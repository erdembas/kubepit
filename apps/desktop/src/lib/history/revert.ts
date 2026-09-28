import YAML from 'yaml';
import type { KubeObject } from '@/types';

/**
 * "Revert" of an audited action: undo exactly what the action changed and
 * nothing else. The entry's normalized before/after objects give an
 * RFC 7386 merge patch (after → before) that is applied to the *live*
 * object, so changes others made since stay; the result is sent as a
 * `replace` (with the live resourceVersion, so a concurrent edit is
 * rejected) through the usual dry-run review first. Pure functions.
 */

type Json = unknown;
type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && equal(a[k], b[k]));
  }
  return false;
}

/**
 * The merge patch turning `from` into `to`; `undefined` when they are
 * equal. Removed keys become `null`; arrays and scalars are replaced whole.
 */
export function diffMergePatch(from: Json, to: Json): Json | undefined {
  if (equal(from, to)) return undefined;
  if (!isObject(from) || !isObject(to)) return to === undefined ? null : to;
  const patch: JsonObject = {};
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (!(key in to)) {
      patch[key] = null;
      continue;
    }
    const child = diffMergePatch(from[key], to[key]);
    if (child !== undefined) patch[key] = child;
  }
  return Object.keys(patch).length ? patch : undefined;
}

/** RFC 7386: apply `patch` to (a copy of) `target`. */
export function applyMergePatch(target: Json, patch: Json): Json {
  if (!isObject(patch)) return structuredClone(patch);
  const base: JsonObject = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = applyMergePatch(base[key], value);
  }
  return base;
}

/** Metadata the revert never touches (the server owns it). */
const PROTECTED_METADATA = [
  'name',
  'namespace',
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'managedFields',
  'selfLink',
];

export type RevertPlan =
  | { ok: true; object: KubeObject; yaml: string; patch: JsonObject }
  | { ok: false; reason: 'unchanged' | 'invalid' | 'redacted' };

function hasMarkers(value: Json): boolean {
  if (typeof value === 'string')
    return value.startsWith('<redacted #') || value.startsWith('<truncated: ');
  if (Array.isArray(value)) return value.some(hasMarkers);
  if (isObject(value)) return Object.values(value).some(hasMarkers);
  return false;
}

/**
 * The live object with the action undone, ready for a `replace` review.
 * `before` / `after` are the entry's normalized YAML documents.
 */
export function planRevert(live: KubeObject, beforeYaml: string, afterYaml: string): RevertPlan {
  let before: Json;
  let after: Json;
  try {
    before = YAML.parse(beforeYaml);
    after = YAML.parse(afterYaml);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isObject(before) || !isObject(after)) return { ok: false, reason: 'invalid' };
  const patch = diffMergePatch(after, before);
  if (!isObject(patch)) return { ok: false, reason: 'unchanged' };
  delete patch.status;
  delete patch.apiVersion;
  delete patch.kind;
  if (isObject(patch.metadata)) {
    for (const key of PROTECTED_METADATA) delete patch.metadata[key];
    if (!Object.keys(patch.metadata).length) delete patch.metadata;
  }
  if (!Object.keys(patch).length) return { ok: false, reason: 'unchanged' };
  if (hasMarkers(patch)) return { ok: false, reason: 'redacted' };
  const object = applyMergePatch(live, patch) as KubeObject;
  delete object.status;
  if (isObject(object.metadata)) delete (object.metadata as JsonObject).managedFields;
  return {
    ok: true,
    object,
    yaml: YAML.stringify(object, { lineWidth: 0 }),
    patch,
  };
}
