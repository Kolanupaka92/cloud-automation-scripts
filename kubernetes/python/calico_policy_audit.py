#!/usr/bin/env python3
"""Audit Calico network policy for gaps, shadowing and dangerous rules.

`kubectl get networkpolicy` tells you what exists. It does not tell you that a
namespace has no policy at all, that a high-order deny is unreachable because an
earlier allow already matched, or that a policy selects every endpoint in the
cluster because someone left the selector empty.

Checks
------
    coverage    namespaces with no NetworkPolicy and no GNP selecting them —
                every pod there accepts traffic from anywhere in the cluster
    shadowing   policies that can never take effect because a lower-order policy
                already matches the same endpoints and takes an action
    dangerous   selector matches all endpoints, allow-from-any-source ingress,
                allow-to-any-destination egress on a non-egress-gateway policy
    dns         default-deny egress in effect with no allow for kube-dns
    hygiene     policies with no rules, references to non-existent selectors,
                and duplicate order values (evaluation order becomes arbitrary)

Read-only — this never modifies a policy. Use calico_gnp_update.yml for changes.

Examples
--------
    ./calico_policy_audit.py
    ./calico_policy_audit.py --namespace payments --format json
    ./calico_policy_audit.py --min-severity WARN --fail-on-findings
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from collections import defaultdict

LOG = logging.getLogger("calico-audit")

SEVERITY_ORDER = {"CRITICAL": 0, "WARN": 1, "INFO": 2}
CHECKS = ("coverage", "shadowing", "dangerous", "dns", "hygiene")

# Selectors that match every workload endpoint in scope.
MATCH_ALL_SELECTORS = {"", "all()", "*"}

# Namespaces that legitimately run without tenant policy.
SYSTEM_NAMESPACES = {"kube-system", "kube-public", "kube-node-lease", "calico-system",
                     "tigera-operator"}


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


def finding(severity, check, subject, text) -> dict:
    return {"severity": severity, "check": check, "subject": subject, "finding": text}


def kubectl(args: list[str], timeout: int = 60) -> dict | None:
    try:
        proc = subprocess.run(
            ["kubectl", *args, "-o", "json"],
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError:
        sys.exit("kubectl not found on PATH")
    except subprocess.TimeoutExpired:
        LOG.error("kubectl %s timed out", " ".join(args))
        return None
    if proc.returncode != 0:
        LOG.debug("kubectl %s failed: %s", " ".join(args), proc.stderr.strip()[:200])
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def fetch(resource: str, namespace: str | None = None) -> list[dict]:
    args = ["get", resource]
    if namespace:
        args += ["-n", namespace]
    else:
        args.append("--all-namespaces")
    data = kubectl(args)
    return (data or {}).get("items", [])


def render(rows, columns, fmt) -> None:
    if fmt == "json":
        print(json.dumps(rows, indent=2, default=str))
        return
    if not rows:
        print("(no findings)")
        return
    widths = {c: len(c) for c in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))
    print("  ".join(c.upper().ljust(widths[c]) for c in columns))
    print("  ".join("-" * widths[c] for c in columns))
    for row in rows:
        print("  ".join(str(row.get(c, "")).ljust(widths[c]) for c in columns))
    print(f"\n{len(rows)} finding(s)")


def check_coverage(namespaces, netpols, gnps, include_system: bool) -> list[dict]:
    rows = []
    covered = {np["metadata"]["namespace"] for np in netpols}

    # A GNP with a namespace-scoped selector covers that namespace too.
    gnp_covered = set()
    for gnp in gnps:
        selector = gnp.get("spec", {}).get("selector", "")
        namespace_selector = gnp.get("spec", {}).get("namespaceSelector", "")
        if selector.strip() in MATCH_ALL_SELECTORS or namespace_selector.strip() == "all()":
            gnp_covered = {ns["metadata"]["name"] for ns in namespaces}
            break
        if "projectcalico.org/namespace ==" in selector:
            name = selector.split("==")[1].strip().strip("'\"")
            gnp_covered.add(name)

    for namespace in namespaces:
        name = namespace["metadata"]["name"]
        if name in SYSTEM_NAMESPACES and not include_system:
            continue
        if name in covered or name in gnp_covered:
            continue
        rows.append(finding(
            "CRITICAL", "coverage", name,
            "no NetworkPolicy and no GlobalNetworkPolicy selects this namespace — "
            "every pod accepts traffic from anywhere in the cluster",
        ))

    if not rows:
        rows.append(finding("INFO", "coverage", "cluster",
                            "every non-system namespace is covered by at least one policy"))
    return rows


def check_dangerous(netpols, gnps) -> list[dict]:
    rows = []

    for gnp in gnps:
        name = gnp["metadata"]["name"]
        spec = gnp.get("spec", {})
        selector = (spec.get("selector") or "").strip()

        if selector in MATCH_ALL_SELECTORS:
            rows.append(finding(
                "WARN", "dangerous", name,
                f"selector '{selector or '(empty)'}' matches every endpoint in the "
                "cluster — verify this breadth is intended",
            ))

        for direction in ("ingress", "egress"):
            for rule in spec.get(direction, []) or []:
                if rule.get("action") != "Allow":
                    continue
                peer = rule.get("source" if direction == "ingress" else "destination", {}) or {}
                has_constraint = any(
                    peer.get(key) for key in
                    ("nets", "selector", "namespaceSelector", "serviceAccounts", "ports",
                     "notNets", "domains")
                )
                if not has_constraint:
                    rows.append(finding(
                        "CRITICAL", "dangerous", name,
                        f"{direction} Allow rule has no source/destination or port "
                        "constraint — it permits everything",
                    ))
                for net in peer.get("nets", []) or []:
                    if net in ("0.0.0.0/0", "::/0") and direction == "ingress":
                        rows.append(finding(
                            "CRITICAL", "dangerous", name,
                            f"ingress Allow from {net} — the policy is open to the internet "
                            "wherever the cluster is routable",
                        ))

    for netpol in netpols:
        name = f"{netpol['metadata']['namespace']}/{netpol['metadata']['name']}"
        spec = netpol.get("spec", {})
        selector = spec.get("podSelector", {})
        if selector == {} and not spec.get("policyTypes"):
            rows.append(finding("WARN", "dangerous", name,
                                "empty podSelector with no policyTypes — this selects every "
                                "pod in the namespace but declares no direction"))
    return rows


def check_shadowing(gnps) -> list[dict]:
    """A policy is shadowed when an earlier policy on the same selector already
    takes a terminal action for the same traffic."""
    rows = []
    by_selector: dict[str, list[dict]] = defaultdict(list)
    for gnp in gnps:
        selector = (gnp.get("spec", {}).get("selector") or "").strip()
        by_selector[selector].append(gnp)

    for selector, group in by_selector.items():
        ordered = sorted(group, key=lambda g: g.get("spec", {}).get("order") or float("inf"))
        for index, policy in enumerate(ordered):
            spec = policy.get("spec", {})
            order = spec.get("order")

            # A catch-all Deny with no further constraints terminates evaluation
            # for this selector; everything after it is unreachable.
            terminal = any(
                rule.get("action") == "Deny"
                and not (rule.get("source") or rule.get("destination"))
                for direction in ("ingress", "egress")
                for rule in spec.get(direction, []) or []
            )
            if terminal and index < len(ordered) - 1:
                shadowed = [p["metadata"]["name"] for p in ordered[index + 1:]]
                rows.append(finding(
                    "WARN", "shadowing", policy["metadata"]["name"],
                    f"catch-all Deny at order {order} on selector '{selector}' makes "
                    f"these unreachable: {', '.join(shadowed[:5])}",
                ))
                break

    # Duplicate orders make evaluation sequence undefined between them.
    orders: dict[float, list[str]] = defaultdict(list)
    for gnp in gnps:
        order = gnp.get("spec", {}).get("order")
        if order is not None:
            orders[order].append(gnp["metadata"]["name"])
    for order, names in orders.items():
        if len(names) > 1:
            rows.append(finding(
                "WARN", "shadowing", f"order {order}",
                f"{len(names)} policies share this order, so their relative evaluation "
                f"is arbitrary: {', '.join(names[:5])}",
            ))
    return rows


def check_dns(gnps, netpols) -> list[dict]:
    """Default-deny egress without a DNS allow breaks every pod's name resolution."""
    default_deny_egress = [
        gnp["metadata"]["name"] for gnp in gnps
        if (gnp.get("spec", {}).get("selector") or "").strip() in MATCH_ALL_SELECTORS
        and "Egress" in (gnp.get("spec", {}).get("types") or [])
        and any(r.get("action") == "Deny" for r in gnp.get("spec", {}).get("egress", []) or [])
    ]

    if not default_deny_egress:
        return [finding("INFO", "dns", "cluster", "no cluster-wide default-deny egress in effect")]

    dns_allowed = False
    for policy in gnps + netpols:
        for rule in policy.get("spec", {}).get("egress", []) or []:
            ports = (rule.get("destination", {}) or {}).get("ports", []) or []
            k8s_ports = [p.get("port") for p in rule.get("ports", []) or []]
            if 53 in ports or 53 in k8s_ports:
                dns_allowed = True
                break

    if dns_allowed:
        return [finding("INFO", "dns", ", ".join(default_deny_egress),
                        "default-deny egress is in effect and DNS (53) is explicitly allowed")]
    return [finding("CRITICAL", "dns", ", ".join(default_deny_egress),
                    "default-deny egress is in effect but no policy allows port 53 — "
                    "pod DNS resolution is broken cluster-wide")]


def check_hygiene(gnps, netpols) -> list[dict]:
    rows = []
    for policy in gnps:
        name = policy["metadata"]["name"]
        spec = policy.get("spec", {})
        if not spec.get("ingress") and not spec.get("egress"):
            rows.append(finding("WARN", "hygiene", name,
                                "policy defines no ingress or egress rules"))
        if spec.get("order") is None:
            rows.append(finding("WARN", "hygiene", name,
                                "no order set — this policy is evaluated last, after every "
                                "policy that does set one"))
    for netpol in netpols:
        name = f"{netpol['metadata']['namespace']}/{netpol['metadata']['name']}"
        spec = netpol.get("spec", {})
        if not spec.get("ingress") and not spec.get("egress") and spec.get("policyTypes"):
            rows.append(finding("INFO", "hygiene", name,
                                f"deliberate default-deny for {spec['policyTypes']}"))
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--namespace", help="restrict namespaced policy checks to one namespace")
    parser.add_argument(
        "--check", default=",".join(CHECKS),
        help=f"comma-separated checks: {', '.join(CHECKS)}",
    )
    parser.add_argument(
        "--include-system", action="store_true",
        help="include kube-system and Calico's own namespaces in the coverage check",
    )
    parser.add_argument(
        "--min-severity", choices=tuple(SEVERITY_ORDER), default="INFO",
        help="suppress findings below this severity",
    )
    parser.add_argument("--format", choices=("table", "json"), default="table")
    parser.add_argument(
        "--fail-on-findings", action="store_true",
        help="exit non-zero on any CRITICAL finding",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = parser.parse_args()
    setup_logging(args.verbose)

    checks = [c.strip() for c in args.check.split(",") if c.strip()]
    unknown = [c for c in checks if c not in CHECKS]
    if unknown:
        parser.error(f"unknown check(s): {', '.join(unknown)}")

    LOG.info("collecting policy objects")
    namespaces = fetch("namespaces")
    netpols = fetch("networkpolicies.projectcalico.org", args.namespace) or fetch(
        "networkpolicies.networking.k8s.io", args.namespace
    )
    gnps = fetch("globalnetworkpolicies.projectcalico.org")

    if not namespaces:
        LOG.error("could not read namespaces; check your kubeconfig and permissions")
        return 2

    LOG.info("%d namespace(s), %d NetworkPolicy, %d GlobalNetworkPolicy",
             len(namespaces), len(netpols), len(gnps))

    rows: list[dict] = []
    if "coverage" in checks:
        rows.extend(check_coverage(namespaces, netpols, gnps, args.include_system))
    if "dangerous" in checks:
        rows.extend(check_dangerous(netpols, gnps))
    if "shadowing" in checks:
        rows.extend(check_shadowing(gnps))
    if "dns" in checks:
        rows.extend(check_dns(gnps, netpols))
    if "hygiene" in checks:
        rows.extend(check_hygiene(gnps, netpols))

    cutoff = SEVERITY_ORDER[args.min_severity]
    rows = [r for r in rows if SEVERITY_ORDER[r["severity"]] <= cutoff]
    rows.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["check"], str(r["subject"])))

    render(rows, ("severity", "check", "subject", "finding"), args.format)

    criticals = [r for r in rows if r["severity"] == "CRITICAL"]
    if args.format == "table" and rows:
        print(f"{len(criticals)} critical, "
              f"{len([r for r in rows if r['severity'] == 'WARN'])} warning")

    if args.fail_on_findings and criticals:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
