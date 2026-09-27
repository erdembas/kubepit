import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import { podStatus } from '@/lib/kube/pods';
import type { ClusterOverview } from '@/types';
import { list, type ClusterDb } from './db';
import { nodeMetrics } from './discovery';
import { warningEvents } from './events';

/** `cluster_overview` computed from the fixtures so every screen agrees. */
export function overviewFor(
  db: ClusterDb,
  version: string | null,
  platform: string | null,
): ClusterOverview {
  const nodes = list(db, 'nodes');
  const pods = list(db, 'pods');
  const ready = nodes.filter((n) =>
    (n.status?.conditions as Array<{ type: string; status: string }> | undefined)?.some(
      (c) => c.type === 'Ready' && c.status === 'True',
    ),
  );
  const sum = (key: 'capacity' | 'allocatable') => {
    let cpu = 0;
    let mem = 0;
    let podsCap = 0;
    for (const n of nodes) {
      const r = (n.status?.[key] ?? {}) as Record<string, string>;
      cpu += cpuMillicores(r.cpu);
      mem += memoryBytes(r.memory);
      podsCap += Number(r.pods ?? 0);
    }
    return { cpu_millicores: cpu, memory_bytes: mem, pods: podsCap };
  };
  let reqCpu = 0;
  let reqMem = 0;
  let limCpu = 0;
  let limMem = 0;
  const phases = {
    total: pods.length,
    running: 0,
    pending: 0,
    failed: 0,
    succeeded: 0,
    unknown: 0,
  };
  for (const p of pods) {
    const phase = String(p.status?.phase ?? 'Unknown');
    const status = podStatus(p);
    if (phase === 'Running' && !/CrashLoop|Error/.test(status)) phases.running++;
    else if (phase === 'Pending') phases.pending++;
    else if (phase === 'Succeeded') phases.succeeded++;
    else if (phase === 'Failed' || /CrashLoop|Error/.test(status)) phases.failed++;
    else phases.unknown++;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    for (const c of (p.spec?.containers as Array<{
      resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
    }>) ?? []) {
      reqCpu += cpuMillicores(c.resources?.requests?.cpu);
      reqMem += memoryBytes(c.resources?.requests?.memory);
      limCpu += cpuMillicores(c.resources?.limits?.cpu ?? c.resources?.requests?.cpu);
      limMem += memoryBytes(c.resources?.limits?.memory ?? c.resources?.requests?.memory);
    }
  }
  const deployments = list(db, 'deployments.apps');
  const metrics = nodeMetrics(db);
  return {
    version,
    platform,
    nodes: { total: nodes.length, ready: ready.length },
    pods: phases,
    namespaces: list(db, 'namespaces').length,
    deployments: {
      total: deployments.length,
      available: deployments.filter(
        (d) => Number(d.status?.availableReplicas ?? 0) >= Number(d.spec?.replicas ?? 1),
      ).length,
    },
    capacity: sum('capacity'),
    allocatable: sum('allocatable'),
    requests: { cpu_millicores: reqCpu, memory_bytes: reqMem },
    limits: { cpu_millicores: limCpu, memory_bytes: limMem },
    usage: metrics.available
      ? {
          cpu_millicores: metrics.items.reduce((s, m) => s + m.cpu_millicores, 0),
          memory_bytes: metrics.items.reduce((s, m) => s + m.memory_bytes, 0),
        }
      : null,
    warnings: warningEvents(db),
  };
}
