import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  Globe,
  Library,
  Package,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { Tabs } from '@/components/ui/Tabs';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { HelmChartSummary, HelmHubChart, HelmRepo } from '@/types';
import { usePolled } from '../data/polled';
import { TableSkeleton } from '../table/TableStates';
import { errorText } from '../util';
import { ChartAvatar, ChartsState, HelmMissing, useHelmMissing } from './ChartBits';
import {
  CHART_KEYS,
  hubChartName,
  isHelmMissingError,
  useChartsUi,
  type ChartSource,
} from './charts';
import { HelmChartDetails, HubChartDetails } from './HelmChartDetails';
import { HelmDeployDialog } from './HelmDeployDialog';
import { HelmReposDialog, refreshCharts } from './HelmReposDialog';

const ROW = 48;
const TEMPLATE = '28px minmax(220px,3fr) minmax(110px,1fr) 104px 110px';
const HUB_PREFIX = 'hub:';

/** Browse the charts of the configured repositories and Artifact Hub; install into this cluster. */
export function HelmChartsPage({
  clusterId,
  namespaces,
  isActive,
}: {
  clusterId: string;
  namespaces: string[];
  isActive: boolean;
}) {
  i18n.useLocale();
  const missing = useHelmMissing();
  const { source, repo, query, hubQuery, set } = useChartsUi();
  const repos = usePolled(
    missing ? null : CHART_KEYS.repos,
    () => ipc.helmRepoList(),
    null,
    isActive,
  );
  const catalog = usePolled(
    missing ? null : CHART_KEYS.catalog,
    () => ipc.helmChartSearch('', { versions: false, devel: false }),
    null,
    isActive,
  );
  const hub = usePolled(
    !missing && source === 'hub' && hubQuery ? CHART_KEYS.hub(hubQuery) : null,
    () => ipc.helmHubSearch(hubQuery),
    null,
    isActive,
  );
  const selected = useWorkbenchStore(
    (s) => s.selection[clusterId]?.[VIEW.helmCharts]?.name ?? null,
  );
  const [reposDialog, setReposDialog] = useState<{ initial: HelmRepo | null } | null>(null);
  const [install, setInstall] = useState<{ chartRef: string; version: string | null } | null>(null);
  const [updating, setUpdating] = useState(false);

  const select = useCallback(
    (name: string | null) =>
      useWorkbenchStore
        .getState()
        .select(
          clusterId,
          VIEW.helmCharts,
          name ? { key: VIEW.helmCharts, namespace: null, name } : null,
        ),
    [clusterId],
  );

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const charts = useMemo(
    () =>
      (catalog.data ?? [])
        .filter((c) => !repo || c.repo === repo)
        .filter((c) => {
          const text = `${c.name} ${c.description}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
        .sort(
          (a, b) =>
            Number(a.deprecated) - Number(b.deprecated) ||
            a.chart.localeCompare(b.chart) ||
            a.repo.localeCompare(b.repo),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog.data, repo, query],
  );
  const hubRows = hub.data ?? [];
  const selectedChart = selected && !selected.startsWith(HUB_PREFIX) ? selected : null;
  const selectedHub = selected?.startsWith(HUB_PREFIX)
    ? hubRows.find((h) => h.url === selected.slice(HUB_PREFIX.length))
    : undefined;
  const helmError = [repos.error, catalog.error, hub.error].find(isHelmMissingError);

  const updateRepos = async () => {
    setUpdating(true);
    try {
      const results = await ipc.helmRepoUpdate([]);
      const failed = results.filter((r) => !r.ok);
      useAppStore
        .getState()
        .pushToast(
          failed.length ? 'error' : 'success',
          failed.length
            ? i18n.t('Could not update {names}', { names: failed.map((r) => r.name).join(', ') })
            : i18n.t('Repositories are up to date'),
        );
    } catch (e) {
      useAppStore.getState().pushToast('error', errorText(e));
    } finally {
      setUpdating(false);
      refreshCharts();
    }
  };

  const count = source === 'hub' ? hubRows.length : charts.length;
  const repoOptions = useMemo(
    () => [
      { value: '', label: i18n.t('All repositories') },
      ...(repos.data ?? []).map((r) => ({ value: r.name, label: r.name, description: r.url })),
    ],
    [repos.data],
  );

  let body: React.ReactNode;
  if (missing || helmError) body = <HelmMissing onRetry={() => refreshCharts()} />;
  else if (source === 'hub') {
    body = !hubQuery ? (
      <ChartsState
        icon={<Globe />}
        tone="bg-accent/10 text-accent"
        title={i18n.t('Search Artifact Hub')}
        message={i18n.t(
          'Find charts from every public repository. Searching runs helm search hub, which queries artifacthub.io.',
        )}
      />
    ) : hub.error && !hub.data ? (
      <ChartsState
        icon={<TriangleAlert />}
        tone="bg-status-error/12 text-status-error"
        title={i18n.t('Artifact Hub search failed')}
        message={hub.error}
      >
        <Button size="sm" variant="secondary" onClick={() => void hub.refresh()}>
          {i18n.t('Retry')}
        </Button>
      </ChartsState>
    ) : !hub.data ? (
      <TableSkeleton rows={8} />
    ) : !hubRows.length ? (
      <ChartsState
        icon={<SearchX />}
        title={i18n.t('No charts found')}
        message={i18n.t('Artifact Hub has no charts matching "{query}".', { query: hubQuery })}
      />
    ) : (
      <ChartList
        label={i18n.t('Artifact Hub results')}
        rows={hubRows}
        rowKey={(h) => h.url}
        selected={selectedHub?.url ?? null}
        onOpen={(h) => select(`${HUB_PREFIX}${h.url}`)}
        render={(h) => <HubRow chart={h} repos={repos.data ?? []} />}
      />
    );
  } else if ((repos.error && !repos.data) || (catalog.error && !catalog.data)) {
    body = (
      <ChartsState
        icon={<TriangleAlert />}
        tone="bg-status-error/12 text-status-error"
        title={i18n.t('Could not load charts')}
        message={catalog.error ?? repos.error ?? ''}
      >
        <Button size="sm" variant="secondary" onClick={() => refreshCharts()}>
          {i18n.t('Retry')}
        </Button>
      </ChartsState>
    );
  } else if (!repos.data || !catalog.data) body = <TableSkeleton rows={8} />;
  else if (!repos.data.length)
    body = (
      <ChartsState
        icon={<Library />}
        title={i18n.t('No chart repositories yet')}
        message={i18n.t(
          'Add a Helm repository to browse and install its charts, or search Artifact Hub for charts from any public repository.',
        )}
      >
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setReposDialog({ initial: null })}
        >
          {i18n.t('Add repository')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => set({ source: 'hub' })}>
          {i18n.t('Search Artifact Hub')}
        </Button>
      </ChartsState>
    );
  else if (!charts.length)
    body = (
      <ChartsState
        icon={<SearchX />}
        title={i18n.t('No matches')}
        message={
          query
            ? i18n.t('No charts match "{query}".', { query })
            : i18n.t('This repository has no charts. Try updating the repositories.')
        }
      >
        {query ? (
          <Button size="sm" variant="secondary" onClick={() => set({ query: '' })}>
            {i18n.t('Clear filter')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => set({ source: 'hub', hubQuery: query })}
          >
            {i18n.t('Search Artifact Hub')}
          </Button>
        )}
      </ChartsState>
    );
  else
    body = (
      <ChartList
        label={i18n.t('Helm Charts')}
        rows={charts}
        rowKey={(c) => c.name}
        selected={selectedChart}
        onOpen={(c) => select(c.name)}
        render={(c) => <ChartRow chart={c} />}
      />
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 @container flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2">
          <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
            <Package className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-fg hidden shrink-0 text-[13px] font-semibold @lg:block">
            {i18n.t('Helm Charts')}
          </h2>
          <span className="bg-surface-muted text-fg-dim hidden shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums @lg:inline">
            {count}
          </span>
          <Tabs<ChartSource>
            className="ml-1 shrink-0"
            value={source}
            onChange={(next) => set({ source: next })}
            tabs={[
              { key: 'repos', label: i18n.t('Repositories') },
              { key: 'hub', label: i18n.t('Artifact Hub') },
            ]}
          />
          <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1.5">
            {source === 'repos' && (repos.data?.length ?? 0) > 1 && (
              <span className="hidden min-w-0 shrink @3xl:block">
                <Select
                  ariaLabel={i18n.t('Repository')}
                  value={repo}
                  onChange={(v) => set({ repo: v })}
                  options={repoOptions}
                  className="max-w-[170px]"
                />
              </span>
            )}
            <SearchBox source={source} />
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Library className="h-3.5 w-3.5" />}
              disabled={missing}
              onClick={() => setReposDialog({ initial: null })}
              title={i18n.t('Manage repositories')}
              aria-label={i18n.t('Manage repositories')}
              className="shrink-0 gap-0 @5xl:gap-1.5"
            >
              <span className="hidden @5xl:inline">{i18n.t('Manage repositories')}</span>
            </Button>
            {source === 'repos' ? (
              <IconButton
                label={
                  updating
                    ? i18n.t('Updating repositories…')
                    : i18n.t('Update repositories (helm repo update)')
                }
                icon={<RefreshCw className={cn(updating && 'animate-spin')} />}
                disabled={missing || updating || !repos.data?.length}
                onClick={() => void updateRepos()}
              />
            ) : (
              <IconButton
                label={i18n.t('Search again')}
                icon={<RefreshCw className={cn(hub.loading && 'animate-spin')} />}
                disabled={missing || !hubQuery || hub.loading}
                onClick={() => void hub.refresh()}
              />
            )}
          </div>
        </div>
        {source === 'hub' && !missing && (
          <p className="border-border/50 text-fg-dim flex h-8 shrink-0 items-center gap-1.5 border-b px-4 text-[11px]">
            <Globe className="h-3 w-3 shrink-0" />
            {i18n.t('Results come from artifacthub.io (helm search hub). Press Enter to search.')}
          </p>
        )}
        {body}
      </div>
      {selectedChart && !missing && (
        <HelmChartDetails
          key={selectedChart}
          chartRef={selectedChart}
          latest={catalog.data?.find((c) => c.name === selectedChart)?.version ?? null}
          isActive={isActive}
          onClose={() => select(null)}
          onInstall={(version) => setInstall({ chartRef: selectedChart, version })}
        />
      )}
      {selectedHub && !missing && (
        <HubChartDetails
          key={selectedHub.url}
          chart={selectedHub}
          repos={repos.data ?? []}
          isActive={isActive}
          onClose={() => select(null)}
          onAddRepo={(initial) => setReposDialog({ initial })}
          onOpenChart={(ref) => {
            set({ source: 'repos', repo: '' });
            select(ref);
          }}
        />
      )}
      {reposDialog && (
        <HelmReposDialog initial={reposDialog.initial} onClose={() => setReposDialog(null)} />
      )}
      {install && (
        <HelmDeployDialog
          clusterId={clusterId}
          target={{ mode: 'install', chartRef: install.chartRef, version: install.version }}
          namespaceHint={namespaces.length === 1 ? namespaces[0]! : null}
          onClose={() => setInstall(null)}
        />
      )}
    </div>
  );
}

function SearchBox({ source }: { source: ChartSource }) {
  i18n.useLocale();
  const { query, set } = useChartsUi();
  const hub = source === 'hub';
  const [draft, setDraft] = useState(() => (hub ? useChartsUi.getState().hubQuery : query));
  useEffect(() => {
    setDraft(hub ? useChartsUi.getState().hubQuery : useChartsUi.getState().query);
  }, [hub]);
  const value = hub ? draft : query;
  const change = (v: string) => (hub ? setDraft(v) : set({ query: v }));
  const clear = () => (hub ? setDraft('') : set({ query: '' }));
  return (
    <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-56 min-w-24 shrink items-center gap-2 rounded-lg border px-2.5 transition-colors">
      <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
      <input
        value={value}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hub && draft.trim()) set({ hubQuery: draft.trim() });
          if (e.key === 'Escape') clear();
        }}
        placeholder={hub ? i18n.t('Search Artifact Hub…') : i18n.t('Filter charts…')}
        aria-label={hub ? i18n.t('Search Artifact Hub') : i18n.t('Filter charts')}
        className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={clear}
          aria-label={i18n.t('Clear filter')}
          className="text-fg-dim hover:text-fg"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Windowed list with a sticky header (catalogs can hold thousands of charts). */
function ChartList<T>({
  label,
  rows,
  rowKey,
  selected,
  onOpen,
  render,
}: {
  label: string;
  rows: T[];
  rowKey: (row: T) => string;
  selected: string | null;
  onOpen: (row: T) => void;
  render: (row: T) => React.ReactNode;
}) {
  i18n.useLocale();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(view.top / ROW) - 8);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + 8);
  return (
    <div
      ref={scroller}
      role="table"
      aria-label={label}
      aria-rowcount={rows.length}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setView((v) => ({ ...v, top }));
      }}
      className="min-h-0 flex-1 overflow-auto"
    >
      <div
        role="row"
        style={{ gridTemplateColumns: TEMPLATE }}
        className="border-border/70 text-fg-dim bg-surface/95 sticky top-0 z-10 grid h-8 min-w-[640px] items-center gap-x-3 border-b px-3 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
      >
        <span role="columnheader" aria-label={i18n.t('Icon')} />
        <span role="columnheader">{i18n.t('Name')}</span>
        <span role="columnheader">{i18n.t('Repository')}</span>
        <span role="columnheader">{i18n.t('Version')}</span>
        <span role="columnheader">{i18n.t('App version')}</span>
      </div>
      <div style={{ height: rows.length * ROW }} className="relative min-w-[640px]">
        {rows.slice(first, last).map((row, i) => {
          const key = rowKey(row);
          const active = key === selected;
          return (
            <div
              key={key}
              role="row"
              aria-selected={active}
              onClick={() => onOpen(row)}
              style={{ gridTemplateColumns: TEMPLATE, top: (first + i) * ROW, height: ROW }}
              className={cn(
                'border-border/40 absolute inset-x-0 grid cursor-default items-center gap-x-3 border-b px-3 text-[12px] transition-colors',
                active ? 'bg-fg/7 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
              )}
            >
              {render(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChartRow({ chart }: { chart: HelmChartSummary }) {
  i18n.useLocale();
  return (
    <>
      <span role="cell">
        <ChartAvatar name={chart.chart} />
      </span>
      <span role="cell" className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn('truncate font-medium', chart.deprecated ? 'text-fg-muted' : 'text-fg')}
          >
            {chart.chart}
          </span>
          {chart.deprecated && (
            <Badge tone="warning" size="xs">
              {i18n.t('Deprecated')}
            </Badge>
          )}
        </span>
        <span className="text-fg-dim block truncate text-[11px]" title={chart.description}>
          {chart.description.replace(/^DEPRECATED[:!\s-]*/i, '') || '—'}
        </span>
      </span>
      <span role="cell" className="text-fg-muted truncate">
        {chart.repo}
      </span>
      <span role="cell" className="text-fg-muted truncate font-mono text-[11px]">
        {chart.version}
      </span>
      <span role="cell" className="text-fg-muted truncate font-mono text-[11px]">
        {chart.app_version ?? '—'}
      </span>
    </>
  );
}

function HubRow({ chart, repos }: { chart: HelmHubChart; repos: HelmRepo[] }) {
  i18n.useLocale();
  const name = hubChartName(chart.url);
  const configured = repos.some(
    (r) => r.url.replace(/\/+$/, '') === chart.repository_url.replace(/\/+$/, ''),
  );
  return (
    <>
      <span role="cell">
        <ChartAvatar name={name} />
      </span>
      <span role="cell" className="min-w-0">
        <span className="text-fg block truncate font-medium">{name}</span>
        <span className="text-fg-dim block truncate text-[11px]" title={chart.description}>
          {chart.description || '—'}
        </span>
      </span>
      <span
        role="cell"
        className="text-fg-muted flex min-w-0 items-center gap-1"
        title={chart.repository_url}
      >
        <span className="truncate">{chart.repository_name}</span>
        {configured && (
          <CircleCheck
            className="text-status-running h-3 w-3 shrink-0"
            aria-label={i18n.t('Repository is configured')}
          />
        )}
      </span>
      <span role="cell" className="text-fg-muted truncate font-mono text-[11px]">
        {chart.version}
      </span>
      <span role="cell" className="text-fg-muted truncate font-mono text-[11px]">
        {chart.app_version ?? '—'}
      </span>
    </>
  );
}
