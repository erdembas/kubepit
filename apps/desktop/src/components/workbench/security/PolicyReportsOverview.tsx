import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState, type ReactNode } from 'react';
import {
  ChevronRight,
  FileWarning,
  Loader2,
  Search,
  ShieldCheck,
  ScrollText,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  KYVERNO_CHART,
  KYVERNO_HELM_INSTALL,
  KYVERNO_INSTALL_ACCESS,
  KYVERNO_INSTALL_URL,
  KYVERNO_NAMESPACE,
  POLICY_RESULT_VALUES,
  policyGroups,
  policyTotals,
  reportRows,
  searchPolicyResults,
  type PolicyGroup,
  type PolicyResultValue,
  type ReportScope,
  type ResultCounts,
} from '@/lib/kube/policyreports';
import type { KubeObject } from '@/types';
import { formatAge } from '@/lib/format';
import { Card, StatTile } from '../overview/charts';
import { SeverityText } from './severity';
import type { PolicyReportData } from './hooks';
import { OperatorInstallCard, type OperatorInstallTexts } from './OperatorInstallCard';
import { KYVERNO_OPERATOR } from './operatorInstall';
import type { GateableAction } from '../access/gates';

/** RBAC/read-only gate of the Kyverno one-click install. */
const POLICY_INSTALL_ACTION: GateableAction = {
  id: 'kyverno-install',
  mutating: true,
  access: KYVERNO_INSTALL_ACCESS,
};

/**
 * The Policy reports half of the Security view: totals by result, failing
 * policies grouped by name with the objects they flagged, and one row per
 * report (`wgpolicyk8s.io`, written by Kyverno, Falcosidekick and others).
 */

const TOP = 8;

/** Visual language of policy results (literal class names for Tailwind). */
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

export function resultName(r: PolicyResultValue): string {
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

/** `F 3 · E 1 · W 2 · P 40` as fixed-width colored numbers (zero stays dim). */
export function ResultCells({
  counts,
  withSkip = false,
  className,
}: {
  counts: ResultCounts;
  withSkip?: boolean;
  className?: string;
}) {
  i18n.useLocale();
  const shown = withSkip
    ? POLICY_RESULT_VALUES
    : POLICY_RESULT_VALUES.filter((r) => r !== 'skip');
  return (
    <span className={cn('flex shrink-0 items-center gap-1 tabular-nums', className)}>
      {shown.map((r) => {
        const n = counts[r];
        return (
          <span
            key={r}
            title={`${resultName(r)}: ${n}`}
            className={cn(
              'w-7 rounded px-0.5 text-right text-[11px]',
              n ? cn(RESULT_TEXT[r], 'font-semibold') : 'text-fg-dim/50',
            )}
          >
            {n}
          </span>
        );
      })}
    </span>
  );
}

export interface PolicyActions {
  openReport: (report: KubeObject) => void;
  openObject: (scope: ReportScope | null) => void;
}

function scopeText(scope: ReportScope | null): string {
  if (!scope) return '';
  return `${scope.namespace ? `${scope.namespace}/` : ''}${scope.name}`;
}

function ScopeButton({ scope, actions }: { scope: ReportScope | null; actions: PolicyActions }) {
  if (!scope) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        actions.openObject(scope);
      }}
      className="text-accent hover:text-accent-hover min-w-0 truncate text-left hover:underline"
      title={`${scope.kind} ${scopeText(scope)}`}
    >
      {scopeText(scope)}
    </button>
  );
}

function ShowAll({
  total,
  expanded,
  onToggle,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  i18n.useLocale();
  if (total <= TOP) return null;
  return (
    <div className="border-border/40 border-t px-4 py-1.5">
      <button
        type="button"
        onClick={onToggle}
        className="text-accent text-[11.5px] hover:underline"
      >
        {expanded ? i18n.t('Show less') : i18n.t('Show all {count}', { count: total })}
      </button>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-fg-dim px-4 py-6 text-center text-[12px]">{children}</p>;
}

function ListHeader({ label, trailing }: { label: string; trailing?: ReactNode }) {
  return (
    <div className="border-border/60 text-fg-dim flex h-7 items-center gap-3 border-b px-4 text-[10px] font-semibold tracking-[0.08em] uppercase">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </div>
  );
}

function ResultHeaders() {
  i18n.useLocale();
  return (
    <span className="flex shrink-0 items-center gap-1">
      {POLICY_RESULT_VALUES.filter((r) => r !== 'skip').map((r) => (
        <span
          key={r}
          title={resultName(r)}
          aria-label={resultName(r)}
          className="flex w-7 justify-end pr-0.5"
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', RESULT_FILL[r])} />
        </span>
      ))}
    </span>
  );
}

/** Result word in its color (data values are shown translated). */
export function ResultText({
  result,
  className,
}: {
  result: PolicyResultValue;
  className?: string;
}) {
  i18n.useLocale();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-medium',
        RESULT_TEXT[result],
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', RESULT_FILL[result])} />
      {resultName(result)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function ResultTiles({ data, loading }: { data: PolicyReportData; loading: boolean }) {
  i18n.useLocale();
  const totals = useMemo(
    () => policyTotals([...data.items.PolicyReport, ...data.items.ClusterPolicyReport]),
    [data.items],
  );
  const reports = totals.reports;
  return (
    <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-5">
      {POLICY_RESULT_VALUES.map((r) => (
        <StatTile
          key={r}
          label={resultName(r)}
          value={loading ? '—' : i18n.number(totals[r])}
          tone={totals[r] ? RESULT_TEXT[r] : 'text-fg'}
          sub={
            loading ? undefined : r === 'pass' ? i18n.t('across {count} reports', { count: i18n.number(reports) }) : undefined
          }
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function SearchRow({
  result,
  scope,
  actions,
}: {
  result: ReturnType<typeof searchPolicyResults>[number];
  scope: ReportScope | null;
  actions: PolicyActions;
}) {
  i18n.useLocale();
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => actions.openReport(result.report)}
        onKeyDown={(e) => e.key === 'Enter' && actions.openReport(result.report)}
        className="hover:bg-fg/4 flex cursor-default flex-col gap-1 px-4 py-2 text-[12px] transition-colors @2xl:flex-row @2xl:items-center @2xl:gap-3"
      >
        <span className="flex min-w-0 items-center gap-2 @2xl:w-64 @2xl:shrink-0">
          <ResultText result={result.result.result} className="w-[72px] shrink-0 text-[11px]" />
          {result.result.severity && (
            <SeverityText severity={result.result.severity} className="shrink-0 text-[11px]" />
          )}
          <span
            className="text-fg min-w-0 truncate font-mono text-[11.5px] font-medium"
            title={result.result.policy}
            lang="en"
          >
            {result.result.policy}
          </span>
        </span>
        <span className="text-fg-muted min-w-0 flex-1 truncate" title={result.result.message}>
          {result.result.rule && (
            <span className="font-mono text-[11px]">
              {result.result.rule}
              <span className="text-fg-dim font-sans"> · </span>
            </span>
          )}
          {result.result.message || i18n.t('No message')}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-[11px] @2xl:w-56 @2xl:shrink-0">
          {scope ? (
            <>
              <span className="text-fg-dim shrink-0">{scope.kind}</span>
              <ScopeButton scope={scope} actions={actions} />
            </>
          ) : (
            <span className="text-fg-dim">{i18n.t('No scope')}</span>
          )}
        </span>
      </div>
    </li>
  );
}

function SearchCard({
  data,
  query,
  actions,
}: {
  data: PolicyReportData;
  query: string;
  actions: PolicyActions;
}) {
  i18n.useLocale();
  const rows = useMemo(
    () => searchPolicyResults([...data.items.PolicyReport, ...data.items.ClusterPolicyReport], query),
    [data.items, query],
  );
  return (
    <Card
      title={i18n.t('Policy search')}
      icon={<Search />}
      actions={
        <span className="text-fg-dim text-[11px] tabular-nums">
          {i18n.plural('{count} match', '{count} matches', rows.length)}
        </span>
      }
    >
      {!rows.length ? (
        <Empty>{i18n.t('No policy, rule, message or object matches “{query}”.', { query })}</Empty>
      ) : (
        <ul className="divide-border/40 divide-y">
          {rows.map((r, i) => (
            <SearchRow key={`${r.report.metadata.uid}|${i}`} result={r} scope={r.scope} actions={actions} />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Failing policies
// ---------------------------------------------------------------------------

function GroupView({ group, actions }: { group: PolicyGroup; actions: PolicyActions }) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const worst: PolicyResultValue = group.counts.fail
    ? 'fail'
    : group.counts.error
      ? 'error'
      : 'warn';
  return (
    <section className="border-border/40 border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="hover:bg-fg/3 flex w-full min-w-0 items-center gap-2.5 px-4 py-2 text-left transition-colors"
      >
        <ChevronRight
          className={cn(
            'text-fg-dim h-3.5 w-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        <ResultText result={worst} className="w-[72px] shrink-0 text-[11px]" />
        {group.severity && (
          <SeverityText severity={group.severity} className="hidden w-[72px] shrink-0 text-[11px] @md:inline-flex" />
        )}
        <span
          className="text-fg min-w-0 flex-1 truncate font-mono text-[12px]"
          title={group.policy}
          lang="en"
        >
          {group.policy}
        </span>
        <span className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {i18n.plural('{count} object', '{count} objects', group.results.length)}
        </span>
      </button>
      {open && (
        <ul className="pb-2">
          {group.results.slice(0, 50).map((r, i) => (
            <li key={`${r.report.metadata.uid}|${i}`}>
              <button
                type="button"
                onClick={() => actions.openReport(r.report)}
                className="hover:bg-fg/4 group flex w-full items-start gap-3 py-1 pr-4 pl-10 text-left"
              >
                <span className="text-fg-dim w-24 shrink-0 truncate pt-px text-[11px]">
                  {r.scope?.kind ?? ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-fg group-hover:text-accent block truncate text-[12px]">
                    {r.scope ? (
                      <>
                        {r.scope.namespace && <span className="text-fg-dim">{r.scope.namespace}/</span>}
                        {r.scope.name}
                      </>
                    ) : (
                      r.report.metadata.name
                    )}
                  </span>
                  {r.result.message && (
                    <span
                      className="text-fg-dim block truncate text-[11px]"
                      title={r.result.message}
                    >
                      {r.result.message}
                    </span>
                  )}
                </span>
                {r.result.severity && (
                  <SeverityText severity={r.result.severity} className="shrink-0 pt-px text-[11px]" />
                )}
              </button>
            </li>
          ))}
          {group.results.length > 50 && (
            <li className="text-fg-dim pl-10 text-[11px]">
              {i18n.plural('{count} more object', '{count} more objects', group.results.length - 50)}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function PoliciesCard({ data, actions }: { data: PolicyReportData; actions: PolicyActions }) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(
    () => policyGroups([...data.items.PolicyReport, ...data.items.ClusterPolicyReport]),
    [data.items],
  );
  const shown = expanded ? groups : groups.slice(0, TOP);
  return (
    <Card
      title={i18n.t('Failing policies')}
      icon={<FileWarning />}
      actions={
        <span className="text-fg-dim text-[11px] tabular-nums">
          {i18n.plural('{count} policy', '{count} policies', groups.length)}
        </span>
      }
    >
      {!groups.length ? (
        <Empty>{i18n.t('Every evaluated policy passes.')}</Empty>
      ) : (
        <>
          {shown.map((g) => (
            <GroupView key={g.policy} group={g} actions={actions} />
          ))}
          <ShowAll
            total={groups.length}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function ReportsCard({ data, query, actions }: { data: PolicyReportData; query: string; actions: PolicyActions }) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const { rows, total } = useMemo(
    () => reportRows([...data.items.PolicyReport, ...data.items.ClusterPolicyReport], query),
    [data.items, query],
  );
  const shown = expanded ? rows : rows.slice(0, TOP);
  const now = Date.now();
  return (
    <Card
      title={i18n.t('Reports by object')}
      icon={<ScrollText />}
      actions={
        <span className="text-fg-dim text-[11px] tabular-nums">
          {i18n.plural('{count} report', '{count} reports', total)}
        </span>
      }
    >
      {!total ? (
        <Empty>
          {query
            ? i18n.t('No report matches “{query}”.', { query })
            : i18n.t('No policy reports yet.')}
        </Empty>
      ) : (
        <>
          <ListHeader label={i18n.t('Object')} trailing={<ResultHeaders />} />
          <ul className="divide-border/40 divide-y">
            {shown.map((r) => (
              <li key={r.report.metadata.uid}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => actions.openReport(r.report)}
                  onKeyDown={(e) => e.key === 'Enter' && actions.openReport(r.report)}
                  className="hover:bg-fg/4 flex w-full cursor-default items-center gap-3 px-4 py-1.5 transition-colors"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                      <span className="text-fg-dim shrink-0 text-[10.5px]">
                        {r.scope?.kind ?? i18n.t('No scope')}
                      </span>
                      {r.scope ? (
                        <ScopeButton scope={r.scope} actions={actions} />
                      ) : (
                        <span className="text-fg truncate">{r.report.metadata.name}</span>
                      )}
                    </span>
                    {r.updated && (
                      <span className="text-fg-dim block truncate text-[10.5px]" title={r.updated}>
                        {i18n.t('{age} ago', { age: formatAge(r.updated, now) })}
                      </span>
                    )}
                  </span>
                  <ResultCells counts={r.counts} />
                </div>
              </li>
            ))}
          </ul>
          <ShowAll total={rows.length} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Missing
// ---------------------------------------------------------------------------

/** CRDs not served: offer the one-click Kyverno install (or the commands). */
export function PolicyReportsMissing({ clusterId }: { clusterId: string }) {
  i18n.useLocale();
  const texts: OperatorInstallTexts = {
    displayName: i18n.t('Kyverno'),
    title: i18n.t('No policy reports on this cluster'),
    body: i18n.t(
      'Policy reports (wgpolicyk8s.io) appear when a policy engine evaluates your objects. Kyverno is an open-source policy engine designed for Kubernetes: it validates, mutates and generates configurations, and records what its policies decided as PolicyReports, which Kubepit reads here. Other engines that write the same reports work without this install.',
    ),
    installLabel: i18n.t('Install Kyverno'),
    installingLabel: i18n.t('Installing Kyverno…'),
    confirmImpact: i18n.t(
      'It adds its CRDs, cluster-wide RBAC and an admission controller that applies the policies you define.',
    ),
    footnote: i18n.t(
      'Adds the kyverno Helm repository and installs {chart} into {namespace} with helm, then waits for the policy report kinds.',
      { chart: KYVERNO_CHART, namespace: KYVERNO_NAMESPACE },
    ),
    helmCommand: KYVERNO_HELM_INSTALL,
    guideUrl: KYVERNO_INSTALL_URL,
  };
  return (
    <OperatorInstallCard
      clusterId={clusterId}
      spec={KYVERNO_OPERATOR}
      texts={texts}
      action={POLICY_INSTALL_ACTION}
    />
  );
}

// ---------------------------------------------------------------------------

export function PolicyReportsOverview({
  data,
  query,
  actions,
}: {
  data: PolicyReportData;
  query: string;
  actions: PolicyActions;
}) {
  i18n.useLocale();
  const reports = useMemo(
    () => [...data.items.PolicyReport, ...data.items.ClusterPolicyReport],
    [data.items],
  );
  const loading = !data.synced && !reports.length;
  return (
    <div className="space-y-4">
      <ResultTiles data={data} loading={loading} />
      {loading ? (
        <div className="text-fg-muted flex items-center justify-center gap-2 py-6 text-[12px]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {i18n.t('Reading policy reports…')}
        </div>
      ) : !reports.length ? (
        <div className="bg-surface-raised/40 border-border flex items-start gap-2.5 rounded-lg border p-4">
          <ShieldCheck className="text-fg-dim mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-fg-dim text-[12px] leading-relaxed">
            {i18n.t(
              'The policy report kinds are served but no report has been written yet. A policy engine writes them after its next evaluation.',
            )}
          </p>
        </div>
      ) : (
        <>
          {query.trim() && <SearchCard data={data} query={query} actions={actions} />}
          <PoliciesCard data={data} actions={actions} />
          <ReportsCard data={data} query={query} actions={actions} />
        </>
      )}
    </div>
  );
}
