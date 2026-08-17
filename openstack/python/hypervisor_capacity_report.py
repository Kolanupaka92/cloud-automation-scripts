#!/usr/bin/env python3
"""Nova capacity and overcommit per compute node.

Numbers come from Placement so they match what the scheduler actually sees.
With --flavor it also works out how many more of that flavor will fit.

    ./hypervisor_capacity_report.py --threshold 85
    ./hypervisor_capacity_report.py --flavor m1.large --format json
"""

from __future__ import annotations

import sys

from common import (
    EMPTY_CLASS,
    base_parser,
    connect,
    pct,
    placement_capacity,
    render,
    setup_logging,
    usable,
)

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


def hypervisor_rows(conn, aggregate_hosts: set[str] | None) -> list[dict]:
    capacity = placement_capacity(conn)
    rows = []

    for hv in conn.compute.hypervisors(details=True):
        name = hv.name
        if aggregate_hosts is not None and name not in aggregate_hosts:
            continue

        provider = capacity.get(name)
        if provider:
            vcpu = provider.get("VCPU", EMPTY_CLASS)
            mem = provider.get("MEMORY_MB", EMPTY_CLASS)
            disk = provider.get("DISK_GB", EMPTY_CLASS)
            vcpu_total, vcpu_used = usable(vcpu), vcpu["used"]
            mem_total, mem_used = usable(mem), mem["used"]
            disk_total, disk_used = usable(disk), disk["used"]
            source = "placement"
        else:
            # Pre-2.88 clouds only. These fields are deprecated and will be
            # None on anything current, which is why Placement is preferred.
            vcpu_total, vcpu_used = float(hv.vcpus or 0), float(hv.vcpus_used or 0)
            mem_total, mem_used = float(hv.memory_size or 0), float(hv.memory_used or 0)
            disk_total, disk_used = float(hv.local_disk_size or 0), float(hv.local_disk_used or 0)
            source = "nova"

        rows.append(
            {
                "hypervisor": name,
                "state": f"{hv.state}/{hv.status}",
                "vms": hv.running_vms or 0,
                "vcpu_used": int(vcpu_used),
                "vcpu_total": int(vcpu_total),
                "vcpu_pct": pct(vcpu_used, vcpu_total),
                "mem_used_gb": round(mem_used / 1024, 1),
                "mem_total_gb": round(mem_total / 1024, 1),
                "mem_pct": pct(mem_used, mem_total),
                "disk_pct": pct(disk_used, disk_total),
                # Kept out of the default column set but useful in --format json.
                "_source": source,
                "_vcpu_free": int(vcpu_total - vcpu_used),
                "_mem_free_mb": int(mem_total - mem_used),
                "_disk_free_gb": int(disk_total - disk_used),
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
