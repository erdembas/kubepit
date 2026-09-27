import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Search } from 'lucide-react';
import { refreshOverview } from '@/lib/clusterActions';
import { clusterColor } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { openObject } from '@/lib/navigation';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef, KubeObject } from '@/types';

interface FleetEvent {
  cluster: ClusterDef;
  event: KubeObject;
  at: number;
}

function eventTime(event: KubeObject): number {
  const e = event as KubeObject & {
    lastTimestamp?: string;
    eventTime?: string;
    series?: { lastObservedTime?: string };
  };
  const raw =
    e.lastTimestamp ?? e.series?.lastObservedTime ?? e.eventTime ?? e.metadata.creationTimestamp;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Right-rail panel: Warning events merged across every connected cluster,
 * newest first. Data comes from the dashboard overviews, so it costs no
 * extra API calls; "Refresh" re-polls the overviews on demand.
 */
export function FleetEventsPanel({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const overviews = useAppStore((s) => s.overviews);
  const [query, setQuery] = useState('');
  const [clusterFilter, setClusterFilter] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // Re-render ages every 30s while visible.
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  const events = useMemo(() => {
    const out: FleetEvent[] = [];
    for (const cluster of clusters) {
      if (statuses[cluster.id]?.state !== 'connected') continue;
      for (const event of overviews[cluster.id]?.warnings ?? []) {
        out.push({ cluster, event, at: eventTime(event) });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [clusters, statuses, overviews]);

  const q = query.trim().toLowerCase();
  const filtered = events.filter(({ cluster, event }) => {
    if (clusterFilter && cluster.id !== clusterFilter) return false;
    if (!q) return true;
    const e = event as KubeObject & { reason?: string; message?: string };
    return `${cluster.name} ${e.reason ?? ''} ${e.message ?? ''} ${event.metadata.namespace ?? ''}`
      .toLowerCase()
      .includes(q);
  });
  const clustersWithEvents = [...new Set(events.map((e) => e.cluster))];

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <AlertTriangle className="text-status-starting h-3.5 w-3.5" />
        <h2 className="text-fg text-[12px] font-semibold">{i18n.t('Warning events')}</h2>
        <span className="bg-surface-muted text-fg-muted rounded-app-sm px-1.5 text-[10px] tabular-nums">
          {events.length}
        </span>
        <button
          type="button"
          onClick={() => {
            for (const id of Object.keys(statuses)) {
              if (statuses[id]?.state === 'connected') void refreshOverview(id);
            }
          }}
          title={i18n.t('Refresh')}
          aria-label={i18n.t('Refresh')}
          className="text-fg-dim hover:bg-fg/5 hover:text-fg ml-auto rounded-md p-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="border-border/60 space-y-2 border-b p-3">
        <div className="bg-surface border-border flex items-center gap-2 rounded-lg border px-2.5">
          <Search className="text-fg-dim h-3.5 w-3.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={i18n.t('Filter by reason, message, namespace…')}
            aria-label={i18n.t('Filter events')}
            className="text-fg w-full bg-transparent py-1.5 text-[12px] outline-none"
          />
        </div>
        {clustersWithEvents.length > 1 && (
          <div className="flex flex-wrap gap-1">
            <FilterChip active={clusterFilter == null} onClick={() => setClusterFilter(null)}>
              {i18n.t('All clusters')}
            </FilterChip>
            {clustersWithEvents.map((cluster) => (
              <FilterChip
                key={cluster.id}
                active={clusterFilter === cluster.id}
                onClick={() => setClusterFilter(cluster.id)}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: clusterColor(cluster) }}
                />
                {cluster.name}
              </FilterChip>
            ))}
          </div>
        )}
      </div>
      <div className="overlay-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {filtered.map(({ cluster, event, at }) => {
          const e = event as KubeObject & {
            reason?: string;
            message?: string;
            count?: number;
            involvedObject?: { kind?: string; name?: string; namespace?: string };
          };
          const target = e.involvedObject;
          return (
            <button
              key={`${cluster.id}:${event.metadata.uid}`}
              type="button"
              onClick={() => {
                if (target?.kind && target.name)
                  openObject(cluster.id, target.kind, target.namespace ?? null, target.name);
              }}
              className="hover:bg-fg/4 mb-1 w-full space-y-1 rounded-md p-2.5 text-left transition-colors"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: clusterColor(cluster) }}
                />
                <span className="text-status-starting text-[11.5px] font-semibold">{e.reason}</span>
                {(e.count ?? 1) > 1 && (
                  <span className="bg-status-starting/12 text-status-starting rounded px-1 text-[9.5px] tabular-nums">
                    ×{e.count}
                  </span>
                )}
                <span className="text-fg-dim ml-auto shrink-0 text-[10px] tabular-nums">
                  {formatAge(at)}
                </span>
              </div>
              <p className="text-fg-muted line-clamp-2 text-[11.5px] leading-snug">{e.message}</p>
              <p className="text-fg-dim truncate font-mono text-[10px]">
                {cluster.name} · {target?.namespace ? `${target.namespace}/` : ''}
                {target?.kind?.toLowerCase()}/{target?.name}
              </p>
            </button>
          );
        })}
        {!filtered.length && (
          <p className="text-fg-dim px-3 py-10 text-center text-[12px]">
            {events.length
              ? i18n.t('No events match this filter.')
              : i18n.t('No warning events on connected clusters.')}
          </p>
        )}
      </div>
    </div>
  );
}

function FilterChip({
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
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] transition',
        active ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-fg/5 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
