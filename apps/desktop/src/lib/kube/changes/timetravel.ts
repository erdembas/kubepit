import { parse, stringify } from 'yaml';
import type { ChangeDetail, ChangeSummary, KubeObject } from '@/types';

/**
 * "State at time T" from the change journal. Every journal entry keeps a
 * full normalized snapshot of its after-state, so reconstructing an object
 * means picking the last entry at or before `T` — no replay needed. The
 * helpers here also render both sides of the comparison (the snapshot and
 * the live object) through the same mirroring of the backend's
 * normalization (`change_journal/normalize.rs`), so a diff stays about
 * intent instead of bookkeeping. Pure: no i18n, no IPC.
 */

export interface TimeTravelEntry {
  entry: ChangeSummary;
  source: 'journal' | 'history';
}

/**
 * The journal page (newest first) and the loaded history page (newest
 * first) merged oldest → newest. History entries are older than the
 * journal's coverage by construction.
 */
export function mergeOldestFirst(
  journal: readonly ChangeSummary[],
  older: readonly ChangeSummary[],
): TimeTravelEntry[] {
  const out: TimeTravelEntry[] = [];
  for (let i = older.length - 1; i >= 0; i--) out.push({ entry: older[i]!, source: 'history' });
  for (let i = journal.length - 1; i >= 0; i--) out.push({ entry: journal[i]!, source: 'journal' });
  return out;
}

export type StatePick =
  | {
      kind: 'state';
      at: number;
      /** Last entry at or before `at` (the one whose after-state applies). */
      picked: TimeTravelEntry;
      /** First entry after `at`, when the object changed again later. */
      next: TimeTravelEntry | null;
    }
  | {
      kind: 'unknown';
      at: number;
      /** Timestamp of the oldest known entry, when any exist. */
      coverageStart: number | null;
      hasEntries: boolean;
    };

/** Which entry's snapshot holds the state at `at` (entries oldest → newest). */
export function pickStateAt(entries: readonly TimeTravelEntry[], at: number): StatePick {
  let picked: TimeTravelEntry | null = null;
  let next: TimeTravelEntry | null = null;
  for (const e of entries) {
    if (e.entry.ts <= at) picked = e;
    else {
      next = e;
      break;
    }
  }
  if (!picked) {
    return {
      kind: 'unknown',
      at,
      coverageStart: entries.length ? entries[0]!.entry.ts : null,
      hasEntries: entries.length > 0,
    };
  }
  return { kind: 'state', at, picked, next };
}

/**
 * Up to `max` entries ending at the picked one, newest first: the fallback
 * candidates when the newest entries were stored without bodies.
 */
export function fallbackCandidates(
  entries: readonly TimeTravelEntry[],
  at: number,
  max = 3,
): TimeTravelEntry[] {
  const upTo: TimeTravelEntry[] = [];
  for (const e of entries) {
    if (e.entry.ts > at) break;
    upTo.push(e);
  }
  return upTo.slice(-max).reverse();
}

export interface ResolvedState {
  /** The entry whose snapshot is shown (`picked`, or an older kept one). */
  entry: TimeTravelEntry;
  /** Entries at or before `at` whose bodies were dropped (0 usually). */
  skippedOmitted: number;
  detail: ChangeDetail;
}

/**
 * Resolve the snapshot: walk the candidates newest first until one kept
 * its bodies. `getDetail` must not throw for a missing entry (return null
 * and the walk continues).
 */
export async function resolveState(
  candidates: readonly TimeTravelEntry[],
  getDetail: (e: TimeTravelEntry) => Promise<ChangeDetail | null>,
): Promise<ResolvedState | null> {
  let skipped = 0;
  for (const candidate of candidates) {
    const detail = await getDetail(candidate);
    if (!detail) continue;
    if (detail.omitted) {
      skipped++;
      continue;
    }
    return { entry: candidate, skippedOmitted: skipped, detail };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Both sides of the diff, through one canonical form
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Metadata fields the journal drops (mirror of `normalize.rs`). */
const NOISE_METADATA = [
  'resourceVersion',
  'generation',
  'managedFields',
  'uid',
  'selfLink',
  'creationTimestamp',
];

/** Bookkeeping annotations the journal drops (mirror of `normalize.rs`). */
const NOISE_ANNOTATIONS = new Set([
  'kubectl.kubernetes.io/last-applied-configuration',
  'deployment.kubernetes.io/revision',
  'deployment.kubernetes.io/desired-replicas',
  'deployment.kubernetes.io/max-replicas',
  'control-plane.alpha.kubernetes.io/leader',
  'cluster-autoscaler.kubernetes.io/last-updated',
  'autoscaling.alpha.kubernetes.io/conditions',
  'autoscaling.alpha.kubernetes.io/current-metrics',
  'endpoints.kubernetes.io/last-change-trigger-time',
  'argocd.argoproj.io/refresh',
]);

const NOISE_NAME_PARTS = [
  'heartbeat',
  'renew-time',
  'renewtime',
  'last-updated',
  'lastupdated',
  'last-seen',
  'lastseen',
  'leader-election',
  'leaderelection',
];

function isNoiseAnnotation(key: string): boolean {
  if (NOISE_ANNOTATIONS.has(key)) return true;
  const name = (key.split('/').pop() ?? key).toLowerCase();
  return name === 'leader' || NOISE_NAME_PARTS.some((p) => name.includes(p));
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]!);
  return out;
}

/** The journal's per-process salt cannot be reproduced; the marker is the fact. */
const REDACTED_MARKER = /^<redacted #[0-9a-f]+>$/;
const TRUNCATED_MARKER = /^<truncated: (\d+) bytes #[0-9a-f]+>$/;

function canonicalMarkers(value: Json): Json {
  if (typeof value === 'string') {
    if (REDACTED_MARKER.test(value)) return '<redacted>';
    const truncated = TRUNCATED_MARKER.exec(value);
    if (truncated) return `<truncated: ${truncated[1]!} bytes>`;
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalMarkers);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, v] of Object.entries(value)) out[key] = canonicalMarkers(v);
  return out;
}

/** Secret values never reach a diff: both sides show the same marker. */
function redactSecrets(value: Json): Json {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isObject(value)) return value;
  for (const field of ['data', 'stringData']) {
    const entries = value[field];
    if (isObject(entries))
      for (const key of Object.keys(entries)) entries[key] = '<redacted>';
  }
  const out: JsonObject = {};
  for (const [key, v] of Object.entries(value)) out[key] = redactSecrets(v);
  return out;
}

/** The live object through the journal's normalization, so both sides match. */
export function journalMirror(obj: KubeObject | Record<string, unknown>): Json {
  const source = JSON.parse(JSON.stringify(obj ?? null)) as unknown;
  if (!isObject(source)) return null;
  let out: JsonObject;
  if (source.kind === 'Node') {
    // Nodes are reduced to name, labels and spec (mirror of `normalize.rs`).
    const meta = isObject(source.metadata) ? source.metadata : {};
    out = {
      apiVersion: source.apiVersion ?? null,
      kind: source.kind ?? null,
      metadata: {
        name: meta.name ?? null,
        ...(isObject(meta.labels) ? { labels: meta.labels } : {}),
      },
      ...(source.spec !== undefined ? { spec: source.spec } : {}),
    };
  } else {
    out = source;
    delete out.status;
  }
  if (isObject(out.metadata)) {
    for (const key of NOISE_METADATA) delete out.metadata[key];
    const annotations = out.metadata.annotations;
    if (isObject(annotations)) {
      for (const key of Object.keys(annotations))
        if (isNoiseAnnotation(key)) delete annotations[key];
      if (!Object.keys(annotations).length) delete out.metadata.annotations;
    }
    if (isObject(out.metadata.labels) && !Object.keys(out.metadata.labels).length)
      delete out.metadata.labels;
  }
  return redactSecrets(out);
}

function render(value: Json): string {
  return stringify(sortKeys(value), {
    lineWidth: 0,
    sortMapEntries: true,
    aliasDuplicateObjects: false,
  });
}

/** YAML of a journal snapshot body (`before_yaml` / `after_yaml`). */
export function snapshotYaml(body: string | null): string {
  if (!body) return '';
  try {
    const parsed = parse(body) as unknown;
    if (!isObject(parsed)) return '';
    // The journal keeps creationTimestamp; the live mirror drops it, so it
    // is dropped here too — a re-created object shows in the timeline.
    if (isObject(parsed.metadata)) delete parsed.metadata.creationTimestamp;
    return render(canonicalMarkers(parsed));
  } catch {
    return '';
  }
}

/** YAML of the live object, through the same canonical form. */
export function liveYaml(obj: KubeObject | Record<string, unknown> | null | undefined): string {
  if (!obj) return '';
  return render(canonicalMarkers(journalMirror(obj)));
}
