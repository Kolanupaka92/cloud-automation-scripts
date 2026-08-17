# cloud-automation-scripts

Production-shaped automation for the platforms I operate day to day: **OpenStack**,
**Azure Operator Nexus**, **Azure**, and the **Kubernetes** layer that now runs on
top of all three.

These are not snippets. Every script is written the way infrastructure automation
has to be written when it runs against a live estate at 02:00: dry-run by default
where it matters, explicit confirmation before anything destructive, pre-flight
capacity and headroom checks, polling to completion instead of fire-and-forget,
resumable state for long maintenance windows, and machine-readable output so any
of it can be wired into a pipeline or an alert.

## Repository layout

```
openstack/
  python/                  Nova, Neutron, Cinder and Placement operations
  ansible/                 fleet health, compute maintenance, hardening, drift
azure/
  operator-nexus/          bare metal machine lifecycle, audits, workbooks
    python/                BMM health, quarterly maintenance, disk/network audit
    ansible/               end-to-end maintenance window orchestration
    workbooks/             Azure Monitor workbook (importable JSON)
    kql/                   the queries behind the workbook
  python/                  classic Azure: orphaned resources, NSG audit, AKS, rightsizing
  ansible/                 resource stack, VM baseline, AKS upgrades and health
storage/python/            Ceph OSD throttles, Pure Storage upgrade pre-flight
kubernetes/                Calico GlobalNetworkPolicy updates and policy audit
hardware/ansible/          firmware validation against an approved baseline
security/                  certificate rotation, SentinelOne agent coverage
network/python/            NTP health and packet-loss diagnosis
airflow/dags/              migration waves as scheduled, resumable work
common/
  ansible/roles/           shared roles used by more than one platform
```

## What's here

### OpenStack

| Script | What it does |
| --- | --- |
| [`hypervisor_capacity_report.py`](openstack/python/hypervisor_capacity_report.py) | Capacity and overcommit per compute node, using Placement allocation ratios so the numbers match what the scheduler believes. Answers "how many more `m1.large` fit in this region". |
| [`orphaned_resource_audit.py`](openstack/python/orphaned_resource_audit.py) | Finds volumes, snapshots, floating IPs, ports and images nobody owns any more, with opt-in reclamation. |
| [`compute_node_drain.py`](openstack/python/compute_node_drain.py) | Drains a compute node for maintenance: pre-flight capacity check, disable the service with an auditable reason, live-migrate one instance at a time polling each to completion, report what could not move. |
| [`security_group_audit.py`](openstack/python/security_group_audit.py) | Ranks security group rules by real exposure — world-open admin ports first — and can gate a pipeline. |
| [`upgrade_preflight.py`](openstack/python/upgrade_preflight.py) | The gate I run before every maintenance window: service liveness, version skew, stuck instances/volumes, orphaned migrations, quota headroom, and whether enough capacity exists to drain N hosts at once. |
| [`prometheus_exporter.py`](openstack/python/prometheus_exporter.py) | Custom exporter for the cloud-level signals the node exporters miss: service and agent liveness, scheduler-visible capacity, instance/volume state backlogs, floating IP pool depletion. |
| [`orphaned_instance_cleanup.py`](openstack/python/orphaned_instance_cleanup.py) | Reconciles Nova against libvirt on a compute node in both directions: domains running that Nova has no record of (silently overcommitting the host), instances Nova thinks are ACTIVE with no domain (a tenant outage nobody has noticed), and stale instance directories. |
| [`compute_node_decommission.py`](openstack/python/compute_node_decommission.py) | Removes a node for good — aggregates, Nova services, Neutron agents and the Placement resource provider — then verifies nothing is left. Placement is the stage everyone forgets and the one that breaks scheduling months later. |
| [`numa_topology_audit.py`](openstack/python/numa_topology_audit.py) | NUMA, CPU pinning and hugepage audit: pins landing outside `cpu_dedicated_set`, a dedicated set with no `isolcpus`, memory spanning sockets, hugepages allocated on only one node, unpinned emulator threads. All invisible to normal monitoring. |
| [`network_onboarding.py`](openstack/python/network_onboarding.py) | Creates a tenant or provider network from a declarative YAML spec, validating everything first: VLAN free on the physical network, CIDR non-overlapping, pools inside the CIDR and clear of the gateway, MTU consistent with the segment. Idempotent and reversible. |
| [`vmware_to_openstack_migrate.py`](openstack/python/vmware_to_openstack_migrate.py) | Per-VM VMware migration in journalled phases (assess → snapshot → export → convert → upload → provision → validate → cutover), preserving MAC and IP, picking a fitting flavor, and resumable with `--resume`. The source VM is powered off, never deleted. |

| Playbook | What it does |
| --- | --- |
| [`openstack_service_health.yml`](openstack/ansible/openstack_service_health.yml) | Read-only region sweep — systemd units, RabbitMQ, Galera quorum, libvirt, OVS, disk — into one consolidated JSON report. Safe during an active incident. |
| [`openstack_k8s_pods_health.yml`](openstack/ansible/openstack_k8s_pods_health.yml) | For OpenStack-Helm / Kolla-on-Kubernetes: every service Deployment, DaemonSet and StatefulSet, plus Galera quorum and RabbitMQ, checked from inside the cluster. |
| [`openstack_k8s_service_restart.yml`](openstack/ansible/openstack_k8s_service_restart.yml) | Rolling restart of one OpenStack service pod set, refusing to touch an already-degraded service, honouring the disruption budget, waiting for real convergence, verifying the API afterwards. |
| [`compute_node_maintenance.yml`](openstack/ansible/compute_node_maintenance.yml) | Drain → patch → reboot → verify → return to service, one host at a time, driven from a change record. Reuses `compute_node_drain.py` so migration logic lives in one place. |
| [`linux_hardening.yml`](openstack/ansible/linux_hardening.yml) | Security baseline with validated SSH config, sysctl hardening, audit rules, and a post-check that proves the settings are live. |
| [`config_drift_detect.yml`](openstack/ansible/config_drift_detect.yml) | Detects drift against a committed baseline — checksums, declared config values, boot-enabled services. Detection only; unexplained drift is an investigation, not something to silently overwrite. |

### Azure Operator Nexus

[Operator Nexus](https://learn.microsoft.com/en-us/azure/operator-nexus/overview) is
the hybrid platform running telco workloads on bare metal in the operator's own
datacentres. Everything below talks to the Network Cloud resource provider, which
is the only sanctioned control path to a bare metal machine.

| Script | What it does |
| --- | --- |
| [`nexus_bmm_health.py`](azure/operator-nexus/python/nexus_bmm_health.py) | Fleet report over every BMM: readyState, power, cordon, detailed status, hardware validation, tenant VMs hosted, backing Kubernetes node — summarised **per rack**, because the real question is never "is this machine healthy" but "can this rack lose one right now". Includes an explicit `--maintenance-readiness` GO/NO-GO gate. |
| [`nexus_bmm_maintenance.py`](azure/operator-nexus/python/nexus_bmm_maintenance.py) | The quarterly window, automated: cordon (evacuating tenant workloads) → power off → hold → power on → wait Ready → uncordon → verify. One machine at a time, rack headroom re-checked immediately before every power-off, every step journalled so an interrupted window resumes instead of restarting. `--phase shutdown` / `--phase restore` split the run around the hardware team's work. |
| [`nexus_disk_network_audit.py`](azure/operator-nexus/python/nexus_disk_network_audit.py) | Disk and network health from two angles: the control-plane view, and allow-listed read-only commands executed on the machine through the RP. Parses drive failures, degraded arrays, SMART pre-failure, filesystem pressure, link state, bond members, error/drop counters and MTU inconsistency. |

| Artifact | What it does |
| --- | --- |
| [`nexus_quarterly_maintenance.yml`](azure/operator-nexus/ansible/nexus_quarterly_maintenance.yml) | The whole window in five stages — pre-flight, snapshot, shutdown, restore, post-flight — where the post-check **diffs against the pre-snapshot**, so it proves nothing regressed rather than merely looking green. Pre-existing hardware findings are recorded up front and never mistaken for maintenance damage. |
| [`nexus_k8s_cluster_health.yml`](azure/operator-nexus/ansible/nexus_k8s_cluster_health.yml) | Nexus Kubernetes health correlated with the bare metal underneath, so a NotReady node immediately resolves to a rack, a slot and a power state. |
| [`bmm-fleet-health.workbook.json`](azure/operator-nexus/workbooks/bmm-fleet-health.workbook.json) | Importable Azure Monitor workbook: fleet tiles, rack GO/NO-GO readiness, machines needing attention, node ↔ BMM correlation, disk/network pressure, and a full power/cordon audit trail. |
| [`bmm_health_signals.kql`](azure/operator-nexus/kql/bmm_health_signals.kql) | The eight queries behind the workbook, standalone and commented for reuse in alerts. |

### Azure (classic) and AKS

| Script | What it does |
| --- | --- |
| [`orphaned_resource_audit.py`](azure/python/orphaned_resource_audit.py) | Unattached disks, unused public IPs and NICs, stale snapshots, orphaned NSGs — with estimated monthly and annual recoverable spend, and deletion that always skips anything tagged `DoNotDelete`. |
| [`nsg_audit.py`](azure/python/nsg_audit.py) | NSG exposure audit that resolves **effective** rules (merged subnet + NIC) where permitted, because authored rules are not what traffic actually hits. |
| [`aks_health_check.py`](azure/python/aks_health_check.py) | Fleet AKS report: version skew against the two-minor kubelet rule, upgrade availability, node pool resilience and zone spread, Spot backing a System pool, RBAC, network policy, public API server without authorized ranges. |
| [`vm_rightsizing.py`](azure/python/vm_rightsizing.py) | 30 days of Azure Monitor metrics, p95 rather than averages, into IDLE/DOWNSIZE/UPSIZE recommendations with estimated savings. Reports only — sizing changes need a reboot and belong in a window. |

| Playbook | What it does |
| --- | --- |
| [`azure_vm_baseline.yml`](azure/ansible/azure_vm_baseline.yml) | Standard VM with the baseline every workload should carry: managed identity, no public IP, deny-all-inbound NSG with management-only SSH, boot diagnostics, Azure Monitor agent. |
| [`aks_nodepool_upgrade.yml`](azure/ansible/aks_nodepool_upgrade.yml) | Controlled AKS upgrade: pre-flight gate, control plane first, then node pools with user pools before system pools, waiting for every node to report Ready on the target version, then verifying workloads rescheduled. |
| [`aks_workload_health.yml`](azure/ansible/aks_workload_health.yml) | Workload health using the same shared role as the OpenStack and Nexus checks, so findings are directly comparable across platforms. |
| [`azure_resource_stack.yml`](azure/ansible/azure_resource_stack.yml) | A whole application stack — resource group, VNet with per-subnet NSGs, storage, key vault, VMs, diagnostics — from one spec, with every default set to the safe option. Public ingress, public blob access and public network access each require an explicit, reviewable override. |

### Storage

| Script | What it does |
| --- | --- |
| [`ceph_osd_throttle.py`](storage/python/ceph_osd_throttle.py) | Sets Ceph recovery and backfill throttles from a named profile (emergency → aggressive), refuses to raise them while the cluster is unhealthy, writes a restore point before every change, and can watch recovery throughput afterwards so the effect is measured rather than assumed. |
| [`pure_upgrade_preflight.py`](storage/python/pure_upgrade_preflight.py) | Pure FlashArray pre-upgrade gate: API token validity and expiry (the check that saves a window from ending at minute one), VIP reachability probed **from the hosts that matter** rather than just the jump box, multipath redundancy per host, controller readiness, and version path sanity. |

### Hardware and firmware

| Playbook | What it does |
| --- | --- |
| [`firmware_validate.yml`](hardware/ansible/firmware_validate.yml) | Compares BIOS, BMC, NIC, RAID and disk firmware against a committed per-model baseline, and flags NICs on the same driver running mismatched firmware — the cause of one-sided packet loss that only appears under load. Remediation requires a change record and a drained host. |

### Kubernetes networking

| Artifact | What it does |
| --- | --- |
| [`calico_gnp_update.yml`](kubernetes/ansible/calico_gnp_update.yml) | GlobalNetworkPolicy updates done safely: back up first, validate all policies server-side before applying any, reject a default-deny with no DNS allow or an order intruding on the platform tier, apply in ascending order, verify DNS, and roll back automatically if it broke. |
| [`calico_policy_audit.py`](kubernetes/python/calico_policy_audit.py) | Finds what `kubectl get` cannot: namespaces with no policy at all, policies shadowed by an earlier catch-all deny, duplicate order values making evaluation arbitrary, match-all selectors, and default-deny egress with no DNS exception. |

### Security

| Artifact | What it does |
| --- | --- |
| [`cert_rotation.yml`](security/ansible/cert_rotation.yml) | Certificate rotation that validates the new material *before* replacing the old: not expired, key actually matches the certificate, SANs still cover every endpoint. Backs up what it replaces, verifies each endpoint serves the new cert, and rolls back with one flag. |
| [`sentinelone_agent_monitor.py`](security/python/sentinelone_agent_monitor.py) | Reconciles the SentinelOne console against the real infrastructure inventory, so hosts with no agent at all are visible — the gap a console-only view structurally cannot show. Also catches alert-only mitigation mode, stale check-ins, and (with `--verify-on-host`) consoles that claim healthy while the host disagrees. |

### Networking

| Script | What it does |
| --- | --- |
| [`ntp_health_check.py`](network/python/ntp_health_check.py) | Clock skew presents as something else entirely — flapping Ceph OSDs, rejected Kubernetes certificates, evicted Galera nodes. This reads chrony's reachability register to catch intermittent UDP/123 loss, plus stratum, offset, jitter, source redundancy, and the number that actually matters for a cluster: cross-host skew. |

### Orchestration

| Artifact | What it does |
| --- | --- |
| [`compute_migration_dag.py`](airflow/dags/compute_migration_dag.py) | An Airflow DAG turning a migration wave into scheduled, observable, resumable work: a region-wide pre-flight that short-circuits the wave if the cloud is unhealthy, one task group per host, a pool capping concurrent drains, per-stage retries (and deliberately none on drain), and a summary that fails unless every host finished. It shells out to the same scripts an operator runs by hand, so the manual and automated paths cannot drift. |

### Shared

[`k8s_workload_health`](common/ansible/roles/k8s_workload_health/) is one role used by
the OpenStack-on-Kubernetes, Nexus Kubernetes and AKS playbooks. Once the platform
is Kubernetes the failure modes are identical — pods not Ready, containers looping,
StatefulSet replicas missing, PVCs unbound, nodes NotReady — so it is written once
and parameterised per platform.

## Getting started

```bash
git clone https://github.com/Kolanupaka92/cloud-automation-scripts.git
cd cloud-automation-scripts
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
ansible-galaxy collection install kubernetes.core ansible.posix community.general openstack.cloud azure.azcollection
```

Authenticate for the platform you're targeting:

```bash
# OpenStack — clouds.yaml entry or a sourced openrc
export OS_CLOUD=dfw-prod

# Azure / Operator Nexus — DefaultAzureCredential resolves az login,
# a service principal, or managed identity with no code change
az login
export AZURE_SUBSCRIPTION_ID=... NEXUS_RESOURCE_GROUP=rg-nexus-prod

# Kubernetes
export K8S_AUTH_KUBECONFIG=/path/to/kubeconfig
```

Then start with a read-only report — nothing in this repository changes state
unless you pass an explicit flag:

```bash
./openstack/python/upgrade_preflight.py
./azure/operator-nexus/python/nexus_bmm_health.py --maintenance-readiness
```

## Conventions

Every script follows the same contract, so there is one set of habits to learn:

- **`--dry-run`** on anything that mutates, and it is meaningful — it prints the
  exact plan without touching the API.
- **Confirmation before destruction**, refused outright without a TTY unless
  `--yes` is passed, so a stray cron job cannot delete production.
- **`--format json`** on every report, for piping into `jq`, a pipeline gate, or
  another script in this repo.
- **Non-zero exit codes carry meaning** — typically `0` clean, `1` warnings,
  `2` blocking failures — so any of these can gate a change.
- **Bounded blast radius**: the Nexus maintenance driver refuses to run without
  `--rack` or `--machine`; the OpenStack drain refuses without capacity headroom.
- **Read-only by default**: health checks never restart anything, so they stay
  safe to run in the middle of an incident. Recovery lives in separate playbooks.

## Safety

No credentials, endpoints, hostnames or tenant identifiers from any employer's
environment appear in this repository. Inventories are templates, baselines are
placeholders, and every value that would be site-specific is a variable with a
neutral default. `.gitignore` and a CI secret-scan job keep it that way.

The destructive operations — resource deletion, power-off, drain, restart — are
written to be run by someone holding a change record, and they say so.

## Licence

MIT — see [LICENSE](LICENSE).
