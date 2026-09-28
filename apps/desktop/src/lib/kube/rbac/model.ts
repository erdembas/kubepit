import type { AccessNonResourceRule, AccessResourceRule, KubeObject } from '@/types';
import { asArray, asObject, asString, isObject } from '../accessors';

/**
 * RBAC objects reduced to what "who can" and permission summaries need.
 * Pure: no IPC, no i18n. Aggregated ClusterRoles need no special handling:
 * the aggregation controller writes the combined rules into `rules`.
 */

export type SubjectKind = 'User' | 'Group' | 'ServiceAccount';

export interface Subject {
  kind: SubjectKind;
  name: string;
  /** ServiceAccounts only. */
  namespace: string | null;
}

export interface RoleInfo {
  kind: 'Role' | 'ClusterRole';
  namespace: string | null;
  name: string;
  uid: string;
  rules: AccessResourceRule[];
  nonResource: AccessNonResourceRule[];
  labels: Record<string, string>;
  /** Filled by the aggregation controller from other ClusterRoles. */
  aggregated: boolean;
}

export interface BindingInfo {
  kind: 'RoleBinding' | 'ClusterRoleBinding';
  namespace: string | null;
  name: string;
  uid: string;
  roleRef: { kind: 'Role' | 'ClusterRole'; name: string };
  subjects: Subject[];
  labels: Record<string, string>;
}

export interface RbacLists {
  roles: readonly KubeObject[];
  clusterRoles: readonly KubeObject[];
  roleBindings: readonly KubeObject[];
  clusterRoleBindings: readonly KubeObject[];
}

export interface RbacIndex {
  roles: Map<string, RoleInfo>;
  clusterRoles: Map<string, RoleInfo>;
  bindings: BindingInfo[];
  /** Which lists were available (a forbidden list is empty and marked false). */
  loaded: {
    roles: boolean;
    clusterRoles: boolean;
    roleBindings: boolean;
    clusterRoleBindings: boolean;
  };
}

const strings = (v: unknown) => asArray(v).map((x) => asString(x));

export const roleKey = (namespace: string | null, name: string) => `${namespace ?? ''}/${name}`;

const SA_USER = 'system:serviceaccount:';

/**
 * A subject as the authorizer sees it: `User system:serviceaccount:ns:name`
 * is that ServiceAccount; a RoleBinding's ServiceAccount without a
 * namespace lives in the binding's namespace.
 */
export function normalizeSubject(raw: unknown, bindingNamespace: string | null): Subject | null {
  if (!isObject(raw)) return null;
  const kind = asString(raw.kind);
  const name = asString(raw.name);
  if (!name) return null;
  if (kind === 'ServiceAccount')
    return {
      kind,
      name,
      namespace: asString(raw.namespace) || bindingNamespace || 'default',
    };
  if (kind === 'User') {
    if (name.startsWith(SA_USER)) {
      const [namespace, sa] = name.slice(SA_USER.length).split(':');
      if (namespace && sa) return { kind: 'ServiceAccount', name: sa, namespace };
    }
    return { kind, name, namespace: null };
  }
  if (kind === 'Group') return { kind, name, namespace: null };
  return null;
}

export function subjectKey(s: Subject): string {
  return s.kind === 'ServiceAccount'
    ? `ServiceAccount:${s.namespace}/${s.name}`
    : `${s.kind}:${s.name}`;
}

/** `ns/name` for ServiceAccounts, the name otherwise. */
export function subjectName(s: Subject): string {
  return s.kind === 'ServiceAccount' ? `${s.namespace}/${s.name}` : s.name;
}

export function sameSubject(a: Subject, b: Subject): boolean {
  return subjectKey(a) === subjectKey(b);
}

function roleInfo(obj: KubeObject): RoleInfo {
  const rules: AccessResourceRule[] = [];
  const nonResource: AccessNonResourceRule[] = [];
  for (const r of asArray(obj.rules).filter(isObject)) {
    const verbs = strings(r.verbs);
    const urls = strings(r.nonResourceURLs);
    if (urls.length) nonResource.push({ verbs, non_resource_urls: urls });
    const resources = strings(r.resources);
    if (resources.length)
      rules.push({
        verbs,
        api_groups: strings(r.apiGroups),
        resources,
        resource_names: strings(r.resourceNames),
      });
  }
  return {
    kind: obj.kind === 'Role' ? 'Role' : 'ClusterRole',
    namespace: obj.kind === 'Role' ? (obj.metadata.namespace ?? null) : null,
    name: obj.metadata.name,
    uid: obj.metadata.uid,
    rules,
    nonResource,
    labels: obj.metadata.labels ?? {},
    aggregated: Object.keys(asObject(obj.aggregationRule)).length > 0,
  };
}

function bindingInfo(obj: KubeObject): BindingInfo | null {
  const ref = asObject(obj.roleRef);
  const refKind = asString(ref.kind);
  if (refKind !== 'Role' && refKind !== 'ClusterRole') return null;
  const namespace = obj.kind === 'RoleBinding' ? (obj.metadata.namespace ?? null) : null;
  return {
    kind: obj.kind === 'RoleBinding' ? 'RoleBinding' : 'ClusterRoleBinding',
    namespace,
    name: obj.metadata.name,
    uid: obj.metadata.uid,
    roleRef: { kind: refKind, name: asString(ref.name) },
    subjects: asArray(obj.subjects)
      .map((s) => normalizeSubject(s, namespace))
      .filter((s): s is Subject => !!s),
    labels: obj.metadata.labels ?? {},
  };
}

export function buildRbacIndex(
  lists: RbacLists,
  loaded: RbacIndex['loaded'] = {
    roles: true,
    clusterRoles: true,
    roleBindings: true,
    clusterRoleBindings: true,
  },
): RbacIndex {
  const roles = new Map<string, RoleInfo>();
  for (const r of lists.roles) {
    const info = roleInfo(r);
    roles.set(roleKey(info.namespace, info.name), info);
  }
  const clusterRoles = new Map<string, RoleInfo>();
  for (const r of lists.clusterRoles) clusterRoles.set(r.metadata.name, roleInfo(r));
  const bindings: BindingInfo[] = [];
  for (const b of [...lists.clusterRoleBindings, ...lists.roleBindings]) {
    const info = bindingInfo(b);
    if (info) bindings.push(info);
  }
  return { roles, clusterRoles, bindings, loaded };
}

/** The role a binding references, or `null` when it is missing (or its list is unknown). */
export function roleOf(index: RbacIndex, binding: BindingInfo): RoleInfo | null {
  return binding.roleRef.kind === 'ClusterRole'
    ? (index.clusterRoles.get(binding.roleRef.name) ?? null)
    : (index.roles.get(roleKey(binding.namespace, binding.roleRef.name)) ?? null);
}

/** True when the referenced role's list loaded, so "missing" really means missing. */
export function roleListLoaded(index: RbacIndex, binding: BindingInfo): boolean {
  return binding.roleRef.kind === 'ClusterRole' ? index.loaded.clusterRoles : index.loaded.roles;
}

/** Every subject named in a binding, deduplicated and sorted (kind, then name). */
export function allSubjects(index: RbacIndex): Subject[] {
  const map = new Map<string, Subject>();
  for (const b of index.bindings) for (const s of b.subjects) map.set(subjectKey(s), s);
  const order: Record<SubjectKind, number> = { User: 0, Group: 1, ServiceAccount: 2 };
  return [...map.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || subjectName(a).localeCompare(subjectName(b)),
  );
}

/**
 * Groups every request of `subject` carries implicitly: ServiceAccounts are
 * in `system:serviceaccounts` and `system:serviceaccounts:<ns>`, and every
 * authenticated identity is in `system:authenticated`.
 */
export function implicitGroups(subject: Subject): string[] {
  if (subject.kind === 'Group') return [];
  const groups = ['system:authenticated'];
  if (subject.kind === 'ServiceAccount')
    groups.push('system:serviceaccounts', `system:serviceaccounts:${subject.namespace}`);
  return groups;
}

/**
 * The binding subject through which `binding` applies to `subject` (with
 * `groups` as extra group memberships), or `null`.
 */
export function matchingSubject(
  binding: BindingInfo,
  subject: Subject,
  groups: readonly string[] = [],
): Subject | null {
  const memberOf = new Set([...implicitGroups(subject), ...groups]);
  for (const s of binding.subjects) {
    if (sameSubject(s, subject)) return s;
    if (
      s.kind === 'Group' &&
      (memberOf.has(s.name) || (subject.kind === 'Group' && s.name === subject.name))
    )
      return s;
  }
  return null;
}

/** Bindings that reference `role` (RoleBindings in its namespace; any binding for ClusterRoles). */
export function bindingsOfRole(
  index: RbacIndex,
  role: Pick<RoleInfo, 'kind' | 'namespace' | 'name'>,
): BindingInfo[] {
  return index.bindings.filter(
    (b) =>
      b.roleRef.kind === role.kind &&
      b.roleRef.name === role.name &&
      (role.kind === 'ClusterRole' || b.namespace === role.namespace),
  );
}
