#!/usr/bin/env python3
"""Migrate one VMware VM to OpenStack.

Phases: assess, snapshot, export, convert, upload, provision, validate,
cutover. Each is journalled to a state file, so --resume picks up from
wherever it stopped instead of starting over.

The disk conversion is the easy part. The rest is picking a flavor that
actually fits, mapping port groups to Neutron networks, and keeping MAC and IP
so the application's peers and firewall rules still work.

    ./vmware_to_openstack_migrate.py --vm app-server-01 --assess-only
    ./vmware_to_openstack_migrate.py --vm app-server-01 --plan plans/wave3.yml
    ./vmware_to_openstack_migrate.py --resume state/app-server-01.json

Needs govc and qemu-img. Source credentials come from the GOVC_* environment
variables. The source VM is powered off at cutover, never deleted.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from common import LOG, base_parser, confirm, connect, render, setup_logging

COLUMNS = ("phase", "status", "subject", "detail")

PHASES = ("assess", "snapshot", "export", "convert", "upload", "provision", "validate", "cutover")


def row(phase, status, subject, detail) -> dict:
    return {"phase": phase, "status": status, "subject": subject, "detail": detail}


class MigrationState:
    """Journal so an interrupted migration resumes instead of restarting."""

    def __init__(self, path: Path, vm: str):
        self.path = path
        self.data = {
            "vm": vm,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "completed": [],
            "artifacts": {},
            "log": [],
        }
        if path.exists():
            self.data = json.loads(path.read_text())
            LOG.info("resuming %s from %s", self.data["vm"], path)

    def done(self, phase: str) -> bool:
        return phase in self.data["completed"]

    def record(self, phase: str, status: str, **artifacts) -> None:
        if status == "ok" and phase not in self.data["completed"]:
            self.data["completed"].append(phase)
        self.data["artifacts"].update(artifacts)
        self.data["log"].append({
            "phase": phase, "status": status,
            "at": datetime.now(timezone.utc).isoformat(),
        })
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2))


def require_tools(*tools: str) -> None:
    missing = [tool for tool in tools if shutil.which(tool) is None]
    if missing:
        sys.exit(f"required tool(s) not on PATH: {', '.join(missing)}")


def govc(args: list[str], timeout: int = 300) -> tuple[int, str]:
    if not os.environ.get("GOVC_URL"):
        sys.exit("GOVC_URL is not set; source your VMware environment first")
    try:
        proc = subprocess.run(["govc", *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        LOG.error("govc %s timed out", " ".join(args))
        return 255, ""
    if proc.returncode != 0:
        LOG.debug("govc %s failed: %s", " ".join(args), proc.stderr.strip()[:300])
    return proc.returncode, proc.stdout


def source_inventory(vm: str) -> dict | None:
    """Read the source VM's hardware inventory from vCenter."""
    rc, out = govc(["vm.info", "-json", vm])
    if rc != 0 or not out.strip():
        LOG.error("could not read VM %s from vCenter", vm)
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        LOG.error("unexpected govc output for %s", vm)
        return None

    machines = data.get("VirtualMachines") or data.get("virtualMachines") or []
    if not machines:
        LOG.error("VM %s not found", vm)
        return None

    machine = machines[0]
    config = machine.get("Config", {})
    hardware = config.get("Hardware", {})
    guest = machine.get("Guest", {})

    disks, nics = [], []
    for device in hardware.get("Device", []):
        kind = device.get("_typeName", "")
        if "VirtualDisk" in kind:
            disks.append({
                "label": device.get("DeviceInfo", {}).get("Label", "disk"),
                "size_gb": round(device.get("CapacityInKB", 0) / 1024 / 1024, 1),
            })
        elif "Ethernet" in kind:
            backing = device.get("Backing", {})
            nics.append({
                "mac": device.get("MacAddress"),
                "portgroup": backing.get("DeviceName")
                             or backing.get("Port", {}).get("PortgroupKey", "unknown"),
            })

    return {
        "name": machine.get("Name", vm),
        "vcpus": hardware.get("NumCPU", 0),
        "ram_mb": hardware.get("MemoryMB", 0),
        "guest_id": config.get("GuestId", "unknown"),
        "guest_ips": [n.get("IpAddress") for n in guest.get("Net", []) if n.get("IpAddress")],
        "tools_status": guest.get("ToolsStatus", "unknown"),
        "power_state": machine.get("Runtime", {}).get("PowerState", "unknown"),
        "firmware": config.get("Firmware", "bios"),
        "disks": disks,
        "nics": nics,
    }


def pick_flavor(conn, inventory: dict, plan: dict) -> tuple[object | None, str]:
    """Smallest flavor that fits, unless the plan names one explicitly."""
    override = plan.get("flavor")
    if override:
        flavor = conn.compute.find_flavor(override, ignore_missing=True)
        return flavor, ("explicit from plan" if flavor else f"flavor {override} not found")

    root_gb = max((d["size_gb"] for d in inventory["disks"]), default=0)
    candidates = [
        f for f in conn.compute.flavors(details=True)
        if f.vcpus >= inventory["vcpus"]
        and f.ram >= inventory["ram_mb"]
        and (f.disk or 0) >= root_gb
    ]
    if not candidates:
        return None, (f"no flavor fits {inventory['vcpus']} vCPU / "
                      f"{inventory['ram_mb']} MB / {root_gb} GB")
    best = min(candidates, key=lambda f: (f.vcpus, f.ram, f.disk or 0))
    waste = ((best.vcpus - inventory["vcpus"]) * 100 // max(inventory["vcpus"], 1))
    return best, f"smallest fit ({waste}% spare vCPU)"


def assess(conn, vm: str, plan: dict) -> tuple[list[dict], dict | None]:
    rows = []
    inventory = source_inventory(vm)
    if inventory is None:
        return [row("assess", "FAIL", vm, "could not read source VM inventory")], None

    rows.append(row("assess", "INFO", vm,
                    f"{inventory['vcpus']} vCPU, {inventory['ram_mb']} MB, "
                    f"{len(inventory['disks'])} disk(s), {len(inventory['nics'])} NIC(s), "
                    f"guest={inventory['guest_id']}, firmware={inventory['firmware']}"))

    if inventory["tools_status"] not in ("toolsOk", "toolsOld"):
        rows.append(row("assess", "WARN", vm,
                        f"VMware Tools status is {inventory['tools_status']}, "
                        "a quiesced snapshot will not be possible"))

    if inventory["firmware"].lower() == "efi":
        rows.append(row("assess", "WARN", vm,
                        "source uses EFI firmware; the Glance image needs "
                        "hw_firmware_type=uefi or the instance will not boot"))

    flavor, why = pick_flavor(conn, inventory, plan)
    if flavor is None:
        rows.append(row("assess", "FAIL", vm, why))
    else:
        rows.append(row("assess", "OK", vm,
                        f"flavor {flavor.name} ({flavor.vcpus} vCPU / {flavor.ram} MB / "
                        f"{flavor.disk} GB), {why}"))

    # Every port group must map to a Neutron network, or the VM cannot be built.
    mapping = plan.get("network_map", {})
    for nic in inventory["nics"]:
        portgroup = nic["portgroup"]
        target = mapping.get(portgroup)
        if not target:
            rows.append(row("assess", "FAIL", portgroup,
                            "no network_map entry for this port group"))
            continue
        network = conn.network.find_network(target, ignore_missing=True)
        if network is None:
            rows.append(row("assess", "FAIL", portgroup,
                            f"mapped to '{target}' which does not exist in OpenStack"))
        else:
            rows.append(row("assess", "OK", portgroup,
                            f"-> {target} (mac {nic['mac']} preserved)"))

    total_gb = sum(d["size_gb"] for d in inventory["disks"])
    rows.append(row("assess", "INFO", vm,
                    f"{total_gb} GB to export and convert; ensure the staging "
                    f"directory has at least {round(total_gb * 2.2)} GB free"))

    return rows, inventory


def snapshot(vm: str, inventory: dict, execute: bool) -> list[dict]:
    name = f"pre-openstack-migration-{int(time.time())}"
    quiesce = inventory["tools_status"] in ("toolsOk", "toolsOld")
    if not execute:
        return [row("snapshot", "WOULD_RUN", vm,
                    f"create snapshot {name} (quiesce={quiesce})")]

    args = ["snapshot.create", "-vm", vm]
    if quiesce:
        args.append("-q")
    args.append(name)
    rc, _ = govc(args, timeout=900)
    if rc != 0:
        return [row("snapshot", "FAIL", vm, "snapshot creation failed")]
    return [row("snapshot", "OK", vm, f"snapshot {name} created (quiesce={quiesce})")]


def export_vm(vm: str, staging: Path, execute: bool) -> tuple[list[dict], Path | None]:
    target = staging / vm
    if not execute:
        return [row("export", "WOULD_RUN", vm, f"export OVF to {target}")], None

    target.mkdir(parents=True, exist_ok=True)
    LOG.info("exporting %s to %s (this is the long one)", vm, target)
    rc, _ = govc(["export.ovf", "-vm", vm, str(staging)], timeout=6 * 3600)
    if rc != 0:
        return [row("export", "FAIL", vm, "govc export.ovf failed")], None

    vmdks = list(target.glob("*.vmdk"))
    if not vmdks:
        return [row("export", "FAIL", vm, f"no VMDK found under {target}")], None
    return [row("export", "OK", vm, f"{len(vmdks)} disk(s) exported to {target}")], target


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def convert(export_dir: Path, fmt: str, execute: bool) -> tuple[list[dict], Path | None]:
    rows = []
    vmdks = sorted(export_dir.glob("*.vmdk")) if export_dir.exists() else []
    if not vmdks:
        return [row("convert", "FAIL", str(export_dir), "no VMDK to convert")], None

    # Largest disk is the boot disk in everything I've migrated so far.
    # TODO: data disks still have to be done by hand afterwards. Should attach
    # them as Cinder volumes here once I've got a case with more than one.
    source = max(vmdks, key=lambda p: p.stat().st_size)
    target = source.with_suffix(f".{fmt}")

    if not execute:
        return [row("convert", "WOULD_RUN", source.name,
                    f"qemu-img convert -O {fmt} -> {target.name}")], None

    before = checksum(source)
    proc = subprocess.run(
        ["qemu-img", "convert", "-p", "-O", fmt, str(source), str(target)],
        capture_output=True, text=True, timeout=6 * 3600,
    )
    if proc.returncode != 0:
        return [row("convert", "FAIL", source.name, proc.stderr.strip()[:200])], None

    rows.append(row("convert", "OK", target.name,
                    f"converted to {fmt}, {target.stat().st_size // 2**30} GB, "
                    f"source sha256 {before[:12]}"))

    verify = subprocess.run(["qemu-img", "check", str(target)],
                            capture_output=True, text=True, timeout=1800)
    if verify.returncode != 0:
        rows.append(row("convert", "FAIL", target.name, "qemu-img check reported errors"))
        return rows, None
    rows.append(row("convert", "OK", target.name, "qemu-img check passed"))
    return rows, target


def upload_image(conn, vm: str, image_path: Path, inventory: dict, fmt: str,
                 execute: bool) -> tuple[list[dict], object | None]:
    name = f"{vm}-migrated"
    properties = {
        "hw_disk_bus": "virtio",
        "hw_vif_model": "virtio",
        "os_type": "windows" if "windows" in inventory["guest_id"].lower() else "linux",
    }
    if inventory["firmware"].lower() == "efi":
        properties["hw_firmware_type"] = "uefi"
    if "windows" in inventory["guest_id"].lower():
        # Windows needs the SCSI bus and QEMU guest agent disabled unless the
        # virtio drivers were installed on the source first.
        properties["hw_disk_bus"] = "scsi"
        properties["hw_scsi_model"] = "virtio-scsi"

    if not execute:
        return [row("upload", "WOULD_RUN", name,
                    f"create Glance image from {image_path.name if image_path else '?'} "
                    f"with {properties}")], None

    LOG.info("uploading %s to Glance", image_path)
    image = conn.image.create_image(
        name=name,
        disk_format=fmt,
        container_format="bare",
        filename=str(image_path),
        **properties,
    )
    return [row("upload", "OK", name, f"image {image.id} ({properties})")], image


def provision(conn, vm: str, inventory: dict, plan: dict, image, execute: bool) -> list[dict]:
    rows = []
    flavor, _ = pick_flavor(conn, inventory, plan)
    if flavor is None:
        return [row("provision", "FAIL", vm, "no suitable flavor")]

    mapping = plan.get("network_map", {})
    preserve_mac = plan.get("preserve_mac", True)
    preserve_ip = plan.get("preserve_ip", True)

    port_ids = []
    for nic in inventory["nics"]:
        target = mapping.get(nic["portgroup"])
        network = conn.network.find_network(target, ignore_missing=True) if target else None
        if network is None:
            return [row("provision", "FAIL", nic["portgroup"], "unmapped port group")]

        attrs = {"network_id": network.id, "name": f"{vm}-{nic['portgroup']}"}
        if preserve_mac and nic["mac"]:
            attrs["mac_address"] = nic["mac"]
        if preserve_ip and inventory["guest_ips"]:
            attrs["fixed_ips"] = [{"ip_address": inventory["guest_ips"][0]}]

        if not execute:
            rows.append(row("provision", "WOULD_RUN", nic["portgroup"],
                            f"create port on {target} mac={attrs.get('mac_address', 'auto')} "
                            f"ip={inventory['guest_ips'][:1] or 'auto'}"))
            continue

        try:
            port = conn.network.create_port(**attrs)
            port_ids.append(port.id)
            rows.append(row("provision", "OK", port.name,
                            f"port {port.id} mac={port.mac_address} "
                            f"ip={[f['ip_address'] for f in port.fixed_ips]}"))
        except Exception as exc:  # noqa: BLE001
            return rows + [row("provision", "FAIL", nic["portgroup"], f"port creation: {exc}")]

    if not execute:
        rows.append(row("provision", "WOULD_RUN", vm,
                        f"boot instance on flavor {flavor.name} from image {image or '(pending)'}"))
        return rows

    server = conn.compute.create_server(
        name=vm,
        image_id=image.id,
        flavor_id=flavor.id,
        networks=[{"port": pid} for pid in port_ids],
        key_name=plan.get("key_name"),
        availability_zone=plan.get("availability_zone"),
    )
    server = conn.compute.wait_for_server(server, wait=plan.get("boot_timeout", 900))
    rows.append(row("provision", "OK", vm, f"instance {server.id} is {server.status}"))
    return rows


def validate_migration(conn, vm: str, execute: bool) -> list[dict]:
    if not execute:
        return [row("validate", "WOULD_RUN", vm, "verify instance state and port status")]

    server = conn.compute.find_server(vm, ignore_missing=True)
    if server is None:
        return [row("validate", "FAIL", vm, "instance not found after provisioning")]

    server = conn.compute.get_server(server.id)
    rows = [row("validate", "OK" if server.status == "ACTIVE" else "FAIL", vm,
                f"instance status {server.status}")]

    for port in conn.network.ports(device_id=server.id):
        rows.append(row("validate", "OK" if port.status == "ACTIVE" else "WARN",
                        port.name or port.id,
                        f"port {port.status}, mac {port.mac_address}, "
                        f"ips {[f['ip_address'] for f in port.fixed_ips]}"))

    rows.append(row("validate", "INFO", vm,
                    "application-level validation is a human step: service start, "
                    "licence re-binding to the new MAC, and monitoring re-registration"))
    return rows


def cutover(vm: str, execute: bool, assume_yes: bool) -> list[dict]:
    if not execute:
        return [row("cutover", "WOULD_RUN", vm, "power off the source VMware VM")]
    if not confirm(f"Power off the SOURCE VMware VM {vm}?", assume_yes):
        return [row("cutover", "SKIPPED", vm, "source VM left running")]

    rc, _ = govc(["vm.power", "-off", vm], timeout=600)
    if rc != 0:
        return [row("cutover", "FAIL", vm, "could not power off the source VM")]
    return [
        row("cutover", "OK", vm, "source VM powered off (not deleted)"),
        row("cutover", "INFO", vm, f"rollback: govc vm.power -on {vm}"),
    ]


def load_plan(path: str | None) -> dict:
    if not path:
        return {}
    try:
        import yaml
        with open(path) as handle:
            return yaml.safe_load(handle) or {}
    except ImportError:
        sys.exit("PyYAML is required to read a plan file")
    except OSError as exc:
        sys.exit(f"cannot read plan: {exc}")


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--vm", help="source VMware VM name")
    parser.add_argument("--plan", help="YAML plan: flavor, network_map, key_name, ...")
    parser.add_argument(
        "--phase", help="comma-separated phases to run (default: all, in order)"
    )
    parser.add_argument("--assess-only", action="store_true", help="run the assessment and stop")
    parser.add_argument(
        "--staging", default="/var/tmp/vmware-migration",
        help="directory for exported and converted disks",
    )
    parser.add_argument(
        "--disk-format", choices=("qcow2", "raw"), default="qcow2",
        help="target disk format for Glance",
    )
    parser.add_argument("--resume", help="path to an existing state file")
    parser.add_argument("--state-dir", default="state", help="directory for state files")
    parser.add_argument("--yes", action="store_true", help="skip confirmation prompts")
    args = parser.parse_args()
    setup_logging(args.verbose)

    if not args.vm and not args.resume:
        parser.error("pass --vm <name> or --resume <state file>")

    require_tools("govc", "qemu-img")
    plan = load_plan(args.plan)
    conn = connect(args.cloud)
    execute = not args.dry_run

    vm = args.vm
    state_path = Path(args.resume) if args.resume else Path(args.state_dir) / f"{vm}.json"
    state = MigrationState(state_path, vm or state_path.stem)
    vm = state.data["vm"]

    phases = [p.strip() for p in args.phase.split(",")] if args.phase else list(PHASES)
    if args.assess_only:
        phases = ["assess"]

    staging = Path(args.staging)
    rows: list[dict] = []
    inventory = None
    export_dir = None
    image_path = None
    image = None

    for phase in phases:
        if state.done(phase) and phase != "assess":
            LOG.info("%s already completed; skipping", phase)
            continue

        LOG.info("phase: %s", phase)
        if phase == "assess":
            phase_rows, inventory = assess(conn, vm, plan)
            rows.extend(phase_rows)
            if any(r["status"] == "FAIL" for r in phase_rows):
                render(rows, COLUMNS, args.format)
                LOG.error("assessment failed; resolve the blockers above before migrating")
                return 2
            state.record(phase, "ok", inventory=inventory)
        elif phase == "snapshot":
            rows.extend(snapshot(vm, inventory or state.data["artifacts"]["inventory"], execute))
            state.record(phase, "ok" if execute else "dry-run")
        elif phase == "export":
            phase_rows, export_dir = export_vm(vm, staging, execute)
            rows.extend(phase_rows)
            state.record(phase, "ok" if export_dir else "dry-run",
                         export_dir=str(export_dir) if export_dir else None)
        elif phase == "convert":
            source_dir = export_dir or Path(state.data["artifacts"].get("export_dir") or staging / vm)
            phase_rows, image_path = convert(source_dir, args.disk_format, execute)
            rows.extend(phase_rows)
            state.record(phase, "ok" if image_path else "dry-run",
                         image_path=str(image_path) if image_path else None)
        elif phase == "upload":
            path = image_path or Path(state.data["artifacts"].get("image_path", ""))
            inv = inventory or state.data["artifacts"].get("inventory", {})
            phase_rows, image = upload_image(conn, vm, path, inv, args.disk_format, execute)
            rows.extend(phase_rows)
            state.record(phase, "ok" if image else "dry-run",
                         image_id=image.id if image else None)
        elif phase == "provision":
            inv = inventory or state.data["artifacts"].get("inventory", {})
            if image is None and state.data["artifacts"].get("image_id"):
                image = conn.image.get_image(state.data["artifacts"]["image_id"])
            rows.extend(provision(conn, vm, inv, plan, image, execute))
            state.record(phase, "ok" if execute else "dry-run")
        elif phase == "validate":
            rows.extend(validate_migration(conn, vm, execute))
            state.record(phase, "ok" if execute else "dry-run")
        elif phase == "cutover":
            rows.extend(cutover(vm, execute, args.yes))
            state.record(phase, "ok" if execute else "dry-run")

    render(rows, COLUMNS, args.format)

    if args.format == "table":
        print(f"\nState journal: {state_path}")
        print(f"Rollback at any point: govc vm.power -on {vm}")

    return 1 if any(r["status"] == "FAIL" for r in rows) else 0


if __name__ == "__main__":
    raise SystemExit(main())
