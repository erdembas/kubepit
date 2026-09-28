import type { AccessCheck, AccessResourceRule } from '@/types';
import { evaluateRules, nonResourceAllows } from '../access';
import {
  roleListLoaded,
  roleOf,
  subjectKey,
  subjectName,
  type BindingInfo,
  type RbacIndex,
  type RoleInfo,
  type Subject,
  type SubjectKind,
} from './model';

/**
 * "Who can <verb> <resource>?" answered from Roles, ClusterRoles and their
 * bindings, with the binding → role → rule path of every grant. Rule
 * matching is the API server's (`lib/kube/access.ts`); RoleBindings only
 * grant namespaced resources in their own namespace, ClusterRoleBindings
 * grant everywhere.
 */

export interface WhoCanRequest {
  verb: string;
  /** `''` is the core group. */
  group: string;
  /** Resource plural, or a non-resource URL starting with `/` (`/metrics`). */
  resource: string;
  subresource: string | null;
  name: string | null;
  /** Namespace of the request; `null` asks cluster-wide (every namespace). */
  namespace: string | null;
  /** Cluster-scoped resources are only granted by ClusterRoleBindings. */
  namespaced: boolean;
}

export interface GrantPath {
  binding: BindingInfo;
  /** The binding subject that grants it. */
  subject: Subject;
  role: RoleInfo;
  /** Index of the granting rule in the role (resource rules, then non-resource rules). */
  ruleIndex: number;
  rule: AccessResourceRule | null;
  /** Non-resource URL rules. */
  urls: string[] | null;
  /** `null` = every namespace (ClusterRoleBinding), else the namespace the RoleBinding lives in. */
  scope: string | null;
  /** Name-restricted rule: only these object names. */
  names: string[] | null;
}

export interface WhoCanEntry {
  subject: Subject;
  paths: GrantPath[];
  /** Allowed for the whole request (not only in some namespaces or for some names). */
  full: boolean;
}

export interface WhoCanResult {
  entries: WhoCanEntry[];
  /** Bindings that could apply but reference a role that does not exist. */
  missing: BindingInfo[];
  /** Some bindings reference roles whose list could not be read. */
  incomplete: boolean;
}

export function isNonResource(req: Pick<WhoCanRequest, 'resource'>): boolean {
  return req.resource.startsWith('/');
}

const KIND_ORDER: Record<SubjectKind, number> = { Group: 0, User: 1, ServiceAccount: 2 };

export function whoCan(index: RbacIndex, req: WhoCanRequest): WhoCanResult {
  const nonResource = isNonResource(req);
  const check: AccessCheck = {
    verb: req.verb,
    group: req.group,
    resource: req.resource,
    subresource: req.subresource || null,
    namespace: req.namespaced ? req.namespace : null,
    name: req.name || null,
  };
  const entries = new Map<string, WhoCanEntry>();
  const missing: BindingInfo[] = [];
  let incomplete = false;

  for (const binding of index.bindings) {
    if (binding.kind === 'RoleBinding') {
      // RoleBindings never grant cluster-scoped resources or non-resource URLs.
      if (!req.namespaced || nonResource) continue;
      if (req.namespace !== null && binding.namespace !== req.namespace) continue;
    }
    const role = roleOf(index, binding);
    if (!role) {
      if (roleListLoaded(index, binding)) missing.push(binding);
      else incomplete = true;
      continue;
    }
    const scope = binding.kind === 'ClusterRoleBinding' ? null : binding.namespace;
    const grants: Array<Omit<GrantPath, 'binding' | 'subject' | 'role' | 'scope'>> = [];
    if (nonResource) {
      role.nonResource.forEach((rule, i) => {
        if (
          nonResourceAllows(
            {
              resource_rules: [],
              non_resource_rules: [rule],
              incomplete: false,
              evaluation_error: null,
            },
            req.verb,
            req.resource,
          )
        )
          grants.push({
            ruleIndex: role.rules.length + i,
            rule: null,
            urls: rule.non_resource_urls,
            names: null,
          });
      });
    } else {
      role.rules.forEach((rule, i) => {
        const verdict = evaluateRules([rule], check);
        if (verdict === 'denied') return;
        grants.push({
          ruleIndex: i,
          rule,
          urls: null,
          names: verdict === 'restricted' ? rule.resource_names : null,
        });
      });
    }
    if (!grants.length) continue;
    for (const subject of binding.subjects) {
      const key = subjectKey(subject);
      let entry = entries.get(key);
      if (!entry) {
        entry = { subject, paths: [], full: false };
        entries.set(key, entry);
      }
      for (const g of grants) {
        entry.paths.push({ ...g, binding, subject, role, scope });
        if (g.names === null && (scope === null || req.namespace !== null)) entry.full = true;
      }
    }
  }

  const sorted = [...entries.values()].sort(
    (a, b) =>
      Number(b.full) - Number(a.full) ||
      KIND_ORDER[a.subject.kind] - KIND_ORDER[b.subject.kind] ||
      subjectName(a.subject).localeCompare(subjectName(b.subject)),
  );
  for (const e of sorted)
    e.paths.sort(
      (a, b) =>
        Number(a.scope !== null) - Number(b.scope !== null) ||
        Number(a.names !== null) - Number(b.names !== null) ||
        a.binding.name.localeCompare(b.binding.name),
    );
  return { entries: sorted, missing, incomplete };
}

/** The `kubectl auth can-i --as` hint for one subject (users and service accounts only). */
export function asFlag(subject: Subject): string | null {
  if (subject.kind === 'ServiceAccount')
    return `--as=system:serviceaccount:${subject.namespace}:${subject.name}`;
  if (subject.kind === 'User') return `--as=${subject.name}`;
  return `--as=any --as-group=${subject.name}`;
}

/** The rule as `verbs on groups/resources [names]` (kubectl describe style). */
export function ruleText(rule: AccessResourceRule): string {
  const groups = rule.api_groups.map((g) => (g === '' ? 'core' : g)).join(',');
  const names = rule.resource_names.length ? ` [${rule.resource_names.join(', ')}]` : '';
  return `${rule.verbs.join(',')} ${groups}/${rule.resources.join(',')}${names}`;
}
