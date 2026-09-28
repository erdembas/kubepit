import * as i18n from '@/i18n/core';
import {
  evaluateObject,
  hasPssPolicy,
  levelRank,
  namespacePss,
  policyText,
  type NamespacePss,
  type PssModePolicy,
  type PssViolation,
} from '../pss';
import { makeFinding, specOwners, type Emit } from './context';
import type { HealthInput } from './types';

/**
 * Pod Security Standards as a rule family: every workload template (or bare
 * pod) is evaluated against the policy its namespace declares through
 * `pod-security.kubernetes.io/*` labels. Namespaces without a level stricter
 * than privileged produce nothing, so clusters that do not use Pod Security
 * admission see no new findings.
 */

function reasons(violations: readonly PssViolation[]): string {
  return [...new Set(violations.map((v) => v.reason))].join(', ');
}

function hint(violations: readonly PssViolation[]): string {
  return violations.map((v) => `${v.reason}: ${v.detail}`).join(' · ');
}

/** The stricter of the audit and warn policies, with the modes that declare it. */
function softPolicy(pss: NamespacePss): { policy: PssModePolicy; modes: string } | null {
  const { audit, warn } = pss;
  if (audit.level === 'privileged' && warn.level === 'privileged') return null;
  if (audit.level === warn.level && audit.version === warn.version)
    return { policy: audit, modes: 'audit, warn' };
  return levelRank(audit.level) >= levelRank(warn.level)
    ? { policy: audit, modes: 'audit' }
    : { policy: warn, modes: 'warn' };
}

export function podSecurityFindings(input: HealthInput, emit: Emit) {
  if (!input.loaded.has('namespaces')) return;
  const policies = new Map<string, NamespacePss>();
  for (const ns of input.namespaces) {
    const pss = namespacePss(ns.metadata.labels);
    if (hasPssPolicy(pss)) policies.set(ns.metadata.name, pss);
  }
  if (!policies.size) return;
  for (const owner of specOwners(input)) {
    const pss = policies.get(owner.metadata.namespace ?? '');
    if (!pss) continue;
    if (pss.enforce.level !== 'privileged') {
      const violations = evaluateObject(pss.enforce, owner);
      if (violations.length) {
        const bare = owner.kind === 'Pod';
        const finding = makeFinding(
          'pss-enforce-violation',
          owner,
          bare
            ? i18n.t(
                'Running pod violates the enforced {policy} level ({checks}); it would be rejected if recreated',
                { policy: policyText(pss.enforce), checks: reasons(violations) },
              )
            : i18n.t('New pods are rejected by the enforced {policy} level: {checks}', {
                policy: policyText(pss.enforce),
                checks: reasons(violations),
              }),
          'enforce',
          bare ? 'warning' : undefined,
        );
        finding.hint = hint(violations);
        emit(finding);
        continue;
      }
    }
    const soft = softPolicy(pss);
    if (!soft) continue;
    const violations = evaluateObject(soft.policy, owner);
    if (!violations.length) continue;
    const finding = makeFinding(
      'pss-audit-violation',
      owner,
      i18n.t('Violates the {policy} level set for {modes}: {checks}', {
        policy: policyText(soft.policy),
        modes: soft.modes,
        checks: reasons(violations),
      }),
      soft.modes,
    );
    finding.hint = hint(violations);
    emit(finding);
  }
}
