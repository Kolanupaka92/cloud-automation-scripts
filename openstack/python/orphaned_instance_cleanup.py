#!/usr/bin/env python3
"""Reconcile Nova's view of a compute node against what libvirt is actually running.

Long-lived compute nodes drift out of sync with the Nova database. The two
directions are very different problems, so the script names them separately:

    ORPHAN_DOMAIN     libvirt is running a domain Nova has no record of, or has
                      recorded as deleted. It consumes real CPU, RAM and disk
                      that the scheduler believes is free — this is the one that
                      silently overcommits a host until it falls over.

    MISSING_DOMAIN    Nova believes an instance is ACTIVE on this host but no
                      libvirt domain exists. The tenant's VM is gone; Nova will
                      keep reporting it as healthy until someone looks.

    STALE_INSTANCE_DIR  /var/lib/nova/instances holds a directory for an instance
                      that no longer exists anywhere. Pure wasted disk.

Cleanup is opt-in, one class at a time, and refuses to touch anything whose
state it cannot fully confirm from both sides.

The libvirt and filesystem views are collected over SSH, so this runs from an
operator workstation against any compute node without an agent.

Examples
--------
    ./orphaned_instance_cleanup.py --host compute-042
    ./orphaned_instance_cleanup.py --all-hosts --format json
    ./orphaned_instance_cleanup.py --host compute-042 --clean orphan-domains --dry-run
    ./orphaned_instance_cleanup.py --host compute-042 --clean stale-dirs --yes
"""

from __future__ import annotations

import shlex
import subprocess

from common import LOG, base_parser, confirm, connect, render, setup_logging

COLUMNS = ("finding", "host", "identifier", "name", "nova_state", "libvirt_state", "detail")

# Nova states in which a libvirt domain is legitimately absent.
NO_DOMAIN_EXPECTED = {"shelved", "shelved_offloaded", "deleted", "error", "building"}

INSTANCE_DIR = "/var/lib/nova/instances"


def ssh(host: str, command: str, user: str, timeout: int = 60) -> tuple[int, str]:
    """Run one command on a compute node. Returns (rc, stdout)."""
    argv = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"ConnectTimeout={min(timeout, 15)}",
        f"{user}@{host}",
        command,
    ]
    LOG.debug("ssh %s: %s", host, command)
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        LOG.error("ssh to %s timed out after %ss", host, timeout)
        return 255, ""
    if proc.returncode != 0:
        LOG.debug("ssh %s rc=%d stderr=%s", host, proc.returncode, proc.stderr.strip()[:200])
    return proc.returncode, proc.stdout


def libvirt_domains(host: str, user: str) -> dict[str, str] | None:
    """Map libvirt domain name -> state, as reported by the hypervisor itself."""
    rc, out = ssh(host, "virsh list --all --name", user)
    if rc != 0:
        LOG.error("cannot reach libvirt on %s; skipping this host", host)
        return None

    domains = {}
    for name in (line.strip() for line in out.splitlines()):
        if not name:
            continue
        rc_state, state_out = ssh(host, f"virsh domstate {shlex.quote(name)}", user)
        domains[name] = state_out.strip() if rc_state == 0 else "unknown"
    return domains


def instance_directories(host: str, user: str) -> set[str]:
    rc, out = ssh(host, f"ls -1 {INSTANCE_DIR} 2>/dev/null", user)
    if rc != 0:
        return set()
    # Only UUID-shaped entries are instances; _base, locks etc. are not.
    return {
        entry.strip()
        for entry in out.splitlines()
        if len(entry.strip()) == 36 and entry.count("-") == 4
    }


def nova_instances(conn, host: str) -> dict[str, object]:
    """Every instance Nova associates with this host, including deleted ones."""
    active = {
        srv.id: srv
        for srv in conn.compute.servers(all_projects=True, details=True, host=host)
    }
    # Deleted instances still explain a leftover domain or directory, so fetch
    # them too — this is what distinguishes "never existed" from "not cleaned up".
    try:
        for srv in conn.compute.servers(
            all_projects=True, details=True, host=host, deleted=True
        ):
            active.setdefault(srv.id, srv)
    except Exception as exc:  # noqa: BLE001 - deleted filter needs admin
        LOG.debug("could not list deleted instances on %s: %s", host, exc)
    return active


def reconcile(conn, host: str, user: str) -> list[dict]:
    domains = libvirt_domains(host, user)
    if domains is None:
        return []

    instances = nova_instances(conn, host)
    directories = instance_directories(host, user)
    rows: list[dict] = []

    # Nova names libvirt domains "instance-<hex id>"; the UUID is the reliable
    # join key, so read it back out of the domain XML.
    domain_uuids: dict[str, str] = {}
    for domain in domains:
        rc, out = ssh(host, f"virsh domuuid {shlex.quote(domain)}", user)
        if rc == 0 and out.strip():
            domain_uuids[out.strip()] = domain

    # Direction 1: libvirt has something Nova does not.
    for uuid, domain in domain_uuids.items():
        server = instances.get(uuid)
        if server is None:
            rows.append({
                "finding": "ORPHAN_DOMAIN",
                "host": host,
                "identifier": uuid,
                "name": domain,
                "nova_state": "absent",
                "libvirt_state": domains[domain],
                "detail": "libvirt domain has no Nova instance — consuming untracked capacity",
                "_domain": domain,
            })
        elif getattr(server, "status", "").upper() == "DELETED":
            rows.append({
                "finding": "ORPHAN_DOMAIN",
                "host": host,
                "identifier": uuid,
                "name": domain,
                "nova_state": "deleted",
                "libvirt_state": domains[domain],
                "detail": "Nova deleted this instance but the domain was never destroyed",
                "_domain": domain,
            })

    # Direction 2: Nova has something libvirt does not.
    for uuid, server in instances.items():
        state = (getattr(server, "vm_state", "") or "").lower()
        if getattr(server, "status", "").upper() == "DELETED" or state in NO_DOMAIN_EXPECTED:
            continue
        if uuid not in domain_uuids:
            rows.append({
                "finding": "MISSING_DOMAIN",
                "host": host,
                "identifier": uuid,
                "name": server.name,
                "nova_state": state,
                "libvirt_state": "absent",
                "detail": "Nova reports this instance on this host but no domain exists",
            })

    # Direction 3: filesystem leftovers.
    for directory in directories:
        if directory in instances and getattr(instances[directory], "status", "").upper() != "DELETED":
            continue
        if directory in domain_uuids:
            continue
        rows.append({
            "finding": "STALE_INSTANCE_DIR",
            "host": host,
            "identifier": directory,
            "name": "-",
            "nova_state": "deleted" if directory in instances else "absent",
            "libvirt_state": "absent",
            "detail": f"{INSTANCE_DIR}/{directory} has no instance and no domain",
        })

    return rows


def disk_usage(host: str, user: str, uuid: str) -> str:
    rc, out = ssh(host, f"du -sh {INSTANCE_DIR}/{shlex.quote(uuid)} 2>/dev/null", user)
    return out.split()[0] if rc == 0 and out.split() else "unknown"


def clean(rows: list[dict], user: str, target: str, dry_run: bool, assume_yes: bool) -> int:
    """Remove one class of finding. Never touches MISSING_DOMAIN — that is a
    tenant-visible outage needing investigation, not cleanup."""
    if target == "orphan-domains":
        selected = [r for r in rows if r["finding"] == "ORPHAN_DOMAIN"]
        action = "destroy and undefine libvirt domain"
    else:
        selected = [r for r in rows if r["finding"] == "STALE_INSTANCE_DIR"]
        action = f"remove directory under {INSTANCE_DIR}"

    if not selected:
        LOG.info("nothing to clean for %s", target)
        return 0

    for row in selected:
        LOG.info("would %s: %s on %s", action, row["identifier"], row["host"])

    if dry_run:
        LOG.info("dry-run: %d item(s) would be cleaned", len(selected))
        return 0

    if not confirm(f"{action} for {len(selected)} item(s)?", assume_yes):
        LOG.info("aborted; nothing cleaned")
        return 1

    failures = 0
    for row in selected:
        host = row["host"]
        if target == "orphan-domains":
            domain = shlex.quote(row["_domain"])
            rc_destroy, _ = ssh(host, f"virsh destroy {domain}", user)
            rc_undef, _ = ssh(host, f"virsh undefine {domain} --nvram", user)
            # destroy fails harmlessly when the domain is already shut off.
            if rc_undef != 0:
                failures += 1
                LOG.error("failed to undefine %s on %s", row["_domain"], host)
            else:
                LOG.info("undefined domain %s on %s (destroy rc=%d)",
                         row["_domain"], host, rc_destroy)
        else:
            uuid = row["identifier"]
            if len(uuid) != 36 or uuid.count("-") != 4:
                LOG.error("refusing to remove non-UUID path %r", uuid)
                failures += 1
                continue
            rc, _ = ssh(host, f"rm -rf {INSTANCE_DIR}/{shlex.quote(uuid)}", user)
            if rc != 0:
                failures += 1
                LOG.error("failed to remove %s/%s on %s", INSTANCE_DIR, uuid, host)
            else:
                LOG.info("removed %s/%s on %s", INSTANCE_DIR, uuid, host)

    return 1 if failures else 0


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--host", action="append", help="compute host to check (repeatable)")
    parser.add_argument(
        "--all-hosts", action="store_true", help="check every enabled compute node"
    )
    parser.add_argument("--ssh-user", default="root", help="SSH user for the compute nodes")
    parser.add_argument(
        "--clean",
        choices=("orphan-domains", "stale-dirs"),
        help="remove one class of finding (honours --dry-run, confirms first)",
    )
    parser.add_argument(
        "--with-disk-usage",
        action="store_true",
        help="measure disk consumed by stale directories (slower)",
    )
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()
    setup_logging(args.verbose)

    if not args.host and not args.all_hosts:
        parser.error("pass --host <name> (repeatable) or --all-hosts")

    conn = connect(args.cloud)

    if args.all_hosts:
        hosts = [
            svc.host
            for svc in conn.compute.services()
            if svc.binary == "nova-compute" and svc.state == "up"
        ]
        LOG.info("checking %d compute node(s)", len(hosts))
    else:
        hosts = args.host

    rows: list[dict] = []
    for host in hosts:
        LOG.info("reconciling %s", host)
        rows.extend(reconcile(conn, host, args.ssh_user))

    if args.with_disk_usage:
        for row in rows:
            if row["finding"] == "STALE_INSTANCE_DIR":
                row["detail"] += f" ({disk_usage(row['host'], args.ssh_user, row['identifier'])})"

    rows.sort(key=lambda r: (r["finding"], r["host"], r["identifier"]))
    render(rows, COLUMNS, args.format)

    if args.format == "table" and rows:
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["finding"]] = counts.get(row["finding"], 0) + 1
        print("Summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        if counts.get("MISSING_DOMAIN"):
            print(
                "\nMISSING_DOMAIN is a tenant-visible outage, not cleanup — "
                "investigate before doing anything else."
            )

    if args.clean:
        return clean(rows, args.ssh_user, args.clean, args.dry_run, args.yes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
