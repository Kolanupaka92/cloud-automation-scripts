#!/usr/bin/env python3
"""Prometheus exporter for cloud-level OpenStack metrics.

The node exporters cover the hosts; this covers the cloud. Service and agent
liveness, scheduler-visible capacity from Placement, instance and volume state
counts, and floating IP pool usage.

    ./prometheus_exporter.py --port 9183
    ./prometheus_exporter.py --once      # one scrape to stdout, for testing
"""

from __future__ import annotations

import sys
import time
from collections import Counter

from common import LOG, base_parser, connect, host_capacity, setup_logging

try:
    from prometheus_client import REGISTRY, Gauge, generate_latest, start_http_server
    from prometheus_client import Counter as PromCounter
except ImportError:  # pragma: no cover - dependency guard
    sys.exit("prometheus_client is not installed. Run: pip install -r requirements.txt")


SERVICE_UP = Gauge(
    "openstack_service_up", "1 if the nova service is up", ["binary", "host", "zone"]
)
SERVICE_ENABLED = Gauge(
    "openstack_service_enabled", "1 if the nova service is enabled", ["binary", "host"]
)
AGENT_UP = Gauge(
    "openstack_network_agent_up", "1 if the neutron agent is alive", ["binary", "host", "type"]
)
VCPUS_TOTAL = Gauge("openstack_hypervisor_vcpus_total", "Total vCPUs", ["host"])
VCPUS_USED = Gauge("openstack_hypervisor_vcpus_used", "Allocated vCPUs", ["host"])
MEM_TOTAL = Gauge("openstack_hypervisor_memory_mb_total", "Total RAM in MB", ["host"])
MEM_USED = Gauge("openstack_hypervisor_memory_mb_used", "Allocated RAM in MB", ["host"])
DISK_TOTAL = Gauge("openstack_hypervisor_disk_gb_total", "Total local disk in GB", ["host"])
DISK_USED = Gauge("openstack_hypervisor_disk_gb_used", "Allocated local disk in GB", ["host"])
RUNNING_VMS = Gauge("openstack_hypervisor_running_vms", "Running VMs on the host", ["host"])
INSTANCES = Gauge("openstack_instances_by_state", "Instance count by vm_state", ["state"])
VOLUMES = Gauge("openstack_volumes_by_status", "Volume count by status", ["status"])
FLOATING_IPS = Gauge("openstack_floating_ips", "Floating IPs by state", ["state"])
SCRAPE_SECONDS = Gauge("openstack_scrape_duration_seconds", "Duration of the last scrape")
SCRAPE_ERRORS = PromCounter("openstack_scrape_errors_total", "Collector errors", ["collector"])


def collect_services(conn) -> None:
    for svc in conn.compute.services():
        SERVICE_UP.labels(svc.binary, svc.host, svc.availability_zone or "none").set(
            1 if svc.state == "up" else 0
        )
        SERVICE_ENABLED.labels(svc.binary, svc.host).set(
            0 if svc.status == "disabled" else 1
        )


def collect_agents(conn) -> None:
    for agent in conn.network.agents():
        AGENT_UP.labels(agent.binary, agent.host, agent.agent_type or "unknown").set(
            1 if agent.is_alive else 0
        )


def collect_hypervisors(conn) -> None:
    # Capacity comes from Placement: Nova stopped returning these fields on the
    # hypervisor API at microversion 2.88, and an exporter publishing zeros is
    # worse than one publishing nothing; every capacity alert would go quiet.
    hypervisors = list(conn.compute.hypervisors(details=True))
    capacity = host_capacity(conn, hypervisors)

    for hv in hypervisors:
        host = hv.name
        entry = capacity.get(host)
        if entry:
            VCPUS_TOTAL.labels(host).set(entry["vcpu_total"])
            VCPUS_USED.labels(host).set(entry["vcpu_used"])
            MEM_TOTAL.labels(host).set(entry["mem_total"])
            MEM_USED.labels(host).set(entry["mem_used"])
        # Disk and VM count have no Placement equivalent worth publishing here.
        DISK_TOTAL.labels(host).set(hv.local_disk_size or 0)
        DISK_USED.labels(host).set(hv.local_disk_used or 0)
        RUNNING_VMS.labels(host).set(hv.running_vms or 0)


def collect_instances(conn) -> None:
    states = Counter(
        (srv.vm_state or "unknown").lower()
        for srv in conn.compute.servers(all_projects=True, details=True)
    )
    # Reset known-but-now-absent states to zero so alerts recover.
    for state in ("active", "error", "build", "shutoff", "paused", "suspended", "unknown"):
        INSTANCES.labels(state).set(states.get(state, 0))
    for state, count in states.items():
        INSTANCES.labels(state).set(count)


def collect_volumes(conn) -> None:
    statuses = Counter(
        vol.status for vol in conn.block_storage.volumes(all_projects=True)
    )
    for status in ("available", "in-use", "error", "creating", "deleting"):
        VOLUMES.labels(status).set(statuses.get(status, 0))
    for status, count in statuses.items():
        VOLUMES.labels(status).set(count)


def collect_floating_ips(conn) -> None:
    used = free = 0
    for fip in conn.network.ips():
        if fip.port_id:
            used += 1
        else:
            free += 1
    FLOATING_IPS.labels("associated").set(used)
    FLOATING_IPS.labels("free").set(free)


COLLECTORS = {
    "services": collect_services,
    "agents": collect_agents,
    "hypervisors": collect_hypervisors,
    "instances": collect_instances,
    "volumes": collect_volumes,
    "floating_ips": collect_floating_ips,
}


def scrape(conn, enabled: list[str]) -> None:
    start = time.monotonic()
    for name in enabled:
        try:
            COLLECTORS[name](conn)
        except Exception as exc:  # noqa: BLE001 - one bad API must not kill the exporter
            SCRAPE_ERRORS.labels(name).inc()
            LOG.error("collector %s failed: %s", name, exc)
    elapsed = time.monotonic() - start
    SCRAPE_SECONDS.set(elapsed)
    LOG.info("scrape completed in %.1fs", elapsed)


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=9183, help="HTTP port to listen on")
    parser.add_argument("--interval", type=int, default=60, help="seconds between scrapes")
    parser.add_argument(
        "--collector",
        action="append",
        choices=tuple(COLLECTORS),
        help="limit to specific collectors (repeatable; default: all)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="print one scrape in Prometheus text format and exit",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    conn = connect(args.cloud)
    enabled = args.collector or list(COLLECTORS)

    if args.once:
        scrape(conn, enabled)
        sys.stdout.write(generate_latest(REGISTRY).decode())
        return 0

    start_http_server(args.port)
    LOG.info("serving metrics on :%d/metrics every %ds", args.port, args.interval)
    while True:
        scrape(conn, enabled)
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        LOG.info("shutting down")
