import { SquareTerminal } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { asArray, asObject, asString, isObject, spec } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { containerNames } from '@/lib/kube/pods';
import { dock } from '@/store/useDockStore';
import type { KubeObject } from '@/types';
import { useActionDialogs, type PortOption } from './dialogStore';

/** Pod-level helpers shared by actions, container cards and the ports tables. */

export interface Anchor {
  x: number;
  y: number;
}

export function podPorts(pod: KubeObject): PortOption[] {
  const out: PortOption[] = [];
  for (const c of asArray(spec(pod).containers).filter(isObject))
    for (const p of asArray(c.ports).filter(isObject))
      out.push({
        port: Number(p.containerPort),
        name: asString(p.name) || asString(c.name),
        protocol: asString(p.protocol) || 'TCP',
      });
  return out.filter((p) => Number.isFinite(p.port) && p.protocol === 'TCP');
}

export function servicePortOptions(svc: KubeObject): PortOption[] {
  return asArray(spec(svc).ports)
    .filter(isObject)
    .map((p) => ({
      port: Number(p.port),
      name: asString(p.name),
      protocol: asString(p.protocol) || 'TCP',
    }))
    .filter((p) => Number.isFinite(p.port) && p.protocol === 'TCP');
}

/** Pods selected by a controller (first one is used for Logs). */
export async function podsForWorkload(clusterId: string, obj: KubeObject): Promise<KubeObject[]> {
  const raw = asObject(spec(obj).selector);
  const labels = asObject(raw.matchLabels ?? (obj.kind === 'ReplicationController' ? raw : {}));
  const selector = Object.entries(labels)
    .map(([k, v]) => `${k}=${asString(v)}`)
    .join(',');
  if (!selector) return [];
  const list = await ipc.resourceList(
    clusterId,
    toGvk(BUILTIN.Pod),
    obj.metadata.namespace ?? null,
    selector,
  );
  return list.items.sort(
    (a, b) => Number(b.status?.phase === 'Running') - Number(a.status?.phase === 'Running'),
  );
}

export function openPodLogs(clusterId: string, pod: KubeObject, container: string | null = null) {
  dock.logs(
    clusterId,
    pod.metadata.namespace ?? 'default',
    pod.metadata.name,
    containerNames(pod, true),
    container,
  );
}

export function pickContainer(
  clusterId: string,
  pod: KubeObject,
  anchor: Anchor,
  run: (container: string | null) => void,
) {
  const names = containerNames(pod, false);
  if (names.length <= 1) {
    run(names[0] ?? null);
    return;
  }
  useActionDialogs.getState().open({
    kind: 'menu',
    clusterId,
    x: anchor.x,
    y: anchor.y,
    items: names.map((name) => ({
      id: name,
      label: name,
      icon: <SquareTerminalIcon />,
      onClick: () => run(name),
    })),
  });
}

function SquareTerminalIcon() {
  return <SquareTerminal size={12} />;
}

export function openPodShell(clusterId: string, pod: KubeObject, anchor: Anchor) {
  pickContainer(clusterId, pod, anchor, (c) =>
    dock.podExec(clusterId, pod.metadata.namespace ?? 'default', pod.metadata.name, c),
  );
}
