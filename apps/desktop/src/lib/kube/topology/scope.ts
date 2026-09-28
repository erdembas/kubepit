import type { Gvk, KubeObject } from '@/types';
import { asArray, asObject, asString, field, isObject, spec } from '../accessors';
import { kindKey } from '../catalog';

/**
 * Watch scope of one topology slot: a namespace list (`[]` = cluster-wide, or
 * a cluster-scoped kind), or `null` when the slot is not watched at all.
 */
export type SlotScope = readonly string[] | null;

/** The cluster-scoped root of a Map tab: what its seeds match against. */
export interface MapRoot {
  kind: string;
  name: string;
  annotations?: Readonly<Record<string, string>>;
  /** `subjects` of a ClusterRoleBinding root (raw Kubernetes JSON). */
  subjects?: unknown;
}

/** Marks the IngressClass that class-less Ingresses use. */
export const DEFAULT_INGRESS_CLASS_ANNOTATION = 'ingressclass.kubernetes.io/is-default-class';

/**
 * The kinds that tie a cluster-scoped root to namespaces. They are watched
 * cluster-wide (the keys other views already share); the namespaces their
 * objects name for the root scope every other namespaced slot. Each rule
 * mirrors how `buildTopology` links that kind to the root.
 */
export interface MapSeed {
  /** Kind keys of the seed watches: at most two, `MapTab` holds two seed watches. */
  gvkKeys: readonly string[];
  /** Namespaces one seed object ties the root to (none when it is unrelated). */
  namespaces(o: KubeObject, root: MapRoot): string[];
  /** Namespaces the root itself names, whatever the seed objects say. */
  rootNamespaces?(root: MapRoot): string[];
}

const own = (o: KubeObject) => (o.metadata.namespace ? [o.metadata.namespace] : []);

const namesRole = (o: KubeObject, root: MapRoot) => {
  const ref = asObject(field(o, 'roleRef'));
  return asString(ref.kind) === 'ClusterRole' && asString(ref.name) === root.name;
};

/** A binding's ServiceAccount subjects as `[namespace, name]` (`fallback` namespace when unset). */
function saSubjects(subjects: unknown, fallback: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const s of asArray(subjects).filter(isObject)) {
    if (asString(s.kind) !== 'ServiceAccount') continue;
    const ns = asString(s.namespace) || fallback;
    if (ns) out.push([ns, asString(s.name)]);
  }
  return out;
}

/** Namespaces of a binding's ServiceAccount subjects (`fallback` when unset). */
const subjectNamespaces = (o: KubeObject, fallback: string | undefined) =>
  saSubjects(field(o, 'subjects'), fallback).map(([ns]) => ns);

const SEEDS: Record<string, MapSeed> = {
  Node: {
    gvkKeys: ['pods'],
    namespaces: (o, root) => (asString(spec(o).nodeName) === root.name ? own(o) : []),
  },
  StorageClass: {
    gvkKeys: ['persistentvolumeclaims'],
    namespaces: (o, root) => (asString(spec(o).storageClassName) === root.name ? own(o) : []),
  },
  ClusterRole: {
    gvkKeys: [
      'rolebindings.rbac.authorization.k8s.io',
      'clusterrolebindings.rbac.authorization.k8s.io',
    ],
    namespaces: (o, root) => {
      if (!namesRole(o, root)) return [];
      // A RoleBinding lives in a namespace and binds subjects of any
      // namespace; a ClusterRoleBinding only reaches its subjects'.
      if (o.kind === 'RoleBinding')
        return [...own(o), ...subjectNamespaces(o, o.metadata.namespace)];
      if (o.kind === 'ClusterRoleBinding') return subjectNamespaces(o, undefined);
      return [];
    },
  },
  ClusterRoleBinding: {
    // Its ServiceAccount subjects, plus the RoleBindings elsewhere that bind
    // them (the builder links those once the service account is observed)
    // and so their Roles.
    gvkKeys: ['rolebindings.rbac.authorization.k8s.io'],
    rootNamespaces: (root) => saSubjects(root.subjects, undefined).map(([ns]) => ns),
    namespaces: (o, root) => {
      if (o.kind !== 'RoleBinding') return [];
      const bound = new Set(saSubjects(root.subjects, undefined).map(([ns, n]) => `${ns}/${n}`));
      return saSubjects(field(o, 'subjects'), o.metadata.namespace).some(([ns, n]) =>
        bound.has(`${ns}/${n}`),
      )
        ? own(o)
        : [];
    },
  },
  IngressClass: {
    gvkKeys: ['ingresses.networking.k8s.io'],
    namespaces: (o, root) => {
      const className =
        asString(spec(o).ingressClassName) ||
        o.metadata.annotations?.['kubernetes.io/ingress.class'] ||
        '';
      const isDefault = root.annotations?.[DEFAULT_INGRESS_CLASS_ANNOTATION] === 'true';
      return className === root.name || (!className && isDefault) ? own(o) : [];
    },
  },
};

/** Seed of a cluster-scoped root, or null when nothing ties it to namespaces. */
export function mapSeed(rootKind: string): MapSeed | null {
  return Object.hasOwn(SEEDS, rootKind) ? SEEDS[rootKind]! : null;
}

/**
 * Per-slot watch scope of the Map tab of a cluster-scoped root. The seed
 * slots and cluster-scoped slots are watched cluster-wide; every other
 * namespaced slot is scoped to the namespaces the root itself and the seed
 * objects name for it. `seed` holds the objects of every seed kind, synced
 * when all of them are (`null` when no seed kind is served). Namespaced slots
 * stay unwatched (`null`) while the seed has not synced, when nothing
 * matches, and for roots without a seed: they never fall back to
 * cluster-wide.
 */
export function planMapScope(
  root: MapRoot,
  sources: ReadonlyArray<Gvk | null>,
  seed: { items: readonly KubeObject[]; synced: boolean } | null,
): SlotScope[] {
  const def = mapSeed(root.kind);
  let namespaces: string[] | null = null;
  // A seed that is not served (`null`) has nothing to wait for.
  if (def && (seed === null || seed.synced)) {
    const found = new Set<string>(def.rootNamespaces?.(root) ?? []);
    for (const o of seed?.items ?? []) for (const ns of def.namespaces(o, root)) found.add(ns);
    if (found.size) namespaces = [...found].sort();
  }
  return sources.map((gvk) => {
    if (!gvk) return null;
    if (!gvk.namespaced) return [];
    if (def?.gvkKeys.includes(kindKey(gvk))) return [];
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

/**
 * Graph scope of a `planMapScope` plan: the namespaces it names, or `null`
 * when it names none. Unlike `scopeNamespaces`, "none" never means "all":
 * the seed slots are watched cluster-wide only to find namespaces, so their
 * objects elsewhere must not make placeholders for everything they reference.
 */
export function plannedGraphScope(plan: ReadonlyArray<SlotScope>): string[] | null {
  const found = scopeNamespaces(plan);
  return found.length ? found : null;
}
