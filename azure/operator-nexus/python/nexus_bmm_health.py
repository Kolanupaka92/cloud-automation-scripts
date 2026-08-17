#!/usr/bin/env python3
"""Fleet health report for Operator Nexus bare metal machines.

This is the report you want open before a quarterly maintenance window and
during any BMM incident. For every machine in scope it reports the control-plane
view (readyState, detailedStatus, powerState, cordonStatus, hardware validation)
plus the tenant impact (how many tenant VMs would move if this machine went
down) and the Nexus Kubernetes node it backs.

Rack-level summaries matter more than per-machine ones during maintenance: the
question is never "is BMM-07 healthy" but "can this rack lose a machine right
now without breaking a control-plane quorum".

Exit codes: 0 all healthy, 1 warnings, 2 machines unavailable or not ready.

Examples
--------
    ./nexus_bmm_health.py --resource-group rg-nexus-prod
    ./nexus_bmm_health.py --rack rack-03 --format json
    ./nexus_bmm_health.py --unhealthy-only --fail-on-findings
    ./nexus_bmm_health.py --maintenance-readiness   # pre-window gate
"""

from __future__ import annotations

from nexus_common import (
    LOG,
    base_parser,
    client,
    health_summary,
    list_machines,
    machine_name,
    machine_rg,
    prop,
    rack_name,
    rack_slot,
    render,
    setup_logging,
    text,
    workload_count,
)

COLUMNS = (
    "machine",
    "rack",
    "slot",
    "ready",
    "power",
    "cordon",
    "detailed_status",
    "tenant_vms",
    "k8s_node",
    "problems",
)


def machine_row(machine) -> dict:
    problems = health_summary(machine)
    hardware = prop(machine, "hardware_validation_status")
    return {
        "machine": machine_name(machine),
        "rack": rack_name(machine),
        "slot": rack_slot(machine),
        "ready": text(prop(machine, "ready_state")),
        "power": text(prop(machine, "power_state"), "-"),
        "cordon": text(prop(machine, "cordon_status"), "Uncordoned"),
        "detailed_status": text(prop(machine, "detailed_status"), "-"),
        "tenant_vms": workload_count(machine),
        "k8s_node": text(prop(machine, "kubernetes_node_name"), "-"),
        "problems": "; ".join(problems) or "none",
        # Extra context that only makes sense in --format json.
        "_resource_group": machine_rg(machine),
        "_serial": prop(machine, "serial_number"),
        "_sku": prop(machine, "machine_sku_id"),
        "_oam_ip": prop(machine, "oam_ipv4_address"),
        "_bmc_ip": prop(machine, "bmc_connection_string"),
        "_machine_cluster_version": prop(machine, "machine_cluster_version"),
        "_kubernetes_version": prop(machine, "kubernetes_version"),
        "_detailed_status_message": prop(machine, "detailed_status_message"),
        "_hardware_validation": getattr(hardware, "result", None) if hardware else None,
        "_healthy": not problems,
    }


def rack_report(rows: list[dict], min_healthy_per_rack: int) -> list[str]:
    """Per-rack readiness lines, plus warnings where a rack is too thin."""
    lines = []
    racks: dict[str, list[dict]] = {}
    for row in rows:
        racks.setdefault(row["rack"], []).append(row)

    for rack in sorted(racks):
        members = racks[rack]
        healthy = [r for r in members if r["_healthy"]]
        cordoned = [r for r in members if r["cordon"] != "Uncordoned"]
        powered_off = [r for r in members if r["power"] != "On"]
        tenant_vms = sum(r["tenant_vms"] for r in members)

        line = (f"  {rack:<16} {len(healthy)}/{len(members)} healthy, "
                f"{tenant_vms} tenant VM(s)")
        if cordoned:
            line += f", {len(cordoned)} cordoned"
        if powered_off:
            line += f", {len(powered_off)} powered off"
        if len(healthy) < min_healthy_per_rack:
            line += "  <-- BELOW MAINTENANCE THRESHOLD"
        lines.append(line)
    return lines


def maintenance_readiness(rows: list[dict], min_healthy_per_rack: int) -> tuple[bool, list[str]]:
    """Can a maintenance window start right now?"""
    blockers = []

    not_ready = [r for r in rows if r["ready"] != "True"]
    if not_ready:
        blockers.append(
            f"{len(not_ready)} machine(s) not ready: "
            + ", ".join(r["machine"] for r in not_ready[:5])
        )

    already_cordoned = [r for r in rows if r["cordon"] != "Uncordoned"]
    if already_cordoned:
        blockers.append(
            f"{len(already_cordoned)} machine(s) already cordoned from a previous window: "
            + ", ".join(r["machine"] for r in already_cordoned[:5])
        )

    powered_off = [r for r in rows if r["power"] != "On"]
    if powered_off:
        blockers.append(
            f"{len(powered_off)} machine(s) powered off: "
            + ", ".join(r["machine"] for r in powered_off[:5])
        )

    racks: dict[str, list[dict]] = {}
    for row in rows:
        racks.setdefault(row["rack"], []).append(row)
    for rack, members in sorted(racks.items()):
        healthy = sum(1 for r in members if r["_healthy"])
        if healthy < min_healthy_per_rack:
            blockers.append(
                f"rack {rack} has only {healthy} healthy machine(s); "
                f"taking one more down breaks the {min_healthy_per_rack}-machine floor"
            )

    return (not blockers), blockers


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument(
        "--unhealthy-only", action="store_true",
        help="only list machines with at least one problem",
    )
    parser.add_argument(
        "--min-healthy-per-rack", type=int, default=3,
        help="healthy machines a rack must retain during maintenance",
    )
    parser.add_argument(
        "--maintenance-readiness", action="store_true",
        help="evaluate whether a maintenance window can safely start now",
    )
    parser.add_argument(
        "--fail-on-findings", action="store_true",
        help="exit non-zero when any machine is unhealthy",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    nc = client(args.subscription)
    machines = list_machines(nc, args)
    if not machines:
        LOG.error("no bare metal machines matched the given scope")
        return 2

    rows = [machine_row(m) for m in machines]
    unhealthy = [r for r in rows if not r["_healthy"]]

    shown = unhealthy if args.unhealthy_only else rows
    render(shown, COLUMNS, args.format)

    if args.format == "table":
        print(f"\nFleet: {len(rows) - len(unhealthy)}/{len(rows)} machine(s) healthy, "
              f"{sum(r['tenant_vms'] for r in rows)} tenant VM(s) hosted")
        print("\nPer-rack readiness:")
        for line in rack_report(rows, args.min_healthy_per_rack):
            print(line)

    if args.maintenance_readiness:
        ready, blockers = maintenance_readiness(rows, args.min_healthy_per_rack)
        print("\nMaintenance readiness: " + ("GO" if ready else "NO-GO"))
        for blocker in blockers:
            print(f"  - {blocker}")
        if not ready:
            return 2

    not_ready = [r for r in rows if r["ready"] != "True" or r["power"] != "On"]
    if args.fail_on_findings and not_ready:
        return 2
    if args.fail_on_findings and unhealthy:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
