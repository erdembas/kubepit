import { useLocaleMemo as useMemo } from '@/i18n';
import { ipc } from '@/lib/ipc';
import { BUILTIN, isServed, toGvk } from '@/lib/kube/catalog';
import { podSpecOwners } from '@/lib/kube/pss';
import { TRIVY_CHART, trivyGvk, type TrivyKind } from '@/lib/kube/trivy';
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { hasListError } from '../data/listState';
import { usePolled } from '../data/polled';
import { restartWatch, useWatch, type WatchSnapshot } from '../data/watchCache';
import { trivyOperatorKey } from './trivyInstall';

/** Shared watches of the Security view and the security details sections. */

export interface ListState {
  gvk: Gvk;
  snap: WatchSnapshot;
}

function settled(lists: readonly ListState[]) {
  return lists.every((l) => l.snap.synced || l.snap.status === 'error');
}

/** Report kinds the overview reads (SBOMs are large and only shown in their own table). */
export const OVERVIEW_KINDS = [
  'VulnerabilityReport',
  'ClusterVulnerabilityReport',
  'ConfigAuditReport',
  'ClusterConfigAuditReport',
  'ExposedSecretReport',
  'RbacAssessmentReport',
  'ClusterRbacAssessmentReport',
  'InfraAssessmentReport',
  'ClusterInfraAssessmentReport',
  'ClusterComplianceReport',
] as const satisfies readonly TrivyKind[];

export type OverviewKind = (typeof OVERVIEW_KINDS)[number];

export interface TrivyData {
  items: Record<OverviewKind, readonly KubeObject[]>;
  lists: ListState[];
  synced: boolean;
  errors: ListState[];
  restart: () => void;
}

export function useTrivyReports(
  clusterId: ClusterId,
  apiResources: readonly ApiResourceInfo[] | null,
  namespaces: string[],
  enabled: boolean,
): TrivyData {
  const gvks = useMemo(() => {
    const out = {} as Record<OverviewKind, Gvk | null>;
    for (const k of OVERVIEW_KINDS) out[k] = trivyGvk(k, apiResources);
    return out;
  }, [apiResources]);
  // One hook per kind keeps the hook order stable; unserved kinds watch nothing.
  const snaps: Record<OverviewKind, WatchSnapshot> = {
    VulnerabilityReport: useWatch(clusterId, gvks.VulnerabilityReport, namespaces, enabled),
    ClusterVulnerabilityReport: useWatch(
      clusterId,
      gvks.ClusterVulnerabilityReport,
      namespaces,
      enabled,
    ),
    ConfigAuditReport: useWatch(clusterId, gvks.ConfigAuditReport, namespaces, enabled),
    ClusterConfigAuditReport: useWatch(
      clusterId,
      gvks.ClusterConfigAuditReport,
      namespaces,
      enabled,
    ),
    ExposedSecretReport: useWatch(clusterId, gvks.ExposedSecretReport, namespaces, enabled),
    RbacAssessmentReport: useWatch(clusterId, gvks.RbacAssessmentReport, namespaces, enabled),
    ClusterRbacAssessmentReport: useWatch(
      clusterId,
      gvks.ClusterRbacAssessmentReport,
      namespaces,
      enabled,
    ),
    InfraAssessmentReport: useWatch(clusterId, gvks.InfraAssessmentReport, namespaces, enabled),
    ClusterInfraAssessmentReport: useWatch(
      clusterId,
      gvks.ClusterInfraAssessmentReport,
      namespaces,
      enabled,
    ),
    ClusterComplianceReport: useWatch(clusterId, gvks.ClusterComplianceReport, namespaces, enabled),
  };
  const lists: ListState[] = OVERVIEW_KINDS.filter((k) => gvks[k]).map((k) => ({
    gvk: gvks[k]!,
    snap: snaps[k],
  }));
  const items = {} as Record<OverviewKind, readonly KubeObject[]>;
  for (const k of OVERVIEW_KINDS) items[k] = gvks[k] ? snaps[k].items : [];
  return {
    items,
    lists,
    synced: lists.length > 0 && settled(lists),
    errors: lists.filter((l) => hasListError(l.snap) && l.snap.error),
    restart: () => lists.forEach((l) => restartWatch(clusterId, l.gvk, namespaces)),
  };
}

/**
 * `true` when no Trivy Operator Deployment exists although its CRDs are
 * served: helm keeps a chart's CRDs after a failed install or an uninstall,
 * and then no report ever arrives. Looked up by the label the chart and the
 * static manifests put on it; an unknown answer (RBAC, errors) is not "missing".
 */
export function useTrivyOperatorMissing(clusterId: ClusterId, enabled: boolean): boolean {
  const state = usePolled(
    enabled ? trivyOperatorKey(clusterId) : null,
    () =>
      ipc
        .resourceList(
          clusterId,
          toGvk(BUILTIN.Deployment),
          null,
          `app.kubernetes.io/name=${TRIVY_CHART}`,
        )
        .then((list) => list.items.length === 0),
    30_000,
    enabled,
  );
  return enabled && state.data === true;
}

const WORKLOAD_KINDS = [
  ['pods', BUILTIN.Pod],
  ['deployments', BUILTIN.Deployment],
  ['statefulSets', BUILTIN.StatefulSet],
  ['daemonSets', BUILTIN.DaemonSet],
  ['jobs', BUILTIN.Job],
  ['cronJobs', BUILTIN.CronJob],
] as const;

export interface OwnersData {
  owners: KubeObject[];
  namespaces: readonly KubeObject[];
  synced: boolean;
  errors: ListState[];
}

/**
 * Pod-spec owners (workload templates and bare pods) in `namespaces`, plus
 * the Namespace objects (their Pod Security labels).
 */
export function usePodSpecOwners(
  clusterId: ClusterId,
  apiResources: readonly ApiResourceInfo[] | null,
  namespaces: string[],
  enabled: boolean,
): OwnersData {
  const gvks = useMemo(
    () =>
      Object.fromEntries(
        [...WORKLOAD_KINDS, ['namespaces', BUILTIN.Namespace] as const].map(([k, def]) => [
          k,
          isServed(def, apiResources) ? toGvk(def) : null,
        ]),
      ) as Record<(typeof WORKLOAD_KINDS)[number][0] | 'namespaces', Gvk | null>,
    [apiResources],
  );
  const pods = useWatch(clusterId, gvks.pods, namespaces, enabled);
  const deployments = useWatch(clusterId, gvks.deployments, namespaces, enabled);
  const statefulSets = useWatch(clusterId, gvks.statefulSets, namespaces, enabled);
  const daemonSets = useWatch(clusterId, gvks.daemonSets, namespaces, enabled);
  const jobs = useWatch(clusterId, gvks.jobs, namespaces, enabled);
  const cronJobs = useWatch(clusterId, gvks.cronJobs, namespaces, enabled);
  const nsList = useWatch(clusterId, gvks.namespaces, [], enabled);
  const owners = useMemo(
    () =>
      podSpecOwners({
        pods: pods.items,
        deployments: deployments.items,
        statefulSets: statefulSets.items,
        daemonSets: daemonSets.items,
        jobs: jobs.items,
        cronJobs: cronJobs.items,
      }),
    [
      pods.items,
      deployments.items,
      statefulSets.items,
      daemonSets.items,
      jobs.items,
      cronJobs.items,
    ],
  );
  const lists: ListState[] = [
    { gvk: gvks.pods, snap: pods },
    { gvk: gvks.deployments, snap: deployments },
    { gvk: gvks.statefulSets, snap: statefulSets },
    { gvk: gvks.daemonSets, snap: daemonSets },
    { gvk: gvks.jobs, snap: jobs },
    { gvk: gvks.cronJobs, snap: cronJobs },
    { gvk: gvks.namespaces, snap: nsList },
  ].filter((l): l is ListState => !!l.gvk);
  return {
    owners,
    namespaces: nsList.items,
    synced: settled(lists),
    errors: lists.filter((l) => hasListError(l.snap) && l.snap.error),
  };
}
