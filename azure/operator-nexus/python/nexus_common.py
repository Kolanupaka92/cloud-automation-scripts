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
from collections.abc import Sequence
from typing import Any

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
        machines = [
            m for m in machines
            if text(prop(m, "cluster_id")).rstrip("/").split("/")[-1] == args.cluster
        ]
    if args.rack:
        machines = [m for m in machines if args.rack.lower() in text(prop(m, "rack_id")).lower()]
    if args.machine:
        wanted = {name.lower() for name in args.machine}
        machines = [m for m in machines if machine_name(m).lower() in wanted]

    machines.sort(key=lambda m: (rack_name(m), rack_slot(m)))
    return machines


def prop(resource, name: str, default=None):
    """Read a resource field across both SDK model generations.

    azure-mgmt-networkcloud 3.x nests every field under ``resource.properties``;
    1.x and 2.x expose them flat on the resource. Reading through this accessor
    means the scripts work with whichever version a site has pinned, instead of
    breaking silently on upgrade — every field would simply read as None.
    """
    properties = getattr(resource, "properties", None)
    if properties is not None and hasattr(properties, name):
        value = getattr(properties, name)
        if value is not None:
            return value
    value = getattr(resource, name, None)
    return default if value is None else value


def text(value, default: str = "") -> str:
    """Normalise an SDK field to a plain string.

    The Network Cloud models return ``str``-mixin enums, and ``str(enum)`` gives
    "BareMetalMachineReadyState.TRUE" rather than "True" on modern Python. The
    same field arrives as a bare string from other code paths, so every
    comparison goes through here — otherwise a healthy machine reads as
    unhealthy and a maintenance window refuses to start for no reason.
    """
    if value is None:
        return default
    return str(getattr(value, "value", value))


def rack_name(machine) -> str:
    return (text(prop(machine, "rack_id")) or "-").rstrip("/").split("/")[-1]


def rack_slot(machine) -> int:
    try:
        return int(prop(machine, "rack_slot"))
    except (TypeError, ValueError):
        return 0


def machine_name(machine) -> str:
    """The BMM's own name, falling back to the ARM resource name."""
    return text(prop(machine, "machine_name")) or getattr(machine, "name", "unknown")


def machine_rg(machine) -> str:
    parts = (machine.id or "").split("/")
    try:
        return parts[parts.index("resourceGroups") + 1]
    except (ValueError, IndexError):
        return "-"


def is_healthy(machine) -> bool:
    return not health_summary(machine)


def health_summary(machine) -> list[str]:
    """Human-readable reasons a machine is not fully healthy (empty when it is)."""
    problems = []
    ready = prop(machine, "ready_state")
    detailed = prop(machine, "detailed_status", "")
    power = prop(machine, "power_state", "")
    cordon = prop(machine, "cordon_status", "Uncordoned")

    if text(ready) not in HEALTHY_READY_STATES:
        problems.append(f"readyState={text(ready)}")
    if text(detailed) not in HEALTHY_DETAILED_STATUS:
        message = prop(machine, "detailed_status_message", "no message")
        problems.append(f"detailedStatus={text(detailed)} ({message})")
    if text(power) != POWERED_ON:
        problems.append(f"powerState={text(power)}")
    if text(cordon) != "Uncordoned":
        problems.append("cordoned")

    hardware = prop(machine, "hardware_validation_status")
    result = getattr(hardware, "result", None) if hardware is not None else None
    if result is not None and text(result) != "Pass":
        problems.append(f"hardwareValidation={text(result)}")
    return problems


def workload_count(machine) -> int:
    """Tenant VMs currently hosted on this BMM."""
    return len(prop(machine, "virtual_machines_associated_ids") or [])


def run_read_commands(nc, resource_group: str, name: str, commands, timeout: int = 600):
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
            resource_group, name, params
        )
        return poller.result()
    except (HttpResponseError, ResourceNotFoundError) as exc:
        LOG.error("run-read-commands failed on %s: %s", name, exc.message or exc)
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
