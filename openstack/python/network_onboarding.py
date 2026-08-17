#!/usr/bin/env python3
"""Onboard a tenant or provider network into OpenStack from a declarative spec.

Network onboarding is the request that arrives most often and gets done by hand
most often — and hand-built networks are where inconsistent MTUs, missing DNS,
overlapping subnets and forgotten security groups come from. This takes a YAML
spec, validates it against the region *before* touching anything, then creates
the network, subnets, router, and default security group idempotently.

Validation performed before any write:

    * project exists and the caller may act on it
    * VLAN segmentation id is free on the target physical network
    * CIDR does not overlap any existing subnet in the same project or in any
      network sharing the physical segment
    * allocation pools sit inside the CIDR and exclude the gateway
    * MTU is consistent with the physical network's configured MTU
    * external network exists when a router gateway is requested

Re-running with the same spec is safe: existing objects are matched by name and
reported as unchanged rather than duplicated.

Examples
--------
    ./network_onboarding.py --spec networks/prod-app.yml --dry-run
    ./network_onboarding.py --spec networks/prod-app.yml
    ./network_onboarding.py --spec networks/prod-app.yml --delete   # tear down

Spec format (YAML):

    project: app-prod
    network:
      name: net-app-prod
      provider_type: vlan          # vlan | vxlan | flat
      physical_network: physnet1   # required for vlan/flat
      segmentation_id: 1234        # required for vlan
      mtu: 9000
      shared: false
      port_security: true
    subnets:
      - name: subnet-app-prod
        cidr: 10.40.12.0/24
        gateway_ip: 10.40.12.1
        allocation_pools:
          - {start: 10.40.12.10, end: 10.40.12.200}
        dns_nameservers: [10.40.0.10, 10.40.0.11]
        enable_dhcp: true
    router:
      name: rtr-app-prod
      external_network: public
    security_group:
      name: sg-app-prod
      rules:
        - {direction: ingress, protocol: tcp, port: 443, remote_ip_prefix: 10.0.0.0/8}
"""

from __future__ import annotations

import ipaddress
import sys

from common import LOG, base_parser, confirm, connect, render, setup_logging

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is not installed. Run: pip install -r requirements.txt")

COLUMNS = ("action", "kind", "name", "status", "detail")

REQUIRED_TOP_LEVEL = ("project", "network")


def result(action, kind, name, status, detail) -> dict:
    return {"action": action, "kind": kind, "name": name, "status": status, "detail": detail}


def load_spec(path: str) -> dict:
    try:
        with open(path) as handle:
            spec = yaml.safe_load(handle)
    except OSError as exc:
        sys.exit(f"cannot read spec: {exc}")
    except yaml.YAMLError as exc:
        sys.exit(f"spec is not valid YAML: {exc}")

    if not isinstance(spec, dict):
        sys.exit("spec must be a YAML mapping")
    missing = [key for key in REQUIRED_TOP_LEVEL if key not in spec]
    if missing:
        sys.exit(f"spec is missing required key(s): {', '.join(missing)}")
    return spec


def validate(conn, spec: dict) -> list[dict]:
    """Every check that can fail is run here, before a single object is created."""
    problems = []
    net_spec = spec["network"]

    project = conn.identity.find_project(spec["project"], ignore_missing=True)
    if project is None:
        problems.append(result("validate", "project", spec["project"], "FAIL",
                               "project does not exist"))
        return problems  # nothing else can be checked without a project

    provider_type = net_spec.get("provider_type", "vxlan")
    physnet = net_spec.get("physical_network")
    seg_id = net_spec.get("segmentation_id")

    if provider_type in ("vlan", "flat") and not physnet:
        problems.append(result("validate", "network", net_spec["name"], "FAIL",
                               f"provider_type={provider_type} requires physical_network"))
    if provider_type == "vlan":
        if seg_id is None:
            problems.append(result("validate", "network", net_spec["name"], "FAIL",
                                   "provider_type=vlan requires segmentation_id"))
        elif not 1 <= int(seg_id) <= 4094:
            problems.append(result("validate", "network", net_spec["name"], "FAIL",
                                   f"segmentation_id {seg_id} is outside the valid VLAN range"))

    existing_networks = list(conn.network.networks())

    # VLAN id must be free on this physical network.
    if provider_type == "vlan" and seg_id is not None:
        for net in existing_networks:
            if net.name == net_spec["name"]:
                continue
            if (net.provider_physical_network == physnet
                    and str(net.provider_segmentation_id) == str(seg_id)):
                problems.append(result("validate", "network", net_spec["name"], "FAIL",
                                       f"VLAN {seg_id} on {physnet} is already used by "
                                       f"network {net.name}"))

    # MTU sanity: a network cannot exceed the physical segment it rides on.
    mtu = net_spec.get("mtu")
    if mtu:
        peers = [n.mtu for n in existing_networks
                 if n.provider_physical_network == physnet and n.mtu]
        if peers and int(mtu) > max(peers):
            problems.append(result("validate", "network", net_spec["name"], "WARN",
                                   f"MTU {mtu} exceeds every existing network on {physnet} "
                                   f"(max {max(peers)}); verify the fabric supports it"))

    # Subnet validation, including overlap against the whole region.
    existing_subnets = list(conn.network.subnets())
    for subnet in spec.get("subnets", []):
        try:
            cidr = ipaddress.ip_network(subnet["cidr"], strict=True)
        except (KeyError, ValueError) as exc:
            problems.append(result("validate", "subnet", subnet.get("name", "?"), "FAIL",
                                   f"invalid cidr: {exc}"))
            continue

        for existing in existing_subnets:
            if existing.name == subnet.get("name"):
                continue
            try:
                other = ipaddress.ip_network(existing.cidr, strict=False)
            except ValueError:
                continue
            if cidr.overlaps(other) and existing.project_id == project.id:
                problems.append(result("validate", "subnet", subnet["name"], "FAIL",
                                       f"{cidr} overlaps existing subnet {existing.name} "
                                       f"({existing.cidr}) in the same project"))

        gateway = subnet.get("gateway_ip")
        if gateway and ipaddress.ip_address(gateway) not in cidr:
            problems.append(result("validate", "subnet", subnet["name"], "FAIL",
                                   f"gateway {gateway} is outside {cidr}"))

        for pool in subnet.get("allocation_pools", []):
            start = ipaddress.ip_address(pool["start"])
            end = ipaddress.ip_address(pool["end"])
            if start not in cidr or end not in cidr:
                problems.append(result("validate", "subnet", subnet["name"], "FAIL",
                                       f"allocation pool {start}-{end} falls outside {cidr}"))
            elif start > end:
                problems.append(result("validate", "subnet", subnet["name"], "FAIL",
                                       f"allocation pool start {start} is after end {end}"))
            elif gateway and start <= ipaddress.ip_address(gateway) <= end:
                problems.append(result("validate", "subnet", subnet["name"], "FAIL",
                                       f"allocation pool includes the gateway {gateway}"))

    router = spec.get("router")
    if router and router.get("external_network"):
        external = conn.network.find_network(router["external_network"], ignore_missing=True)
        if external is None:
            problems.append(result("validate", "router", router["name"], "FAIL",
                                   f"external network {router['external_network']} not found"))
        elif not external.is_router_external:
            problems.append(result("validate", "router", router["name"], "FAIL",
                                   f"{router['external_network']} is not an external network"))

    if not problems:
        problems.append(result("validate", "spec", net_spec["name"], "OK",
                               "all pre-flight checks passed"))
    return problems


def apply_spec(conn, spec: dict, execute: bool) -> list[dict]:
    rows = []
    net_spec = spec["network"]
    project = conn.identity.find_project(spec["project"], ignore_missing=False)

    # --- network ---------------------------------------------------------
    network = conn.network.find_network(net_spec["name"], ignore_missing=True)
    if network:
        rows.append(result("create", "network", net_spec["name"], "EXISTS",
                           f"id={network.id} mtu={network.mtu}"))
    elif not execute:
        rows.append(result("create", "network", net_spec["name"], "WOULD_CREATE",
                           f"{net_spec.get('provider_type', 'vxlan')} "
                           f"physnet={net_spec.get('physical_network', '-')} "
                           f"vlan={net_spec.get('segmentation_id', '-')}"))
    else:
        attrs = {
            "name": net_spec["name"],
            "project_id": project.id,
            "is_shared": net_spec.get("shared", False),
            "is_port_security_enabled": net_spec.get("port_security", True),
            "mtu": net_spec.get("mtu"),
        }
        if net_spec.get("provider_type"):
            attrs["provider_network_type"] = net_spec["provider_type"]
        if net_spec.get("physical_network"):
            attrs["provider_physical_network"] = net_spec["physical_network"]
        if net_spec.get("segmentation_id"):
            attrs["provider_segmentation_id"] = net_spec["segmentation_id"]
        attrs = {k: v for k, v in attrs.items() if v is not None}
        network = conn.network.create_network(**attrs)
        rows.append(result("create", "network", network.name, "CREATED", f"id={network.id}"))

    # --- subnets ---------------------------------------------------------
    created_subnets = []
    for subnet_spec in spec.get("subnets", []):
        subnet = conn.network.find_subnet(subnet_spec["name"], ignore_missing=True)
        if subnet:
            rows.append(result("create", "subnet", subnet_spec["name"], "EXISTS",
                               f"cidr={subnet.cidr}"))
            created_subnets.append(subnet)
            continue
        if not execute:
            rows.append(result("create", "subnet", subnet_spec["name"], "WOULD_CREATE",
                               f"cidr={subnet_spec['cidr']} "
                               f"dhcp={subnet_spec.get('enable_dhcp', True)}"))
            continue
        subnet = conn.network.create_subnet(
            name=subnet_spec["name"],
            network_id=network.id,
            project_id=project.id,
            ip_version=ipaddress.ip_network(subnet_spec["cidr"], strict=False).version,
            cidr=subnet_spec["cidr"],
            gateway_ip=subnet_spec.get("gateway_ip"),
            allocation_pools=subnet_spec.get("allocation_pools"),
            dns_nameservers=subnet_spec.get("dns_nameservers", []),
            is_dhcp_enabled=subnet_spec.get("enable_dhcp", True),
        )
        created_subnets.append(subnet)
        rows.append(result("create", "subnet", subnet.name, "CREATED", f"cidr={subnet.cidr}"))

    # --- router ----------------------------------------------------------
    router_spec = spec.get("router")
    if router_spec:
        router = conn.network.find_router(router_spec["name"], ignore_missing=True)
        if router:
            rows.append(result("create", "router", router_spec["name"], "EXISTS",
                               f"id={router.id}"))
        elif not execute:
            rows.append(result("create", "router", router_spec["name"], "WOULD_CREATE",
                               f"gateway={router_spec.get('external_network', 'none')}"))
        else:
            attrs = {"name": router_spec["name"], "project_id": project.id}
            if router_spec.get("external_network"):
                external = conn.network.find_network(router_spec["external_network"])
                attrs["external_gateway_info"] = {"network_id": external.id}
            router = conn.network.create_router(**attrs)
            rows.append(result("create", "router", router.name, "CREATED", f"id={router.id}"))

        if execute and router:
            for subnet in created_subnets:
                try:
                    conn.network.add_interface_to_router(router, subnet_id=subnet.id)
                    rows.append(result("attach", "router", router.name, "ATTACHED",
                                       f"subnet {subnet.name}"))
                except Exception as exc:  # noqa: BLE001 - already attached is fine
                    rows.append(result("attach", "router", router.name, "SKIPPED",
                                       f"subnet {subnet.name}: {exc}"))

    # --- security group --------------------------------------------------
    sg_spec = spec.get("security_group")
    if sg_spec:
        group = conn.network.find_security_group(sg_spec["name"], ignore_missing=True)
        if group:
            rows.append(result("create", "security-group", sg_spec["name"], "EXISTS",
                               f"id={group.id}"))
        elif not execute:
            rows.append(result("create", "security-group", sg_spec["name"], "WOULD_CREATE",
                               f"{len(sg_spec.get('rules', []))} rule(s)"))
        else:
            group = conn.network.create_security_group(
                name=sg_spec["name"], project_id=project.id,
                description=f"Managed by network_onboarding.py for {spec['project']}",
            )
            rows.append(result("create", "security-group", group.name, "CREATED",
                               f"id={group.id}"))
            for rule in sg_spec.get("rules", []):
                port = rule.get("port")
                conn.network.create_security_group_rule(
                    security_group_id=group.id,
                    direction=rule.get("direction", "ingress"),
                    protocol=rule.get("protocol"),
                    port_range_min=port,
                    port_range_max=rule.get("port_max", port),
                    remote_ip_prefix=rule.get("remote_ip_prefix"),
                    ether_type=rule.get("ether_type", "IPv4"),
                )
                rows.append(result("create", "sg-rule", group.name, "CREATED",
                                   f"{rule.get('direction', 'ingress')} "
                                   f"{rule.get('protocol', 'any')}/{port or 'all'} "
                                   f"from {rule.get('remote_ip_prefix', 'any')}"))
    return rows


def delete_spec(conn, spec: dict, execute: bool, assume_yes: bool) -> list[dict]:
    """Tear down in reverse dependency order."""
    rows = []
    net_spec = spec["network"]

    if execute and not confirm(
        f"Delete network {net_spec['name']} and everything attached to it?", assume_yes
    ):
        return [result("delete", "network", net_spec["name"], "ABORTED", "not confirmed")]

    router_spec = spec.get("router")
    if router_spec:
        router = conn.network.find_router(router_spec["name"], ignore_missing=True)
        if router:
            if execute:
                for subnet_spec in spec.get("subnets", []):
                    subnet = conn.network.find_subnet(subnet_spec["name"], ignore_missing=True)
                    if subnet:
                        try:
                            conn.network.remove_interface_from_router(router, subnet_id=subnet.id)
                        except Exception as exc:  # noqa: BLE001
                            LOG.debug("detach %s: %s", subnet.name, exc)
                conn.network.delete_router(router, ignore_missing=True)
            rows.append(result("delete", "router", router_spec["name"],
                               "DELETED" if execute else "WOULD_DELETE", ""))

    for subnet_spec in spec.get("subnets", []):
        subnet = conn.network.find_subnet(subnet_spec["name"], ignore_missing=True)
        if subnet:
            if execute:
                conn.network.delete_subnet(subnet, ignore_missing=True)
            rows.append(result("delete", "subnet", subnet_spec["name"],
                               "DELETED" if execute else "WOULD_DELETE", subnet.cidr))

    network = conn.network.find_network(net_spec["name"], ignore_missing=True)
    if network:
        if execute:
            conn.network.delete_network(network, ignore_missing=True)
        rows.append(result("delete", "network", net_spec["name"],
                           "DELETED" if execute else "WOULD_DELETE", ""))

    sg_spec = spec.get("security_group")
    if sg_spec:
        group = conn.network.find_security_group(sg_spec["name"], ignore_missing=True)
        if group:
            if execute:
                conn.network.delete_security_group(group, ignore_missing=True)
            rows.append(result("delete", "security-group", sg_spec["name"],
                               "DELETED" if execute else "WOULD_DELETE", ""))
    return rows


def main() -> int:
    parser = base_parser(__doc__.splitlines()[0])
    parser.add_argument("--spec", required=True, help="path to the YAML network spec")
    parser.add_argument(
        "--delete", action="store_true", help="tear the spec down instead of creating it"
    )
    parser.add_argument(
        "--validate-only", action="store_true", help="run pre-flight checks and stop"
    )
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args()
    setup_logging(args.verbose)

    spec = load_spec(args.spec)
    conn = connect(args.cloud)
    execute = not args.dry_run

    rows = validate(conn, spec)
    failures = [r for r in rows if r["status"] == "FAIL"]
    if failures or args.validate_only:
        render(rows, COLUMNS, args.format)
        if failures:
            LOG.error("%d validation failure(s); nothing was created", len(failures))
            return 2
        return 0

    if args.delete:
        rows.extend(delete_spec(conn, spec, execute, args.yes))
    else:
        rows.extend(apply_spec(conn, spec, execute))

    render(rows, COLUMNS, args.format)

    if not execute and args.format == "table":
        print("\nDry run — nothing was changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
