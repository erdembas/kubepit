import * as i18n from '@/i18n';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { RefLink } from '@/lib/kube/columns/cells';
import type { ColumnContext, ObjectRef } from '@/lib/kube/columns';
import {
  conditionTone,
  type GatewayIssue,
  type GwCondition,
  type IssueSeverity,
} from '@/lib/kube/gateway';
import { toneText } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { MiniTable, ToneText } from '../details/primitives';

/** Small building blocks shared by the Gateway API view and its details sections. */

/** Conditions whose `True` is bad. */
const NEGATIVE = new Set(['Conflicted', 'Overridden', 'Degraded']);

/** `Accepted  Programmed  ResolvedRefs` coloured by status; reasons and messages in the tooltip. */
export function ConditionChips({ conditions }: { conditions: readonly GwCondition[] }) {
  if (!conditions.length) return <span className="text-fg-dim">—</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {conditions.map((c) => {
        const negative = NEGATIVE.has(c.type);
        // A negative condition that is False is uninteresting.
        if (negative && c.status !== 'True') return null;
        const tone = conditionTone(c, negative);
        return (
          <span
            key={c.type}
            className={cn('shrink-0 font-medium', toneText(tone))}
            title={[`${c.type}=${c.status}`, c.reason, c.message].filter(Boolean).join('\n')}
          >
            {c.status === 'True' || !c.reason ? c.type : `${c.type}: ${c.reason}`}
          </span>
        );
      })}
    </span>
  );
}

export function ConditionsTable({
  conditions,
  now,
}: {
  conditions: readonly GwCondition[];
  now: number;
}) {
  i18n.useLocale();
  return (
    <MiniTable
      rows={[...conditions]}
      rowKey={(c) => c.type}
      columns={[
        { label: i18n.t('Type'), cell: (c) => <span className="text-fg">{c.type}</span> },
        {
          label: i18n.t('Status'),
          cell: (c) => (
            <ToneText tone={conditionTone(c, NEGATIVE.has(c.type))}>{c.status}</ToneText>
          ),
        },
        {
          label: i18n.t('Reason'),
          cell: (c) => (
            <span className="flex flex-col">
              <span>{c.reason || '—'}</span>
              {c.message && <span className="text-fg-dim break-words">{c.message}</span>}
            </span>
          ),
        },
        {
          label: i18n.t('Updated'),
          cell: (c) => formatAge(c.lastTransitionTime || undefined, now),
          className: 'text-right whitespace-nowrap',
        },
      ]}
    />
  );
}

const SEVERITY_ICON: Record<IssueSeverity, typeof Info> = {
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
};

const SEVERITY_CLASS: Record<IssueSeverity, string> = {
  error: 'text-status-error',
  warning: 'text-status-starting',
  info: 'text-cat-frontend',
};

export function severityLabel(s: IssueSeverity): string {
  return s === 'error' ? i18n.t('Error') : s === 'warning' ? i18n.t('Warning') : i18n.t('Info');
}

export function SeverityIcon({
  severity,
  className,
}: {
  severity: IssueSeverity;
  className?: string;
}) {
  const Icon = SEVERITY_ICON[severity];
  return (
    <Icon
      className={cn('h-3.5 w-3.5 shrink-0', SEVERITY_CLASS[severity], className)}
      aria-label={severityLabel(severity)}
    />
  );
}

/**
 * Diagnosis findings: severity, title, the controller's message, the hint
 * and a link to the other object. `showSubject` names the object each
 * finding is about (lists that mix objects).
 */
export function IssueList({
  issues,
  ctx,
  showSubject = false,
  empty,
}: {
  issues: readonly GatewayIssue[];
  ctx: Pick<ColumnContext, 'navigate'>;
  showSubject?: boolean;
  empty?: string;
}) {
  i18n.useLocale();
  if (!issues.length)
    return <p className="text-fg-dim text-[12px]">{empty ?? i18n.t('No problems found.')}</p>;
  const link = (ref: ObjectRef, label?: string) => (
    <RefLink target={ref} ctx={ctx as ColumnContext} label={label} />
  );
  return (
    <ul className="flex flex-col gap-2">
      {issues.map((issue, i) => (
        <li
          key={`${issue.code}|${issue.subject.namespace ?? ''}/${issue.subject.name}|${i}`}
          className="border-border/60 bg-fg/[0.015] flex items-start gap-2 rounded-md border px-2.5 py-2 text-[12px]"
        >
          <SeverityIcon severity={issue.severity} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            {showSubject && (
              <div className="text-fg-dim mb-0.5 flex min-w-0 items-center gap-1.5 text-[11px]">
                <span className="shrink-0">{issue.subject.kind}</span>
                {link(
                  issue.subject,
                  issue.subject.namespace
                    ? `${issue.subject.namespace}/${issue.subject.name}`
                    : issue.subject.name,
                )}
              </div>
            )}
            <p className="text-fg break-words">{issue.title}</p>
            {issue.detail && (
              <p className="text-fg-muted mt-0.5 font-mono text-[11px] break-words">
                {issue.detail}
              </p>
            )}
            {issue.hint && <p className="text-fg-dim mt-0.5 break-words">{issue.hint}</p>}
            {issue.target && (
              <p className="text-fg-dim mt-1 flex min-w-0 items-baseline gap-1.5 text-[11px]">
                <span className="shrink-0">{issue.target.kind}</span>
                {link(
                  issue.target,
                  issue.target.namespace && issue.target.namespace !== issue.subject.namespace
                    ? `${issue.target.namespace}/${issue.target.name}`
                    : issue.target.name,
                )}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
