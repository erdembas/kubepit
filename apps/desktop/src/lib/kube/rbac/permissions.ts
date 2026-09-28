import {
  matchingSubject,
  roleOf,
  type BindingInfo,
  type RbacIndex,
  type RoleInfo,
  type Subject,
} from './model';

/**
 * Everything one subject can do: the rules of every binding that applies
 * to it (directly or through a group it is in), summarized per scope and
 * resource with the union of verbs.
 */

export interface PermissionSource {
  binding: BindingInfo;
  role: RoleInfo;
  /** The binding subject that matched (the subject itself or one of its groups). */
  via: Subject;
}

export interface PermissionRow {
  /** `null` = cluster-wide (ClusterRoleBinding), else the RoleBinding's namespace. */
  scope: string | null;
  /** `''` is the core group, `*` every group. */
  group: string;
  /** `pods`, `pods/exec`, `*`, or a non-resource URL. */
  resource: string;
  nonResource: boolean;
  /** Empty = every name. */
  names: string[];
  /** Sorted, `*` first. */
  verbs: string[];
  sources: PermissionSource[];
}

export interface SubjectBinding {
  binding: BindingInfo;
  via: Subject;
  /** `null` when the referenced role does not exist or could not be read. */
  role: RoleInfo | null;
}

export interface SubjectPermissions {
  rows: PermissionRow[];
  bindings: SubjectBinding[];
}

function sortVerbs(verbs: Iterable<string>): string[] {
  return [...new Set(verbs)].sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)));
}

/**
 * `groups` are extra group memberships (a user's groups are not stored in
 * the cluster); the implicit `system:*` groups are always included.
 */
export function subjectPermissions(
  index: RbacIndex,
  subject: Subject,
  groups: readonly string[] = [],
): SubjectPermissions {
  const bindings: SubjectBinding[] = [];
  const rows = new Map<string, PermissionRow>();
  const add = (
    source: PermissionSource,
    scope: string | null,
    group: string,
    resource: string,
    nonResource: boolean,
    names: string[],
    verbs: string[],
  ) => {
    const key = [scope ?? '', nonResource ? 1 : 0, group, resource, names.join(',')].join('|');
    let row = rows.get(key);
    if (!row) {
      row = { scope, group, resource, nonResource, names, verbs: [], sources: [] };
      rows.set(key, row);
    }
    row.verbs = sortVerbs([...row.verbs, ...verbs]);
    if (!row.sources.some((s) => s.binding.uid === source.binding.uid)) row.sources.push(source);
  };

  for (const binding of index.bindings) {
    const via = matchingSubject(binding, subject, groups);
    if (!via) continue;
    const role = roleOf(index, binding);
    bindings.push({ binding, via, role });
    if (!role) continue;
    const scope = binding.kind === 'ClusterRoleBinding' ? null : binding.namespace;
    const source = { binding, role, via };
    for (const rule of role.rules)
      for (const group of rule.api_groups.length ? rule.api_groups : [''])
        for (const resource of rule.resources)
          add(source, scope, group, resource, false, [...rule.resource_names].sort(), rule.verbs);
    // Non-resource URLs are only granted cluster-wide.
    if (scope === null)
      for (const rule of role.nonResource)
        for (const url of rule.non_resource_urls) add(source, null, '', url, true, [], rule.verbs);
  }

  const sorted = [...rows.values()].sort(
    (a, b) =>
      Number(a.scope !== null) - Number(b.scope !== null) ||
      (a.scope ?? '').localeCompare(b.scope ?? '') ||
      Number(a.nonResource) - Number(b.nonResource) ||
      a.group.localeCompare(b.group) ||
      a.resource.localeCompare(b.resource) ||
      a.names.join(',').localeCompare(b.names.join(',')),
  );
  bindings.sort(
    (a, b) =>
      Number(a.binding.kind === 'RoleBinding') - Number(b.binding.kind === 'RoleBinding') ||
      (a.binding.namespace ?? '').localeCompare(b.binding.namespace ?? '') ||
      a.binding.name.localeCompare(b.binding.name),
  );
  return { rows: sorted, bindings };
}

/** `deployments.apps`, `deployments.apps/scale`, `pods/exec`, `*.*` — kubectl-style names. */
export function rowResource(
  row: Pick<PermissionRow, 'group' | 'resource' | 'nonResource'>,
): string {
  if (row.nonResource || !row.group) return row.resource;
  const slash = row.resource.indexOf('/');
  return slash < 0
    ? `${row.resource}.${row.group}`
    : `${row.resource.slice(0, slash)}.${row.group}${row.resource.slice(slash)}`;
}
