"""Shared helpers for the Azure Operator Nexus automation scripts.

Operator Nexus exposes bare metal machines (BMMs), racks, storage appliances and
Nexus Kubernetes clusters through the Network Cloud resource provider, so every
script here talks to ``NetworkCloudMgmtClient`` rather than the classic compute
provider.

Conventions shared by all Nexus scripts:

    --subscription / --resource-group   scope
    --cluster                           restrict to one Nexus cluster
    --rack                              restrict to one rack
    --dry-run                           print intended actions, change nothing
    --format table|json                 output format

Read operations need Reader on the cluster resource group. Power and cordon
operations need a role that grants the Network Cloud action set — typically a
custom "Nexus Maintenance Operator" role rather than a broad Contributor grant.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import Any, Sequence

try:
    from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
    from azure.identity import DefaultAzureCredential
    from azure.mgmt.networkcloud import NetworkCloudMgmtClient
except ImportError:  # pragma: no cover - dependency guard
    sys.exit(
        "azure-mgmt-networkcloud is not installed. "
        "Run: pip install -r requirements.txt"
    )

LOG = logging.getLogger("nexus")

# readyState / detailedStatus values that mean the machine is genuinely healthy.
HEALTHY_READY_STATES = {"True"}
HEALTHY_DETAILED_STATUS = {"Available", "Provisioned"}
POWERED_ON = "On"
POWERED_OFF = "Off"


def base_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=description,
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--subscription",
        default=os.environ.get("AZURE_SUBSCRIPTION_ID"),
        help="subscription id holding the Nexus cluster",
    )
    parser.add_argument(
        "--resource-group",
        default=os.environ.get("NEXUS_RESOURCE_GROUP"),
        help="resource group holding the bare metal machines",
    )
    parser.add_argument("--cluster", help="restrict to one Nexus cluster name")
    parser.add_argument("--rack", help="restrict to one rack (matches rackId or rack name)")
    parser.add_argument(
        "--machine",
        action="append",
        help="restrict to specific BMM names (repeatable)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report intended actions without changing anything",
    )
    parser.add_argument(
        "--format", choices=("table", "json"), default="table", help="output format"
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )
    logging.getLogger("azure").setLevel(logging.WARNING)
    logging.getLogger("azure.identity").setLevel(logging.ERROR)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def client(subscription: str | None) -> NetworkCloudMgmtClient:
    if not subscription:
        sys.exit(
            "No subscription specified. Pass --subscription or set AZURE_SUBSCRIPTION_ID."
        )
    return NetworkCloudMgmtClient(DefaultAzureCredential(), subscription)


def list_machines(nc: NetworkCloudMgmtClient, args) -> list:
    """Return the BMMs in scope, sorted by rack then slot so output is stable."""
    try:
        if args.resource_group:
            machines = list(nc.bare_metal_machines.list_by_resource_group(args.resource_group))
        else:
            machines = list(nc.bare_metal_machines.list_by_subscription())
    except HttpResponseError as exc:
        sys.exit(f"Failed to list bare metal machines: {exc.message or exc}")

    if args.cluster:
        machines = [m for m in machines if (m.cluster_id or "").rstrip("/").split("/")[-1] == args.cluster]
    if args.rack:
        machines = [
            m for m in machines
            if args.rack.lower() in (m.rack_id or "").lower()
        ]
    if args.machine:
        wanted = {name.lower() for name in args.machine}
        machines = [m for m in machines if (m.machine_name or m.name or "").lower() in wanted]

    machines.sort(key=lambda m: (rack_name(m), rack_slot(m)))
    return machines


def rack_name(machine) -> str:
    return (machine.rack_id or "-").rstrip("/").split("/")[-1]


def rack_slot(machine) -> int:
    try:
        return int(machine.rack_slot)
    except (TypeError, ValueError):
        return 0


def machine_rg(machine) -> str:
    parts = (machine.id or "").split("/")
    try:
        return parts[parts.index("resourceGroups") + 1]
    except (ValueError, IndexError):
        return "-"


def is_healthy(machine) -> bool:
    return (
        str(machine.ready_state) in HEALTHY_READY_STATES
        and (machine.detailed_status or "") in HEALTHY_DETAILED_STATUS
        and (machine.power_state or "") == POWERED_ON
        and (machine.cordon_status or "Uncordoned") == "Uncordoned"
    )


def health_summary(machine) -> list[str]:
    """Human-readable reasons a machine is not fully healthy (empty when it is)."""
    problems = []
    if str(machine.ready_state) not in HEALTHY_READY_STATES:
        problems.append(f"readyState={machine.ready_state}")
    if (machine.detailed_status or "") not in HEALTHY_DETAILED_STATUS:
        detail = machine.detailed_status_message or "no message"
        problems.append(f"detailedStatus={machine.detailed_status} ({detail})")
    if (machine.power_state or "") != POWERED_ON:
        problems.append(f"powerState={machine.power_state}")
    if (machine.cordon_status or "Uncordoned") != "Uncordoned":
        problems.append("cordoned")
    hardware = getattr(machine, "hardware_validation_status", None)
    if hardware and getattr(hardware, "result", None) not in (None, "Pass"):
        problems.append(f"hardwareValidation={hardware.result}")
    return problems


def workload_count(machine) -> int:
    """Tenant VMs currently hosted on this BMM."""
    return len(getattr(machine, "virtual_machines_associated_ids", None) or [])


def run_read_commands(nc, resource_group: str, machine_name: str, commands, timeout: int = 600):
    """Execute allow-listed read-only commands on a BMM via the Nexus RP.

    Only commands on the Operator Nexus read-only allow list are accepted by the
    platform; anything mutating is rejected server-side, which is exactly the
    guarantee we want for a health check.
    """
    from azure.mgmt.networkcloud.models import (
        BareMetalMachineCommandSpecification,
        BareMetalMachineRunReadCommandsParameters,
    )

    specs = [
        BareMetalMachineCommandSpecification(
            command=cmd["command"], arguments=cmd.get("arguments", [])
        )
        for cmd in commands
    ]
    params = BareMetalMachineRunReadCommandsParameters(
        commands=specs, limit_time_seconds=timeout
    )
    try:
        poller = nc.bare_metal_machines.begin_run_read_commands(
            resource_group, machine_name, params
        )
        return poller.result()
    except (HttpResponseError, ResourceNotFoundError) as exc:
        LOG.error("run-read-commands failed on %s: %s", machine_name, exc.message or exc)
        return None


def render(rows: Sequence[dict[str, Any]], columns: Sequence[str], fmt: str) -> None:
    if fmt == "json":
        print(json.dumps(list(rows), indent=2, default=str))
        return
    if not rows:
        print("(no results)")
        return

    widths = {c: len(c) for c in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))

    print("  ".join(c.upper().ljust(widths[c]) for c in columns))
    print("  ".join("-" * widths[c] for c in columns))
    for row in rows:
        print("  ".join(str(row.get(c, "")).ljust(widths[c]) for c in columns))
    print(f"\n{len(rows)} row(s)")


def confirm(prompt: str, assume_yes: bool = False) -> bool:
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        LOG.error("refusing to proceed without a TTY; pass --yes to override")
        return False
    return input(f"{prompt} [y/N] ").strip().lower() in ("y", "yes")
