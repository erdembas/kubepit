import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import {
  EyeOff,
  HeartPulse,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ToggleLeft,
  ToggleRight,
  X,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Select, type SelectOption } from '@/components/ui/Select';
import {
  CATEGORIES,
  RULES,
  SEVERITIES,
  categoryLabel,
  ruleTitle,
  severityLabel,
  type Category,
  type RuleGroup,
  type Severity,
} from '@/lib/kube/health';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { useHealthIgnores, useHealthOptIns, useHealthStore } from '@/store/useHealthStore';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';
import { useSelectedNamespaces } from '../data/hooks';
import { NamespacePicker } from '../header/NamespacePicker';
import { Card, StatTile } from '../overview/charts';
import { useNow } from '../util';
import { FindingGroup } from './FindingGroup';
import { ScoreRing } from './ScoreRing';
import { CATEGORY_FILL, SEVERITY_ICON, SEVERITY_TEXT } from './severity';
import { useHealthScan } from './useHealthScan';

type Filter<T extends string> = T | 'all';

/** Rules that stay silent until a cluster turns them on. */
const OPT_IN_RULES = RULES.filter((r) => r.optIn);

function scopeLabel(namespaces: string[]) {
  if (!namespaces.length) return i18n.t('All namespaces');
  if (namespaces.length === 1) return namespaces[0]!;
  return i18n.t('{count} namespaces', { count: namespaces.length });
}

function filterGroups(
  groups: readonly RuleGroup[],
  severity: Filter<Severity>,
  category: Filter<Category>,
  rule: string,
  query: string,
): RuleGroup[] {
  const q = query.trim().toLowerCase();
  const out: RuleGroup[] = [];
  for (const g of groups) {
    if (category !== 'all' && g.category !== category) continue;
    if (rule !== 'all' && g.ruleId !== rule) continue;
    if (severity === 'all' && !q) {
      out.push(g);
      continue;
    }
    const findings = g.findings.filter(
      (f) =>
        (severity === 'all' || f.severity === severity) &&
        (!q ||
          `${f.ref.kind} ${f.ref.namespace ?? ''}/${f.ref.name} ${f.message}`
            .toLowerCase()
            .includes(q)),
    );
    if (findings.length) out.push({ ...g, findings, total: findings.length });
  }
  return out;
}

export function HealthPage({
  clusterId,
  viewKey,
  isActive,
  apiResources,
}: {
  clusterId: string;
  viewKey: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const namespaces = useSelectedNamespaces(clusterId, viewKey);
  const health = useHealthScan(clusterId, namespaces, isActive, apiResources);
  const ignores = useHealthIgnores(clusterId);
  const optIns = useHealthOptIns(clusterId);
  const now = useNow(15_000, isActive);
  const query = useWorkbenchStore((s) => s.filters[`${clusterId}|${VIEW.clusterHealth}`] ?? '');
  const setQuery = (text: string) =>
    useWorkbenchStore.getState().setFilter(clusterId, VIEW.clusterHealth, text);
  const [severity, setSeverity] = useState<Filter<Severity>>('all');
  const [category, setCategory] = useState<Filter<Category>>('all');
  const [rule, setRule] = useState('all');
  const { summary, scan } = health;

  const groups = useMemo(
    () => (summary ? filterGroups(summary.groups, severity, category, rule, query) : []),
    [summary, severity, category, rule, query],
  );
  const ruleOptions = useMemo<SelectOption[]>(
    () => [
      { value: 'all', label: i18n.t('All rules') },
      ...(summary?.groups ?? []).map((g) => ({ value: g.ruleId, label: ruleTitle(g.ruleId) })),
    ],
    [summary],
  );
  const scanned = scan ? [...scan.scanned.values()].reduce((a, b) => a + b, 0) : 0;
  const filtered = severity !== 'all' || category !== 'all' || rule !== 'all' || !!query.trim();
  const toggleSeverity = (s: Severity) => setSeverity((cur) => (cur === s ? 'all' : s));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
          <HeartPulse className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg shrink-0 text-[13px] font-semibold">{i18n.t('Cluster health')}</h2>
        <span className="text-fg-dim hidden truncate text-[11px] lg:inline">
          {scopeLabel(namespaces)}
        </span>
        {health.scanning && (
          <Loader2 className="text-fg-dim h-3 w-3 animate-spin" aria-label={i18n.t('Scanning')} />
        )}
        <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1.5">
          <NamespacePicker clusterId={clusterId} viewKey={viewKey} isActive={isActive} />
          <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-56 min-w-24 shrink items-center gap-2 rounded-lg border px-2.5 transition-colors">
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
          <IconButton label={i18n.t('Rescan')} icon={<RefreshCw />} onClick={health.rescan} />
        </div>
      </div>
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
        <div className="@container mx-auto max-w-6xl space-y-4 p-5">
          {health.issues.length > 0 && (
            <div className="border-status-starting/30 bg-status-starting/8 text-fg-muted rounded-app flex items-start gap-2.5 border px-4 py-2.5 text-[12px]">
              <ShieldAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {i18n.t('Some checks were skipped because these lists could not be read: {kinds}', {
                  kinds: health.issues
                    .map((x) =>
                      x.forbidden ? i18n.t('{kind} (access denied)', { kind: x.title }) : x.title,
                    )
                    .join(', '),
                })}
              </span>
            </div>
          )}
          <div className="grid gap-3 @4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,1.2fr)]">
            <Card title={i18n.t('Score')} icon={<HeartPulse />}>
              <div className="flex items-center gap-4 p-4">
                <ScoreRing
                  score={summary?.score ?? null}
                  grade={summary?.grade ?? null}
                  loading={!summary}
                />
                <div className="min-w-0 text-[11.5px]">
                  {summary && scan ? (
                    <>
                      <p className="text-fg">
                        {i18n.plural('{count} object scanned', '{count} objects scanned', scanned)}
                      </p>
                      <p className="text-fg-dim mt-1">
                        {i18n.t('Updated {age} ago', { age: formatAge(scan.computedAt, now) })}
                      </p>
                      {summary.ignored > 0 && (
                        <p className="text-fg-dim mt-1">
                          {i18n.plural(
                            '{count} finding ignored',
                            '{count} findings ignored',
                            summary.ignored,
                          )}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-fg-muted">
                      {i18n.t('Reading {loaded} of {total} resource lists…', {
                        loaded: health.progress.loaded,
                        total: health.progress.total,
                      })}
                    </p>
                  )}
                </div>
              </div>
            </Card>
            <div className="grid grid-cols-3 gap-3">
              {SEVERITIES.map((s) => {
                const Icon = SEVERITY_ICON[s];
                const n = summary?.counts[s] ?? 0;
                return (
                  <div key={s} className="rounded-app grid min-w-0">
                    <StatTile
                      icon={<Icon className={SEVERITY_TEXT[s]} />}
                      label={severityLabel(s)}
                      value={summary ? n : '—'}
                      tone={n > 0 ? SEVERITY_TEXT[s] : 'text-fg'}
                      sub={severity === s ? i18n.t('filtering') : i18n.t('findings')}
                      onClick={() => toggleSeverity(s)}
                    />
                  </div>
                );
              })}
            </div>
            <Card title={i18n.t('Categories')}>
              <ul className="space-y-2 px-4 py-3">
                {CATEGORIES.map((c) => {
                  const n = summary?.categories[c] ?? 0;
                  const total = summary
                    ? Math.max(1, ...CATEGORIES.map((x) => summary.categories[x]))
                    : 1;
                  return (
                    <li key={c}>
                      <button
                        type="button"
                        onClick={() => setCategory((cur) => (cur === c ? 'all' : c))}
                        className={cn(
                          'hover:bg-fg/4 -mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-[11.5px]',
                          category === c && 'bg-fg/6',
                        )}
                      >
                        <span className="text-fg-muted w-20 shrink-0 truncate">
                          {categoryLabel(c)}
                        </span>
                        <span className="bg-fg/7 relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full">
                          <span
                            className={cn(
                              'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500',
                              CATEGORY_FILL[c],
                            )}
                            style={{ width: `${(n / total) * 100}%` }}
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
            <Select<Filter<Severity>>
              value={severity}
              onChange={setSeverity}
              ariaLabel={i18n.t('Severity')}
              options={[
                { value: 'all', label: i18n.t('All severities') },
                ...SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) })),
              ]}
            />
            <Select<Filter<Category>>
              value={category}
              onChange={setCategory}
              ariaLabel={i18n.t('Category')}
              options={[
                { value: 'all', label: i18n.t('All categories') },
                ...CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) })),
              ]}
            />
            <Select
              value={rule}
              onChange={setRule}
              ariaLabel={i18n.t('Rule')}
              options={ruleOptions}
              className="max-w-[320px]"
            />
            {filtered && (
              <button
                type="button"
                onClick={() => {
                  setSeverity('all');
                  setCategory('all');
                  setRule('all');
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
              summary ? (
                <span className="text-fg-dim text-[11px] tabular-nums">
                  {i18n.plural('{count} rule', '{count} rules', groups.length)}
                </span>
              ) : undefined
            }
          >
            {!summary ? (
              <div className="text-fg-muted flex items-center justify-center gap-2 px-4 py-10 text-[12px]">
                <Loader2 className="h-4 w-4 animate-spin" />
                {i18n.t('Scanning the cluster…')}
              </div>
            ) : !groups.length ? (
              <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
                {filtered
                  ? i18n.t('No findings match the filters.')
                  : i18n.t('No findings. Every check passes.')}
              </p>
            ) : (
              groups.map((g, i) => (
                <FindingGroup
                  key={g.ruleId}
                  clusterId={clusterId}
                  group={g}
                  apiResources={apiResources}
                  defaultOpen={i < 3 || rule !== 'all'}
                />
              ))
            )}
          </Card>
          {OPT_IN_RULES.length > 0 && (
            <Card title={i18n.t('Off by default')} icon={<ToggleLeft />}>
              <p className="text-fg-dim px-4 pt-2.5 pb-1 text-[11px] leading-relaxed">
                {i18n.t(
                  'Findings of these rules stay hidden until you turn them on for this cluster.',
                )}
              </p>
              <ul className="divide-border/60 divide-y">
                {OPT_IN_RULES.map((r) => {
                  const on = optIns.includes(r.id);
                  const Icon = on ? ToggleRight : ToggleLeft;
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2 text-[12px]">
                      <span className="text-fg min-w-0 flex-1 truncate">{r.title()}</span>
                      <span className="text-fg-dim shrink-0 text-[11px]">
                        {categoryLabel(r.category)}
                      </span>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => useHealthStore.getState().setOptIn(clusterId, r.id, !on)}
                        className="text-fg-dim hover:text-accent flex shrink-0 items-center gap-1 text-[11px]"
                      >
                        <Icon className={cn('h-3 w-3', on && 'text-accent')} />
                        {on ? i18n.t('Turn off') : i18n.t('Turn on')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          {ignores.length > 0 && (
            <Card title={i18n.t('Ignored rules')} icon={<EyeOff />}>
              <ul className="divide-border/60 divide-y">
                {ignores.map((ig) => (
                  <li
                    key={`${ig.rule}|${ig.namespace ?? ''}`}
                    className="flex items-center gap-3 px-4 py-2 text-[12px]"
                  >
                    <span className="text-fg min-w-0 flex-1 truncate">{ruleTitle(ig.rule)}</span>
                    <span className="text-fg-dim shrink-0 font-mono text-[11px]">
                      {ig.namespace ?? i18n.t('every namespace')}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        useHealthStore.getState().unignore(clusterId, ig.rule, ig.namespace)
                      }
                      className="text-fg-dim hover:text-accent flex shrink-0 items-center gap-1 text-[11px]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {i18n.t('Restore')}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
