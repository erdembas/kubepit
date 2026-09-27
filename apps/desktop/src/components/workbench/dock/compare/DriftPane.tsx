import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import {
  Ban,
  CircleCheck,
  CircleDashed,
  Crosshair,
  FileDiff,
  Loader2,
  Plug,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { ClusterAvatar, EnvPill } from '@/components/workbench/ClusterAvatar';
import { connectCluster } from '@/lib/clusterActions';
import { cn } from '@/lib/cn';
import { shortPath, shortValue, type FieldChange } from '@/lib/kube/drift';
import { useAppStore } from '@/store/useAppStore';
import type { CompareSide, DockTab } from '@/store/useDockStore';
import type { ClusterId } from '@/types';
import { compareToBaseline, fetchSide, type DriftRow, type FetchedSide } from './compareData';

type CompareTab = Extract<DockTab, { kind: 'compare' }>;

function changeText(c: FieldChange, short = false): string {
  const path = short ? shortPath(c.path) : c.path;
  if (c.kind === 'added') return `+ ${path}`;
  if (c.kind === 'removed') return `− ${path}`;
  return `${path}: ${shortValue(c.before)} → ${shortValue(c.after)}`;
}

function StateCell({
  row,
  loading,
  baseline,
}: {
  row: DriftRow | null;
  loading: boolean;
  baseline: boolean;
}) {
  i18n.useLocale();
  if (loading || !row)
    return (
      <span className="text-fg-dim flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        {i18n.t('Reading…')}
      </span>
    );
  const s = row.side.state;
  if (s === 'missing')
    return (
      <span className="text-fg-muted flex items-center gap-1.5">
        <CircleDashed className="h-3.5 w-3.5" />
        {i18n.t('Missing')}
      </span>
    );
  if (s === 'not-served')
    return (
      <span className="text-fg-dim flex items-center gap-1.5">
        <Ban className="h-3.5 w-3.5" />
        {i18n.t('Not served')}
      </span>
    );
  if (s === 'forbidden')
    return (
      <span className="text-status-starting flex items-center gap-1.5">
        <ShieldAlert className="h-3.5 w-3.5" />
        {i18n.t('Forbidden')}
      </span>
    );
  if (s === 'error')
    return (
      <span className="text-status-error flex items-center gap-1.5" title={row.side.message ?? ''}>
        <TriangleAlert className="h-3.5 w-3.5" />
        {i18n.t('Error')}
      </span>
    );
  if (baseline)
    return (
      <span className="bg-accent/12 text-accent ring-accent/25 justify-self-start rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold ring-1">
        {i18n.t('Baseline')}
      </span>
    );
  if (row.identical === null) return <span className="text-fg-dim">—</span>;
  if (row.identical)
    return (
      <span className="text-status-running flex items-center gap-1.5">
        <CircleCheck className="h-3.5 w-3.5" />
        {i18n.t('Identical')}
      </span>
    );
  const total = Math.max(1, row.added + row.removed);
  return (
    <span className="flex items-center gap-2 font-mono tabular-nums">
      <span className="text-status-running">+{row.added}</span>
      <span className="text-status-error">−{row.removed}</span>
      <span className="bg-fg/8 flex h-1.5 w-12 overflow-hidden rounded-full" aria-hidden>
        <span
          className="bg-status-running h-full"
          style={{ width: `${(row.added / total) * 100}%` }}
        />
        <span
          className="bg-status-error h-full"
          style={{ width: `${(row.removed / total) * 100}%` }}
        />
      </span>
    </span>
  );
}

export function DriftPane({
  clusterId,
  tab,
  active,
  refresh,
  onBaseline,
  onOpenDiff,
}: {
  clusterId: ClusterId;
  tab: CompareTab;
  active: boolean;
  refresh: number;
  onBaseline: (clusterId: ClusterId) => void;
  onOpenDiff: (left: CompareSide, right: CompareSide) => void;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const live = clusters.filter((c) => statuses[c.id]?.state === 'connected');
  const offline = clusters.filter((c) => statuses[c.id]?.state !== 'connected');
  const liveKey = live.map((c) => c.id).join(',');
  const baselineId =
    tab.baseline && live.some((c) => c.id === tab.baseline) ? tab.baseline : clusterId;
  const [sides, setSides] = useState<Record<ClusterId, FetchedSide>>({});
  const [fetchKey, setFetchKey] = useState('');
  const key = `${liveKey}|${tab.includeStatus}|${refresh}`;

  // Fetch once per key while visible; a newer key discards older answers.
  const generation = useRef(0);
  useEffect(() => {
    if (!active || key === fetchKey) return;
    const current = ++generation.current;
    setFetchKey(key);
    setSides({});
    for (const c of live) {
      void fetchSide(
        { clusterId: c.id, namespace: tab.namespace, name: tab.name },
        tab.gvk,
        tab.includeStatus,
      ).then((side) => {
        if (generation.current === current) setSides((prev) => ({ ...prev, [c.id]: side }));
      });
    }
    // `key` covers the connected set, status toggle and refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  const side = (id: ClusterId): CompareSide => ({
    clusterId: id,
    namespace: tab.namespace,
    name: tab.name,
  });
  const rows = useMemo(
    () =>
      [...live]
        .sort((a, b) => Number(b.id === baselineId) - Number(a.id === baselineId))
        .map((c) => ({
          cluster: c,
          row: sides[c.id] ? compareToBaseline(c.id, sides[c.id]!, sides[baselineId]) : null,
        })),
    // `liveKey` stands for `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveKey, sides, baselineId],
  );
  const done = rows.filter((r) => r.row);
  const counts = {
    identical: done.filter((r) => r.row!.identical && r.cluster.id !== baselineId).length,
    differs: done.filter((r) => r.row!.identical === false).length,
    missing: done.filter((r) => r.row!.side.state === 'missing').length,
  };
  const baselineSide = sides[baselineId];
  const baselineName = clusters.find((c) => c.id === baselineId)?.name ?? baselineId;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 text-fg-dim flex h-10 shrink-0 items-center gap-3 border-b px-3 text-[11.5px] tabular-nums">
        <span>
          {i18n.plural(
            'Checked on {count} connected cluster',
            'Checked on {count} connected clusters',
            live.length,
          )}
        </span>
        {done.length > 0 && (
          <>
            <span className="text-status-running">
              {i18n.t('{count} identical', { count: counts.identical })}
            </span>
            <span className={counts.differs ? 'text-status-starting' : undefined}>
              {i18n.t('{count} differ', { count: counts.differs })}
            </span>
            <span>{i18n.t('{count} missing', { count: counts.missing })}</span>
          </>
        )}
        <span className="ml-auto">
          {i18n.rich('Baseline: {cluster}', {
            cluster: <span className="text-fg font-medium">{baselineName}</span>,
          })}
        </span>
      </div>
      <div className="overlay-scroll min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {baselineSide && baselineSide.state !== 'ok' && (
          <p className="bg-status-starting/8 text-status-starting border-status-starting/20 mx-1 mb-1.5 rounded-md border px-3 py-1.5 text-[11.5px]">
            {i18n.t(
              'The baseline has no readable object; pick another baseline to compare against.',
            )}
          </p>
        )}
        <div className="text-fg-dim grid grid-cols-[minmax(180px,1.1fr)_150px_minmax(0,2fr)_64px] gap-3 px-2 py-1 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
          <span>{i18n.t('Cluster')}</span>
          <span>{i18n.t('State')}</span>
          <span>{i18n.t('Differences')}</span>
          <span />
        </div>
        {rows.map(({ cluster, row }) => {
          const isBaseline = cluster.id === baselineId;
          const canDiff =
            !!row && row.side.state === 'ok' && baselineSide?.state === 'ok' && !isBaseline;
          return (
            <div
              key={cluster.id}
              role={canDiff ? 'button' : undefined}
              tabIndex={canDiff ? 0 : undefined}
              onClick={() => canDiff && onOpenDiff(side(baselineId), side(cluster.id))}
              onKeyDown={(e) => {
                if (canDiff && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onOpenDiff(side(baselineId), side(cluster.id));
                }
              }}
              className={cn(
                'group grid min-h-9 grid-cols-[minmax(180px,1.1fr)_150px_minmax(0,2fr)_64px] items-center gap-3 rounded-md px-2 text-[12px] transition-colors',
                canDiff && 'hover:bg-fg/4 cursor-pointer',
                isBaseline && 'bg-accent/5 shadow-[inset_2px_0_0_rgb(var(--accent))]',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ClusterAvatar cluster={cluster} />
                <span className="text-fg truncate font-medium">{cluster.name}</span>
                <EnvPill cluster={cluster} />
              </span>
              <StateCell row={row} loading={!row} baseline={isBaseline} />
              <span
                className="text-fg-muted min-w-0 truncate font-mono text-[11px]"
                title={row?.changes.map((c) => changeText(c)).join('\n')}
              >
                {row?.changes
                  .slice(0, 2)
                  .map((c) => changeText(c, true))
                  .join(' · ')}
                {row && row.changes.length > 2 && (
                  <span className="text-fg-dim">
                    {' '}
                    {i18n.t('+{count} more', { count: row.changes.length - 2 })}
                  </span>
                )}
              </span>
              <span className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                {!isBaseline && row?.side.state === 'ok' && (
                  <button
                    type="button"
                    title={i18n.t('Use as baseline')}
                    aria-label={i18n.t('Use as baseline')}
                    onClick={() => onBaseline(cluster.id)}
                    className="text-fg-dim hover:text-fg hover:bg-fg/10 flex h-6 w-6 items-center justify-center rounded-md opacity-0 group-hover:opacity-100"
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                  </button>
                )}
                {canDiff && (
                  <button
                    type="button"
                    title={i18n.t('Open diff')}
                    aria-label={i18n.t('Open diff')}
                    onClick={() => onOpenDiff(side(baselineId), side(cluster.id))}
                    className="text-fg-dim hover:text-fg hover:bg-fg/10 flex h-6 w-6 items-center justify-center rounded-md"
                  >
                    <FileDiff className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {offline.length > 0 && (
          <p className="text-fg-dim flex items-center gap-2 px-2 pt-2 text-[11px]">
            {i18n.plural(
              '{count} cluster is not connected and was not checked.',
              '{count} clusters are not connected and were not checked.',
              offline.length,
            )}
            <button
              type="button"
              onClick={() => {
                for (const c of offline) void connectCluster(c.id, { quiet: true });
              }}
              className="hover:text-accent inline-flex items-center gap-1"
            >
              <Plug className="h-3 w-3" />
              {i18n.t('Connect all')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
