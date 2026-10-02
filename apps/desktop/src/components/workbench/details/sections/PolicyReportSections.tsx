import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { RefLink } from '@/lib/kube/columns/cells';
import { formatAge } from '@/lib/format';
import {
  reportEngine,
  reportResults,
  reportResultCounts,
  reportScope,
  updatedAt,
  type PolicyResult,
  type PolicyResultValue,
} from '@/lib/kube/policyreports';
import { SeverityText } from '../../security/severity';
import { MonoText, Row, Rows, Section } from '../primitives';
import type { SectionProps } from './types';

/**
 * Details sections of policy reports (`wgpolicyk8s.io`). Policy and rule
 * names, categories and result messages are Kubernetes data and are shown
 * verbatim.
 */

const PAGE = 25;

const RESULT_TEXT: Record<PolicyResultValue, string> = {
  fail: 'text-status-error',
  error: 'text-cat-infra',
  warn: 'text-status-starting',
  pass: 'text-status-running',
  skip: 'text-fg-dim',
};

const RESULT_FILL: Record<PolicyResultValue, string> = {
  fail: 'bg-status-error',
  error: 'bg-cat-infra',
  warn: 'bg-status-starting',
  pass: 'bg-status-running',
  skip: 'bg-fg-dim',
};

function resultName(r: PolicyResultValue): string {
  switch (r) {
    case 'fail':
      return i18n.t('Fail');
    case 'error':
      return i18n.t('Error');
    case 'warn':
      return i18n.t('Warn');
    case 'pass':
      return i18n.t('Pass');
    default:
      return i18n.t('Skip');
  }
}

function ResultBadge({ result }: { result: PolicyResultValue }) {
  i18n.useLocale();
  return (
    <span className="inline-flex w-[64px] shrink-0 items-center gap-1.5 text-[11px] font-medium">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', RESULT_FILL[result])} />
      <span className={RESULT_TEXT[result]}>{resultName(result)}</span>
    </span>
  );
}

function matches(r: PolicyResult, q: string): boolean {
  return `${r.policy} ${r.rule} ${r.message} ${r.category}`.toLowerCase().includes(q);
}

export function PolicyReportSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState(PAGE);
  const scope = reportScope(obj);
  const updated = updatedAt(obj);
  const counts = useMemo(() => reportResultCounts(obj), [obj]);
  const results = useMemo(() => reportResults(obj), [obj]);
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? results.filter((r) => matches(r, q)) : results),
    [results, q],
  );
  const visible = filtered.slice(0, shown);

  return (
    <>
      <Section title={i18n.t('Report')}>
        <Rows>
          <Row label={i18n.t('Object')}>
            {scope ? (
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-fg-dim text-[11px]">{scope.kind}</span>
                <RefLink
                  target={{ kind: scope.kind, name: scope.name, namespace: scope.namespace }}
                  ctx={ctx}
                />
              </span>
            ) : null}
          </Row>
          <Row label={i18n.t('Results')}>
            <span className="flex items-center gap-2 text-[11.5px] tabular-nums">
              {counts.fail > 0 && (
                <span className="text-status-error font-semibold">{counts.fail} {resultName('fail')}</span>
              )}
              {counts.error > 0 && (
                <span className="text-cat-infra font-semibold">{counts.error} {resultName('error')}</span>
              )}
              {counts.warn > 0 && (
                <span className="text-status-starting font-semibold">{counts.warn} {resultName('warn')}</span>
              )}
              {counts.pass > 0 && <span className="text-status-running">{counts.pass} {resultName('pass')}</span>}
              {counts.skip > 0 && <span className="text-fg-dim">{counts.skip} {resultName('skip')}</span>}
            </span>
          </Row>
          <Row label={i18n.t('Engine')}>
            {reportEngine(obj) ? <MonoText>{reportEngine(obj)}</MonoText> : null}
          </Row>
          <Row label={i18n.t('Updated')}>
            {updated ? (
              <span title={updated}>
                {i18n.t('{age} ago', { age: formatAge(updated, ctx.now) })}
              </span>
            ) : null}
          </Row>
        </Rows>
      </Section>
      <Section
        title={i18n.t('Results')}
        actions={
          <div className="bg-surface border-border focus-within:border-accent/50 flex h-6.5 min-w-36 items-center gap-1.5 rounded-md border px-1.5">
            <Search className="text-fg-dim h-3 w-3 shrink-0" />
            <input
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setShown(PAGE);
              }}
              placeholder={i18n.t('Filter policies…')}
              aria-label={i18n.t('Filter policies')}
              className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[11px] outline-none"
            />
          </div>
        }
      >
        {!filtered.length ? (
          <p className="text-fg-dim px-1 py-2 text-[11.5px]">
            {q ? i18n.t('No result matches “{query}”.', { query: filter.trim() }) : i18n.t('No results.')}
          </p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {visible.map((r, i) => (
                <li key={`${r.policy}|${r.rule}|${i}`} className="min-w-0">
                  <div className="flex min-w-0 items-baseline gap-2 text-[12px]">
                    <ResultBadge result={r.result} />
                    <span className="text-fg min-w-0 truncate font-mono text-[11.5px]" lang="en">
                      {r.policy}
                      {r.rule && r.rule !== r.policy && (
                        <span className="text-fg-dim font-sans"> · </span>
                      )}
                      {r.rule && r.rule !== r.policy ? r.rule : ''}
                    </span>
                    {r.severity && (
                      <SeverityText severity={r.severity} className="ml-auto shrink-0 text-[11px]" />
                    )}
                  </div>
                  {r.message && (
                    <p
                      className="text-fg-muted mt-0.5 pl-[72px] text-[11px] leading-relaxed break-words"
                      title={r.message}
                    >
                      {r.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {filtered.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE)}
                className="text-accent mt-2 text-[11px] hover:underline"
              >
                {i18n.t('Show all {count}', { count: filtered.length })}
              </button>
            )}
          </>
        )}
      </Section>
    </>
  );
}
