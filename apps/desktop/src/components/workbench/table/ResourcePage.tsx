import * as i18n from '@/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  BookmarkX,
  BookOpenText,
  Download,
  Lock,
  Loader2,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { accessCheck } from '@/lib/kube/access';
import { apiVersionOf } from '@/lib/kube/catalog';
import { kindIcon } from '@/lib/kube/icons';
import { viewLabel } from '@/lib/kube/nav';
import { templateFor } from '@/lib/kube/templates';
import { cn } from '@/lib/cn';
import { useCan } from '@/store/useAccessStore';
import { sameObject, useBookmarksStore } from '@/store/useBookmarksStore';
import { dock } from '@/store/useDockStore';
import { openExplain } from '@/store/useExplainStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { AccessCheck, ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { deniedMessage, OPEN_GATE, useActionGates } from '../access/gates';
import { PermissionExplainer } from '../access/PermissionExplainer';
import { bulkActions } from '../actions/bulkActions';
import { resourceActions } from '../actions/resourceActions';
import { useCluster } from '../data/hooks';
import { restartWatch } from '../data/watchCache';
import { DetailsPanel } from '../details/DetailsPanel';
import { toggleObjectBookmark } from '../nav/bookmarkActions';
import { useEvent } from '../util';
import { ColumnMenu } from './ColumnMenu';
import { ExportDialog } from './ExportDialog';
import { requestExport, useTableExport } from './exportStore';
import { applyDefaultViewOnce, useSaveViewDialog } from './savedViews';
import { SavedViewsMenu } from './SavedViewsMenu';
import { SaveViewDialog } from './SaveViewDialog';
import { ResourceTable } from './ResourceTable';
import { SELECTION_BAR_INSET, SelectionBar } from './SelectionBar';
import { TableEmpty, TableError, TableSkeleton } from './TableStates';
import { useKindTable } from './useKindTable';

/** A kind's list page: toolbar, virtualized table, bulk actions and the details panel. */
export function ResourcePage({
  clusterId,
  kindKey,
  gvk,
  namespaces,
  isActive,
  apiResources,
}: {
  clusterId: string;
  kindKey: string;
  gvk: Gvk;
  namespaces: string[];
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const { cluster, readOnly } = useCluster(clusterId);
  const t = useKindTable({ clusterId, kindKey, gvk, namespaces, active: isActive, apiResources });
  const selection = useWorkbenchStore((s) => s.selection[clusterId]?.[kindKey] ?? null);
  const revealKey = useWorkbenchStore((s) => s.navRevision[`${clusterId}|${kindKey}`] ?? 0);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const lastIndex = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; obj: KubeObject } | null>(null);
  const [explain, setExplain] = useState<AccessCheck[] | null>(null);
  const label = viewLabel(kindKey, apiResources);
  const Icon = kindIcon(kindKey);
  const store = useWorkbenchStore.getState;

  useEffect(() => {
    setChecked(new Set());
    lastIndex.current = null;
  }, [kindKey, namespaces]);
  // Saved views: a kind's default view applies the first time its table opens.
  useEffect(() => applyDefaultViewOnce(clusterId, kindKey), [clusterId, kindKey]);
  // Dialogs requested for this table must not pop up later when it closes first.
  useEffect(
    () => () => {
      const mine = (t: { clusterId: string; kindKey: string } | null) =>
        t?.clusterId === clusterId && t.kindKey === kindKey;
      if (mine(useTableExport.getState().request)) useTableExport.getState().close();
      if (mine(useSaveViewDialog.getState().target)) useSaveViewDialog.getState().close();
    },
    [clusterId, kindKey],
  );
  const saveViewOpen = useSaveViewDialog(
    (s) => s.target?.clusterId === clusterId && s.target.kindKey === kindKey,
  );
  // Drop checks for objects that disappeared.
  useEffect(() => {
    setChecked((prev) => {
      if (!prev.size) return prev;
      const next = new Set([...prev].filter((uid) => t.snapshot.byUid.has(uid)));
      return next.size === prev.size ? prev : next;
    });
  }, [t.snapshot.byUid]);

  const selectedObj = useMemo(() => {
    if (!selection) return null;
    return (
      t.snapshot.items.find(
        (o) =>
          o.metadata.name === selection.name &&
          (o.metadata.namespace ?? null) === (selection.namespace ?? null),
      ) ?? null
    );
  }, [selection, t.snapshot.items]);

  const onOpen = useEvent((obj: KubeObject) =>
    store().select(clusterId, kindKey, {
      key: kindKey,
      namespace: obj.metadata.namespace ?? null,
      name: obj.metadata.name,
    }),
  );
  const onToggle = useEvent((uid: string, index: number, shift: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (shift && lastIndex.current !== null) {
        const [a, b] = [Math.min(lastIndex.current, index), Math.max(lastIndex.current, index)];
        const on = !prev.has(uid);
        for (const o of t.items.slice(a, b + 1))
          on ? next.add(o.metadata.uid) : next.delete(o.metadata.uid);
      } else if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
    lastIndex.current = index;
  });
  const onToggleAll = useEvent(() =>
    setChecked((prev) =>
      t.items.length && t.items.every((o) => prev.has(o.metadata.uid))
        ? new Set()
        : new Set(t.items.map((o) => o.metadata.uid)),
    ),
  );
  const onContextMenu = useEvent((e: React.MouseEvent, obj: KubeObject) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, obj });
  });
  const onSort = useCallback(
    (column: string) => store().setSort(kindKey, column),
    [kindKey, store],
  );
  const onResizeColumn = useCallback(
    (column: string, width: number | null) => store().setColumnWidth(kindKey, column, width),
    [kindKey, store],
  );

  const menuActions = useMemo(
    () => (menu ? resourceActions({ clusterId, cluster, gvk, obj: menu.obj }) : []),
    [menu, clusterId, cluster, gvk],
  );
  const menuGates = useActionGates(clusterId, menuActions, readOnly);
  const menuItems = useMemo((): FileContextMenuEntry[] => {
    if (!menu) return [];
    const { name, namespace = null } = menu.obj.metadata;
    const bookmarked = useBookmarksStore
      .getState()
      .bookmarks.some((b) => sameObject(b, clusterId, gvk, namespace, name));
    const entries: FileContextMenuEntry[] = [
      { id: 'open', label: i18n.t('Show details'), onClick: () => onOpen(menu.obj) },
      {
        id: 'bookmark',
        label: bookmarked ? i18n.t('Remove bookmark') : i18n.t('Bookmark'),
        icon: bookmarked ? <BookmarkX size={12} /> : <Bookmark size={12} />,
        onClick: () => toggleObjectBookmark(clusterId, gvk, namespace, name),
      },
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
  }, [menu, menuActions, menuGates, onOpen, clusterId, gvk]);

  const onClearChecked = useEvent(() => setChecked(new Set()));
  const onSelectAll = useEvent(() => setChecked(new Set(t.items.map((o) => o.metadata.uid))));
  // Bulk actions only reach checked rows the current filter still shows.
  const targets = useMemo(
    () => (checked.size ? t.items.filter((o) => checked.has(o.metadata.uid)) : []),
    [checked, t.items],
  );
  const onExportSelected = useEvent(() =>
    requestExport({ clusterId, kindKey, format: 'csv', selection: true }),
  );
  const bulk = useMemo(
    () =>
      bulkActions({
        clusterId,
        cluster,
        gvk,
        label,
        targets,
        onDeleted: onClearChecked,
        onExport: onExportSelected,
      }),
    [clusterId, cluster, gvk, label, targets, onClearChecked, onExportSelected],
  );
  const exportRequest = useTableExport((s) =>
    s.request?.clusterId === clusterId && s.request.kindKey === kindKey ? s.request : null,
  );

  const scopeNs =
    namespaces.length === 1 ? namespaces[0]! : (cluster?.default_namespace ?? 'default');
  const { status, error, forbidden, synced } = t.snapshot;
  const loading = !synced && status !== 'error';
  const createCheck = useMemo(
    () => (readOnly ? null : accessCheck('create', gvk, { namespace: scopeNs })),
    [readOnly, gvk, scopeNs],
  );
  const canCreate = useCan(clusterId, createCheck);
  // "Why?" on a forbidden list: one check per namespace in scope.
  const listChecks = () =>
    gvk.namespaced && namespaces.length
      ? namespaces.map((namespace) => accessCheck('list', gvk, { namespace }))
      : [accessCheck('list', gvk)];

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-fg max-w-[40%] shrink-0 truncate text-[13px] font-semibold">
            {label}
          </h2>
          <span className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
            {t.filter ? `${t.items.length}/${t.snapshot.items.length}` : t.snapshot.items.length}
          </span>
          <SavedViewsMenu clusterId={clusterId} kindKey={kindKey} />
          {gvk.namespaced && (
            <span className="text-fg-dim hidden truncate text-[11px] lg:inline">
              {namespaces.length === 0
                ? i18n.t('All namespaces')
                : namespaces.length === 1
                  ? namespaces[0]
                  : i18n.t('{count} namespaces', { count: namespaces.length })}
            </span>
          )}
          {status === 'loading' && synced && (
            <Loader2 className="text-fg-dim h-3 w-3 animate-spin" aria-label={i18n.t('Syncing')} />
          )}
          <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1.5">
            <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-56 min-w-24 shrink items-center gap-2 rounded-lg border px-2.5 transition-colors">
              <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
              <input
                value={t.filter}
                onChange={(e) => store().setFilter(clusterId, kindKey, e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && store().setFilter(clusterId, kindKey, '')}
                placeholder={i18n.t('Filter {kind}…', { kind: label })}
                aria-label={i18n.t('Filter {kind}', { kind: label })}
                title={i18n.t('Matches name, namespace and labels (key=value)')}
                className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
              />
              {t.filter && (
                <button
                  type="button"
                  onClick={() => store().setFilter(clusterId, kindKey, '')}
                  aria-label={i18n.t('Clear filter')}
                  className="text-fg-dim hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <IconButton
              label={i18n.t('Export {kind}…', { kind: label })}
              icon={<Download />}
              disabled={!t.items.length}
              onClick={() =>
                requestExport({ clusterId, kindKey, format: 'csv', selection: targets.length > 0 })
              }
            />
            <ColumnMenu kind={kindKey} columns={t.orderedColumns} hidden={t.hidden} />
            <IconButton
              label={i18n.t('Explain the fields of {kind}', { kind: gvk.kind })}
              icon={<BookOpenText />}
              onClick={() =>
                openExplain(clusterId, { apiVersion: apiVersionOf(gvk), kind: gvk.kind })
              }
            />
            <IconButton
              label={
                readOnly
                  ? i18n.t('Read-only cluster: changes are blocked')
                  : canCreate === 'denied' && createCheck
                    ? `${i18n.t('Create {kind}', { kind: gvk.kind })} — ${deniedMessage(createCheck)}`
                    : i18n.t('Create {kind}', { kind: gvk.kind })
              }
              icon={<Plus />}
              disabled={readOnly || canCreate === 'denied'}
              onClick={() =>
                dock.create(clusterId, gvk.namespaced ? scopeNs : null, templateFor(gvk, scopeNs))
              }
            />
          </div>
        </div>
        {status === 'error' && error ? (
          <TableError
            error={error}
            forbidden={forbidden}
            onRetry={() => restartWatch(clusterId, gvk, t.watchNs)}
            onExplain={() => setExplain(listChecks())}
          />
        ) : loading && !t.snapshot.items.length ? (
          <TableSkeleton />
        ) : !t.items.length ? (
          <TableEmpty
            filtered={!!t.filter}
            kind={label}
            onClear={() => store().setFilter(clusterId, kindKey, '')}
          />
        ) : (
          <ResourceTable
            label={label}
            items={t.items}
            columns={t.visibleColumns}
            ctx={t.ctx}
            sort={t.sort}
            onSort={onSort}
            checked={checked}
            onToggle={onToggle}
            onToggleAll={onToggleAll}
            activeUid={selectedObj?.metadata.uid ?? null}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            selectable
            revealKey={revealKey}
            bottomInset={targets.length ? SELECTION_BAR_INSET : 0}
            onResizeColumn={onResizeColumn}
          />
        )}
        {targets.length > 0 && (
          <SelectionBar
            clusterId={clusterId}
            count={targets.length}
            total={t.items.length}
            actions={bulk}
            readOnly={readOnly}
            isActive={isActive}
            onSelectAll={onSelectAll}
            onClear={onClearChecked}
          />
        )}
        <div className="border-border/60 text-fg-dim flex h-7 shrink-0 items-center gap-2 border-t px-4 text-[11px] tabular-nums">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              status === 'error'
                ? 'bg-status-error'
                : synced && isActive
                  ? 'bg-status-running animate-breathe'
                  : 'bg-fg-dim/50',
            )}
          />
          <span>
            {status === 'error'
              ? i18n.t('Watch failed')
              : !isActive
                ? i18n.t('Paused')
                : synced
                  ? i18n.t('Live')
                  : i18n.t('Loading…')}
          </span>
          <span className="text-fg-dim/40">·</span>
          <span>{i18n.t('{count} items', { count: t.snapshot.items.length })}</span>
          {kindKey === 'pods' && !t.ctx.podMetrics.available && synced && (
            <>
              <span className="text-fg-dim/40">·</span>
              <span>{i18n.t('Metrics unavailable')}</span>
            </>
          )}
        </div>
      </div>
      {selection && (
        <DetailsPanel
          clusterId={clusterId}
          gvk={gvk}
          kindKey={kindKey}
          selection={selection}
          liveObject={selectedObj}
          isActive={isActive}
          apiResources={apiResources}
        />
      )}
      {menu && (
        <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {exportRequest && (
        <ExportDialog
          request={exportRequest}
          clusterName={cluster?.name ?? clusterId}
          label={label}
          gvk={gvk}
          columns={t.visibleColumns}
          items={t.items}
          selected={targets}
          ctx={t.ctx}
          onClose={() => useTableExport.getState().close()}
        />
      )}
      {saveViewOpen && (
        <SaveViewDialog
          clusterId={clusterId}
          clusterName={cluster?.name ?? clusterId}
          kindKey={kindKey}
          label={label}
          namespaced={gvk.namespaced}
          onClose={() => useSaveViewDialog.getState().close()}
        />
      )}
      {explain && (
        <PermissionExplainer
          clusterId={clusterId}
          checks={explain}
          namespaced={gvk.namespaced}
          onClose={() => setExplain(null)}
        />
      )}
    </div>
  );
}
