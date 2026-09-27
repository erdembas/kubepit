import { JOURNALED_KINDS } from '@/lib/kube/changes/kinds';
import type { ChangeActor, ChangedPath, ChangeOp, Gvk, KubeObject } from '@/types';
import { find, list, type ClusterDb } from './db';
import { BOOT, DAY, HOUR, iso, MIN } from './util';

/**
 * Demo change journal: the same normalization and changed-path summary as
 * `change_journal/{normalize,diff}.rs`, plus a synthesized history of the
 * last day for every demo cluster (image bumps, scaling, ConfigMap edits,
 * a rotated Secret key, a deleted Service, RBAC and node changes). Secret
 * values never reach an entry: they are replaced by salted hash markers.
 */

type Json = Record<string, unknown>;

export interface JournalRecord {
  id: number;
  ts: number;
  gvk: Gvk;
  namespace: string | null;
  name: string;
  uid: string;
  op: ChangeOp;
  actor: ChangeActor | null;
  paths: ChangedPath[];
  pathCount: number;
  before: Json | null;
  after: Json | null;
}

// -- Normalization ------------------------------------------------------------

const NOISE_METADATA = ['resourceVersion', 'generation', 'managedFields', 'uid', 'selfLink'];
const NOISE_ANNOTATIONS = new Set([
  'kubectl.kubernetes.io/last-applied-configuration',
  'deployment.kubernetes.io/revision',
  'deployment.kubernetes.io/desired-replicas',
  'deployment.kubernetes.io/max-replicas',
  'control-plane.alpha.kubernetes.io/leader',
  'cluster-autoscaler.kubernetes.io/last-updated',
  'autoscaling.alpha.kubernetes.io/conditions',
  'autoscaling.alpha.kubernetes.io/current-metrics',
  'endpoints.kubernetes.io/last-change-trigger-time',
  'argocd.argoproj.io/refresh',
]);
const NOISE_PARTS = [
  'heartbeat',
  'renew-time',
  'renewtime',
  'last-updated',
  'lastupdated',
  'last-seen',
  'lastseen',
  'leader-election',
  'leaderelection',
];

function isNoiseAnnotation(key: string) {
  if (NOISE_ANNOTATIONS.has(key)) return true;
  const name = (key.split('/').pop() ?? key).toLowerCase();
  return name === 'leader' || NOISE_PARTS.some((p) => name.includes(p));
}

/** Per page load, never shown: markers cannot be matched against guessed values. */
const SALT = Math.random().toString(36).slice(2);

function digest(text: string) {
  // FNV-1a over salt + text, twice with different seeds: 12 hex chars.
  let a = 2166136261;
  let b = 3421674724;
  for (const ch of `${SALT}\u0000${text}`) {
    a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
    b = Math.imul(b ^ ch.charCodeAt(0), 1099511);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`.slice(
    0,
    12,
  );
}

export function secretMarker(key: string, value: string) {
  return `<redacted #${digest(`${key}ÿ${value}`)}>`;
}

export function isIgnored(o: KubeObject) {
  if (o.kind === 'Secret') return o.type === 'helm.sh/release.v1';
  if (o.kind === 'ConfigMap')
    return (
      o.metadata.namespace === 'kube-system' && o.metadata.name === 'cluster-autoscaler-status'
    );
  return false;
}

export function normalize(o: KubeObject): Json {
  const source = structuredClone(o) as Json;
  let out: Json;
  if (o.kind === 'Node') {
    const m = o.metadata;
    out = {
      apiVersion: o.apiVersion,
      kind: o.kind,
      metadata: {
        name: m.name,
        ...(m.labels ? { labels: m.labels } : {}),
        ...(m.creationTimestamp ? { creationTimestamp: m.creationTimestamp } : {}),
      },
      ...(o.spec ? { spec: structuredClone(o.spec) } : {}),
    };
  } else {
    delete source.status;
    out = source;
  }
  const meta = out.metadata as Json | undefined;
  if (meta) {
    for (const key of NOISE_METADATA) delete meta[key];
    const annotations = meta.annotations as Record<string, string> | undefined;
    if (annotations) {
      for (const key of Object.keys(annotations)) {
        const value = annotations[key] ?? '';
        const embedsData =
          o.kind === 'Secret' && (value.includes('"data"') || value.includes('"stringData"'));
        if (isNoiseAnnotation(key) || embedsData) delete annotations[key];
      }
      if (!Object.keys(annotations).length) delete meta.annotations;
    }
  }
  if (o.kind === 'Secret') {
    for (const field of ['data', 'stringData']) {
      const values = out[field] as Record<string, string> | undefined;
      if (!values) continue;
      for (const key of Object.keys(values)) values[key] = secretMarker(key, String(values[key]));
    }
  }
  return out;
}

// -- Changed paths (mirror of diff.rs) ----------------------------------------

const MAX_VALUE_CHARS = 120;
export const MAX_PATHS = 50;
const ITEM_KEYS = ['name', 'mountPath'];

type Segment = { key: string } | { item: string } | { index: number };

function formatPath(segments: Segment[]) {
  let out = '';
  segments.forEach((s, i) => {
    if ('key' in s) {
      if (/^[A-Za-z0-9_-]+$/.test(s.key)) out += (i > 0 ? '.' : '') + s.key;
      else out += `[${JSON.stringify(s.key)}]`;
    } else if ('item' in s) out += `[${s.item}]`;
    else out += `[${s.index}]`;
  });
  return out;
}

function cut(text: string) {
  const chars = [...text];
  return chars.length <= MAX_VALUE_CHARS
    ? text
    : `${chars.slice(0, MAX_VALUE_CHARS - 1).join('')}…`;
}

function render(value: unknown) {
  if (typeof value === 'string' && value.includes('\n')) {
    const first = value.split('\n').find((l) => l.trim()) ?? '';
    return cut(`${first.trimEnd()} …`);
  }
  return cut(typeof value === 'string' ? value : JSON.stringify(sortKeys(value)));
}

/** Two multi-line strings: only the lines between the common head and tail. */
function changedLines(a: string, b: string): [string, string] | null {
  if (!a.includes('\n') && !b.includes('\n')) return null;
  const lines = (s: string) => {
    const out = s.split('\n');
    if (out[out.length - 1] === '') out.pop();
    return out;
  };
  const la = lines(a);
  const lb = lines(b);
  let head = 0;
  while (head < la.length && head < lb.length && la[head] === lb[head]) head++;
  const room = Math.min(la.length, lb.length) - head;
  let tail = 0;
  while (tail < room && la[la.length - 1 - tail] === lb[lb.length - 1 - tail]) tail++;
  const middle = (l: string[]) => cut(l.map((x) => x.trim()).join(' ⏎ '));
  const ma = middle(la.slice(head, la.length - tail));
  const mb = middle(lb.slice(head, lb.length - tail));
  return ma || mb ? [ma, mb] : null;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Json)
        .sort()
        .map((k) => [k, sortKeys((value as Json)[k])]),
    );
  return value;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

function scalarKey(v: unknown) {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function itemKey(a: unknown[], b: unknown[]) {
  if (!a.length && !b.length) return null;
  return (
    ITEM_KEYS.find((field) =>
      [a, b].every((items) => {
        const seen = new Set<string>();
        return items.every((item) => {
          const k = isObj(item) ? scalarKey(item[field]) : null;
          if (k === null || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }),
    ) ?? null
  );
}

export function changedPaths(before: unknown, after: unknown, secret: boolean): ChangedPath[] {
  const out: ChangedPath[] = [];
  const segments: Segment[] = [];
  const leaf = (a: unknown, b: unknown) => {
    const root = segments[0];
    const lines = typeof a === 'string' && typeof b === 'string' ? changedLines(a, b) : null;
    out.push({
      path: formatPath(segments),
      before: lines ? lines[0] : a === undefined ? null : render(a),
      after: lines ? lines[1] : b === undefined ? null : render(b),
      redacted: secret && !!root && 'key' in root && ['data', 'stringData'].includes(root.key),
    });
  };
  const descend = (s: Segment, a: unknown, b: unknown) => {
    segments.push(s);
    walk(a, b);
    segments.pop();
  };
  const walk = (a: unknown, b: unknown) => {
    if (a === undefined && b === undefined) return;
    if (a !== undefined && b !== undefined && same(a, b)) return;
    if (isObj(a) && isObj(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
        descend({ key }, a[key], b[key]);
    } else if (Array.isArray(a) && Array.isArray(b)) {
      const field = itemKey(a, b);
      if (field) {
        const keyOf = (v: unknown) => (isObj(v) ? scalarKey(v[field]) : null);
        for (const vb of b) {
          const k = keyOf(vb) ?? '';
          descend(
            { item: k },
            a.find((va) => keyOf(va) === k),
            vb,
          );
        }
        for (const va of a) {
          const k = keyOf(va) ?? '';
          if (!b.some((vb) => keyOf(vb) === k)) descend({ item: k }, va, undefined);
        }
      } else {
        for (let i = 0; i < Math.max(a.length, b.length); i++) descend({ index: i }, a[i], b[i]);
      }
    } else leaf(a, b);
  };
  walk(before, after);
  return out;
}

// -- Synthesized history ------------------------------------------------------

export interface Draft {
  ts: number;
  gvk: Gvk;
  namespace: string | null;
  name: string;
  uid: string;
  op: ChangeOp;
  actor: ChangeActor | null;
  before: Json | null;
  after: Json | null;
}

const actor = (manager: string, operation = 'Update', subresource: string | null = null) => ({
  manager,
  operation,
  subresource,
});

function gvkOf(kind: string): Gvk {
  const k = JOURNALED_KINDS.find((d) => d.kind === kind)!;
  return {
    group: k.group,
    version: k.version,
    kind: k.kind,
    plural: k.plural,
    namespaced: k.namespaced,
  };
}

interface Step {
  ago: number;
  actor: ChangeActor | null;
  /** Turn the state after this change into the state before it. */
  revert: (before: Json) => void;
}

/** Entries of `obj` from newest to oldest, ending in its current state. */
function chain(obj: KubeObject | undefined, steps: Step[]): Draft[] {
  if (!obj) return [];
  let after = normalize(obj);
  const out: Draft[] = [];
  for (const step of steps) {
    const before = structuredClone(after);
    step.revert(before);
    out.push({
      ts: BOOT - step.ago,
      gvk: gvkOf(obj.kind),
      namespace: obj.metadata.namespace ?? null,
      name: obj.metadata.name,
      uid: obj.metadata.uid,
      op: 'modified',
      actor: step.actor,
      before,
      after,
    });
    after = before;
  }
  return out;
}

/** An object that existed only for a while (created at `born`, deleted at `died`). */
function transient(
  kind: string,
  object: KubeObject,
  born: number | null,
  died: number | null,
  createdBy: ChangeActor,
): Draft[] {
  const normalized = normalize(object);
  const base = {
    gvk: gvkOf(kind),
    namespace: object.metadata.namespace ?? null,
    name: object.metadata.name,
    uid: object.metadata.uid,
  };
  const out: Draft[] = [];
  if (died !== null)
    out.push({
      ...base,
      ts: BOOT - died,
      op: 'deleted',
      actor: null,
      before: normalized,
      after: null,
    });
  if (born !== null)
    out.push({
      ...base,
      ts: BOOT - born,
      op: 'added',
      actor: createdBy,
      before: null,
      after: normalized,
    });
  return out;
}

const at = (o: Json, path: string[]): Json => {
  let cur = o;
  for (const p of path) cur = (cur[p] ??= {}) as Json;
  return cur;
};

type Container = { name: string; image: string };

function containers(o: Json, init = false): Container[] {
  const spec = at(o, ['spec', 'template', 'spec']);
  return ((init ? spec.initContainers : spec.containers) as Container[] | undefined) ?? [];
}

/** `2.14.3` → `2.14.2`, `v1.32.3` → `v1.32.2`, `1.27-alpine` → `1.26-alpine`. */
function olderImage(image: string) {
  return image.replace(/(\d+)(?!.*\d)/, (n) => String(Math.max(0, Number(n) - 1)));
}

function first(db: ClusterDb, key: string, namespaces: string[] = []) {
  return list(db, key)
    .filter((o) => !namespaces.length || namespaces.includes(o.metadata.namespace ?? ''))
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))[0];
}

let synthUid = 0;
function synthetic(
  kind: string,
  apiVersion: string,
  namespace: string | null,
  name: string,
  body: Json,
) {
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      ...(namespace ? { namespace } : {}),
      uid: `demo-journal-${++synthUid}`,
      creationTimestamp: iso(BOOT - DAY),
    },
    ...body,
  } as KubeObject;
}

/** A believable last day of changes for `db`, oldest entries included. */
export function seedHistory(db: ClusterDb): Draft[] {
  const p = db.profile;
  const gitops = p.argocd ? actor('argocd-controller', 'Apply') : actor('helm');
  const drafts: Draft[] = [];

  // checkout/payment-api: an image bump minutes before the crash loop, and an older one.
  drafts.push(
    ...chain(find(db, 'deployments.apps', 'checkout', 'payment-api'), [
      {
        ago: 7 * MIN,
        actor: gitops,
        revert: (o) => {
          for (const c of [...containers(o), ...containers(o, true)])
            if (c.image.includes('payment-api')) c.image = olderImage(c.image);
        },
      },
      {
        ago: 5 * HOUR + 12 * MIN,
        actor: gitops,
        revert: (o) => {
          const env = (containers(o)[0] as Container & { env?: Json[] }).env;
          const flags = env?.find((e) => e.name === 'SPRING_PROFILES_ACTIVE');
          if (flags) flags.value = `${String(flags.value)},legacy-auth`;
        },
      },
    ]),
  );

  // Rotated Stripe key (value hidden) and an added webhook secret.
  if (!p.forbidClusterSecrets)
    drafts.push(
      ...chain(find(db, 'secrets', 'checkout', 'payment-api-secrets'), [
        {
          ago: 4 * MIN,
          actor: actor('external-secrets'),
          revert: (o) => {
            at(o, ['data']).STRIPE_API_KEY = secretMarker('STRIPE_API_KEY', 'previous');
          },
        },
        {
          ago: 3 * HOUR + 5 * MIN,
          actor: actor('kubectl-client-side-apply'),
          revert: (o) => {
            delete at(o, ['data']).WEBHOOK_SIGNING_SECRET;
          },
        },
      ]),
    );

  // Feature flag and log level flipped by hand.
  drafts.push(
    ...chain(find(db, 'configmaps', 'checkout', 'payment-api-config'), [
      {
        ago: 12 * MIN,
        actor: actor('kubectl-edit'),
        revert: (o) => {
          const data = at(o, ['data']);
          data['feature-flags'] = 'apple-pay=true,klarna=true,3ds2=true';
          data['log-level'] = 'DEBUG';
        },
      },
    ]),
  );

  // Scaled down by hand.
  drafts.push(
    ...chain(find(db, 'deployments.apps', 'checkout', 'cart-service'), [
      {
        ago: 18 * MIN,
        actor: actor('kubectl-scale', 'Update', 'scale'),
        revert: (o) => {
          at(o, ['spec']).replicas = 4;
        },
      },
    ]),
  );

  // A canary Service that lived for a few hours.
  drafts.push(
    ...transient(
      'Service',
      synthetic('Service', 'v1', 'checkout', 'payment-api-canary', {
        spec: {
          type: 'ClusterIP',
          selector: { app: 'payment-api', track: 'canary' },
          ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }],
        },
      }),
      4 * HOUR + 40 * MIN,
      26 * MIN,
      gitops,
    ),
  );

  // On-call got read-only access.
  drafts.push(
    ...chain(find(db, 'clusterrolebindings.rbac.authorization.k8s.io', null, 'platform-readonly'), [
      {
        ago: 33 * MIN,
        actor: actor('kubectl-client-side-apply'),
        revert: (o) => {
          o.subjects = (o.subjects as Json[]).filter((s) => s.name !== 'oncall@acme.io');
        },
      },
    ]),
  );

  // HPA floor raised.
  const hpa = first(db, 'horizontalpodautoscalers.autoscaling', ['checkout', 'web']);
  drafts.push(
    ...chain(hpa, [
      {
        ago: 41 * MIN,
        actor: gitops,
        revert: (o) => {
          const spec = at(o, ['spec']);
          spec.minReplicas = Math.max(1, Number(spec.minReplicas ?? 2) - 1);
        },
      },
    ]),
  );

  // CronJob resumed.
  drafts.push(
    ...chain(find(db, 'cronjobs.batch', 'data', 'metrics-rollup'), [
      {
        ago: 52 * MIN,
        actor: actor('kubectl-patch'),
        revert: (o) => {
          at(o, ['spec']).suspend = true;
        },
      },
    ]),
  );

  // IP allowlist removed from an Ingress.
  const ingress = first(db, 'ingresses.networking.k8s.io', ['monitoring', 'argocd', 'web']);
  drafts.push(
    ...chain(ingress, [
      {
        ago: 95 * MIN,
        actor: actor('kubectl-edit'),
        revert: (o) => {
          at(o, ['metadata', 'annotations'])['nginx.ingress.kubernetes.io/whitelist-source-range'] =
            '10.0.0.0/8,192.168.0.0/16';
        },
      },
    ]),
  );

  // Cordoned node (matches the taint's timeAdded in the node fixtures).
  if (p.cordoned !== null) {
    const node = list(db, 'nodes').find((n) => n.spec?.unschedulable);
    drafts.push(
      ...chain(node, [
        {
          ago: 3 * HOUR,
          actor: actor('kubectl-cordon'),
          revert: (o) => {
            const spec = at(o, ['spec']);
            delete spec.unschedulable;
            spec.taints = ((spec.taints as Json[] | undefined) ?? []).filter(
              (t) => t.key !== 'node.kubernetes.io/unschedulable',
            );
            if (!(spec.taints as Json[]).length) delete spec.taints;
          },
        },
      ]),
    );
  }

  // A NetworkPolicy tightened.
  const netpol = first(db, 'networkpolicies.networking.k8s.io', ['checkout', 'data', 'web']);
  drafts.push(
    ...chain(netpol, [
      {
        ago: 2 * HOUR + 10 * MIN,
        actor: gitops,
        revert: (o) => {
          const types = at(o, ['spec']).policyTypes as string[] | undefined;
          if (types?.includes('Egress')) at(o, ['spec']).policyTypes = ['Ingress'];
          else at(o, ['metadata', 'labels']).enforcement = 'audit';
        },
      },
    ]),
  );

  // Debug access granted and revoked.
  drafts.push(
    ...transient(
      'RoleBinding',
      synthetic('RoleBinding', 'rbac.authorization.k8s.io/v1', 'checkout', 'debug-access', {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'edit' },
        subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: 'dev@acme.io' }],
      }),
      9 * HOUR,
      8 * HOUR + 20 * MIN,
      actor('kubectl-create'),
    ),
  );

  // A load-test namespace.
  drafts.push(
    ...transient(
      'Namespace',
      synthetic('Namespace', 'v1', null, 'load-test', { spec: { finalizers: ['kubernetes'] } }),
      7 * HOUR,
      5 * HOUR + 30 * MIN,
      actor('kubectl-create'),
    ),
  );

  // Older rollouts: web storefront and a node agent.
  const web = first(db, 'deployments.apps', ['web']);
  drafts.push(
    ...chain(web, [
      {
        ago: 14 * HOUR + 3 * MIN,
        actor: gitops,
        revert: (o) => {
          const c = containers(o)[0];
          if (c) c.image = olderImage(c.image);
        },
      },
    ]),
  );
  const ds = first(db, 'daemonsets.apps', ['monitoring', 'kube-system']);
  drafts.push(
    ...chain(ds, [
      {
        ago: 20 * HOUR + 45 * MIN,
        actor: actor('helm'),
        revert: (o) => {
          const c = containers(o)[0];
          if (c) c.image = olderImage(c.image);
        },
      },
    ]),
  );

  // CoreDNS cache tuned.
  drafts.push(
    ...chain(find(db, 'configmaps', 'kube-system', 'coredns'), [
      {
        ago: 16 * HOUR,
        actor: actor('kubectl-edit'),
        revert: (o) => {
          const data = at(o, ['data']);
          data.Corefile = String(data.Corefile ?? '').replace('cache 30', 'cache 10');
        },
      },
    ]),
  );

  return drafts.filter((d) => BOOT - d.ts < DAY).sort((a, b) => a.ts - b.ts);
}
