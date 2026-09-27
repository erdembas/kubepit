import * as i18n from '@/i18n/core';
import { asArray, asObject, asString, isObject, spec, status } from '@/lib/kube/accessors';
import { containerNames, podContainers, type ContainerInfo } from '@/lib/kube/pods';
import { labelSelectorString } from '@/lib/kube/selectorString';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import type { KubeObject } from '@/types';
import { useActionDialogs } from './dialogStore';

/**
 * Openers for the logs & debug features: merged workload logs, the debug
 * container dialog and the container file browser.
 */

/** Kinds whose "Logs" opens the merged view of all their pods. */
export const MERGED_LOG_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
  'Service',
]);

function names(list: unknown): string[] {
  return asArray(list)
    .filter(isObject)
    .map((c) => asString(c.name))
    .filter(Boolean);
}

/** Selector and template containers of a workload (or a Service's selector). */
export function workloadLogTarget(obj: KubeObject) {
  const s = spec(obj);
  const selector = labelSelectorString(s.selector);
  const template = asObject(asObject(s.template).spec);
  return {
    namespace: obj.metadata.namespace ?? 'default',
    kind: obj.kind,
    name: obj.metadata.name,
    selector,
    containers: names(template.containers),
    initContainers: names(template.initContainers),
  };
}

/** Open the merged logs of every pod of `obj`; toasts when it selects nothing. */
export function openWorkloadLogs(clusterId: string, obj: KubeObject) {
  const target = workloadLogTarget(obj);
  if (!target.selector) {
    useAppStore
      .getState()
      .pushToast('info', i18n.t('{name} has no pod selector', { name: obj.metadata.name }));
    return;
  }
  dock.workloadLogs(clusterId, target);
}

/** Names of the pod's ephemeral (debug) containers. */
export function ephemeralContainerNames(pod: KubeObject): string[] {
  return names(spec(pod).ephemeralContainers);
}

/** The pod's ephemeral containers as `ContainerInfo` (same state logic as regular ones). */
export function ephemeralContainers(pod: KubeObject): ContainerInfo[] {
  const specs = asArray(spec(pod).ephemeralContainers).filter(isObject);
  if (specs.length === 0) return [];
  return podContainers({
    ...pod,
    spec: { containers: specs },
    status: { containerStatuses: asArray(status(pod).ephemeralContainerStatuses) },
  });
}

export function openPodDebug(clusterId: string, pod: KubeObject, target: string | null = null) {
  useActionDialogs.getState().open({ kind: 'debug', clusterId, pod, target });
}

/** File browser for a pod; debug containers are offered too (they have a shell). */
export function openPodFiles(clusterId: string, pod: KubeObject, container: string | null = null) {
  dock.files(
    clusterId,
    pod.metadata.namespace ?? 'default',
    pod.metadata.name,
    [...containerNames(pod, false), ...ephemeralContainerNames(pod)],
    container,
  );
}
