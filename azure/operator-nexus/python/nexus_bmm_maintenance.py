#!/usr/bin/env python3
"""Quarterly maintenance driver for Operator Nexus bare metal machines.

Automates the loop that is otherwise done by hand, one machine at a time, for
hours: cordon, power off, wait for the hardware work, power back on, wait for
the machine to rejoin as Ready, uncordon, verify.

    ./nexus_bmm_maintenance.py --rack rack-03 --change CHG0041827 --dry-run
    ./nexus_bmm_maintenance.py --machine bmm-r03-s04 --change CHG0041827
    ./nexus_bmm_maintenance.py --rack rack-03 --change CHG0041827 --phase shutdown
    ./nexus_bmm_maintenance.py --rack rack-03 --change CHG0041827 --phase restore
    ./nexus_bmm_maintenance.py --resume state/CHG0041827.json

Safety properties that make this runnable in a production window:

  * One machine at a time. A rack is never drained below --min-healthy-per-rack,
    checked again immediately before every single power-off.
  * Cordon evacuates tenant workloads first (``--no-evacuate`` opts out for
    machines with no tenant VMs).
  * Every state transition is polled to completion with a timeout; the script
    never assumes an operation landed.
  * Progress is journalled to a state file after every step, so an interrupted
    window resumes with --resume instead of restarting.
  * --phase shutdown / restore splits the run across a hardware team's window:
    take the machines down, hand over, bring them back later.

Nothing here replaces a BMM (``begin_replace``) or reimages anything — those are
deliberately out of scope for an automated loop.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

from nexus_common import (
    LOG,
    base_parser,
    client,
    confirm,
    health_summary,
    list_machines,
    machine_rg,
    rack_name,
    rack_slot,
    render,
    setup_logging,
    workload_count,
)

try:
    from azure.core.exceptions import HttpResponseError
    from azure.mgmt.networkcloud.models import (
        BareMetalMachineCordonParameters,
        BareMetalMachinePowerOffParameters,
    )
except ImportError:  # pragma: no cover
    raise SystemExit("pip install -r requirements.txt")

COLUMNS = ("machine", "rack", "slot", "power", "cordon", "tenant_vms", "step", "result")

STEPS = ("cordon", "power_off", "power_on", "wait_ready", "uncordon", "verify")


class MaintenanceState:
    """Journal of what has already been done, so a window can be resumed."""

    def __init__(self, path: Path, change: str):
        self.path = path
        self.data = {
            "change": change,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "machines": {},
        }
        if path.exists():
            self.data = json.loads(path.read_text())
            LOG.info("resuming %s from %s", self.data.get("change"), path)

    def completed(self, machine: str, step: str) -> bool:
        return step in self.data["machines"].get(machine, {}).get("completed", [])

    def record(self, machine: str, step: str, result: str) -> None:
        entry = self.data["machines"].setdefault(machine, {"completed": [], "log": []})
        if result == "ok" and step not in entry["completed"]:
            entry["completed"].append(step)
        entry["log"].append({
            "step": step,
            "result": result,
            "at": datetime.now(timezone.utc).isoformat(),
        })
        self.flush()

    def flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2))


def refresh(nc, resource_group: str, name: str):
    return nc.bare_metal_machines.get(resource_group, name)


def wait_for(nc, resource_group: str, name: str, predicate, description: str,
             timeout: int, interval: int) -> bool:
    """Poll a machine until predicate(machine) is true or the timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        machine = refresh(nc, resource_group, name)
        if predicate(machine):
            LOG.info("    %s: %s", name, description)
            return True
        LOG.debug(
            "    %s: waiting (%s, power=%s, ready=%s)",
            name, machine.detailed_status, machine.power_state, machine.ready_state,
        )
        time.sleep(interval)
    LOG.error("    %s: timed out waiting for %s after %ss", name, description, timeout)
    return False


def rack_has_headroom(nc, args, target_machine_name: str) -> bool:
    """Re-check, immediately before power-off, that the rack can spare a machine."""
    peers = list_machines(nc, args)
    target_rack = None
    for machine in peers:
        if (machine.machine_name or machine.name) == target_machine_name:
            target_rack = rack_name(machine)
            break
    if target_rack is None:
        return False

    in_rack = [m for m in peers if rack_name(m) == target_rack]
    healthy_others = [
        m for m in in_rack
        if (m.machine_name or m.name) != target_machine_name and not health_summary(m)
    ]
    ok = len(healthy_others) >= args.min_healthy_per_rack
    if not ok:
        LOG.error(
            "    rack %s would drop to %d healthy machine(s), below the floor of %d",
            target_rack, len(healthy_others), args.min_healthy_per_rack,
        )
    return ok


def do_cordon(nc, rg, name, args, evacuate: bool) -> bool:
    params = BareMetalMachineCordonParameters(evacuate="True" if evacuate else "False")
    LOG.info("    cordoning %s (evacuate=%s)", name, evacuate)
    nc.bare_metal_machines.begin_cordon(rg, name, cordon_parameters=params).result()
    return wait_for(
        nc, rg, name,
        lambda m: (m.cordon_status or "") == "Cordoned",
        "cordoned", args.cordon_timeout, args.poll,
    )


def do_uncordon(nc, rg, name, args) -> bool:
    LOG.info("    uncordoning %s", name)
    nc.bare_metal_machines.begin_uncordon(rg, name).result()
    return wait_for(
        nc, rg, name,
        lambda m: (m.cordon_status or "Uncordoned") == "Uncordoned",
        "uncordoned", args.cordon_timeout, args.poll,
    )


def do_power_off(nc, rg, name, args) -> bool:
    params = BareMetalMachinePowerOffParameters(
        skip_shutdown="True" if args.skip_shutdown else "False"
    )
    LOG.info("    powering off %s (graceful=%s)", name, not args.skip_shutdown)
    nc.bare_metal_machines.begin_power_off(rg, name, bare_metal_machine_power_off_parameters=params).result()
    return wait_for(
        nc, rg, name,
        lambda m: (m.power_state or "") == "Off",
        "powered off", args.power_timeout, args.poll,
    )


def do_power_on(nc, rg, name, args) -> bool:
    LOG.info("    starting %s", name)
    nc.bare_metal_machines.begin_start(rg, name).result()
    return wait_for(
        nc, rg, name,
        lambda m: (m.power_state or "") == "On",
        "powered on", args.power_timeout, args.poll,
    )


def do_wait_ready(nc, rg, name, args) -> bool:
    LOG.info("    waiting for %s to rejoin the cluster", name)
    return wait_for(
        nc, rg, name,
        lambda m: str(m.ready_state) == "True" and (m.detailed_status or "") in
                  ("Available", "Provisioned"),
        "ready and available", args.ready_timeout, args.poll,
    )


def do_verify(nc, rg, name, args) -> bool:
    machine = refresh(nc, rg, name)
    problems = health_summary(machine)
    if problems:
        LOG.error("    %s post-maintenance problems: %s", name, "; ".join(problems))
        return False
    LOG.info("    %s verified healthy", name)
    return True


def maintain_machine(nc, machine, args, state: MaintenanceState) -> dict:
    name = machine.machine_name or machine.name
    rg = machine_rg(machine)
    tenant_vms = workload_count(machine)

    row = {
        "machine": name,
        "rack": rack_name(machine),
        "slot": rack_slot(machine),
        "power": machine.power_state,
        "cordon": machine.cordon_status or "Uncordoned",
        "tenant_vms": tenant_vms,
        "step": "-",
        "result": "-",
    }

    phases = {
        "shutdown": ["cordon", "power_off"],
        "restore": ["power_on", "wait_ready", "uncordon", "verify"],
        "full": list(STEPS),
    }[args.phase]

    if args.dry_run:
        row["step"] = " -> ".join(phases)
        row["result"] = "dry-run"
        LOG.info("  dry-run %s (rack %s slot %s, %d tenant VM(s)): would %s",
                 name, row["rack"], row["slot"], tenant_vms, " -> ".join(phases))
        return row

    for step in phases:
        if state.completed(name, step):
            LOG.info("  %s: %s already completed, skipping", name, step)
            continue

        row["step"] = step
        LOG.info("  %s: %s", name, step)

        try:
            if step == "cordon":
                ok = do_cordon(nc, rg, name, args, evacuate=(tenant_vms > 0 and not args.no_evacuate))
            elif step == "power_off":
                if not rack_has_headroom(nc, args, name):
                    state.record(name, step, "blocked-no-headroom")
                    row["result"] = "blocked: rack headroom"
                    return row
                ok = do_power_off(nc, rg, name, args)
            elif step == "power_on":
                ok = do_power_on(nc, rg, name, args)
            elif step == "wait_ready":
                ok = do_wait_ready(nc, rg, name, args)
            elif step == "uncordon":
                ok = do_uncordon(nc, rg, name, args)
            else:
                ok = do_verify(nc, rg, name, args)
        except HttpResponseError as exc:
            LOG.error("  %s: %s failed: %s", name, step, exc.message or exc)
            state.record(name, step, "error")
            row["result"] = f"failed at {step}"
            return row

        state.record(name, step, "ok" if ok else "failed")
        if not ok:
            row["result"] = f"failed at {step}"
            return row

        if step == "power_off" and args.hold_seconds:
            LOG.info("  %s: holding powered off for %ds (hardware work window)",
                     name, args.hold_seconds)
            time.sleep(args.hold_seconds)

    row["result"] = "ok"
    row["step"] = "complete"
    return row


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--change", help="change record id, used for the state file name")
    parser.add_argument(
        "--phase", choices=("full", "shutdown", "restore"), default="full",
        help="run the whole cycle, or only take machines down / bring them back",
    )
    parser.add_argument(
        "--min-healthy-per-rack", type=int, default=3,
        help="healthy machines a rack must retain at all times",
    )
    parser.add_argument(
        "--hold-seconds", type=int, default=0,
        help="seconds to stay powered off before restoring (full phase only)",
    )
    parser.add_argument(
        "--skip-shutdown", action="store_true",
        help="hard power-off instead of a graceful OS shutdown (use only when hung)",
    )
    parser.add_argument(
        "--no-evacuate", action="store_true",
        help="cordon without evacuating tenant workloads",
    )
    parser.add_argument("--power-timeout", type=int, default=1800, help="power state timeout")
    parser.add_argument("--cordon-timeout", type=int, default=1800, help="cordon timeout")
    parser.add_argument("--ready-timeout", type=int, default=3600, help="rejoin timeout")
    parser.add_argument("--poll", type=int, default=30, help="poll interval in seconds")
    parser.add_argument("--resume", help="path to an existing state file to resume")
    parser.add_argument(
        "--state-dir", default="state", help="directory for maintenance state files"
    )
    parser.add_argument(
        "--keep-going", action="store_true",
        help="continue with the remaining machines after one fails (default: stop)",
    )
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()
    setup_logging(args.verbose)

    if not args.change and not args.resume:
        parser.error("pass --change CHG####### (or --resume a previous state file)")

    nc = client(args.subscription)
    machines = list_machines(nc, args)
    if not machines:
        LOG.error("no bare metal machines matched the given scope")
        return 2

    if not (args.machine or args.rack):
        LOG.error(
            "refusing to run against every machine in scope; "
            "pass --rack or --machine to bound the blast radius"
        )
        return 2

    state_path = Path(args.resume) if args.resume else Path(args.state_dir) / f"{args.change}.json"
    state = MaintenanceState(state_path, args.change or state_path.stem)

    LOG.info(
        "%s: %d machine(s) in scope, phase=%s, rack floor=%d",
        state.data["change"], len(machines), args.phase, args.min_healthy_per_rack,
    )
    for machine in machines:
        LOG.info(
            "  %s (rack %s slot %s) power=%s cordon=%s tenantVMs=%d",
            machine.machine_name or machine.name, rack_name(machine), rack_slot(machine),
            machine.power_state, machine.cordon_status or "Uncordoned", workload_count(machine),
        )

    if not args.dry_run and not confirm(
        f"Run '{args.phase}' maintenance on {len(machines)} machine(s)?", args.yes
    ):
        LOG.info("aborted")
        return 1

    rows = []
    for machine in machines:
        rows.append(maintain_machine(nc, machine, args, state))
        if rows[-1]["result"].startswith(("failed", "blocked")) and not args.keep_going:
            LOG.error("stopping: %s did not complete cleanly", rows[-1]["machine"])
            break

    render(rows, COLUMNS, args.format)
    LOG.info("state journal: %s", state_path)

    failed = [r for r in rows if r["result"] not in ("ok", "dry-run")]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
