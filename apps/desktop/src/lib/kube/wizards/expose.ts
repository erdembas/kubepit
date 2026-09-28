import type { KubeObject } from '@/types';
import { asArray, asNumber, asObject, asString, asStringMap, isObject, spec } from '../accessors';
import { matchesSelector, parseSelector } from '../selectors';
import { prune, type KeyValue } from './encoding';
import {
  labelsError,
  nameError,
  portNameError,
  portNumberError,
  targetPortError,
} from './validate';
import * as i18n from '@/i18n/core';

/**
 * `kubectl expose`: a Service for a workload or a pod. Ports come from the
 * pod template's container ports (named ports stay named and become the
 * target port), the selector from the workload's own selector.
 */

export const EXPOSABLE_KINDS = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Pod',
] as const;

export function isExposable(kind: string): boolean {
  return (EXPOSABLE_KINDS as readonly string[]).includes(kind);
}

export type ServiceKind = 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'Headless';
export type PortProtocol = 'TCP' | 'UDP' | 'SCTP';

export interface ServicePortDraft {
  name: string;
  port: string;
  /** Number or container port name. */
  targetPort: string;
  protocol: PortProtocol;
  /** NodePort / LoadBalancer only; empty = allocated by the cluster. */
  nodePort: string;
}

export interface ExposeInput {
  name: string;
  namespace: string;
  type: ServiceKind;
  ports: ServicePortDraft[];
  selector: KeyValue[];
  sessionAffinity: 'None' | 'ClientIP';
  /** Seconds, ClientIP affinity only. */
  affinityTimeout: string;
  externalTrafficPolicy: 'Cluster' | 'Local';
  labels: KeyValue[];
}

/** Labels that pin a selector to one revision or one pod; left out of defaults. */
const REVISION_LABELS = new Set([
  'pod-template-hash',
  'controller-revision-hash',
  'pod-template-generation',
  'batch.kubernetes.io/controller-uid',
  'controller-uid',
]);

interface PodTemplate {
  labels: Record<string, string>;
  containers: Record<string, unknown>[];
}

export function podTemplateOf(obj: KubeObject): PodTemplate {
  if (obj.kind === 'Pod')
    return {
      labels: obj.metadata.labels ?? {},
      containers: asArray(spec(obj).containers).filter(isObject),
    };
  const template = asObject(spec(obj).template);
  return {
    labels: asStringMap(asObject(template.metadata).labels),
    containers: asArray(asObject(template.spec).containers).filter(isObject),
  };
}

/** The selector the workload uses for its own pods (plain map form). */
export function workloadSelector(obj: KubeObject): Record<string, string> {
  if (obj.kind === 'Pod') {
    const labels = { ...(obj.metadata.labels ?? {}) };
    for (const key of Object.keys(labels)) if (REVISION_LABELS.has(key)) delete labels[key];
    return labels;
  }
  const raw = spec(obj).selector;
  const parsed = parseSelector(raw);
  if (parsed && Object.keys(parsed.matchLabels).length) return parsed.matchLabels;
  return podTemplateOf(obj).labels;
}

function defaultPortName(port: number, protocol: string): string {
  const prefix = protocol === 'TCP' ? 'tcp' : protocol.toLowerCase();
  return `${prefix}-${port}`;
}

/** One Service port per container port (deduplicated by port and protocol). */
export function templatePorts(obj: KubeObject): ServicePortDraft[] {
  const out: ServicePortDraft[] = [];
  const seen = new Set<string>();
  for (const container of podTemplateOf(obj).containers) {
    for (const p of asArray(container.ports).filter(isObject)) {
      const port = asNumber(p.containerPort);
      if (!port) continue;
      const protocol = (asString(p.protocol) || 'TCP') as PortProtocol;
      const key = `${port}/${protocol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = asString(p.name);
      out.push({
        name: name || defaultPortName(port, protocol),
        port: String(port),
        targetPort: name || String(port),
        protocol,
        nodePort: '',
      });
    }
  }
  return out;
}

export function emptyPort(): ServicePortDraft {
  return { name: '', port: '', targetPort: '', protocol: 'TCP', nodePort: '' };
}

/** Form defaults for exposing `obj`. */
export function exposeDefaults(obj: KubeObject | null, namespace: string): ExposeInput {
  const ports = obj ? templatePorts(obj) : [];
  const selector = obj ? workloadSelector(obj) : {};
  return {
    name: obj?.metadata.name ?? '',
    namespace: obj?.metadata.namespace ?? namespace,
    type: 'ClusterIP',
    ports: ports.length ? ports : [emptyPort()],
    selector: Object.entries(selector).map(([key, value]) => ({ key, value })),
    sessionAffinity: 'None',
    affinityTimeout: '10800',
    externalTrafficPolicy: 'Cluster',
    labels: [],
  };
}

function selectorMap(pairs: readonly KeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) if (p.key.trim()) out[p.key.trim()] = p.value;
  return out;
}

function portValue(value: string): number | string {
  return /^\d+$/.test(value.trim()) ? Number(value) : value.trim();
}

export function buildService(input: ExposeInput): Record<string, unknown> {
  const external = input.type === 'NodePort' || input.type === 'LoadBalancer';
  const ports = input.ports.map((p) =>
    prune({
      name: p.name.trim() || undefined,
      protocol: p.protocol,
      port: Number(p.port) || 0,
      targetPort: p.targetPort.trim() ? portValue(p.targetPort) : undefined,
      nodePort: external && p.nodePort.trim() ? Number(p.nodePort) : undefined,
    }),
  );
  const labels = selectorMap(input.labels);
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      ...(Object.keys(labels).length ? { labels } : {}),
    },
    spec: {
      type: input.type === 'Headless' ? 'ClusterIP' : input.type,
      ...(input.type === 'Headless' ? { clusterIP: 'None' } : {}),
      selector: selectorMap(input.selector),
      ports,
      ...(input.sessionAffinity === 'ClientIP'
        ? {
            sessionAffinity: 'ClientIP',
            sessionAffinityConfig: {
              clientIP: { timeoutSeconds: Number(input.affinityTimeout) || 10800 },
            },
          }
        : {}),
      ...(external && input.externalTrafficPolicy === 'Local'
        ? { externalTrafficPolicy: 'Local' }
        : {}),
    },
  };
}

/** Problems that block handing the Service to the editor, per field. */
export interface ExposeErrors {
  name: string | null;
  ports: Array<Partial<Record<keyof ServicePortDraft, string | null>>>;
  portsGeneral: string | null;
  selector: string | null;
  /** Not blocking: an empty selector is valid (manual Endpoints). */
  selectorWarning: string | null;
  labels: string | null;
  affinityTimeout: string | null;
}

export function validateExpose(input: ExposeInput): ExposeErrors {
  const external = input.type === 'NodePort' || input.type === 'LoadBalancer';
  const names = new Set<string>();
  const numbers = new Set<string>();
  let portsGeneral: string | null = null;
  const ports = input.ports.map((p) => {
    const name = portNameError(p.name.trim());
    const errors: Partial<Record<keyof ServicePortDraft, string | null>> = {
      name:
        name ??
        (input.ports.length > 1 && !p.name.trim()
          ? i18n.t('Name every port when there are several.')
          : null),
      port: portNumberError(p.port),
      targetPort: p.targetPort.trim() ? targetPortError(p.targetPort) : null,
      nodePort: null,
    };
    if (external && p.nodePort.trim()) {
      const n = Number(p.nodePort);
      if (!Number.isInteger(n) || n < 30000 || n > 32767)
        errors.nodePort = i18n.t('Node ports are usually between 30000 and 32767.');
    }
    const key = `${p.port}/${p.protocol}`;
    if (p.port && numbers.has(key))
      portsGeneral = i18n.t('Port {port} is listed twice.', { port: key });
    numbers.add(key);
    if (p.name.trim()) {
      if (names.has(p.name.trim()))
        portsGeneral = i18n.t('Port name {name} is used twice.', { name: p.name.trim() });
      names.add(p.name.trim());
    }
    return errors;
  });
  if (input.type !== 'Headless' && input.ports.length === 0)
    portsGeneral = i18n.t('Add at least one port.');
  const selectorPairs = input.selector.filter((p) => p.key.trim() || p.value);
  const timeout = Number(input.affinityTimeout);
  return {
    name: nameError(input.name, 'dns1035'),
    ports,
    portsGeneral,
    selector: labelsError(selectorPairs),
    selectorWarning:
      selectorPairs.length === 0
        ? i18n.t('Without a selector the Service sends traffic nowhere until you add Endpoints.')
        : null,
    labels: labelsError(input.labels),
    affinityTimeout:
      input.sessionAffinity === 'ClientIP' &&
      (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400)
        ? i18n.t('Use 1 to 86400 seconds.')
        : null,
  };
}

/** True when something in `errors` blocks (warnings do not). */
export function exposeBlocked(errors: ExposeErrors): boolean {
  return (
    !!errors.name ||
    !!errors.portsGeneral ||
    !!errors.selector ||
    !!errors.labels ||
    !!errors.affinityTimeout ||
    errors.ports.some((p) => Object.values(p).some(Boolean))
  );
}

/**
 * Pods the selector reaches beyond the exposed object's own pods (those its
 * own selector matches, or the pod itself). Empty selectors match nothing.
 */
export function foreignPods(
  selector: readonly KeyValue[],
  target: KubeObject | null,
  pods: readonly KubeObject[],
): KubeObject[] {
  const map = selectorMap(selector);
  if (!Object.keys(map).length) return [];
  const service = { matchLabels: map, matchExpressions: [] };
  const own =
    target && target.kind !== 'Pod'
      ? (parseSelector(spec(target).selector) ?? {
          matchLabels: podTemplateOf(target).labels,
          matchExpressions: [],
        })
      : null;
  return pods.filter((pod) => {
    if (!matchesSelector(service, pod.metadata.labels)) return false;
    if (target?.kind === 'Pod') return pod.metadata.uid !== target.metadata.uid;
    return !own || !matchesSelector(own, pod.metadata.labels);
  });
}

/** Pods the selector matches at all. */
export function matchedPods(
  selector: readonly KeyValue[],
  pods: readonly KubeObject[],
): KubeObject[] {
  const map = selectorMap(selector);
  if (!Object.keys(map).length) return [];
  const s = { matchLabels: map, matchExpressions: [] };
  return pods.filter((pod) => matchesSelector(s, pod.metadata.labels));
}
