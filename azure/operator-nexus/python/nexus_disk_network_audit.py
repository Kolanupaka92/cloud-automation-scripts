#!/usr/bin/env python3
"""Disk and network health audit for Operator Nexus bare metal machines.

Two sources are combined so the report reflects both what the platform believes
and what the hardware reports:

  * Control-plane view — storage appliance state and capacity, BMM detailed
    status, hardware validation results.
  * On-machine view — read-only commands executed through the Network Cloud RP
    (``begin_run_read_commands``), which is the only sanctioned way to inspect a
    BMM without an SSH path into the rack. Only allow-listed read commands are
    accepted by the platform, so this cannot mutate a machine.

Checks
------
    disk     failed/degraded physical drives, RAID/virtual disk state, SMART
             pre-failure indicators, filesystem utilisation on the host
    network  interface link state and speed, bond/LACP member health, dropped
             and errored packet counters, MTU consistency
    storage  Nexus storage appliance status and remaining capacity

Output is designed to paste straight into a maintenance ticket.

Examples
--------
    ./nexus_disk_network_audit.py --rack rack-03
    ./nexus_disk_network_audit.py --machine bmm-r03-s04 --check disk --format json
    ./nexus_disk_network_audit.py --control-plane-only    # no on-machine commands
"""

from __future__ import annotations

import re

from nexus_common import (
    LOG,
    base_parser,
    client,
    list_machines,
    machine_name,
    machine_rg,
    prop,
    rack_name,
    render,
    run_read_commands,
    setup_logging,
    text,
)

COLUMNS = ("severity", "machine", "rack", "check", "subject", "finding")

SEVERITY_ORDER = {"CRITICAL": 0, "WARN": 1, "INFO": 2}

# Read-only commands the Network Cloud RP accepts on a BMM. Each entry maps to a
# parser below; anything the platform rejects is reported, not retried.
DISK_COMMANDS = [
    {"command": "hardware_support_data_collection", "arguments": []},
    {"command": "mdadm_status", "arguments": []},
]
NETWORK_COMMANDS = [
    {"command": "network_interface_status", "arguments": []},
    {"command": "ping", "arguments": ["-c", "3"]},
]


def finding(severity, machine, rack, check, subject, text) -> dict:
    return {
        "severity": severity,
        "machine": machine,
        "rack": rack,
        "check": check,
        "subject": subject,
        "finding": text,
    }


def audit_control_plane(machine) -> list[dict]:
    """Everything derivable from the BMM resource itself — always available."""
    name = machine_name(machine)
    rack = rack_name(machine)
    rows = []

    hardware = prop(machine, "hardware_validation_status")
    if hardware is not None:
        result = getattr(hardware, "result", None)
        if result and result != "Pass":
            rows.append(finding(
                "CRITICAL", name, rack, "hardware", "validation",
                f"hardware validation result is {result} "
                f"(last run {getattr(hardware, 'last_validation_time', 'unknown')})",
            ))

    status = text(prop(machine, "detailed_status", ""))
    if status not in ("Available", "Provisioned"):
        rows.append(finding(
            "CRITICAL", name, rack, "platform", "detailedStatus",
            f"{status}: {prop(machine, 'detailed_status_message', 'no message')}",
        ))

    if text(prop(machine, "ready_state")) != "True":
        rows.append(finding(
            "CRITICAL", name, rack, "platform", "readyState",
            f"readyState={text(prop(machine, 'ready_state'))}",
        ))

    if text(prop(machine, "power_state", "")) != "On":
        rows.append(finding(
            "WARN", name, rack, "platform", "powerState",
            f"powerState={text(prop(machine, 'power_state'))}",
        ))

    if text(prop(machine, "cordon_status", "Uncordoned")) != "Uncordoned":
        rows.append(finding(
            "WARN", name, rack, "platform", "cordonStatus",
            "machine is cordoned — check whether a maintenance window was left open",
        ))
    return rows


def audit_storage_appliances(nc, args) -> list[dict]:
    rows = []
    try:
        if args.resource_group:
            appliances = list(nc.storage_appliances.list_by_resource_group(args.resource_group))
        else:
            appliances = list(nc.storage_appliances.list_by_subscription())
    except Exception as exc:  # noqa: BLE001 - permissions vary by role
        LOG.warning("storage appliance list unavailable: %s", exc)
        return rows

    for appliance in appliances:
        name = appliance.name
        rack = (prop(appliance, "rack_id") or "-").rstrip("/").split("/")[-1]
        status = text(prop(appliance, "detailed_status", ""))
        if status not in ("Available", "Provisioned"):
            rows.append(finding(
                "CRITICAL", name, rack, "storage", "appliance",
                f"detailedStatus={status}: "
                f"{prop(appliance, 'detailed_status_message', 'no message')}",
            ))
        capacity = prop(appliance, "remote_vendor_management_status")
        if capacity and str(capacity) != "Enabled":
            rows.append(finding(
                "WARN", name, rack, "storage", "vendor-management",
                f"remote vendor management is {text(capacity)}",
            ))
        total = prop(appliance, "capacity")
        used = prop(appliance, "capacity_used")
        if total and used:
            pct = round(used / total * 100, 1)
            severity = "CRITICAL" if pct >= 90 else "WARN" if pct >= 80 else "INFO"
            rows.append(finding(
                severity, name, rack, "storage", "capacity",
                f"{pct}% used ({used}/{total} GB)",
            ))
    return rows


def parse_disk_output(output: str, name: str, rack: str) -> list[dict]:
    """Extract disk problems from the collected hardware/mdadm output."""
    rows = []
    lowered = output.lower()

    for pattern, severity, label in (
        (r"\b(failed|failure predicted|predictive failure)\b", "CRITICAL", "drive failure"),
        (r"\b(degraded|rebuilding|resync)\b", "CRITICAL", "array degraded"),
        (r"\bforeign\b", "WARN", "foreign configuration"),
        (r"\bsmart.{0,40}\b(fail|threshold exceeded)\b", "CRITICAL", "SMART pre-failure"),
        (r"\bmedia errors?\s*[:=]\s*[1-9]", "WARN", "media errors present"),
    ):
        for match in re.finditer(pattern, lowered):
            line = output[max(0, match.start() - 80): match.end() + 80].replace("\n", " ").strip()
            rows.append(finding("CRITICAL" if severity == "CRITICAL" else "WARN",
                                name, rack, "disk", label, line[:160]))
            break  # one finding per pattern; the full output goes in the ticket

    # Filesystem utilisation lines look like: /dev/sda1  100G  92G  8G  92% /
    for match in re.finditer(r"(\S+)\s+[\d.]+[GTM]\s+[\d.]+[GTM]\s+[\d.]+[GTM]\s+(\d+)%\s+(\S+)", output):
        pct = int(match.group(2))
        if pct >= 85:
            rows.append(finding(
                "CRITICAL" if pct >= 90 else "WARN", name, rack, "disk", match.group(3),
                f"filesystem {pct}% full on {match.group(1)}",
            ))
    return rows


def parse_network_output(output: str, name: str, rack: str) -> list[dict]:
    """Extract link, bond and error-counter problems from interface output."""
    rows = []

    for match in re.finditer(r"^(\S+):.*state (DOWN|LOWERLAYERDOWN)", output, re.MULTILINE):
        rows.append(finding("CRITICAL", name, rack, "network", match.group(1),
                            f"interface state {match.group(2)}"))

    for match in re.finditer(r"MII Status:\s*down", output, re.IGNORECASE):
        context = output[max(0, match.start() - 200): match.start()]
        slave = re.findall(r"Slave Interface:\s*(\S+)", context)
        rows.append(finding("CRITICAL", name, rack, "network",
                            slave[-1] if slave else "bond",
                            "bond member link is down"))

    for label, pattern in (("rx errors", r"RX errors?\s+(\d+)"),
                           ("tx errors", r"TX errors?\s+(\d+)"),
                           ("rx dropped", r"RX .*dropped\s+(\d+)"),
                           ("tx dropped", r"TX .*dropped\s+(\d+)")):
        for match in re.finditer(pattern, output):
            count = int(match.group(1))
            if count > 0:
                rows.append(finding("WARN" if count < 1000 else "CRITICAL",
                                    name, rack, "network", label,
                                    f"{count} {label} since boot"))
                break

    mtus = set(re.findall(r"mtu (\d+)", output))
    if len(mtus) > 2:  # loopback plus one data MTU is normal
        rows.append(finding("WARN", name, rack, "network", "mtu",
                            f"inconsistent MTUs across interfaces: {', '.join(sorted(mtus))}"))

    if re.search(r"100% packet loss", output):
        rows.append(finding("CRITICAL", name, rack, "network", "reachability",
                            "100% packet loss on the connectivity probe"))
    return rows


def audit_on_machine(nc, machine, checks: list[str], timeout: int) -> list[dict]:
    name = machine_name(machine)
    rack = rack_name(machine)
    rg = machine_rg(machine)
    rows = []

    if text(prop(machine, "power_state", "")) != "On":
        return [finding("WARN", name, rack, "platform", "run-read-commands",
                        "machine is powered off; on-machine checks skipped")]

    commands = []
    if "disk" in checks:
        commands.extend(DISK_COMMANDS)
    if "network" in checks:
        commands.extend(NETWORK_COMMANDS)
    if not commands:
        return rows

    LOG.info("  running %d read command(s) on %s", len(commands), name)
    result = run_read_commands(nc, rg, name, commands, timeout)
    if result is None:
        return [finding("WARN", name, rack, "platform", "run-read-commands",
                        "command execution failed or was not permitted")]

    # The RP returns a URL to the collected output rather than inline text.
    output_url = getattr(result, "result_url", None) or getattr(result, "resultUrl", None)
    output = getattr(result, "result_text", None) or ""

    if not output and output_url:
        rows.append(finding("INFO", name, rack, "platform", "run-read-commands",
                            f"output written to the cluster storage account: {output_url}"))
        return rows

    if "disk" in checks:
        rows.extend(parse_disk_output(output, name, rack))
    if "network" in checks:
        rows.extend(parse_network_output(output, name, rack))

    if not rows:
        rows.append(finding("INFO", name, rack, "on-machine", "-",
                            "no disk or network problems detected on the machine"))
    return rows


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument(
        "--check", action="append", choices=("disk", "network", "storage"),
        help="limit to specific checks (repeatable; default: all)",
    )
    parser.add_argument(
        "--control-plane-only", action="store_true",
        help="skip on-machine read commands; use only the resource-provider view",
    )
    parser.add_argument(
        "--min-severity", choices=tuple(SEVERITY_ORDER), default="INFO",
        help="suppress findings below this severity",
    )
    parser.add_argument(
        "--command-timeout", type=int, default=600,
        help="seconds allowed for on-machine read commands",
    )
    parser.add_argument(
        "--fail-on-findings", action="store_true",
        help="exit non-zero when any CRITICAL finding is reported",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    checks = args.check or ["disk", "network", "storage"]
    nc = client(args.subscription)
    machines = list_machines(nc, args)
    if not machines:
        LOG.error("no bare metal machines matched the given scope")
        return 2

    rows: list[dict] = []
    for machine in machines:
        LOG.info("auditing %s", machine_name(machine))
        rows.extend(audit_control_plane(machine))
        if not args.control_plane_only:
            rows.extend(audit_on_machine(nc, machine, checks, args.command_timeout))

    if "storage" in checks:
        rows.extend(audit_storage_appliances(nc, args))

    cutoff = SEVERITY_ORDER[args.min_severity]
    rows = [r for r in rows if SEVERITY_ORDER[r["severity"]] <= cutoff]
    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["machine"], r["check"]))

    render(rows, COLUMNS, args.format)

    criticals = [r for r in rows if r["severity"] == "CRITICAL"]
    if args.format == "table":
        print(f"\n{len(machines)} machine(s) audited, {len(criticals)} critical finding(s), "
              f"{len([r for r in rows if r['severity'] == 'WARN'])} warning(s)")

    if args.fail_on_findings and criticals:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
