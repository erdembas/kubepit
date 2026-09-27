import * as i18n from '@/i18n/core';
import {
  Bookmark,
  Braces,
  Download,
  FileCode2,
  LayoutList,
  RefreshCw,
  Save,
  Sheet,
} from 'lucide-react';
import { viewLabel } from '@/lib/kube/nav';
import { viewsFor, viewsOnCluster } from '@/lib/savedViews';
import type { ExportFormat } from '@/lib/tableExport';
import { bookmarkText, isStale, openBookmark } from '@/components/workbench/nav/bookmarkActions';
import { requestExport } from '@/components/workbench/table/exportStore';
import { applySavedView, useSaveViewDialog } from '@/components/workbench/table/savedViews';
import { useAppStore } from '@/store/useAppStore';
import { useBookmarksStore } from '@/store/useBookmarksStore';
import { useSavedViewsStore } from '@/store/useSavedViewsStore';
import { useUpdaterStore } from '@/store/useUpdaterStore';
import { gvkForCluster, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { PaletteFilter, PaletteItem } from './paletteItems';

/** Palette entries for bookmarks, saved views, table exports and updates. */

const BOOKMARKS_WITHOUT_QUERY = 8;

function matches(query: string, ...parts: Array<string | undefined | null>) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The resource table focused in the selected cluster, if any. */
function activeTable() {
  const clusterId = useAppStore.getState().selectedClusterId;
  if (!clusterId) return null;
  const kindKey = useWorkbenchStore.getState().activeKind[clusterId];
  if (!kindKey || !gvkForCluster(clusterId, kindKey)) return null;
  const apiResources = useWorkbenchStore.getState().apiResources[clusterId] ?? null;
  return { clusterId, kindKey, label: viewLabel(kindKey, apiResources) };
}

const EXPORTS: Array<{ format: ExportFormat; icon: typeof Sheet; label: () => string }> = [
  { format: 'csv', icon: Sheet, label: () => 'CSV' },
  { format: 'json', icon: Braces, label: () => 'JSON' },
  { format: 'yaml', icon: FileCode2, label: () => 'YAML' },
];

/** Sections to insert before the app actions (headers included). */
export function workbenchItems(query: string, filter: PaletteFilter): PaletteItem[] {
  const q = query.trim();
  const out: PaletteItem[] = [];

  if (filter === 'all' || filter === 'resources') {
    const clusters = useAppStore.getState().clusters;
    const { bookmarks, liveness } = useBookmarksStore.getState();
    const items = bookmarks
      .map((b): PaletteItem | null => {
        const cluster = clusters.find((c) => c.id === b.clusterId);
        if (!cluster) return null;
        const { title, detail } = bookmarkText(b);
        const stale = isStale(b, liveness);
        if (!matches(q, title, detail, cluster.name, 'bookmark')) return null;
        return {
          type: 'action',
          id: `bookmark:${b.id}`,
          label: title,
          hint: `${stale ? `${i18n.t('Missing')} · ` : ''}${detail} · ${cluster.name}`,
          icon: b.type === 'view' ? LayoutList : Bookmark,
          group: 'resources',
          run: () => openBookmark(b),
        };
      })
      .filter((x): x is PaletteItem => !!x);
    const shown = q ? items : items.slice(0, BOOKMARKS_WITHOUT_QUERY);
    if (shown.length) {
      out.push({ type: 'header', id: 'hdr-bookmarks', label: i18n.t('Bookmarks') });
      out.push(...shown);
    }
  }

  const table = activeTable();
  if (table && (filter === 'all' || filter === 'actions')) {
    const { clusterId, kindKey, label } = table;
    const views = useSavedViewsStore.getState().views;
    const own = viewsFor(views, clusterId, kindKey);
    const items: PaletteItem[] = [
      ...own.map((view): PaletteItem => ({
        type: 'action',
        id: `view:${view.id}`,
        label: i18n.t('Apply view “{name}”', { name: view.name }),
        hint: label,
        icon: LayoutList,
        keywords: 'saved view',
        group: 'actions',
        run: () => applySavedView(clusterId, view),
      })),
      {
        type: 'action',
        id: 'view:save',
        label: i18n.t('Save current view of {kind}…', { kind: label }),
        icon: Save,
        keywords: 'saved view',
        group: 'actions',
        run: () => useSaveViewDialog.getState().open(clusterId, kindKey),
      },
      ...EXPORTS.map((e): PaletteItem => ({
        type: 'action',
        id: `export:${e.format}`,
        label: i18n.t('Export {kind} as {format}…', { kind: label, format: e.label() }),
        icon: e.format === 'csv' ? Download : e.icon,
        keywords: 'export download save table',
        group: 'actions',
        run: () => requestExport({ clusterId, kindKey, format: e.format }),
      })),
    ];
    // With a query, views of the other kinds on this cluster too.
    if (q) {
      const apiResources = useWorkbenchStore.getState().apiResources[clusterId] ?? null;
      for (const view of viewsOnCluster(views, clusterId)) {
        if (view.kindKey === kindKey) continue;
        items.push({
          type: 'action',
          id: `view:${view.id}`,
          label: i18n.t('Open view “{name}”', { name: view.name }),
          hint: viewLabel(view.kindKey, apiResources),
          icon: LayoutList,
          keywords: 'saved view',
          group: 'actions',
          run: () => applySavedView(clusterId, view, true),
        });
      }
    }
    const shown = items.filter(
      (item) => item.type === 'action' && matches(q, item.label, item.keywords, item.hint),
    );
    if (shown.length) {
      out.push({
        type: 'header',
        id: 'hdr-table',
        label: i18n.t('{kind} table', { kind: label }),
      });
      out.push(...shown);
    }
  }
  return out;
}

/** Extra app actions (appended to the palette's "Actions"). */
export function updateActions(): PaletteItem[] {
  return [
    {
      type: 'action',
      id: 'check-updates',
      label: i18n.t('Check for updates'),
      icon: RefreshCw,
      keywords: 'update upgrade version release',
      group: 'actions',
      run: () =>
        void (async () => {
          const updater = useUpdaterStore.getState();
          const status = updater.status ?? (await updater.loadStatus());
          // Builds without a signing key explain that on the About & Updates page.
          if (!status?.configured) useAppStore.getState().openSettings('about');
          else await updater.check();
        })(),
    },
  ];
}
