import * as i18n from '@/i18n/core';
import type { ChangeSummary, HelmRelease, KubeObject } from '@/types';
import {
  annotations,
  asArray,
  asNumber,
  asObject,
  asString,
  field,
  lastTimestamp,
} from '../accessors';

/**
 * The change timeline: journal entries interleaved with Warning events,
 * Helm release revisions and Deployment rollouts (ReplicaSets), newest
 * first, grouped into time buckets. Pure functions; the Changes view feeds
 * them with polled data.
 */

export type TimelineSource = 'changes' | 'warnings' | 'helm' | 'rollouts';

export const TIMELINE_SOURCES: readonly TimelineSource[] = [
  'changes',
  'warnings',
  'helm',
  'rollouts',
];

export interface ObjectRef {
  kind: string;
  apiVersion: string;
  namespace: string | null;
  name: string;
  uid: string;
}

export type TimelineItem =
  | { type: 'change'; key: string; ts: number; change: ChangeSummary }
  | {
      type: 'warning';
      key: string;
      ts: number;
      event: KubeObject;
      reason: string;
      message: string;
      count: number;
      object: ObjectRef;
    }
  | { type: 'helm'; key: string; ts: number; release: HelmRelease }
  | {
      type: 'rollout';
      key: string;
      ts: number;
      revision: number;
      owner: ObjectRef;
      replicaSet: string;
      images: string[];
    };

export type TimeRange = '15m' | '1h' | '6h' | '24h' | '7d' | '30d';

export const TIME_RANGES: Record<TimeRange, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

/** Ranges the in-memory journal covers. */
export const LIVE_RANGES: readonly TimeRange[] = ['15m', '1h', '6h', '24h'];
/** Ranges only clusters with persistent history offer. */
export const HISTORY_RANGES: readonly TimeRange[] = ['7d', '30d'];

/** Journal entries from the persistent history (keys distinct from live ones). */
export function historyChangeItems(
  entries: readonly ChangeSummary[],
  w: TimelineWindow,
): TimelineItem[] {
  return changeItems(entries, w).map((item) => ({ ...item, key: `hc:${item.key.slice(2)}` }));
}

export function isHistoryItem(item: TimelineItem): boolean {
  return item.key.startsWith('hc:');
}

export interface TimelineWindow {
  since: number;
  until: number;
  namespaces: readonly string[];
  /** Lower-cased free text; empty = everything. */
  text: string;
  /** Kind names; empty = every kind. */
  kinds: readonly string[];
}

const inWindow = (ts: number, w: TimelineWindow) =>
  Number.isFinite(ts) && ts >= w.since && ts <= w.until;
const inNamespaces = (ns: string | null, w: TimelineWindow) =>
  !w.namespaces.length || (ns !== null && w.namespaces.includes(ns));
const matchesText = (haystack: string, w: TimelineWindow) =>
  !w.text || haystack.toLowerCase().includes(w.text);
const matchesKind = (kind: string, w: TimelineWindow) => !w.kinds.length || w.kinds.includes(kind);

export function changeItems(entries: readonly ChangeSummary[], w: TimelineWindow): TimelineItem[] {
  return entries
    .filter((c) => matchesKind(c.gvk.kind, w))
    .map((change) => ({ type: 'change', key: `c:${change.id}`, ts: change.ts, change }));
}

function objectRef(value: unknown): ObjectRef {
  const o = asObject(value);
  return {
    kind: asString(o.kind),
    apiVersion: asString(o.apiVersion),
    namespace: asString(o.namespace) || null,
    name: asString(o.name),
    uid: asString(o.uid),
  };
}

export function warningItems(events: readonly KubeObject[], w: TimelineWindow): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const event of events) {
    if (asString(field(event, 'type')) !== 'Warning') continue;
    const ts = Date.parse(lastTimestamp(event) ?? '');
    const object = objectRef(field(event, 'involvedObject'));
    const reason = asString(field(event, 'reason'));
    const message = asString(field(event, 'message'));
    const namespace = event.metadata.namespace ?? object.namespace;
    if (!inWindow(ts, w) || !inNamespaces(namespace, w) || !matchesKind(object.kind, w)) continue;
    if (!matchesText(`${reason} ${message} ${object.kind} ${namespace ?? ''}/${object.name}`, w))
      continue;
    out.push({
      type: 'warning',
      key: `w:${event.metadata.uid || `${namespace}/${event.metadata.name}`}`,
      ts,
      event,
      reason,
      message,
      count: asNumber(field(event, 'count'), 1),
      object,
    });
  }
  return out;
}

export function helmItems(releases: readonly HelmRelease[], w: TimelineWindow): TimelineItem[] {
  // Helm releases are not a journaled kind: a kind filter hides them.
  if (w.kinds.length) return [];
  return releases
    .map((release) => ({ release, ts: Date.parse(release.updated ?? '') }))
    .filter(({ release, ts }) => inWindow(ts, w) && inNamespaces(release.namespace, w))
    .filter(({ release: r }) =>
      matchesText(`helm ${r.namespace}/${r.name} ${r.chart} ${r.chart_version} ${r.status}`, w),
    )
    .map(({ release, ts }) => ({
      type: 'helm',
      key: `h:${release.namespace}/${release.name}/${release.revision}`,
      ts,
      release,
    }));
}

const REVISION = 'deployment.kubernetes.io/revision';

/** New ReplicaSets of Deployments: one rollout per revision. */
export function rolloutItems(
  replicaSets: readonly KubeObject[],
  w: TimelineWindow,
): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const rs of replicaSets) {
    const revision = Number(annotations(rs)[REVISION]);
    const owner = rs.metadata.ownerReferences?.find((r) => r.controller && r.kind === 'Deployment');
    if (!owner || !Number.isFinite(revision)) continue;
    const ts = Date.parse(rs.metadata.creationTimestamp ?? '');
    const namespace = rs.metadata.namespace ?? null;
    if (!inWindow(ts, w) || !inNamespaces(namespace, w) || !matchesKind('Deployment', w)) continue;
    const images = asArray<Record<string, unknown>>(rs.spec?.template?.spec?.containers).map((c) =>
      asString(c.image),
    );
    if (!matchesText(`rollout Deployment ${namespace ?? ''}/${owner.name} ${images.join(' ')}`, w))
      continue;
    out.push({
      type: 'rollout',
      key: `r:${rs.metadata.uid}`,
      ts,
      revision,
      owner: {
        kind: owner.kind,
        apiVersion: owner.apiVersion,
        namespace,
        name: owner.name,
        uid: owner.uid,
      },
      replicaSet: rs.metadata.name,
      images,
    });
  }
  return out;
}

/** Newest first; ties keep journal entries (newest id first) before the rest. */
export function mergeTimeline(...lists: TimelineItem[][]): TimelineItem[] {
  const rank = (item: TimelineItem) => (item.type === 'change' ? -item.change.id : 0);
  return lists.flat().sort((a, b) => b.ts - a.ts || rank(a) - rank(b));
}

export interface TimelineBucket {
  key: string;
  label: string;
  items: TimelineItem[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function hourLabel(start: number, now: number): string {
  const time = (ts: number) => i18n.date(ts, { hour: '2-digit', minute: '2-digit' });
  const range = `${time(start)} – ${time(start + HOUR)}`;
  const sameDay = new Date(start).toDateString() === new Date(now).toDateString();
  return sameDay ? range : `${i18n.date(start, { weekday: 'short', day: 'numeric' })} · ${range}`;
}

/** Recent minutes in fine buckets, then one bucket per clock hour. */
export function bucketize(items: readonly TimelineItem[], now: number): TimelineBucket[] {
  const buckets: TimelineBucket[] = [];
  const recent: Array<[number, string, () => string]> = [
    [5 * MINUTE, 'm5', () => i18n.t('Last 5 minutes')],
    [15 * MINUTE, 'm15', () => i18n.t('5–15 minutes ago')],
    [30 * MINUTE, 'm30', () => i18n.t('15–30 minutes ago')],
    [HOUR, 'm60', () => i18n.t('30–60 minutes ago')],
  ];
  for (const item of items) {
    const age = Math.max(0, now - item.ts);
    const fine = recent.find(([limit]) => age < limit);
    const hourStart = Math.floor(item.ts / HOUR) * HOUR;
    const key = fine ? fine[1] : `h${hourStart}`;
    let bucket = buckets[buckets.length - 1];
    if (!bucket || bucket.key !== key) {
      bucket = { key, label: fine ? fine[2]() : hourLabel(hourStart, now), items: [] };
      buckets.push(bucket);
    }
    bucket.items.push(item);
  }
  return buckets;
}

/** Counts per source (for the source chips). */
export function countBySource(items: readonly TimelineItem[]): Record<TimelineSource, number> {
  const counts: Record<TimelineSource, number> = { changes: 0, warnings: 0, helm: 0, rollouts: 0 };
  for (const item of items) {
    if (item.type === 'change') counts.changes++;
    else if (item.type === 'warning') counts.warnings++;
    else if (item.type === 'helm') counts.helm++;
    else counts.rollouts++;
  }
  return counts;
}

/** Journal entry counts per kind, most frequent first (kind chips). */
export function kindFacets(entries: readonly ChangeSummary[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.gvk.kind, (counts.get(e.gvk.kind) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
