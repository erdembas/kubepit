import { stringify } from 'yaml';
import type { KubeObject } from '@/types';

/**
 * Object normalisation for diffs. Two views of "the same" object differ in
 * fields nobody wrote: server bookkeeping (uid, resourceVersion, managed
 * fields…) and, across clusters, values the cluster assigns (cluster IPs,
 * owner uids, revision counters). Stripping them keeps a diff about intent.
 *
 * - `edit`   — live object vs. an edited / dry-run version on the same
 *              cluster: drop server bookkeeping only.
 * - `compare` — the same object on two clusters (or two objects of a kind):
 *              also drop cluster-assigned values and sort keys so field
 *              order from different API server versions never shows up.
 */
export type NormalizeMode = 'edit' | 'compare';

export interface NormalizeOptions {
  mode?: NormalizeMode;
  /** Keep `.status` (default false: status is observed state, not intent). */
  keepStatus?: boolean;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const META_BOOKKEEPING = [
  'managedFields',
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'selfLink',
] as const;

const NOISY_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration'];

/** Annotations the controllers bump on their own; noise across clusters. */
const COMPARE_ANNOTATIONS = [
  'deployment.kubernetes.io/revision',
  'deprecated.daemonset.template.generation',
  'meta.helm.sh/release-namespace',
];

const COMPARE_LABELS = ['pod-template-hash', 'controller-revision-hash'];

/** Service spec values the cluster allocates. */
const COMPARE_SERVICE_SPEC = ['clusterIP', 'clusterIPs', 'healthCheckNodePort'];

const TOP_LEVEL_ORDER = ['apiVersion', 'kind', 'metadata', 'spec', 'data', 'stringData', 'type'];

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function dropKeys(target: JsonObject | undefined, keys: readonly string[]) {
  if (!target) return;
  for (const key of keys) delete target[key];
}

function pruneEmpty(target: JsonObject, key: string) {
  const value = target[key];
  if (isObject(value) && Object.keys(value).length === 0) delete target[key];
}

function sortDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]!);
  return out;
}

function orderTopLevel(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of TOP_LEVEL_ORDER) if (key in obj) out[key] = obj[key]!;
  for (const key of Object.keys(obj).sort())
    if (!(key in out) && key !== 'status') out[key] = obj[key]!;
  if ('status' in obj) out.status = obj.status!;
  return out;
}

/** A deep copy of `obj` with diff noise removed (see module docs). */
export function normalizeObject(
  obj: KubeObject | Record<string, unknown>,
  { mode = 'edit', keepStatus = false }: NormalizeOptions = {},
): JsonObject {
  const copy = clone(obj) as unknown as JsonObject;
  if (!keepStatus) delete copy.status;
  const meta = isObject(copy.metadata) ? copy.metadata : undefined;
  if (meta) {
    dropKeys(meta, META_BOOKKEEPING);
    const annotations = isObject(meta.annotations) ? meta.annotations : undefined;
    const labels = isObject(meta.labels) ? meta.labels : undefined;
    dropKeys(annotations, NOISY_ANNOTATIONS);
    if (mode === 'compare') {
      dropKeys(annotations, COMPARE_ANNOTATIONS);
      dropKeys(labels, COMPARE_LABELS);
      if (Array.isArray(meta.ownerReferences)) {
        for (const ref of meta.ownerReferences) if (isObject(ref)) delete ref.uid;
      }
    }
    pruneEmpty(meta, 'annotations');
    pruneEmpty(meta, 'labels');
  }
  if (mode === 'compare' && copy.kind === 'Service' && isObject(copy.spec)) {
    dropKeys(copy.spec, COMPARE_SERVICE_SPEC);
  }
  if (mode === 'compare') return orderTopLevel(sortDeep(copy) as JsonObject);
  return orderTopLevel(copy);
}

/** YAML rendering used on both sides of every diff (stable, no line folding). */
export function toDiffYaml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
}

/** `normalizeObject` + `toDiffYaml`; `null` (object missing) renders as ''. */
export function normalizedYaml(
  obj: KubeObject | Record<string, unknown> | null | undefined,
  options?: NormalizeOptions,
): string {
  return obj ? toDiffYaml(normalizeObject(obj, options)) : '';
}
