import { accessCheck, eitherNeed, type AccessNeed } from '@/lib/kube/access';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import type { Gvk, KubeObject } from '@/types';

/**
 * Permissions each resource action needs, keyed by action id (the `id` of
 * `ResourceAction` / `BulkAction`). Actions whose id is not listed are not
 * gated. To gate a new action, add one line, e.g.
 *
 *   'set-image': ({ gvk, ns, name }) => [accessCheck('patch', gvk, { namespace: ns, name })],
 *
 * A requirement returns every check the action needs (all must be allowed),
 * or `{ anyOf: [...] }` when one of several alternatives is enough.
 */

interface Target {
  obj: KubeObject;
  /** Kind of the object the action runs on. */
  gvk: Gvk;
  ns: string | null;
  name: string | null;
}

type Requirement = (target: Target) => AccessNeed;

const POD = toGvk(BUILTIN.Pod);
const JOB = toGvk(BUILTIN.Job);
const NODE = toGvk(BUILTIN.Node);
const SERVICE = toGvk(BUILTIN.Service);
const INGRESS = toGvk(BUILTIN.Ingress);
const ROLE_BINDING = toGvk(BUILTIN.RoleBinding);

/** Where the node-shell helper pod may be created, in the order `node_shell.rs` tries. */
export const NODE_SHELL_NAMESPACES = ['kube-system', 'default'] as const;

/** Pod subresource checks; only a Pod names itself (workloads resolve to one of their pods). */
const podSub =
  (verb: string, subresource: string): Requirement =>
  ({ obj, ns }) => [
    accessCheck(verb, POD, {
      namespace: ns,
      subresource,
      name: obj.kind === 'Pod' ? obj.metadata.name : null,
    }),
  ];

const onObject =
  (verb: string, subresource?: string): Requirement =>
  ({ gvk, ns, name }) => [accessCheck(verb, gvk, { namespace: ns, name, subresource })];

export const ACTION_ACCESS: Record<string, Requirement> = {
  logs: podSub('get', 'log'),
  shell: podSub('create', 'exec'),
  attach: podSub('create', 'attach'),
  // Services forward to one of their pods.
  'port-forward': podSub('create', 'portforward'),
  scale: onObject('patch', 'scale'),
  restart: onObject('patch'),
  trigger: ({ ns }) => [accessCheck('create', JOB, { namespace: ns })],
  suspend: onObject('patch'),
  resume: onObject('patch'),
  'node-shell': () => ({
    anyOf: NODE_SHELL_NAMESPACES.map((namespace) => [
      accessCheck('create', POD, { namespace }),
      accessCheck('create', POD, { namespace, subresource: 'exec' }),
    ]),
  }),
  cordon: ({ name }) => [accessCheck('patch', NODE, { name })],
  uncordon: ({ name }) => [accessCheck('patch', NODE, { name })],
  // Drain cordons, then evicts pods of every namespace on the node.
  drain: ({ name }) => [
    accessCheck('patch', NODE, { name }),
    accessCheck('create', POD, { subresource: 'eviction' }),
  ],
  // The editor applies with a PATCH (server-side apply) or replaces with a PUT.
  edit: ({ gvk, ns, name }) => ({
    anyOf: [
      [accessCheck('patch', gvk, { namespace: ns, name })],
      [accessCheck('update', gvk, { namespace: ns, name })],
    ],
  }),
  delete: onObject('delete'),
  // Workload operations: patches on the object itself (template, spec.paused).
  'set-image': onObject('patch'),
  // Cost insight: apply a right-sizing recommendation (pod template resources).
  rightsize: onObject('patch'),
  'pause-rollout': onObject('patch'),
  rollback: onObject('patch'),
  // GitOps: every Argo CD / Flux action is a patch of the object itself.
  'argo-sync': onObject('patch'),
  'argo-refresh': onObject('patch'),
  'argo-hard-refresh': onObject('patch'),
  'argo-terminate': onObject('patch'),
  'argo-auto-sync': onObject('patch'),
  'flux-reconcile': onObject('patch'),
  'flux-reconcile-options': onObject('patch'),
  'flux-suspend': onObject('patch'),
  // Logs & debug: file operations run over exec; a debug container is added
  // through the ephemeralcontainers subresource, then attached to.
  files: podSub('create', 'exec'),
  debug: ({ obj, ns }) => [
    accessCheck('patch', POD, {
      namespace: ns,
      subresource: 'ephemeralcontainers',
      name: obj.metadata.name,
    }),
    accessCheck('create', POD, { namespace: ns, subresource: 'attach', name: obj.metadata.name }),
  ],
  // Resource wizards: what the generated manifest creates.
  expose: ({ ns }) => [accessCheck('create', SERVICE, { namespace: ns })],
  'create-ingress': ({ ns }) => [accessCheck('create', INGRESS, { namespace: ns })],
  'add-rolebinding': ({ ns }) => [accessCheck('create', ROLE_BINDING, { namespace: ns })],
};

/** What action `actionId` needs on `obj`, or `undefined` when it is not gated. */
export function requiredAccess(
  actionId: string,
  obj: KubeObject,
  gvk: Gvk,
): AccessNeed | undefined {
  return ACTION_ACCESS[actionId]?.({
    obj,
    gvk,
    ns: obj.metadata.namespace ?? null,
    name: obj.metadata.name || null,
  });
}

/** Above this many targets, bulk checks ask per namespace instead of per object. */
const BULK_NAMED_LIMIT = 50;

/**
 * A bulk action is allowed when it is allowed on at least one target (the
 * summary toast reports per-object failures). Large selections collapse to
 * one nameless representative per namespace.
 */
export function bulkAccess(
  actionId: string,
  targets: readonly KubeObject[],
  gvk: Gvk,
): AccessNeed | undefined {
  if (!ACTION_ACCESS[actionId] || !targets.length) return undefined;
  let objects = targets;
  if (targets.length > BULK_NAMED_LIMIT) {
    const byNamespace = new Map<string, KubeObject>();
    for (const o of targets)
      byNamespace.set(o.metadata.namespace ?? '', {
        ...o,
        metadata: { ...o.metadata, name: '' },
      });
    objects = [...byNamespace.values()];
  }
  const needs = objects
    .map((o) => requiredAccess(actionId, o, gvk))
    .filter((n): n is AccessNeed => !!n);
  return needs.length ? eitherNeed(needs) : undefined;
}
