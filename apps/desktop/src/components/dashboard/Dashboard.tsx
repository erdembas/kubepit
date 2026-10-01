import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CircleSlash,
  ClipboardCheck,
  Cpu,
  FileSearch,
  Loader2,
  MemoryStick,
  Plug,
  Plus,
  ScanSearch,
  Search,
  Server,
  Boxes,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { InvestigationsPage } from '@/components/workbench/investigations/InvestigationsPage';
import { Kbd } from '@/components/ui/Kbd';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { connectCluster } from '@/lib/clusterActions';
import { ENVIRONMENTS, isLive, connState } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { formatBytes, formatCpu, formatPercent } from '@/lib/format';
import { IS_MAC, modChord } from '@/lib/platform';
import { sectionColor } from '@/lib/sectionColors';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useAppStore } from '@/store/useAppStore';
import { openFleetSearch } from '@/store/useFleetSearchStore';
import { ClusterCard } from './ClusterCard';
import { FleetCost } from './FleetCost';
import { RecommendationsFleetCard } from './RecommendationsFleetCard';
import { HeaderAction, SectionHeader } from './SectionHeader';
import { UpgradeFleetCard } from './UpgradeFleetCard';
import {
  TONE_CLASSES,
  fleetStats,
  fleetTotals,
  groupClusters,
  heroState,
  type DashboardGroupBy,
} from './model';

const GROUP_KEY = 'kubepit.dashboard.group';
const FLEET_SEARCH_SHORTCUT = IS_MAC ? '⌘⇧F' : 'Ctrl+Shift+F';

function initialGroup(): DashboardGroupBy {
  try {
    const saved = localStorage.getItem(GROUP_KEY);
    if (saved === 'sections' || saved === 'environment' || saved === 'none') return saved;
  } catch {
    /* ignore */
  }
  return 'sections';
}

export function Dashboard({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const clusters = useVisibleStore(useAppStore, (s) => s.clusters, visible);
  const statuses = useVisibleStore(useAppStore, (s) => s.statuses, visible);
  const overviews = useVisibleStore(useAppStore, (s) => s.overviews, visible);
  const sections = useVisibleStore(useAppStore, (s) => s.sections, visible);
  const clusterSection = useVisibleStore(useAppStore, (s) => s.clusterSection, visible);
  const sectionItemOrder = useVisibleStore(useAppStore, (s) => s.sectionItemOrder, visible);
  const bootstrapped = useVisibleStore(useAppStore, (s) => s.bootstrapped, visible);
  const appVersion = useVisibleStore(useAppStore, (s) => s.appInfo?.version, visible);
  const openClusterEditor = useAppStore((s) => s.openClusterEditor);
  const setImportDialogOpen = useAppStore((s) => s.setImportDialogOpen);
  const [query, setQuery] = useState('');
  const [showInvestigations, setShowInvestigations] = useState(false);
  const [envFilter, setEnvFilter] = useState<string | null>(null);
  const [groupBy, setGroupByState] = useState<DashboardGroupBy>(initialGroup);
  const setGroupBy = (next: DashboardGroupBy) => {
    setGroupByState(next);
    try {
      localStorage.setItem(GROUP_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const stats = useMemo(() => fleetStats(clusters, statuses), [clusters, statuses]);
  const totals = useMemo(
    () => fleetTotals(clusters, statuses, overviews),
    [clusters, statuses, overviews],
  );
  const hero = heroState(stats, totals);
  const tone = TONE_CLASSES[hero.tone];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clusters.filter((c) => {
      if (envFilter && (c.environment ?? 'none') !== envFilter) return false;
      if (!q) return true;
      return `${c.name} ${c.context} ${c.tags.join(' ')} ${c.environment ?? ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [clusters, query, envFilter]);

  const groups = useMemo(
    () =>
      groupClusters(
        filtered,
        groupBy,
        sections,
        clusterSection,
        sectionItemOrder,
        (s) => sectionColor(s.color).solid,
      ),
    [filtered, groupBy, sections, clusterSection, sectionItemOrder],
  );

  if (!bootstrapped) {
    return (
      <div className="text-fg-dim flex flex-1 items-center justify-center gap-2 text-[12px]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {i18n.t('Loading workspace…')}
      </div>
    );
  }

  if (showInvestigations) {
    return (
      <div className="bg-surface flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 flex shrink-0 items-center border-b px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setShowInvestigations(false)}>
            {i18n.t('Back to fleet')}
          </Button>
        </div>
        <InvestigationsPage active={visible} />
      </div>
    );
  }

  if (clusters.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EmptyFleet
          onAdd={() => openClusterEditor({ mode: 'add' })}
          onDiscover={() => setImportDialogOpen(true)}
        />
        <div className="flex justify-center p-3">
          <Button size="sm" variant="ghost" onClick={() => setShowInvestigations(true)}>
            {i18n.t('Open saved investigations')}
          </Button>
        </div>
      </div>
    );
  }

  const connectedPct = clusters.length ? (stats.connected / clusters.length) * 100 : 0;
  const envs = ENVIRONMENTS.filter((env) => clusters.some((c) => c.environment === env.key));

  return (
    <div className="bg-surface relative flex min-h-0 flex-1 overflow-hidden">
      <div className="relative flex-1 overflow-y-auto">
        {tone.backdrop && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[340px]"
            style={{
              background: `radial-gradient(900px 340px at 50% -20%, ${tone.backdrop}, transparent 70%)`,
            }}
          />
        )}
        <div className="@container/main relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 py-8">
          <header className="flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-start @3xl/main:justify-between">
            <div className="min-w-0 flex-1">
              <div className="text-fg-dim mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums">
                <span className="inline-flex items-center gap-1.5">
                  <span className="bg-accent/15 text-accent inline-flex h-5 w-5 items-center justify-center rounded-md">
                    <KubepitMark className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-fg-muted font-semibold tracking-[0.22em] uppercase">
                    {i18n.t('Fleet')}
                  </span>
                </span>
                {appVersion && (
                  <>
                    <span className="text-fg-dim/40">·</span>
                    <span className="text-fg-dim/80">v{appVersion}</span>
                  </>
                )}
                <span className="text-fg-dim/40">·</span>
                <span>{i18n.plural('{count} cluster', '{count} clusters', clusters.length)}</span>
              </div>
              <h1 className="text-fg text-[32px] leading-[1.1] font-semibold tracking-tight">
                {hero.count != null ? (
                  <>
                    <span className={cn('tabular-nums', tone.count)}>{hero.count}</span>
                    <span className="text-fg"> {hero.label}</span>
                  </>
                ) : (
                  <span className={tone.count}>{hero.label}</span>
                )}
              </h1>
              {stats.connected > 0 && (
                <p className="text-fg-muted mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    <Server className="text-fg-dim h-3 w-3" />
                    {i18n.t('{ready}/{total} nodes ready', {
                      ready: totals.nodesReady,
                      total: totals.nodes,
                    })}
                  </span>
                  <span className="text-fg-dim/50">·</span>
                  <span className="inline-flex items-center gap-1">
                    <Boxes className="text-fg-dim h-3 w-3" />
                    {i18n.t('{running}/{total} pods running', {
                      running: totals.podsRunning,
                      total: totals.pods,
                    })}
                  </span>
                  {totals.metricsClusters > 0 && (
                    <>
                      <span className="text-fg-dim/50">·</span>
                      <span className="inline-flex items-center gap-1">
                        <Cpu className="text-fg-dim h-3 w-3" />
                        {i18n.t('{cpu} cores', { cpu: formatCpu(totals.cpuUsage) })}
                      </span>
                      <span className="text-fg-dim/50">·</span>
                      <span className="inline-flex items-center gap-1">
                        <MemoryStick className="text-fg-dim h-3 w-3" />
                        {formatBytes(totals.memUsage)}
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<ClipboardCheck className="h-3.5 w-3.5" />}
                onClick={() => setShowInvestigations(true)}
              >
                {i18n.t('Investigations')}
              </Button>
              {stats.connected > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<ScanSearch className="h-3.5 w-3.5" />}
                  onClick={() => openFleetSearch()}
                  title={i18n.t('Search every connected cluster ({shortcut})', {
                    shortcut: FLEET_SEARCH_SHORTCUT,
                  })}
                >
                  {i18n.t('Fleet search')}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<FileSearch className="h-3.5 w-3.5" />}
                onClick={() => setImportDialogOpen(true)}
              >
                {i18n.t('Discover contexts')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => openClusterEditor({ mode: 'add' })}
              >
                {i18n.t('Add cluster')}
              </Button>
            </div>
          </header>

          <div className="grid grid-cols-2 gap-3 @3xl/main:grid-cols-4">
            <StatTile
              icon={<Activity className="h-4 w-4" />}
              value={stats.connected}
              label={i18n.t('Connected')}
              tone="running"
              extra={clusters.length ? formatPercent(connectedPct) : undefined}
            />
            <StatTile
              icon={<Loader2 className={cn('h-4 w-4', stats.connecting > 0 && 'animate-spin')} />}
              value={stats.connecting}
              label={i18n.t('Connecting')}
              tone="starting"
            />
            <StatTile
              icon={<CircleSlash className="h-4 w-4" />}
              value={stats.offline}
              label={i18n.t('Offline')}
              tone="idle"
            />
            <StatTile
              icon={<AlertTriangle className="h-4 w-4" />}
              value={stats.failing}
              label={i18n.t('Failing')}
              tone="error"
            />
          </div>

          <div className="glass flex items-center gap-4 px-5 py-3">
            <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.18em] uppercase">
              {i18n.t('Connected')}
            </span>
            <div className="bg-fg/8 h-1.5 flex-1 overflow-hidden rounded-full">
              <div
                className="h-full rounded-full transition-[width] duration-700"
                style={{
                  width: `${connectedPct}%`,
                  background:
                    'linear-gradient(90deg, rgb(var(--accent)), rgb(var(--status-running)))',
                }}
              />
            </div>
            <span className="text-fg text-[12px] font-semibold tabular-nums">
              {formatPercent(connectedPct)}
            </span>
            {totals.metricsClusters > 0 && totals.cpuAllocatable > 0 && (
              <span className="text-fg-dim border-border/60 border-l pl-4 text-[11px] tabular-nums">
                {i18n.t('CPU {cpu} · MEM {mem}', {
                  cpu: formatPercent((totals.cpuUsage / totals.cpuAllocatable) * 100),
                  mem: formatPercent((totals.memUsage / Math.max(1, totals.memAllocatable)) * 100),
                })}
              </span>
            )}
            <FleetCost clusters={clusters} statuses={statuses} visible={visible} />
          </div>

          {stats.connected > 0 && <UpgradeFleetCard visible={visible} />}
          <RecommendationsFleetCard visible={visible} />

          <div className="flex flex-wrap items-center gap-2">
            <div className="border-border/70 bg-surface-raised/60 focus-within:border-accent/40 flex h-8 w-72 max-w-full items-center gap-2 rounded-lg border px-2.5">
              <Search className="text-fg-dim h-3.5 w-3.5" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={i18n.t('Filter clusters…')}
                aria-label={i18n.t('Filter clusters')}
                className="text-fg w-full bg-transparent text-[12px] outline-none"
              />
              {query && (
                <button
                  type="button"
                  aria-label={i18n.t('Clear search')}
                  onClick={() => setQuery('')}
                  className="text-fg-dim hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {envs.length > 0 && (
              <div className="bg-fg/4 inline-flex gap-0.5 rounded-lg p-0.5">
                <Segment active={envFilter == null} onClick={() => setEnvFilter(null)}>
                  {i18n.t('All')}
                </Segment>
                {envs.map((env) => (
                  <Segment
                    key={env.key}
                    active={envFilter === env.key}
                    onClick={() => setEnvFilter(env.key)}
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full', env.dot)} />
                    {env.label}
                  </Segment>
                ))}
              </div>
            )}
            <div className="bg-fg/4 ml-auto inline-flex gap-0.5 rounded-lg p-0.5">
              {(
                [
                  ['sections', i18n.t('Sections')],
                  ['environment', i18n.t('Environment')],
                  ['none', i18n.t('Flat')],
                ] as const
              ).map(([key, label]) => (
                <Segment key={key} active={groupBy === key} onClick={() => setGroupBy(key)}>
                  {label}
                </Segment>
              ))}
            </div>
          </div>

          {groups.map((group) => {
            const connected = group.clusters.filter((c) =>
              isLive(connState(statuses[c.id])),
            ).length;
            const offline = group.clusters.filter((c) => !isLive(connState(statuses[c.id])));
            return (
              <section key={group.key} className="flex flex-col gap-3">
                <SectionHeader
                  label={group.label}
                  dotClass={group.dotClass}
                  dotStyle={group.dotStyle}
                  labelClass={group.labelClass}
                  count={group.clusters.length}
                  runningCount={connected}
                  actions={
                    offline.length > 0 ? (
                      <HeaderAction
                        title={i18n.t('Connect all in group')}
                        tone="run"
                        onClick={() => {
                          for (const c of offline) void connectCluster(c.id, { quiet: true });
                        }}
                      >
                        <Plug className="h-3.5 w-3.5" />
                      </HeaderAction>
                    ) : undefined
                  }
                />
                <div className="grid grid-cols-1 gap-3 @2xl/main:grid-cols-2 @5xl/main:grid-cols-3">
                  {group.clusters.map((cluster) => (
                    <ClusterCard key={cluster.id} cluster={cluster} visible={visible} />
                  ))}
                </div>
              </section>
            );
          })}
          {groups.length === 0 && (
            <p className="text-fg-dim py-10 text-center text-[12px]">
              {i18n.t('No clusters match this filter.')}
            </p>
          )}

          <footer className="text-fg-dim mt-auto flex items-center justify-between pt-4 text-[11px]">
            <span>{i18n.t('Local-first. Credentials never leave this machine.')}</span>
            <span className="flex items-center gap-1.5 opacity-70">
              <Kbd>{modChord('K')}</Kbd>
              <span>{i18n.t('quick jump')}</span>
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}

const TILE_TONE = {
  running: 'text-status-running bg-status-running/10',
  starting: 'text-status-starting bg-status-starting/10',
  idle: 'text-fg-muted bg-fg/5',
  error: 'text-status-error bg-status-error/10',
} as const;

function StatTile({
  icon,
  value,
  label,
  tone,
  extra,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  tone: keyof typeof TILE_TONE;
  extra?: string;
}) {
  const [text] = TILE_TONE[tone].split(' ');
  return (
    <div className="glass flex items-center gap-4 px-5 py-4">
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg', TILE_TONE[tone])}>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'text-[26px] leading-none font-semibold tabular-nums',
              value > 0 ? text : 'text-fg',
            )}
          >
            {value}
          </span>
          {extra && <span className="text-fg-dim text-[11px] tabular-nums">{extra}</span>}
        </div>
        <span className="text-fg-dim mt-1.5 block text-[10.5px] font-semibold tracking-[0.18em] uppercase">
          {label}
        </span>
      </div>
    </div>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors',
        active ? 'bg-surface-raised text-fg font-medium shadow-sm' : 'text-fg-dim hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function EmptyFleet({ onAdd, onDiscover }: { onAdd: () => void; onDiscover: () => void }) {
  i18n.useLocale();
  return (
    <div className="bg-surface relative flex flex-1 items-center justify-center overflow-hidden p-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(600px 400px at 50% 30%, rgb(var(--accent) / 0.06), transparent 70%)',
        }}
      />
      <div className="glass animate-fade-in relative max-w-sm p-8 text-center">
        <div className="bg-accent/10 border-accent/30 text-accent mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border">
          <KubepitMark className="h-8 w-8" />
        </div>
        <h2 className="text-fg text-xl font-semibold tracking-tight">
          {i18n.t('Bring your clusters in')}
        </h2>
        <p className="text-fg-muted mt-2 text-[13px] leading-relaxed">
          {i18n.t(
            'Kubepit finds the contexts in your kubeconfig files. Pick the ones you want, group them into sections and tag them.',
          )}
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<FileSearch className="h-4 w-4" />}
            onClick={onDiscover}
          >
            {i18n.t('Discover contexts')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={onAdd}
          >
            {i18n.t('Add cluster')}
          </Button>
        </div>
      </div>
    </div>
  );
}
