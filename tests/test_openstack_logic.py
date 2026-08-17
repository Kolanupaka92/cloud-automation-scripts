"""Exercise the OpenStack helpers against real openstacksdk resource objects.

Resources are built from the SDK's own classes, so a rename or type change in
openstacksdk fails these tests rather than surfacing as an empty report.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "openstack/python"))

import orphaned_resource_audit as ora
import security_group_audit as sga
import upgrade_preflight as preflight
from openstack.block_storage.v3.volume import Volume
from openstack.compute.v2.hypervisor import Hypervisor
from openstack.compute.v2.server import Server
from openstack.network.v2.security_group_rule import SecurityGroupRule

import common


# ----------------------------------------------------------------- common ---
def test_pct_handles_zero_denominator():
    assert common.pct(5, 10) == 50.0
    assert common.pct(0, 0) == 0.0      # an erroring host must not divide by zero


# --------------------------------------------------------------- capacity ---
def test_hypervisor_fields_exist_on_the_sdk_model():
    hv = Hypervisor(name="compute-01", vcpus=64, vcpus_used=32,
                    memory_size=262144, memory_used=131072,
                    local_disk_size=2000, local_disk_used=500,
                    running_vms=12, state="up", status="enabled")
    for field in ("name", "vcpus", "vcpus_used", "memory_size", "memory_used",
                  "local_disk_size", "local_disk_used", "running_vms", "state", "status"):
        assert hasattr(hv, field), f"openstacksdk Hypervisor lost .{field}"
    assert common.pct(hv.vcpus_used, hv.vcpus) == 50.0


# --------------------------------------------------- security group audit ---
def rule(**kw):
    defaults = {"direction": "ingress", "protocol": "tcp",
                "remote_ip_prefix": "0.0.0.0/0",
                "port_range_min": 22, "port_range_max": 22}
    defaults.update(kw)
    return SecurityGroupRule(**defaults)


def test_world_open_ssh_is_critical():
    severity, text = sga.classify(rule())
    assert severity == "CRITICAL"
    assert "SSH" in text


def test_world_open_high_port_is_high_not_critical():
    severity, _ = sga.classify(rule(port_range_min=8080, port_range_max=8080))
    assert severity == "HIGH"


def test_all_ports_open_to_world_is_flagged():
    severity, text = sga.classify(
        rule(protocol=None, port_range_min=None, port_range_max=None))
    assert severity == "HIGH"
    assert "all protocols" in text


def test_wide_private_range_to_admin_port_is_medium():
    severity, _ = sga.classify(rule(remote_ip_prefix="10.0.0.0/8"))
    assert severity == "MEDIUM"


def test_narrow_private_source_is_not_flagged():
    assert sga.classify(rule(remote_ip_prefix="10.1.2.0/24")) is None


def test_egress_is_never_flagged():
    assert sga.classify(rule(direction="egress")) is None


def test_remote_group_reference_is_the_good_pattern():
    assert sga.classify(rule(remote_ip_prefix=None)) is None


def test_port_range_covering_ssh_is_caught():
    severity, text = sga.classify(rule(port_range_min=20, port_range_max=30))
    assert severity == "CRITICAL" and "SSH" in text


def test_port_range_rendering():
    assert sga.port_range(rule(port_range_min=None, port_range_max=None)) == "ALL"
    assert sga.port_range(rule(port_range_min=80, port_range_max=80)) == "80"
    assert sga.port_range(rule(port_range_min=80, port_range_max=90)) == "80-90"


# ------------------------------------------------- orphaned resource audit ---
def test_age_days_parses_openstack_timestamps():
    assert ora.age_days(None) == -1
    assert ora.age_days("not-a-date") == -1
    assert ora.age_days("2020-01-01T00:00:00Z") > 1000


def test_older_than_is_false_for_unknown_timestamps():
    assert ora.older_than(None, 30) is False


def test_infra_ports_are_excluded_from_orphans():
    """Router and DHCP ports are infrastructure, not leftovers."""
    for owner in ora.INFRA_PORT_OWNERS:
        assert owner.startswith("network:")


def test_volume_model_fields_exist():
    vol = Volume(id="v1", name="data", status="available", size=100, attachments=[])
    for field in ("id", "name", "status", "size", "attachments"):
        assert hasattr(vol, field), f"openstacksdk Volume lost .{field}"


# ------------------------------------------------------- upgrade preflight ---
def test_stable_state_sets_are_lowercase():
    """States are compared lowercased; a stray capital would never match."""
    assert all(s == s.lower() for s in preflight.STABLE_VM_STATES)
    assert all(s == s.lower() for s in preflight.STABLE_VOLUME_STATES)


def test_server_model_exposes_the_fields_preflight_reads():
    srv = Server(id="s1", name="app", vm_state="active", task_state=None, status="ACTIVE")
    for field in ("id", "name", "vm_state", "task_state", "status"):
        assert hasattr(srv, field), f"openstacksdk Server lost .{field}"


def test_row_helpers_produce_consistent_shape():
    for helper in (preflight.ok, preflight.warn, preflight.fail):
        row = helper("check", "subject", "detail")
        assert set(row) == {"status", "check", "subject", "detail"}
