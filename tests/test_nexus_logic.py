"""Exercise the Nexus helpers against real SDK model objects.

These build genuine azure-mgmt-networkcloud model instances rather than mocks,
so the tests fail if the SDK changes shape. Otherwise that turns up as every
field reading None against a live cloud.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "azure/operator-nexus/python"))

import nexus_common as nc
from azure.mgmt.networkcloud import models as m


def build(name="bmm-r03-s04", rack="rack-03", slot=4, **overrides):
    """Construct the model with only the required fields, then set state."""
    props = m.BareMetalMachineProperties(
        bmc_connection_string="bmc-01",
        bmc_credentials=m.AdministrativeCredentials(username="u", password="p"),
        bmc_mac_address="00:11:22:33:44:55",
        boot_mac_address="00:11:22:33:44:56",
        machine_details="test",
        machine_name=name,
        machine_sku_id="sku-1",
        rack_id=f"/subscriptions/s/resourceGroups/rg/providers/Microsoft.NetworkCloud/racks/{rack}",
        rack_slot=slot,
        serial_number="SN123",
    )
    for key, value in overrides.items():
        setattr(props, key, value)
    machine = m.BareMetalMachine(
        location="eastus",
        extended_location=m.ExtendedLocation(name="el", type="CustomLocation"),
        properties=props,
    )
    machine.id = ("/subscriptions/s/resourceGroups/rg-nexus-prod/providers/"
                  f"Microsoft.NetworkCloud/bareMetalMachines/{name}")
    machine.name = name
    return machine


def test_prop_reads_nested_properties():
    machine = build(ready_state="True", power_state="On")
    assert nc.prop(machine, "machine_name") == "bmm-r03-s04"
    assert nc.prop(machine, "power_state") == "On"
    assert nc.prop(machine, "missing_field", "fallback") == "fallback"


def test_rack_and_slot_parsing():
    machine = build(rack="rack-07", slot=11)
    assert nc.rack_name(machine) == "rack-07"
    assert nc.rack_slot(machine) == 11


def test_machine_name_falls_back_to_resource_name():
    machine = build()
    machine.properties.machine_name = None
    assert nc.machine_name(machine) == "bmm-r03-s04"


def test_healthy_machine_has_no_problems():
    machine = build(ready_state="True", power_state="On",
                    cordon_status="Uncordoned", detailed_status="Available")
    assert nc.health_summary(machine) == []
    assert nc.is_healthy(machine) is True


def test_each_unhealthy_state_is_reported():
    healthy = {"ready_state": "True", "power_state": "On",
               "cordon_status": "Uncordoned", "detailed_status": "Available"}
    cases = {
        "readyState": {**healthy, "ready_state": "False"},
        "powerState": {**healthy, "power_state": "Off"},
        "cordoned": {**healthy, "cordon_status": "Cordoned"},
        "detailedStatus": {**healthy, "detailed_status": "Error"},
    }
    for expected, state in cases.items():
        machine = build(**state)
        problems = nc.health_summary(machine)
        assert problems, f"{expected}: expected a problem, got none"
        assert any(expected in p for p in problems), f"{expected} not in {problems}"
        assert nc.is_healthy(machine) is False


def test_workload_count():
    machine = build(virtual_machines_associated_ids=["/vm/1", "/vm/2"])
    assert nc.workload_count(machine) == 2
    assert nc.workload_count(build()) == 0


def test_hardware_validation_failure_is_a_problem():
    machine = build(ready_state="True", power_state="On", cordon_status="Uncordoned",
                    detailed_status="Available",
                    hardware_validation_status=m.HardwareValidationStatus())
    machine.properties.hardware_validation_status.result = "Fail"
    problems = nc.health_summary(machine)
    assert any("hardwareValidation" in p for p in problems), problems


def test_machine_rg_extracted_from_arm_id():
    assert nc.machine_rg(build()) == "rg-nexus-prod"


def test_enum_values_match_the_sdk():
    """Our string comparisons must match the SDK's actual enum values."""
    assert nc.POWERED_ON in [e.value for e in m.BareMetalMachinePowerState]
    assert nc.POWERED_OFF in [e.value for e in m.BareMetalMachinePowerState]
    assert {e.value for e in m.BareMetalMachineReadyState} >= nc.HEALTHY_READY_STATES
    assert {e.value for e in m.BareMetalMachineDetailedStatus} >= nc.HEALTHY_DETAILED_STATUS
