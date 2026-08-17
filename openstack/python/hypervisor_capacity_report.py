#!/usr/bin/env python3
"""Nova capacity and overcommit report across every compute node in a region.

Answers the two questions that come up in every capacity review:

  1. Which hypervisors are close to exhausting vCPU / RAM / disk?
  2. How many more instances of flavor X can this region actually place?

Placement's allocation ratios are read from the Placement API when available so
the numbers match what the scheduler believes, rather than raw hardware totals.

Examples
--------
    ./hypervisor_capacity_report.py --threshold 85
    ./hypervisor_capacity_report.py --flavor m1.large --format json
    ./hypervisor_capacity_report.py --aggregate gpu-nodes --sort mem_pct
"""

from __future__ import annotations

import sys

from common import LOG, base_parser, connect, pct, render, setup_logging

COLUMNS = (
    "hypervisor",
    "state",
    "vms",
    "vcpu_used",
    "vcpu_total",
    "vcpu_pct",
    "mem_used_gb",
    "mem_total_gb",
    "mem_pct",
    "disk_pct",
)


def placement_ratios(conn) -> dict[str, dict[str, float]]:
    """Map resource provider name -> {VCPU: ratio, MEMORY_MB: ratio, DISK_GB: ratio}.

    Falls back to an empty map (i.e. ratio 1.0) if the Placement API is not
    reachable — older deployments or restricted credentials.
    """
    ratios: dict[str, dict[str, float]] = {}
    try:
        for provider in conn.placement.resource_providers():
            inventories = conn.placement.resource_provider_inventories(provider)
            ratios[provider.name] = {
                inv.resource_class: float(getattr(inv, "allocation_ratio", 1.0) or 1.0)
                for inv in inventories
            }
    except Exception as exc:  # noqa: BLE001 - placement is best-effort here
        LOG.warning("placement inventory unavailable (%s); using raw totals", exc)
    return ratios


def hypervisor_rows(conn, aggregate_hosts: set[str] | None) -> list[dict]:
    ratios = placement_ratios(conn)
    rows = []

    for hv in conn.compute.hypervisors(details=True):
        name = hv.name
        if aggregate_hosts is not None and name not in aggregate_hosts:
            continue

        ratio = ratios.get(name, {})
        vcpu_total = (hv.vcpus or 0) * ratio.get("VCPU", 1.0)
        mem_total = (hv.memory_size or 0) * ratio.get("MEMORY_MB", 1.0)
        disk_total = (hv.local_disk_size or 0) * ratio.get("DISK_GB", 1.0)

        rows.append(
            {
                "hypervisor": name,
                "state": f"{hv.state}/{hv.status}",
                "vms": hv.running_vms or 0,
                "vcpu_used": hv.vcpus_used or 0,
                "vcpu_total": int(vcpu_total),
                "vcpu_pct": pct(hv.vcpus_used or 0, vcpu_total),
                "mem_used_gb": round((hv.memory_used or 0) / 1024, 1),
                "mem_total_gb": round(mem_total / 1024, 1),
                "mem_pct": pct(hv.memory_used or 0, mem_total),
                "disk_pct": pct(hv.local_disk_used or 0, disk_total),
                # Kept out of the default column set but useful in --format json.
                "_vcpu_free": int(vcpu_total - (hv.vcpus_used or 0)),
                "_mem_free_mb": int(mem_total - (hv.memory_used or 0)),
                "_disk_free_gb": int(disk_total - (hv.local_disk_used or 0)),
            }
        )
    return rows


def aggregate_members(conn, aggregate_name: str) -> set[str]:
    for agg in conn.compute.aggregates():
        if agg.name == aggregate_name:
            return set(agg.hosts or [])
    sys.exit(f"host aggregate '{aggregate_name}' not found")


def flavor_fit(conn, rows: list[dict], flavor_name: str) -> None:
    """Report how many instances of a flavor still fit, per host and in total."""
    flavor = conn.compute.find_flavor(flavor_name, ignore_missing=True)
    if flavor is None:
        sys.exit(f"flavor '{flavor_name}' not found")

    disk_need = (flavor.disk or 0) + (flavor.ephemeral or 0)
    total = 0
    per_host = []

    for row in rows:
        if not row["state"].startswith("up"):
            continue
        fits = min(
            row["_vcpu_free"] // flavor.vcpus if flavor.vcpus else 0,
            row["_mem_free_mb"] // flavor.ram if flavor.ram else 0,
            row["_disk_free_gb"] // disk_need if disk_need else 10**6,
        )
        fits = max(fits, 0)
        total += fits
        per_host.append((row["hypervisor"], fits))

    print(f"\nCapacity for flavor {flavor.name} "
          f"({flavor.vcpus} vCPU / {flavor.ram} MB / {disk_need} GB):")
    for name, fits in sorted(per_host, key=lambda item: -item[1])[:10]:
        print(f"  {name:<40} {fits:>5}")
    print(f"  {'TOTAL PLACEABLE':<40} {total:>5}")


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.0,
        help="only show hosts where any resource exceeds this percentage",
    )
    parser.add_argument("--aggregate", help="restrict to hosts in this host aggregate")
    parser.add_argument("--flavor", help="also report how many of this flavor still fit")
    parser.add_argument(
        "--sort",
        choices=("hypervisor", "vcpu_pct", "mem_pct", "disk_pct", "vms"),
        default="mem_pct",
        help="sort key (percentages sort descending)",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    conn = connect(args.cloud)
    hosts = aggregate_members(conn, args.aggregate) if args.aggregate else None
    rows = hypervisor_rows(conn, hosts)

    if args.threshold:
        rows = [
            r
            for r in rows
            if max(r["vcpu_pct"], r["mem_pct"], r["disk_pct"]) >= args.threshold
        ]

    reverse = args.sort != "hypervisor"
    rows.sort(key=lambda r: r[args.sort], reverse=reverse)

    render(rows, COLUMNS, args.format)

    if args.format == "table" and rows:
        vcpu_used = sum(r["vcpu_used"] for r in rows)
        vcpu_total = sum(r["vcpu_total"] for r in rows)
        mem_used = sum(r["mem_used_gb"] for r in rows)
        mem_total = sum(r["mem_total_gb"] for r in rows)
        print(
            f"\nRegion totals: vCPU {vcpu_used}/{vcpu_total} "
            f"({pct(vcpu_used, vcpu_total)}%), "
            f"RAM {mem_used:.0f}/{mem_total:.0f} GB ({pct(mem_used, mem_total)}%)"
        )

    if args.flavor:
        flavor_fit(conn, rows, args.flavor)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
