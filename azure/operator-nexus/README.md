# Azure Operator Nexus automation

Automation for the bare metal layer of [Azure Operator Nexus](https://learn.microsoft.com/en-us/azure/operator-nexus/overview) —
fleet health, disk and network audits, and the quarterly maintenance window.

Everything here talks to the **Network Cloud resource provider**
(`Microsoft.NetworkCloud`) rather than the classic compute provider, because that
is the only sanctioned control path to a bare metal machine. There is no SSH path
into a rack in these scripts; on-machine inspection goes through
`begin_run_read_commands`, which the platform restricts to an allow list of
read-only commands.

## Prerequisites

```bash
pip install -r ../../requirements.txt
ansible-galaxy collection install kubernetes.core azure.azcollection

az login
export AZURE_SUBSCRIPTION_ID=<subscription>
export NEXUS_RESOURCE_GROUP=<resource group holding the BMMs>
export K8S_AUTH_KUBECONFIG=<nexus kubernetes kubeconfig>   # for the k8s playbooks
```

Permissions: the read scripts need **Reader** on the cluster resource group. The
maintenance driver needs the Network Cloud power and cordon actions — grant these
through a narrow custom role (a "Nexus Maintenance Operator") rather than a broad
Contributor assignment.

## The quarterly maintenance window

The whole window, start to finish:

```bash
# 1. Days before — is the rack even in a state to be worked on?
./python/nexus_bmm_health.py --rack rack-03 --maintenance-readiness
./python/nexus_disk_network_audit.py --rack rack-03 --min-severity WARN

# 2. Rehearse the exact plan. Changes nothing.
ansible-playbook ansible/nexus_quarterly_maintenance.yml \
    -e rack=rack-03 -e change_id=CHG0041827 --check

# 3. Window opens — take the machines down.
ansible-playbook ansible/nexus_quarterly_maintenance.yml \
    -e rack=rack-03 -e change_id=CHG0041827 -e phase=shutdown

# 4. Hardware team does the physical work.

# 5. Bring them back and prove nothing regressed.
ansible-playbook ansible/nexus_quarterly_maintenance.yml \
    -e rack=rack-03 -e change_id=CHG0041827 -e phase=restore
```

The five stages the playbook runs:

| Stage | What happens | Why |
| --- | --- | --- |
| Pre-flight | BMM fleet health, disk/network audit, Kubernetes health, explicit GO/NO-GO | A NO-GO stops the window before anything is touched |
| Snapshot | Pre-maintenance state written to `reports/<change>-<rack>-pre.json` | Pre-existing findings are recorded so they are never mistaken for maintenance damage |
| Shutdown | Cordon (evacuating tenant workloads) → power off, one machine at a time | Rack headroom is re-checked immediately before every single power-off |
| Restore | Power on → wait Ready → uncordon → verify | Every transition is polled to completion, never assumed |
| Post-flight | Re-run every check and **diff against the snapshot** | Proves nothing regressed, rather than merely looking green |

### If the window is interrupted

Progress is journalled to `state/<change_id>.json` after every step. Re-running
resumes from where it stopped — completed steps are skipped, not repeated:

```bash
./python/nexus_bmm_maintenance.py --resume state/CHG0041827.json --rack rack-03
```

### Safety properties

- **One machine at a time.** Never parallel, never a whole rack at once.
- **Rack floor enforced twice** — at pre-flight, and again immediately before each
  power-off, because the fleet can change during a long window.
- **Cordon evacuates first** when the machine hosts tenant VMs.
- **Graceful shutdown by default**; `--skip-shutdown` is a deliberate opt-in for a
  hung machine.
- **Bounded blast radius**: the driver refuses to run without `--rack` or
  `--machine`.
- **Out of scope on purpose**: `begin_replace` and any reimaging. Those are not
  things an automated loop should do unattended.

## Day-to-day operations

```bash
# Fleet state, summarised per rack
./python/nexus_bmm_health.py

# Only what's broken, as JSON for a ticket or a pipeline
./python/nexus_bmm_health.py --unhealthy-only --format json

# Hardware audit on one machine, control-plane view only (no on-machine commands)
./python/nexus_disk_network_audit.py --machine bmm-r03-s04 --control-plane-only

# Kubernetes health correlated with the bare metal underneath it
ansible-playbook ansible/nexus_k8s_cluster_health.yml
```

That last one exists because a NotReady node and an unhealthy BMM are the same
incident seen from two layers. The playbook joins them and tells you which layer
to work on:

| Node | BMM | Diagnosis |
| --- | --- | --- |
| NotReady | powered off | expected — the machine is down for maintenance |
| NotReady | unhealthy | hardware first; the node will follow |
| NotReady | healthy | kubelet, CNI or the node itself — not the hardware |

## Monitoring

Import [`workbooks/bmm-fleet-health.workbook.json`](workbooks/bmm-fleet-health.workbook.json)
into Azure Monitor (**Workbooks → New → Advanced Editor → paste → Apply**), then
pick a subscription and Log Analytics workspace. It gives you fleet tiles, rack
GO/NO-GO readiness, machines needing attention, node ↔ BMM correlation, disk and
network pressure, and the full power/cordon audit trail with callers.

The underlying queries are in [`kql/bmm_health_signals.kql`](kql/bmm_health_signals.kql),
commented and standalone so they can be lifted into alert rules. Table names
assume the standard Nexus diagnostic-settings routing plus Container Insights;
adjust if your diagnostic settings use custom destinations.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Clean |
| 1 | Warnings, or a maintenance step failed |
| 2 | Blocking failure — machines not ready, NO-GO on readiness, or nothing in scope |

These are stable, so any script here can gate a pipeline stage or a change task.
