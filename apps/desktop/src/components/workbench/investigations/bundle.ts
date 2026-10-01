import type {
  Investigation,
  InvestigationEvidence,
  InvestigationSummary,
} from '@/types/investigations';

export const MAX_BUNDLE_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_BYTES = 64 * 1024;
export const byteLength = (text: string) => new TextEncoder().encode(text).length;

const FIELDS = [
  'version',
  'id',
  'title',
  'cluster_id',
  'cluster_name',
  'target',
  'captured_at',
  'updated_at',
  'imported',
  'evidence_count',
  'incomplete_count',
  'notes',
  'lookback_minutes',
  'evidence',
];
const EVIDENCE_FIELDS = ['id', 'kind', 'label', 'status', 'format', 'content', 'reason'];
const KINDS = ['object', 'pods', 'events', 'logs', 'changes', 'metrics'];
const REASONS = [
  'timeout',
  'forbidden',
  'not-found',
  'not-available',
  'no-pods',
  'not-recording',
  'capture-limit',
  'request-failed',
  'no-selector',
];

function fail(code = 'invalid-data'): never {
  throw new Error(`investigations:${code}`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = true): asserts value is string {
  if (
    typeof value !== 'string' ||
    byteLength(value) > max ||
    value.includes('\0') ||
    (required && !value.trim())
  )
    fail();
}
function exact(value: Record<string, unknown>, fields: string[]) {
  if (
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in value))
  )
    fail();
}

/** Validate before displaying a file, even in the demo. Native imports
 * independently repeat validation and redaction. No cluster is contacted. */
export function parseInvestigationBundle(bundle: string): Investigation {
  if (byteLength(bundle) > MAX_BUNDLE_BYTES) fail('bundle-too-large');
  let raw: unknown;
  try {
    raw = JSON.parse(bundle);
  } catch {
    return fail();
  }
  const value = object(raw);
  if (value.version !== 1) fail('unsupported-version');
  exact(value, FIELDS);
  text(value.id, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(value.id)) fail();
  text(value.title, 200);
  text(value.notes, 32 * 1024, false);
  text(value.cluster_name, 256);
  if (value.cluster_id !== null) text(value.cluster_id, 128);
  const target = object(value.target);
  exact(target, ['api_version', 'kind', 'namespace', 'name']);
  for (const part of Object.values(target)) text(part, 256);
  for (const key of ['captured_at', 'updated_at']) {
    if (
      !Number.isSafeInteger(value[key]) ||
      (value[key] as number) < 0 ||
      (value[key] as number) > Date.now() + 86_400_000
    )
      fail();
  }
  if (typeof value.imported !== 'boolean' || ![15, 60].includes(value.lookback_minutes as number))
    fail();
  for (const key of ['evidence_count', 'incomplete_count']) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) fail();
  }
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 32)
    fail();
  const ids = new Set<string>();
  for (const item of value.evidence) {
    const entry = object(item);
    exact(entry, EVIDENCE_FIELDS);
    text(entry.id, 128);
    text(entry.label, 512);
    text(entry.content, MAX_EVIDENCE_BYTES, false);
    if (
      ids.has(entry.id) ||
      !KINDS.includes(String(entry.kind)) ||
      !['captured', 'empty', 'unavailable', 'truncated'].includes(String(entry.status)) ||
      !['yaml', 'json', 'text'].includes(String(entry.format)) ||
      (entry.reason !== null && !REASONS.includes(String(entry.reason)))
    )
      fail();
    if (['empty', 'unavailable'].includes(String(entry.status)) && entry.content) fail();
    ids.add(entry.id);
  }
  return summarizeCounts(value as unknown as Investigation);
}

export function summarizeCounts(record: Investigation): Investigation {
  return {
    ...record,
    evidence_count: record.evidence.length,
    incomplete_count: record.evidence.filter(
      (item) => item.status === 'unavailable' || item.status === 'truncated',
    ).length,
  };
}

export function summary(record: Investigation): InvestigationSummary {
  const {
    evidence: _evidence,
    version: _version,
    notes: _notes,
    lookback_minutes: _lookback,
    ...rest
  } = summarizeCounts(record);
  return rest;
}

export function selectedEvidence(
  record: Investigation,
  ids: string[] | null,
): InvestigationEvidence[] {
  if (ids === null) return record.evidence;
  if (
    !ids.length ||
    ids.length > 32 ||
    ids.some((id) => !record.evidence.some((entry) => entry.id === id))
  )
    fail();
  return record.evidence.filter((entry) => ids.includes(entry.id));
}
