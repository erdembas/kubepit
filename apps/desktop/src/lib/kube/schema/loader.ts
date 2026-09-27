import { ipc } from '@/lib/ipc';
import type { ApiResourceInfo, ClusterId, OpenApiGvk, OpenApiIndex } from '@/types';
import { SchemaSet, type SchemaNode } from './openapi';

/**
 * On-demand schema loading for a cluster: the OpenAPI v3 index (re-read
 * after `INDEX_TTL`), one `SchemaSet` per group-version keyed by its
 * content hash, and discovery for `apiVersion`/`kind` completion. Failures
 * are remembered briefly so a cluster without OpenAPI v3 is not asked on
 * every keystroke; callers treat them as "no schema" and never block.
 */

const INDEX_TTL = 30_000;
const RESOURCES_TTL = 60_000;
const FAILURE_TTL = 30_000;

interface Entry<T> {
  at: number;
  promise: Promise<T>;
  failed: boolean;
}

interface ClusterCache {
  index: Entry<OpenApiIndex> | null;
  docs: Map<string, Entry<SchemaSet>>;
  resources: Entry<ApiResourceInfo[]> | null;
}

const caches = new Map<ClusterId, ClusterCache>();

function cacheOf(clusterId: ClusterId): ClusterCache {
  let cache = caches.get(clusterId);
  if (!cache) {
    cache = { index: null, docs: new Map(), resources: null };
    caches.set(clusterId, cache);
  }
  return cache;
}

function track<T>(promise: Promise<T>): Entry<T> {
  const entry: Entry<T> = { at: Date.now(), promise, failed: false };
  promise.catch(() => {
    entry.failed = true;
  });
  return entry;
}

function fresh<T>(entry: Entry<T> | null | undefined, ttl: number): entry is Entry<T> {
  return !!entry && Date.now() - entry.at < (entry.failed ? FAILURE_TTL : ttl);
}

export function splitApiVersion(apiVersion: string): { group: string; version: string } {
  const slash = apiVersion.indexOf('/');
  return slash < 0
    ? { group: '', version: apiVersion }
    : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

export function loadIndex(clusterId: ClusterId, refresh = false): Promise<OpenApiIndex> {
  const cache = cacheOf(clusterId);
  if (!refresh && fresh(cache.index, INDEX_TTL)) return cache.index.promise;
  const entry = track(
    ipc.openapiV3Index(clusterId, refresh).then((index) => {
      // Documents whose hash is gone are stale.
      const live = new Set(
        index.group_versions.map((gv) => docKey(gv.api_version, gv.hash, index)),
      );
      for (const key of cache.docs.keys()) if (!live.has(key)) cache.docs.delete(key);
      return index;
    }),
  );
  cache.index = entry;
  return entry.promise;
}

function docKey(apiVersion: string, hash: string | null, index: OpenApiIndex) {
  return `${apiVersion}@${hash ?? index.hash}`;
}

/** The schemas of one group-version; `null` when the cluster publishes none for it. */
export async function loadSchemaSet(
  clusterId: ClusterId,
  apiVersion: string,
): Promise<SchemaSet | null> {
  const index = await loadIndex(clusterId);
  const gv = index.group_versions.find((g) => g.api_version === apiVersion);
  if (!gv) return null;
  const cache = cacheOf(clusterId);
  const key = docKey(apiVersion, gv.hash, index);
  let entry = cache.docs.get(key);
  if (!fresh(entry, Infinity)) {
    entry = track(ipc.openapiV3Document(clusterId, apiVersion).then((doc) => new SchemaSet(doc)));
    cache.docs.set(key, entry);
  }
  return entry.promise;
}

/** Served resource types (preferred versions), cached briefly. */
export function servedResources(clusterId: ClusterId): Promise<ApiResourceInfo[]> {
  const cache = cacheOf(clusterId);
  if (!fresh(cache.resources, RESOURCES_TTL)) cache.resources = track(ipc.apiResources(clusterId));
  return cache.resources.promise;
}

export type KindResolution =
  | { status: 'ok'; set: SchemaSet; root: SchemaNode; name: string; gvk: OpenApiGvk }
  /** The cluster serves no such apiVersion. */
  | { status: 'unknown-version' }
  /** The apiVersion is served, the kind is not. */
  | { status: 'unknown-kind' }
  /** No schema to judge by (no OpenAPI v3, a failed request, a kind without schema). */
  | { status: 'unavailable' };

/** The root schema of `apiVersion` + `kind`, or why there is none. */
export async function resolveKind(
  clusterId: ClusterId,
  apiVersion: string,
  kind: string,
): Promise<KindResolution> {
  const gvk = { ...splitApiVersion(apiVersion), kind };
  const served = () => servedResources(clusterId).catch(() => null);
  try {
    const set = await loadSchemaSet(clusterId, apiVersion);
    if (!set) {
      // Discovery is the tie-breaker: aggregated APIs may publish no schema.
      const resources = await served();
      return resources && !resources.some((r) => r.api_version === apiVersion)
        ? { status: 'unknown-version' }
        : { status: 'unavailable' };
    }
    const found = set.findKind(gvk);
    if (found) return { status: 'ok', set, root: found.node, name: found.name, gvk };
    if (kind.endsWith('List')) return { status: 'unavailable' };
    const resources = await served();
    const listed = resources?.some((r) => r.api_version === apiVersion && r.kind === kind);
    return resources && !listed && set.listKinds().length
      ? { status: 'unknown-kind' }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Forget a cluster's schemas (e.g. after a reconnect to a different API server). */
export function forgetSchemas(clusterId: ClusterId) {
  caches.delete(clusterId);
}
