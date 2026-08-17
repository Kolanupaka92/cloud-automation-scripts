#!/usr/bin/env python3
"""Drain a compute node before maintenance.

Checks there is somewhere for the instances to go, disables nova-compute with
a reason attached, then live-migrates one instance at a time, waiting for each
to land before starting the next. Anything it cannot move is reported rather
than forced.

    ./compute_node_drain.py --host compute-042 --dry-run
    ./compute_node_drain.py --host compute-042 --reason "CHG0041827 firmware"
    ./compute_node_drain.py --host compute-042 --undrain
"""

from __future__ import annotations

import time

from common import (
    LOG,
    base_parser,
    confirm,
    connect,
    host_capacity,
    render,
    setup_logging,
)

# Instances in these states can be live-migrated; anything else needs a human.
MIGRATABLE_VM_STATES = {"active", "paused"}
TERMINAL_MIGRATION_STATES = {"ACTIVE", "PAUSED", "ERROR", "SHUTOFF"}

COLUMNS = ("instance", "name", "project_id", "vm_state", "flavor", "action")


def find_service(conn, host: str):
    for svc in conn.compute.services():
        if svc.host == host and svc.binary == "nova-compute":
            return svc
    return None


def instances_on(conn, host: str) -> list:
    return list(conn.compute.servers(all_projects=True, details=True, host=host))


def plan(conn, host: str) -> list[dict]:
    rows = []
    for srv in instances_on(conn, host):
        state = (srv.vm_state or "").lower()
        if state in MIGRATABLE_VM_STATES:
            action = "live-migrate"
        elif state == "shutoff":
            action = "cold-migrate (manual)"
        else:
            action = f"SKIP ({state})"
        flavor = (srv.flavor or {}).get("original_name") or (srv.flavor or {}).get("id", "-")
        rows.append(
            {
                "instance": srv.id,
                "name": srv.name,
                "project_id": srv.project_id,
                "vm_state": state,
                "flavor": flavor,
                "action": action,
                "_migratable": action == "live-migrate",
            }
        )
    return rows


def capacity_available(conn, host: str, rows: list[dict]) -> bool:
    """Rough check that the rest of the region can absorb this host's load."""
    needed_vcpu = 0
    needed_mem = 0
    for row in rows:
        if not row["_migratable"]:
            continue
        flavor = conn.compute.find_flavor(row["flavor"], ignore_missing=True)
        if flavor is None:
            LOG.warning("flavor %s not found; skipping capacity math", row["flavor"])
            continue
        needed_vcpu += flavor.vcpus or 0
        needed_mem += flavor.ram or 0

    # Capacity comes from Placement where available; the hypervisor API stopped
    # reporting these numbers at Nova 2.88, and a zero here would wave through a
    # drain the region cannot actually absorb.
    hypervisors = [
        hv for hv in conn.compute.hypervisors(details=True)
        if hv.name != host and hv.state == "up" and hv.status == "enabled"
    ]
    capacity = host_capacity(conn, hypervisors)
    free_vcpu = sum(entry["vcpu_free"] for entry in capacity.values())
    free_mem = sum(entry["mem_free"] for entry in capacity.values())
    sources = {entry["source"] for entry in capacity.values()} or {"none"}

    LOG.info(
        "need %d vCPU / %d MB; %d other host(s) have %d vCPU / %d MB free (source: %s)",
        needed_vcpu, needed_mem, len(capacity), free_vcpu, free_mem, ",".join(sorted(sources)),
    )
    return free_vcpu >= needed_vcpu and free_mem >= needed_mem


def wait_for_migration(conn, server_id: str, host: str, timeout: int, interval: int) -> bool:
    """Poll one instance until it lands somewhere else or the timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        srv = conn.compute.get_server(server_id)
        current_host = getattr(srv, "compute_host", None) or srv.hypervisor_hostname
        if srv.status in TERMINAL_MIGRATION_STATES and current_host != host:
            LOG.info("  -> %s landed on %s (%s)", server_id, current_host, srv.status)
            return srv.status != "ERROR"
        if srv.status == "ERROR":
            LOG.error("  -> %s entered ERROR during migration", server_id)
            return False
        time.sleep(interval)
    LOG.error("  -> %s did not finish migrating within %ss", server_id, timeout)
    return False


def drain(conn, host: str, rows: list[dict], args) -> int:
    service = find_service(conn, host)
    if service is None:
        LOG.error("no nova-compute service found for host %s", host)
        return 2
    if service.state != "up":
        LOG.warning("nova-compute on %s is %s; live migration will likely fail",
                    host, service.state)

    if args.dry_run:
        LOG.info("dry-run: would disable nova-compute on %s and migrate %d instance(s)",
                 host, sum(1 for r in rows if r["_migratable"]))
        return 0

    if not confirm(f"Drain {host} ({sum(1 for r in rows if r['_migratable'])} instances)?",
                   args.yes):
        LOG.info("aborted")
        return 1

    conn.compute.disable_service(service, disabled_reason=args.reason)
    LOG.info("disabled nova-compute on %s (reason: %s)", host, args.reason)

    failures = 0
    for row in rows:
        if not row["_migratable"]:
            LOG.warning("skipping %s (%s): %s", row["instance"], row["name"], row["action"])
            continue
        LOG.info("live-migrating %s (%s)", row["instance"], row["name"])
        try:
            conn.compute.live_migrate_server(
                row["instance"],
                host=None,            # let the scheduler pick the destination
                block_migration="auto",
            )
        except Exception as exc:  # noqa: BLE001 - one failure must not stop the drain
            LOG.error("  -> migration call failed for %s: %s", row["instance"], exc)
            failures += 1
            continue
        if not wait_for_migration(conn, row["instance"], host, args.timeout, args.poll):
            failures += 1

    remaining = instances_on(conn, host)
    if remaining:
        LOG.warning("%d instance(s) still on %s:", len(remaining), host)
        for srv in remaining:
            LOG.warning("  %s (%s) vm_state=%s", srv.id, srv.name, srv.vm_state)
    else:
        LOG.info("%s is empty and ready for maintenance", host)

    return 1 if failures or remaining else 0


def undrain(conn, host: str, dry_run: bool) -> int:
    service = find_service(conn, host)
    if service is None:
        LOG.error("no nova-compute service found for host %s", host)
        return 2
    if dry_run:
        LOG.info("dry-run: would re-enable nova-compute on %s", host)
        return 0
    conn.compute.enable_service(service)
    LOG.info("re-enabled nova-compute on %s", host)
    return 0


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--host", required=True, help="compute hostname to drain")
    parser.add_argument(
        "--reason",
        default="planned maintenance",
        help="disabled_reason recorded on the nova-compute service",
    )
    parser.add_argument(
        "--undrain",
        action="store_true",
        help="re-enable the compute service instead of draining it",
    )
    parser.add_argument(
        "--timeout", type=int, default=1800, help="seconds to wait per migration"
    )
    parser.add_argument("--poll", type=int, default=15, help="poll interval in seconds")
    parser.add_argument(
        "--skip-capacity-check",
        action="store_true",
        help="drain even if the rest of the region looks too full",
    )
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()
    setup_logging(args.verbose)

    conn = connect(args.cloud)

    if args.undrain:
        return undrain(conn, args.host, args.dry_run)

    rows = plan(conn, args.host)
    render(rows, COLUMNS, args.format)

    if not rows:
        LOG.info("%s has no instances; safe to take offline", args.host)
        return 0

    if not capacity_available(conn, args.host, rows) and not args.skip_capacity_check:
        LOG.error(
            "insufficient free capacity elsewhere to absorb %s; "
            "add capacity or pass --skip-capacity-check",
            args.host,
        )
        return 2

    return drain(conn, args.host, rows, args)


if __name__ == "__main__":
    raise SystemExit(main())
