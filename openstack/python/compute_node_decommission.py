#!/usr/bin/env python3
"""Permanently decommission a compute node from an OpenStack region.

Decommissioning is not "drain and forget". A half-removed compute node leaves
Nova services, Placement resource providers, Neutron agents and host aggregate
memberships behind, which then break the next upgrade, distort capacity
reporting, and make the scheduler consider a host that no longer exists.

Stages, each verified before the next begins:

    1. verify        the host is drained (no instances of any kind, including
                     shelved and errored) and already disabled
    2. aggregates    remove the host from every host aggregate and AZ
    3. services      delete nova-compute from the Nova service list
    4. neutron       delete the L2/L3 agents registered for this host
    5. placement     delete the resource provider and its inventories
    6. verify        confirm the host is absent from every inventory

Because every stage is destructive and irreversible, the default is a full
dry-run report; `--execute` is required to change anything, and each stage
confirms independently unless `--yes` is passed.

Examples
--------
    ./compute_node_decommission.py --host compute-042
    ./compute_node_decommission.py --host compute-042 --execute
    ./compute_node_decommission.py --host compute-042 --execute --stage placement
"""

from __future__ import annotations

from common import LOG, base_parser, confirm, connect, render, setup_logging

COLUMNS = ("stage", "status", "object", "detail")

STAGES = ("verify", "aggregates", "services", "neutron", "placement")


def row(stage: str, status: str, obj: str, detail: str) -> dict:
    return {"stage": stage, "status": status, "object": obj, "detail": detail}


def verify_drained(conn, host: str) -> tuple[bool, list[dict]]:
    """A node is only safe to decommission when nothing at all remains on it."""
    rows = []
    servers = list(conn.compute.servers(all_projects=True, details=True, host=host))
    if servers:
        for srv in servers[:10]:
            rows.append(row("verify", "BLOCKED", srv.id,
                            f"{srv.name} still on host (vm_state={srv.vm_state})"))
        if len(servers) > 10:
            rows.append(row("verify", "BLOCKED", "...",
                            f"and {len(servers) - 10} more instance(s)"))
        return False, rows

    rows.append(row("verify", "OK", host, "no instances remain on this host"))

    service = None
    for svc in conn.compute.services():
        if svc.host == host and svc.binary == "nova-compute":
            service = svc
            break

    if service is None:
        rows.append(row("verify", "WARN", host,
                        "no nova-compute service found — may already be partly removed"))
    elif service.status != "disabled":
        rows.append(row("verify", "BLOCKED", host,
                        "nova-compute is still enabled; drain and disable it first"))
        return False, rows
    else:
        rows.append(row("verify", "OK", host,
                        f"nova-compute disabled: {service.disabled_reason or 'no reason recorded'}"))

    return True, rows


def remove_from_aggregates(conn, host: str, execute: bool, assume_yes: bool) -> list[dict]:
    rows = []
    for agg in conn.compute.aggregates():
        if host not in (agg.hosts or []):
            continue
        detail = f"aggregate {agg.name} (az={agg.availability_zone or 'none'})"
        if not execute:
            rows.append(row("aggregates", "WOULD_REMOVE", host, detail))
            continue
        if not confirm(f"Remove {host} from {agg.name}?", assume_yes):
            rows.append(row("aggregates", "SKIPPED", host, detail))
            continue
        try:
            conn.compute.remove_host_from_aggregate(agg.id, host)
            rows.append(row("aggregates", "REMOVED", host, detail))
        except Exception as exc:  # noqa: BLE001 - continue and report
            rows.append(row("aggregates", "FAILED", host, f"{detail}: {exc}"))

    if not rows:
        rows.append(row("aggregates", "OK", host, "host is not in any aggregate"))
    return rows


def delete_compute_service(conn, host: str, execute: bool, assume_yes: bool) -> list[dict]:
    rows = []
    for svc in conn.compute.services():
        if svc.host != host:
            continue
        detail = f"{svc.binary} (state={svc.state}, status={svc.status})"
        if not execute:
            rows.append(row("services", "WOULD_DELETE", svc.host, detail))
            continue
        if not confirm(f"Delete Nova service {svc.binary}@{host}?", assume_yes):
            rows.append(row("services", "SKIPPED", svc.host, detail))
            continue
        try:
            conn.compute.delete_service(svc)
            rows.append(row("services", "DELETED", svc.host, detail))
        except Exception as exc:  # noqa: BLE001
            rows.append(row("services", "FAILED", svc.host, f"{detail}: {exc}"))

    if not rows:
        rows.append(row("services", "OK", host, "no Nova services registered for this host"))
    return rows


def delete_network_agents(conn, host: str, execute: bool, assume_yes: bool) -> list[dict]:
    rows = []
    try:
        agents = [a for a in conn.network.agents() if a.host == host]
    except Exception as exc:  # noqa: BLE001
        return [row("neutron", "FAILED", host, f"could not list agents: {exc}")]

    for agent in agents:
        detail = f"{agent.binary} (alive={agent.is_alive})"
        if not execute:
            rows.append(row("neutron", "WOULD_DELETE", agent.id, detail))
            continue
        if not confirm(f"Delete Neutron agent {agent.binary}@{host}?", assume_yes):
            rows.append(row("neutron", "SKIPPED", agent.id, detail))
            continue
        try:
            conn.network.delete_agent(agent.id, ignore_missing=True)
            rows.append(row("neutron", "DELETED", agent.id, detail))
        except Exception as exc:  # noqa: BLE001
            rows.append(row("neutron", "FAILED", agent.id, f"{detail}: {exc}"))

    if not rows:
        rows.append(row("neutron", "OK", host, "no Neutron agents registered for this host"))
    return rows


def delete_resource_provider(conn, host: str, execute: bool, assume_yes: bool) -> list[dict]:
    """Placement is the stage most often forgotten, and the one that quietly
    breaks scheduling and capacity reporting months later."""
    rows = []
    try:
        providers = [p for p in conn.placement.resource_providers() if p.name == host]
    except Exception as exc:  # noqa: BLE001
        return [row("placement", "FAILED", host, f"could not list resource providers: {exc}")]

    if not providers:
        return [row("placement", "OK", host, "no resource provider found")]

    for provider in providers:
        detail = f"resource provider {provider.id}"
        if not execute:
            rows.append(row("placement", "WOULD_DELETE", provider.name, detail))
            continue
        if not confirm(f"Delete Placement resource provider for {host}?", assume_yes):
            rows.append(row("placement", "SKIPPED", provider.name, detail))
            continue
        try:
            conn.placement.delete_resource_provider(provider, ignore_missing=True)
            rows.append(row("placement", "DELETED", provider.name, detail))
        except Exception as exc:  # noqa: BLE001
            # A provider with live allocations cannot be deleted — that means
            # something is still assigned to a host we believe is empty.
            rows.append(row("placement", "FAILED", provider.name,
                            f"{detail}: {exc} (allocations may still exist)"))
    return rows


def final_verification(conn, host: str) -> list[dict]:
    rows = []
    remaining = []

    if any(svc.host == host for svc in conn.compute.services()):
        remaining.append("nova service")
    try:
        if any(agent.host == host for agent in conn.network.agents()):
            remaining.append("neutron agent")
    except Exception:  # noqa: BLE001
        pass
    try:
        if any(p.name == host for p in conn.placement.resource_providers()):
            remaining.append("placement resource provider")
    except Exception:  # noqa: BLE001
        pass
    if any(host in (agg.hosts or []) for agg in conn.compute.aggregates()):
        remaining.append("host aggregate membership")

    if remaining:
        rows.append(row("verify", "INCOMPLETE", host,
                        "still registered as: " + ", ".join(remaining)))
    else:
        rows.append(row("verify", "OK", host,
                        "fully removed from Nova, Neutron, Placement and all aggregates"))
    return rows


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--host", required=True, help="compute host to decommission")
    parser.add_argument(
        "--execute", action="store_true",
        help="actually perform the removal (default is a full dry-run report)",
    )
    parser.add_argument(
        "--stage", action="append", choices=STAGES,
        help="run only specific stages (repeatable; default: all, in order)",
    )
    parser.add_argument(
        "--skip-drain-check", action="store_true",
        help="proceed even if instances remain (dangerous; for a dead host only)",
    )
    parser.add_argument("--yes", action="store_true", help="skip per-stage confirmation")
    args = parser.parse_args()
    setup_logging(args.verbose)

    conn = connect(args.cloud)
    execute = args.execute and not args.dry_run
    stages = args.stage or list(STAGES)

    if args.execute and args.dry_run:
        LOG.info("--dry-run overrides --execute; reporting only")

    rows: list[dict] = []

    if "verify" in stages:
        drained, verify_rows = verify_drained(conn, args.host)
        rows.extend(verify_rows)
        if not drained and not args.skip_drain_check:
            render(rows, COLUMNS, args.format)
            LOG.error(
                "%s is not ready to decommission. Drain it first with "
                "compute_node_drain.py, or pass --skip-drain-check for a dead host.",
                args.host,
            )
            return 2

    if "aggregates" in stages:
        rows.extend(remove_from_aggregates(conn, args.host, execute, args.yes))
    if "services" in stages:
        rows.extend(delete_compute_service(conn, args.host, execute, args.yes))
    if "neutron" in stages:
        rows.extend(delete_network_agents(conn, args.host, execute, args.yes))
    if "placement" in stages:
        rows.extend(delete_resource_provider(conn, args.host, execute, args.yes))

    if execute:
        rows.extend(final_verification(conn, args.host))

    render(rows, COLUMNS, args.format)

    if not execute and args.format == "table":
        print(f"\nDry run — nothing was changed. Re-run with --execute to decommission "
              f"{args.host}.")

    failures = [r for r in rows if r["status"] in ("FAILED", "INCOMPLETE")]
    if failures:
        LOG.error("%d stage(s) did not complete cleanly", len(failures))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
