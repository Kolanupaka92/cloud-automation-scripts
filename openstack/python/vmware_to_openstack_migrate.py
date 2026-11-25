#!/usr/bin/env python3
"""Migrate one VMware VM to OpenStack.

Phases: assess, snapshot, shutdown, export, convert, upload, provision,
validate, cutover. Each is journalled to a state file once it succeeds, so
--resume picks up from wherever it stopped instead of starting over. A phase
that fails stops the run.

This is a cold migration: the source is shut down before its disks are
exported, so nothing it writes can be missed and the two copies never share a
MAC and IP. The outage runs from shutdown to the end of provision.

The disk conversion is the easy part. The rest is picking a flavor that
actually fits, mapping port groups to Neutron networks, and keeping MAC and IP
so the application's peers and firewall rules still work.

    ./vmware_to_openstack_migrate.py --vm app-server-01 --assess-only
    ./vmware_to_openstack_migrate.py --vm app-server-01 --plan plans/wave3.yml
    ./vmware_to_openstack_migrate.py --resume state/app-server-01.json

Needs govc and qemu-img. Source credentials come from the GOVC_* environment
variables. The source VM is shut down, never deleted.
"""

from __future__ import annotations

import hashlib
import ipaddress
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

PHASES = ("assess", "snapshot", "shutdown", "export", "convert", "upload",
          "provision", "validate", "cutover")

POWERED_OFF = "poweredOff"

# Row statuses that mean a phase did not do its job. SKIPPED is an operator
# declining a prompt: not an error, but nothing after it may run either.
BLOCKING = {"FAIL", "SKIPPED"}


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
        self.flush()

    def note(self, **artifacts) -> None:
        """Journal something created part way through a phase."""
        self.data["artifacts"].update(artifacts)
        self.flush()

    def flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2))

    def out_of_order(self) -> list[str]:
        """Phases marked complete although an earlier one is not.

        Journals written before shutdown preceded export look like this, and
        their disks came from a source that was not known to be off.
        """
        pending = [p for p in PHASES if not self.done(p)]
        if not pending:
            return []
        return [p for p in PHASES[PHASES.index(pending[0]):] if self.done(p)]


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


def camel(value):
    """Lower-case the first letter of every key.

    govc emitted PascalCase JSON up to 0.30 and camelCase since; reading only
    one spelling turns the other into a VM with no CPUs, disks or NICs.
    """
    if isinstance(value, dict):
        return {key[:1].lower() + key[1:]: camel(item) for key, item in value.items()}
    if isinstance(value, list):
        return [camel(item) for item in value]
    return value


def ipv4_addresses(addresses) -> list[str]:
    """The routable IPv4 addresses out of what VMware Tools reports for a NIC."""
    if isinstance(addresses, str):
        addresses = [addresses]
    found = []
    for address in addresses or []:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if parsed.version == 4 and not parsed.is_link_local:
            found.append(str(parsed))
    return found


def parse_inventory(data: dict, vm: str) -> dict | None:
    data = camel(data)
    machines = data.get("virtualMachines") or []
    if not machines:
        LOG.error("VM %s not found", vm)
        return None

    machine = machines[0]
    config = machine.get("config") or {}
    hardware = config.get("hardware") or {}
    guest = machine.get("guest") or {}

    # Match guest addresses to NICs by MAC. The guest list also carries
    # bridges and tunnels, and is not in device order.
    guest_ips: dict[str, list[str]] = {}
    for net in guest.get("net") or []:
        mac = (net.get("macAddress") or "").lower()
        if mac:
            guest_ips.setdefault(mac, []).extend(ipv4_addresses(net.get("ipAddress")))

    disks, nics = [], []
    for device in hardware.get("device") or []:
        # By shape, not type name: a NIC is VirtualVmxnet3, VirtualE1000, ...
        if "capacityInKB" in device:
            disks.append({
                "label": (device.get("deviceInfo") or {}).get("label", "disk"),
                "size_gb": round((device["capacityInKB"] or 0) / 1024 / 1024, 1),
            })
        elif "macAddress" in device:
            backing = device.get("backing") or {}
            mac = device["macAddress"]
            nics.append({
                "mac": mac,
                "portgroup": backing.get("deviceName")
                             or (backing.get("port") or {}).get("portgroupKey", "unknown"),
                "ips": guest_ips.get((mac or "").lower(), []),
            })

    return {
        "name": machine.get("name", vm),
        "vcpus": hardware.get("numCPU", 0),
        "ram_mb": hardware.get("memoryMB", 0),
        "guest_id": config.get("guestId") or "unknown",
        "tools_status": guest.get("toolsStatus") or "unknown",
        "power_state": (machine.get("runtime") or {}).get("powerState", "unknown"),
        "firmware": config.get("firmware") or "bios",
        "disks": disks,
        "nics": nics,
    }


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
    return parse_inventory(data, vm)


def source_power(vm: str) -> str:
    inventory = source_inventory(vm)
    return inventory["power_state"] if inventory else "unknown"


def source_not_off(phase: str, vm: str) -> list[dict]:
    """A FAIL row when the source is not verifiably off, otherwise nothing."""
    power = source_power(vm)
    if power == POWERED_OFF:
        return []
    return [row(phase, "FAIL", vm, f"source VM is {power}, expected {POWERED_OFF}")]


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


def assess(conn, vm: str, plan: dict, prior: dict | None = None) -> tuple[list[dict], dict | None]:
    rows = []
    inventory = source_inventory(vm)
    if inventory is None:
        return [row("assess", "FAIL", vm, "could not read source VM inventory")], None

    # A powered-off guest reports no addresses. Once we have shut the source
    # down, what was journalled while it was running is the only record.
    if prior and inventory["power_state"] == POWERED_OFF:
        inventory = {**prior, "power_state": POWERED_OFF}

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
            rows.append(row("assess", "OK", portgroup, f"-> {target} (mac {nic['mac']})"))

        if plan.get("preserve_ip", True):
            if not nic["ips"]:
                rows.append(row("assess", "WARN", portgroup,
                                f"no IPv4 address known for {nic['mac']}, "
                                "the port will get a new one"))
            elif len(nic["ips"]) > 1:
                rows.append(row("assess", "WARN", portgroup,
                                f"{nic['mac']} has {len(nic['ips'])} addresses; only "
                                f"{nic['ips'][0]} is kept, add the rest by hand"))

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


def shutdown(vm: str, inventory: dict, plan: dict, execute: bool, assume_yes: bool) -> list[dict]:
    """Stop the source before its disks are read. The outage starts here."""
    graceful = inventory["tools_status"] in ("toolsOk", "toolsOld")
    how = "guest shutdown" if graceful else "hard power-off, VMware Tools is not running"
    if not execute:
        return [row("shutdown", "WOULD_RUN", vm, f"{how} of the source VM")]
    if source_power(vm) == POWERED_OFF:
        return [row("shutdown", "OK", vm, "source VM is already off")]
    if not confirm(f"Shut down the SOURCE VMware VM {vm} ({how})? The outage starts now.",
                   assume_yes):
        return [row("shutdown", "SKIPPED", vm, "source VM left running")]

    rc, _ = govc(["vm.power", "-s" if graceful else "-off", vm], timeout=600)
    if rc != 0:
        return [row("shutdown", "FAIL", vm, f"{how} was refused")]

    timeout = plan.get("shutdown_timeout", 600)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if source_power(vm) == POWERED_OFF:
            return [row("shutdown", "OK", vm, f"source VM is off ({how})")]
        time.sleep(10)
    return [row("shutdown", "FAIL", vm,
                f"source VM still not off after {timeout}s; stop it by hand, then --resume")]


def export_vm(vm: str, staging: Path, execute: bool) -> tuple[list[dict], Path | None]:
    target = staging / vm
    if not execute:
        return [row("export", "WOULD_RUN", vm, f"export OVF to {target}")], None

    running = source_not_off("export", vm)
    if running:
        return running, None

    # An earlier attempt may have left disks behind, and convert takes whatever
    # VMDK it finds here.
    for stale in target.glob("*.vmdk"):
        LOG.info("removing partial export %s", stale)
        stale.unlink()

    target.mkdir(parents=True, exist_ok=True)
    LOG.info("exporting %s to %s (this is the long one)", vm, target)
    rc, _ = govc(["export.ovf", "-f", "-vm", vm, str(staging)], timeout=6 * 3600)
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
        if not execute:
            return [row("convert", "WOULD_RUN", str(export_dir),
                        f"qemu-img convert the exported boot disk to {fmt}")], None
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

    if fmt == "raw":
        return rows, target      # qemu-img check does not support raw

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


def delete_ports(conn, port_ids: list[str]) -> list[str]:
    """Delete ports, returning the ones that could not be deleted."""
    stuck = []
    for port_id in port_ids:
        try:
            conn.network.delete_port(port_id, ignore_missing=True)
        except Exception as exc:  # noqa: BLE001 - report it, the caller decides
            LOG.error("could not delete port %s: %s", port_id, exc)
            stuck.append(port_id)
    return stuck


def provision(conn, vm: str, inventory: dict, plan: dict, image, state: MigrationState,
              execute: bool) -> list[dict]:
    rows = []
    flavor, _ = pick_flavor(conn, inventory, plan)
    if flavor is None:
        return [row("provision", "FAIL", vm, "no suitable flavor")]

    if execute:
        if image is None:
            return [row("provision", "FAIL", vm, "no uploaded image recorded in the journal")]
        running = source_not_off("provision", vm)
        if running:
            return running

        # Pick up what an interrupted attempt left, rather than colliding with
        # our own MAC and IP.
        server_id = state.data["artifacts"].get("server_id")
        if server_id:
            server = conn.compute.find_server(server_id, ignore_missing=True)
            if server is not None and server.status == "ACTIVE":
                return [row("provision", "OK", vm, f"instance {server_id} is already ACTIVE")]
            if server is not None:
                return [row("provision", "FAIL", vm,
                            f"instance {server_id} from an earlier attempt is {server.status}; "
                            "fix or delete it, then --resume")]
        stuck = delete_ports(conn, state.data["artifacts"].get("port_ids") or [])
        state.note(server_id=None, port_ids=stuck)
        if stuck:
            return [row("provision", "FAIL", vm,
                        f"ports from an earlier attempt cannot be deleted: {', '.join(stuck)}")]

    mapping = plan.get("network_map", {})
    preserve_mac = plan.get("preserve_mac", True)
    preserve_ip = plan.get("preserve_ip", True)

    port_ids: list[str] = []

    def abandon(subject: str, detail: str) -> list[dict]:
        state.note(port_ids=delete_ports(conn, port_ids))
        return rows + [row("provision", "FAIL", subject, detail)]

    for nic in inventory["nics"]:
        target = mapping.get(nic["portgroup"])
        network = conn.network.find_network(target, ignore_missing=True) if target else None
        if network is None:
            return abandon(nic["portgroup"], "unmapped port group")

        attrs = {"network_id": network.id, "name": f"{vm}-{nic['portgroup']}"}
        if preserve_mac and nic["mac"]:
            attrs["mac_address"] = nic["mac"]
        if preserve_ip and nic["ips"]:
            attrs["fixed_ips"] = [{"ip_address": nic["ips"][0]}]

        if not execute:
            kept = attrs["fixed_ips"][0]["ip_address"] if "fixed_ips" in attrs else "auto"
            rows.append(row("provision", "WOULD_RUN", nic["portgroup"],
                            f"create port on {target} mac={attrs.get('mac_address', 'auto')} "
                            f"ip={kept}"))
            continue

        try:
            port = conn.network.create_port(**attrs)
        except Exception as exc:  # noqa: BLE001
            return abandon(nic["portgroup"], f"port creation: {exc}")
        port_ids.append(port.id)
        state.note(port_ids=port_ids)
        rows.append(row("provision", "OK", port.name,
                        f"port {port.id} mac={port.mac_address} "
                        f"ip={[f['ip_address'] for f in port.fixed_ips]}"))

    if not execute:
        rows.append(row("provision", "WOULD_RUN", vm,
                        f"boot instance on flavor {flavor.name} from image {image or '(pending)'}"))
        return rows

    # Left out when unset rather than sent as null.
    optional = {key: plan[key] for key in ("key_name", "availability_zone") if plan.get(key)}
    try:
        server = conn.compute.create_server(
            name=vm,
            image_id=image.id,
            flavor_id=flavor.id,
            networks=[{"port": pid} for pid in port_ids],
            **optional,
        )
    except Exception as exc:  # noqa: BLE001
        return abandon(vm, f"instance creation: {exc}")

    state.note(server_id=server.id)
    try:
        server = conn.compute.wait_for_server(server, wait=plan.get("boot_timeout", 900))
    except Exception as exc:  # noqa: BLE001 - leave the instance for inspection
        return rows + [row("provision", "FAIL", vm,
                           f"instance {server.id} did not become ACTIVE: {exc}")]
    rows.append(row("provision", "OK", vm, f"instance {server.id} is {server.status}"))
    return rows


def validate_migration(conn, vm: str, server_id: str | None, execute: bool) -> list[dict]:
    if not execute:
        return [row("validate", "WOULD_RUN", vm, "verify instance state and port status")]

    # By id: another project can have an instance with the same name.
    server = conn.compute.find_server(server_id, ignore_missing=True) if server_id else None
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


def cutover(conn, vm: str, server_id: str | None, execute: bool) -> list[dict]:
    """Final gate: exactly one copy is running, and it is the OpenStack one."""
    if not execute:
        return [row("cutover", "WOULD_RUN", vm,
                    "confirm the source is off and the instance is ACTIVE")]

    running = source_not_off("cutover", vm)
    if running:
        return running
    server = conn.compute.find_server(server_id, ignore_missing=True) if server_id else None
    if server is None or server.status != "ACTIVE":
        return [row("cutover", "FAIL", vm,
                    f"instance is {server.status if server else 'missing'}, not ACTIVE")]
    return [
        row("cutover", "OK", vm, f"instance {server.id} is live, source VM off (not deleted)"),
        row("cutover", "INFO", vm,
            f"rollback: openstack server stop {server.id} && govc vm.power -on {vm}"),
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

    requested = [p.strip() for p in args.phase.split(",")] if args.phase else list(PHASES)
    unknown = [p for p in requested if p not in PHASES]
    if unknown:
        parser.error(f"unknown phase(s): {', '.join(unknown)} (choose from {', '.join(PHASES)})")
    phases = [p for p in PHASES if p in requested]
    if args.assess_only:
        phases = ["assess"]

    stale = state.out_of_order()
    if stale and not args.assess_only:
        LOG.error("%s marks %s complete although an earlier phase is not. Its disks may not "
                  "match the source; check for leftovers in OpenStack, remove the journal "
                  "and start again.", state_path, ", ".join(stale))
        return 2

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

        missing = [p for p in PHASES[:PHASES.index(phase)] if not state.done(p)]
        if execute and missing:
            rows.append(row(phase, "FAIL", vm, f"needs {', '.join(missing)} to complete first"))
            break

        LOG.info("phase: %s", phase)
        saved = state.data["artifacts"]
        prior = saved.get("inventory")
        if prior and any("ips" not in nic for nic in prior["nics"]):
            prior = None      # journalled before addresses were kept per NIC
        inv = inventory or prior
        if phase != "assess" and inv is None:
            rows.append(row(phase, "FAIL", vm, "no inventory; run the assess phase first"))
            break

        artifacts: dict = {}
        if phase == "assess":
            phase_rows, inventory = assess(conn, vm, plan, prior)
            artifacts = {"inventory": inventory}
        elif phase == "snapshot":
            phase_rows = snapshot(vm, inv, execute)
        elif phase == "shutdown":
            phase_rows = shutdown(vm, inv, plan, execute, args.yes)
        elif phase == "export":
            phase_rows, export_dir = export_vm(vm, staging, execute)
            artifacts = {"export_dir": str(export_dir)}
        elif phase == "convert":
            source_dir = export_dir or Path(saved.get("export_dir") or staging / vm)
            phase_rows, image_path = convert(source_dir, args.disk_format, execute)
            # upload has to declare the format that was actually written
            artifacts = {"image_path": str(image_path), "disk_format": args.disk_format}
        elif phase == "upload":
            path = image_path or (Path(saved["image_path"]) if saved.get("image_path") else None)
            phase_rows, image = upload_image(
                conn, vm, path, inv, saved.get("disk_format") or args.disk_format, execute)
            artifacts = {"image_id": image.id if image else None}
        elif phase == "provision":
            if image is None and execute and saved.get("image_id"):
                image = conn.image.get_image(saved["image_id"])
            phase_rows = provision(conn, vm, inv, plan, image, state, execute)
        elif phase == "validate":
            phase_rows = validate_migration(conn, vm, saved.get("server_id"), execute)
        else:
            phase_rows = cutover(conn, vm, saved.get("server_id"), execute)

        rows.extend(phase_rows)
        blocked = any(r["status"] in BLOCKING for r in phase_rows)
        # A dry run leaves no trace, or a rehearsal could pass for progress.
        if execute:
            if blocked:
                state.record(phase, "failed")
            else:
                state.record(phase, "ok", **artifacts)
        if blocked:
            LOG.error("stopping at %s; resolve the rows above, then --resume %s",
                      phase, state_path)
            break

    render(rows, COLUMNS, args.format)

    if args.format == "table":
        print(f"\nState journal: {state_path}")
        print(f"Rollback at any point: stop the OpenStack instance if there is one, "
              f"then govc vm.power -on {vm}")

    if any(r["phase"] == "assess" and r["status"] == "FAIL" for r in rows):
        return 2
    return 1 if any(r["status"] in BLOCKING for r in rows) else 0


if __name__ == "__main__":
    raise SystemExit(main())
