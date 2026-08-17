"""Shared helpers for the Azure automation scripts.

Authentication uses ``DefaultAzureCredential``, so the same script works from a
laptop (``az login``), a pipeline (workload identity / service principal), and a
VM or AKS pod (managed identity) with no code change.

Common flags:

    --subscription  subscription id (defaults to $AZURE_SUBSCRIPTION_ID, or all
                    subscriptions the credential can see with --all-subscriptions)
    --resource-group  restrict to one resource group
    --dry-run       report intended actions without changing anything
    --format        table | json
    -v/--verbose    DEBUG logging
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import Any, Iterator, Sequence

try:
    from azure.core.exceptions import ClientAuthenticationError, HttpResponseError
    from azure.identity import DefaultAzureCredential
    from azure.mgmt.resource.subscriptions import SubscriptionClient
except ImportError:  # pragma: no cover - dependency guard
    sys.exit(
        "Azure SDK packages are missing. Run: pip install -r requirements.txt"
    )

LOG = logging.getLogger("azauto")


def base_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=description,
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--subscription",
        default=os.environ.get("AZURE_SUBSCRIPTION_ID"),
        help="subscription id to operate on",
    )
    parser.add_argument(
        "--all-subscriptions",
        action="store_true",
        help="iterate every subscription the credential can enumerate",
    )
    parser.add_argument("--resource-group", help="restrict to a single resource group")
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
    # The Azure SDK logs every HTTP request at INFO; that is unusable in a report.
    logging.getLogger("azure").setLevel(logging.WARNING)
    logging.getLogger("azure.identity").setLevel(logging.ERROR)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def credential() -> DefaultAzureCredential:
    """One credential object, reused by every management client."""
    return DefaultAzureCredential(exclude_interactive_browser_credential=False)


def subscriptions(cred, args) -> Iterator[tuple[str, str]]:
    """Yield (subscription_id, display_name) for whatever the caller asked for."""
    if args.all_subscriptions:
        try:
            for sub in SubscriptionClient(cred).subscriptions.list():
                if sub.state == "Enabled":
                    yield sub.subscription_id, sub.display_name
        except ClientAuthenticationError as exc:
            sys.exit(f"Azure authentication failed: {exc}")
        return

    if not args.subscription:
        sys.exit(
            "No subscription specified. Pass --subscription, set "
            "AZURE_SUBSCRIPTION_ID, or use --all-subscriptions."
        )
    yield args.subscription, args.subscription


def resource_group_of(resource_id: str) -> str:
    """Pull the resource group out of an ARM resource id."""
    parts = resource_id.split("/")
    try:
        return parts[parts.index("resourceGroups") + 1]
    except (ValueError, IndexError):
        return "-"


def name_of(resource_id: str) -> str:
    return resource_id.rstrip("/").split("/")[-1]


def in_scope(resource_id: str, resource_group: str | None) -> bool:
    if not resource_group:
        return True
    return resource_group_of(resource_id).lower() == resource_group.lower()


def tag(resource, key: str, default: str = "-") -> str:
    return (getattr(resource, "tags", None) or {}).get(key, default)


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


def safe_list(call, description: str) -> list:
    """Run a list operation, downgrading permission errors to a warning.

    Estate-wide reports routinely hit a subscription or resource group the
    credential cannot read; that should skip, not abort the whole run.
    """
    try:
        return list(call())
    except HttpResponseError as exc:
        LOG.warning("skipping %s: %s", description, exc.message or exc)
        return []
