import type { AccessResourceRule } from '@/types';
import { ruleAllows } from '../access';
import type { BindingInfo, RoleInfo, Subject } from './model';

/**
 * Grants worth a second look: full admin, wildcards, the privilege
 * escalation verbs (`escalate`, `bind`, `impersonate`), reading Secrets,
 * exec/attach into pods, the kubelet API through `nodes/proxy`, and pod
 * creation (which reaches every Secret and ServiceAccount of a namespace,
 * `kube-system` included when granted cluster-wide).
 */

export type RiskId =
  | 'cluster-admin'
  | 'wildcard'
  | 'escalate'
  | 'bind'
  | 'impersonate'
  | 'secrets'
  | 'exec'
  | 'nodes-proxy'
  | 'create-pods';

export const RISK_IDS: readonly RiskId[] = [
  'cluster-admin',
  'wildcard',
  'escalate',
  'bind',
  'impersonate',
  'secrets',
  'exec',
  'nodes-proxy',
  'create-pods',
];

/** Where a role's rules apply: everywhere (ClusterRoleBinding) or in one namespace. */
export type GrantScope = 'cluster' | 'namespace';

const can = (
  rule: AccessResourceRule,
  verb: string,
  group: string,
  resource: string,
  sub?: string,
) =>
  ruleAllows(rule, {
    verb,
    group,
    resource,
    subresource: sub ?? null,
    namespace: null,
    name: null,
  });

const anyVerb = (
  rule: AccessResourceRule,
  verbs: readonly string[],
  group: string,
  resource: string,
  sub?: string,
) => verbs.some((v) => can(rule, v, group, resource, sub));

const WORKLOADS: ReadonlyArray<[string, string]> = [
  ['', 'pods'],
  ['apps', 'deployments'],
  ['apps', 'daemonsets'],
  ['apps', 'statefulsets'],
  ['apps', 'replicasets'],
  ['batch', 'jobs'],
  ['batch', 'cronjobs'],
];

/** Risks of one rule. Cluster-scoped grants (users, groups, nodes) only count cluster-wide. */
export function ruleRisks(rule: AccessResourceRule, scope: GrantScope): RiskId[] {
  const out: RiskId[] = [];
  const all = (list: string[]) => list.includes('*');
  if (all(rule.verbs) && all(rule.api_groups) && all(rule.resources) && !rule.resource_names.length)
    return ['cluster-admin'];
  if (all(rule.verbs) || all(rule.resources)) out.push('wildcard');
  const rbac = 'rbac.authorization.k8s.io';
  const roles = scope === 'cluster' ? ['roles', 'clusterroles'] : ['roles'];
  if (roles.some((r) => can(rule, 'escalate', rbac, r))) out.push('escalate');
  if (roles.some((r) => can(rule, 'bind', rbac, r))) out.push('bind');
  const identities: Array<[string, string]> =
    scope === 'cluster'
      ? [
          ['', 'users'],
          ['', 'groups'],
          ['', 'serviceaccounts'],
          ['authentication.k8s.io', 'userextras'],
          ['authentication.k8s.io', 'uids'],
        ]
      : [['', 'serviceaccounts']];
  if (identities.some(([g, r]) => can(rule, 'impersonate', g, r))) out.push('impersonate');
  if (anyVerb(rule, ['get', 'list', 'watch'], '', 'secrets')) out.push('secrets');
  // Exec and attach need `create` (websocket upgrades too, since Kubernetes 1.30).
  if (can(rule, 'create', '', 'pods', 'exec') || can(rule, 'create', '', 'pods', 'attach'))
    out.push('exec');
  if (scope === 'cluster' && anyVerb(rule, ['get', 'create'], '', 'nodes', 'proxy'))
    out.push('nodes-proxy');
  if (WORKLOADS.some(([g, r]) => can(rule, 'create', g, r))) out.push('create-pods');
  return out;
}

/** Risks of a role in a scope, with the indexes of the rules behind each. */
export function roleRisks(role: RoleInfo, scope: GrantScope): Map<RiskId, number[]> {
  const out = new Map<RiskId, number[]>();
  role.rules.forEach((rule, i) => {
    for (const risk of ruleRisks(rule, scope)) out.set(risk, [...(out.get(risk) ?? []), i]);
  });
  if (out.has('cluster-admin')) return new Map([['cluster-admin', out.get('cluster-admin')!]]);
  return out;
}

/**
 * Bindings Kubernetes or the platform manages (bootstrap defaults,
 * `system:` bindings, EKS/GKE add-on bindings). Their grants are expected;
 * flagging them would only add noise nobody can act on.
 */
export function isPlatformBinding(binding: BindingInfo): boolean {
  if (binding.labels['kubernetes.io/bootstrapping'] === 'rbac-defaults') return true;
  if (binding.labels['addonmanager.kubernetes.io/mode']) return true;
  return /^(system:|eks:|gce:|gke:)/.test(binding.name);
}

/** Built-in identities (control plane components, nodes, `system:masters`). */
export function isSystemSubject(subject: Subject): boolean {
  if (subject.kind === 'ServiceAccount') return false;
  if (!subject.name.startsWith('system:')) return false;
  // Broad groups are exactly what makes a grant dangerous: keep them.
  return !(
    subject.kind === 'Group' &&
    (subject.name === 'system:authenticated' ||
      subject.name === 'system:unauthenticated' ||
      subject.name === 'system:serviceaccounts' ||
      subject.name.startsWith('system:serviceaccounts:'))
  );
}
