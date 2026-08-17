#!/usr/bin/env python3
"""Audit Neutron security groups for overly permissive ingress rules.

Findings are ranked so the report can be handed straight to a security review:

    CRITICAL  world-open ingress (0.0.0.0/0 or ::/0) on an admin port
              (SSH, RDP, WinRM, database, etcd, Kubernetes API, Redis, ...)
    HIGH      world-open ingress on any other port, or a world-open ALL/ANY rule
    MEDIUM    ingress from a wide RFC1918 range (/8, /12, /16) on an admin port
    INFO      security group with no rules at all, or attached to nothing

Only groups actually attached to a port are reported by default, because an
unused permissive group is noise; pass --include-unused to see everything.

Examples
--------
    ./security_group_audit.py --min-severity HIGH
    ./security_group_audit.py --format json | jq '.[] | select(.severity=="CRITICAL")'
    ./security_group_audit.py --project 8f2c... --include-unused
"""

from __future__ import annotations

import ipaddress

from common import LOG, base_parser, connect, render, setup_logging

SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "INFO": 3}

# Ports that should never be reachable from the internet.
ADMIN_PORTS = {
    22: "SSH",
    23: "telnet",
    445: "SMB",
    1433: "MSSQL",
    2379: "etcd client",
    2380: "etcd peer",
    3306: "MySQL",
    3389: "RDP",
    5432: "PostgreSQL",
    5601: "Kibana",
    5985: "WinRM",
    5986: "WinRM/TLS",
    6379: "Redis",
    6443: "Kubernetes API",
    9200: "Elasticsearch",
    9300: "Elasticsearch transport",
    10250: "kubelet",
    11211: "memcached",
    27017: "MongoDB",
}

WORLD = ("0.0.0.0/0", "::/0")

COLUMNS = ("severity", "group", "project_id", "direction", "protocol", "ports", "source", "finding")


def port_range(rule) -> str:
    lo, hi = rule.port_range_min, rule.port_range_max
    if lo is None and hi is None:
        return "ALL"
    if lo == hi:
        return str(lo)
    return f"{lo}-{hi}"


def covered_admin_ports(rule) -> list[str]:
    lo, hi = rule.port_range_min, rule.port_range_max
    if lo is None and hi is None:
        return sorted({name for name in ADMIN_PORTS.values()})
    return [ADMIN_PORTS[p] for p in ADMIN_PORTS if lo <= p <= hi]


def is_wide_private(cidr: str) -> bool:
    """True for RFC1918 supernets broad enough to mean 'most of the estate'."""
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False
    return net.is_private and net.prefixlen <= 16


def classify(rule) -> tuple[str, str] | None:
    """Return (severity, finding) or None when the rule looks reasonable."""
    if rule.direction != "ingress":
        return None

    cidr = rule.remote_ip_prefix
    if not cidr:
        # Remote *group* references are the good pattern — nothing to flag.
        return None

    admin = covered_admin_ports(rule)
    proto = (rule.protocol or "any").lower()

    if cidr in WORLD:
        if proto in ("any", "none") and rule.port_range_min is None:
            return "HIGH", "all protocols and ports open to the internet"
        if admin:
            return "CRITICAL", f"internet-facing admin service: {', '.join(admin[:4])}"
        return "HIGH", "internet-facing ingress"

    if is_wide_private(cidr) and admin:
        return "MEDIUM", f"wide internal range {cidr} reaches {', '.join(admin[:4])}"

    return None


def audit(conn, include_unused: bool, project: str | None) -> list[dict]:
    attached = set()
    if not include_unused:
        for port in conn.network.ports():
            attached.update(port.security_group_ids or [])

    rows: list[dict] = []
    for group in conn.network.security_groups():
        if project and group.project_id != project:
            continue
        in_use = group.id in attached
        if not include_unused and not in_use:
            continue

        rules = list(group.security_group_rules or [])
        if not rules:
            rows.append(
                {
                    "severity": "INFO",
                    "group": group.name or group.id,
                    "project_id": group.project_id,
                    "direction": "-",
                    "protocol": "-",
                    "ports": "-",
                    "source": "-",
                    "finding": "security group has no rules",
                    "_group_id": group.id,
                }
            )
            continue

        for raw in rules:
            # security_group_rules come back as dicts on some SDK versions.
            rule = conn.network.get_security_group_rule(raw["id"]) if isinstance(raw, dict) else raw
            verdict = classify(rule)
            if verdict is None:
                continue
            severity, finding = verdict
            rows.append(
                {
                    "severity": severity,
                    "group": group.name or group.id,
                    "project_id": group.project_id,
                    "direction": rule.direction,
                    "protocol": rule.protocol or "any",
                    "ports": port_range(rule),
                    "source": rule.remote_ip_prefix,
                    "finding": finding + ("" if in_use else " (group unused)"),
                    "_group_id": group.id,
                    "_rule_id": rule.id,
                }
            )
    return rows


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument(
        "--min-severity",
        choices=tuple(SEVERITY_ORDER),
        default="MEDIUM",
        help="suppress findings below this severity",
    )
    parser.add_argument("--project", help="restrict to a single project id")
    parser.add_argument(
        "--include-unused",
        action="store_true",
        help="also audit security groups not attached to any port",
    )
    parser.add_argument(
        "--fail-on-findings",
        action="store_true",
        help="exit non-zero when anything is reported (for CI gates)",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    conn = connect(args.cloud)
    rows = audit(conn, args.include_unused, args.project)

    cutoff = SEVERITY_ORDER[args.min_severity]
    rows = [r for r in rows if SEVERITY_ORDER[r["severity"]] <= cutoff]
    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["group"]))

    render(rows, COLUMNS, args.format)

    if args.format == "table" and rows:
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["severity"]] = counts.get(row["severity"], 0) + 1
        print("Summary: " + ", ".join(f"{k}={counts[k]}" for k in sorted(counts, key=SEVERITY_ORDER.get)))

    if args.fail_on_findings and rows:
        LOG.error("%d finding(s) at or above %s", len(rows), args.min_severity)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
