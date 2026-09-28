import { useMemo, useRef } from 'react';
import { BUILTIN, gvkFromApiResource, isServed, toGvk } from '@/lib/kube/catalog';
import {
  buildCluster,
  detectCni,
  EXTRA_POLICY_KINDS,
  extraPolicyResources,
  unevaluatedPolicies,
  type CniDetection,
  type NpCluster,
  type UnevaluatedPolicy,
} from '@/lib/kube/netpol';
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { hasListError } from '../data/listState';
import { useWatch, type WatchSnapshot } from '../data/watchCache';
import { watchErrors, type NetpolWatchError } from './uncertain';

export type { NetpolWatchError };

/**
 * Live input of the NetworkPolicy simulator: pods, namespaces, policies
 * and Services cluster-wide (falling back to the selected namespaces when
 * listing everywhere is forbidden), DaemonSets for the CNI guess and the
 * policy kinds of other engines. Watches are the shared, ref-counted ones
 * the tables use; the model is rebuilt once per delivered batch and
 * shared by every component showing the same snapshot.
 */

export interface NetpolData {
  cluster: NpCluster;
  /** Every list delivered (or failed). */
  synced: boolean;
  loading: boolean;
  errors: NetpolWatchError[];
  /**
   * The NetworkPolicy list failed or only partly loaded (one namespace
   * forbidden): verdicts are not certain, pods may look unprotected.
   */
  policiesIncomplete: boolean;
  /** Only the selected namespaces could be listed. */
  scoped: boolean;
  cni: CniDetection;
  unevaluated: UnevaluatedPolicy[];
  /** Live objects for links and the docked details panel. */
  policyObject: (namespace: string, name: string) => KubeObject | null;
  podObject: (namespace: string, name: string) => KubeObject | null;
}

/** Cluster-wide watch, falling back to `fallback` namespaces when that is forbidden. */
function useScopedWatch(
  clusterId: ClusterId,
  gvk: Gvk | null,
  fallback: readonly string[],
  enabled: boolean,
): WatchSnapshot & { scoped: boolean } {
  const all = useWatch(clusterId, gvk, [], enabled);
  const scoped = !!gvk?.namespaced && all.forbidden && fallback.length > 0;
  const narrow = useWatch(clusterId, gvk, fallback, enabled && scoped);
  return { ...(scoped ? narrow : all), scoped };
}

interface Built {
  key: string;
  cluster: NpCluster;
}
const shared = new Map<ClusterId, Built>();

const KUBE_SYSTEM = ['kube-system'];

export function useNetpolData(
  clusterId: ClusterId,
  namespaces: readonly string[],
  enabled: boolean,
  apiResources: readonly ApiResourceInfo[] | null,
): NetpolData {
  const gvks = useMemo(() => {
    const g = (k: (typeof BUILTIN)[keyof typeof BUILTIN]) =>
      isServed(k, apiResources) ? toGvk(k) : null;
    return {
      pods: g(BUILTIN.Pod),
      namespaces: g(BUILTIN.Namespace),
      policies: g(BUILTIN.NetworkPolicy),
      services: g(BUILTIN.Service),
      daemonSets: g(BUILTIN.DaemonSet),
      extra: extraPolicyResources(apiResources).map((r) => (r ? gvkFromApiResource(r) : null)),
    };
  }, [apiResources]);

  const pods = useScopedWatch(clusterId, gvks.pods, namespaces, enabled);
  const nsList = useWatch(clusterId, gvks.namespaces, [], enabled);
  const policies = useScopedWatch(clusterId, gvks.policies, namespaces, enabled);
  const services = useScopedWatch(clusterId, gvks.services, namespaces, enabled);
  const daemonSets = useScopedWatch(clusterId, gvks.daemonSets, KUBE_SYSTEM, enabled);
  const extra: WatchSnapshot[] = [];
  // EXTRA_POLICY_KINDS has a fixed length, so the hook order never changes.
  for (let i = 0; i < EXTRA_POLICY_KINDS.length; i++)
    // eslint-disable-next-line react-hooks/rules-of-hooks
    extra.push(useScopedWatch(clusterId, gvks.extra[i] ?? null, namespaces, enabled));

  const core = [pods, nsList, policies, services];
  const narrowed = pods.scoped || policies.scoped || services.scoped;
  const key = [
    ...core.map((s) => `${s.version}:${s.status}:${s.items.length}:${s.error ? 1 : 0}`),
    nsList.status === 'error' ? 'ns-error' : '',
    narrowed
      ? `scoped:${[pods.scoped, policies.scoped, services.scoped].join(',')}:${namespaces.join(',')}`
      : '',
  ].join('|');
  const snapsRef = useRef({ pods, nsList, policies, services });
  snapsRef.current = { pods, nsList, policies, services };

  const cluster = useMemo(() => {
    const cached = shared.get(clusterId);
    if (cached?.key === key) return cached.cluster;
    const s = snapsRef.current;
    const built = buildCluster({
      namespaces: s.nsList.status === 'error' ? null : s.nsList.items,
      pods: s.pods.items,
      policies: s.policies.items,
      services: s.services.items,
    });
    shared.set(clusterId, { key, cluster: built });
    return built;
  }, [clusterId, key]);

  const dsKey = `${daemonSets.version}:${daemonSets.status}`;
  const dsRef = useRef(daemonSets);
  dsRef.current = daemonSets;
  const cni = useMemo(() => {
    const ds = dsRef.current;
    if (ds.status === 'error' || (!ds.synced && !ds.items.length)) {
      return ds.status === 'error'
        ? detectCni(null)
        : { enforcement: 'unknown' as const, plugins: [], unreadable: false };
    }
    return detectCni(ds.items);
    // `dsKey` captures the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsKey]);

  const extraKey = extra.map((s) => `${s.version}:${s.status}`).join(',');
  const extraRef = useRef(extra);
  extraRef.current = extra;
  const unevaluated = useMemo(
    () =>
      unevaluatedPolicies(
        EXTRA_POLICY_KINDS.map((kind, i) => ({
          kind,
          items: gvks.extra[i] ? (extraRef.current[i]?.items ?? []) : [],
        })),
      ),
    // `extraKey` captures every snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extraKey, gvks],
  );

  const errors = watchErrors([
    ['Pod', pods],
    ['NetworkPolicy', policies],
    ['Service', services],
    ['Namespace', nsList],
  ]);
  const policiesIncomplete = !!gvks.policies && hasListError(policies);

  const watched = [pods, policies, services, nsList].filter(
    (_, i) => [gvks.pods, gvks.policies, gvks.services, gvks.namespaces][i],
  );
  const synced = watched.every((s) => s.synced || s.status === 'error');
  const loading = watched.some((s) => s.status === 'loading');

  const policyItems = policies.items;
  const podItems = pods.items;
  const lookups = useMemo(() => {
    const index = (items: readonly KubeObject[]) =>
      new Map(items.map((o) => [`${o.metadata.namespace ?? ''}/${o.metadata.name}`, o]));
    const byPolicy = index(policyItems);
    let byPod: Map<string, KubeObject> | null = null;
    return {
      policyObject: (namespace: string, name: string) =>
        byPolicy.get(`${namespace}/${name}`) ?? null,
      podObject: (namespace: string, name: string) => {
        byPod ??= index(podItems);
        return byPod.get(`${namespace}/${name}`) ?? null;
      },
    };
  }, [policyItems, podItems]);

  return {
    cluster,
    synced,
    loading,
    errors,
    policiesIncomplete,
    scoped: pods.scoped || policies.scoped,
    cni,
    unevaluated,
    ...lookups,
  };
}
