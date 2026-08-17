#!/usr/bin/env python3
"""Audit Azure network security groups for internet-exposed administrative ports.

Effective rules matter more than authored ones, so where the credential has
permission the script pulls the *effective* NSG rules for each NIC — the merged
result of subnet-level and NIC-level groups, which is what traffic actually
hits. It falls back to authored rules when effective rules are unavailable.

Severity model:

    CRITICAL  Allow from Internet/Any to an admin port (SSH, RDP, WinRM, SQL,
              Redis, Mongo, Elasticsearch, Kubernetes API, ...)
    HIGH      Allow from Internet/Any to any port, or a rule allowing all ports
    MEDIUM    Allow from a very wide private range to an admin port
    INFO      NSG attached to nothing, or with no custom rules

Examples
--------
    ./nsg_audit.py --all-subscriptions --min-severity HIGH
    ./nsg_audit.py --resource-group prod-network --format json
    ./nsg_audit.py --fail-on-findings   # CI gate
"""

from __future__ import annotations

import ipaddress

from common import (
    LOG,
    base_parser,
    credential,
    in_scope,
    render,
    resource_group_of,
    safe_list,
    setup_logging,
    subscriptions,
)

try:
    from azure.mgmt.network import NetworkManagementClient
except ImportError:  # pragma: no cover
    raise SystemExit("pip install -r requirements.txt")

SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "INFO": 3}

ADMIN_PORTS = {
    22: "SSH",
    23: "telnet",
    135: "RPC",
    139: "NetBIOS",
    445: "SMB",
    1433: "MSSQL",
    1521: "Oracle",
    2379: "etcd",
    3306: "MySQL",
    3389: "RDP",
    5432: "PostgreSQL",
    5601: "Kibana",
    5985: "WinRM",
    5986: "WinRM/TLS",
    6379: "Redis",
    6443: "Kubernetes API",
    9200: "Elasticsearch",
    10250: "kubelet",
    11211: "memcached",
    27017: "MongoDB",
}

INTERNET_SOURCES = {"*", "internet", "any", "0.0.0.0/0", "::/0"}

COLUMNS = ("severity", "nsg", "rule", "priority", "source", "ports", "protocol", "finding")


def normalise(values, single) -> list[str]:
    """NSG rules carry either a singular or a plural field; unify them."""
    if values:
        return [str(v) for v in values]
    return [str(single)] if single is not None else []


def expand_ports(port_specs: list[str]) -> tuple[bool, set[int]]:
    """Return (covers_all, explicit_admin_ports_covered)."""
    covers_all = False
    hit: set[int] = set()
    for spec in port_specs:
        if spec == "*":
            covers_all = True
            continue
        if "-" in spec:
            try:
                lo, hi = (int(p) for p in spec.split("-", 1))
            except ValueError:
                continue
            hit.update(p for p in ADMIN_PORTS if lo <= p <= hi)
        else:
            try:
                port = int(spec)
            except ValueError:
                continue
            if port in ADMIN_PORTS:
                hit.add(port)
    return covers_all, hit


def source_is_internet(sources: list[str]) -> bool:
    return any(s.strip().lower() in INTERNET_SOURCES for s in sources)


def source_is_wide_private(sources: list[str]) -> bool:
    for src in sources:
        try:
            net = ipaddress.ip_network(src, strict=False)
        except ValueError:
            continue
        if net.is_private and net.prefixlen <= 16:
            return True
    return False


def classify(rule) -> tuple[str, str] | None:
    if rule.direction != "Inbound" or rule.access != "Allow":
        return None

    sources = normalise(rule.source_address_prefixes, rule.source_address_prefix)
    ports = normalise(rule.destination_port_ranges, rule.destination_port_range)
    covers_all, admin_hits = expand_ports(ports)

    if source_is_internet(sources):
        if covers_all:
            return "CRITICAL", "all ports open to the internet"
        if admin_hits:
            names = ", ".join(ADMIN_PORTS[p] for p in sorted(admin_hits)[:4])
            return "CRITICAL", f"internet-facing admin service: {names}"
        return "HIGH", "internet-facing inbound allow"

    if source_is_wide_private(sources) and (admin_hits or covers_all):
        scope = "all ports" if covers_all else ", ".join(
            ADMIN_PORTS[p] for p in sorted(admin_hits)[:4]
        )
        return "MEDIUM", f"wide internal source reaches {scope}"

    return None


def rules_for(client, nsg, use_effective: bool) -> list:
    """Effective rules when we can get them, authored rules otherwise."""
    if not use_effective or not nsg.network_interfaces:
        return list(nsg.security_rules or [])

    nic_id = nsg.network_interfaces[0].id
    try:
        poller = client.network_interfaces.begin_list_effective_network_security_groups(
            resource_group_of(nic_id), nic_id.rstrip("/").split("/")[-1]
        )
        effective = poller.result()
        merged = []
        for entry in effective.value or []:
            merged.extend(entry.effective_security_rules or [])
        if merged:
            LOG.debug("using effective rules for %s (%d)", nsg.name, len(merged))
            return merged
    except Exception as exc:  # noqa: BLE001 - needs a running VM and extra rights
        LOG.debug("effective rules unavailable for %s: %s", nsg.name, exc)
    return list(nsg.security_rules or [])


def audit_subscription(client, sub_name: str, args) -> list[dict]:
    rows: list[dict] = []
    for nsg in safe_list(client.network_security_groups.list_all, f"NSGs in {sub_name}"):
        if not in_scope(nsg.id, args.resource_group):
            continue

        attached = bool(nsg.subnets or nsg.network_interfaces)
        if not attached and not args.include_unattached:
            continue

        rules = rules_for(client, nsg, args.effective)
        if not rules:
            rows.append({
                "severity": "INFO",
                "nsg": nsg.name,
                "rule": "-",
                "priority": "-",
                "source": "-",
                "ports": "-",
                "protocol": "-",
                "finding": "no custom rules" + ("" if attached else "; attached to nothing"),
                "_subscription": sub_name,
                "_resource_group": resource_group_of(nsg.id),
            })
            continue

        for rule in rules:
            verdict = classify(rule)
            if verdict is None:
                continue
            severity, finding = verdict
            sources = normalise(rule.source_address_prefixes, rule.source_address_prefix)
            ports = normalise(rule.destination_port_ranges, rule.destination_port_range)
            rows.append({
                "severity": severity,
                "nsg": nsg.name,
                "rule": getattr(rule, "name", "effective"),
                "priority": rule.priority,
                "source": ",".join(sources) or "-",
                "ports": ",".join(ports) or "-",
                "protocol": rule.protocol,
                "finding": finding + ("" if attached else " (NSG unattached)"),
                "_subscription": sub_name,
                "_resource_group": resource_group_of(nsg.id),
            })
    return rows


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument(
        "--min-severity", choices=tuple(SEVERITY_ORDER), default="MEDIUM",
        help="suppress findings below this severity",
    )
    parser.add_argument(
        "--include-unattached", action="store_true",
        help="also audit NSGs not attached to a subnet or NIC",
    )
    parser.add_argument(
        "--effective", action="store_true",
        help="resolve effective (merged subnet + NIC) rules where permitted",
    )
    parser.add_argument(
        "--fail-on-findings", action="store_true",
        help="exit non-zero when anything is reported (for CI gates)",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    cred = credential()
    rows: list[dict] = []
    for sub_id, sub_name in subscriptions(cred, args):
        LOG.info("auditing subscription %s", sub_name)
        rows.extend(audit_subscription(NetworkManagementClient(cred, sub_id), sub_name, args))

    cutoff = SEVERITY_ORDER[args.min_severity]
    rows = [r for r in rows if SEVERITY_ORDER[r["severity"]] <= cutoff]
    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["nsg"], r["priority"]))

    render(rows, COLUMNS, args.format)

    if args.format == "table" and rows:
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["severity"]] = counts.get(row["severity"], 0) + 1
        print("Summary: " + ", ".join(
            f"{k}={counts[k]}" for k in sorted(counts, key=lambda s: SEVERITY_ORDER[s])
        ))

    if args.fail_on_findings and rows:
        LOG.error("%d finding(s) at or above %s", len(rows), args.min_severity)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
