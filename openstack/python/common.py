"""Shared helpers for the OpenStack automation scripts.

Every script in this directory authenticates the same way and shares the same
CLI conventions, so operators only have to learn them once:

    --cloud     name of a cloud entry in clouds.yaml (default: envvars)
    --dry-run   print what would change, touch nothing
    --format    table | json  (json is meant for piping into jq/CI)
    -v/--verbose  DEBUG logging

Authentication order is whatever ``openstack.connect()`` resolves: an explicit
``--cloud`` entry from clouds.yaml, otherwise the standard OS_* environment
variables sourced from an openrc file.
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
    import openstack
    from openstack import exceptions as os_exceptions
except ImportError:  # pragma: no cover - dependency guard
    sys.exit(
        "openstacksdk is not installed. Run: pip install -r requirements.txt"
    )

LOG = logging.getLogger("osauto")


def base_parser(description: str) -> argparse.ArgumentParser:
    """Return an ArgumentParser preloaded with the flags every script accepts."""
    parser = argparse.ArgumentParser(
        description=description,
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--cloud",
        default=os.environ.get("OS_CLOUD", "envvars"),
        help="clouds.yaml entry to authenticate with",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report intended actions without changing anything",
    )
    parser.add_argument(
        "--format",
        choices=("table", "json"),
        default="table",
        help="output format",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="enable debug logging",
    )
    return parser


def setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )
    # openstacksdk is extremely chatty at DEBUG; keep it at WARNING unless asked.
    logging.getLogger("openstack").setLevel(
        logging.DEBUG if verbose else logging.WARNING
    )
    logging.getLogger("keystoneauth").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def connect(cloud: str):
    """Build an authenticated connection, failing with a readable message."""
    try:
        conn = openstack.connect(cloud=cloud)
        # Force a token exchange now so auth problems surface here rather than
        # halfway through a maintenance run.
        conn.authorize()
    except os_exceptions.SDKException as exc:
        sys.exit(f"OpenStack authentication failed for cloud '{cloud}': {exc}")
    LOG.debug("authenticated against %s", conn.config.get_session_endpoint("identity"))
    return conn


def render(rows: Sequence[dict[str, Any]], columns: Sequence[str], fmt: str) -> None:
    """Print rows as an aligned table or as JSON."""
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

    header = "  ".join(c.upper().ljust(widths[c]) for c in columns)
    print(header)
    print("  ".join("-" * widths[c] for c in columns))
    for row in rows:
        print("  ".join(str(row.get(c, "")).ljust(widths[c]) for c in columns))
    print(f"\n{len(rows)} row(s)")


def confirm(prompt: str, assume_yes: bool = False) -> bool:
    """Interactive guard for anything destructive."""
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        LOG.error("refusing to proceed without a TTY; pass --yes to override")
        return False
    return input(f"{prompt} [y/N] ").strip().lower() in ("y", "yes")


def pct(used: float, total: float) -> float:
    """Percentage that tolerates a zero denominator (empty/erroring hosts)."""
    return round((used / total) * 100, 1) if total else 0.0
