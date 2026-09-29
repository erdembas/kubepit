import { ipc } from '@/lib/ipc';
import { controllerOf } from '@/lib/kube/accessors';
import { BUILTIN } from '@/lib/kube/kinds';
import { podContainers } from '@/lib/kube/pods';
import { labelSelectorString } from '@/lib/kube/selectorString';
import { useAlertStore } from '@/store/useAlertStore';
import { useAppStore } from '@/store/useAppStore';
import { useHealthStore } from '@/store/useHealthStore';
import type {
  AiContextSection,
  Alert,
  ChangeFilter,
  ChangeSummary,
  ClusterId,
  Gvk,
  KubeObject,
} from '@/types';
import {
  alertsSection,
  changesSection,
  containersSection,
  eventsSection,
  healthSection,
  logsSection,
  metricsSection,
  objectSection,
  scopeSection,
  worstPods,
} from './explain';

/**
 * I/O of the explain context: reads what the builders in `explain.ts` need
 * from the backend (pods, events, logs, the change timeline, metrics) and
 * from the stores (clusters, health scans, alerts). Every read is
 * best-effort: a failing one drops its section, never the whole request.
 * Nothing leaves the machine here; the backend redacts and budgets the
 * sections when the request is previewed.
 */

const LOG_TAIL_LINES = 500;
const LOG_TIMEOUT_MS = 10_000;
const MAX_CONTAINERS = 3;
const MAX_LOG_STREAMS = 4;
const CHANGES_WINDOW_MS = 24 * 3_600_000;
const POD_GVK: Gvk = (({ group, version, kind, plural, namespaced }) => ({
  group,
  version,
  kind,
  plural,
  namespaced,
}))(BUILTIN.Pod);

/**
 * The last 500 lines of one container (`previous`: its last terminated
 * instance), with the API server's timestamps. Resolves on `done`, on an
 * error, or after `timeoutMs` with what arrived, then stops the stream.
 */
export function collectPodLogs(
  clusterId: ClusterId,
  namespace: string,
  pod: string,
  container: string,
  previous: boolean,
  timeoutMs = LOG_TIMEOUT_MS,
): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let partial = '';
    let streamId: string | null = null;
    let finished = false;
    let timedOut = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (partial) lines.push(partial);
      partial = '';
      if (timedOut && streamId) void ipc.podLogsStop(streamId).catch(() => undefined);
      resolve(lines);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);
    ipc
      .podLogsStream(
        clusterId,
        namespace,
        pod,
        container,
        {
          follow: false,
          tail_lines: LOG_TAIL_LINES,
          since_seconds: null,
          timestamps: true,
          previous,
        },
        (chunk) => {
          if (finished) return;
          const parts = (partial + chunk.data).split('\n');
          partial = parts.pop() ?? '';
          lines.push(...parts.map((line) => line.replace(/\r$/, '')));
          if (chunk.done || chunk.error) finish();
        },
      )
      .then((id) => {
        streamId = id;
        if (finished && timedOut) void ipc.podLogsStop(id).catch(() => undefined);
      })
      .catch(finish);
  });
}

/** Runs `tasks` with at most `limit` in flight; results keep their order. */
async function limited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const settled = <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback);

/** Pods of a workload: its label selector, owned through its controller chain. */
async function workloadPods(clusterId: ClusterId, obj: KubeObject): Promise<KubeObject[]> {
  const selector = labelSelectorString(obj.spec?.selector);
  if (!selector) return [];
  const list = await ipc.resourceList(clusterId, POD_GVK, obj.metadata.namespace ?? null, selector);
  const name = obj.metadata.name;
  return list.items.filter((pod) => {
    const owner = controllerOf(pod);
    if (!owner) return false;
    if (owner.kind === obj.kind && owner.name === name) return true;
    // Deployment → ReplicaSet `<name>-<hash>` → pods.
    return (
      obj.kind === 'Deployment' && owner.kind === 'ReplicaSet' && owner.name.startsWith(`${name}-`)
    );
  });
}

/** Containers worth reading: restarting and not-ready ones first, at most three. */
function logContainers(pod: KubeObject) {
  return podContainers(pod)
    .filter((c) => !c.init || c.restarts > 0 || (c.state === 'terminated' && !!c.exitCode))
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) => b.c.restarts - a.c.restarts || Number(a.c.ready) - Number(b.c.ready) || a.i - b.i,
    )
    .slice(0, MAX_CONTAINERS)
    .map((x) => x.c);
}

async function logSections(clusterId: ClusterId, pods: KubeObject[]): Promise<AiContextSection[]> {
  const jobs: { pod: string; container: string; previous: boolean }[] = [];
  for (const pod of pods)
    for (const c of logContainers(pod)) {
      jobs.push({ pod: pod.metadata.name, container: c.name, previous: false });
      if (c.restarts > 0) jobs.push({ pod: pod.metadata.name, container: c.name, previous: true });
    }
  const namespaceOf = new Map(pods.map((p) => [p.metadata.name, p.metadata.namespace ?? '']));
  const logs = await limited(
    jobs.map(
      (j) => () =>
        collectPodLogs(clusterId, namespaceOf.get(j.pod) ?? '', j.pod, j.container, j.previous),
    ),
    MAX_LOG_STREAMS,
  );
  return jobs.flatMap((j, i) => {
    const section = logsSection(j.pod, j.container, j.previous, logs[i]!);
    return section ? [section] : [];
  });
}

async function eventsOf(
  clusterId: ClusterId,
  namespace: string | null,
  uids: string[],
): Promise<KubeObject[]> {
  const lists = await Promise.all(
    uids.map((uid) => settled(ipc.resourceEvents(clusterId, namespace, uid), [])),
  );
  return [...new Map(lists.flat().map((e) => [e.metadata.uid, e])).values()];
}

/** The object and its owner chain (a pod's ReplicaSet and that one's Deployment). */
function changeTargets(obj: KubeObject): { kind: string; name: string }[] {
  const targets = [{ kind: obj.kind, name: obj.metadata.name }];
  const owner = controllerOf(obj);
  if (owner) {
    targets.push({ kind: owner.kind, name: owner.name });
    const hash = obj.metadata.labels?.['pod-template-hash'];
    if (owner.kind === 'ReplicaSet' && hash && owner.name.endsWith(`-${hash}`))
      targets.push({ kind: 'Deployment', name: owner.name.slice(0, -(hash.length + 1)) });
  }
  return targets;
}

async function changesOf(clusterId: ClusterId, obj: KubeObject): Promise<ChangeSummary[]> {
  const since = Date.now() - CHANGES_WINDOW_MS;
  const namespace = obj.metadata.namespace;
  const pages = await Promise.all(
    changeTargets(obj).map((t) => {
      const filter: ChangeFilter = {
        namespaces: namespace ? [namespace] : [],
        kinds: [t.kind],
        name: t.name,
        text: null,
        since,
        until: null,
        limit: 50,
        cursor: null,
      };
      return settled(
        ipc.changesList(clusterId, filter).then((page) => page.entries),
        [] as ChangeSummary[],
      );
    }),
  );
  return [...new Map(pages.flat().map((c) => [`${c.cluster_id}:${c.id}`, c])).values()];
}

function alertsOf(clusterId: ClusterId, objects: KubeObject[]): Alert[] {
  const wanted = new Set(
    objects.map((o) => `${o.kind}|${o.metadata.namespace ?? ''}|${o.metadata.name}`),
  );
  return useAlertStore
    .getState()
    .alerts.filter(
      (a) =>
        a.cluster_id === clusterId &&
        wanted.has(`${a.object.kind}|${a.object.namespace ?? ''}|${a.object.name}`),
    );
}

/**
 * Every section of an "explain" request for a pod or a workload (spec §11):
 * scope, object, containers, events, logs, health, changes, alerts and
 * metrics. Workloads are explained through their three worst pods.
 */
export async function gatherExplainContext(
  clusterId: ClusterId,
  gvk: Gvk,
  obj: KubeObject,
): Promise<AiContextSection[]> {
  const app = useAppStore.getState();
  const cluster = app.clusters.find((c) => c.id === clusterId);
  const status = app.statuses[clusterId] ?? null;
  const namespace = obj.metadata.namespace ?? null;
  const isPod = gvk.group === '' && gvk.kind === 'Pod';
  const pods = isPod ? [obj] : worstPods(await settled(workloadPods(clusterId, obj), []));
  const objects = isPod ? [obj] : [obj, ...pods];
  const uids = [...new Set(objects.map((o) => o.metadata.uid))];

  const [events, logs, changes, metrics] = await Promise.all([
    eventsOf(clusterId, namespace, uids),
    logSections(clusterId, pods),
    changesOf(clusterId, obj),
    namespace && pods.length
      ? settled(ipc.metricsPods(clusterId, namespace), null)
      : Promise.resolve(null),
  ]);
  const byUid = useHealthStore.getState().scans[clusterId]?.byUid;
  const findings = uids.flatMap((uid) => byUid?.get(uid) ?? []);

  return [
    cluster ? scopeSection({ cluster, status, namespace, obj }) : null,
    objectSection(obj),
    containersSection(pods),
    eventsSection(events, `${obj.kind.toLowerCase()}/${obj.metadata.name}`),
    ...logs,
    healthSection(findings),
    changesSection(changes),
    alertsSection(alertsOf(clusterId, objects)),
    metrics?.available ? metricsSection(pods, metrics.items) : null,
  ].filter((s): s is AiContextSection => s !== null);
}
