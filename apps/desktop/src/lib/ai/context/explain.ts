import { asObject, asString, controllerOf, lastTimestamp } from '@/lib/kube/accessors';
import type { Finding } from '@/lib/kube/health/types';
import { normalizeObject, toDiffYaml } from '@/lib/kube/normalize';
import { podContainers, podIsReady, podRestarts, podStatus } from '@/lib/kube/pods';
import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import { hasRollout, rolloutProgress } from '@/lib/kube/rollout';
import type {
  AiContextSection,
  Alert,
  ChangeSummary,
  ClusterDef,
  ClusterStatus,
  KubeObject,
  PodMetric,
} from '@/types';
import { condenseLogs } from './logs';

/**
 * Pure builders of the explain context (spec §11). Each returns one
 * `AiContextSection`, or null when there is nothing to say. Ids and
 * priorities follow the spec (0 = kept longest); labels are identifiers
 * only (`pod/web-1`, `web-1/app@previous`) and never translated; contents
 * are Kubernetes data in plain, compact text. The backend redacts and
 * budgets every section before anything is previewed or sent.
 */

const MAX_EVENTS = 50;
const MAX_FINDINGS = 40;
const MAX_CHANGES = 30;
const MAX_ALERTS = 20;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ref = (kind: string, namespace: string | null | undefined, name: string) =>
  `${kind} ${namespace ? `${namespace}/` : ''}${name}`;
const objectLabel = (obj: Pick<KubeObject, 'kind' | 'metadata'>) =>
  `${obj.kind.toLowerCase()}/${obj.metadata.name}`;

/** Identifiers, at most three, then `+N`. */
function labelOf(names: string[]): string {
  const unique = [...new Set(names)];
  return unique.length > 3
    ? `${unique.slice(0, 3).join(', ')} +${unique.length - 3}`
    : unique.join(', ');
}

export function scopeSection(input: {
  cluster: ClusterDef;
  status: ClusterStatus | null;
  namespace: string | null;
  obj: KubeObject | null;
}): AiContextSection {
  const { cluster, status, namespace, obj } = input;
  const lines = [
    `cluster: ${cluster.name}${cluster.environment ? ` (${cluster.environment})` : ''}`,
    ...(status?.version ? [`version: ${status.version}`] : []),
    ...(status?.platform ? [`platform: ${status.platform}`] : []),
    ...(cluster.read_only ? ['read-only: yes (Kubepit applies nothing here)'] : []),
    `namespace: ${namespace ?? '(all)'}`,
  ];
  if (obj) {
    lines.push(`object: ${ref(obj.kind, obj.metadata.namespace, obj.metadata.name)}`);
    const owner = controllerOf(obj);
    if (owner) lines.push(`owner: ${owner.kind} ${owner.name}`);
    if (hasRollout(obj)) {
      const r = rolloutProgress(obj);
      lines.push(
        `rollout: ${r.state} desired=${r.desired} updated=${r.updated} ready=${r.ready} available=${r.available} old=${r.old}`,
      );
    }
  }
  return {
    id: 'scope',
    kind: 'scope',
    label: cluster.name,
    priority: 0,
    format: 'text',
    content: lines.join('\n'),
  };
}

/** Normalized YAML with status; `managedFields` and last-applied are stripped. */
export function objectSection(obj: KubeObject): AiContextSection {
  return {
    id: 'object',
    kind: 'object',
    label: objectLabel(obj),
    priority: 1,
    format: 'yaml',
    content: toDiffYaml(normalizeObject(obj, { keepStatus: true })),
  };
}

/** Container state, last state reason / exit code and restarts per pod. */
export function containersSection(
  pods: KubeObject[],
  /** Pod name → a note, e.g. why its logs were not read. */
  notes: ReadonlyMap<string, string> = new Map(),
): AiContextSection | null {
  if (!pods.length) return null;
  const lines: string[] = [];
  for (const pod of pods) {
    const node = asString(pod.spec?.nodeName);
    lines.push(
      `${objectLabel(pod)} phase=${asString(pod.status?.phase) || 'Unknown'} status=${podStatus(pod)} ready=${podIsReady(pod)} restarts=${podRestarts(pod)}${node ? ` node=${node}` : ''}`,
    );
    for (const c of podContainers(pod)) {
      const state = [c.state, c.reason, c.exitCode !== null ? `(${c.exitCode})` : null]
        .filter(Boolean)
        .join(' ');
      const last = c.lastTermination
        ? `; last: ${c.lastTermination.reason}${c.lastTermination.exitCode !== null ? ` (${c.lastTermination.exitCode})` : ''}${c.lastTermination.finishedAt ? ` at ${c.lastTermination.finishedAt}` : ''}`
        : '';
      const message = c.message ? ` — ${c.message}` : '';
      lines.push(
        `  ${c.init ? 'init ' : ''}${c.name}: ${state}${message} ready=${c.ready} restarts=${c.restarts} image=${c.image}${last}`,
      );
    }
    const note = notes.get(pod.metadata.name);
    if (note) lines.push(`  ${note}`);
  }
  return {
    id: 'containers',
    kind: 'containers',
    label: labelOf(pods.map(objectLabel)),
    priority: 1,
    format: 'text',
    content: lines.join('\n'),
  };
}

function eventTime(e: KubeObject): number {
  const t = Date.parse(lastTimestamp(e) ?? '');
  return Number.isFinite(t) ? t : 0;
}

/** Warnings first, then newest first; at most 50 rows. */
export function eventsSection(events: KubeObject[], label: string): AiContextSection | null {
  if (!events.length) return null;
  const sorted = [...events].sort(
    (a, b) =>
      Number(b.type === 'Warning') - Number(a.type === 'Warning') || eventTime(b) - eventTime(a),
  );
  const rows = sorted.slice(0, MAX_EVENTS).map((e) => {
    const involved = asObject(e.involvedObject);
    const count = Number(e.count ?? asObject(e.series).count ?? 1) || 1;
    return [
      eventTime(e) ? iso(eventTime(e)) : '-',
      asString(e.type) || 'Normal',
      asString(e.reason) || '-',
      `×${count}`,
      `${asString(involved.kind)}/${asString(involved.name)}`,
      asString(e.message).replace(/\s+/g, ' ').trim(),
    ].join('  ');
  });
  const more = sorted.length - rows.length;
  return {
    id: 'events',
    kind: 'events',
    label,
    priority: 1,
    format: 'text',
    content: [
      'LAST SEEN  TYPE  REASON  COUNT  OBJECT  MESSAGE',
      ...rows,
      ...(more > 0 ? [`… ${more} more events not shown`] : []),
    ].join('\n'),
  };
}

/** One container's logs, condensed; `previous` is the last terminated instance. */
export function logsSection(
  pod: string,
  container: string,
  previous: boolean,
  raw: string[],
): AiContextSection | null {
  if (!raw.some((line) => line.trim())) return null;
  const label = `${pod}/${container}${previous ? '@previous' : ''}`;
  return {
    id: `logs:${label}`,
    kind: 'logs',
    label,
    priority: 2,
    format: 'log',
    content: condenseLogs(raw).text,
  };
}

/** Health findings of the object and its pods (messages as the scan wrote them). */
export function healthSection(findings: Finding[]): AiContextSection | null {
  if (!findings.length) return null;
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const unique = [...new Map(findings.map((f) => [f.id, f])).values()].sort(
    (a, b) => order[a.severity] - order[b.severity],
  );
  const rows = unique
    .slice(0, MAX_FINDINGS)
    .map(
      (f) =>
        `${f.severity}  ${f.category}  ${ref(f.ref.kind, f.ref.namespace, f.ref.name)}  ${f.message} (rule ${f.ruleId})`,
    );
  return {
    id: 'health',
    kind: 'health',
    label: labelOf(unique.map((f) => `${f.ref.kind.toLowerCase()}/${f.ref.name}`)),
    priority: 2,
    format: 'text',
    content: rows.join('\n'),
  };
}

/** The change timeline: headlines and changed paths, newest first. */
export function changesSection(entries: ChangeSummary[]): AiContextSection | null {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a, b) => b.ts - a.ts).slice(0, MAX_CHANGES);
  const lines: string[] = [];
  for (const c of sorted) {
    const actor = c.actor
      ? ` by ${c.actor.manager}${c.actor.operation ? ` (${c.actor.operation})` : ''}`
      : '';
    lines.push(`${iso(c.ts)} ${c.op} ${ref(c.gvk.kind, c.namespace, c.name)}${actor}`);
    for (const p of c.paths)
      lines.push(
        p.redacted
          ? `  ${p.path}: (changed)`
          : `  ${p.path}: ${p.before ?? '(none)'} → ${p.after ?? '(none)'}`,
      );
    const more = c.path_count - c.paths.length;
    if (more > 0) lines.push(`  … ${more} more ${more === 1 ? 'path' : 'paths'}`);
  }
  return {
    id: 'changes',
    kind: 'changes',
    label: labelOf(sorted.map((c) => `${c.gvk.kind.toLowerCase()}/${c.name}`)),
    priority: 3,
    format: 'text',
    content: lines.join('\n'),
  };
}

/** Kubepit alerts of the object (Kubernetes' own messages). */
export function alertsSection(alerts: Alert[]): AiContextSection | null {
  if (!alerts.length) return null;
  const sorted = [...alerts].sort((a, b) => b.last_seen - a.last_seen).slice(0, MAX_ALERTS);
  const rows = sorted.map((a) =>
    [
      a.severity,
      a.reason,
      ref(a.object.kind, a.object.namespace, a.object.name || '*'),
      ...(a.container ? [`container=${a.container}`] : []),
      ...(a.condition ? [`condition=${a.condition}`] : []),
      `×${a.count}`,
      `last=${iso(a.last_seen)}`,
      a.message,
    ].join(' '),
  );
  return {
    id: 'alerts',
    kind: 'alerts',
    label: labelOf(sorted.map((a) => `${a.object.kind.toLowerCase()}/${a.object.name || '*'}`)),
    priority: 3,
    format: 'text',
    content: rows.join('\n'),
  };
}

const cpuText = (m: number) => `${Math.round(m)}m`;
const memText = (bytes: number) => `${Math.round(bytes / 2 ** 20)}Mi`;

function limitText(
  kind: 'request' | 'limit',
  value: unknown,
  format: (n: number) => string,
  parse: (v: unknown) => number,
) {
  return value === undefined || value === null || value === ''
    ? `no ${kind}`
    : `${kind} ${format(parse(value))}`;
}

/** metrics-server usage per container against its requests and limits. */
export function metricsSection(pods: KubeObject[], usage: PodMetric[]): AiContextSection | null {
  const lines: string[] = [];
  for (const pod of pods) {
    const metric = usage.find(
      (m) =>
        m.name === pod.metadata.name && m.namespace === (pod.metadata.namespace ?? m.namespace),
    );
    if (!metric) continue;
    lines.push(objectLabel(pod));
    for (const c of metric.containers) {
      const spec = podContainers(pod).find((x) => x.name === c.name)?.spec;
      const resources = asObject(spec?.resources);
      const requests = asObject(resources.requests);
      const limits = asObject(resources.limits);
      lines.push(
        `  ${c.name}: cpu ${cpuText(c.cpu_millicores)} (${limitText('request', requests.cpu, cpuText, (v) => cpuMillicores(v))}, ${limitText('limit', limits.cpu, cpuText, (v) => cpuMillicores(v))}) · memory ${memText(c.memory_bytes)} (${limitText('request', requests.memory, memText, memoryBytes)}, ${limitText('limit', limits.memory, memText, memoryBytes)})`,
      );
    }
  }
  if (!lines.length) return null;
  return {
    id: 'metrics',
    kind: 'metrics',
    label: labelOf(pods.map(objectLabel)),
    priority: 4,
    format: 'text',
    content: lines.join('\n'),
  };
}

/** The `n` worst pods: most restarts first, then not ready. */
export function worstPods(pods: KubeObject[], n = 3): KubeObject[] {
  return pods
    .map((pod, i) => ({ pod, i, restarts: podRestarts(pod), ready: podIsReady(pod) }))
    .sort((a, b) => b.restarts - a.restarts || Number(a.ready) - Number(b.ready) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.pod);
}
