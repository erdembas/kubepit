import { ipc } from '@/lib/ipc';
import { asString, condition, controllerOf } from '@/lib/kube/accessors';
import { BUILTIN, type KindDef } from '@/lib/kube/kinds';
import { podContainers, podStatus } from '@/lib/kube/pods';
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
 * All log reads share one deadline (12 s from the start), pods on a node
 * that is not Ready (or in phase Unknown) are not asked for logs, and an
 * `AbortSignal` stops everything at once. Nothing leaves the machine here;
 * the backend redacts and budgets the sections when the request is
 * previewed.
 */

const LOG_TAIL_LINES = 500;
const LOG_TIMEOUT_MS = 10_000;
/** Every log read of one gather ends by then. */
const LOG_BUDGET_MS = 12_000;
const MAX_CONTAINERS = 3;
const MAX_LOG_STREAMS = 4;
const CHANGES_WINDOW_MS = 24 * 3_600_000;

const gvkOf = ({ group, version, kind, plural, namespaced }: KindDef): Gvk => ({
  group,
  version,
  kind,
  plural,
  namespaced,
});
const POD_GVK = gvkOf(BUILTIN.Pod);
const JOB_GVK = gvkOf(BUILTIN.Job);
const NODE_GVK = gvkOf(BUILTIN.Node);

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Rejects as soon as `signal` aborts (the IPC call itself cannot be cancelled). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** `fallback` when the read fails; an abort still rejects. */
function soft<T>(promise: Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
  return abortable(promise, signal).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    return fallback;
  });
}

/**
 * The last 500 lines of one container (`previous`: its last terminated
 * instance), with the API server's timestamps. Resolves on `done`, on an
 * error, after `timeoutMs` or when `signal` aborts, with what arrived; the
 * last two stop the stream.
 */
export function collectPodLogs(
  clusterId: ClusterId,
  namespace: string,
  pod: string,
  container: string,
  previous: boolean,
  timeoutMs = LOG_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) return Promise.resolve([]);
  return new Promise((resolve) => {
    const lines: string[] = [];
    let partial = '';
    let streamId: string | null = null;
    let finished = false;
    let stopWanted = false;
    const stop = (id: string) => void ipc.podLogsStop(id).catch(() => undefined);
    const finish = (stopStream: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (partial) lines.push(partial);
      partial = '';
      stopWanted = stopStream;
      if (stopStream && streamId) stop(streamId);
      resolve(lines);
    };
    const onAbort = () => finish(true);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(true), timeoutMs);
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
          if (chunk.done || chunk.error) finish(false);
        },
      )
      .then((id) => {
        streamId = id;
        if (finished && stopWanted) stop(id);
      })
      .catch(() => finish(false));
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

/** Controlled by `owner`: directly, or a Deployment's pod through its exact ReplicaSet. */
function ownedBy(pod: KubeObject, owner: KubeObject): boolean {
  const ref = controllerOf(pod);
  if (!ref) return false;
  if (ref.kind === owner.kind && ref.name === owner.metadata.name) return true;
  const hash = pod.metadata.labels?.['pod-template-hash'];
  return (
    owner.kind === 'Deployment' &&
    ref.kind === 'ReplicaSet' &&
    !!hash &&
    ref.name === `${owner.metadata.name}-${hash}`
  );
}

async function ownedPods(
  clusterId: ClusterId,
  owner: KubeObject,
  signal?: AbortSignal,
): Promise<KubeObject[]> {
  const selector = labelSelectorString(owner.spec?.selector);
  if (!selector) return [];
  const list = await abortable(
    ipc.resourceList(clusterId, POD_GVK, owner.metadata.namespace ?? null, selector),
    signal,
  );
  return list.items.filter((pod) => ownedBy(pod, owner));
}

/** Pods of a workload; a CronJob's through the Jobs it owns. */
async function workloadPods(
  clusterId: ClusterId,
  obj: KubeObject,
  signal?: AbortSignal,
): Promise<KubeObject[]> {
  if (obj.kind !== 'CronJob') return ownedPods(clusterId, obj, signal);
  const jobs = await abortable(
    ipc.resourceList(clusterId, JOB_GVK, obj.metadata.namespace ?? null),
    signal,
  );
  const owned = jobs.items.filter((job) => {
    const ref = controllerOf(job);
    return ref?.kind === 'CronJob' && ref.name === obj.metadata.name;
  });
  const lists = await Promise.all(owned.map((job) => ownedPods(clusterId, job, signal)));
  return lists.flat();
}

/**
 * Why a pod's logs are not read: the kubelet of a node that is not Ready
 * (or a pod in phase Unknown) cannot serve them, and asking would only
 * wait for the timeout. Nodes that cannot be read (RBAC) count as fine.
 */
async function logSkips(
  clusterId: ClusterId,
  pods: KubeObject[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const nodes = [...new Set(pods.map((p) => asString(p.spec?.nodeName)).filter(Boolean))];
  const ready = new Map<string, boolean>();
  await Promise.all(
    nodes.map(async (name) => {
      const node = await soft(ipc.resourceGet(clusterId, NODE_GVK, null, name), null, signal);
      if (node?.metadata) ready.set(name, condition(node, 'Ready')?.status === 'True');
    }),
  );
  const notes = new Map<string, string>();
  for (const pod of pods) {
    const node = asString(pod.spec?.nodeName);
    if (asString(pod.status?.phase) === 'Unknown')
      notes.set(pod.metadata.name, 'logs not read: pod phase is Unknown');
    else if (node && ready.get(node) === false)
      notes.set(pod.metadata.name, `logs not read: node ${node} is not Ready`);
  }
  return notes;
}

/**
 * Containers worth reading, at most three: restarting and not-ready ones
 * first, init containers only when they failed or still run (the pod is
 * initializing, or a sidecar is not ready).
 */
function logContainers(pod: KubeObject) {
  const initializing =
    condition(pod, 'Initialized')?.status === 'False' || podStatus(pod).startsWith('Init:');
  return podContainers(pod)
    .filter(
      (c) =>
        !c.init ||
        c.restarts > 0 ||
        (c.state === 'terminated' && !!c.exitCode) ||
        (c.state === 'running' && (initializing || !c.ready)),
    )
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) => b.c.restarts - a.c.restarts || Number(a.c.ready) - Number(b.c.ready) || a.i - b.i,
    )
    .slice(0, MAX_CONTAINERS)
    .map((x) => x.c);
}

async function logSections(
  clusterId: ClusterId,
  pods: KubeObject[],
  deadline: number,
  signal: AbortSignal,
): Promise<AiContextSection[]> {
  const jobs: { pod: KubeObject; container: string; previous: boolean }[] = [];
  for (const pod of pods)
    for (const c of logContainers(pod)) {
      // A container that never started has no current logs.
      const started = !(c.state === 'waiting' && c.restarts === 0 && !c.lastTermination);
      if (started) jobs.push({ pod, container: c.name, previous: false });
      if (c.restarts > 0) jobs.push({ pod, container: c.name, previous: true });
    }
  const logs = await limited(
    jobs.map((j) => () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) return Promise.resolve([] as string[]);
      return collectPodLogs(
        clusterId,
        j.pod.metadata.namespace ?? '',
        j.pod.metadata.name,
        j.container,
        j.previous,
        Math.min(LOG_TIMEOUT_MS, remaining),
        signal,
      );
    }),
    MAX_LOG_STREAMS,
  );
  return jobs.flatMap((j, i) => {
    const section = logsSection(j.pod.metadata.name, j.container, j.previous, logs[i]!);
    return section ? [section] : [];
  });
}

async function eventsOf(
  clusterId: ClusterId,
  namespace: string | null,
  uids: string[],
): Promise<KubeObject[]> {
  const lists = await Promise.all(
    uids.map((uid) => soft(ipc.resourceEvents(clusterId, namespace, uid), [])),
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
      return soft(
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
 * metrics. Workloads are explained through their three worst pods; a
 * CronJob through the pods of its Jobs. Rejects with an `AbortError` when
 * `signal` aborts.
 */
export async function gatherExplainContext(
  clusterId: ClusterId,
  gvk: Gvk,
  obj: KubeObject,
  signal?: AbortSignal,
): Promise<AiContextSection[]> {
  if (signal?.aborted) throw abortError(signal);
  const deadline = Date.now() + LOG_BUDGET_MS;
  const logsAbort = new AbortController();
  const stopLogs = () => logsAbort.abort();
  const timer = setTimeout(stopLogs, LOG_BUDGET_MS);
  signal?.addEventListener('abort', stopLogs, { once: true });
  try {
    const app = useAppStore.getState();
    const cluster = app.clusters.find((c) => c.id === clusterId);
    const status = app.statuses[clusterId] ?? null;
    const namespace = obj.metadata.namespace ?? null;
    const isPod = gvk.group === '' && gvk.kind === 'Pod';
    const pods = isPod
      ? [obj]
      : worstPods(await soft(workloadPods(clusterId, obj, signal), [], signal));
    const objects = isPod ? [obj] : [obj, ...pods];
    const uids = [...new Set(objects.map((o) => o.metadata.uid))];
    const skips = await logSkips(clusterId, pods, signal);
    const readable = pods.filter((p) => !skips.has(p.metadata.name));

    const [events, logs, changes, metrics] = await abortable(
      Promise.all([
        eventsOf(clusterId, namespace, uids),
        logSections(clusterId, readable, deadline, logsAbort.signal),
        changesOf(clusterId, obj),
        namespace && pods.length
          ? soft(ipc.metricsPods(clusterId, namespace), null)
          : Promise.resolve(null),
      ]),
      signal,
    );
    const byUid = useHealthStore.getState().scans[clusterId]?.byUid;
    const findings = uids.flatMap((uid) => byUid?.get(uid) ?? []);

    return [
      cluster ? scopeSection({ cluster, status, namespace, obj }) : null,
      objectSection(obj),
      containersSection(pods, skips),
      eventsSection(events, `${obj.kind.toLowerCase()}/${obj.metadata.name}`),
      ...logs,
      healthSection(findings),
      changesSection(changes),
      alertsSection(alertsOf(clusterId, objects)),
      metrics?.available ? metricsSection(pods, metrics.items) : null,
    ].filter((s): s is AiContextSection => s !== null);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stopLogs);
  }
}
