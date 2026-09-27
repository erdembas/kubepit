import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { Package, RefreshCw, Search, X } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { ipc } from '@/lib/ipc';
import { phaseTone, toneText } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { HelmRelease } from '@/types';
import { usePolled } from '../data/polled';
import { TableError, TableSkeleton } from '../table/TableStates';
import { useNow } from '../util';
import { HelmDetails } from './HelmDetails';

export function helmListKey(clusterId: string, namespaces: string[]) {
  return `${clusterId}|helm-releases|${namespaces.length === 1 ? namespaces[0] : '*'}`;
}

const TEMPLATE =
  'minmax(160px,2fr) minmax(110px,1fr) minmax(140px,1.4fr) 76px 96px 110px 110px 84px';

export function HelmPage({
  clusterId,
  namespaces,
  isActive,
}: {
  clusterId: string;
  namespaces: string[];
  isActive: boolean;
}) {
  i18n.useLocale();
  const single = namespaces.length === 1 ? namespaces[0]! : null;
  const releases = usePolled(
    helmListKey(clusterId, namespaces),
    () => ipc.helmReleases(clusterId, single),
    30_000,
    isActive,
  );
  const filter = useWorkbenchStore((s) => s.filters[`${clusterId}|${VIEW.helmReleases}`] ?? '');
  const selected = useWorkbenchStore((s) => s.selection[clusterId]?.[VIEW.helmReleases] ?? null);
  const now = useNow(30_000, isActive);
  const store = useWorkbenchStore.getState;
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (releases.data ?? [])
      .filter((r) => !namespaces.length || namespaces.includes(r.namespace))
      .filter(
        (r) => !q || `${r.name} ${r.namespace} ${r.chart} ${r.status}`.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.namespace.localeCompare(b.namespace));
  }, [releases.data, filter, namespaces]);
  const open = (r: HelmRelease) =>
    store().select(clusterId, VIEW.helmReleases, {
      key: VIEW.helmReleases,
      namespace: r.namespace,
      name: r.name,
    });

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="bg-accent/10 text-accent flex h-6 w-6 items-center justify-center rounded-md">
            <Package className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-fg text-[13px] font-semibold">{i18n.t('Helm Releases')}</h2>
          <span className="bg-surface-muted text-fg-dim rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
            {rows.length}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-56 items-center gap-2 rounded-lg border px-2.5">
              <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
              <input
                value={filter}
                onChange={(e) => store().setFilter(clusterId, VIEW.helmReleases, e.target.value)}
                placeholder={i18n.t('Filter releases…')}
                aria-label={i18n.t('Filter releases')}
                className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => store().setFilter(clusterId, VIEW.helmReleases, '')}
                  aria-label={i18n.t('Clear filter')}
                  className="text-fg-dim hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <IconButton
              label={i18n.t('Refresh')}
              icon={<RefreshCw />}
              onClick={() => void releases.refresh()}
            />
          </div>
        </div>
        {releases.error && !releases.data ? (
          <TableError
            error={releases.error}
            forbidden={/forbidden/i.test(releases.error)}
            onRetry={() => void releases.refresh()}
          />
        ) : !releases.data ? (
          <TableSkeleton rows={6} />
        ) : !rows.length ? (
          <p className="text-fg-dim flex flex-1 items-center justify-center text-[12px]">
            {filter
              ? i18n.t('No releases match the filter.')
              : i18n.t('No Helm releases in the selected namespaces.')}
          </p>
        ) : (
          <div
            role="table"
            aria-label={i18n.t('Helm Releases')}
            className="min-h-0 flex-1 overflow-auto"
          >
            <div
              role="row"
              style={{ gridTemplateColumns: TEMPLATE }}
              className="border-border/70 text-fg-dim bg-surface/95 sticky top-0 z-10 grid h-8 min-w-[900px] items-center gap-x-3 border-b px-3 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
            >
              {[
                i18n.t('Name'),
                i18n.t('Namespace'),
                i18n.t('Chart'),
                i18n.t('Revision'),
                i18n.t('Version'),
                i18n.t('App version'),
                i18n.t('Status'),
                i18n.t('Updated'),
              ].map((h, i) => (
                <span
                  key={h}
                  role="columnheader"
                  className={cn('truncate', (i === 3 || i === 7) && 'text-right')}
                >
                  {h}
                </span>
              ))}
            </div>
            {rows.map((r) => {
              const active = selected?.name === r.name && selected.namespace === r.namespace;
              return (
                <div
                  key={`${r.namespace}/${r.name}`}
                  role="row"
                  onClick={() => open(r)}
                  style={{ gridTemplateColumns: TEMPLATE }}
                  className={cn(
                    'border-border/40 grid h-8 min-w-[900px] cursor-default items-center gap-x-3 border-b px-3 text-[12px] transition-colors',
                    active ? 'bg-fg/7 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
                  )}
                >
                  <span role="cell" className="text-fg truncate">
                    {r.name}
                  </span>
                  <span role="cell" className="text-fg-muted truncate">
                    {r.namespace}
                  </span>
                  <span role="cell" className="text-fg-muted truncate">
                    {r.chart}
                  </span>
                  <span role="cell" className="text-fg-muted text-right tabular-nums">
                    {r.revision}
                  </span>
                  <span role="cell" className="text-fg-muted truncate font-mono text-[11px]">
                    {r.chart_version}
                  </span>
                  <span role="cell" className="text-fg-muted truncate font-mono text-[11px]">
                    {r.app_version ?? '—'}
                  </span>
                  <span
                    role="cell"
                    className={cn('truncate font-medium capitalize', toneText(phaseTone(r.status)))}
                  >
                    {r.status}
                  </span>
                  <span
                    role="cell"
                    className="text-fg-muted text-right tabular-nums"
                    title={r.updated ?? undefined}
                  >
                    {formatAge(r.updated, now)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {selected && selected.namespace && (
        <HelmDetails
          clusterId={clusterId}
          namespace={selected.namespace}
          name={selected.name}
          isActive={isActive}
          listKey={helmListKey(clusterId, namespaces)}
        />
      )}
    </div>
  );
}
