import * as i18n from '@/i18n/core';
import type { RiskId } from './risk';
import type { SubjectKind } from './model';

/** Translated labels for RBAC risks and subject kinds (kinds stay English where shown as identifiers). */

export function riskLabel(risk: RiskId): string {
  switch (risk) {
    case 'cluster-admin':
      return i18n.t('Full admin (every verb on every resource)');
    case 'wildcard':
      return i18n.t('Wildcard verbs or resources');
    case 'escalate':
      return i18n.t('Can escalate roles');
    case 'bind':
      return i18n.t('Can bind roles');
    case 'impersonate':
      return i18n.t('Can impersonate identities');
    case 'secrets':
      return i18n.t('Can read Secrets');
    case 'exec':
      return i18n.t('Can exec or attach into pods');
    case 'nodes-proxy':
      return i18n.t('Can reach the kubelet API (nodes/proxy)');
    default:
      return i18n.t('Can create pods');
  }
}

export function subjectKindLabel(kind: SubjectKind): string {
  switch (kind) {
    case 'User':
      return i18n.t('User');
    case 'Group':
      return i18n.t('Group');
    default:
      return i18n.t('Service account');
  }
}

/** Explains the built-in groups that stand for many identities. */
export function groupHint(name: string): string | null {
  if (name === 'system:authenticated')
    return i18n.t('Every authenticated user and service account');
  if (name === 'system:unauthenticated') return i18n.t('Anonymous requests');
  if (name === 'system:serviceaccounts') return i18n.t('Every service account in the cluster');
  if (name.startsWith('system:serviceaccounts:'))
    return i18n.t('Every service account in namespace {namespace}', {
      namespace: name.slice('system:serviceaccounts:'.length),
    });
  if (name === 'system:masters') return i18n.t('Superusers (bypass RBAC)');
  return null;
}
