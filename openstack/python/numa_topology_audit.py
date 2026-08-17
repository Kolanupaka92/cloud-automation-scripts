#!/usr/bin/env python3
"""NUMA, CPU pinning and hugepage audit for compute nodes.

Catches the things that never alert but cost 20-30% on latency-sensitive
workloads: vCPUs pinned outside cpu_dedicated_set, a dedicated set with no
isolcpus behind it, instance memory spanning sockets, hugepages allocated on
one NUMA node only, emulator threads left unpinned, NICs with no NUMA
affinity.

Read-only. The output is evidence for a rebuild or a migration, not the fix.
"""

from __future__ import annotations

import re
import shlex
import subprocess

from common import LOG, base_parser, connect, render, setup_logging

COLUMNS = ("severity", "host", "check", "subject", "finding")

SEVERITY_ORDER = {"CRITICAL": 0, "WARN": 1, "INFO": 2}

CHECKS = ("host", "config", "instances", "nic")


def finding(severity, host, check, subject, text) -> dict:
    return {
        "severity": severity, "host": host, "check": check,
        "subject": subject, "finding": text,
    }


def ssh(host: str, command: str, user: str, timeout: int = 45) -> tuple[int, str]:
    argv = [
        "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"ConnectTimeout={min(timeout, 15)}", f"{user}@{host}", command,
    ]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        LOG.error("ssh to %s timed out", host)
        return 255, ""
    return proc.returncode, proc.stdout


def parse_numactl(output: str) -> dict[int, dict]:
    """Parse `numactl --hardware` into {node: {cpus, size_mb, free_mb}}."""
    nodes: dict[int, dict] = {}
    for match in re.finditer(r"node (\d+) cpus: ([\d ]*)", output):
        node = int(match.group(1))
        cpus = [int(c) for c in match.group(2).split()]
        nodes.setdefault(node, {})["cpus"] = cpus
    for match in re.finditer(r"node (\d+) size: (\d+) MB", output):
        nodes.setdefault(int(match.group(1)), {})["size_mb"] = int(match.group(2))
    for match in re.finditer(r"node (\d+) free: (\d+) MB", output):
        nodes.setdefault(int(match.group(1)), {})["free_mb"] = int(match.group(2))
    return nodes


def check_host_topology(host: str, user: str) -> list[dict]:
    rows = []
    rc, out = ssh(host, "numactl --hardware", user)
    if rc != 0:
        return [finding("CRITICAL", host, "host", "numactl",
                        "numactl unavailable or host unreachable")]

    nodes = parse_numactl(out)
    if len(nodes) < 2:
        rows.append(finding("INFO", host, "host", "topology",
                            f"single NUMA node ({len(nodes)}), pinning has no effect here"))
        return rows

    rows.append(finding("INFO", host, "host", "topology",
                        f"{len(nodes)} NUMA nodes, "
                        + ", ".join(f"node{n}={len(d.get('cpus', []))}cpu/"
                                    f"{d.get('size_mb', 0) // 1024}GB"
                                    for n, d in sorted(nodes.items()))))

    # Memory imbalance across nodes means one node will exhaust first and the
    # scheduler will start placing instances across sockets.
    frees = [d.get("free_mb", 0) for d in nodes.values()]
    if frees and max(frees) > 0:
        skew = (max(frees) - min(frees)) / max(frees) * 100
        if skew >= 40:
            rows.append(finding("WARN", host, "host", "memory-balance",
                                f"free memory skewed {skew:.0f}% across NUMA nodes "
                                f"({', '.join(str(f) for f in frees)} MB)"))

    # Hugepages must exist on every node, or instances land on one socket only.
    rc, hp_out = ssh(
        host,
        "for n in /sys/devices/system/node/node*/hugepages/hugepages-*/nr_hugepages; "
        "do echo \"$n $(cat $n)\"; done",
        user,
    )
    if rc == 0 and hp_out.strip():
        pools: dict[str, dict[str, int]] = {}
        for line in hp_out.splitlines():
            parts = line.split()
            if len(parts) != 2:
                continue
            node = re.search(r"node(\d+)", parts[0])
            size = re.search(r"hugepages-(\d+kB)", parts[0])
            if node and size:
                pools.setdefault(size.group(1), {})[node.group(1)] = int(parts[1])

        for size, per_node in pools.items():
            allocated = {n: c for n, c in per_node.items() if c > 0}
            if not allocated:
                continue
            if len(allocated) < len(nodes):
                rows.append(finding("CRITICAL", host, "host", f"hugepages-{size}",
                                    f"allocated on nodes {sorted(allocated)} but the host has "
                                    f"{len(nodes)} NUMA nodes, instances cannot be placed evenly"))
            elif len(set(allocated.values())) > 1:
                rows.append(finding("WARN", host, "host", f"hugepages-{size}",
                                    f"uneven pools across nodes: {allocated}"))
            else:
                rows.append(finding("INFO", host, "host", f"hugepages-{size}",
                                    f"{sum(allocated.values())} pages, evenly spread"))
    return rows


def check_nova_config(host: str, user: str) -> list[dict]:
    rows = []
    rc, out = ssh(
        host,
        "grep -hE '^(cpu_dedicated_set|cpu_shared_set|vcpu_pin_set|reserved_host_memory_mb)' "
        "/etc/nova/nova.conf",
        user,
    )
    config = {}
    if rc == 0:
        for line in out.splitlines():
            if "=" in line:
                key, _, value = line.partition("=")
                config[key.strip()] = value.strip()

    if not config.get("cpu_dedicated_set") and not config.get("vcpu_pin_set"):
        rows.append(finding("WARN", host, "config", "cpu_dedicated_set",
                            "no dedicated CPU set configured, pinned instances will "
                            "compete with host processes"))
    if config.get("vcpu_pin_set"):
        rows.append(finding("WARN", host, "config", "vcpu_pin_set",
                            "vcpu_pin_set is deprecated; migrate to "
                            "cpu_dedicated_set / cpu_shared_set"))

    # The dedicated set is meaningless unless those CPUs are actually isolated
    # from the kernel scheduler.
    rc, cmdline = ssh(host, "cat /proc/cmdline", user)
    isolated = ""
    if rc == 0:
        match = re.search(r"isolcpus=(\S+)", cmdline)
        isolated = match.group(1) if match else ""

    dedicated = config.get("cpu_dedicated_set", "")
    if dedicated and not isolated:
        rows.append(finding("CRITICAL", host, "config", "isolcpus",
                            f"cpu_dedicated_set={dedicated} but no isolcpus on the kernel "
                            "command line, host processes will still schedule on those CPUs"))
    elif dedicated and isolated:
        rows.append(finding("INFO", host, "config", "isolcpus",
                            f"dedicated={dedicated}, isolated={isolated}"))

    for key in ("nohz_full", "rcu_nocbs"):
        if dedicated and rc == 0 and key not in cmdline:
            rows.append(finding("WARN", host, "config", key,
                                f"{key} not set; dedicated CPUs will still take timer "
                                "and RCU callback interruptions"))
    return rows


def check_instances(conn, host: str, user: str) -> list[dict]:
    rows = []
    rc, dedicated_out = ssh(
        host, "grep -hE '^cpu_dedicated_set' /etc/nova/nova.conf || true", user
    )
    dedicated_cpus = set()
    if rc == 0 and "=" in dedicated_out:
        dedicated_cpus = expand_cpu_list(dedicated_out.partition("=")[2].strip())

    for srv in conn.compute.servers(all_projects=True, details=True, host=host):
        domain = getattr(srv, "instance_name", None) or f"instance-{int(srv.id[:8], 16):08x}"
        rc, xml = ssh(host, f"virsh dumpxml {shlex.quote(domain)}", user)
        if rc != 0:
            continue

        # Memory backing node(s) vs vCPU node(s).
        mem_nodes = set(re.findall(r'<memnode cellid="\d+" mode="\w+" nodeset="(\d+)"', xml))
        pinned = re.findall(r'<vcpupin vcpu="\d+" cpuset="([\d,\-]+)"', xml)
        pinned_cpus: set[int] = set()
        for cpuset in pinned:
            pinned_cpus |= expand_cpu_list(cpuset)

        if pinned_cpus and dedicated_cpus and not pinned_cpus <= dedicated_cpus:
            stray = sorted(pinned_cpus - dedicated_cpus)
            rows.append(finding("CRITICAL", host, "instances", srv.name,
                                f"pinned to CPUs outside cpu_dedicated_set: {stray[:8]}"))

        if len(mem_nodes) > 1:
            rows.append(finding("WARN", host, "instances", srv.name,
                                f"memory spans NUMA nodes {sorted(mem_nodes)}, "
                                "cross-socket access on every miss"))

        extra_specs = (srv.flavor or {}).get("extra_specs", {}) or {}
        if extra_specs.get("hw:mem_page_size") and "<hugepages" not in xml:
            rows.append(finding("CRITICAL", host, "instances", srv.name,
                                "flavor requests hugepages but the domain is not "
                                "hugepage-backed"))

        if pinned_cpus and "<emulatorpin" not in xml:
            rows.append(finding("WARN", host, "instances", srv.name,
                                "vCPUs are pinned but emulator threads are not, "
                                "QEMU I/O will interrupt the pinned cores"))
    return rows


def expand_cpu_list(spec: str) -> set[int]:
    """Expand '0-3,8,12-13' into a set of CPU ids."""
    cpus: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                lo, hi = (int(x) for x in part.split("-", 1))
                cpus.update(range(lo, hi + 1))
            except ValueError:
                continue
        else:
            try:
                cpus.add(int(part))
            except ValueError:
                continue
    return cpus


def check_nic_locality(host: str, user: str) -> list[dict]:
    """SR-IOV and vhost-user only pay off when the NIC is on the instance's node."""
    rows = []
    rc, out = ssh(
        host,
        "for d in /sys/class/net/*/device/numa_node; do "
        "echo \"$(basename $(dirname $(dirname $d))) $(cat $d)\"; done",
        user,
    )
    if rc != 0:
        return rows

    for line in out.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        interface, node = parts[0], parts[1]
        if node == "-1":
            rows.append(finding("WARN", host, "nic", interface,
                                "NIC reports no NUMA affinity (-1); the scheduler cannot "
                                "make a locality-aware placement"))
        else:
            rows.append(finding("INFO", host, "nic", interface, f"NUMA node {node}"))
    return rows


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--host", action="append", help="compute host (repeatable)")
    parser.add_argument("--all-hosts", action="store_true", help="audit every compute node")
    parser.add_argument("--ssh-user", default="root", help="SSH user for the compute nodes")
    parser.add_argument(
        "--check", action="append", choices=CHECKS,
        help="limit to specific checks (repeatable; default: all)",
    )
    parser.add_argument(
        "--min-severity", choices=tuple(SEVERITY_ORDER), default="INFO",
        help="suppress findings below this severity",
    )
    parser.add_argument(
        "--fail-on-findings", action="store_true",
        help="exit non-zero on any CRITICAL finding",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    if not args.host and not args.all_hosts:
        parser.error("pass --host <name> (repeatable) or --all-hosts")

    conn = connect(args.cloud)
    checks = args.check or list(CHECKS)

    if args.all_hosts:
        hosts = [
            svc.host for svc in conn.compute.services()
            if svc.binary == "nova-compute" and svc.state == "up"
        ]
    else:
        hosts = args.host

    rows: list[dict] = []
    for host in hosts:
        LOG.info("auditing %s", host)
        if "host" in checks:
            rows.extend(check_host_topology(host, args.ssh_user))
        if "config" in checks:
            rows.extend(check_nova_config(host, args.ssh_user))
        if "instances" in checks:
            rows.extend(check_instances(conn, host, args.ssh_user))
        if "nic" in checks:
            rows.extend(check_nic_locality(host, args.ssh_user))

    cutoff = SEVERITY_ORDER[args.min_severity]
    rows = [r for r in rows if SEVERITY_ORDER[r["severity"]] <= cutoff]
    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["host"], r["check"]))

    render(rows, COLUMNS, args.format)

    criticals = [r for r in rows if r["severity"] == "CRITICAL"]
    if args.format == "table":
        print(f"\n{len(hosts)} host(s) audited, {len(criticals)} critical finding(s)")

    if args.fail_on_findings and criticals:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
