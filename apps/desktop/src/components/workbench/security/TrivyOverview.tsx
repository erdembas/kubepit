import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState, type ReactNode } from 'react';
import {
  BadgeCheck,
  Bug,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  FileKey2,
  Images,
  Lightbulb,
  Loader2,
  Search,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  SEVERITIES,
  checkGroups,
  complianceRows,
  safeLink,
  searchVulns,
  secretRows,
  vulnOverview,
  type CheckGroup,
  type CveRow,
  type Severity,
  type WorkloadKey,
} from '@/lib/kube/trivy';
import type { KubeObject } from '@/types';
import { openExternal } from '../actions/openExternal';
import { Card, StatTile } from '../overview/charts';
import type { TrivyData } from './hooks';
import {
  CountCells,
  CountHeaders,
  SEV_TEXT,
  SeverityBar,
  SeverityText,
  countOf,
  severityName,
} from './severity';

/**
 * The Trivy half of the Security view: severity totals, the most
 * vulnerable images (one row per digest), workloads ranked by risk, CVE
 * search, failed checks grouped by check, exposed secrets (metadata only)
 * and compliance reports.
 */

const TOP = 8;

export interface OverviewActions {
  openReport: (report: KubeObject) => void;
  openObject: (target: WorkloadKey) => void;
}

function workloadText(w: WorkloadKey): string {
  return `${w.namespace ? `${w.namespace}/` : ''}${w.name}`;
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

function WorkloadButton({
  workload,
  actions,
}: {
  workload: WorkloadKey;
  actions: OverviewActions;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        actions.openObject(workload);
      }}
      className="text-accent hover:text-accent-hover min-w-0 truncate text-left hover:underline"
      title={`${workload.kind} ${workloadText(workload)}`}
    >
      {workloadText(workload)}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Severity tiles
// ---------------------------------------------------------------------------

function SeverityTiles({
  totals,
  fixable,
  fixableOnly,
  loading,
}: {
  totals: Record<Severity, number>;
  fixable: Record<Severity, number>;
  fixableOnly: boolean;
  loading: boolean;
}) {
  i18n.useLocale();
  return (
    <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-5">
      {SEVERITIES.map((s) => (
        <StatTile
          key={s}
          label={severityName(s)}
          value={loading ? '—' : i18n.number(totals[s])}
          tone={totals[s] ? SEV_TEXT[s] : 'text-fg'}
          sub={
            loading
              ? undefined
              : fixableOnly
                ? i18n.t('fixable')
                : i18n.t('{count} fixable', { count: i18n.number(fixable[s]) })
          }
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CVE search
// ---------------------------------------------------------------------------

function CveRowView({ row, actions }: { row: CveRow; actions: OverviewActions }) {
  i18n.useLocale();
  const link = safeLink(row.link);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => row.reports[0] && actions.openReport(row.reports[0])}
        onKeyDown={(e) => e.key === 'Enter' && row.reports[0] && actions.openReport(row.reports[0])}
        className="hover:bg-fg/4 flex cursor-default flex-col gap-1 px-4 py-2 text-[12px] transition-colors @2xl:flex-row @2xl:items-center @2xl:gap-3"
      >
        <span className="flex min-w-0 items-center gap-2 @2xl:w-56 @2xl:shrink-0">
          <span className="text-fg truncate font-mono text-[11.5px] font-medium" lang="en">
            {row.id}
          </span>
          {link && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openExternal(link);
              }}
              title={i18n.t('Open advisory')}
              aria-label={i18n.t('Open advisory')}
              className="text-fg-dim hover:text-accent shrink-0"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          <SeverityText severity={row.severity} className="ml-auto text-[11px] @2xl:ml-0" />
        </span>
        <span className="text-fg-muted min-w-0 flex-1 truncate" title={row.title}>
          <span className="text-fg font-mono text-[11px]">{row.packages.join(', ')}</span>
          <span className="text-fg-dim"> · </span>
          <span className="font-mono text-[11px]">{row.installed.join(', ')}</span>
          <span className="text-fg-dim"> → </span>
          <span
            className={cn(
              'font-mono text-[11px]',
              row.fixed.length ? 'text-status-running' : 'text-fg-dim',
            )}
          >
            {row.fixed.length ? row.fixed.join(', ') : i18n.t('no fix')}
          </span>
        </span>
        <span className="text-fg-dim shrink-0 text-[11px] tabular-nums">
          {i18n.plural('{count} workload', '{count} workloads', row.workloads.length)}
          {' · '}
          {i18n.plural('{count} image', '{count} images', row.images.length)}
        </span>
      </div>
    </li>
  );
}

function CveSearchCard({
  reports,
  query,
  fixableOnly,
  actions,
}: {
  reports: readonly KubeObject[];
  query: string;
  fixableOnly: boolean;
  actions: OverviewActions;
}) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const result = useMemo(
    () => searchVulns(reports, query, fixableOnly),
    [reports, query, fixableOnly],
  );
  const shown = expanded ? result.rows : result.rows.slice(0, TOP);
  return (
    <Card
      title={i18n.t('Vulnerability search')}
      icon={<Search />}
      actions={
        <span className="text-fg-dim text-[11px] tabular-nums">
          {i18n.plural('{count} match', '{count} matches', result.total)}
        </span>
      }
    >
      {!result.rows.length ? (
        <Empty>
          {i18n.t('No vulnerability id, package or title matches “{query}”.', { query })}
        </Empty>
      ) : (
        <>
          <ul className="divide-border/40 divide-y">
            {shown.map((row) => (
              <CveRowView key={row.id} row={row} actions={actions} />
            ))}
          </ul>
          <ShowAll
            total={result.rows.length}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Images and workloads
// ---------------------------------------------------------------------------

function ImagesCard({
  overview,
  actions,
}: {
  overview: ReturnType<typeof vulnOverview>;
  actions: OverviewActions;
}) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const rows = overview.images;
  const shown = expanded ? rows : rows.slice(0, TOP);
  return (
    <Card
      title={i18n.t('Most vulnerable images')}
      icon={<Images />}
      actions={
        <span className="text-fg-dim text-[11px] tabular-nums">
          {i18n.plural('{count} image', '{count} images', rows.length)}
        </span>
      }
    >
      {!rows.length ? (
        <Empty>{i18n.t('No vulnerability reports yet.')}</Empty>
      ) : (
        <>
          <ListHeader label={i18n.t('Image')} trailing={<CountHeaders />} />
          <ul className="divide-border/40 divide-y">
            {shown.map((r) => (
              <li key={r.key}>
                <button
                  type="button"
                  onClick={() => actions.openReport(r.report)}
                  className="hover:bg-fg/4 flex w-full items-center gap-3 px-4 py-1.5 text-left transition-colors"
                  title={r.image.digest || r.image.text}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-fg block truncate font-mono text-[11.5px]">
                      {r.image.text || r.report.metadata.name}
                    </span>
                    <span className="text-fg-dim block truncate text-[10.5px]">
                      {i18n.plural('{count} workload', '{count} workloads', r.workloads.length)}
                      {r.image.digest && <> · {r.image.digest.slice(0, 19)}</>}
                    </span>
                  </span>
                  <CountCells counts={r.counts} />
                </button>
              </li>
            ))}
          </ul>
          <ShowAll
            total={rows.length}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Card>
  );
}

function WorkloadsCard({
  overview,
  actions,
}: {
  overview: ReturnType<typeof vulnOverview>;
  actions: OverviewActions;
}) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const rows = overview.workloads;
  const shown = expanded ? rows : rows.slice(0, TOP);
  return (
    <Card
      title={i18n.t('Workloads by risk')}
      icon={<Workflow />}
      actions={
        <span className="text-fg-dim text-[11px] tabular-nums">
          {i18n.plural('{count} workload', '{count} workloads', rows.length)}
        </span>
      }
    >
      {!rows.length ? (
        <Empty>{i18n.t('No vulnerability reports yet.')}</Empty>
      ) : (
        <>
          <ListHeader label={i18n.t('Workload')} trailing={<CountHeaders />} />
          <ul className="divide-border/40 divide-y">
            {shown.map((r) => (
              <li key={r.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => r.reports[0] && actions.openReport(r.reports[0])}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && r.reports[0] && actions.openReport(r.reports[0])
                  }
                  className="hover:bg-fg/4 flex w-full cursor-default items-center gap-3 px-4 py-1.5 transition-colors"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                      <span className="text-fg-dim shrink-0 text-[10.5px]">{r.workload.kind}</span>
                      <WorkloadButton workload={r.workload} actions={actions} />
                    </span>
                    <span
                      className="text-fg-dim block truncate text-[10.5px]"
                      title={r.images.join('\n')}
                    >
                      {i18n.plural('{count} container', '{count} containers', r.containers.length)}
                      {r.images[0] && <> · {r.images[0]}</>}
                    </span>
                  </span>
                  <CountCells counts={r.counts} />
                </div>
              </li>
            ))}
          </ul>
          <ShowAll
            total={rows.length}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Failed checks
// ---------------------------------------------------------------------------

type CheckSource = 'workloads' | 'rbac' | 'infra';

function sourceLabel(s: CheckSource): string {
  switch (s) {
    case 'workloads':
      return i18n.t('Workload configuration');
    case 'rbac':
      return i18n.t('RBAC');
    default:
      return i18n.t('Infrastructure');
  }
}

function CheckGroupView({ group, actions }: { group: CheckGroup; actions: OverviewActions }) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
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
        <SeverityText severity={group.severity} className="w-[72px] shrink-0 text-[11px]" />
        <span
          className="text-fg-dim hidden w-16 shrink-0 font-mono text-[11px] @md:inline"
          lang="en"
        >
          {group.id}
        </span>
        <span className="text-fg min-w-0 flex-1 truncate text-[12px]" title={group.title}>
          {group.title}
        </span>
        <span className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {group.objects.length}
        </span>
      </button>
      {open && (
        <div className="pb-2">
          {(group.remediation || group.description) && (
            <p className="text-fg-dim flex items-start gap-1.5 pr-4 pb-1.5 pl-10 text-[11.5px] leading-relaxed">
              <Lightbulb className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{group.remediation || group.description}</span>
            </p>
          )}
          <ul>
            {group.objects.slice(0, 50).map((o) => (
              <li key={o.report.metadata.uid}>
                <button
                  type="button"
                  onClick={() => actions.openReport(o.report)}
                  className="hover:bg-fg/4 group flex w-full items-start gap-3 py-1 pr-4 pl-10 text-left"
                >
                  <span className="text-fg-dim w-24 shrink-0 truncate pt-px text-[11px]">
                    {o.target.kind}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-fg group-hover:text-accent block truncate text-[12px]">
                      {o.target.namespace && (
                        <span className="text-fg-dim">{o.target.namespace}/</span>
                      )}
                      {o.target.name}
                    </span>
                    {o.messages[0] && (
                      <span
                        className="text-fg-dim block truncate text-[11px]"
                        title={o.messages.join('\n')}
                      >
                        {o.messages[0]}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {group.objects.length > 50 && (
            <p className="text-fg-dim pl-10 text-[11px]">
              {i18n.plural(
                '{count} more object',
                '{count} more objects',
                group.objects.length - 50,
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ChecksCard({ data, actions }: { data: TrivyData; actions: OverviewActions }) {
  i18n.useLocale();
  const [source, setSource] = useState<CheckSource>('workloads');
  const [expanded, setExpanded] = useState(false);
  const bySource = useMemo(
    () => ({
      workloads: checkGroups([
        ...data.items.ConfigAuditReport,
        ...data.items.ClusterConfigAuditReport,
      ]),
      rbac: checkGroups([
        ...data.items.RbacAssessmentReport,
        ...data.items.ClusterRbacAssessmentReport,
      ]),
      infra: checkGroups([
        ...data.items.InfraAssessmentReport,
        ...data.items.ClusterInfraAssessmentReport,
      ]),
    }),
    [data.items],
  );
  const groups = bySource[source];
  const shown = expanded ? groups : groups.slice(0, TOP);
  return (
    <Card
      title={i18n.t('Failed checks')}
      icon={<ClipboardCheck />}
      actions={
        <div className="flex items-center gap-0.5" role="radiogroup" aria-label={i18n.t('Source')}>
          {(['workloads', 'rbac', 'infra'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={source === s}
              onClick={() => {
                setSource(s);
                setExpanded(false);
              }}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] transition',
                source === s
                  ? 'bg-fg/7 text-fg font-medium'
                  : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
              )}
            >
              <span className="hidden @xl:inline">{sourceLabel(s)}</span>
              <span className="@xl:hidden">
                {s === 'workloads' ? i18n.t('Workloads') : sourceLabel(s)}
              </span>
              <span className="text-fg-dim tabular-nums">{bySource[s].length}</span>
            </button>
          ))}
        </div>
      }
    >
      {!groups.length ? (
        <Empty>{i18n.t('No failed checks.')}</Empty>
      ) : (
        <>
          {shown.map((g) => (
            <CheckGroupView key={g.id} group={g} actions={actions} />
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
// Exposed secrets
// ---------------------------------------------------------------------------

function SecretsCard({
  reports,
  actions,
}: {
  reports: readonly KubeObject[];
  actions: OverviewActions;
}) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => secretRows(reports), [reports]);
  const shown = expanded ? rows : rows.slice(0, TOP);
  return (
    <Card
      title={i18n.t('Exposed secrets')}
      icon={<FileKey2 />}
      actions={
        <span className="text-fg-dim text-[11px] tabular-nums">
          {i18n.plural('{count} secret', '{count} secrets', rows.length)}
        </span>
      }
    >
      <p className="text-fg-dim border-border/40 border-b px-4 py-1.5 text-[11px]">
        {i18n.t('Only where a secret was found is shown; secret values are never displayed.')}
      </p>
      {!rows.length ? (
        <Empty>{i18n.t('No secrets found in scanned images.')}</Empty>
      ) : (
        <>
          <ul className="divide-border/40 divide-y">
            {shown.map((r) => (
              <li key={r.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => actions.openReport(r.report)}
                  onKeyDown={(e) => e.key === 'Enter' && actions.openReport(r.report)}
                  className="hover:bg-fg/4 flex cursor-default flex-col gap-0.5 px-4 py-1.5 text-[12px] transition-colors @2xl:flex-row @2xl:items-center @2xl:gap-3"
                >
                  <span className="flex min-w-0 items-center gap-2 @2xl:w-72 @2xl:shrink-0">
                    <SeverityText severity={r.severity} className="w-[72px] shrink-0 text-[11px]" />
                    <span className="text-fg truncate" title={r.ruleId}>
                      {r.title || r.ruleId}
                    </span>
                  </span>
                  <span
                    className="text-fg-muted min-w-0 flex-1 truncate font-mono text-[11px]"
                    title={r.target}
                  >
                    {r.target}
                  </span>
                  <span className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] @2xl:w-64 @2xl:shrink-0">
                    <WorkloadButton workload={r.workload} actions={actions} />
                    {r.container && (
                      <span className="text-fg-dim truncate text-[10.5px]">{r.container}</span>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <ShowAll
            total={rows.length}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

function ComplianceCard({
  reports,
  actions,
}: {
  reports: readonly KubeObject[];
  actions: OverviewActions;
}) {
  i18n.useLocale();
  const rows = useMemo(() => complianceRows(reports), [reports]);
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return null;
  return (
    <Card title={i18n.t('Compliance')} icon={<BadgeCheck />}>
      <ul className="divide-border/40 divide-y">
        {rows.map((r) => {
          const total = r.pass + r.fail;
          const failing = r.controls
            .filter((c) => (c.failed ?? 0) > 0)
            .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
          const expanded = open === r.report.metadata.uid;
          return (
            <li key={r.report.metadata.uid}>
              <div className="flex items-center gap-3 px-4 py-2">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : r.report.metadata.uid)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <ChevronRight
                    className={cn(
                      'text-fg-dim h-3.5 w-3.5 shrink-0 transition-transform',
                      expanded && 'rotate-90',
                    )}
                  />
                  <span className="min-w-0">
                    <span className="text-fg block truncate text-[12px] font-medium">
                      {r.title}
                    </span>
                    <span className="text-fg-dim block truncate text-[10.5px]">
                      {[r.id, r.version && `v${r.version}`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
                <span className="hidden w-32 shrink-0 @lg:block">
                  <span className="bg-fg/8 flex h-1.5 overflow-hidden rounded-full" aria-hidden>
                    {total > 0 && (
                      <>
                        <span
                          className="bg-status-running"
                          style={{ width: `${(r.pass / total) * 100}%` }}
                        />
                        <span
                          className="bg-status-error"
                          style={{ width: `${(r.fail / total) * 100}%` }}
                        />
                      </>
                    )}
                  </span>
                </span>
                <span className="text-fg-muted shrink-0 text-[11px] tabular-nums">
                  <span className="text-status-running">
                    {i18n.t('{count} pass', { count: r.pass })}
                  </span>
                  {' · '}
                  <span className={r.fail ? 'text-status-error' : undefined}>
                    {i18n.t('{count} fail', { count: r.fail })}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => actions.openReport(r.report)}
                  className="text-accent shrink-0 text-[11px] hover:underline"
                >
                  {i18n.t('Details')}
                </button>
              </div>
              {expanded && (
                <ul className="pb-2">
                  {!failing.length ? (
                    <li className="text-fg-dim pl-10 text-[11.5px]">
                      {i18n.t('Every control passes.')}
                    </li>
                  ) : (
                    failing.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-center gap-3 py-0.5 pr-4 pl-10 text-[11.5px]"
                      >
                        <span className="text-fg-dim w-14 shrink-0 font-mono text-[11px]" lang="en">
                          {c.id}
                        </span>
                        <span className="text-fg min-w-0 flex-1 truncate" title={c.name}>
                          {c.name}
                        </span>
                        <SeverityText
                          severity={c.severity}
                          className="hidden w-[72px] shrink-0 text-[11px] @md:inline-flex"
                        />
                        <span className="text-status-error w-10 shrink-0 text-right tabular-nums">
                          {c.failed}
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function TrivyOverview({
  data,
  query,
  fixableOnly,
  actions,
}: {
  data: TrivyData;
  query: string;
  fixableOnly: boolean;
  actions: OverviewActions;
}) {
  i18n.useLocale();
  const vulnReports = useMemo(
    () => [...data.items.VulnerabilityReport, ...data.items.ClusterVulnerabilityReport],
    [data.items],
  );
  const overview = useMemo(
    () => vulnOverview(vulnReports, fixableOnly),
    [vulnReports, fixableOnly],
  );
  const fixable = useMemo(
    () => (fixableOnly ? overview : vulnOverview(vulnReports, true)),
    [vulnReports, fixableOnly, overview],
  );
  const perSeverity = (c: typeof overview.totals) =>
    Object.fromEntries(SEVERITIES.map((s) => [s, countOf(c, s)])) as Record<Severity, number>;
  const loading = !data.synced && !vulnReports.length;

  return (
    <div className="space-y-4">
      <SeverityTiles
        totals={perSeverity(overview.totals)}
        fixable={perSeverity(fixable.totals)}
        fixableOnly={fixableOnly}
        loading={loading}
      />
      {!loading && overview.images.length > 0 && (
        <div className="flex items-center gap-3 text-[11px]">
          <Bug className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <span className="text-fg-dim shrink-0">
            {i18n.t('Across {images} images in {workloads} workloads', {
              images: overview.images.length,
              workloads: overview.workloads.length,
            })}
          </span>
          <SeverityBar counts={overview.totals} className="flex-1" />
        </div>
      )}
      {loading && (
        <div className="text-fg-muted flex items-center justify-center gap-2 py-6 text-[12px]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {i18n.t('Reading Trivy reports…')}
        </div>
      )}
      {query.trim() && (
        <CveSearchCard
          reports={vulnReports}
          query={query}
          fixableOnly={fixableOnly}
          actions={actions}
        />
      )}
      <div className="grid gap-4 @4xl:grid-cols-2">
        <ImagesCard overview={overview} actions={actions} />
        <WorkloadsCard overview={overview} actions={actions} />
      </div>
      <ChecksCard data={data} actions={actions} />
      <SecretsCard reports={data.items.ExposedSecretReport} actions={actions} />
      <ComplianceCard reports={data.items.ClusterComplianceReport} actions={actions} />
    </div>
  );
}
