#!/usr/bin/env python3
"""Fleet monitor for SentinelOne agent health across an infrastructure estate.

An EDR agent that is installed but not actually protecting is worse than no
agent, because the compliance dashboard shows green. This reconciles three
views and reports where they disagree:

    1. The SentinelOne management console (via its REST API) — what the security
       team believes is deployed and healthy.
    2. The infrastructure inventory (an Ansible inventory, or an OpenStack /
       Nexus host list) — what actually exists and should be covered.
    3. Optionally the hosts themselves over SSH — whether the agent process is
       running and the local status agrees with the console.

Findings
--------
    UNPROTECTED     host exists in inventory but has no agent in the console —
                    the gap nobody sees, because the console only shows what it
                    knows about
    DISCONNECTED    agent registered but has not checked in within --stale-hours
    DISABLED        agent present and connected but protection is off, in alert-
                    only mode, or actively user-disabled
    OUT_OF_DATE     agent version behind the fleet's target version
    NEEDS_REBOOT    agent upgraded but pending a reboot to take full effect
    INFECTED        unresolved threats on the endpoint
    LOCAL_MISMATCH  the console says healthy but the host's own agent status
                    disagrees (only with --verify-on-host)

Read-only. This never disables, uninstalls or reconfigures an agent.

Examples
--------
    ./sentinelone_agent_monitor.py --inventory hosts.ini
    ./sentinelone_agent_monitor.py --openstack-hosts --format json
    ./sentinelone_agent_monitor.py --inventory hosts.ini --verify-on-host \\
        --finding UNPROTECTED --fail-on-findings

Credentials come from S1_API_TOKEN and S1_CONSOLE_URL in the environment.
"""

from __future__ import annotations

import argparse
import configparser
import json
import logging
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

LOG = logging.getLogger("s1-monitor")

FINDINGS = (
    "UNPROTECTED", "DISCONNECTED", "DISABLED", "OUT_OF_DATE",
    "NEEDS_REBOOT", "INFECTED", "LOCAL_MISMATCH",
)

SEVERITY = {
    "UNPROTECTED": "CRITICAL",
    "INFECTED": "CRITICAL",
    "DISABLED": "CRITICAL",
    "LOCAL_MISMATCH": "CRITICAL",
    "DISCONNECTED": "WARN",
    "OUT_OF_DATE": "WARN",
    "NEEDS_REBOOT": "WARN",
}

COLUMNS = ("severity", "finding", "host", "agent_version", "last_seen", "detail")


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


def row(finding_type, host, version, last_seen, detail) -> dict:
    return {
        "severity": SEVERITY.get(finding_type, "WARN"),
        "finding": finding_type,
        "host": host,
        "agent_version": version or "-",
        "last_seen": last_seen or "-",
        "detail": detail,
    }


def render(rows, columns, fmt) -> None:
    if fmt == "json":
        print(json.dumps(rows, indent=2, default=str))
        return
    if not rows:
        print("(no findings)")
        return
    widths = {c: len(c) for c in columns}
    for entry in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(entry.get(col, ""))))
    print("  ".join(c.upper().ljust(widths[c]) for c in columns))
    print("  ".join("-" * widths[c] for c in columns))
    for entry in rows:
        print("  ".join(str(entry.get(c, "")).ljust(widths[c]) for c in columns))
    print(f"\n{len(rows)} finding(s)")


class SentinelOneClient:
    def __init__(self, console_url: str, token: str, verify_tls: bool = True):
        self.base = console_url.rstrip("/") + "/web/api/v2.1"
        self.token = token
        self.verify_tls = verify_tls

    def _get(self, path: str, params: dict | None = None, timeout: int = 30) -> dict | None:
        url = f"{self.base}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url)
        request.add_header("Authorization", f"ApiToken {self.token}")
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as resp:
                return json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                sys.exit(
                    f"SentinelOne API rejected the token (HTTP {exc.code}). "
                    "Check S1_API_TOKEN and the account's console permissions."
                )
            LOG.error("GET %s -> HTTP %s", path, exc.code)
            return None
        except urllib.error.URLError as exc:
            LOG.error("cannot reach the SentinelOne console: %s", exc)
            return None

    def agents(self, site_id: str | None = None) -> list[dict]:
        """Page through every agent the token can see."""
        collected: list[dict] = []
        cursor = None
        while True:
            params = {"limit": 200}
            if cursor:
                params["cursor"] = cursor
            if site_id:
                params["siteIds"] = site_id
            body = self._get("/agents", params)
            if body is None:
                break
            collected.extend(body.get("data", []))
            cursor = (body.get("pagination") or {}).get("nextCursor")
            if not cursor:
                break
        return collected


def parse_inventory(path: str) -> set[str]:
    """Read hostnames from an INI-style Ansible inventory."""
    hosts: set[str] = set()
    parser = configparser.ConfigParser(allow_no_value=True, delimiters=("=",))
    parser.optionxform = str
    try:
        parser.read(path)
    except configparser.Error as exc:
        LOG.warning("inventory is not clean INI (%s); falling back to line parsing", exc)

    for section in parser.sections():
        if ":vars" in section or ":children" in section:
            continue
        for key in parser[section]:
            hosts.add(key.split()[0])

    if not hosts:
        # Plain host-per-line file.
        try:
            with open(path) as handle:
                for line in handle:
                    line = line.strip()
                    if line and not line.startswith(("#", ";", "[")):
                        hosts.add(line.split()[0])
        except OSError as exc:
            sys.exit(f"cannot read inventory: {exc}")
    return hosts


def openstack_hosts() -> set[str]:
    """Compute hosts from the OpenStack service list, when running against a cloud."""
    try:
        import openstack
    except ImportError:
        sys.exit("openstacksdk is required for --openstack-hosts")
    conn = openstack.connect(cloud=os.environ.get("OS_CLOUD", "envvars"))
    return {svc.host for svc in conn.compute.services() if svc.binary == "nova-compute"}


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalise(hostname: str) -> str:
    """Compare on the short hostname; consoles and inventories disagree on FQDNs."""
    return hostname.split(".")[0].lower()


def local_agent_status(host: str, ssh_user: str) -> tuple[bool, str]:
    """Ask the host itself. The console is a claim; this is the evidence."""
    command = (
        "sentinelctl control status 2>/dev/null "
        "|| /opt/sentinelone/bin/sentinelctl control status 2>/dev/null "
        "|| echo 'AGENT NOT PRESENT'"
    )
    try:
        proc = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
             "-o", "ConnectTimeout=10", f"{ssh_user}@{host}", command],
            capture_output=True, text=True, timeout=45,
        )
    except subprocess.TimeoutExpired:
        return False, "ssh timed out"
    if proc.returncode != 0:
        return False, "host unreachable over ssh"

    output = proc.stdout.strip()
    if "NOT PRESENT" in output:
        return False, "sentinelctl not installed on the host"
    healthy = "Disabled" not in output and (
        "Enabled" in output or "Protect" in output or "connected" in output.lower()
    )
    return healthy, output.replace("\n", "; ")[:160]


def evaluate(agents: list[dict], inventory: set[str], target_version: str | None,
             stale_hours: int) -> list[dict]:
    rows: list[dict] = []
    by_host = {normalise(a.get("computerName", "")): a for a in agents if a.get("computerName")}
    now = datetime.now(timezone.utc)

    # Direction 1: inventory hosts with no agent at all.
    for host in sorted(inventory):
        if normalise(host) not in by_host:
            rows.append(row("UNPROTECTED", host, None, None,
                            "host is in inventory but has no agent registered in the console"))

    # Direction 2: registered agents that are not actually protecting.
    for agent in agents:
        host = agent.get("computerName", "unknown")
        version = agent.get("agentVersion")
        last_active = parse_timestamp(agent.get("lastActiveDate"))
        last_seen = last_active.strftime("%Y-%m-%d %H:%M") if last_active else "never"

        if last_active is None or (now - last_active) > timedelta(hours=stale_hours):
            age = f"{(now - last_active).days}d" if last_active else "never"
            rows.append(row("DISCONNECTED", host, version, last_seen,
                            f"no check-in for {age} (threshold {stale_hours}h)"))

        if agent.get("isUninstalled"):
            rows.append(row("UNPROTECTED", host, version, last_seen,
                            "agent has been uninstalled from this endpoint"))

        if agent.get("userActionsNeeded"):
            actions = ", ".join(str(a) for a in agent["userActionsNeeded"])
            if "reboot" in actions.lower():
                rows.append(row("NEEDS_REBOOT", host, version, last_seen,
                                f"pending action: {actions}"))
            else:
                rows.append(row("DISABLED", host, version, last_seen,
                                f"pending action: {actions}"))

        mitigation = agent.get("mitigationMode")
        if mitigation and mitigation not in ("protect",):
            rows.append(row("DISABLED", host, version, last_seen,
                            f"mitigation mode is '{mitigation}', not 'protect' — "
                            "threats are detected but not stopped"))

        if agent.get("threatRebootRequired"):
            rows.append(row("NEEDS_REBOOT", host, version, last_seen,
                            "a mitigation requires a reboot to complete"))

        infected = agent.get("infected")
        active_threats = agent.get("activeThreats", 0)
        if infected or active_threats:
            rows.append(row("INFECTED", host, version, last_seen,
                            f"{active_threats} unresolved threat(s) on this endpoint"))

        if target_version and version and version != target_version:
            rows.append(row("OUT_OF_DATE", host, version, last_seen,
                            f"agent {version}, fleet target {target_version}"))

        if agent.get("networkStatus") == "disconnected":
            rows.append(row("DISABLED", host, version, last_seen,
                            "endpoint is network-quarantined by SentinelOne"))

    return rows


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--inventory", help="Ansible inventory or host-per-line file")
    source.add_argument(
        "--openstack-hosts", action="store_true",
        help="use the OpenStack nova-compute host list as the expected inventory",
    )
    parser.add_argument("--site-id", help="restrict to one SentinelOne site")
    parser.add_argument(
        "--target-version", help="agent version the fleet should be on"
    )
    parser.add_argument(
        "--stale-hours", type=int, default=24,
        help="hours without a check-in before an agent is DISCONNECTED",
    )
    parser.add_argument(
        "--finding", action="append", choices=FINDINGS,
        help="only report specific finding types (repeatable)",
    )
    parser.add_argument(
        "--verify-on-host", action="store_true",
        help="SSH to each host and compare its local agent status with the console",
    )
    parser.add_argument("--ssh-user", default="root", help="SSH user for --verify-on-host")
    parser.add_argument("--format", choices=("table", "json"), default="table")
    parser.add_argument(
        "--fail-on-findings", action="store_true",
        help="exit non-zero when any CRITICAL finding is reported",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = parser.parse_args()
    setup_logging(args.verbose)

    console = os.environ.get("S1_CONSOLE_URL", "").strip()
    token = os.environ.get("S1_API_TOKEN", "").strip()
    if not console or not token:
        sys.exit(
            "Set S1_CONSOLE_URL and S1_API_TOKEN in the environment. "
            "Never commit an API token to a repository."
        )

    inventory = openstack_hosts() if args.openstack_hosts else parse_inventory(args.inventory)
    LOG.info("%d host(s) expected to be protected", len(inventory))

    client = SentinelOneClient(console, token)
    agents = client.agents(args.site_id)
    LOG.info("%d agent(s) registered in the console", len(agents))

    rows = evaluate(agents, inventory, args.target_version, args.stale_hours)

    if args.verify_on_host:
        by_host = {normalise(a.get("computerName", "")): a for a in agents}
        healthy_per_console = [
            host for host in inventory
            if normalise(host) in by_host
            and not any(r["host"] == host and r["severity"] == "CRITICAL" for r in rows)
        ]
        LOG.info("verifying %d console-healthy host(s) on the host itself",
                 len(healthy_per_console))
        for host in healthy_per_console:
            healthy, detail = local_agent_status(host, args.ssh_user)
            if not healthy:
                agent = by_host[normalise(host)]
                rows.append(row("LOCAL_MISMATCH", host, agent.get("agentVersion"),
                                agent.get("lastActiveDate", "-"),
                                f"console reports healthy, host reports: {detail}"))

    if args.finding:
        rows = [r for r in rows if r["finding"] in args.finding]

    rows.sort(key=lambda r: (0 if r["severity"] == "CRITICAL" else 1, r["finding"], r["host"]))
    render(rows, COLUMNS, args.format)

    criticals = [r for r in rows if r["severity"] == "CRITICAL"]
    if args.format == "table":
        unprotected = len([r for r in rows if r["finding"] == "UNPROTECTED"])
        coverage = (len(inventory) - unprotected) / len(inventory) * 100 if inventory else 0
        print(f"Coverage: {coverage:.1f}% ({len(inventory) - unprotected}/{len(inventory)} hosts), "
              f"{len(criticals)} critical finding(s)")

    if args.fail_on_findings and criticals:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
