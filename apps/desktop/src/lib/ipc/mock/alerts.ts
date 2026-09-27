import { alertSettingsOf, clusterMonitored, recordsAlert } from '@/lib/alerts/policy';
import { windowLabel } from '@/lib/windowSeed';
import type {
  Alert,
  AlertNotice,
  AlertObjectRef,
  AlertReason,
  AlertSettings,
  ClusterStatus,
  KubeObject,
  Settings,
} from '@/types';
import { mockEmit } from './bus';
import { ALERT_SCENARIOS, QUIET_NAMESPACES, type AlertScenario } from './fixtures/alerts';
import { getDb, list } from './fixtures/db';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo alerts: while a demo cluster is connected (and alerts are enabled
 * for it), a plausible alert about one of its fixture objects shows up
 * shortly after connecting and then every minute or two, including bursts
 * that collapse into one group alert and repeats that merge. The
 * bookkeeping mirrors `crates/kubepit-core/src/alerts/book.rs`.
 */

const COOLDOWN_MS = 10 * 60_000;
const BURST_WINDOW_MS = 60_000;
const BURST_THRESHOLD = 3;
const GROUP_NAME_LIMIT = 50;
const HISTORY_LIMIT = 500;

const FIRST_ALERT_MS: [number, number] = [6_000, 12_000];
const NEXT_ALERT_MS: [number, number] = [50_000, 110_000];

interface Finding {
  reason: AlertReason;
  container: string | null;
  condition: string | null;
  message: string;
}

/** Oldest first, like the backend's history. */
let alerts: Alert[] = [];
const recent = new Map<string, Array<{ at: number; name: string }>>();

const objectKey = (cluster: string, o: AlertObjectRef, f: Pick<Finding, 'reason' | 'condition'>) =>
  [cluster, o.kind, o.namespace ?? '', o.name, f.reason, f.condition ?? ''].join('|');
const bucketKey = (cluster: string, o: AlertObjectRef, f: Pick<Finding, 'reason' | 'condition'>) =>
  [cluster, o.kind, o.namespace ?? '', f.reason, f.condition ?? ''].join('|');

function active(key: (a: Alert) => boolean, now: number) {
  return alerts.find((a) => key(a) && now - a.last_seen < COOLDOWN_MS);
}

function record(
  clusterId: string,
  object: AlertObjectRef,
  finding: Finding,
  now: number,
): { alert: Alert; fresh: boolean } {
  const key = objectKey(clusterId, object, finding);
  const bucket = bucketKey(clusterId, object, finding);
  const own = active((a) => !a.group && objectKey(a.cluster_id, a.object, a) === key, now);
  if (own) {
    own.count += 1;
    own.last_seen = now;
    own.message = finding.message;
    return { alert: { ...own }, fresh: false };
  }
  const group = active((a) => !!a.group && bucketKey(a.cluster_id, a.object, a) === bucket, now);
  if (group?.group) {
    group.count += 1;
    group.last_seen = now;
    group.message = finding.message;
    if (!group.group.names.includes(object.name)) {
      group.group.total += 1;
      if (group.group.names.length < GROUP_NAME_LIMIT) group.group.names.push(object.name);
    }
    return { alert: { ...group, group: { ...group.group } }, fresh: false };
  }
  const window = (recent.get(bucket) ?? []).filter((r) => now - r.at < BURST_WINDOW_MS);
  const base = {
    id: crypto.randomUUID(),
    cluster_id: clusterId,
    severity: severityOf(finding.reason),
    reason: finding.reason,
    condition: finding.condition,
    message: finding.message,
    first_seen: now,
    last_seen: now,
    read: false,
  };
  let alert: Alert;
  if (window.length >= BURST_THRESHOLD) {
    const names = [...new Set([...window.map((r) => r.name), object.name])];
    alert = {
      ...base,
      object: { ...object, name: '' },
      container: null,
      count: names.length,
      group: { total: names.length, names: names.slice(0, GROUP_NAME_LIMIT) },
    };
  } else {
    window.push({ at: now, name: object.name });
    alert = { ...base, object, container: finding.container, count: 1, group: null };
  }
  recent.set(bucket, window);
  alerts = [...alerts, alert].slice(-HISTORY_LIMIT);
  return { alert: { ...alert }, fresh: true };
}

function severityOf(reason: AlertReason): Alert['severity'] {
  return ['CrashLoopBackOff', 'OOMKilled', 'JobFailed', 'NodeNotReady'].includes(reason)
    ? 'critical'
    : 'warning';
}

function settings(): AlertSettings {
  return alertSettingsOf(handlers.settings_get?.({}) as Settings | undefined);
}

function statuses(): Record<string, ClusterStatus> {
  return (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined) ?? {};
}

function emit(clusterId: string, object: AlertObjectRef, finding: Finding) {
  if (!recordsAlert(settings(), clusterId, finding.reason, object.namespace)) return;
  const { alert, fresh } = record(clusterId, object, finding, Date.now());
  const notice: AlertNotice = {
    alert,
    fresh,
    // Every browser window runs its own demo backend, so each notifies for itself.
    notifier: windowLabel,
    app_focused: typeof document !== 'undefined' && document.hasFocus(),
  };
  mockEmit('alerts://new', notice);
}

const REFS: Record<
  Exclude<AlertScenario['kind'], 'burst' | 'repeat'>,
  [string, string, string, string]
> = {
  pod: ['pods', '', 'v1', 'Pod'],
  job: ['jobs.batch', 'batch', 'v1', 'Job'],
  node: ['nodes', '', 'v1', 'Node'],
  deployment: ['deployments.apps', 'apps', 'v1', 'Deployment'],
};

function refOf(kind: keyof typeof REFS, obj: KubeObject): AlertObjectRef {
  const [, group, version, k] = REFS[kind];
  return {
    group,
    version,
    kind: k,
    namespace: obj.metadata.namespace ?? null,
    name: obj.metadata.name,
  };
}

const any = <T>(items: readonly T[]): T | undefined =>
  items[Math.floor(Math.random() * items.length)];

function candidates(clusterId: string, kind: keyof typeof REFS): KubeObject[] {
  const items = list(getDb(clusterId), REFS[kind][0]);
  const workload = items.filter((o) => !QUIET_NAMESPACES.has(o.metadata.namespace ?? ''));
  return workload.length ? workload : items;
}

function containerOf(pod: KubeObject): string | null {
  return (pod.spec?.containers?.[0]?.name as string | undefined) ?? null;
}

function podFinding(scenario: AlertScenario, pod: KubeObject): Finding {
  const container = scenario.reason === 'Evicted' ? null : containerOf(pod);
  return {
    reason: scenario.reason,
    container,
    condition: scenario.condition ?? null,
    message: scenario.message(pod, container),
  };
}

function pickScenario(): AlertScenario {
  const total = ALERT_SCENARIOS.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * total;
  for (const s of ALERT_SCENARIOS) {
    roll -= s.weight;
    if (roll < 0) return s;
  }
  return ALERT_SCENARIOS[0]!;
}

function fire(clusterId: string, attempt = 0): void {
  if (attempt > 3) return;
  const scenario = pickScenario();
  if (scenario.kind === 'repeat') {
    const last = [...alerts]
      .reverse()
      .find((a) => a.cluster_id === clusterId && !a.group && a.object.kind === 'Pod');
    const pod =
      last && candidates(clusterId, 'pod').find((p) => p.metadata.name === last.object.name);
    if (last && pod) {
      emit(clusterId, last.object, {
        reason: last.reason,
        container: last.container,
        condition: last.condition,
        message: scenario.message(pod, last.container),
      });
      return;
    }
    return fire(clusterId, attempt + 1);
  }
  if (scenario.kind === 'burst') {
    const byNamespace = new Map<string, KubeObject[]>();
    for (const pod of candidates(clusterId, 'pod')) {
      const ns = pod.metadata.namespace ?? '';
      byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), pod]);
    }
    const crowd = any([...byNamespace.values()].filter((pods) => pods.length >= 4));
    if (!crowd) return fire(clusterId, attempt + 1);
    crowd.slice(0, 6).forEach((pod, i) => {
      window.setTimeout(() => {
        if (statuses()[clusterId]?.state === 'connected')
          emit(clusterId, refOf('pod', pod), podFinding(scenario, pod));
      }, i * 120);
    });
    return;
  }
  const obj = any(candidates(clusterId, scenario.kind));
  if (!obj) return;
  const finding =
    scenario.kind === 'pod'
      ? podFinding(scenario, obj)
      : {
          reason: scenario.reason,
          container: null,
          condition: scenario.condition ?? null,
          message: scenario.message(obj, null),
        };
  emit(clusterId, refOf(scenario.kind, obj), finding);
}

const between = ([min, max]: [number, number]) => min + Math.random() * (max - min);
const nextAt = new Map<string, number>();

function tick() {
  const now = Date.now();
  const s = settings();
  for (const [id, status] of Object.entries(statuses())) {
    if (status.state !== 'connected' || !clusterMonitored(s, id)) {
      // A reconnect starts a fresh baseline, like the real monitor.
      nextAt.delete(id);
      continue;
    }
    const due = nextAt.get(id);
    if (due === undefined) {
      nextAt.set(id, now + between(FIRST_ALERT_MS));
    } else if (now >= due) {
      nextAt.set(id, now + between(NEXT_ALERT_MS));
      fire(id);
    }
  }
}

if (typeof window !== 'undefined') window.setInterval(tick, 2_000);

function select(ids: unknown, alert: Alert) {
  return !Array.isArray(ids) || ids.includes(alert.id);
}

register({
  alerts_list: () =>
    [...alerts]
      .sort((a, b) => b.last_seen - a.last_seen || b.first_seen - a.first_seen)
      .map((a) => ({ ...a, group: a.group && { ...a.group } })),
  alerts_mark_read: ({ ids }: MockArgs) => {
    let changed = false;
    alerts = alerts.map((a) => {
      if (a.read || !select(ids, a)) return a;
      changed = true;
      return { ...a, read: true };
    });
    if (changed) mockEmit('alerts://changed', null);
  },
  alerts_clear: ({ ids }: MockArgs) => {
    const before = alerts.length;
    alerts = alerts.filter((a) => !select(ids, a));
    if (alerts.length !== before) mockEmit('alerts://changed', null);
  },
});
