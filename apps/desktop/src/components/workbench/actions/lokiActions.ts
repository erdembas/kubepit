import { emptyBuilder, LOKI_WORKLOAD_KINDS } from '@/lib/logs/logql';
import { dock } from '@/store/useDockStore';
import type { KubeObject } from '@/types';

/**
 * Openers of the Loki tab with the selector preselected: a pod (optionally
 * one container) or every pod of a workload, matched by the pod names its
 * kind generates.
 */

export function openLokiForPod(
  clusterId: string,
  namespace: string,
  pod: string,
  container: string | null = null,
) {
  dock.loki(clusterId, { builder: { ...emptyBuilder(namespace), pod, container } });
}

export function openLokiForWorkload(
  clusterId: string,
  namespace: string,
  kind: string,
  name: string,
) {
  dock.loki(clusterId, { builder: { ...emptyBuilder(namespace), workload: { kind, name } } });
}

/** Kinds whose details offer "Historical logs (Loki)". */
export function hasLokiLogs(kind: string): boolean {
  return kind === 'Pod' || LOKI_WORKLOAD_KINDS.has(kind);
}

export function openLokiForObject(clusterId: string, obj: KubeObject) {
  const namespace = obj.metadata.namespace ?? 'default';
  if (obj.kind === 'Pod') openLokiForPod(clusterId, namespace, obj.metadata.name);
  else openLokiForWorkload(clusterId, namespace, obj.kind, obj.metadata.name);
}
