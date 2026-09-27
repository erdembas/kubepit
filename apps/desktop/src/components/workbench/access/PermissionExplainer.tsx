import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { kubectlCanI, resourceRef } from '@/lib/kube/access';
import { reviewNow } from '@/store/useAccessStore';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { AccessCheck, AccessDecision } from '@/types';
import { ChipList, CodeBlock, MonoText, Row, Rows, Section } from '../details/primitives';
import { errorText } from '../util';
import { isUnsupported, useWhoAmI } from './hooks';

/** The Role rule that would grant `check`, as YAML. */
function ruleSnippet(check: AccessCheck) {
  const lines = [
    `- apiGroups: ["${check.group}"]`,
    `  resources: ["${check.subresource ? `${check.resource}/${check.subresource}` : check.resource}"]`,
  ];
  if (check.name) lines.push(`  resourceNames: ["${check.name}"]`);
  lines.push(`  verbs: ["${check.verb}"]`);
  return lines.join('\n');
}

function scopeLabel(check: AccessCheck) {
  return check.namespace
    ? i18n.t('in {namespace}', { namespace: check.namespace })
    : i18n.t('cluster-wide');
}

/**
 * "Why?" for a forbidden list or action: fresh SelfSubjectAccessReviews
 * with the authorizer's reasons, the identity the API server sees, and the
 * rule an admin would have to grant.
 */
export function PermissionExplainer({
  clusterId,
  checks,
  namespaced,
  onClose,
}: {
  clusterId: string;
  /** Same verb and resource; one per namespace in scope. */
  checks: AccessCheck[];
  namespaced: boolean;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [decisions, setDecisions] = useState<AccessDecision[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const who = useWhoAmI(clusterId, true);
  const first = checks[0];

  useEffect(() => {
    let live = true;
    reviewNow(clusterId, checks)
      .then((d) => live && setDecisions(d))
      .catch((e: unknown) => live && setFailure(errorText(e)));
    return () => {
      live = false;
    };
    // Checks are fixed for the dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  if (!first) return null;
  const denied = checks.filter((_, i) => decisions?.[i] && !decisions[i]!.allowed);
  const target = denied[0] ?? first;
  const openPermissions = () => {
    useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.myPermissions);
    onClose();
  };

  return (
    <Dialog
      title={i18n.t("Why can't I {verb} {resource}?", {
        verb: first.verb,
        resource: resourceRef(first),
      })}
      subtitle={kubectlCanI(target, namespaced)}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={openPermissions}>
            {i18n.t('Open My Permissions')}
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            {i18n.t('Close')}
          </Button>
        </>
      }
    >
      <div className="-m-4">
        <Section title={i18n.t('Decision')}>
          {failure ? (
            <p className="text-status-error text-[12px] break-words">{failure}</p>
          ) : (
            <ul className="space-y-2.5">
              {checks.map((check, i) => {
                const d = decisions?.[i];
                const Icon = !d
                  ? Loader2
                  : d.error
                    ? ShieldQuestion
                    : d.allowed
                      ? ShieldCheck
                      : ShieldX;
                return (
                  <li key={`${check.namespace ?? ''}|${i}`} className="flex items-start gap-2.5">
                    <Icon
                      className={
                        !d
                          ? 'text-fg-dim mt-0.5 h-4 w-4 shrink-0 animate-spin'
                          : d.error
                            ? 'text-status-starting mt-0.5 h-4 w-4 shrink-0'
                            : d.allowed
                              ? 'text-status-running mt-0.5 h-4 w-4 shrink-0'
                              : 'text-status-error mt-0.5 h-4 w-4 shrink-0'
                      }
                    />
                    <div className="min-w-0 flex-1 text-[12px]">
                      <p className="text-fg">
                        <MonoText>
                          {check.verb} {resourceRef(check)}
                        </MonoText>{' '}
                        <span className="text-fg-dim">{scopeLabel(check)}</span>
                      </p>
                      <p className="text-fg-muted mt-0.5 break-words">
                        {!d
                          ? i18n.t('Asking the API server…')
                          : d.error
                            ? d.error
                            : d.allowed
                              ? i18n.t('Allowed now. Retry loading the list.')
                              : (d.reason ??
                                (d.denied
                                  ? i18n.t('Explicitly denied by an authorizer.')
                                  : i18n.t('No RBAC rule grants this permission.')))}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
        <Section title={i18n.t('Signed in as')}>
          {who.data ? (
            <Rows>
              <Row label={i18n.t('User')}>
                <MonoText>{who.data.username || '—'}</MonoText>
              </Row>
              <Row label={i18n.t('Groups')}>
                <ChipList entries={who.data.groups} limit={6} />
              </Row>
            </Rows>
          ) : who.error ? (
            <p className="text-fg-dim text-[12px]">
              {isUnsupported(who.error)
                ? i18n.t('This cluster cannot report who you are (SelfSubjectReview needs 1.28+).')
                : who.error}
            </p>
          ) : (
            <p className="text-fg-dim flex items-center gap-2 text-[12px]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {i18n.t('Loading…')}
            </p>
          )}
        </Section>
        <Section title={i18n.t('How to get access')}>
          <p className="text-fg-muted mb-2 text-[12px] leading-relaxed">
            {target.namespace
              ? i18n.t(
                  'Ask a cluster admin to bind a Role with this rule to your user or one of your groups in {namespace}:',
                  { namespace: target.namespace },
                )
              : i18n.t(
                  'Ask a cluster admin to bind a ClusterRole with this rule to your user or one of your groups:',
                )}
          </p>
          <CodeBlock text={ruleSnippet(target)} />
          <p className="text-fg-dim mt-3 mb-1.5 text-[11px]">
            {i18n.t('Check again from a terminal:')}
          </p>
          <CodeBlock text={kubectlCanI(target, namespaced)} />
        </Section>
      </div>
    </Dialog>
  );
}
