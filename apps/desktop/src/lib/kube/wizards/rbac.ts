import * as i18n from '@/i18n/core';
import { nameError } from './validate';

/**
 * `kubectl create serviceaccount` and `kubectl create rolebinding`: a
 * ServiceAccount, optionally bound to an existing Role or ClusterRole in
 * its namespace, or a RoleBinding for an existing ServiceAccount.
 */

export type RoleKind = 'Role' | 'ClusterRole';

export interface BindingDraft {
  enabled: boolean;
  name: string;
  roleKind: RoleKind;
  roleName: string;
}

export interface ServiceAccountInput {
  /** `create`: ServiceAccount (+ binding); `bind`: only the RoleBinding for `name`. */
  mode: 'create' | 'bind';
  name: string;
  /** Namespace of the ServiceAccount and the RoleBinding. */
  namespace: string;
  /** Null leaves the field unset (the cluster default applies). */
  automount: boolean | null;
  imagePullSecrets: string[];
  binding: BindingDraft;
}

export function serviceAccountDefaults(
  namespace: string,
  opts: {
    mode?: 'create' | 'bind';
    name?: string;
    role?: { kind: RoleKind; name: string } | null;
  } = {},
): ServiceAccountInput {
  const mode = opts.mode ?? 'create';
  return {
    mode,
    name: opts.name ?? '',
    namespace,
    automount: null,
    imagePullSecrets: [],
    binding: {
      enabled: mode === 'bind' || !!opts.role,
      name: '',
      roleKind: opts.role?.kind ?? 'ClusterRole',
      roleName: opts.role?.name ?? '',
    },
  };
}

/** Default binding name: `<serviceaccount>-<role>`. */
export function bindingName(input: ServiceAccountInput): string {
  if (input.binding.name.trim()) return input.binding.name.trim();
  const role = input.binding.roleName.replace(/[^a-z0-9.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return [input.name, role].filter(Boolean).join('-').slice(0, 253);
}

export function buildRoleBinding(input: ServiceAccountInput): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: bindingName(input), namespace: input.namespace },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: input.binding.roleKind,
      name: input.binding.roleName,
    },
    subjects: [{ kind: 'ServiceAccount', name: input.name, namespace: input.namespace }],
  };
}

export function buildServiceAccount(input: ServiceAccountInput): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (input.mode === 'create') {
    const pullSecrets = input.imagePullSecrets.filter(Boolean);
    out.push({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: input.name, namespace: input.namespace },
      ...(input.automount !== null ? { automountServiceAccountToken: input.automount } : {}),
      ...(pullSecrets.length ? { imagePullSecrets: pullSecrets.map((name) => ({ name })) } : {}),
    });
  }
  if (input.binding.enabled) out.push(buildRoleBinding(input));
  return out;
}

export interface ServiceAccountErrors {
  name: string | null;
  bindingName: string | null;
  role: string | null;
  exists: string | null;
}

export function validateServiceAccount(
  input: ServiceAccountInput,
  existing: readonly string[],
): ServiceAccountErrors {
  const binding = input.binding.enabled;
  return {
    name:
      input.mode === 'bind' && !input.name
        ? i18n.t('Pick a ServiceAccount.')
        : nameError(input.name),
    bindingName: binding && input.binding.name.trim() ? nameError(input.binding.name.trim()) : null,
    role: binding && !input.binding.roleName ? i18n.t('Pick a role.') : null,
    exists:
      input.mode === 'create' && existing.includes(input.name)
        ? i18n.t('ServiceAccount {name} already exists.', { name: input.name })
        : null,
  };
}

export function serviceAccountBlocked(errors: ServiceAccountErrors): boolean {
  return !!errors.name || !!errors.bindingName || !!errors.role || !!errors.exists;
}
