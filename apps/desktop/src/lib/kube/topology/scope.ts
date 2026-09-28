import type { Gvk, KubeObject } from '@/types';
import { asObject, asString, field, spec } from '../accessors';
import { kindKey } from '../catalog';

/**
 * Watch scope of one topology slot: a namespace list (`[]` = cluster-wide, or
 * a cluster-scoped kind), or `null` when the slot is not watched at all.
 */
export type SlotScope = readonly string[] | null;

/**
 * The one kind that ties a cluster-scoped root to namespaces. It is watched
 * cluster-wide (the key other views already share); the namespaces of the
 * objects that match the root scope every other namespaced slot.
 */
export interface MapSeed {
  gvkKey: string;
  matches(o: KubeObject, rootName: string): boolean;
}

const SEEDS: Record<string, MapSeed> = {
  Node: {
    gvkKey: 'pods',
    matches: (o, name) => asString(spec(o).nodeName) === name,
  },
  StorageClass: {
    gvkKey: 'persistentvolumeclaims',
    matches: (o, name) => asString(spec(o).storageClassName) === name,
  },
  ClusterRole: {
    gvkKey: 'rolebindings.rbac.authorization.k8s.io',
    matches: (o, name) => {
      const ref = asObject(field(o, 'roleRef'));
      return asString(ref.kind) === 'ClusterRole' && asString(ref.name) === name;
    },
  },
  IngressClass: {
    gvkKey: 'ingresses.networking.k8s.io',
    matches: (o, name) => asString(spec(o).ingressClassName) === name,
  },
};

/** Seed kind of a cluster-scoped root, or null when nothing ties it to namespaces. */
export function mapSeed(rootKind: string): MapSeed | null {
  return Object.hasOwn(SEEDS, rootKind) ? SEEDS[rootKind]! : null;
}

/**
 * Per-slot watch scope of the Map tab of a cluster-scoped root. The seed slot
 * and cluster-scoped slots are watched cluster-wide; every other namespaced
 * slot is scoped to the namespaces of the seed objects that match the root.
 * Namespaced slots stay unwatched (`null`) while the seed has not synced, when
 * nothing matches, and for roots without a seed: they never fall back to
 * cluster-wide.
 */
export function planMapScope(
  root: { kind: string; name: string },
  sources: ReadonlyArray<Gvk | null>,
  seed: { items: readonly KubeObject[]; synced: boolean } | null,
): SlotScope[] {
  const def = mapSeed(root.kind);
  let namespaces: string[] | null = null;
  if (def && seed?.synced) {
    const found = new Set<string>();
    for (const o of seed.items) {
      const ns = o.metadata.namespace;
      if (ns && def.matches(o, root.name)) found.add(ns);
    }
    if (found.size) namespaces = [...found].sort();
  }
  return sources.map((gvk) => {
    if (!gvk) return null;
    if (!gvk.namespaced) return [];
    if (def && kindKey(gvk) === def.gvkKey) return [];
    return namespaces;
  });
}

/**
 * Namespaces the graph is scoped to: the union of the explicit namespace
 * lists. Cluster-wide slots (`[]`) add nothing unless no slot names a
 * namespace, in which case the result is `[]` (all namespaces).
 */
export function scopeNamespaces(slots: ReadonlyArray<SlotScope>): string[] {
  const found = new Set<string>();
  for (const s of slots) for (const ns of s ?? []) found.add(ns);
  return [...found].sort();
}
