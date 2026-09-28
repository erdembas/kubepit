import { generateScaleObjects, type ScalePresetName } from '@/lib/ipc/mock/fixtures/scale';
import { parseApiVersion } from '@/lib/kube/catalog';
import type { HealthInput, HealthKind } from '@/lib/kube/health';
import { emptyHealthInput } from '@/lib/kube/health/testing';
import type { NpInput } from '@/lib/kube/netpol';
import { topologySources, type TopologyInput } from '@/lib/kube/topology';
import type { KubeObject } from '@/types';

/**
 * Inputs of the engine benches (`*.bench.ts`). Built from the scaled demo
 * objects (`generateScaleObjects`, the same presets as the Rust fixture),
 * so every run measures the same data. Pure and deterministic; perf tooling
 * only, never imported by app code.
 */

/** A fixed clock for scans, so ages and findings never drift between runs. */
export const BENCH_NOW = Date.parse('2026-09-28T12:00:00Z');

const cache = new Map<ScalePresetName, KubeObject[]>();

/** Every object of `c-scale-<preset>`, generated once per bench file. */
export function scaleObjects(preset: ScalePresetName): KubeObject[] {
  let objects = cache.get(preset);
  if (!objects) cache.set(preset, (objects = generateScaleObjects(preset, `c-scale-${preset}`)));
  return objects;
}

const groupKind = (group: string, kind: string) => `${group}/${kind}`;

/** The objects of one preset per `group/kind`. */
function byGroupKind(preset: ScalePresetName): Map<string, KubeObject[]> {
  const out = new Map<string, KubeObject[]>();
  for (const o of scaleObjects(preset)) {
    const key = groupKind(parseApiVersion(o.apiVersion).group, o.kind);
    let items = out.get(key);
    if (!items) out.set(key, (items = []));
    items.push(o);
  }
  return out;
}

const ofKind = (preset: ScalePresetName, kind: string) =>
  scaleObjects(preset).filter((o) => o.kind === kind);

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const HEALTH_KINDS: Partial<Record<string, HealthKind>> = {
  Pod: 'pods',
  Deployment: 'deployments',
  StatefulSet: 'statefulSets',
  DaemonSet: 'daemonSets',
  Job: 'jobs',
  CronJob: 'cronJobs',
  Service: 'services',
  Ingress: 'ingresses',
  ConfigMap: 'configMaps',
  Secret: 'secrets',
  ServiceAccount: 'serviceAccounts',
  PersistentVolumeClaim: 'pvcs',
  PodDisruptionBudget: 'pdbs',
  HorizontalPodAutoscaler: 'hpas',
  Node: 'nodes',
  Namespace: 'namespaces',
  Role: 'roles',
  ClusterRole: 'clusterRoles',
  RoleBinding: 'roleBindings',
  ClusterRoleBinding: 'clusterRoleBindings',
};

/** A health scan input over the whole preset, every list loaded. */
export function healthInputFor(preset: ScalePresetName): HealthInput {
  const lists: Partial<Record<HealthKind, KubeObject[]>> = {};
  for (const o of scaleObjects(preset)) {
    const kind = HEALTH_KINDS[o.kind];
    if (kind) (lists[kind] ??= []).push(o);
  }
  return emptyHealthInput({ ...lists, now: BENCH_NOW, rightsizing: null });
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/**
 * The Resource Map's input: one synced list per map source, namespaced kinds
 * scoped to `namespace` (`null`: all namespaces), cluster-scoped kinds whole,
 * as the map watches them.
 */
export function topologyInputFor(preset: ScalePresetName, namespace: string | null): TopologyInput {
  const objects = byGroupKind(preset);
  const lists = topologySources(null).flatMap((gvk) => {
    if (!gvk) return [];
    const all = objects.get(groupKind(gvk.group, gvk.kind)) ?? [];
    const items =
      gvk.namespaced && namespace ? all.filter((o) => o.metadata.namespace === namespace) : all;
    return [{ gvk, items, synced: true }];
  });
  return { lists, namespaces: namespace ? [namespace] : [], apiResources: null };
}

// ---------------------------------------------------------------------------
// NetworkPolicy
// ---------------------------------------------------------------------------

const DEFAULT_DENY_NAMESPACES = ['ns-0001', 'ns-0002'];
const LABEL_POLICIES = 1000;

function policy(namespace: string, name: string, spec: Record<string, unknown>): KubeObject {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name,
      namespace,
      uid: `np-${namespace}-${name}`,
      creationTimestamp: '2026-08-01T00:00:00Z',
    },
    spec,
  };
}

/**
 * NetworkPolicies for the simulator bench: a default deny (ingress and
 * egress) in `ns-0001` and `ns-0002`, plus 1 000 label policies spread over
 * the Deployments round-robin. Each selects one app's pods and admits its
 * team's pods on 8080, from its own namespace or, every third policy, from
 * namespaces labelled with the team.
 */
export function netpolPolicies(preset: ScalePresetName): KubeObject[] {
  const out = DEFAULT_DENY_NAMESPACES.map((ns) =>
    policy(ns, 'default-deny', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
  );
  const deployments = ofKind(preset, 'Deployment');
  for (let i = 0; i < LABEL_POLICIES && deployments.length; i++) {
    const d = deployments[i % deployments.length]!;
    const { app = '', team = '' } = d.metadata.labels ?? {};
    const peer =
      i % 3 === 0
        ? { namespaceSelector: { matchLabels: { team } }, podSelector: { matchLabels: { team } } }
        : { podSelector: { matchLabels: { team } } };
    out.push(
      policy(d.metadata.namespace!, `allow-${team}-${i}`, {
        podSelector: { matchLabels: { app } },
        policyTypes: ['Ingress'],
        ingress: [{ from: [peer], ports: [{ protocol: 'TCP', port: 8080 }] }],
      }),
    );
  }
  return out;
}

/** The simulator's input over the whole preset, with {@link netpolPolicies}. */
export function netpolInputFor(preset: ScalePresetName): NpInput {
  return {
    namespaces: ofKind(preset, 'Namespace'),
    pods: ofKind(preset, 'Pod'),
    services: ofKind(preset, 'Service'),
    policies: netpolPolicies(preset),
  };
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export type LogFormat = 'json' | 'logfmt' | 'text';

const LEVELS = ['info', 'info', 'info', 'info', 'debug', 'warn', 'info', 'error'];
const PATHS = ['/api/v1/orders', '/api/v1/items', '/healthz', '/api/v1/users/me', '/metrics'];
const METHODS = ['GET', 'GET', 'POST', 'GET', 'PUT'];

/** A kubelet timestamp prefix (`kubectl logs --timestamps`), 1 ms apart. */
function k8sTime(i: number) {
  const ms = Date.parse('2026-09-28T10:00:00Z') + i;
  return new Date(ms).toISOString().replace('Z', '000000Z');
}

function logLine(format: LogFormat, i: number): string {
  const level = LEVELS[i % LEVELS.length]!;
  const path = `${PATHS[i % PATHS.length]}/${i % 997}`;
  const method = METHODS[i % METHODS.length]!;
  const status = level === 'error' ? 500 : level === 'warn' ? 429 : 200;
  const ms = ((i * 37) % 900) / 10;
  const trace = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
  const at = new Date(Date.parse('2026-09-28T10:00:00Z') + i).toISOString();
  switch (format) {
    case 'json':
      return `${k8sTime(i)} {"ts":"${at}","level":"${level}","logger":"http","msg":"request handled","method":"${method}","path":"${path}","status":${status},"duration_ms":${ms},"trace_id":"${trace}"}`;
    case 'logfmt':
      return `${k8sTime(i)} time=${at} level=${level} logger=http msg="request handled" method=${method} path=${path} status=${status} duration=${ms}ms trace_id=${trace}`;
    case 'text':
      return `${k8sTime(i)} ${at.replace('T', ' ').slice(0, 23)} ${level.toUpperCase()} [http-nio-8080-exec-${i % 16}] c.e.orders.OrderController : ${method} ${path} -> ${status} in ${ms} ms`;
  }
}

/** `n` log lines of one format, deterministic, with a level mix and kubelet timestamps. */
export function logLines(format: LogFormat, n: number): string[] {
  return Array.from({ length: n }, (_, i) => logLine(format, i));
}

const STACK = [
  'java.lang.IllegalStateException: order service unavailable',
  '\tat com.example.orders.OrderClient.fetch(OrderClient.java:88)',
  '\tat com.example.orders.OrderController.get(OrderController.java:42)',
  '\t... 12 more',
];

/**
 * `n` raw lines as the dock buffers them: the three formats interleaved,
 * with a four-line Java stack trace after every 50th line.
 */
export function mixedRawLines(n: number): Array<{ seq: number; text: string }> {
  const formats: LogFormat[] = ['json', 'logfmt', 'text'];
  const out: Array<{ seq: number; text: string }> = [];
  for (let i = 0; out.length < n; i++) {
    out.push({ seq: out.length, text: logLine(formats[i % 3]!, i) });
    if (i % 50 === 49)
      for (const line of STACK) {
        if (out.length >= n) break;
        out.push({ seq: out.length, text: `${k8sTime(i)} ${line}` });
      }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** The rows of the pods table of `c-scale-<preset>` (all namespaces). */
export function tableItems(preset: ScalePresetName): KubeObject[] {
  return ofKind(preset, 'Pod');
}
