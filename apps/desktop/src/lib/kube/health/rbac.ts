import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import {
  buildRbacIndex,
  isPlatformBinding,
  isSystemSubject,
  roleListLoaded,
  roleOf,
  roleRisks,
  subjectName,
  type Subject,
} from '../rbac';
import { makeFinding, type Emit } from './context';
import type { HealthInput, Severity } from './types';

/**
 * Risky RBAC grants, one finding per binding and risk. Platform-managed
 * bindings (bootstrap defaults, `system:` / cloud add-on bindings) and
 * built-in identities are skipped. Grants limited to one namespace are
 * reported one step softer than cluster-wide ones (except in kube-system):
 * a team admin reading its own Secrets is expected, a cluster-wide reader
 * of every Secret is not.
 */

const MAX_SUBJECTS = 3;

function subjectsText(subjects: readonly Subject[]): string {
  const shown = subjects.slice(0, MAX_SUBJECTS).map((s) => `${s.kind} ${subjectName(s)}`);
  const more = subjects.length - shown.length;
  return more > 0 ? `${shown.join(', ')} +${more}` : shown.join(', ');
}

export function rbacFindings(input: HealthInput, emit: Emit) {
  if (!input.loaded.has('clusterRoles')) return;
  const index = buildRbacIndex(
    {
      roles: input.roles,
      clusterRoles: input.clusterRoles,
      roleBindings: input.roleBindings,
      clusterRoleBindings: input.clusterRoleBindings,
    },
    {
      roles: input.loaded.has('roles'),
      clusterRoles: true,
      roleBindings: input.loaded.has('roleBindings'),
      clusterRoleBindings: input.loaded.has('clusterRoleBindings'),
    },
  );
  const objects = new Map<string, KubeObject>();
  for (const b of [...input.roleBindings, ...input.clusterRoleBindings])
    objects.set(b.metadata.uid, b);

  for (const binding of index.bindings) {
    const obj = objects.get(binding.uid);
    if (!obj || isPlatformBinding(binding)) continue;
    const subjects = binding.subjects.filter((s) => !isSystemSubject(s));
    if (!subjects.length) continue;
    const role = roleOf(index, binding);
    const values = {
      subjects: subjectsText(subjects),
      role: `${binding.roleRef.kind} ${binding.roleRef.name}`,
      namespace: binding.namespace ?? '',
    };
    if (!role) {
      if (roleListLoaded(index, binding))
        emit(
          makeFinding(
            'rbac-missing-role',
            obj,
            i18n.t('Binds {subjects} to {role}, which does not exist', values),
          ),
        );
      continue;
    }
    const cluster = binding.kind === 'ClusterRoleBinding';
    const kubeSystem = binding.namespace === 'kube-system';
    const risks = roleRisks(role, cluster ? 'cluster' : 'namespace');
    const soft = (strong: Severity, weak: Severity) => (cluster || kubeSystem ? strong : weak);

    if (risks.has('cluster-admin')) {
      emit(
        makeFinding(
          'rbac-wildcard',
          obj,
          cluster
            ? i18n.t('Grants full admin on the whole cluster to {subjects} through {role}', values)
            : i18n.t(
                'Grants full admin in namespace {namespace} to {subjects} through {role}',
                values,
              ),
          'admin',
          cluster ? 'critical' : 'warning',
        ),
      );
      continue;
    }
    if (risks.has('wildcard'))
      emit(
        makeFinding(
          'rbac-wildcard',
          obj,
          cluster
            ? i18n.t(
                'Grants wildcard verbs or resources cluster-wide to {subjects} through {role}',
                values,
              )
            : i18n.t(
                'Grants wildcard verbs or resources in namespace {namespace} to {subjects} through {role}',
                values,
              ),
          'wildcard',
          soft('warning', 'info'),
        ),
      );
    const verbs = (['escalate', 'bind', 'impersonate'] as const).filter((v) => risks.has(v));
    if (verbs.length)
      emit(
        makeFinding(
          'rbac-escalation',
          obj,
          cluster
            ? i18n.t('Grants {verbs} cluster-wide to {subjects} through {role}', {
                ...values,
                verbs: verbs.join(', '),
              })
            : i18n.t('Grants {verbs} in namespace {namespace} to {subjects} through {role}', {
                ...values,
                verbs: verbs.join(', '),
              }),
          verbs.join(','),
          cluster ? 'critical' : 'warning',
        ),
      );
    if (risks.has('secrets'))
      emit(
        makeFinding(
          'rbac-secrets-read',
          obj,
          cluster
            ? i18n.t('{subjects} can read every Secret in the cluster through {role}', values)
            : i18n.t(
                '{subjects} can read the Secrets of namespace {namespace} through {role}',
                values,
              ),
          '',
          soft('warning', 'info'),
        ),
      );
    if (risks.has('exec'))
      emit(
        makeFinding(
          'rbac-pod-exec',
          obj,
          cluster
            ? i18n.t('{subjects} can exec into any pod in the cluster through {role}', values)
            : i18n.t(
                '{subjects} can exec into pods in namespace {namespace} through {role}',
                values,
              ),
          '',
          soft('warning', 'info'),
        ),
      );
    if (risks.has('nodes-proxy'))
      emit(
        makeFinding(
          'rbac-nodes-proxy',
          obj,
          i18n.t('{subjects} can reach the kubelet API of every node through {role}', values),
        ),
      );
    if (risks.has('create-pods') && (cluster || kubeSystem))
      emit(
        makeFinding(
          'rbac-kube-system-pods',
          obj,
          cluster
            ? i18n.t(
                '{subjects} can create pods in every namespace, kube-system included, through {role}',
                values,
              )
            : i18n.t('{subjects} can create pods in kube-system through {role}', values),
        ),
      );
  }
}
