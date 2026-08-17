"""Airflow DAG for a wave of compute node migrations.

A wave is dozens of hosts over several weeks, different people, different
windows. Driving that from a laptop does not scale and leaves no audit trail.

One task group per host, a pool capping concurrent drains, per-stage retries
so a failure resumes from that stage rather than the whole host, and a
region-wide gate that short-circuits the wave if the cloud is unhealthy.

It shells out to the same scripts in this repo that get run by hand, so there
is one implementation of the migration logic and the two paths cannot drift.

Config lives in an Airflow Variable named compute_migration_wave:

    {
      "wave": "wave-3",
      "change_id": "CHG0041827",
      "cloud": "dfw-prod",
      "hosts": ["compute-041", "compute-042"],
      "target_aggregate": "yoga-upgraded",
      "max_parallel_drains": 2
    }
"""

from __future__ import annotations

import json
import shlex
from datetime import datetime, timedelta

from airflow.decorators import task, task_group
from airflow.exceptions import AirflowSkipException
from airflow.models import Variable
from airflow.models.dag import DAG
from airflow.operators.python import ShortCircuitOperator
from airflow.utils.trigger_rule import TriggerRule

REPO = "/opt/cloud-automation-scripts"
OPENSTACK_PY = f"{REPO}/openstack/python"
ANSIBLE_DIR = f"{REPO}/openstack/ansible"

DEFAULT_ARGS = {
    "owner": "cloud-platform",
    "depends_on_past": False,
    "email_on_failure": True,
    "retries": 1,
    # A retry that starts immediately usually fails the same way; give the
    # cloud time to settle first.
    "retry_delay": timedelta(minutes=10),
    "execution_timeout": timedelta(hours=4),
}


def wave_config() -> dict:
    """Read the wave definition, with defaults that fail safe."""
    raw = Variable.get("compute_migration_wave", default_var="{}")
    config = json.loads(raw) if isinstance(raw, str) else raw
    config.setdefault("hosts", [])
    config.setdefault("cloud", "envvars")
    config.setdefault("change_id", "unspecified")
    config.setdefault("max_parallel_drains", 1)
    config.setdefault("skip_capacity_check", False)
    return config


with DAG(
    dag_id="compute_migration_wave",
    description="Drain, upgrade and return compute nodes to service, one wave at a time",
    default_args=DEFAULT_ARGS,
    schedule=None,                    # triggered per maintenance window
    start_date=datetime(2026, 1, 1),
    catchup=False,
    max_active_runs=1,                # never run two waves against one region
    tags=["openstack", "compute", "migration", "maintenance"],
    doc_md=__doc__,
) as dag:

    @task(task_id="load_wave")
    def load_wave() -> dict:
        config = wave_config()
        if not config["hosts"]:
            raise ValueError(
                "compute_migration_wave Variable defines no hosts; "
                "nothing to migrate."
            )
        if config["change_id"] == "unspecified":
            raise ValueError(
                "compute_migration_wave Variable has no change_id; "
                "every drain must be traceable to a change record."
            )
        print(f"wave {config.get('wave', '?')}: {len(config['hosts'])} host(s), "
              f"change {config['change_id']}")
        return config

    def region_is_healthy(**context) -> bool:
        """Region-wide gate. False short-circuits the entire wave."""
        import subprocess

        config = context["ti"].xcom_pull(task_ids="load_wave")
        result = subprocess.run(
            ["python3", f"{OPENSTACK_PY}/upgrade_preflight.py",
             f"--cloud={config['cloud']}",
             f"--evacuate-hosts={config['max_parallel_drains']}",
             "--format=json"],
            capture_output=True, text=True, timeout=1800,
        )
        print(result.stdout[:8000])

        # 0 clean, 1 warnings, 2 blocking failures.
        if result.returncode >= 2:
            print("Region pre-flight reported blocking failures; the wave will not start.")
            return False
        if result.returncode == 1:
            print("Region pre-flight reported warnings; proceeding.")
        return True

    preflight = ShortCircuitOperator(
        task_id="region_preflight",
        python_callable=region_is_healthy,
        doc_md=(
            "Runs `upgrade_preflight.py` against the whole region. Exit code 2 "
            "(stuck instances, dead services, insufficient capacity) short-"
            "circuits every downstream task so no host is drained into an "
            "unhealthy region."
        ),
    )

    @task_group(group_id="migrate_host")
    def migrate_host(host: str):
        """Every stage for one compute node. Retried per stage, not per host."""

        @task(task_id="assess", pool="openstack_api")
        def assess(host: str) -> dict:
            import subprocess

            config = wave_config()
            result = subprocess.run(
                ["python3", f"{OPENSTACK_PY}/compute_node_drain.py",
                 f"--cloud={config['cloud']}", f"--host={host}",
                 "--dry-run", "--format=json"],
                capture_output=True, text=True, timeout=900,
            )
            if result.returncode >= 2:
                raise RuntimeError(
                    f"{host} cannot be drained safely: {result.stderr[-2000:]}"
                )
            try:
                plan = json.loads(result.stdout or "[]")
            except json.JSONDecodeError:
                plan = []
            movable = [row for row in plan if row.get("_migratable")]
            print(f"{host}: {len(plan)} instance(s), {len(movable)} live-migratable")
            return {"host": host, "instances": len(plan), "migratable": len(movable)}

        @task(task_id="drain", pool="compute_drain", retries=0)
        def drain(assessment: dict) -> dict:
            """No retries: a partially drained host must be looked at, not retried."""
            import subprocess

            config = wave_config()
            host = assessment["host"]
            argv = [
                "python3", f"{OPENSTACK_PY}/compute_node_drain.py",
                f"--cloud={config['cloud']}", f"--host={host}",
                f"--reason={config['change_id']} wave {config.get('wave', '')}",
                "--yes",
            ]
            if config["skip_capacity_check"]:
                argv.append("--skip-capacity-check")

            result = subprocess.run(argv, capture_output=True, text=True, timeout=4 * 3600)
            print(result.stdout[-8000:])
            if result.returncode != 0:
                raise RuntimeError(
                    f"{host} did not drain cleanly (rc={result.returncode}). "
                    "Investigate before re-running; do not blindly retry."
                )
            return assessment

        @task(task_id="maintain", pool="compute_drain",
              execution_timeout=timedelta(hours=3))
        def maintain_host(assessment: dict) -> dict:
            """Patch, reboot if the kernel changed, verify libvirt and OVS come
            back, then return the node to the scheduler."""
            import subprocess

            config = wave_config()
            host = assessment["host"]
            command = (
                f"cd {shlex.quote(ANSIBLE_DIR)} && "
                f"ansible-playbook compute_node_maintenance.yml "
                f"-l {shlex.quote(host)} "
                f"-e change_id={shlex.quote(config['change_id'])} "
                f"-e reboot_required=true"
            )
            result = subprocess.run(
                ["bash", "-lc", command], capture_output=True, text=True, timeout=3 * 3600
            )
            print(result.stdout[-8000:])
            if result.returncode != 0:
                raise RuntimeError(f"maintenance playbook failed on {host}")
            return assessment

        @task(task_id="verify", pool="openstack_api")
        def verify(assessment: dict) -> dict:
            import subprocess

            config = wave_config()
            host = assessment["host"]

            # The node must be back, enabled, and reporting capacity again.
            result = subprocess.run(
                ["python3", f"{OPENSTACK_PY}/hypervisor_capacity_report.py",
                 f"--cloud={config['cloud']}", "--format=json"],
                capture_output=True, text=True, timeout=900,
            )
            rows = json.loads(result.stdout or "[]")
            match = next((r for r in rows if r["hypervisor"] == host), None)
            if match is None:
                raise RuntimeError(f"{host} is not reporting to the scheduler after maintenance")
            if not str(match.get("state", "")).startswith("up"):
                raise RuntimeError(f"{host} is back but reports state {match.get('state')}")

            print(f"{host} back in service: {match['vcpu_total']} vCPU, "
                  f"{match['mem_total_gb']} GB")
            return {"host": host, "status": "completed"}

        @task(task_id="move_to_aggregate", trigger_rule=TriggerRule.ALL_SUCCESS)
        def move_to_aggregate(outcome: dict) -> dict:
            """Record completion by moving the host into the 'done' aggregate."""
            import subprocess

            config = wave_config()
            target = config.get("target_aggregate")
            if not target:
                raise AirflowSkipException("no target_aggregate configured for this wave")

            host = outcome["host"]
            result = subprocess.run(
                ["openstack", "--os-cloud", config["cloud"],
                 "aggregate", "add", "host", target, host],
                capture_output=True, text=True, timeout=300,
            )
            if result.returncode != 0 and "already" not in result.stderr.lower():
                raise RuntimeError(f"could not add {host} to aggregate {target}")
            print(f"{host} recorded in aggregate {target}")
            return outcome

        return move_to_aggregate(verify(maintain_host(drain(assess(host)))))

    @task(task_id="wave_summary", trigger_rule=TriggerRule.ALL_DONE)
    def wave_summary(**context) -> None:
        """Fails the run unless every host finished. ALL_DONE so it always runs."""
        config = wave_config()
        dag_run = context["dag_run"]

        completed, failed, skipped = [], [], []
        for instance in dag_run.get_task_instances():
            if not instance.task_id.endswith(".verify"):
                continue
            host_group = instance.task_id.split(".")[0]
            if instance.state == "success":
                completed.append(host_group)
            elif instance.state == "skipped":
                skipped.append(host_group)
            else:
                failed.append(f"{host_group} ({instance.state})")

        print(f"Wave {config.get('wave', '?')} ({config['change_id']}): "
              f"{len(completed)} completed, {len(failed)} failed, {len(skipped)} skipped")
        for entry in failed:
            print(f"  FAILED: {entry}")

        if failed:
            raise RuntimeError(
                f"{len(failed)} host(s) did not complete: {', '.join(failed)}. "
                "Each needs investigation before the next wave starts."
            )

    config = load_wave()
    hosts = wave_config()["hosts"]

    migrations = [migrate_host.override(group_id=f"host_{h.replace('-', '_')}")(h)
                  for h in hosts]

    config >> preflight >> migrations >> wave_summary()
