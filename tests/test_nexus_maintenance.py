# Author: Sai Kolanupaka
"""Rack headroom and cordon ordering, against real SDK model objects."""
import pathlib
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "azure/operator-nexus/python"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import nexus_bmm_maintenance as maint
import pytest
from test_nexus_logic import build

HEALTHY = {"ready_state": "True", "power_state": "On",
           "cordon_status": "Uncordoned", "detailed_status": "Available"}


class Fleet:
    """Applies power and cordon calls to the models, as the platform would."""

    def __init__(self, machines):
        self.machines = {m.name: m for m in machines}
        self.calls = []
        self.on_cordon = lambda: None
        self.bare_metal_machines = self

    def list_by_resource_group(self, rg):
        return list(self.machines.values())

    list_by_subscription = lambda self: list(self.machines.values())  # noqa: E731

    def get(self, rg, name):
        return self.machines[name]

    def _do(self, call, name, **fields):
        self.calls.append((call, name))
        for key, value in fields.items():
            setattr(self.machines[name].properties, key, value)
        return NS(result=lambda: None)

    def begin_cordon(self, rg, name, **kw):
        self.on_cordon()
        return self._do("cordon", name, cordon_status="Cordoned")

    def begin_uncordon(self, rg, name):
        return self._do("uncordon", name, cordon_status="Uncordoned")

    def begin_power_off(self, rg, name, **kw):
        return self._do("power_off", name, power_state="Off")


def args(**kw):
    defaults = {"resource_group": "rg", "cluster": None, "rack": None, "machine": None,
                "min_healthy_per_rack": 3, "phase": "shutdown", "dry_run": False,
                "no_evacuate": False, "skip_shutdown": False, "hold_seconds": 0,
                "cordon_timeout": 1, "power_timeout": 1, "poll": 0}
    return NS(**{**defaults, **kw})


def fleet(size, rack="rack-03"):
    return Fleet([build(name=f"bmm-{i}", slot=i, rack=rack, **HEALTHY) for i in range(size)])


@pytest.fixture
def state(tmp_path):
    return maint.MaintenanceState(tmp_path / "s.json", "CHG1")


@pytest.mark.parametrize("scope", [{"machine": ["bmm-0"]}, {"rack": "rack-03"}])
def test_selection_does_not_shrink_the_rack(scope, state):
    nc = fleet(4)
    row = maint.maintain_machine(nc, nc.machines["bmm-0"], args(**scope), state)
    assert row["result"] == "ok"
    assert nc.calls == [("cordon", "bmm-0"), ("power_off", "bmm-0")]


def test_other_racks_do_not_count_as_peers(state):
    nc = fleet(3)
    for i in range(5):
        other = build(name=f"x-{i}", rack="rack-030", **HEALTHY)
        nc.machines[other.name] = other
    row = maint.maintain_machine(nc, nc.machines["bmm-0"], args(machine=["bmm-0"]), state)
    assert row["result"] == "blocked: rack headroom"


def test_thin_rack_is_blocked_before_any_eviction(state):
    nc = fleet(3)
    row = maint.maintain_machine(nc, nc.machines["bmm-0"], args(), state)
    assert row["result"] == "blocked: rack headroom"
    assert nc.calls == []


def lose_peer(nc):
    nc.machines["bmm-1"].properties.ready_state = "False"


def test_peer_lost_during_eviction_returns_the_machine(state):
    nc = fleet(4)
    nc.on_cordon = lambda: lose_peer(nc)
    row = maint.maintain_machine(nc, nc.machines["bmm-0"], args(), state)
    assert row["result"] == "blocked: rack headroom"
    assert nc.calls == [("cordon", "bmm-0"), ("uncordon", "bmm-0")]
    assert not state.completed("bmm-0", "cordon")       # a resume must cordon again


def test_a_cordon_from_before_the_window_is_left_alone(state):
    nc = fleet(4)
    nc.machines["bmm-0"].properties.cordon_status = "Cordoned"
    nc.on_cordon = lambda: lose_peer(nc)
    maint.maintain_machine(nc, nc.machines["bmm-0"], args(), state)
    assert ("uncordon", "bmm-0") not in nc.calls
