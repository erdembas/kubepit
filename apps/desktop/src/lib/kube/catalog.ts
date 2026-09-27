import type { ApiResourceInfo, Gvk } from '@/types';
import { BUILTIN_KINDS, type KindDef } from './kinds';

export * from './kinds';

/**
 * Static catalog of the built-in Kubernetes kinds the workbench knows how to
 * list, plus helpers that turn discovery data (`ApiResourceInfo`) and owner
 * references (`apiVersion` + `kind`) into addressable `Gvk`s.
 *
 * A *kind key* is the kubectl resource name: `pods`, `deployments.apps`,
 * `certificates.cert-manager.io`. It is stable across versions, so it is
 * what the workbench persists (active kind, column prefs, pins).
 */

const byKey = new Map<string, KindDef>(BUILTIN_KINDS.map((k) => [k.key, k]));
const byGroupKind = new Map<string, KindDef>(BUILTIN_KINDS.map((k) => [`${k.group}/${k.kind}`, k]));

/**
 * API groups that ship with Kubernetes. Discovery entries outside this set
 * are treated as custom resources (even when their group ends in `.k8s.io`,
 * like the Gateway API or volume snapshots).
 */
export const BUILTIN_GROUPS = new Set([
  '',
  'apps',
  'batch',
  'autoscaling',
  'policy',
  'networking.k8s.io',
  'discovery.k8s.io',
  'storage.k8s.io',
  'rbac.authorization.k8s.io',
  'scheduling.k8s.io',
  'node.k8s.io',
  'coordination.k8s.io',
  'admissionregistration.k8s.io',
  'apiextensions.k8s.io',
  'apiregistration.k8s.io',
  'certificates.k8s.io',
  'events.k8s.io',
  'flowcontrol.apiserver.k8s.io',
  'authentication.k8s.io',
  'authorization.k8s.io',
  'resource.k8s.io',
  'storagemigration.k8s.io',
  'internal.apiserver.k8s.io',
  'metrics.k8s.io',
]);

export function kindKey(gvk: Pick<Gvk, 'group' | 'plural'>): string {
  return gvk.group ? `${gvk.plural}.${gvk.group}` : gvk.plural;
}

export function builtinByKey(key: string): KindDef | undefined {
  return byKey.get(key);
}

export function builtinByGroupKind(group: string, kind: string): KindDef | undefined {
  return byGroupKind.get(`${group}/${kind}`);
}

export function isBuiltinKey(key: string): boolean {
  return byKey.has(key);
}

export function toGvk(k: Gvk): Gvk {
  return {
    group: k.group,
    version: k.version,
    kind: k.kind,
    plural: k.plural,
    namespaced: k.namespaced,
  };
}

export function parseApiVersion(apiVersion: string): { group: string; version: string } {
  const slash = apiVersion.indexOf('/');
  return slash < 0
    ? { group: '', version: apiVersion }
    : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

export function apiVersionOf(gvk: Pick<Gvk, 'group' | 'version'>): string {
  return gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version;
}

export function gvkFromApiResource(r: ApiResourceInfo): Gvk {
  return {
    group: r.group,
    version: r.version,
    kind: r.kind,
    plural: r.plural,
    namespaced: r.namespaced,
  };
}

export function isCustomResource(r: Pick<Gvk, 'group'>): boolean {
  return !BUILTIN_GROUPS.has(r.group);
}

/** Naive English pluralisation for kinds we have never seen in discovery. */
function guessPlural(kind: string): string {
  const lower = kind.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/**
 * Resolve an object reference (`ownerReferences[]`, `involvedObject`,
 * RBAC `roleRef`) to a Gvk. Built-ins win, then discovery, then a guess so
 * links to exotic kinds still work when the server serves them.
 */
export function resolveRef(
  apiVersion: string | undefined,
  kind: string,
  apiResources?: readonly ApiResourceInfo[] | null,
): Gvk | null {
  if (!kind) return null;
  const parsed = apiVersion ? parseApiVersion(apiVersion) : null;
  if (parsed) {
    const builtin = builtinByGroupKind(parsed.group, kind);
    if (builtin) return toGvk({ ...builtin, version: parsed.version || builtin.version });
    const found = apiResources?.find((r) => r.group === parsed.group && r.kind === kind);
    if (found) return gvkFromApiResource(found);
    return {
      group: parsed.group,
      version: parsed.version,
      kind,
      plural: guessPlural(kind),
      namespaced: true,
    };
  }
  // No apiVersion (e.g. events' involvedObject without one): search by kind.
  const builtin = BUILTIN_KINDS.find((k) => k.kind === kind);
  if (builtin) return toGvk(builtin);
  const found = apiResources?.find((r) => r.kind === kind);
  return found ? gvkFromApiResource(found) : null;
}

/** Lookup by kind key: built-in catalog first, then discovery. */
export function gvkForKey(
  key: string,
  apiResources?: readonly ApiResourceInfo[] | null,
): Gvk | null {
  const builtin = builtinByKey(key);
  if (builtin) return toGvk(builtin);
  const found = apiResources?.find((r) => kindKey(r) === key);
  return found ? gvkFromApiResource(found) : null;
}

/** True when discovery says the server serves this built-in (or discovery is unknown). */
export function isServed(
  k: Pick<Gvk, 'group' | 'plural'>,
  apiResources?: readonly ApiResourceInfo[] | null,
) {
  if (!apiResources) return true;
  return apiResources.some((r) => r.group === k.group && r.plural === k.plural);
}

/**
 * Resolve a free-form kind reference (`Pod`, `pods`, `deploy`,
 * `deployments.apps`, `Certificate`) to a Gvk.
 */
export function resolveKindName(
  kind: string,
  apiResources?: readonly ApiResourceInfo[] | null,
): Gvk | null {
  const q = kind.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  const builtin =
    BUILTIN_KINDS.find((k) => k.kind === q) ??
    BUILTIN_KINDS.find(
      (k) =>
        k.key === lower ||
        k.plural === lower ||
        k.kind.toLowerCase() === lower ||
        k.shortNames.includes(lower),
    );
  if (builtin) return toGvk(builtin);
  const found =
    apiResources?.find((r) => r.kind === q) ??
    apiResources?.find(
      (r) =>
        kindKey(r) === lower ||
        r.plural === lower ||
        r.kind.toLowerCase() === lower ||
        r.short_names.includes(lower),
    );
  return found ? gvkFromApiResource(found) : null;
}
