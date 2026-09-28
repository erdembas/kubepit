import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import {
  CirclePause,
  GitBranch,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { gvkForKey } from '@/lib/kube/catalog';
import {
  detectGitOps,
  GITOPS_KEYS,
  servedGvk,
  toolName,
  type GitOpsTool,
} from '@/lib/kube/gitops/kinds';
import {
  countBuckets,
  gitopsRow,
  rowSearchText,
  sortRows,
  type GitOpsBucket,
  type GitOpsRow,
} from '@/lib/kube/gitops/model';
import { kindIcon } from '@/lib/kube/icons';
import type { StatusTone } from '@/lib/kube/pods';
import { toneDot, toneText } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId, Gvk } from '@/types';
import { OPEN_GATE, useActionGates } from '../access/gates';
import { resourceActions } from '../actions/resourceActions';
import { useCluster } from '../data/hooks';
import { hasListError } from '../data/listState';
import { restartWatch, useWatch, type WatchSnapshot } from '../data/watchCache';
import { DetailsPanel } from '../details/DetailsPanel';
import { TableSkeleton } from '../table/TableStates';
import { useNow } from '../util';

/**
 * GitOps overview: Argo CD Applications, Flux Kustomizations and
 * HelmReleases in one live table (cluster-wide watches) with status and
 * tool filters. A row belongs to the selected namespaces when the object or
 * its destination namespace is selected, so an Application in `argocd` that
 * deploys into `web` shows up while browsing `web`.
 */

const TEMPLATE =
  'minmax(170px,2fr) 116px minmax(90px,1fr) 108px 100px 100px minmax(170px,2fr) minmax(120px,1.2fr) 76px minmax(180px,2.2fr)';

type ToolFilter = 'all' | GitOpsTool;
type BucketFilter = 'all' | GitOpsBucket;

const BUCKET_TONE: Record<GitOpsBucket, StatusTone> = {
  healthy: 'success',
  outOfSync: 'warning',
  degraded: 'error',
  progressing: 'info',
  suspended: 'muted',
  unknown: 'muted',
};

function bucketLabel(bucket: GitOpsBucket): string {
  switch (bucket) {
    case 'healthy':
      return i18n.t('Healthy');
    case 'outOfSync':
      return i18n.t('Out of sync');
    case 'degraded':
      return i18n.t('Degraded');
    case 'progressing':
      return i18n.t('Progressing');
    case 'suspended':
      return i18n.t('Suspended');
    default:
      return i18n.t('Unknown');
  }
}

/** Cluster-wide watch, falling back to the selected namespaces when listing everywhere is forbidden. */
function useScopedWatch(
  clusterId: ClusterId,
  gvk: Gvk | null,
  namespaces: string[],
  active: boolean,
): WatchSnapshot {
  const all = useWatch(clusterId, gvk, [], active);
  const fallback = all.forbidden && namespaces.length > 0;
  const scoped = useWatch(clusterId, gvk, namespaces, active && fallback);
  return fallback ? scoped : all;
}

function Chip({
  active,
  onClick,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: StatusTone;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition',
        active ? 'bg-fg/7 text-fg font-medium' : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
      )}
    >
      {tone && <span className={cn('h-1.5 w-1.5 rounded-full', toneDot(tone))} />}
      {label}
      <span className="text-fg-dim tabular-nums">{count}</span>
    </button>
  );
}

export function GitOpsPage({
  clusterId,
  namespaces,
  isActive,
  apiResources,
}: {
  clusterId: string;
  namespaces: string[];
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const { cluster, readOnly } = useCluster(clusterId);
  const appGvk = useMemo(() => servedGvk(GITOPS_KEYS.application, apiResources), [apiResources]);
  const ksGvk = useMemo(() => servedGvk(GITOPS_KEYS.kustomization, apiResources), [apiResources]);
  const hrGvk = useMemo(() => servedGvk(GITOPS_KEYS.helmRelease, apiResources), [apiResources]);
  const apps = useScopedWatch(clusterId, appGvk, namespaces, isActive);
  const kss = useScopedWatch(clusterId, ksGvk, namespaces, isActive);
  const hrs = useScopedWatch(clusterId, hrGvk, namespaces, isActive);
  const watches = [
    { gvk: appGvk, snap: apps },
    { gvk: ksGvk, snap: kss },
    { gvk: hrGvk, snap: hrs },
  ].filter((w): w is { gvk: Gvk; snap: WatchSnapshot } => !!w.gvk);
  const filter = useWorkbenchStore((s) => s.filters[`${clusterId}|${VIEW.gitops}`] ?? '');
  const selection = useWorkbenchStore((s) => s.selection[clusterId]?.[VIEW.gitops] ?? null);
  const [tool, setTool] = useState<ToolFilter>('all');
  const [bucket, setBucket] = useState<BucketFilter>('all');
  const [menu, setMenu] = useState<{ x: number; y: number; row: GitOpsRow } | null>(null);
  const now = useNow(30_000, isActive);
  const store = useWorkbenchStore.getState;

  const rows = useMemo(
    () =>
      sortRows(
        [...apps.items, ...kss.items, ...hrs.items]
          .map(gitopsRow)
          .filter((r): r is GitOpsRow => !!r),
      ),
    [apps.items, kss.items, hrs.items],
  );
  const base = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!namespaces.length ||
          namespaces.includes(r.namespace) ||
          (!!r.destNamespace && namespaces.includes(r.destNamespace))) &&
        (!q || rowSearchText(r).includes(q)),
    );
  }, [rows, namespaces, filter]);
  const toolCounts = useMemo(
    () => ({
      all: base.length,
      argo: base.filter((r) => r.tool === 'argo').length,
      flux: base.filter((r) => r.tool === 'flux').length,
    }),
    [base],
  );
  const byTool = useMemo(
    () => (tool === 'all' ? base : base.filter((r) => r.tool === tool)),
    [base, tool],
  );
  const counts = useMemo(() => countBuckets(byTool), [byTool]);
  const visible = useMemo(
    () => (bucket === 'all' ? byTool : byTool.filter((r) => r.bucket === bucket)),
    [byTool, bucket],
  );

  const detection = detectGitOps(apiResources);
  const synced =
    watches.length > 0 && watches.every((w) => w.snap.synced || w.snap.status === 'error');
  const errors = watches.filter((w) => hasListError(w.snap) && w.snap.error);
  const selectedGvk = selection ? gvkForKey(selection.key, apiResources) : null;
  const selectedObj = useMemo(
    () =>
      (selection &&
        rows.find(
          (r) =>
            keyForRow(r) === selection.key &&
            r.obj.metadata.name === selection.name &&
            (r.obj.metadata.namespace ?? null) === (selection.namespace ?? null),
        )?.obj) ??
      null,
    [rows, selection],
  );

  const open = (r: GitOpsRow) =>
    store().select(clusterId, VIEW.gitops, {
      key: keyForRow(r),
      namespace: r.namespace || null,
      name: r.name,
    });
  const gvkOfRow = (r: GitOpsRow) =>
    r.kind === 'Application' ? appGvk : r.kind === 'Kustomization' ? ksGvk : hrGvk;

  const menuActions = useMemo(() => {
    const gvk = menu ? gvkOfRow(menu.row) : null;
    return menu && gvk ? resourceActions({ clusterId, cluster, gvk, obj: menu.row.obj }) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, clusterId, cluster]);
  const menuGates = useActionGates(clusterId, menuActions, readOnly);
  const menuItems = useMemo((): FileContextMenuEntry[] => {
    if (!menu) return [];
    const entries: FileContextMenuEntry[] = [
      { id: 'open', label: i18n.t('Show details'), onClick: () => open(menu.row) },
      { id: 'sep0', separator: true },
    ];
    menuActions.forEach((a) => {
      if (a.id === 'delete') entries.push({ id: 'sep1', separator: true });
      const Icon = a.icon;
      const gate = menuGates.get(a.id) ?? OPEN_GATE;
      entries.push({
        id: a.id,
        label: a.label,
        icon: gate.reason === 'permission' ? <Lock size={12} /> : <Icon size={12} />,
        tone: a.tone,
        disabled: gate.blocked,
        hint:
          gate.reason === 'read-only'
            ? i18n.t('read-only')
            : gate.reason === 'permission'
              ? i18n.t('no access')
              : undefined,
        title: gate.message ?? undefined,
        onClick: () => a.run({ x: menu.x, y: menu.y }),
      });
    });
    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, menuActions, menuGates]);

  const buckets: GitOpsBucket[] = ['healthy', 'outOfSync', 'degraded', 'progressing', 'suspended'];
  if (counts.unknown) buckets.push('unknown');

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
            <GitBranch className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-fg shrink-0 text-[13px] font-semibold">
            {i18n.t('GitOps Overview')}
          </h2>
          <span className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
            {visible.length === rows.length ? rows.length : `${visible.length}/${rows.length}`}
          </span>
          <span className="text-fg-dim hidden truncate text-[11px] lg:inline">
            {namespaces.length === 0
              ? i18n.t('All namespaces')
              : namespaces.length === 1
                ? i18n.t('{namespace} (object or destination)', { namespace: namespaces[0] })
                : i18n.t('{count} namespaces', { count: namespaces.length })}
          </span>
          <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1.5">
            <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-56 min-w-24 shrink items-center gap-2 rounded-lg border px-2.5">
              <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
              <input
                value={filter}
                onChange={(e) => store().setFilter(clusterId, VIEW.gitops, e.target.value)}
                onKeyDown={(e) =>
                  e.key === 'Escape' && store().setFilter(clusterId, VIEW.gitops, '')
                }
                placeholder={i18n.t('Filter applications…')}
                aria-label={i18n.t('Filter applications')}
                title={i18n.t('Matches name, namespace, status, revision, source and message')}
                className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => store().setFilter(clusterId, VIEW.gitops, '')}
                  aria-label={i18n.t('Clear filter')}
                  className="text-fg-dim hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <IconButton
              label={i18n.t('Restart watches')}
              icon={<RefreshCw />}
              onClick={() => watches.forEach((w) => restartWatch(clusterId, w.gvk, []))}
            />
          </div>
        </div>
        <div className="border-border/60 flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
          <div className="flex items-center gap-0.5" role="radiogroup" aria-label={i18n.t('Tool')}>
            <Chip
              active={tool === 'all'}
              onClick={() => setTool('all')}
              label={i18n.t('All')}
              count={toolCounts.all}
            />
            {detection.argo && (
              <Chip
                active={tool === 'argo'}
                onClick={() => setTool('argo')}
                label={toolName('argo')}
                count={toolCounts.argo}
              />
            )}
            {detection.flux && (
              <Chip
                active={tool === 'flux'}
                onClick={() => setTool('flux')}
                label={toolName('flux')}
                count={toolCounts.flux}
              />
            )}
          </div>
          <span className="bg-border/80 mx-1.5 h-4 w-px shrink-0" aria-hidden />
          <div
            className="flex items-center gap-0.5"
            role="radiogroup"
            aria-label={i18n.t('Status')}
          >
            <Chip
              active={bucket === 'all'}
              onClick={() => setBucket('all')}
              label={i18n.t('Any status')}
              count={byTool.length}
            />
            {buckets.map((b) => (
              <Chip
                key={b}
                active={bucket === b}
                onClick={() => setBucket(bucket === b ? 'all' : b)}
                label={bucketLabel(b)}
                count={counts[b]}
                tone={BUCKET_TONE[b]}
              />
            ))}
          </div>
        </div>
        {errors.length > 0 && (
          <div className="border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg flex shrink-0 flex-col gap-0.5 border-b px-4 py-1.5 text-[11.5px]">
            {errors.map((w) => (
              <span key={w.gvk.kind} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">
                  {w.gvk.kind}: {w.snap.error}
                </span>
              </span>
            ))}
          </div>
        )}
        {!apiResources ? (
          <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Discovering API resources…')}
          </div>
        ) : !detection.overview ? (
          <p className="text-fg-dim flex flex-1 items-center justify-center px-8 text-center text-[12px]">
            {i18n.t(
              'No Argo CD Applications or Flux Kustomizations and HelmReleases are served by this cluster.',
            )}
          </p>
        ) : !synced && !rows.length ? (
          <TableSkeleton rows={8} />
        ) : !visible.length ? (
          <p className="text-fg-dim flex flex-1 items-center justify-center text-[12px]">
            {rows.length
              ? i18n.t('Nothing matches the current filters.')
              : i18n.t('No applications, Kustomizations or HelmReleases yet.')}
          </p>
        ) : (
          <div
            role="table"
            aria-label={i18n.t('GitOps Overview')}
            className="min-h-0 flex-1 overflow-auto"
          >
            <div
              role="row"
              style={{ gridTemplateColumns: TEMPLATE }}
              className="border-border/70 text-fg-dim bg-surface/95 sticky top-0 z-10 grid h-8 min-w-[1320px] items-center gap-x-3 border-b px-3 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
            >
              {[
                i18n.t('Name'),
                i18n.t('Kind'),
                i18n.t('Namespace'),
                i18n.t('Sync'),
                i18n.t('Health'),
                i18n.t('Revision'),
                i18n.t('Source'),
                i18n.t('Destination'),
                i18n.t('Last sync'),
                i18n.t('Message'),
              ].map((h, i) => (
                <span
                  key={h}
                  role="columnheader"
                  className={cn('truncate', i === 8 && 'text-right')}
                >
                  {h}
                </span>
              ))}
            </div>
            {visible.map((r) => {
              const active =
                !!selection &&
                selection.key === keyForRow(r) &&
                selection.name === r.name &&
                (selection.namespace ?? '') === r.namespace;
              const Icon = kindIcon(keyForRow(r));
              return (
                <div
                  key={r.uid}
                  role="row"
                  onClick={() => open(r)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, row: r });
                  }}
                  style={{ gridTemplateColumns: TEMPLATE }}
                  className={cn(
                    'border-border/40 grid h-8 min-w-[1320px] cursor-default items-center gap-x-3 border-b px-3 text-[12px] transition-colors',
                    active ? 'bg-fg/7 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
                  )}
                >
                  <span role="cell" className="flex min-w-0 items-center gap-1.5">
                    <span className="text-fg truncate" title={r.name}>
                      {r.name}
                    </span>
                    {r.operation && (
                      <Loader2
                        className="text-cat-frontend h-3 w-3 shrink-0 animate-spin"
                        aria-label={r.operation}
                      />
                    )}
                    {r.autoSync && (
                      <span title={i18n.t('Auto-sync on')} className="text-fg-dim shrink-0">
                        <Zap className="h-3 w-3" />
                      </span>
                    )}
                    {r.suspended && (
                      <span title={i18n.t('Suspended')} className="text-status-starting shrink-0">
                        <CirclePause className="h-3 w-3" />
                      </span>
                    )}
                  </span>
                  <span
                    role="cell"
                    className="text-fg-muted flex min-w-0 items-center gap-1.5"
                    title={toolName(r.tool)}
                  >
                    <Icon className="text-fg-dim h-3 w-3 shrink-0" />
                    <span className="truncate">{r.kind}</span>
                  </span>
                  <span role="cell" className="text-fg-muted truncate">
                    {r.namespace}
                  </span>
                  <span
                    role="cell"
                    className={cn('truncate font-medium', toneText(r.syncTone))}
                    title={r.sync}
                  >
                    {r.sync || '—'}
                  </span>
                  <span role="cell" className={cn('truncate font-medium', toneText(r.healthTone))}>
                    {r.health}
                  </span>
                  <span
                    role="cell"
                    className="text-fg-muted truncate font-mono text-[11px]"
                    title={r.revisionFull}
                  >
                    {r.revision || '—'}
                  </span>
                  <span role="cell" className="text-fg-muted truncate" title={r.source}>
                    {r.source || '—'}
                  </span>
                  <span
                    role="cell"
                    className="text-fg-muted truncate font-mono text-[11px]"
                    title={r.destination}
                  >
                    {r.destination}
                  </span>
                  <span
                    role="cell"
                    className="text-fg-muted text-right tabular-nums"
                    title={r.lastSync || undefined}
                  >
                    {formatAge(r.lastSync || null, now)}
                  </span>
                  <span
                    role="cell"
                    className={cn(
                      'truncate',
                      r.bucket === 'degraded' ? 'text-status-error' : 'text-fg-dim',
                    )}
                    title={r.message || undefined}
                  >
                    {r.message || '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="border-border/60 text-fg-dim flex h-7 shrink-0 items-center gap-2 border-t px-4 text-[11px] tabular-nums">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              errors.length
                ? 'bg-status-error'
                : synced && isActive
                  ? 'bg-status-running animate-breathe'
                  : 'bg-fg-dim/50',
            )}
          />
          <span>{!isActive ? i18n.t('Paused') : synced ? i18n.t('Live') : i18n.t('Loading…')}</span>
          <span className="text-fg-dim/40">·</span>
          <span>{i18n.t('{count} items', { count: rows.length })}</span>
        </div>
      </div>
      {selection && selectedGvk && (
        <DetailsPanel
          clusterId={clusterId}
          gvk={selectedGvk}
          kindKey={selection.key}
          selection={selection}
          liveObject={selectedObj}
          isActive={isActive}
          apiResources={apiResources}
          viewKey={VIEW.gitops}
        />
      )}
      {menu && (
        <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/** Kind key of a row's object. */
function keyForRow(r: GitOpsRow): string {
  return r.kind === 'Application'
    ? GITOPS_KEYS.application
    : r.kind === 'Kustomization'
      ? GITOPS_KEYS.kustomization
      : GITOPS_KEYS.helmRelease;
}
