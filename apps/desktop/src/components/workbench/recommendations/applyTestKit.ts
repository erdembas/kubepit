import type { ClusterDef, DryRunResult, KubeObject, WorkloadRecommendation } from '@/types';
import { MiB, container, recommend, workload } from './testFixtures';

/** Clusters, workloads and live objects for the apply-flow tests (never bundled). */

export function clusterDef(over: Partial<ClusterDef> = {}): ClusterDef {
  return {
    id: 'c1',
    name: 'dev',
    read_only: false,
    environment: 'development',
    ...over,
  } as ClusterDef;
}

/** A high-confidence over-provisioned Deployment: `app` 500m / 512Mi → 200m / 256Mi. */
export function oneClickRow(name = 'web', over: Partial<WorkloadRecommendation> = {}) {
  const app = recommend(container('app', [500, 512 * MiB], { cpu_p95: 100 }), [200, 256 * MiB]);
  return workload(name, [app], { verdict: 'over', monthly_delta: -12, ...over });
}

/** The live workload `rec` was computed against (optionally edited since). */
export function liveOf(
  rec: WorkloadRecommendation,
  requests: { cpu?: string; memory?: string } = { cpu: '500m', memory: '512Mi' },
  metadata: Partial<KubeObject['metadata']> = {},
): KubeObject {
  const podSpec = {
    containers: rec.containers.map((c) => ({
      name: c.name,
      image: 'app:1',
      resources: { requests },
    })),
  };
  return {
    apiVersion: rec.kind === 'CronJob' ? 'batch/v1' : 'apps/v1',
    kind: rec.kind,
    metadata: { name: rec.name, namespace: rec.namespace, uid: rec.uid, ...metadata },
    spec:
      rec.kind === 'CronJob'
        ? { jobTemplate: { spec: { template: { spec: podSpec } } } }
        : { template: { spec: podSpec } },
  } as KubeObject;
}

export function dryRunOf(live: KubeObject): DryRunResult {
  return {
    api_version: live.apiVersion,
    kind: live.kind,
    name: live.metadata.name,
    namespace: live.metadata.namespace ?? null,
    operation: 'update',
    live,
    result: live,
    error: null,
  };
}
