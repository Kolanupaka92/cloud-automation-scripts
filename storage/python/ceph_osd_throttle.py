#!/usr/bin/env python3
"""Tune Ceph OSD recovery and backfill throttles for the situation at hand.

Recovery throttles are the classic false economy. Leave the defaults during a
large backfill and client latency collapses; leave them turned down after the
incident and the cluster stays degraded for days. Both failure modes are
routine, and both are avoidable by setting the throttle deliberately and
recording why.

Profiles
--------
    emergency   client I/O is already suffering; recover as slowly as possible
    conservative  business hours — protect client latency, accept slow recovery
    balanced    the sensible default outside a window
    aggressive  maintenance window, no tenant load, drain the backfill queue
    default     restore Ceph's shipped values

Applied settings (per profile):
    osd_max_backfills, osd_recovery_max_active, osd_recovery_op_priority,
    osd_recovery_sleep_hdd/ssd, osd_scrub_during_recovery

Safety
------
  * Refuses to raise throttles while the cluster is not HEALTH_OK unless
    --force is given, because turning recovery up during an outage is how a
    slow cluster becomes an unavailable one.
  * Records the current values before changing anything and writes them to a
    restore file, so `--restore` puts the cluster back exactly as it was.
  * `--watch` reports recovery throughput and client latency after applying, so
    the effect is visible rather than assumed.

Examples
--------
    ./ceph_osd_throttle.py --show
    ./ceph_osd_throttle.py --profile conservative --dry-run
    ./ceph_osd_throttle.py --profile aggressive --reason "CHG0041827 rack drain"
    ./ceph_osd_throttle.py --restore state/ceph-throttle-20260817.json
    ./ceph_osd_throttle.py --watch 300
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LOG = logging.getLogger("ceph-throttle")

TUNABLES = (
    "osd_max_backfills",
    "osd_recovery_max_active",
    "osd_recovery_op_priority",
    "osd_recovery_sleep_hdd",
    "osd_recovery_sleep_ssd",
    "osd_scrub_during_recovery",
)

PROFILES = {
    "emergency": {
        "osd_max_backfills": "1",
        "osd_recovery_max_active": "1",
        "osd_recovery_op_priority": "1",
        "osd_recovery_sleep_hdd": "0.5",
        "osd_recovery_sleep_ssd": "0.1",
        "osd_scrub_during_recovery": "false",
    },
    "conservative": {
        "osd_max_backfills": "1",
        "osd_recovery_max_active": "2",
        "osd_recovery_op_priority": "1",
        "osd_recovery_sleep_hdd": "0.1",
        "osd_recovery_sleep_ssd": "0.02",
        "osd_scrub_during_recovery": "false",
    },
    "balanced": {
        "osd_max_backfills": "2",
        "osd_recovery_max_active": "3",
        "osd_recovery_op_priority": "3",
        "osd_recovery_sleep_hdd": "0.05",
        "osd_recovery_sleep_ssd": "0",
        "osd_scrub_during_recovery": "false",
    },
    "aggressive": {
        "osd_max_backfills": "8",
        "osd_recovery_max_active": "8",
        "osd_recovery_op_priority": "5",
        "osd_recovery_sleep_hdd": "0",
        "osd_recovery_sleep_ssd": "0",
        "osd_scrub_during_recovery": "true",
    },
    "default": {
        "osd_max_backfills": "1",
        "osd_recovery_max_active": "0",
        "osd_recovery_op_priority": "3",
        "osd_recovery_sleep_hdd": "0.1",
        "osd_recovery_sleep_ssd": "0",
        "osd_scrub_during_recovery": "false",
    },
}

# Profiles that increase recovery pressure on the cluster.
HEAVY_PROFILES = {"balanced", "aggressive"}


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


def ceph(args: list[str], timeout: int = 60) -> tuple[int, str]:
    try:
        proc = subprocess.run(["ceph", *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        sys.exit("ceph CLI not found on PATH")
    except subprocess.TimeoutExpired:
        LOG.error("ceph %s timed out", " ".join(args))
        return 255, ""
    if proc.returncode != 0:
        LOG.debug("ceph %s failed: %s", " ".join(args), proc.stderr.strip()[:200])
    return proc.returncode, proc.stdout


def cluster_status() -> dict:
    rc, out = ceph(["status", "--format", "json"])
    if rc != 0:
        sys.exit("cannot reach the Ceph cluster; check your keyring and ceph.conf")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        sys.exit("unexpected output from `ceph status`")


def health_summary(status: dict) -> tuple[str, list[str]]:
    health = status.get("health", {})
    state = health.get("status", "UNKNOWN")
    checks = [
        f"{name}: {detail.get('summary', {}).get('message', '')}"
        for name, detail in (health.get("checks") or {}).items()
    ]
    return state, checks


def current_values() -> dict[str, str]:
    values = {}
    for key in TUNABLES:
        rc, out = ceph(["config", "get", "osd", key])
        values[key] = out.strip() if rc == 0 else "unknown"
    return values


def apply_values(values: dict[str, str], execute: bool) -> int:
    failures = 0
    for key, value in values.items():
        if not execute:
            LOG.info("would set osd/%s = %s", key, value)
            continue
        rc, _ = ceph(["config", "set", "osd", key, value])
        if rc != 0:
            failures += 1
            LOG.error("failed to set %s = %s", key, value)
        else:
            LOG.info("set osd/%s = %s", key, value)
    return failures


def recovery_progress(status: dict) -> str:
    pgmap = status.get("pgmap", {})
    parts = []
    if pgmap.get("recovering_objects_per_sec"):
        parts.append(f"{pgmap['recovering_objects_per_sec']} obj/s recovering")
    if pgmap.get("recovering_bytes_per_sec"):
        parts.append(f"{pgmap['recovering_bytes_per_sec'] / 2**20:.0f} MB/s recovery")
    if pgmap.get("read_bytes_sec") or pgmap.get("write_bytes_sec"):
        parts.append(
            f"client {pgmap.get('read_bytes_sec', 0) / 2**20:.0f} MB/s r / "
            f"{pgmap.get('write_bytes_sec', 0) / 2**20:.0f} MB/s w"
        )
    degraded = pgmap.get("degraded_objects")
    if degraded:
        parts.append(f"{degraded} degraded object(s) "
                     f"({pgmap.get('degraded_ratio', 0) * 100:.2f}%)")
    misplaced = pgmap.get("misplaced_objects")
    if misplaced:
        parts.append(f"{misplaced} misplaced object(s)")
    return "; ".join(parts) or "no recovery in progress"


def watch(seconds: int, interval: int = 15) -> None:
    LOG.info("watching recovery for %ds", seconds)
    deadline = time.time() + seconds
    while time.time() < deadline:
        status = cluster_status()
        state, _ = health_summary(status)
        print(f"{datetime.now(timezone.utc).strftime('%H:%M:%S')}  {state}  "
              f"{recovery_progress(status)}")
        time.sleep(interval)


def save_restore_point(values: dict[str, str], reason: str, state_dir: Path) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = state_dir / f"ceph-throttle-{stamp}.json"
    path.write_text(json.dumps({
        "captured_at": stamp,
        "reason": reason,
        "previous_values": values,
    }, indent=2))
    return path


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--profile", choices=tuple(PROFILES), help="throttle profile to apply")
    parser.add_argument("--show", action="store_true", help="show current values and exit")
    parser.add_argument("--restore", help="restore values from a saved restore point")
    parser.add_argument(
        "--reason", default="", help="why this change is being made (recorded in the restore point)"
    )
    parser.add_argument(
        "--watch", type=int, metavar="SECONDS",
        help="after applying, report recovery and client throughput for this long",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="raise throttles even when the cluster is not HEALTH_OK",
    )
    parser.add_argument("--state-dir", default="state", help="where restore points are written")
    parser.add_argument("--dry-run", action="store_true", help="report without changing anything")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = parser.parse_args()
    setup_logging(args.verbose)

    status = cluster_status()
    state, checks = health_summary(status)
    LOG.info("cluster health: %s", state)
    for check in checks:
        LOG.info("  %s", check)
    LOG.info("recovery: %s", recovery_progress(status))

    values = current_values()

    if args.show or (not args.profile and not args.restore and not args.watch):
        print("\nCurrent OSD throttle configuration:")
        width = max(len(k) for k in TUNABLES)
        for key in TUNABLES:
            print(f"  {key.ljust(width)}  {values[key]}")
        matching = [name for name, profile in PROFILES.items()
                    if all(values.get(k) == v for k, v in profile.items())]
        print(f"\nMatches profile: {matching[0] if matching else 'custom'}")
        if not args.watch:
            return 0

    if args.restore:
        try:
            saved = json.loads(Path(args.restore).read_text())
        except (OSError, json.JSONDecodeError) as exc:
            sys.exit(f"cannot read restore point: {exc}")
        previous = saved["previous_values"]
        LOG.info("restoring values captured at %s (reason: %s)",
                 saved.get("captured_at"), saved.get("reason") or "not recorded")
        failures = apply_values(
            {k: v for k, v in previous.items() if v != "unknown"}, not args.dry_run
        )
        return 1 if failures else 0

    if args.profile:
        target = PROFILES[args.profile]

        if args.profile in HEAVY_PROFILES and state != "HEALTH_OK" and not args.force:
            LOG.error(
                "cluster is %s; refusing to raise recovery throttles. "
                "Use --profile conservative, or --force if this is deliberate.",
                state,
            )
            return 2

        if not args.reason and not args.dry_run:
            LOG.warning("no --reason given; the restore point will not record why")

        restore_path = None
        if not args.dry_run:
            restore_path = save_restore_point(values, args.reason, Path(args.state_dir))
            LOG.info("restore point written to %s", restore_path)

        print(f"\nApplying profile '{args.profile}':")
        width = max(len(k) for k in TUNABLES)
        for key in TUNABLES:
            change = "" if values.get(key) == target[key] else "  <-- change"
            print(f"  {key.ljust(width)}  {values.get(key, '?')} -> {target[key]}{change}")
        print()

        failures = apply_values(target, not args.dry_run)
        if failures:
            LOG.error("%d setting(s) failed to apply", failures)
            return 1
        if restore_path:
            LOG.info("revert with: %s --restore %s", sys.argv[0], restore_path)

    if args.watch:
        watch(args.watch)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        LOG.info("interrupted")
