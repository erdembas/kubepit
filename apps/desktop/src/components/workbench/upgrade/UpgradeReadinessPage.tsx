import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useEffect, useState } from 'react';
import {
  CircleArrowUp,
  CircleCheck,
  Loader2,
  Package,
  RefreshCw,
  Search,
  ShieldAlert,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select, type SelectOption } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { DEPRECATIONS_UPDATED, minorOf, sourceLabel, targetOptions } from '@/lib/kube/deprecations';
import {
  UPGRADE_SOURCES,
  countFindings,
  filterFindings,
  groupFindings,
  type Filter,
} from '@/lib/kube/upgrade';
import { useAppStore } from '@/store/useAppStore';
import { useUpgradeEntry, useUpgradeStore } from '@/store/useUpgradeStore';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, UpgradeSeverity, UpgradeSource } from '@/types';
import { Card, StatTile } from '../overview/charts';
import { useNow } from '../util';
import { UpgradeGroupSection } from './UpgradeGroupSection';
import { SEVERITY_FILL, SEVERITY_ICON, SEVERITY_TEXT, severityLabel } from './severity';

const DEFAULT_TARGET = '__next__';

/**
 * "Upgrade readiness": deprecated and removed API versions this cluster
 * still uses, for an upgrade to a target Kubernetes version (default: the
 * next minor). Findings come from `upgrade_readiness_scan` and are grouped
 * by apiVersion + kind; rows open the object or the Helm release.
 */
export function UpgradeReadinessPage({
  clusterId,
  isActive,
  apiResources,
}: {
  clusterId: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const version = useAppStore((s) => s.statuses[clusterId]?.version ?? null);
  const target = useUpgradeStore((s) => s.targets[clusterId] ?? null);
  const entry = useUpgradeEntry(clusterId, target);
  const report = entry?.report ?? null;
  const now = useNow(30_000, isActive);
  const query = useWorkbenchStore((s) => s.filters[`${clusterId}|${VIEW.upgradeReadiness}`] ?? '');
  const setQuery = (text: string) =>
    useWorkbenchStore.getState().setFilter(clusterId, VIEW.upgradeReadiness, text);
  const [severity, setSeverity] = useState<Filter<UpgradeSeverity>>('all');
  const [source, setSource] = useState<Filter<UpgradeSource>>('all');

  const scan = () => void useUpgradeStore.getState().scan(clusterId, target);
  // First visit (per target): scan once; later visits show the last report.
  useEffect(() => {
    if (isActive && !entry && version) void useUpgradeStore.getState().scan(clusterId, target);
  }, [isActive, entry, version, clusterId, target]);

  const findings = report?.findings ?? [];
  const counts = useMemo(() => countFindings(findings), [findings]);
  const visible = useMemo(
    () => filterFindings(findings, { severity, source, query }),
    [findings, severity, source, query],
  );
  const groups = useMemo(() => groupFindings(visible), [visible]);
  const filtered = severity !== 'all' || source !== 'all' || !!query.trim();

  const current = report?.server_version ?? minorOf(version);
  const targetValue = target ?? DEFAULT_TARGET;
  const options = useMemo<SelectOption[]>(() => {
    const next = targetOptions(version);
    const list: SelectOption[] = next.map((v, i) => ({
      value: i === 0 ? DEFAULT_TARGET : v,
      label:
        i === 0
          ? i18n.t('Kubernetes {version} (next)', { version: v })
          : i18n.t('Kubernetes {version}', { version: v }),
    }));
    if (target && !next.includes(target))
      list.push({ value: target, label: i18n.t('Kubernetes {version}', { version: target }) });
    return list;
  }, [version, target]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
          <CircleArrowUp className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg shrink-0 text-[13px] font-semibold">
          {i18n.t('Upgrade readiness')}
        </h2>
        {entry?.scanning && (
          <Loader2 className="text-fg-dim h-3 w-3 animate-spin" aria-label={i18n.t('Scanning')} />
        )}
        <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1.5">
          {options.length > 0 && (
            <Select
              value={targetValue}
              onChange={(v) =>
                useUpgradeStore.getState().setTarget(clusterId, v === DEFAULT_TARGET ? null : v)
              }
              options={options}
              ariaLabel={i18n.t('Target version')}
              className="shrink-0"
            />
          )}
          <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-52 min-w-20 shrink items-center gap-2 rounded-lg border px-2.5 transition-colors">
            <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              placeholder={i18n.t('Filter findings…')}
              aria-label={i18n.t('Filter findings')}
              className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={i18n.t('Clear filter')}
                className="text-fg-dim hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <IconButton
            label={i18n.t('Rescan')}
            icon={<RefreshCw />}
            onClick={scan}
            disabled={!!entry?.scanning}
          />
        </div>
      </div>
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
        <div className="@container mx-auto max-w-6xl space-y-4 p-5">
          {entry?.error && (
            <div className="border-status-error/30 bg-status-error/[0.06] rounded-app flex items-start gap-2.5 border px-4 py-3 text-[12px]">
              <TriangleAlert className="text-status-error mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-status-error font-semibold">{i18n.t('The scan failed')}</p>
                <p className="text-status-error/90 mt-1 font-mono text-[11px] break-words">
                  {entry.error}
                </p>
              </div>
              <Button size="xs" variant="secondary" onClick={scan}>
                {i18n.t('Try again')}
              </Button>
            </div>
          )}
          {report && report.skipped.length > 0 && (
            <div className="border-status-starting/30 bg-status-starting/8 text-fg-muted rounded-app flex items-start gap-2.5 border px-4 py-2.5 text-[12px]">
              <ShieldAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span title={report.skipped.map((s) => `${s.what}: ${s.reason}`).join('\n')}>
                {i18n.t('Some sources could not be read and were skipped: {what}', {
                  what: report.skipped.map((s) => s.what).join(', '),
                })}
              </span>
            </div>
          )}
          <div className="grid gap-3 @4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,1.2fr)]">
            <Card title={i18n.t('Target')} icon={<CircleArrowUp />}>
              <div className="px-4 py-3">
                <p className="text-fg text-[22px] leading-none font-semibold tracking-tight tabular-nums">
                  {current ?? '—'}
                  <span className="text-fg-dim mx-2 font-normal">→</span>
                  {report?.target_version ?? target ?? targetOptions(version, 1)[0] ?? '—'}
                </p>
                <p className="text-fg-dim mt-2 text-[11px]">
                  {report
                    ? i18n.t('Scanned {age} ago · {objects} objects, {releases} Helm releases', {
                        age: formatAge(report.scanned_at, now),
                        objects: i18n.number(report.objects_scanned),
                        releases: i18n.number(report.helm_releases_scanned),
                      })
                    : entry?.scanning
                      ? i18n.t('Scanning the cluster…')
                      : i18n.t('Not scanned yet')}
                </p>
                <p className="text-fg-dim mt-1 text-[11px]">
                  {i18n.t('Deprecation table reviewed {date}', {
                    date: report?.table_updated ?? DEPRECATIONS_UPDATED,
                  })}
                </p>
                {report?.metrics === 'unavailable' && (
                  <p
                    className="text-fg-dim mt-1 truncate text-[11px]"
                    title={report.metrics_error ?? undefined}
                  >
                    {i18n.t('API server metrics unavailable (no Prometheus).')}
                  </p>
                )}
              </div>
            </Card>
            <div className="grid grid-cols-3 gap-3">
              {(['blocker', 'warning'] as const).map((s) => {
                const Icon = SEVERITY_ICON[s];
                const n = counts[s];
                return (
                  <div key={s} className="grid min-w-0">
                    <StatTile
                      icon={<Icon className={SEVERITY_TEXT[s]} />}
                      label={severityLabel(s)}
                      value={report ? n : '—'}
                      tone={n > 0 ? SEVERITY_TEXT[s] : 'text-fg'}
                      sub={severity === s ? i18n.t('filtering') : i18n.t('findings')}
                      onClick={() => setSeverity((cur) => (cur === s ? 'all' : s))}
                    />
                  </div>
                );
              })}
              <div className="grid min-w-0">
                <StatTile
                  icon={<Package />}
                  label={i18n.t('Helm')}
                  value={report ? counts.helmReleases : '—'}
                  tone={counts.blockedReleases > 0 ? SEVERITY_TEXT.blocker : 'text-fg'}
                  sub={
                    source === 'helm-release'
                      ? i18n.t('filtering')
                      : i18n.plural(
                          '{count} release blocked',
                          '{count} releases blocked',
                          counts.blockedReleases,
                        )
                  }
                  onClick={() =>
                    setSource((cur) => (cur === 'helm-release' ? 'all' : 'helm-release'))
                  }
                />
              </div>
            </div>
            <Card title={i18n.t('Sources')}>
              <ul className="space-y-2 px-4 py-3">
                {UPGRADE_SOURCES.map((src) => {
                  const n = counts.bySource[src];
                  const max = Math.max(1, ...UPGRADE_SOURCES.map((x) => counts.bySource[x]));
                  return (
                    <li key={src}>
                      <button
                        type="button"
                        onClick={() => setSource((cur) => (cur === src ? 'all' : src))}
                        className={cn(
                          'hover:bg-fg/4 -mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-[11.5px]',
                          source === src && 'bg-fg/6',
                        )}
                      >
                        <span className="text-fg-muted w-28 shrink-0 truncate">
                          {sourceLabel(src)}
                        </span>
                        <span className="bg-fg/7 relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full">
                          <span
                            className={cn(
                              'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500',
                              SEVERITY_FILL.warning,
                            )}
                            style={{ width: `${(n / max) * 100}%` }}
                          />
                        </span>
                        <span className="text-fg w-8 shrink-0 text-right tabular-nums">{n}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select<Filter<UpgradeSeverity>>
              value={severity}
              onChange={setSeverity}
              ariaLabel={i18n.t('Severity')}
              options={[
                { value: 'all', label: i18n.t('All severities') },
                { value: 'blocker', label: severityLabel('blocker') },
                { value: 'warning', label: severityLabel('warning') },
              ]}
            />
            <Select<Filter<UpgradeSource>>
              value={source}
              onChange={setSource}
              ariaLabel={i18n.t('Source')}
              options={[
                { value: 'all', label: i18n.t('All sources') },
                ...UPGRADE_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) })),
              ]}
            />
            {filtered && (
              <button
                type="button"
                onClick={() => {
                  setSeverity('all');
                  setSource('all');
                  setQuery('');
                }}
                className="text-fg-dim hover:text-fg text-[11.5px]"
              >
                {i18n.t('Clear filters')}
              </button>
            )}
          </div>
          <Card
            title={i18n.t('Findings')}
            actions={
              report ? (
                <span className="text-fg-dim text-[11px] tabular-nums">
                  {i18n.plural('{count} API version', '{count} API versions', groups.length)}
                </span>
              ) : undefined
            }
          >
            {!report ? (
              <div className="text-fg-muted flex items-center justify-center gap-2 px-4 py-10 text-[12px]">
                {entry?.scanning || !entry ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {i18n.t('Scanning the cluster…')}
                  </>
                ) : (
                  i18n.t('No report yet.')
                )}
              </div>
            ) : !groups.length ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[12px]">
                {filtered ? (
                  <p className="text-fg-dim">{i18n.t('No findings match the filters.')}</p>
                ) : (
                  <>
                    <CircleCheck className="text-status-running h-5 w-5" />
                    <p className="text-fg">
                      {i18n.t(
                        'Nothing in this cluster uses an API that Kubernetes {version} deprecates or removes.',
                        {
                          version: report.target_version,
                        },
                      )}
                    </p>
                  </>
                )}
              </div>
            ) : (
              groups.map((g, i) => (
                <UpgradeGroupSection
                  key={g.key}
                  clusterId={clusterId}
                  group={g}
                  apiResources={apiResources}
                  defaultOpen={i < 4 || filtered}
                />
              ))
            )}
          </Card>
          {report?.truncated && (
            <p className="text-fg-dim text-[11px]">
              {i18n.t(
                'Some kinds have more objects than a scan reads; their findings may be incomplete.',
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
