import * as i18n from '@/i18n/core';
import type { RuleDef } from './rules';
import type { HealthKind } from './types';

/**
 * Catalog entries of the Pod Security Standards and RBAC rule families
 * (`podSecurity.ts`, `rbac.ts`). Pod Security findings only appear in
 * namespaces that opted into a level through their labels, and RBAC findings
 * skip platform-managed bindings, so neither repeats the generic
 * security-context rules.
 */

const RBAC_LISTS: readonly HealthKind[] = ['clusterRoles'];

function security(
  id: string,
  severity: RuleDef['severity'],
  needs: readonly HealthKind[],
  title: () => string,
  hint: () => string,
  category: RuleDef['category'] = 'security',
): RuleDef {
  return { id, category, severity, needs, local: false, title, hint };
}

export const SECURITY_RULES: readonly RuleDef[] = [
  // -- Pod Security Standards ---------------------------------------------------
  security(
    'pss-enforce-violation',
    'critical',
    ['namespaces'],
    () => i18n.t('Workloads violating their namespace’s enforced Pod Security level'),
    () =>
      i18n.t(
        'The API server rejects new pods that fail the enforced level: fix the listed checks in the pod template, or lower pod-security.kubernetes.io/enforce on the namespace.',
      ),
  ),
  security(
    'pss-audit-violation',
    'warning',
    ['namespaces'],
    () => i18n.t('Workloads violating their namespace’s audit or warn Pod Security level'),
    () =>
      i18n.t(
        'These pods are admitted but logged or warned about; fix the listed checks before raising the enforce level.',
      ),
  ),
  // -- RBAC -------------------------------------------------------------------
  security(
    'rbac-wildcard',
    'warning',
    RBAC_LISTS,
    () => i18n.t('Bindings granting wildcard or full admin access'),
    () =>
      i18n.t(
        'Replace * verbs and resources with the exact verbs and resources the subject needs; full admin should be limited to break-glass identities.',
      ),
  ),
  security(
    'rbac-escalation',
    'critical',
    RBAC_LISTS,
    () => i18n.t('Bindings granting escalate, bind or impersonate'),
    () =>
      i18n.t(
        'These verbs let a subject grant itself more permissions or act as another identity; remove them unless the subject manages RBAC.',
      ),
  ),
  security(
    'rbac-secrets-read',
    'warning',
    RBAC_LISTS,
    () => i18n.t('Bindings granting read access to Secrets'),
    () =>
      i18n.t(
        'get, list and watch on secrets return the values; restrict the rule with resourceNames or move the workload to a narrower role.',
      ),
  ),
  security(
    'rbac-pod-exec',
    'warning',
    RBAC_LISTS,
    () => i18n.t('Bindings granting exec or attach into pods'),
    () =>
      i18n.t(
        'pods/exec and pods/attach give a shell with the pod’s credentials; grant them only to operators who need interactive access.',
      ),
  ),
  security(
    'rbac-nodes-proxy',
    'warning',
    RBAC_LISTS,
    () => i18n.t('Bindings granting nodes/proxy'),
    () =>
      i18n.t(
        'nodes/proxy reaches the kubelet API, which can run commands in any pod on the node; limit it to monitoring that really needs it.',
      ),
  ),
  security(
    'rbac-kube-system-pods',
    'warning',
    RBAC_LISTS,
    () => i18n.t('Bindings allowing pod creation in kube-system'),
    () =>
      i18n.t(
        'A pod in kube-system can mount the service accounts of control-plane add-ons; scope pod creation to the namespaces the subject deploys to.',
      ),
  ),
  security(
    'rbac-missing-role',
    'info',
    RBAC_LISTS,
    () => i18n.t('Bindings referencing a role that does not exist'),
    () =>
      i18n.t(
        'Delete the binding or create the role; a later role with that name would silently grant its rules to these subjects.',
      ),
    'hygiene',
  ),
];
