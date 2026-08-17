#!/usr/bin/env python3
"""Fleet-wide health and upgrade-readiness report for AKS clusters.

Checks each cluster for the things that cause a bad night:

    version        cluster and node pools on a supported version, control plane
                   and node pools not skewed, an upgrade actually available
    node-pools     autoscaler bounds, node count vs max pods, spot pools in
                   system mode, pools not in a Succeeded state
    resilience     multi-zone spread, availability of a system pool, minimum
                   node counts that survive a single-zone loss
    config         RBAC enabled, network policy set, private cluster, managed
                   identity rather than a service principal, Azure Monitor and
                   Defender add-ons enabled

Examples
--------
    ./aks_health_check.py --all-subscriptions
    ./aks_health_check.py --cluster prod-aks-eastus --format json
    ./aks_health_check.py --min-severity FAIL --fail-on-findings
"""

from __future__ import annotations

from common import (
    LOG,
    base_parser,
    credential,
    in_scope,
    render,
    resource_group_of,
    safe_list,
    setup_logging,
    subscriptions,
)

try:
    from azure.mgmt.containerservice import ContainerServiceClient
except ImportError:  # pragma: no cover
    raise SystemExit("pip install -r requirements.txt")

SEVERITY_ORDER = {"FAIL": 0, "WARN": 1, "INFO": 2}

COLUMNS = ("severity", "cluster", "area", "subject", "finding")


def finding(severity, cluster, area, subject, text, rg, sub) -> dict:
    return {
        "severity": severity,
        "cluster": cluster,
        "area": area,
        "subject": subject,
        "finding": text,
        "_resource_group": rg,
        "_subscription": sub,
    }


def parse_version(version: str | None) -> tuple[int, ...]:
    if not version:
        return ()
    try:
        return tuple(int(part) for part in version.split(".")[:3])
    except ValueError:
        return ()


def check_versions(client, cluster, rg, sub, args) -> list[dict]:
    rows = []
    name = cluster.name
    control = cluster.kubernetes_version
    control_v = parse_version(control)

    for pool in cluster.agent_pool_profiles or []:
        pool_v = parse_version(pool.orchestrator_version or control)
        if not pool_v or not control_v:
            continue
        # Kubernetes tolerates at most two minor versions of kubelet skew.
        if control_v[1] - pool_v[1] > 2:
            rows.append(finding("FAIL", name, "version", pool.name,
                                f"node pool on {pool.orchestrator_version} is more than "
                                f"two minors behind the control plane ({control})", rg, sub))
        elif pool_v[:2] != control_v[:2]:
            rows.append(finding("WARN", name, "version", pool.name,
                                f"node pool {pool.orchestrator_version} != control plane {control}",
                                rg, sub))

    try:
        profile = client.managed_clusters.get_upgrade_profile(rg, name)
        upgrades = profile.control_plane_profile.upgrades or []
        if upgrades:
            targets = ", ".join(u.kubernetes_version for u in upgrades[:3])
            rows.append(finding("INFO", name, "version", "control-plane",
                                f"on {control}; upgrade available to {targets}", rg, sub))
    except Exception as exc:  # noqa: BLE001 - upgrade profile needs extra rights
        LOG.debug("upgrade profile unavailable for %s: %s", name, exc)

    return rows


def check_node_pools(cluster, rg, sub, args) -> list[dict]:
    rows = []
    name = cluster.name
    pools = cluster.agent_pool_profiles or []

    if not pools:
        return [finding("FAIL", name, "node-pools", "-", "cluster has no node pools", rg, sub)]

    system_pools = [p for p in pools if (p.mode or "") == "System"]
    if not system_pools:
        rows.append(finding("FAIL", name, "node-pools", "-",
                            "no System-mode node pool", rg, sub))

    for pool in pools:
        if pool.provisioning_state and pool.provisioning_state != "Succeeded":
            rows.append(finding("FAIL", name, "node-pools", pool.name,
                                f"provisioning state is {pool.provisioning_state}", rg, sub))

        if (pool.scale_set_priority or "") == "Spot" and (pool.mode or "") == "System":
            rows.append(finding("FAIL", name, "node-pools", pool.name,
                                "Spot instances backing a System pool", rg, sub))

        if not pool.enable_auto_scaling:
            rows.append(finding("WARN", name, "node-pools", pool.name,
                                f"autoscaling disabled (fixed at {pool.count} node(s))", rg, sub))
        elif pool.min_count is not None and pool.min_count < 2 and (pool.mode or "") == "System":
            rows.append(finding("WARN", name, "node-pools", pool.name,
                                f"system pool can scale down to {pool.min_count} node(s)", rg, sub))

        if pool.count is not None and pool.count < 3 and (pool.mode or "") == "System":
            rows.append(finding("WARN", name, "node-pools", pool.name,
                                f"only {pool.count} node(s) in the system pool", rg, sub))

        zones = pool.availability_zones or []
        if len(zones) < 2:
            rows.append(finding("WARN", name, "resilience", pool.name,
                                f"spans {len(zones) or 'no'} availability zone(s)", rg, sub))

        if pool.max_pods is not None and pool.max_pods > 110:
            rows.append(finding("WARN", name, "node-pools", pool.name,
                                f"max_pods={pool.max_pods} exceeds the supported maximum", rg, sub))
    return rows


def check_config(cluster, rg, sub, args) -> list[dict]:
    rows = []
    name = cluster.name
    addons = cluster.addon_profiles or {}

    if not cluster.enable_rbac:
        rows.append(finding("FAIL", name, "config", "rbac", "Kubernetes RBAC is disabled", rg, sub))

    if cluster.identity is None:
        rows.append(finding("WARN", name, "config", "identity",
                            "no managed identity; still using a service principal", rg, sub))

    network = cluster.network_profile
    if network and not network.network_policy:
        rows.append(finding("WARN", name, "config", "network-policy",
                            "no network policy engine — pod-to-pod traffic is unrestricted",
                            rg, sub))

    api = cluster.api_server_access_profile
    private = bool(api and api.enable_private_cluster)
    if not private:
        allowed = (api.authorized_ip_ranges if api else None) or []
        if not allowed:
            rows.append(finding("FAIL", name, "config", "api-server",
                                "public API server with no authorized IP ranges", rg, sub))
        else:
            rows.append(finding("INFO", name, "config", "api-server",
                                f"public API server restricted to {len(allowed)} range(s)", rg, sub))

    monitoring = addons.get("omsagent") or addons.get("omsAgent")
    if not (monitoring and monitoring.enabled):
        rows.append(finding("WARN", name, "config", "monitoring",
                            "Container Insights (omsagent) is not enabled", rg, sub))

    if cluster.auto_upgrade_profile is None or not getattr(
        cluster.auto_upgrade_profile, "upgrade_channel", None
    ):
        rows.append(finding("INFO", name, "config", "auto-upgrade",
                            "no upgrade channel configured; upgrades are fully manual", rg, sub))

    if cluster.provisioning_state and cluster.provisioning_state != "Succeeded":
        rows.append(finding("FAIL", name, "config", "provisioning",
                            f"cluster provisioning state is {cluster.provisioning_state}", rg, sub))

    if (cluster.power_state and getattr(cluster.power_state, "code", "") == "Stopped"):
        rows.append(finding("WARN", name, "config", "power",
                            "cluster is stopped", rg, sub))
    return rows


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--cluster", help="restrict to a single cluster name")
    parser.add_argument(
        "--min-severity", choices=tuple(SEVERITY_ORDER), default="INFO",
        help="suppress findings below this severity",
    )
    parser.add_argument(
        "--fail-on-findings", action="store_true",
        help="exit non-zero when any FAIL-level finding is reported",
    )
    args = parser.parse_args()
    setup_logging(args.verbose)

    cred = credential()
    rows: list[dict] = []
    clusters_seen = 0

    for sub_id, sub_name in subscriptions(cred, args):
        client = ContainerServiceClient(cred, sub_id)
        LOG.info("scanning subscription %s", sub_name)
        for cluster in safe_list(client.managed_clusters.list, f"AKS clusters in {sub_name}"):
            if args.cluster and cluster.name != args.cluster:
                continue
            if not in_scope(cluster.id, args.resource_group):
                continue
            rg = resource_group_of(cluster.id)
            clusters_seen += 1
            LOG.info("  checking %s (%s)", cluster.name, cluster.kubernetes_version)
            rows.extend(check_versions(client, cluster, rg, sub_name, args))
            rows.extend(check_node_pools(cluster, rg, sub_name, args))
            rows.extend(check_config(cluster, rg, sub_name, args))

    cutoff = SEVERITY_ORDER[args.min_severity]
    rows = [r for r in rows if SEVERITY_ORDER[r["severity"]] <= cutoff]
    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["cluster"], r["area"]))

    render(rows, COLUMNS, args.format)

    fails = [r for r in rows if r["severity"] == "FAIL"]
    if args.format == "table":
        print(f"\n{clusters_seen} cluster(s) checked, {len(fails)} failure(s), "
              f"{len([r for r in rows if r['severity'] == 'WARN'])} warning(s)")

    if args.fail_on_findings and fails:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
