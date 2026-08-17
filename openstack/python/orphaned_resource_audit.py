#!/usr/bin/env python3
"""Find (and optionally reclaim) orphaned resources across an OpenStack region.

Long-lived regions accumulate resources nobody owns any more: volumes detached
years ago, floating IPs nobody released, ports left behind by failed builds,
snapshots whose parent is gone. They cost quota, they slow the control plane,
and they make capacity planning lie.

Checks performed
----------------
    volumes       available (never re-attached) for longer than --age-days
    snapshots     whose source volume no longer exists
    floating-ips  allocated but not associated with a port
    ports         DOWN, not bound to a device, not a router/DHCP port
    images        private, not in use by any instance, older than --age-days

Deletion is opt-in per resource class and always confirms first:

    ./orphaned_resource_audit.py                          # report everything
    ./orphaned_resource_audit.py --check volumes --age-days 90
    ./orphaned_resource_audit.py --check floating-ips --delete
"""

from __future__ import annotations

from datetime import datetime, timezone

from common import LOG, base_parser, confirm, connect, render, setup_logging

CHECKS = ("volumes", "snapshots", "floating-ips", "ports", "images")

COLUMNS = ("kind", "id", "name", "project_id", "age_days", "detail")

# Ports owned by these services are infrastructure, not leftovers.
INFRA_PORT_OWNERS = (
    "network:router_interface",
    "network:router_gateway",
    "network:router_ha_interface",
    "network:dhcp",
    "network:floatingip",
    "network:distributed",
)


def age_days(timestamp: str | None) -> int:
    """Age in whole days from an OpenStack ISO-8601 timestamp."""
    if not timestamp:
        return -1
    try:
        created = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        LOG.debug("unparsable timestamp %r", timestamp)
        return -1
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - created).days


def older_than(timestamp: str | None, days: int) -> bool:
    found = age_days(timestamp)
    return found >= days if found >= 0 else False


def find_volumes(conn, min_age: int) -> list[dict]:
    rows = []
    for vol in conn.block_storage.volumes(all_projects=True):
        if vol.status != "available" or vol.attachments:
            continue
        if not older_than(vol.created_at, min_age):
            continue
        rows.append(
            {
                "kind": "volume",
                "id": vol.id,
                "name": vol.name or "-",
                "project_id": vol.project_id,
                "age_days": age_days(vol.created_at),
                "detail": f"{vol.size}GB type={vol.volume_type}",
                "_size": vol.size or 0,
            }
        )
    return rows


def find_snapshots(conn, min_age: int) -> list[dict]:
    volume_ids = {v.id for v in conn.block_storage.volumes(all_projects=True)}
    rows = []
    for snap in conn.block_storage.snapshots(all_projects=True):
        if snap.volume_id in volume_ids:
            continue
        if not older_than(snap.created_at, min_age):
            continue
        rows.append(
            {
                "kind": "snapshot",
                "id": snap.id,
                "name": snap.name or "-",
                "project_id": snap.project_id,
                "age_days": age_days(snap.created_at),
                "detail": f"{snap.size}GB source volume {snap.volume_id} missing",
                "_size": snap.size or 0,
            }
        )
    return rows


def find_floating_ips(conn, min_age: int) -> list[dict]:
    rows = []
    for fip in conn.network.ips():
        if fip.port_id:
            continue
        if not older_than(fip.created_at, min_age):
            continue
        rows.append(
            {
                "kind": "floating-ip",
                "id": fip.id,
                "name": fip.floating_ip_address,
                "project_id": fip.project_id,
                "age_days": age_days(fip.created_at),
                "detail": f"status={fip.status} unassociated",
            }
        )
    return rows


def find_ports(conn, min_age: int) -> list[dict]:
    rows = []
    for port in conn.network.ports():
        owner = port.device_owner or ""
        if owner.startswith(INFRA_PORT_OWNERS):
            continue
        if port.device_id:
            continue
        if port.status != "DOWN":
            continue
        if not older_than(port.created_at, min_age):
            continue
        ips = ",".join(fixed.get("ip_address", "") for fixed in port.fixed_ips or [])
        rows.append(
            {
                "kind": "port",
                "id": port.id,
                "name": port.name or "-",
                "project_id": port.project_id,
                "age_days": age_days(port.created_at),
                "detail": f"owner={owner or 'none'} ips={ips or 'none'}",
            }
        )
    return rows


def find_images(conn, min_age: int) -> list[dict]:
    in_use = {
        srv.image.get("id")
        for srv in conn.compute.servers(all_projects=True, details=True)
        if isinstance(srv.image, dict) and srv.image.get("id")
    }
    rows = []
    for image in conn.image.images():
        if image.visibility != "private" or image.id in in_use:
            continue
        if image.protected or not older_than(image.created_at, min_age):
            continue
        rows.append(
            {
                "kind": "image",
                "id": image.id,
                "name": image.name or "-",
                "project_id": image.owner,
                "age_days": age_days(image.created_at),
                "detail": f"{round((image.size or 0) / 2**30, 1)}GB status={image.status}",
            }
        )
    return rows


FINDERS = {
    "volumes": find_volumes,
    "snapshots": find_snapshots,
    "floating-ips": find_floating_ips,
    "ports": find_ports,
    "images": find_images,
}

DELETERS = {
    "volume": lambda conn, rid: conn.block_storage.delete_volume(rid, ignore_missing=True),
    "snapshot": lambda conn, rid: conn.block_storage.delete_snapshot(rid, ignore_missing=True),
    "floating-ip": lambda conn, rid: conn.network.delete_ip(rid, ignore_missing=True),
    "port": lambda conn, rid: conn.network.delete_port(rid, ignore_missing=True),
    "image": lambda conn, rid: conn.image.delete_image(rid, ignore_missing=True),
}


def reclaim(conn, rows: list[dict], dry_run: bool, assume_yes: bool) -> int:
    if not rows:
        return 0
    if dry_run:
        LOG.info("dry-run: would delete %d resource(s)", len(rows))
        return 0
    if not confirm(f"Delete {len(rows)} resource(s)?", assume_yes):
        LOG.info("aborted; nothing deleted")
        return 1

    failures = 0
    for row in rows:
        try:
            DELETERS[row["kind"]](conn, row["id"])
            LOG.info("deleted %s %s (%s)", row["kind"], row["id"], row["name"])
        except Exception as exc:  # noqa: BLE001 - keep going, report at the end
            failures += 1
            LOG.error("failed to delete %s %s: %s", row["kind"], row["id"], exc)
    return 1 if failures else 0


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="append",
        choices=CHECKS,
        help="limit to specific checks (repeatable; default: all)",
    )
    parser.add_argument(
        "--age-days",
        type=int,
        default=30,
        help="only report resources idle for at least this many days",
    )
    parser.add_argument(
        "--project",
        help="restrict the report to a single project id",
    )
    parser.add_argument(
        "--delete",
        action="store_true",
        help="delete what was found (honours --dry-run, confirms first)",
    )
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()
    setup_logging(args.verbose)

    conn = connect(args.cloud)
    checks = args.check or list(CHECKS)

    rows: list[dict] = []
    for check in checks:
        LOG.info("scanning %s ...", check)
        rows.extend(FINDERS[check](conn, args.age_days))

    if args.project:
        rows = [r for r in rows if r["project_id"] == args.project]

    rows.sort(key=lambda r: (r["kind"], -r["age_days"]))
    render(rows, COLUMNS, args.format)

    reclaimable_gb = sum(r.get("_size", 0) for r in rows)
    if reclaimable_gb and args.format == "table":
        print(f"Reclaimable block storage: {reclaimable_gb} GB")

    if args.delete:
        return reclaim(conn, rows, args.dry_run, args.yes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
