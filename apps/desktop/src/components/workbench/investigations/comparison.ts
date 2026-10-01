import YAML from 'yaml';
import type {
  Investigation,
  InvestigationEvidence,
  InvestigationEvidenceKind,
  InvestigationSummary,
} from '@/types/investigations';
import { MAX_EVIDENCE_BYTES, byteLength } from './bundle';

type ObjectValue = Record<string, unknown>;
export type CoverageIssue = 'missing' | 'unavailable' | 'truncated' | 'invalid' | 'limit';
export interface ComparisonCoverage {
  state: 'complete' | 'partial' | 'unavailable';
  issues: CoverageIssue[];
  sources: InvestigationEvidence[];
}
interface ParsedEvidence {
  values: unknown[];
  coverage: ComparisonCoverage;
}
export interface ContainerObservation {
  key: string;
  name: string;
  group: string;
  state: string | null;
  ready: boolean | null;
  restarts: number | null;
}
export interface PodObservation {
  uid: string;
  name: string;
  namespace: string;
  phase: string | null;
  ready: string | null;
  containers: ContainerObservation[];
}
export interface ContainerDifference {
  key: string;
  before: ContainerObservation | null;
  after: ContainerObservation | null;
  /** A counter decrease is a reset/unknown interval, not negative restarts. */
  restartDelta: number | null;
  counterReset: boolean;
}
export interface PodDifference {
  uid: string;
  before: PodObservation | null;
  after: PodObservation | null;
  containers: ContainerDifference[];
}
export interface EventObservation {
  uid: string;
  name: string;
  regarding: string;
  type: string | null;
  reason: string | null;
  message: string | null;
  count: number | null;
  lastObserved: string | null;
}
export interface InvestigationComparison {
  earlier: Investigation;
  later: Investigation;
  sameCaptureTime: boolean;
  workloadRecreated: boolean;
  manifest: {
    before: string | null;
    after: string | null;
    beforeCoverage: ComparisonCoverage;
    afterCoverage: ComparisonCoverage;
  };
  pods: {
    changes: PodDifference[];
    unchanged: number;
    recreatedNames: string[];
    beforeCoverage: ComparisonCoverage;
    afterCoverage: ComparisonCoverage;
  };
  events: {
    added: EventObservation[];
    removed: EventObservation[];
    changed: { before: EventObservation; after: EventObservation }[];
    unchanged: number;
    beforeCoverage: ComparisonCoverage;
    afterCoverage: ComparisonCoverage;
  };
}

const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
const apiGroup = (version: string) => (version.includes('/') ? version.split('/')[0] : '');

/** Cluster names are editable and non-unique; imported bundles cannot prove
 * shared origin after their local cluster ID is deliberately removed. */
export function sameInvestigationWorkload(
  a: InvestigationSummary,
  b: InvestigationSummary,
): boolean {
  return (
    !!a.cluster_id &&
    a.cluster_id === b.cluster_id &&
    apiGroup(a.target.api_version) === apiGroup(b.target.api_version) &&
    a.target.kind === b.target.kind &&
    a.target.namespace === b.target.namespace &&
    a.target.name === b.target.name
  );
}

export function comparisonCandidates(
  record: InvestigationSummary,
  records: readonly InvestigationSummary[],
): InvestigationSummary[] {
  return records
    .filter((item) => item.id !== record.id && sameInvestigationWorkload(record, item))
    .sort((a, b) => b.captured_at - a.captured_at || a.id.localeCompare(b.id));
}

/** Canonical keys avoid JSON/YAML formatting noise. Hard limits also bound
 * imported nested structures and prevent aliases/cycles exhausting the UI. */
function canonical(value: unknown): string {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 40) throw new Error('structure-limit');
    if (Array.isArray(entry)) return entry.map((child) => visit(child, depth + 1));
    const record = object(entry);
    if (record)
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, visit(record[key], depth + 1)]),
      );
    return entry;
  };
  return JSON.stringify(visit(value, 0), null, 2);
}

function parseEvidence(record: Investigation, kind: InvestigationEvidenceKind): ParsedEvidence {
  const sources = record.evidence.filter((entry) => entry.kind === kind);
  const issues = new Set<CoverageIssue>();
  const values: unknown[] = [];
  let readable = 0;
  if (!sources.length) issues.add('missing');
  for (const entry of sources) {
    if (entry.status === 'unavailable') {
      issues.add('unavailable');
      continue;
    }
    if (entry.status === 'truncated') issues.add('truncated');
    if (entry.status === 'empty' && kind !== 'object') {
      readable++;
      continue;
    }
    try {
      if (byteLength(entry.content) > MAX_EVIDENCE_BYTES || entry.format === 'text')
        throw new Error('invalid-structure');
      const value: unknown =
        entry.format === 'json'
          ? JSON.parse(entry.content)
          : YAML.parse(entry.content, { maxAliasCount: 20, prettyErrors: false, uniqueKeys: true });
      canonical(value);
      if (kind === 'object' ? !object(value) : !Array.isArray(value))
        throw new Error('invalid-structure');
      values.push(value);
      readable++;
    } catch {
      issues.add('invalid');
    }
  }
  return {
    values,
    coverage: {
      state: !readable ? 'unavailable' : issues.size ? 'partial' : 'complete',
      issues: [...issues],
      sources,
    },
  };
}

function issue(coverage: ComparisonCoverage, value: CoverageIssue) {
  if (!coverage.issues.includes(value)) coverage.issues.push(value);
  if (coverage.state === 'complete') coverage.state = 'partial';
}

function manifest(record: Investigation) {
  const parsed = parseEvidence(record, 'object');
  const value = object(parsed.values[0]);
  const meta = object(value?.metadata);
  // A bundle's advertised target is not sufficient to trust its contents.
  if (
    parsed.values.length !== 1 ||
    !value ||
    value.kind !== record.target.kind ||
    apiGroup(text(value.apiVersion) ?? '') !== apiGroup(record.target.api_version) ||
    meta?.name !== record.target.name ||
    meta?.namespace !== record.target.namespace
  ) {
    if (parsed.values.length) issue(parsed.coverage, 'invalid');
    parsed.coverage.state = 'unavailable';
    return { content: null, uid: null, coverage: parsed.coverage };
  }
  return { content: canonical(value), uid: text(meta?.uid), coverage: parsed.coverage };
}

function podObservation(raw: unknown): PodObservation | null {
  const value = object(raw);
  const meta = object(value?.metadata);
  if (!meta || !text(meta.uid) || !text(meta.name) || !text(meta.namespace)) return null;
  const status = object(value?.status);
  const containers: ContainerObservation[] = [];
  for (const group of [
    'containerStatuses',
    'initContainerStatuses',
    'ephemeralContainerStatuses',
  ]) {
    const statuses = status?.[group];
    if (!Array.isArray(statuses)) continue;
    for (const rawContainer of statuses) {
      const container = object(rawContainer);
      if (!text(container?.name)) continue;
      const states = object(container?.state);
      const state =
        states && ['running', 'waiting', 'terminated'].find((key) => object(states[key]));
      const reason = state && text(object(states?.[state])?.reason);
      const name = text(container?.name)!;
      containers.push({
        key: `${group}/${name}`,
        name,
        group,
        state: state ? `${state}${reason ? ` (${reason})` : ''}` : null,
        ready: typeof container?.ready === 'boolean' ? container.ready : null,
        restarts: count(container?.restartCount),
      });
    }
  }
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  const ready = conditions.map(object).find((condition) => condition?.type === 'Ready');
  return {
    uid: text(meta.uid)!,
    name: text(meta.name)!,
    namespace: text(meta.namespace)!,
    phase: text(status?.phase),
    ready: text(ready?.status),
    containers: containers.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function eventObservation(raw: unknown): EventObservation | null {
  const value = object(raw);
  const meta = object(value?.metadata);
  if (!text(meta?.uid) || !text(meta?.name)) return null;
  const involved = object(value?.involvedObject) ?? object(value?.regarding);
  const series = object(value?.series);
  return {
    uid: text(meta?.uid)!,
    name: text(meta?.name)!,
    regarding: [text(involved?.kind), text(involved?.namespace), text(involved?.name)]
      .filter(Boolean)
      .join('/'),
    type: text(value?.type),
    reason: text(value?.reason),
    message: text(value?.message) ?? text(value?.note),
    count: count(series?.count) ?? count(value?.count) ?? count(value?.deprecatedCount),
    lastObserved:
      text(series?.lastObservedTime) ??
      text(value?.lastTimestamp) ??
      text(value?.eventTime) ??
      text(meta?.creationTimestamp),
  };
}

function observations<T extends { uid: string }>(
  record: Investigation,
  kind: 'pods' | 'events',
  read: (raw: unknown) => T | null,
  limit: number,
) {
  const parsed = parseEvidence(record, kind);
  const values = new Map<string, T>();
  let scanned = 0;
  for (const section of parsed.values) {
    for (const raw of section as unknown[]) {
      if (++scanned > limit) {
        issue(parsed.coverage, 'limit');
        break;
      }
      const value = read(raw);
      if (
        kind === 'pods' &&
        (value as PodObservation | null)?.namespace !== record.target.namespace
      ) {
        issue(parsed.coverage, 'invalid');
        continue;
      }
      if (!value) {
        issue(parsed.coverage, 'invalid');
        continue;
      }
      const previous = values.get(value.uid);
      if (previous && canonical(previous) !== canonical(value)) issue(parsed.coverage, 'invalid');
      if (!previous) values.set(value.uid, value);
    }
  }
  if (scanned > 0 && !values.size) parsed.coverage.state = 'unavailable';
  return { values, coverage: parsed.coverage };
}

function containerDifferences(
  a: PodObservation | null,
  b: PodObservation | null,
  chronological: boolean,
): ContainerDifference[] {
  const before = new Map(a?.containers.map((item) => [item.key, item]));
  const after = new Map(b?.containers.map((item) => [item.key, item]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((key) => {
    const x = before.get(key) ?? null;
    const y = after.get(key) ?? null;
    if (canonical(x) === canonical(y)) return [];
    const known =
      x?.restarts !== null &&
      x?.restarts !== undefined &&
      y?.restarts !== null &&
      y?.restarts !== undefined;
    const counterReset = chronological && known && y.restarts! < x.restarts!;
    return [
      {
        key,
        before: x,
        after: y,
        counterReset,
        restartDelta: chronological && known && !counterReset ? y.restarts! - x.restarts! : null,
      },
    ];
  });
}

/** Pure, offline comparison. Never substitutes an empty manifest or zero
 * counter for missing evidence, and never matches Pods by name across UIDs. */
export function compareInvestigations(a: Investigation, b: Investigation): InvestigationComparison {
  if (a.id === b.id || !sameInvestigationWorkload(a, b))
    throw new Error('investigations:comparison-identity');
  const [earlier, later] = a.captured_at <= b.captured_at ? [a, b] : [b, a];
  const sameCaptureTime = earlier.captured_at === later.captured_at;
  const ma = manifest(earlier);
  const mb = manifest(later);
  const pa = observations(earlier, 'pods', podObservation, 200);
  const pb = observations(later, 'pods', podObservation, 200);
  const ea = observations(earlier, 'events', eventObservation, 1000);
  const eb = observations(later, 'events', eventObservation, 1000);
  const changes: PodDifference[] = [];
  let unchangedPods = 0;
  for (const uid of [...new Set([...pa.values.keys(), ...pb.values.keys()])].sort()) {
    const before = pa.values.get(uid) ?? null;
    const after = pb.values.get(uid) ?? null;
    if (canonical(before) === canonical(after)) {
      unchangedPods++;
      continue;
    }
    changes.push({
      uid,
      before,
      after,
      containers: containerDifferences(before, after, !sameCaptureTime),
    });
  }
  const recreatedNames = [...pa.values.values()]
    .filter((pod) =>
      [...pb.values.values()].some(
        (other) =>
          pod.name === other.name && pod.namespace === other.namespace && pod.uid !== other.uid,
      ),
    )
    .map((pod) => `${pod.namespace}/${pod.name}`);
  const added: EventObservation[] = [];
  const removed: EventObservation[] = [];
  const changed: { before: EventObservation; after: EventObservation }[] = [];
  let unchangedEvents = 0;
  for (const uid of [...new Set([...ea.values.keys(), ...eb.values.keys()])].sort()) {
    const before = ea.values.get(uid);
    const after = eb.values.get(uid);
    if (!before) added.push(after!);
    else if (!after) removed.push(before);
    else if (canonical(before) !== canonical(after)) changed.push({ before, after });
    else unchangedEvents++;
  }
  return {
    earlier,
    later,
    sameCaptureTime,
    workloadRecreated: !!ma.uid && !!mb.uid && ma.uid !== mb.uid,
    manifest: {
      before: ma.content,
      after: mb.content,
      beforeCoverage: ma.coverage,
      afterCoverage: mb.coverage,
    },
    pods: {
      changes,
      unchanged: unchangedPods,
      recreatedNames,
      beforeCoverage: pa.coverage,
      afterCoverage: pb.coverage,
    },
    events: {
      added,
      removed,
      changed,
      unchanged: unchangedEvents,
      beforeCoverage: ea.coverage,
      afterCoverage: eb.coverage,
    },
  };
}
