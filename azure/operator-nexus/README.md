# Operator Nexus

Bare metal automation for [Azure Operator Nexus](https://learn.microsoft.com/en-us/azure/operator-nexus/overview):
fleet health, disk and network audits, and the quarterly maintenance window.

Everything goes through the Network Cloud resource provider
(`Microsoft.NetworkCloud`) rather than the classic compute provider. There is no
SSH path into a rack in any of this; on-machine inspection uses
`begin_run_read_commands`, which the platform restricts to an allow list of
read-only commands.

## Setup

```bash
pip install -r ../../requirements.txt
ansible-galaxy collection install kubernetes.core azure.azcollection

az login
export AZURE_SUBSCRIPTION_ID=<subscription>
export NEXUS_RESOURCE_GROUP=<rg holding the BMMs>
export K8S_AUTH_KUBECONFIG=<nexus kubernetes kubeconfig>
```

Reader on the cluster resource group covers the read scripts. The maintenance
driver additionally needs the Network Cloud power and cordon actions. Worth
putting those in a narrow custom role rather than handing out Contributor.

## Quarterly window

```bash
# days before: is the rack in a state to be worked on at all?
./python/nexus_bmm_health.py --rack rack-03 --maintenance-readiness
./python/nexus_disk_network_audit.py --rack rack-03 --min-severity WARN

# rehearse. changes nothing.
ansible-playbook ansible/nexus_quarterly_maintenance.yml \
    -e rack=rack-03 -e change_id=CHG0041827 --check

# window opens
ansible-playbook ansible/nexus_quarterly_maintenance.yml \
    -e rack=rack-03 -e change_id=CHG0041827 -e phase=shutdown

# ... hardware team does the physical work ...

ansible-playbook ansible/nexus_quarterly_maintenance.yml \
    -e rack=rack-03 -e change_id=CHG0041827 -e phase=restore
```

The playbook runs five stages:

1. **Pre-flight.** Fleet health, disk/network audit, Kubernetes health, and a
   GO/NO-GO. A NO-GO stops before anything is touched.
2. **Snapshot.** Written to `reports/<change>-<rack>-pre.json`. This is the bit
   that stops pre-existing hardware findings getting blamed on the maintenance.
3. **Shutdown.** Cordon (evacuating tenant workloads), then power off, one
   machine at a time. Rack headroom is re-checked immediately before each
   power-off, not just once at the start, because the fleet can change during a
   long window.
4. **Restore.** Power on, wait Ready, uncordon, verify. Every transition is
   polled, never assumed.
5. **Post-flight.** Re-run the checks and diff against the snapshot.

Splitting shutdown and restore means the machines can stay down as long as the
physical work needs.

### If it gets interrupted

State is journalled to `state/<change_id>.json` after each step. Re-running skips
what already completed:

```bash
./python/nexus_bmm_maintenance.py --resume state/CHG0041827.json --rack rack-03
```

### Constraints worth knowing

One machine at a time, never a whole rack. Graceful shutdown by default;
`--skip-shutdown` is there for a hung machine and is a deliberate choice. The
driver refuses to run without `--rack` or `--machine`. `begin_replace` and
reimaging are out of scope on purpose, since neither belongs in an unattended
loop.

## Day to day

```bash
./python/nexus_bmm_health.py                                 # per-rack summary
./python/nexus_bmm_health.py --unhealthy-only --format json  # for a ticket
./python/nexus_disk_network_audit.py --machine bmm-r03-s04 --control-plane-only
ansible-playbook ansible/nexus_k8s_cluster_health.yml
```

That last one exists because a NotReady node and an unhealthy BMM are usually
the same incident seen from two layers. It joins them and says which layer to
work on:

| Node | BMM | What it means |
| --- | --- | --- |
| NotReady | powered off | expected, machine is down for maintenance |
| NotReady | unhealthy | hardware first, the node will follow |
| NotReady | healthy | kubelet, CNI or the node itself |

## Monitoring

Import `workbooks/bmm-fleet-health.workbook.json` via Workbooks > New > Advanced
Editor, then pick a subscription and workspace. Gives fleet tiles, rack GO/NO-GO,
machines needing attention, node/BMM correlation, disk and network pressure, and
the power/cordon audit trail with callers.

The queries are in `kql/bmm_health_signals.kql` if you'd rather lift them into
alert rules. Table names assume the standard Nexus diagnostic settings routing
plus Container Insights, so adjust if yours go somewhere custom.

## Exit codes

0 clean, 1 warnings or a failed step, 2 blocking (not ready, NO-GO, or nothing in
scope). Stable, so these can gate a pipeline stage or a change task.
