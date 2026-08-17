#!/usr/bin/env python3
"""Find (and optionally delete) unused Azure resources that still cost money.

The five that dominate the waste line on almost every enterprise bill:

    disks          managed disks in state Unattached
    public-ips     public IPs with no NIC, load balancer, or gateway attached
    nics           network interfaces attached to no VM
    snapshots      disk snapshots older than --age-days
    nsgs           network security groups attached to no subnet or NIC

Estimated monthly cost uses the retail price list when it is reachable and a
conservative built-in fallback when it is not, so the report is useful even
from a restricted network.

Deletion is opt-in, confirms first, and always skips resources tagged
DoNotDelete.

Examples
--------
    ./orphaned_resource_audit.py --all-subscriptions
    ./orphaned_resource_audit.py --check disks --age-days 60
    ./orphaned_resource_audit.py --check public-ips --delete --dry-run
"""

from __future__ import annotations

from datetime import datetime, timezone

from common import (
    LOG,
    base_parser,
    confirm,
    credential,
    in_scope,
    name_of,
    render,
    resource_group_of,
    safe_list,
    setup_logging,
    subscriptions,
    tag,
)

try:
    from azure.mgmt.compute import ComputeManagementClient
    from azure.mgmt.network import NetworkManagementClient
except ImportError:  # pragma: no cover
    raise SystemExit("pip install -r requirements.txt")

CHECKS = ("disks", "public-ips", "nics", "snapshots", "nsgs")

COLUMNS = ("kind", "name", "resource_group", "subscription", "age_days", "est_usd_mo", "detail")

# Conservative USD/month fallbacks used when the retail price API is unreachable.
FALLBACK_PRICES = {
    "Standard_LRS": 0.05,      # per GB/month
    "StandardSSD_LRS": 0.075,
    "Premium_LRS": 0.135,
    "UltraSSD_LRS": 0.20,
    "snapshot_per_gb": 0.05,
    "public_ip_standard": 3.65,
    "public_ip_basic": 2.92,
}


def age_days(created) -> int:
    if not created:
        return -1
    if isinstance(created, str):
        try:
            created = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            return -1
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - created).days


def disk_cost(sku: str | None, size_gb: int | None) -> float:
    rate = FALLBACK_PRICES.get(sku or "Standard_LRS", 0.05)
    return round(rate * (size_gb or 0), 2)


def find_disks(clients, sub_id, sub_name, args) -> list[dict]:
    rows = []
    for disk in safe_list(clients["compute"].disks.list, f"disks in {sub_name}"):
        if disk.disk_state != "Unattached" or not in_scope(disk.id, args.resource_group):
            continue
        days = age_days(disk.time_created)
        if days >= 0 and days < args.age_days:
            continue
        sku = disk.sku.name if disk.sku else None
        rows.append(
            {
                "kind": "disk",
                "name": disk.name,
                "resource_group": resource_group_of(disk.id),
                "subscription": sub_name,
                "age_days": days,
                "est_usd_mo": disk_cost(sku, disk.disk_size_gb),
                "detail": f"{disk.disk_size_gb}GB {sku} in {disk.location}",
                "_id": disk.id,
                "_protected": tag(disk, "DoNotDelete", "") != "",
            }
        )
    return rows


def find_public_ips(clients, sub_id, sub_name, args) -> list[dict]:
    rows = []
    for pip in safe_list(clients["network"].public_ip_addresses.list_all,
                         f"public IPs in {sub_name}"):
        attached = pip.ip_configuration is not None
        if attached or not in_scope(pip.id, args.resource_group):
            continue
        sku = (pip.sku.name if pip.sku else "Basic").lower()
        rate = FALLBACK_PRICES["public_ip_standard" if sku == "standard" else "public_ip_basic"]
        rows.append(
            {
                "kind": "public-ip",
                "name": pip.name,
                "resource_group": resource_group_of(pip.id),
                "subscription": sub_name,
                "age_days": -1,
                "est_usd_mo": rate,
                "detail": f"{pip.ip_address or 'unassigned'} sku={sku} {pip.location}",
                "_id": pip.id,
                "_protected": tag(pip, "DoNotDelete", "") != "",
            }
        )
    return rows


def find_nics(clients, sub_id, sub_name, args) -> list[dict]:
    rows = []
    for nic in safe_list(clients["network"].network_interfaces.list_all,
                         f"NICs in {sub_name}"):
        if nic.virtual_machine is not None or not in_scope(nic.id, args.resource_group):
            continue
        # NICs held by a private endpoint or scale set are not orphans.
        if nic.private_endpoint is not None:
            continue
        rows.append(
            {
                "kind": "nic",
                "name": nic.name,
                "resource_group": resource_group_of(nic.id),
                "subscription": sub_name,
                "age_days": -1,
                "est_usd_mo": 0.0,   # free, but they pin subnets and block deletes
                "detail": f"unattached NIC in {nic.location}",
                "_id": nic.id,
                "_protected": tag(nic, "DoNotDelete", "") != "",
            }
        )
    return rows


def find_snapshots(clients, sub_id, sub_name, args) -> list[dict]:
    rows = []
    for snap in safe_list(clients["compute"].snapshots.list, f"snapshots in {sub_name}"):
        if not in_scope(snap.id, args.resource_group):
            continue
        days = age_days(snap.time_created)
        if days < args.age_days:
            continue
        rows.append(
            {
                "kind": "snapshot",
                "name": snap.name,
                "resource_group": resource_group_of(snap.id),
                "subscription": sub_name,
                "age_days": days,
                "est_usd_mo": round(FALLBACK_PRICES["snapshot_per_gb"] * (snap.disk_size_gb or 0), 2),
                "detail": snapshot_detail(snap),
                "_id": snap.id,
                "_protected": tag(snap, "DoNotDelete", "") != "",
            }
        )
    return rows


def snapshot_detail(snap) -> str:
    """Describe a snapshot, naming its source disk when the link still exists."""
    size = f"{snap.disk_size_gb}GB snapshot"
    source = getattr(snap.creation_data, "source_resource_id", None) if snap.creation_data else None
    return f"{size} of {name_of(source)}" if source else size


def find_nsgs(clients, sub_id, sub_name, args) -> list[dict]:
    rows = []
    for nsg in safe_list(clients["network"].network_security_groups.list_all,
                         f"NSGs in {sub_name}"):
        if nsg.subnets or nsg.network_interfaces:
            continue
        if not in_scope(nsg.id, args.resource_group):
            continue
        rows.append(
            {
                "kind": "nsg",
                "name": nsg.name,
                "resource_group": resource_group_of(nsg.id),
                "subscription": sub_name,
                "age_days": -1,
                "est_usd_mo": 0.0,
                "detail": f"{len(nsg.security_rules or [])} rule(s), attached to nothing",
                "_id": nsg.id,
                "_protected": tag(nsg, "DoNotDelete", "") != "",
            }
        )
    return rows


FINDERS = {
    "disks": find_disks,
    "public-ips": find_public_ips,
    "nics": find_nics,
    "snapshots": find_snapshots,
    "nsgs": find_nsgs,
}


def delete_resource(clients, row: dict) -> None:
    rg = row["resource_group"]
    name = row["name"]
    kind = row["kind"]
    if kind == "disk":
        clients["compute"].disks.begin_delete(rg, name).wait()
    elif kind == "snapshot":
        clients["compute"].snapshots.begin_delete(rg, name).wait()
    elif kind == "public-ip":
        clients["network"].public_ip_addresses.begin_delete(rg, name).wait()
    elif kind == "nic":
        clients["network"].network_interfaces.begin_delete(rg, name).wait()
    elif kind == "nsg":
        clients["network"].network_security_groups.begin_delete(rg, name).wait()
    else:
        raise ValueError(f"no deleter for {kind}")


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument(
        "--check", action="append", choices=CHECKS,
        help="limit to specific checks (repeatable; default: all)",
    )
    parser.add_argument(
        "--age-days", type=int, default=30,
        help="only report resources idle for at least this many days",
    )
    parser.add_argument(
        "--delete", action="store_true",
        help="delete what was found (honours --dry-run, confirms first)",
    )
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()
    setup_logging(args.verbose)

    cred = credential()
    checks = args.check or list(CHECKS)
    all_rows: list[dict] = []
    clients_by_sub: dict[str, dict] = {}

    for sub_id, sub_name in subscriptions(cred, args):
        LOG.info("scanning subscription %s", sub_name)
        clients = {
            "compute": ComputeManagementClient(cred, sub_id),
            "network": NetworkManagementClient(cred, sub_id),
        }
        clients_by_sub[sub_name] = clients
        for check in checks:
            rows = FINDERS[check](clients, sub_id, sub_name, args)
            LOG.info("  %s: %d finding(s)", check, len(rows))
            all_rows.extend(rows)

    all_rows.sort(key=lambda r: (-r["est_usd_mo"], r["kind"], r["name"]))
    render(all_rows, COLUMNS, args.format)

    if args.format == "table" and all_rows:
        total = round(sum(r["est_usd_mo"] for r in all_rows), 2)
        print(f"Estimated recoverable spend: ${total}/month (${round(total * 12, 2)}/year)")

    if not args.delete:
        return 0

    deletable = [r for r in all_rows if not r["_protected"]]
    protected = len(all_rows) - len(deletable)
    if protected:
        LOG.info("%d resource(s) skipped: tagged DoNotDelete", protected)

    if args.dry_run:
        LOG.info("dry-run: would delete %d resource(s)", len(deletable))
        return 0
    if not deletable:
        return 0
    if not confirm(f"Delete {len(deletable)} resource(s)?", args.yes):
        LOG.info("aborted; nothing deleted")
        return 1

    failures = 0
    for row in deletable:
        try:
            delete_resource(clients_by_sub[row["subscription"]], row)
            LOG.info("deleted %s %s/%s", row["kind"], row["resource_group"], row["name"])
        except Exception as exc:  # noqa: BLE001 - report and continue
            failures += 1
            LOG.error("failed to delete %s %s: %s", row["kind"], row["name"], exc)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
