#!/usr/bin/env python3
"""VM rightsizing from 30 days of Azure Monitor metrics.

Uses p95 rather than averages, because an average hides the peak that makes a
downsize a bad idea. Produces IDLE / DOWNSIZE / UPSIZE / OK with an estimated
monthly saving.

Reports only. Resizing needs a reboot, so it belongs in a window and in a
change record.

Prices are a rough built-in table; swap in your own rates for real numbers.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

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
    tag,
)

try:
    from azure.mgmt.compute import ComputeManagementClient
    from azure.mgmt.monitor import MonitorManagementClient
except ImportError:  # pragma: no cover
    raise SystemExit("pip install -r requirements.txt")

COLUMNS = (
    "vm",
    "resource_group",
    "size",
    "cpu_p95",
    "mem_p95",
    "recommendation",
    "suggested_size",
    "est_saving_usd_mo",
)

# One step down / up within the same VM family. Extend for the sizes in use at
# your site; anything not listed simply reports "review manually".
SIZE_LADDER = {
    "Standard_D2s_v5": "Standard_D4s_v5",
    "Standard_D4s_v5": "Standard_D8s_v5",
    "Standard_D8s_v5": "Standard_D16s_v5",
    "Standard_D16s_v5": "Standard_D32s_v5",
    "Standard_E2s_v5": "Standard_E4s_v5",
    "Standard_E4s_v5": "Standard_E8s_v5",
    "Standard_E8s_v5": "Standard_E16s_v5",
    "Standard_F2s_v2": "Standard_F4s_v2",
    "Standard_F4s_v2": "Standard_F8s_v2",
    "Standard_F8s_v2": "Standard_F16s_v2",
}
SIZE_LADDER_DOWN = {larger: smaller for smaller, larger in SIZE_LADDER.items()}

# Rough on-demand USD/month, Linux, PAYG. Nowhere near your actual bill if you
# have an EA or reservations. Fine for ranking candidates, not for finance.
SIZE_PRICES = {
    "Standard_D2s_v5": 70.0,
    "Standard_D4s_v5": 140.0,
    "Standard_D8s_v5": 280.0,
    "Standard_D16s_v5": 560.0,
    "Standard_D32s_v5": 1120.0,
    "Standard_E2s_v5": 91.0,
    "Standard_E4s_v5": 182.0,
    "Standard_E8s_v5": 364.0,
    "Standard_E16s_v5": 728.0,
    "Standard_F2s_v2": 61.0,
    "Standard_F4s_v2": 122.0,
    "Standard_F8s_v2": 244.0,
    "Standard_F16s_v2": 488.0,
}


def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile; no numpy dependency for a fleet report."""
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(int(round(pct / 100 * len(ordered) + 0.5)) - 1, len(ordered) - 1)
    return round(ordered[max(index, 0)], 1)


def metric_series(monitor, resource_id: str, metric: str, days: int) -> list[float]:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    try:
        result = monitor.metrics.list(
            resource_id,
            timespan=f"{start.isoformat()}/{end.isoformat()}",
            interval="PT1H",
            metricnames=metric,
            aggregation="Average",
        )
    except Exception as exc:  # noqa: BLE001 - metric may not exist without the agent
        LOG.debug("metric %s unavailable for %s: %s", metric, resource_id, exc)
        return []

    values = []
    for item in result.value:
        for series in item.timeseries:
            for point in series.data:
                if point.average is not None:
                    values.append(point.average)
    return values


def classify(cpu_p95: float, mem_p95: float | None, net_total: float, args) -> str:
    if cpu_p95 < args.idle_cpu and net_total <= 0:
        return "IDLE"
    if cpu_p95 > args.high_cpu or (mem_p95 is not None and mem_p95 > args.high_mem):
        return "UPSIZE"
    if cpu_p95 < args.low_cpu and (mem_p95 is None or mem_p95 < args.low_mem):
        return "DOWNSIZE"
    return "OK"


def suggest(size: str, recommendation: str) -> str:
    if recommendation == "DOWNSIZE":
        return SIZE_LADDER_DOWN.get(size, "review manually")
    if recommendation == "UPSIZE":
        return SIZE_LADDER.get(size, "review manually")
    if recommendation == "IDLE":
        return "deallocate"
    return "-"


def saving(size: str, suggested: str, recommendation: str) -> float:
    current = SIZE_PRICES.get(size)
    if current is None:
        return 0.0
    if recommendation == "IDLE":
        return round(current, 2)
    target = SIZE_PRICES.get(suggested)
    if target is None:
        return 0.0
    return round(current - target, 2)


def analyse_subscription(cred, sub_id: str, sub_name: str, args) -> list[dict]:
    compute = ComputeManagementClient(cred, sub_id)
    monitor = MonitorManagementClient(cred, sub_id)
    rows = []

    for vm in safe_list(compute.virtual_machines.list_all, f"VMs in {sub_name}"):
        if not in_scope(vm.id, args.resource_group):
            continue
        if tag(vm, "RightsizingExempt", "") != "":
            LOG.debug("skipping %s: tagged RightsizingExempt", vm.name)
            continue

        size = vm.hardware_profile.vm_size if vm.hardware_profile else "unknown"
        cpu = metric_series(monitor, vm.id, "Percentage CPU", args.days)
        if not cpu:
            LOG.debug("no CPU data for %s; skipping", vm.name)
            continue

        mem_series = metric_series(monitor, vm.id, "Available Memory Bytes", args.days)
        network = metric_series(monitor, vm.id, "Network In Total", args.days)

        cpu_p95 = percentile(cpu, 95)
        # Available memory is inverted: low availability means high utilisation.
        mem_p95 = None
        if mem_series and vm.hardware_profile:
            min_available = min(mem_series)
            total_guess = max(mem_series) + min_available
            if total_guess:
                mem_p95 = round((1 - (min_available / total_guess)) * 100, 1)

        recommendation = classify(cpu_p95, mem_p95, sum(network), args)
        suggested = suggest(size, recommendation)

        rows.append({
            "vm": vm.name,
            "resource_group": resource_group_of(vm.id),
            "subscription": sub_name,
            "size": size,
            "cpu_p95": cpu_p95,
            "mem_p95": mem_p95 if mem_p95 is not None else "n/a",
            "recommendation": recommendation,
            "suggested_size": suggested,
            "est_saving_usd_mo": saving(size, suggested, recommendation),
            "samples": len(cpu),
        })
    return rows


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=30, help="metric lookback window")
    parser.add_argument("--idle-cpu", type=float, default=3.0, help="p95 CPU%% below which a VM is idle")
    parser.add_argument("--low-cpu", type=float, default=20.0, help="p95 CPU%% below which to downsize")
    parser.add_argument("--low-mem", type=float, default=40.0, help="p95 memory%% below which to downsize")
    parser.add_argument("--high-cpu", type=float, default=80.0, help="p95 CPU%% above which to upsize")
    parser.add_argument("--high-mem", type=float, default=85.0, help="p95 memory%% above which to upsize")
    parser.add_argument(
        "--recommendation",
        choices=("IDLE", "DOWNSIZE", "UPSIZE", "OK"),
        help="only show VMs with this recommendation",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    cred = credential()
    rows: list[dict] = []
    for sub_id, sub_name in subscriptions(cred, args):
        LOG.info("analysing subscription %s over %d day(s)", sub_name, args.days)
        rows.extend(analyse_subscription(cred, sub_id, sub_name, args))

    if args.recommendation:
        rows = [r for r in rows if r["recommendation"] == args.recommendation]

    rows.sort(key=lambda r: -r["est_saving_usd_mo"])
    render(rows, COLUMNS, args.format)

    if args.format == "table" and rows:
        total = round(sum(r["est_saving_usd_mo"] for r in rows), 2)
        print(f"Estimated saving if every recommendation is applied: "
              f"${total}/month (${round(total * 12, 2)}/year)")
        print("Sizing changes require a reboot, schedule them in a maintenance window.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
