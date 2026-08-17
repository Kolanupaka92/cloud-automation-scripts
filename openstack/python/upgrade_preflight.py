#!/usr/bin/env python3
"""Pre-upgrade validation gate for an OpenStack region.

Run this before every maintenance window. It fails loudly on the conditions
that historically turn a routine upgrade into an incident:

    services          any nova/cinder/neutron service or agent that is down
    version-skew      compute nodes not all on the same service version
    stuck-instances   VMs in a transitional or ERROR state that will not survive
                      a control-plane restart cleanly
    stuck-volumes     volumes stuck in creating/attaching/detaching/error
    orphan-migrations migrations left in a non-terminal state
    quota-headroom    projects at >= --quota-threshold of any quota, which turn
                      post-upgrade retries into hard failures
    capacity          not enough free capacity to evacuate --evacuate-hosts
                      hosts concurrently during a rolling upgrade

Exit codes: 0 clean, 1 warnings only, 2 blocking failures.

Examples
--------
    ./upgrade_preflight.py
    ./upgrade_preflight.py --evacuate-hosts 3 --format json
    ./upgrade_preflight.py --skip quota-headroom
"""

from __future__ import annotations

from collections import Counter

from common import LOG, base_parser, connect, render, setup_logging

CHECKS = (
    "services",
    "version-skew",
    "stuck-instances",
    "stuck-volumes",
    "orphan-migrations",
    "quota-headroom",
    "capacity",
)

COLUMNS = ("status", "check", "subject", "detail")

STABLE_VM_STATES = {"active", "stopped", "shelved", "shelved_offloaded", "paused", "suspended"}
STABLE_VOLUME_STATES = {"available", "in-use", "reserved"}
TERMINAL_MIGRATION_STATES = {"completed", "done", "cancelled", "error", "failed"}


def ok(check: str, subject: str, detail: str) -> dict:
    return {"status": "PASS", "check": check, "subject": subject, "detail": detail}


def warn(check: str, subject: str, detail: str) -> dict:
    return {"status": "WARN", "check": check, "subject": subject, "detail": detail}


def fail(check: str, subject: str, detail: str) -> dict:
    return {"status": "FAIL", "check": check, "subject": subject, "detail": detail}


def check_services(conn) -> list[dict]:
    rows = []
    down = 0
    for svc in conn.compute.services():
        if svc.state != "up":
            down += 1
            rows.append(fail("services", f"{svc.binary}@{svc.host}",
                             f"state={svc.state} status={svc.status}"))
        elif svc.status == "disabled":
            rows.append(warn("services", f"{svc.binary}@{svc.host}",
                             f"disabled: {svc.disabled_reason or 'no reason recorded'}"))

    try:
        for agent in conn.network.agents():
            if not agent.is_alive:
                down += 1
                rows.append(fail("services", f"{agent.binary}@{agent.host}",
                                 "neutron agent is not alive"))
            elif not agent.is_admin_state_up:
                rows.append(warn("services", f"{agent.binary}@{agent.host}",
                                 "neutron agent admin_state_up=False"))
    except Exception as exc:  # noqa: BLE001
        rows.append(warn("services", "neutron", f"agent list unavailable: {exc}"))

    if not down:
        rows.append(ok("services", "control plane", "all compute services and agents up"))
    return rows


def check_version_skew(conn) -> list[dict]:
    versions = Counter()
    for svc in conn.compute.services():
        if svc.binary == "nova-compute":
            versions[getattr(svc, "version", None)] += 1
    if len(versions) <= 1:
        only = next(iter(versions), "unknown")
        return [ok("version-skew", "nova-compute", f"all {versions[only]} nodes on version {only}")]
    detail = ", ".join(f"v{ver}: {count} node(s)" for ver, count in sorted(versions.items(), key=str))
    return [fail("version-skew", "nova-compute", f"mixed service versions ({detail})")]


def check_stuck_instances(conn) -> list[dict]:
    rows = []
    for srv in conn.compute.servers(all_projects=True, details=True):
        state = (srv.vm_state or "").lower()
        task = srv.task_state
        if state == "error":
            rows.append(fail("stuck-instances", srv.id, f"{srv.name}: vm_state=error"))
        elif task:
            rows.append(fail("stuck-instances", srv.id,
                             f"{srv.name}: task_state={task} (transition in flight)"))
        elif state not in STABLE_VM_STATES:
            rows.append(warn("stuck-instances", srv.id, f"{srv.name}: vm_state={state}"))
    return rows or [ok("stuck-instances", "nova", "no instances in a transitional state")]


def check_stuck_volumes(conn) -> list[dict]:
    rows = []
    for vol in conn.block_storage.volumes(all_projects=True):
        if vol.status not in STABLE_VOLUME_STATES:
            level = fail if vol.status.startswith("error") else warn
            rows.append(level("stuck-volumes", vol.id, f"{vol.name or '-'}: status={vol.status}"))
    return rows or [ok("stuck-volumes", "cinder", "no volumes in a transitional state")]


def check_orphan_migrations(conn) -> list[dict]:
    rows = []
    try:
        migrations = list(conn.compute.migrations())
    except Exception as exc:  # noqa: BLE001 - needs admin, may be restricted
        return [warn("orphan-migrations", "nova", f"migration list unavailable: {exc}")]

    for mig in migrations:
        status = (mig.status or "").lower()
        if status not in TERMINAL_MIGRATION_STATES:
            rows.append(fail("orphan-migrations", str(mig.id),
                             f"instance {mig.server_id} status={status} "
                             f"{mig.source_compute}->{mig.dest_compute}"))
    return rows or [ok("orphan-migrations", "nova", "no in-flight migrations")]


def check_quota_headroom(conn, threshold: int) -> list[dict]:
    rows = []
    try:
        projects = list(conn.identity.projects())
    except Exception as exc:  # noqa: BLE001
        return [warn("quota-headroom", "keystone", f"project list unavailable: {exc}")]

    for project in projects:
        try:
            usage = conn.compute.get_quota_set(project.id, usage=True)
        except Exception:  # noqa: BLE001 - project may have no compute quota
            continue
        for resource in ("instances", "cores", "ram"):
            limit = getattr(usage, resource, None)
            used = (usage.usage or {}).get(resource)
            if not limit or limit < 0 or used is None:
                continue
            pct_used = round(used / limit * 100)
            if pct_used >= threshold:
                rows.append(warn("quota-headroom", project.name,
                                 f"{resource} at {pct_used}% ({used}/{limit})"))
    return rows or [ok("quota-headroom", "nova", f"no project above {threshold}% of quota")]


def check_capacity(conn, evacuate_hosts: int) -> list[dict]:
    hypervisors = [hv for hv in conn.compute.hypervisors(details=True) if hv.state == "up"]
    if not hypervisors:
        return [fail("capacity", "nova", "no hypervisors reporting up")]

    # Worst case: the N most heavily loaded hosts go down at once.
    by_load = sorted(hypervisors, key=lambda hv: (hv.memory_used or 0), reverse=True)
    victims = by_load[:evacuate_hosts]
    need_vcpu = sum(hv.vcpus_used or 0 for hv in victims)
    need_mem = sum(hv.memory_used or 0 for hv in victims)

    survivors = by_load[evacuate_hosts:]
    free_vcpu = sum((hv.vcpus or 0) - (hv.vcpus_used or 0) for hv in survivors)
    free_mem = sum((hv.memory_size or 0) - (hv.memory_used or 0) for hv in survivors)

    detail = (f"need {need_vcpu} vCPU / {need_mem} MB to drain {evacuate_hosts} host(s); "
              f"{free_vcpu} vCPU / {free_mem} MB free elsewhere")
    if free_vcpu >= need_vcpu and free_mem >= need_mem:
        return [ok("capacity", "nova", detail)]
    return [fail("capacity", "nova", detail)]


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument(
        "--skip", action="append", choices=CHECKS, default=[],
        help="skip a check (repeatable)",
    )
    parser.add_argument(
        "--evacuate-hosts", type=int, default=1,
        help="hosts drained concurrently during the rolling upgrade",
    )
    parser.add_argument(
        "--quota-threshold", type=int, default=90,
        help="warn when a project is at or above this percentage of any quota",
    )
    parser.add_argument(
        "--show-passing", action="store_true",
        help="include PASS lines in the report",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    conn = connect(args.cloud)
    runners = {
        "services": lambda: check_services(conn),
        "version-skew": lambda: check_version_skew(conn),
        "stuck-instances": lambda: check_stuck_instances(conn),
        "stuck-volumes": lambda: check_stuck_volumes(conn),
        "orphan-migrations": lambda: check_orphan_migrations(conn),
        "quota-headroom": lambda: check_quota_headroom(conn, args.quota_threshold),
        "capacity": lambda: check_capacity(conn, args.evacuate_hosts),
    }

    rows: list[dict] = []
    for name, runner in runners.items():
        if name in args.skip:
            LOG.info("skipping check %s", name)
            continue
        LOG.info("running check %s ...", name)
        rows.extend(runner())

    failures = [r for r in rows if r["status"] == "FAIL"]
    warnings = [r for r in rows if r["status"] == "WARN"]

    shown = rows if args.show_passing or args.format == "json" else failures + warnings
    render(shown or [ok("all", "region", "all checks passed")], COLUMNS, args.format)

    if args.format == "table":
        print(f"\n{len(failures)} failure(s), {len(warnings)} warning(s)")

    if failures:
        return 2
    return 1 if warnings else 0


if __name__ == "__main__":
    raise SystemExit(main())
