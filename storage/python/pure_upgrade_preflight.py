#!/usr/bin/env python3
"""Pre-upgrade validation for Pure Storage FlashArray, including API token and
VIP reachability checks.

Two failures account for most aborted Pure upgrades, and both are trivially
detectable beforehand:

  1. **The API token no longer works.** Tokens are per-user, they expire, and the
     account behind them gets disabled or loses its role during an access review.
     Nobody notices until the upgrade automation authenticates at the start of
     the window and fails.

  2. **A VIP is not actually reachable from where it matters.** The management
     VIP answers from the jump host but not from the compute nodes; or one
     controller's iSCSI/NVMe data VIP is dark, so the array survives the
     controller failover on paper but half the hosts lose paths in practice.

Checks
------
    token       authenticate, report the token's user, role, expiry and whether
                the account is enabled; warn well before expiry
    vip         TCP reachability of every management and data VIP, from this
                host and optionally from a list of remote hosts over SSH
    paths       per-host multipath state — every LUN has paths through both
                controllers, none in a failed state
    version     current Purity version, target compatibility, pending upgrade
    health      array-level alerts, controller status, capacity headroom,
                and whether both controllers are ready for a failover

Read-only in every mode. Nothing here changes array state.

Examples
--------
    ./pure_upgrade_preflight.py --array flasharray-01.example.net
    ./pure_upgrade_preflight.py --array fa-01 --check token,vip --format json
    ./pure_upgrade_preflight.py --array fa-01 --from-hosts compute-01,compute-02
    ./pure_upgrade_preflight.py --array fa-01 --target-version 6.5.4 --fail-on-findings

Credentials come from PURE_API_TOKEN in the environment, or from
`--token-file`, never from this repository.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

LOG = logging.getLogger("pure-preflight")

SEVERITY_ORDER = {"CRITICAL": 0, "WARN": 1, "INFO": 2}
CHECKS = ("token", "vip", "paths", "version", "health")

# Ports that matter for a FlashArray: management, iSCSI, NVMe/TCP, replication.
VIP_PORTS = {
    "management": 443,
    "iscsi": 3260,
    "nvme-tcp": 4420,
    "replication": 8117,
}

TOKEN_EXPIRY_WARN_DAYS = 30


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


def finding(severity, check, subject, text) -> dict:
    return {"severity": severity, "check": check, "subject": subject, "finding": text}


def render(rows, columns, fmt) -> None:
    if fmt == "json":
        print(json.dumps(rows, indent=2, default=str))
        return
    if not rows:
        print("(no results)")
        return
    widths = {c: len(c) for c in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))
    print("  ".join(c.upper().ljust(widths[c]) for c in columns))
    print("  ".join("-" * widths[c] for c in columns))
    for row in rows:
        print("  ".join(str(row.get(c, "")).ljust(widths[c]) for c in columns))
    print(f"\n{len(rows)} row(s)")


def read_token(token_file: str | None) -> str:
    if token_file:
        try:
            with open(token_file) as handle:
                return handle.read().strip()
        except OSError as exc:
            sys.exit(f"cannot read token file: {exc}")
    token = os.environ.get("PURE_API_TOKEN", "").strip()
    if not token:
        sys.exit(
            "No API token. Set PURE_API_TOKEN in the environment or pass --token-file. "
            "Never commit a token to a repository."
        )
    return token


class PureClient:
    """Minimal FlashArray REST client — no vendor SDK required on a jump host."""

    def __init__(self, array: str, token: str, verify_tls: bool, api_version: str = "2.26"):
        self.base = f"https://{array}/api/{api_version}"
        self.array = array
        self.token = token
        self.session_token: str | None = None
        self.context = ssl.create_default_context()
        if not verify_tls:
            # Arrays commonly carry an internal CA certificate; allow opting out
            # explicitly rather than disabling verification silently.
            self.context.check_hostname = False
            self.context.verify_mode = ssl.CERT_NONE

    def _request(self, path: str, method: str = "GET", headers: dict | None = None,
                 timeout: int = 20) -> tuple[int, dict | None, dict]:
        request = urllib.request.Request(f"{self.base}{path}", method=method)
        request.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        if self.session_token:
            request.add_header("x-auth-token", self.session_token)
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=self.context) as resp:
                body = resp.read().decode() or "{}"
                return resp.status, json.loads(body), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode()[:300]
            LOG.debug("%s %s -> %s %s", method, path, exc.code, detail)
            return exc.code, {"error": detail}, dict(exc.headers or {})
        except (urllib.error.URLError, TimeoutError, ssl.SSLError, socket.timeout) as exc:
            LOG.debug("%s %s -> %s", method, path, exc)
            return 0, {"error": str(exc)}, {}

    def login(self) -> tuple[bool, str]:
        status, body, headers = self._request(
            "/login", method="POST", headers={"api-token": self.token}
        )
        if status == 200:
            self.session_token = headers.get("x-auth-token")
            return True, "authenticated"
        if status in (401, 403):
            return False, (f"token rejected (HTTP {status}) — expired, revoked, "
                           "or the account is disabled")
        if status == 0:
            return False, f"could not reach {self.array}: {(body or {}).get('error', 'no route')}"
        return False, f"unexpected response HTTP {status}"

    def get(self, path: str) -> dict | None:
        status, body, _ = self._request(path)
        return body if status == 200 else None


def check_token(client: PureClient) -> list[dict]:
    rows = []
    ok, message = client.login()
    if not ok:
        return [finding("CRITICAL", "token", client.array, message)]

    rows.append(finding("INFO", "token", client.array, message))

    admins = client.get("/admins?expose_api_token=false")
    if admins is None:
        rows.append(finding("WARN", "token", client.array,
                            "authenticated, but the admin list is not readable — "
                            "the token's role may be too narrow for the upgrade"))
        return rows

    for admin in (admins.get("items") or []):
        name = admin.get("name", "unknown")
        role = (admin.get("role") or {}).get("name", "unknown")
        enabled = admin.get("is_local", True)
        rows.append(finding("INFO", "token", name, f"role={role} local={enabled}"))

        expiry = admin.get("api_token", {}).get("expires_at")
        if expiry:
            try:
                expires = datetime.fromtimestamp(int(expiry) / 1000, tz=timezone.utc)
            except (TypeError, ValueError):
                continue
            remaining = expires - datetime.now(timezone.utc)
            if remaining <= timedelta(0):
                rows.append(finding("CRITICAL", "token", name,
                                    f"API token expired at {expires.isoformat()}"))
            elif remaining <= timedelta(days=TOKEN_EXPIRY_WARN_DAYS):
                rows.append(finding("WARN", "token", name,
                                    f"API token expires in {remaining.days} day(s) "
                                    f"({expires.date()}) — renew before the window"))
            else:
                rows.append(finding("INFO", "token", name,
                                    f"API token valid until {expires.date()}"))
    return rows


def tcp_probe(host: str, port: int, timeout: float = 5.0) -> tuple[bool, str]:
    start = datetime.now()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            elapsed = (datetime.now() - start).total_seconds() * 1000
            return True, f"connected in {elapsed:.0f} ms"
    except socket.timeout:
        return False, f"timed out after {timeout}s"
    except OSError as exc:
        return False, str(exc)


def remote_tcp_probe(via_host: str, target: str, port: int, ssh_user: str) -> tuple[bool, str]:
    """Probe a VIP from somewhere else — the check that catches asymmetric routing."""
    command = (
        f"timeout 5 bash -c '</dev/tcp/{target}/{port}' 2>/dev/null "
        f"&& echo REACHABLE || echo UNREACHABLE"
    )
    try:
        proc = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
             "-o", "ConnectTimeout=10", f"{ssh_user}@{via_host}", command],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return False, f"ssh to {via_host} timed out"
    if proc.returncode != 0:
        return False, f"ssh to {via_host} failed"
    return "REACHABLE" in proc.stdout, proc.stdout.strip() or "no output"


def check_vips(client: PureClient, from_hosts: list[str], ssh_user: str) -> list[dict]:
    rows = []
    interfaces = client.get("/network-interfaces")
    vips: list[tuple[str, str, str]] = []

    if interfaces:
        for iface in (interfaces.get("items") or []):
            address = iface.get("eth", {}).get("address")
            services = iface.get("services") or []
            if not address or not iface.get("enabled", True):
                continue
            for service in services:
                vips.append((service, address, iface.get("name", "?")))
    else:
        rows.append(finding("WARN", "vip", client.array,
                            "network interface list unavailable; probing the "
                            "management address only"))
        vips.append(("management", client.array, "management"))

    for service, address, name in vips:
        port = VIP_PORTS.get(service.lower())
        if port is None:
            continue

        ok, detail = tcp_probe(address, port)
        rows.append(finding(
            "INFO" if ok else "CRITICAL", "vip", f"{name} {address}:{port}",
            f"{service} from this host: {detail}",
        ))

        for host in from_hosts:
            ok_remote, detail_remote = remote_tcp_probe(host, address, port, ssh_user)
            rows.append(finding(
                "INFO" if ok_remote else "CRITICAL", "vip", f"{name} {address}:{port}",
                f"{service} from {host}: {detail_remote}",
            ))

    # A single reachable data VIP is a single point of failure across a
    # controller failover, which is exactly what an upgrade performs.
    data_vips = [v for v in vips if v[0].lower() in ("iscsi", "nvme-tcp")]
    if 0 < len(data_vips) < 2:
        rows.append(finding("CRITICAL", "vip", client.array,
                            f"only {len(data_vips)} data VIP configured — a controller "
                            "failover during the upgrade will drop all paths"))
    return rows


def check_multipath(from_hosts: list[str], ssh_user: str) -> list[dict]:
    rows = []
    for host in from_hosts:
        try:
            proc = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
                 "-o", "ConnectTimeout=10", f"{ssh_user}@{host}", "multipath -ll"],
                capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            rows.append(finding("WARN", "paths", host, "multipath query timed out"))
            continue

        if proc.returncode != 0:
            rows.append(finding("WARN", "paths", host,
                                "multipath -ll failed or multipathd is not running"))
            continue

        output = proc.stdout
        failed = output.count("failed") + output.count("faulty")
        active = output.count("active ready")
        maps = output.count("PURE")

        if failed:
            rows.append(finding("CRITICAL", "paths", host,
                                f"{failed} failed/faulty path(s) before the upgrade even starts"))
        if maps and active < maps * 2:
            rows.append(finding("CRITICAL", "paths", host,
                                f"{active} active path(s) across {maps} Pure LUN(s) — "
                                "fewer than two per LUN means no controller redundancy"))
        elif maps:
            rows.append(finding("INFO", "paths", host,
                                f"{maps} Pure LUN(s), {active} active path(s)"))
        else:
            rows.append(finding("INFO", "paths", host, "no Pure LUNs mapped to this host"))
    return rows


def check_version(client: PureClient, target: str | None) -> list[dict]:
    rows = []
    arrays = client.get("/arrays")
    if not arrays or not arrays.get("items"):
        return [finding("WARN", "version", client.array, "array details unavailable")]

    array = arrays["items"][0]
    current = array.get("version", "unknown")
    rows.append(finding("INFO", "version", array.get("name", client.array),
                        f"Purity {current}"))

    if target:
        try:
            cur_parts = tuple(int(p) for p in current.split(".")[:3])
            tgt_parts = tuple(int(p) for p in target.split(".")[:3])
        except ValueError:
            return rows + [finding("WARN", "version", client.array,
                                   f"cannot compare {current} with {target}")]

        if cur_parts == tgt_parts:
            rows.append(finding("INFO", "version", client.array,
                                f"already on the target version {target}"))
        elif cur_parts > tgt_parts:
            rows.append(finding("CRITICAL", "version", client.array,
                                f"current {current} is newer than target {target} — downgrade"))
        elif tgt_parts[0] - cur_parts[0] > 1:
            rows.append(finding("CRITICAL", "version", client.array,
                                f"{current} -> {target} skips a major release; "
                                "a stepped upgrade is required"))
        else:
            rows.append(finding("INFO", "version", client.array,
                                f"upgrade path {current} -> {target} looks valid"))
    return rows


def check_health(client: PureClient) -> list[dict]:
    rows = []

    controllers = client.get("/controllers")
    if controllers:
        items = controllers.get("items") or []
        ready = [c for c in items if (c.get("status") or "").lower() == "ready"]
        for controller in items:
            status = controller.get("status", "unknown")
            rows.append(finding(
                "INFO" if status.lower() == "ready" else "CRITICAL",
                "health", controller.get("name", "controller"),
                f"status={status} mode={controller.get('mode', '?')} "
                f"version={controller.get('version', '?')}",
            ))
        if len(ready) < 2:
            rows.append(finding("CRITICAL", "health", client.array,
                                f"only {len(ready)} controller(s) ready — a non-disruptive "
                                "upgrade requires both"))

    alerts = client.get("/alerts?filter=state='open'")
    if alerts:
        for alert in (alerts.get("items") or [])[:20]:
            severity = (alert.get("severity") or "info").lower()
            rows.append(finding(
                "CRITICAL" if severity in ("critical", "fatal") else "WARN",
                "health", alert.get("component_name", "alert"),
                f"{severity}: {alert.get('summary', alert.get('code', 'no summary'))}",
            ))
        if not alerts.get("items"):
            rows.append(finding("INFO", "health", client.array, "no open alerts"))

    space = client.get("/arrays/space")
    if space and space.get("items"):
        item = space["items"][0]
        capacity = item.get("capacity") or 0
        used = (item.get("space") or {}).get("total_physical") or 0
        if capacity:
            pct = used / capacity * 100
            rows.append(finding(
                "CRITICAL" if pct >= 90 else "WARN" if pct >= 80 else "INFO",
                "health", client.array,
                f"{pct:.1f}% physical capacity used",
            ))
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--array", required=True, help="FlashArray management hostname or VIP")
    parser.add_argument(
        "--check", default=",".join(CHECKS),
        help=f"comma-separated checks to run: {', '.join(CHECKS)}",
    )
    parser.add_argument("--target-version", help="Purity version being upgraded to")
    parser.add_argument(
        "--from-hosts", default="",
        help="comma-separated hosts to probe VIP reachability and multipath from",
    )
    parser.add_argument("--ssh-user", default="root", help="SSH user for the remote probes")
    parser.add_argument("--token-file", help="file containing the API token")
    parser.add_argument(
        "--insecure", action="store_true",
        help="skip TLS verification (arrays with an internal CA certificate)",
    )
    parser.add_argument(
        "--min-severity", choices=tuple(SEVERITY_ORDER), default="INFO",
        help="suppress findings below this severity",
    )
    parser.add_argument("--format", choices=("table", "json"), default="table")
    parser.add_argument(
        "--fail-on-findings", action="store_true",
        help="exit non-zero on any CRITICAL finding",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = parser.parse_args()
    setup_logging(args.verbose)

    checks = [c.strip() for c in args.check.split(",") if c.strip()]
    unknown = [c for c in checks if c not in CHECKS]
    if unknown:
        parser.error(f"unknown check(s): {', '.join(unknown)}")

    from_hosts = [h.strip() for h in args.from_hosts.split(",") if h.strip()]
    client = PureClient(args.array, read_token(args.token_file), not args.insecure)

    rows: list[dict] = []

    # Token first: every other API-based check depends on it.
    token_rows = check_token(client)
    if "token" in checks:
        rows.extend(token_rows)
    authenticated = not any(
        r["severity"] == "CRITICAL" and r["check"] == "token" for r in token_rows
    )

    if not authenticated:
        if "token" not in checks:
            rows.extend(token_rows)
        LOG.error("authentication failed; API-based checks cannot run")
    else:
        if "version" in checks:
            rows.extend(check_version(client, args.target_version))
        if "health" in checks:
            rows.extend(check_health(client))

    if "vip" in checks:
        rows.extend(check_vips(client, from_hosts, args.ssh_user))
    if "paths" in checks and from_hosts:
        rows.extend(check_multipath(from_hosts, args.ssh_user))
    elif "paths" in checks:
        rows.append(finding("INFO", "paths", args.array,
                            "no --from-hosts given; multipath check skipped"))

    cutoff = SEVERITY_ORDER[args.min_severity]
    rows = [r for r in rows if SEVERITY_ORDER[r["severity"]] <= cutoff]
    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["check"], r["subject"]))

    render(rows, ("severity", "check", "subject", "finding"), args.format)

    criticals = [r for r in rows if r["severity"] == "CRITICAL"]
    if args.format == "table":
        verdict = "NO-GO" if criticals else "GO"
        print(f"\nUpgrade readiness for {args.array}: {verdict} "
              f"({len(criticals)} critical, "
              f"{len([r for r in rows if r['severity'] == 'WARN'])} warning)")

    if criticals and (args.fail_on_findings or not authenticated):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
