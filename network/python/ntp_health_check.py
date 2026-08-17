#!/usr/bin/env python3
"""Diagnose NTP/chrony health and packet loss across a fleet.

Clock skew is the failure that presents as something else entirely: Ceph
flapping OSDs, Kubernetes certificates rejected as not-yet-valid, Keystone
tokens refused, Galera nodes evicted, and log timelines that make an incident
impossible to reconstruct. By the time anyone suspects NTP, hours are gone.

What this checks, per host:

    sync        chrony/ntpd is actually synchronised, not merely running
    offset      current offset against the reference, and the trend
    stratum     stratum depth, and that the host is not following an
                unsynchronised peer (stratum 16) or itself (LOCAL/orphan mode)
    loss        packet loss and unreachability toward each configured source,
                read from chrony's own reachability register — the check that
                catches a firewall dropping UDP/123 intermittently, which is the
                hardest NTP failure to see
    jitter      RMS jitter and root dispersion, which reveal a congested or
                asymmetric path even when the offset looks fine
    sources     enough reachable sources to survive one going away, and no
                single point of failure
    consistency cross-host skew — the number that actually matters for a
                distributed system is how far apart two nodes are

Read-only: it never restarts a time service or steps a clock.

Examples
--------
    ./ntp_health_check.py --hosts compute-01,compute-02,ctrl-01
    ./ntp_health_check.py --inventory hosts.ini --format json
    ./ntp_health_check.py --inventory hosts.ini --max-offset-ms 50 --fail-on-findings
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import re
import subprocess
import sys

LOG = logging.getLogger("ntp-check")

SEVERITY_ORDER = {"CRITICAL": 0, "WARN": 1, "INFO": 2}
COLUMNS = ("severity", "host", "check", "subject", "finding")

# chronyc reachability register: 8 octal digits of the last 8 polls.
# 377 means all eight succeeded; anything less means loss.
REACHABILITY_PERFECT = 377


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


def finding(severity, host, check, subject, text) -> dict:
    return {"severity": severity, "host": host, "check": check,
            "subject": subject, "finding": text}


def render(rows, columns, fmt) -> None:
    if fmt == "json":
        print(json.dumps(rows, indent=2, default=str))
        return
    if not rows:
        print("(no findings)")
        return
    widths = {c: len(c) for c in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))
    print("  ".join(c.upper().ljust(widths[c]) for c in columns))
    print("  ".join("-" * widths[c] for c in columns))
    for row in rows:
        print("  ".join(str(row.get(c, "")).ljust(widths[c]) for c in columns))
    print(f"\n{len(rows)} finding(s)")


def ssh(host: str, command: str, user: str, timeout: int = 30) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
             "-o", "ConnectTimeout=10", f"{user}@{host}", command],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return 255, ""
    return proc.returncode, proc.stdout


def parse_tracking(output: str) -> dict:
    """Parse `chronyc tracking` into the fields that matter."""
    fields: dict[str, str] = {}
    for line in output.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip().lower()] = value.strip()

    def seconds(key: str) -> float | None:
        raw = fields.get(key, "")
        match = re.search(r"([-+]?[\d.]+)\s*seconds", raw)
        return float(match.group(1)) if match else None

    return {
        "reference": fields.get("reference id", "unknown"),
        "stratum": int(fields.get("stratum", "16") or 16),
        "leap": fields.get("leap status", "unknown"),
        "system_time_s": seconds("system time"),
        "last_offset_s": seconds("last offset"),
        "rms_offset_s": seconds("rms offset"),
        "root_delay_s": seconds("root delay"),
        "root_dispersion_s": seconds("root dispersion"),
        "skew_ppm": _float(fields.get("skew", "").split()[0] if fields.get("skew") else None),
    }


def _float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_sources(output: str) -> list[dict]:
    """Parse `chronyc -n sources` lines into structured records.

    Format:  ^* 10.0.0.1   2   6   377    31   +12us[  +14us] +/-  8ms
             │└ state      │   │   │      │
             └ mode        │   │   └ reachability register (octal)
                           │   └ poll interval
                           └ stratum
    """
    sources = []
    for line in output.splitlines():
        match = re.match(
            r"^([\^=#])([*+\-?x~])\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$", line
        )
        if not match:
            continue
        sources.append({
            "mode": match.group(1),
            "state": match.group(2),
            "address": match.group(3),
            "stratum": int(match.group(4)),
            "poll": int(match.group(5)),
            "reach": int(match.group(6), 8),
            "reach_octal": match.group(6),
            "last_rx": match.group(7),
            "offset": match.group(8).strip(),
        })
    return sources


def check_host(host: str, user: str, max_offset_ms: float, min_sources: int) -> list[dict]:
    rows = []

    rc, tracking_out = ssh(host, "chronyc tracking 2>/dev/null", user)
    if rc != 0 or not tracking_out.strip():
        # Fall back to ntpq for hosts still running ntpd.
        rc_ntp, ntp_out = ssh(host, "ntpq -pn 2>/dev/null", user)
        if rc_ntp == 0 and ntp_out.strip():
            return check_ntpd(host, ntp_out, max_offset_ms, min_sources)
        return [finding("CRITICAL", host, "sync", "service",
                        "neither chronyc nor ntpq responded — no time service, or "
                        "the host is unreachable")]

    tracking = parse_tracking(tracking_out)

    # Stratum 16 means "I am not synchronised to anything".
    if tracking["stratum"] >= 16:
        rows.append(finding("CRITICAL", host, "sync", "stratum",
                            "stratum 16 — the host is not synchronised to any source"))
    elif tracking["stratum"] >= 5:
        rows.append(finding("WARN", host, "sync", "stratum",
                            f"stratum {tracking['stratum']} — unusually deep in the "
                            "hierarchy; check the upstream chain"))

    if tracking["reference"].upper().startswith(("7F7F", "LOCAL")):
        rows.append(finding("CRITICAL", host, "sync", "reference",
                            "synchronised to its own local clock — this host will drift "
                            "freely and pull others with it"))

    if tracking["leap"] and tracking["leap"].lower() not in ("normal", "unknown"):
        rows.append(finding("WARN", host, "sync", "leap",
                            f"leap status is '{tracking['leap']}'"))

    offset_s = tracking["last_offset_s"]
    if offset_s is not None:
        offset_ms = abs(offset_s) * 1000
        if offset_ms > max_offset_ms:
            rows.append(finding(
                "CRITICAL" if offset_ms > max_offset_ms * 10 else "WARN",
                host, "offset", "last offset",
                f"{offset_ms:.1f} ms from reference (threshold {max_offset_ms} ms)",
            ))
        else:
            rows.append(finding("INFO", host, "offset", "last offset",
                                f"{offset_ms:.2f} ms"))

    dispersion = tracking["root_dispersion_s"]
    if dispersion is not None and dispersion > 1.0:
        rows.append(finding("WARN", host, "jitter", "root dispersion",
                            f"{dispersion * 1000:.0f} ms — the path to the reference is "
                            "congested or asymmetric"))

    skew = tracking["skew_ppm"]
    if skew is not None and skew > 100:
        rows.append(finding("WARN", host, "jitter", "skew",
                            f"{skew:.0f} ppm frequency skew — likely a failing oscillator "
                            "or an unstable virtualised clock source"))

    # Sources and packet loss — the reachability register is the key signal.
    rc, sources_out = ssh(host, "chronyc -n sources 2>/dev/null", user)
    if rc == 0:
        sources = parse_sources(sources_out)
        reachable = [s for s in sources if s["reach"] > 0]
        selected = [s for s in sources if s["state"] == "*"]

        if not sources:
            rows.append(finding("CRITICAL", host, "sources", "configured",
                                "no time sources configured at all"))
        if not selected:
            rows.append(finding("CRITICAL", host, "sources", "selection",
                                f"{len(sources)} source(s) configured but none is selected "
                                "as the synchronisation reference"))
        if len(reachable) < min_sources:
            rows.append(finding("WARN", host, "sources", "redundancy",
                                f"only {len(reachable)} reachable source(s); "
                                f"{min_sources} recommended to survive one going away"))

        for source in sources:
            if source["reach"] == 0:
                rows.append(finding("CRITICAL", host, "loss", source["address"],
                                    "completely unreachable (reach 0) — check UDP/123 "
                                    "filtering on the path"))
            elif source["reach"] != REACHABILITY_PERFECT:
                # Count the missing polls out of the last eight.
                missed = 8 - bin(source["reach"]).count("1")
                rows.append(finding(
                    "CRITICAL" if missed >= 4 else "WARN",
                    host, "loss", source["address"],
                    f"{missed} of the last 8 polls lost (reach {source['reach_octal']}) — "
                    "intermittent packet loss toward this source",
                ))
            elif source["state"] == "x":
                rows.append(finding("WARN", host, "sources", source["address"],
                                    "marked a falseticker — it disagrees with the majority"))
            elif source["state"] == "~":
                rows.append(finding("WARN", host, "sources", source["address"],
                                    "too variable to be used"))
            else:
                rows.append(finding("INFO", host, "sources", source["address"],
                                    f"stratum {source['stratum']}, reach "
                                    f"{source['reach_octal']}, offset {source['offset']}"))
    return rows


def check_ntpd(host: str, output: str, max_offset_ms: float, min_sources: int) -> list[dict]:
    """Same analysis for hosts still running ntpd rather than chrony."""
    rows = [finding("INFO", host, "sync", "service", "running ntpd, not chrony")]
    peers = []
    for line in output.splitlines()[2:]:
        parts = line.split()
        if len(parts) < 10:
            continue
        peers.append({
            "selected": line[0] == "*",
            "address": parts[0].lstrip("*+-#x~ "),
            "stratum": int(parts[2]) if parts[2].isdigit() else 16,
            "reach": int(parts[6], 8) if parts[6].isdigit() else 0,
            "offset_ms": _float(parts[8]) or 0.0,
            "jitter": _float(parts[9]) or 0.0,
        })

    if not any(p["selected"] for p in peers):
        rows.append(finding("CRITICAL", host, "sync", "selection",
                            "no peer selected as the synchronisation source"))

    reachable = [p for p in peers if p["reach"] > 0]
    if len(reachable) < min_sources:
        rows.append(finding("WARN", host, "sources", "redundancy",
                            f"only {len(reachable)} reachable peer(s)"))

    for peer in peers:
        if peer["reach"] == 0:
            rows.append(finding("CRITICAL", host, "loss", peer["address"],
                                "unreachable (reach 0)"))
        elif peer["reach"] != REACHABILITY_PERFECT:
            missed = 8 - bin(peer["reach"]).count("1")
            rows.append(finding("WARN", host, "loss", peer["address"],
                                f"{missed} of the last 8 polls lost"))
        if peer["selected"] and abs(peer["offset_ms"]) > max_offset_ms:
            rows.append(finding("CRITICAL", host, "offset", peer["address"],
                                f"{peer['offset_ms']:.1f} ms offset "
                                f"(threshold {max_offset_ms} ms)"))
    return rows


def cross_host_consistency(host_offsets: dict[str, float], max_skew_ms: float) -> list[dict]:
    """What matters for a cluster is how far apart two nodes are, not the
    absolute offset of either."""
    if len(host_offsets) < 2:
        return []
    lowest = min(host_offsets.values())
    highest = max(host_offsets.values())
    spread_ms = (highest - lowest) * 1000
    if spread_ms > max_skew_ms:
        worst_low = min(host_offsets, key=host_offsets.get)
        worst_high = max(host_offsets, key=host_offsets.get)
        return [finding("CRITICAL", "fleet", "consistency", "cross-host skew",
                        f"{spread_ms:.1f} ms between {worst_low} and {worst_high} — "
                        "Ceph, Galera and Kubernetes certificate validation all break "
                        "well before this becomes visible elsewhere")]
    return [finding("INFO", "fleet", "consistency", "cross-host skew",
                    f"{spread_ms:.2f} ms across {len(host_offsets)} host(s)")]


def parse_inventory(path: str) -> list[str]:
    hosts = []
    try:
        with open(path) as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith(("#", ";", "[")):
                    hosts.append(line.split()[0])
    except OSError as exc:
        sys.exit(f"cannot read inventory: {exc}")
    return hosts


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--hosts", help="comma-separated host list")
    source.add_argument("--inventory", help="file with one host per line")
    parser.add_argument("--ssh-user", default="root", help="SSH user")
    parser.add_argument(
        "--max-offset-ms", type=float, default=100.0,
        help="offset above which a host is reported",
    )
    parser.add_argument(
        "--max-skew-ms", type=float, default=200.0,
        help="acceptable spread between the fleet's most- and least-advanced clocks",
    )
    parser.add_argument(
        "--min-sources", type=int, default=3,
        help="reachable time sources each host should have",
    )
    parser.add_argument(
        "--workers", type=int, default=20, help="parallel SSH connections"
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

    hosts = (
        [h.strip() for h in args.hosts.split(",") if h.strip()]
        if args.hosts else parse_inventory(args.inventory)
    )
    LOG.info("checking %d host(s)", len(hosts))

    rows: list[dict] = []
    offsets: dict[str, float] = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(check_host, host, args.ssh_user, args.max_offset_ms,
                        args.min_sources): host
            for host in hosts
        }
        for future in concurrent.futures.as_completed(futures):
            host = futures[future]
            try:
                host_rows = future.result()
            except Exception as exc:  # noqa: BLE001 - one host must not stop the sweep
                rows.append(finding("CRITICAL", host, "sync", "check", f"check failed: {exc}"))
                continue
            rows.extend(host_rows)
            for entry in host_rows:
                if entry["check"] == "offset" and entry["subject"] == "last offset":
                    match = re.search(r"([\d.]+) ms", entry["finding"])
                    if match:
                        offsets[host] = float(match.group(1)) / 1000

    rows.extend(cross_host_consistency(offsets, args.max_skew_ms))

    cutoff = SEVERITY_ORDER[args.min_severity]
    rows = [r for r in rows if SEVERITY_ORDER[r["severity"]] <= cutoff]
    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["host"], r["check"]))

    render(rows, COLUMNS, args.format)

    criticals = [r for r in rows if r["severity"] == "CRITICAL"]
    if args.format == "table":
        loss = [r for r in rows if r["check"] == "loss" and r["severity"] != "INFO"]
        print(f"{len(hosts)} host(s), {len(criticals)} critical, "
              f"{len(loss)} source(s) showing packet loss")

    if args.fail_on_findings and criticals:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
