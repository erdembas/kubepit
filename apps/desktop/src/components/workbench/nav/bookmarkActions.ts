import * as i18n from '@/i18n/core';
import { connectCluster } from '@/lib/clusterActions';
import { viewLabel } from '@/lib/kube/nav';
import { useAppStore } from '@/store/useAppStore';
import { type Bookmark, type BookmarkLiveness, useBookmarksStore } from '@/store/useBookmarksStore';
import { useSavedViewsStore } from '@/store/useSavedViewsStore';
import { navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { Gvk } from '@/types';
import { applySavedView } from '../table/savedViews';

/** Open a bookmark: connect its cluster if needed, then the object's details or the view. */
export function openBookmark(bookmark: Bookmark) {
  const app = useAppStore.getState();
  const state = app.statuses[bookmark.clusterId]?.state ?? 'disconnected';
  if (state === 'disconnected' || state === 'error') void connectCluster(bookmark.clusterId);
  if (bookmark.type === 'object') {
    navigateTo(bookmark.clusterId, bookmark.gvk, bookmark.namespace, bookmark.name);
    return;
  }
  const view = bookmark.viewId ? savedView(bookmark.viewId) : null;
  if (view) applySavedView(bookmark.clusterId, view, true);
  else useWorkbenchStore.getState().setActiveKind(bookmark.clusterId, bookmark.kindKey);
  if (app.activeMainTabKey !== `cluster:${bookmark.clusterId}`) app.openCluster(bookmark.clusterId);
}

function savedView(id: string) {
  return useSavedViewsStore.getState().views.find((v) => v.id === id) ?? null;
}

/** Title and subtitle of a bookmark row (Kubernetes names are never translated). */
export function bookmarkText(bookmark: Bookmark): { title: string; detail: string } {
  if (bookmark.type === 'object')
    return {
      title: bookmark.name,
      detail: bookmark.namespace
        ? `${bookmark.gvk.kind} · ${bookmark.namespace}`
        : bookmark.gvk.kind,
    };
  const apiResources = useWorkbenchStore.getState().apiResources[bookmark.clusterId] ?? null;
  const kind = viewLabel(bookmark.kindKey, apiResources);
  const view = bookmark.viewId ? savedView(bookmark.viewId) : null;
  return view
    ? { title: view.name, detail: i18n.t('{kind} view', { kind }) }
    : { title: kind, detail: i18n.t('Table') };
}

/** A view bookmark whose saved view was deleted, or an object that is gone. */
export function isStale(bookmark: Bookmark, liveness: Readonly<Record<string, BookmarkLiveness>>) {
  if (bookmark.type === 'view') return !!bookmark.viewId && !savedView(bookmark.viewId);
  return liveness[bookmark.id] === 'missing';
}

/** Toggle the bookmark of an object and say what happened. */
export function toggleObjectBookmark(
  clusterId: string,
  gvk: Gvk,
  namespace: string | null,
  name: string,
) {
  const added = useBookmarksStore.getState().toggleObject(clusterId, gvk, namespace, name);
  useAppStore
    .getState()
    .pushToast('success', added ? i18n.t('Bookmark added') : i18n.t('Bookmark removed'));
}
