"""Regression tests for the OpenStack scripts that delete, migrate or gate.

Cloud state is faked at the connection level; every resource handed to the
scripts is a real openstacksdk object.
"""
import pathlib
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "openstack/python"))

import compute_node_decommission as decom
import compute_node_drain as drain
import hypervisor_capacity_report as capacity
import orphaned_instance_cleanup as oic
import orphaned_resource_audit as ora
import pytest
import upgrade_preflight as preflight
import vmware_to_openstack_migrate as mig
from openstack.compute.v2.flavor import Flavor
from openstack.compute.v2.hypervisor import Hypervisor
from openstack.compute.v2.migration import Migration
from openstack.compute.v2.server import Server
from openstack.image.v2.image import Image

from openstack import exceptions

OLD = "2020-01-01T00:00:00Z"
UUID = "11111111-2222-3333-4444-555555555555"


# ------------------------------------------------------- instance cleanup ---
def nova(here=(), elsewhere=(), error=None):
    known = {s.id: s for s in [*here, *elsewhere]}

    def get_server(uuid):
        if error:
            raise error
        if uuid not in known:
            raise exceptions.NotFoundException("gone")
        return known[uuid]

    return NS(compute=NS(
        servers=lambda **kw: [] if kw.get("deleted") else list(here),
        get_server=get_server,
    ))


@pytest.fixture
def host_with_leftovers(monkeypatch):
    """One domain, plus one directory that belongs to a different instance."""
    commands = []

    def ssh(host, command, user, timeout=60):
        commands.append(command)
        return 0, UUID + "\n" if "domuuid" in command else ""

    monkeypatch.setattr(oic, "ssh", ssh)
    monkeypatch.setattr(oic, "libvirt_domains", lambda h, u: {"instance-01": "running"})
    monkeypatch.setattr(oic, "instance_directories", lambda h, u: {UUID[::-1]})
    return commands


def migrating(uuid=UUID):
    return Server(id=uuid, status="MIGRATING", compute_host="other", task_state="migrating")


def test_domain_live_on_another_host_is_not_an_orphan(host_with_leftovers):
    conn = nova(elsewhere=[migrating(), migrating(UUID[::-1])])
    rows = oic.reconcile(conn, "compute-01", "root")
    assert [r["finding"] for r in rows] == ["UNCONFIRMED"]
    assert oic.clean(conn, rows, "root", "orphan-domains", False, True) == 0
    assert oic.clean(conn, rows, "root", "stale-dirs", False, True) == 0
    assert not any("destroy" in c or "rm -rf" in c for c in host_with_leftovers)


def test_nova_errors_never_count_as_absence(host_with_leftovers):
    conn = nova(error=exceptions.SDKException("503"))
    assert [r["finding"] for r in oic.reconcile(conn, "compute-01", "root")] == ["UNCONFIRMED"]


def test_real_orphans_are_still_found_and_cleaned(host_with_leftovers):
    conn = nova()
    rows = oic.reconcile(conn, "compute-01", "root")
    assert {r["finding"] for r in rows} == {"ORPHAN_DOMAIN", "STALE_INSTANCE_DIR"}
    assert oic.clean(conn, rows, "root", "orphan-domains", False, True) == 0
    assert any("virsh destroy" in c for c in host_with_leftovers)


def test_cleanup_rechecks_right_before_removing(host_with_leftovers):
    rows = oic.reconcile(nova(), "compute-01", "root")
    now_live = nova(elsewhere=[migrating(), migrating(UUID[::-1])])
    for target in ("orphan-domains", "stale-dirs"):
        assert oic.clean(now_live, rows, "root", target, False, True) == 1
    assert not any("destroy" in c or "rm -rf" in c for c in host_with_leftovers)


# ------------------------------------------------------------ image audit ---
def test_shelve_snapshots_are_kept():
    def image(iid, name, **kw):
        return Image(id=iid, name=name, visibility="private", is_protected=False,
                     created_at=OLD, size=1, status="active", **kw)

    conn = NS(
        compute=NS(servers=lambda **kw: [
            Server(id="s1", name="db", status="SHELVED_OFFLOADED", image={"id": "base"})]),
        image=NS(images=lambda: [
            image("base", "ubuntu"),
            image("by-uuid", "renamed", instance_uuid="s1"),
            image("by-name", "db-shelved"),
            image("unused", "old-build"),
        ]),
    )
    assert [r["id"] for r in ora.find_images(conn, 30)] == ["unused"]


# -------------------------------------------------------------- preflight ---
@pytest.mark.parametrize("status,expected", [
    ("confirmed", "PASS"), ("reverted", "PASS"), ("completed", "PASS"),
    ("finished", "FAIL"), ("migrating", "FAIL"), ("confirming", "FAIL"),
])
def test_only_unfinished_migrations_block(status, expected):
    conn = NS(compute=NS(migrations=lambda: [Migration(id=1, status=status)]))
    assert [r["status"] for r in preflight.check_orphan_migrations(conn)] == [expected]


def hv(name, host, version=8002000, **kw):
    return Hypervisor(name=name, service_details={"host": host}, hypervisor_type="QEMU",
                      hypervisor_version=version, state="up", status="enabled", **kw)


@pytest.mark.parametrize("versions,expected", [
    ((8, 8), ["PASS"]), ((8, 9), ["FAIL"]), ((8, None), ["PASS", "WARN"]), ((), ["WARN"]),
])
def test_version_skew(versions, expected):
    hypervisors = [hv(f"c{i}", f"c{i}", v) for i, v in enumerate(versions)]
    conn = NS(compute=NS(hypervisors=lambda **kw: hypervisors))
    assert [r["status"] for r in preflight.check_version_skew(conn)] == expected


# ------------------------------------------------------------- host names ---
FQDN = "compute-042.dfw.example.net"


def region(providers, hypervisors):
    return NS(
        placement=NS(resource_providers=lambda: [NS(name=n, id=n) for n in providers]),
        compute=NS(hypervisors=lambda **kw: hypervisors),
    )


def test_drain_does_not_count_its_own_capacity(monkeypatch):
    seen = []
    monkeypatch.setattr(drain, "host_capacity", lambda c, hvs: seen.extend(hvs) or {})
    drain.capacity_available(region([], [hv(FQDN, "compute-042"), hv("b", "b")]),
                             "compute-042", [])
    assert [h.name for h in seen] == ["b"]


def test_decommission_finds_the_fqdn_provider():
    conn = region([FQDN, "compute-0420.dfw.example.net"], [hv(FQDN, "compute-042")])
    names = decom.provider_names(conn, "compute-042")
    rows = decom.delete_resource_provider(conn, "compute-042", names, False, True)
    assert [(r["status"], r["object"]) for r in rows] == [("WOULD_DELETE", FQDN)]


def test_decommission_rerun_after_nova_forgot_the_host():
    rows = decom.delete_resource_provider(region([FQDN], []), "compute-042", set(), False, True)
    assert [r["object"] for r in rows] == [FQDN]


def test_decommission_refuses_to_guess():
    conn = region([FQDN, "compute-042.iad.example.net"], [])
    rows = decom.delete_resource_provider(conn, "compute-042", set(), True, True)
    assert [r["status"] for r in rows] == ["FAILED"]


def test_capacity_report_carries_the_service_host(monkeypatch):
    monkeypatch.setattr(capacity, "placement_capacity", lambda c: {})
    rows = capacity.hypervisor_rows(region([], [hv(FQDN, "compute-042")]), {"compute-042"})
    assert rows[0]["_host"] == "compute-042"


# ---------------------------------------------------------------- migration ---
def govc_json(pascal, power="poweredOn"):
    data = {"virtualMachines": [{
        "name": "app", "runtime": {"powerState": power},
        "config": {"guestId": "ubuntu64Guest", "firmware": "bios", "hardware": {
            "numCPU": 2, "memoryMB": 2048, "device": [
                {"_typeName": "VirtualDisk", "capacityInKB": 10485760,
                 "deviceInfo": {"label": "Hard disk 1"}},
                {"_typeName": "VirtualVmxnet3", "macAddress": "00:50:56:AA:00:01",
                 "backing": {"deviceName": "front"}},
                {"_typeName": "VirtualE1000", "macAddress": "00:50:56:AA:00:02",
                 "backing": {"port": {"portgroupKey": "back"}}},
            ]}},
        "guest": {"toolsStatus": "toolsOk", "net": [] if power != "poweredOn" else [
            {"macAddress": "02:42:00:00:00:01", "ipAddress": ["172.17.0.1"]},
            {"macAddress": "00:50:56:aa:00:02",
             "ipAddress": ["fe80::1", "169.254.1.1", "10.2.0.5"]},
            {"macAddress": "00:50:56:aa:00:01", "ipAddress": ["10.1.0.5", "10.1.0.6"]},
        ]},
    }]}
    if not pascal:
        return data

    def up(v):
        if isinstance(v, dict):
            return {k if k.startswith("_") else k[0].upper() + k[1:]: up(i) for k, i in v.items()}
        return [up(i) for i in v] if isinstance(v, list) else v
    return up(data)


@pytest.mark.parametrize("pascal", [True, False])
def test_inventory_reads_both_govc_spellings(pascal):
    inv = mig.parse_inventory(govc_json(pascal), "app")
    assert (inv["vcpus"], inv["ram_mb"], inv["power_state"]) == (2, 2048, "poweredOn")
    assert [d["size_gb"] for d in inv["disks"]] == [10.0]
    assert [(n["portgroup"], n["ips"]) for n in inv["nics"]] == [
        ("front", ["10.1.0.5", "10.1.0.6"]), ("back", ["10.2.0.5"])]


PLAN = {"network_map": {"front": "net-a", "back": "net-b"}}


class Cloud:
    def __init__(self, fail_port=None, boots=True):
        self.ports, self.deleted, self.servers = {}, [], {}
        self.fail_port, self.boots = fail_port, boots
        self.compute = NS(
            flavors=lambda **kw: [Flavor(id="f", name="f", vcpus=2, ram=2048, disk=20)],
            create_server=self.create_server, wait_for_server=self.wait,
            find_server=lambda sid, **kw: self.servers.get(sid),
            get_server=lambda sid: self.servers[sid])
        self.network = NS(
            find_network=lambda n, **kw: NS(id=n), create_port=self.create_port,
            delete_port=self.delete_port, ports=lambda **kw: [])
        self.image = NS(create_image=lambda **kw: NS(id="img"), get_image=lambda i: NS(id=i))

    def create_port(self, **attrs):
        if attrs["network_id"] == self.fail_port:
            raise exceptions.BadRequestException("no")
        pid = f"p{len(self.ports) + 1}"
        self.ports[pid] = attrs
        return NS(id=pid, name=attrs["name"], mac_address=attrs["mac_address"],
                  fixed_ips=attrs.get("fixed_ips", []))

    def delete_port(self, pid, **kw):
        self.deleted.append(pid)

    def create_server(self, **kw):
        self.servers["srv"] = Server(id="srv", status="BUILD")
        return self.servers["srv"]

    def wait(self, server, **kw):
        server.status = "ACTIVE" if self.boots else "ERROR"
        if not self.boots:
            raise exceptions.ResourceFailure("ERROR")
        return server


class Vcenter:
    def __init__(self, tmp_path):
        self.tmp, self.power, self.calls, self.fail = tmp_path, "poweredOn", [], None

    def __call__(self, args, timeout=300):
        self.calls.append(args[0])
        if args[0] == self.fail:
            return 1, ""
        if args[0] == "vm.info":
            import json
            return 0, json.dumps(govc_json(False, self.power))
        if args[0] == "vm.power":
            self.power = "poweredOff"
        if args[0] == "export.ovf":
            assert self.power == "poweredOff", "exported a running source"
            (self.tmp / "staging" / "app" / "app-disk.vmdk").write_bytes(b"x")
        return 0, ""


@pytest.fixture
def run(monkeypatch, tmp_path):
    vcenter = Vcenter(tmp_path)
    plan = tmp_path / "plan.yml"
    plan.write_text("{}")
    monkeypatch.setattr(mig, "govc", vcenter)
    monkeypatch.setattr(mig, "require_tools", lambda *a: None)
    monkeypatch.setattr(mig, "load_plan", lambda p: dict(PLAN))
    monkeypatch.setattr(mig, "convert", lambda d, f, e: (
        [mig.row("convert", "OK" if e else "WOULD_RUN", "d", "")], d / "a.qcow2" if e else None))
    monkeypatch.setattr(mig.time, "sleep", lambda s: None)

    def go(cloud, *extra):
        monkeypatch.setattr(mig, "connect", lambda c: cloud)
        monkeypatch.setattr(sys, "argv", [
            "m", "--vm", "app", "--yes", "--staging", str(tmp_path / "staging"),
            "--state-dir", str(tmp_path / "state"), *extra])
        return mig.main()

    go.vcenter, go.journal = vcenter, tmp_path / "state" / "app.json"
    return go


def journal(run):
    import json
    return json.loads(run.journal.read_text())


def test_full_migration_shuts_down_before_export_and_keeps_each_ip(run):
    cloud = Cloud()
    assert run(cloud) == 0
    calls = run.vcenter.calls
    assert calls.index("vm.power") < calls.index("export.ovf")
    assert [p["fixed_ips"] for p in cloud.ports.values()] == [
        [{"ip_address": "10.1.0.5"}], [{"ip_address": "10.2.0.5"}]]
    assert journal(run)["completed"] == list(mig.PHASES)


def test_failed_snapshot_never_reaches_the_source(run):
    run.vcenter.fail = "snapshot.create"
    assert run(Cloud()) == 1
    assert run.vcenter.power == "poweredOn"
    assert journal(run)["completed"] == ["assess"]


def test_failed_provision_stops_cleans_up_and_resumes(run):
    broken = Cloud(fail_port="net-b")
    assert run(broken) == 1
    assert broken.deleted == ["p1"]
    assert "provision" not in journal(run)["completed"]

    # The source is off by now and reports no addresses.
    fixed = Cloud()
    assert run(fixed) == 0
    assert [p["fixed_ips"][0]["ip_address"] for p in fixed.ports.values()] == [
        "10.1.0.5", "10.2.0.5"]
    assert run.vcenter.calls.count("export.ovf") == 1


def test_instance_that_fails_to_boot_is_not_recreated_behind_your_back(run):
    cloud = Cloud(boots=False)
    assert run(cloud) == 1
    assert run(cloud) == 1                      # ERROR instance still there
    assert len(cloud.ports) == 2
    cloud.servers.clear()                       # operator deletes it
    cloud.boots = True
    assert run(cloud) == 0
    assert cloud.deleted == ["p1", "p2"]


def test_cutover_refuses_when_the_source_is_back_on(run):
    cloud = Cloud()
    assert run(cloud, "--phase", ",".join(mig.PHASES[:-1])) == 0
    run.vcenter.power = "poweredOn"
    assert run(cloud, "--phase", "cutover") == 1
    assert "cutover" not in journal(run)["completed"]


def test_phase_cannot_skip_its_prerequisites(run):
    assert run(Cloud(), "--phase", "cutover") == 1
    assert "vm.power" not in run.vcenter.calls


def test_declined_shutdown_goes_no_further(run, monkeypatch):
    monkeypatch.setattr(mig, "confirm", lambda *a: False)
    assert run(Cloud()) == 1
    assert "export.ovf" not in run.vcenter.calls
    assert "shutdown" not in journal(run)["completed"]


def test_journal_from_before_shutdown_is_refused(run):
    run.journal.parent.mkdir(parents=True)
    run.journal.write_text('{"vm": "app", "completed": ["assess", "snapshot", "export"], '
                           '"artifacts": {}, "log": []}')
    assert run(Cloud()) == 2
    assert run.vcenter.calls == []


def test_dry_run_covers_every_phase_and_leaves_no_journal(run, capsys):
    cloud = Cloud()
    assert run(cloud, "--dry-run") == 0
    out = capsys.readouterr().out
    assert all(phase in out for phase in mig.PHASES)
    assert not run.journal.exists() and not cloud.ports
    assert set(run.vcenter.calls) == {"vm.info"}
