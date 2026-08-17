# cloud-automation-scripts

Operational tooling for the platforms I run day to day: OpenStack, Azure Operator
Nexus, Azure, and the Kubernetes layer sitting on top of all three.

Most of this started as one-off scripts written during a maintenance window or an
incident, then got cleaned up once it turned out I was running the same thing
every quarter. So the bias throughout is towards things that are safe to run at
2am on a live estate: dry runs, pre-flight checks, resumable state, and exit codes
that mean something.

## Layout

```
openstack/python      Nova, Neutron, Cinder, Placement
openstack/ansible     region health, compute maintenance, hardening, drift
azure/operator-nexus  bare metal lifecycle, audits, workbooks, KQL
azure/python          orphaned resources, NSG audit, AKS, rightsizing
azure/ansible         resource stack, VM baseline, AKS upgrades
storage/python        Ceph throttles, Pure upgrade pre-flight
kubernetes            Calico policy updates and audit
hardware/ansible      firmware validation
security              cert rotation, SentinelOne coverage
network/python        NTP health
airflow/dags          migration waves
common/ansible/roles  shared roles
```

## OpenStack

| | |
| --- | --- |
| `hypervisor_capacity_report.py` | Capacity and overcommit per node, from Placement. `--flavor` works out how many more will fit. |
| `orphaned_resource_audit.py` | Volumes, snapshots, floating IPs, ports and images nobody owns. Optional reclamation. |
| `compute_node_drain.py` | Drain for maintenance. Checks there's somewhere for the instances to go first, then migrates one at a time. |
| `compute_node_decommission.py` | Permanent removal, including the Placement resource provider that gets missed by hand. |
| `orphaned_instance_cleanup.py` | Nova vs libvirt reconciliation. Catches domains eating untracked capacity, and instances Nova thinks are running that aren't. |
| `numa_topology_audit.py` | Pinning, isolcpus, hugepage balance, NIC locality. None of it alerts; all of it costs latency. |
| `security_group_audit.py` | Ingress exposure ranked by severity. Can gate a pipeline. |
| `upgrade_preflight.py` | The gate before a window. Services, version skew, stuck instances and volumes, quota, capacity to drain N hosts. |
| `network_onboarding.py` | Networks from a YAML spec, validated against the region before anything is created. |
| `vmware_to_openstack_migrate.py` | Per-VM migration in resumable phases, preserving MAC and IP. |
| `prometheus_exporter.py` | Cloud-level metrics the node exporters don't cover. |

| | |
| --- | --- |
| `openstack_service_health.yml` | Read-only region sweep into one JSON report. Safe during an incident. |
| `openstack_k8s_pods_health.yml` | Same idea for OpenStack-Helm deployments: service pods, Galera quorum, RabbitMQ. |
| `openstack_k8s_service_restart.yml` | Rolling restart of one service, refusing to touch one that's already degraded. |
| `compute_node_maintenance.yml` | Drain, patch, reboot, verify, return to service. Calls `compute_node_drain.py` so the migration logic lives in one place. |
| `linux_hardening.yml` | SSH, sysctl, audit rules, with a post-check that the settings actually took. |
| `config_drift_detect.yml` | Drift against a committed baseline. Detection only. Unexplained drift is an investigation, not something to overwrite at 3am. |

## Azure Operator Nexus

[Operator Nexus](https://learn.microsoft.com/en-us/azure/operator-nexus/overview)
runs telco workloads on bare metal in the operator's own datacentres. Everything
here goes through the Network Cloud resource provider, which is the only
sanctioned path to a BMM.

| | |
| --- | --- |
| `nexus_bmm_health.py` | Fleet state per rack, plus a GO/NO-GO on whether a window can start. During maintenance the question isn't whether a machine is healthy, it's whether the rack can spare one. |
| `nexus_bmm_maintenance.py` | The quarterly cycle: cordon, power off, power on, wait Ready, uncordon, verify. One machine at a time, journalled so it resumes. `--phase shutdown`/`restore` splits it around the hardware team. |
| `nexus_disk_network_audit.py` | Control-plane view plus on-machine output via allow-listed read commands. Drives, SMART, filesystems, links, bonds, error counters. |
| `nexus_quarterly_maintenance.yml` | The whole window: pre-flight, snapshot, shutdown, restore, post-flight. The post-check diffs against the snapshot, so pre-existing findings don't get blamed on the maintenance. |
| `nexus_k8s_cluster_health.yml` | Nexus Kubernetes correlated with the bare metal under it, so a NotReady node resolves to a rack and slot. |
| `bmm-fleet-health.workbook.json` | Azure Monitor workbook: fleet tiles, rack readiness, node/BMM correlation, power and cordon audit trail. |
| `bmm_health_signals.kql` | The queries behind it, standalone so they can go into alert rules. |

## Azure and AKS

| | |
| --- | --- |
| `orphaned_resource_audit.py` | Unattached disks, unused public IPs and NICs, stale snapshots, orphaned NSGs, with rough monthly cost. Skips anything tagged DoNotDelete. |
| `nsg_audit.py` | Effective rules where permitted, since authored rules aren't necessarily what traffic hits. |
| `aks_health_check.py` | Version skew, node pool resilience, zone spread, RBAC, network policy, public API server with no IP restrictions. |
| `vm_rightsizing.py` | p95 over 30 days into IDLE/DOWNSIZE/UPSIZE. Reports only; resizing needs a reboot. |
| `azure_resource_stack.yml` | A full stack from one spec with safe defaults. Public ingress and public blob access each need an explicit override. |
| `azure_vm_baseline.yml` | Standard VM: managed identity, no public IP, deny-all NSG, monitoring agent. |
| `aks_nodepool_upgrade.yml` | Control plane first, then node pools with user pools before system pools, verifying workloads rescheduled. |
| `aks_workload_health.yml` | Same shared role as the OpenStack and Nexus checks, so findings compare directly. |

## Everything else

| | |
| --- | --- |
| `ceph_osd_throttle.py` | Recovery throttle profiles with a restore point. Won't raise pressure on an unhealthy cluster. |
| `pure_upgrade_preflight.py` | Token expiry and VIP reachability from the hosts that matter, plus multipath and controller state. Both of the usual reasons an upgrade gets aborted. |
| `firmware_validate.yml` | Firmware against a per-model baseline, including mismatched versions across NICs on the same driver. |
| `calico_gnp_update.yml` | Back up, validate all, apply in order, verify DNS, roll back automatically if it broke. |
| `calico_policy_audit.py` | Uncovered namespaces, shadowed policies, duplicate orders, default-deny with no DNS exception. |
| `cert_rotation.yml` | Validates the new certificate before replacing the old one. Key match, SAN coverage, per-endpoint verification, rollback. |
| `sentinelone_agent_monitor.py` | Console against real inventory, so hosts with no agent at all show up. |
| `ntp_health_check.py` | Chrony reachability register for intermittent UDP/123 loss, plus cross-host skew. |
| `compute_migration_dag.py` | Migration waves in Airflow, shelling out to these same scripts so the manual and automated paths can't drift. |

`common/ansible/roles/k8s_workload_health` is shared between the OpenStack-on-K8s,
Nexus and AKS playbooks. Once the platform is Kubernetes the failure modes are the
same, so it's written once and parameterised.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
ansible-galaxy collection install kubernetes.core ansible.posix community.general \
  community.crypto openstack.cloud azure.azcollection
```

Auth is whatever the platform normally uses:

```bash
export OS_CLOUD=dfw-prod                      # clouds.yaml entry, or a sourced openrc
az login                                      # or a service principal / managed identity
export AZURE_SUBSCRIPTION_ID=... NEXUS_RESOURCE_GROUP=...
export K8S_AUTH_KUBECONFIG=/path/to/kubeconfig
```

Nothing changes state without an explicit flag, so a read-only report is a safe
first run:

```bash
./openstack/python/upgrade_preflight.py
./azure/operator-nexus/python/nexus_bmm_health.py --maintenance-readiness
```

## Conventions

Same contract everywhere, so there's one set of habits to learn:

- `--dry-run` on anything that mutates, and it prints the actual plan
- confirmation before destructive work, refused without a TTY unless `--yes`
- `--format json` on every report
- exit codes: 0 clean, 1 warnings, 2 blocking
- health checks never restart anything, so they stay safe mid-incident. Recovery
  lives in separate playbooks
- blast radius is bounded: the Nexus maintenance driver won't run without
  `--rack` or `--machine`, the drain won't run without capacity headroom

## Notes

No credentials, hostnames or tenant identifiers from any employer environment are
in here. Inventories are templates and site-specific values are variables with
neutral defaults. There's a CI job that fails the build if that changes.

A few things need real values before they'll do anything useful at your site: the
firmware baseline in `firmware_validate.yml`, the Purity versions in the Pure
pre-flight, and the Log Analytics table names in the KQL, which assume the
standard Nexus diagnostic settings.

Tests build real openstacksdk and azure-mgmt model objects rather than mocks, so
an SDK renaming a field fails the build instead of showing up as an empty report
against a live cloud. That has already caught a few: `SubscriptionClient` moving
out of `azure-mgmt-resource`, the Nexus SDK nesting everything under
`.properties` in 3.x, and Nova dropping the hypervisor capacity fields at
microversion 2.88.

```bash
ruff check . && yamllint . && ansible-lint && pytest tests/ -q
```

MIT.
