import * as i18n from '@/i18n';
import { useEffect, useMemo } from 'react';
import { Bookmark as BookmarkIcon, ChevronDown, LayoutList, TriangleAlert, X } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { kindIcon } from '@/lib/kube/icons';
import { kindKey } from '@/lib/kube/catalog';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import {
  useBookmarksStore,
  type Bookmark,
  type BookmarkLiveness,
  type ObjectBookmark,
} from '@/store/useBookmarksStore';
import { useSavedViewsStore } from '@/store/useSavedViewsStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { bookmarkText, isStale, openBookmark } from './bookmarkActions';

const RECHECK_MS = 60_000;
const CONCURRENCY = 4;
const NOT_FOUND = /\bnot found\b|\b404\b/i;

/**
 * Checks that bookmarked objects still exist while the cluster is
 * connected and the group is open: a 404 marks the bookmark stale, any
 * other failure (RBAC, network) leaves it unknown.
 */
function useBookmarkLiveness(clusterId: string, objects: ObjectBookmark[], enabled: boolean) {
  const key = objects.map((b) => b.id).join(',');
  useEffect(() => {
    if (!enabled || !objects.length) return;
    let cancelled = false;
    const check = async () => {
      const queue = [...objects];
      const updates: Record<string, BookmarkLiveness> = {};
      const worker = async () => {
        for (let b = queue.shift(); b && !cancelled; b = queue.shift()) {
          const bookmark = b;
          updates[bookmark.id] = await ipc
            .resourceGet(clusterId, bookmark.gvk, bookmark.namespace, bookmark.name)
            .then(
              () => 'ok' as const,
              (e: unknown) => (NOT_FOUND.test(String(e)) ? 'missing' : 'unknown'),
            );
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (!cancelled) useBookmarksStore.getState().setLiveness(updates);
    };
    void check();
    const timer = window.setInterval(() => {
      if (!document.hidden) void check();
    }, RECHECK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `key` stands for the list of bookmark ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, key, enabled]);
}

/** "Bookmarks" group at the top of the resource navigator (this cluster's bookmarks). */
export function BookmarksSection({ clusterId }: { clusterId: string }) {
  i18n.useLocale();
  const all = useBookmarksStore((s) => s.bookmarks);
  const liveness = useBookmarksStore((s) => s.liveness);
  // Re-render when saved views change (view bookmark titles, stale views).
  useSavedViewsStore((s) => s.views);
  const collapsed = useWorkbenchStore((s) => !!s.collapsedGroups.bookmarks);
  const connected = useAppStore((s) => s.statuses[clusterId]?.state === 'connected');
  const bookmarks = useMemo(() => all.filter((b) => b.clusterId === clusterId), [all, clusterId]);
  const objects = useMemo(
    () => bookmarks.filter((b): b is ObjectBookmark => b.type === 'object'),
    [bookmarks],
  );
  useBookmarkLiveness(clusterId, objects, connected && !collapsed);

  if (!bookmarks.length) return null;
  return (
    <section aria-label={i18n.t('Bookmarks')}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => useWorkbenchStore.getState().toggleGroup('bookmarks')}
        className="text-fg-dim hover:text-fg-muted hover:bg-fg/3 mt-1 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[10.5px] font-semibold tracking-[0.12em] uppercase transition-colors"
      >
        <ChevronDown
          className={cn('h-3 w-3 shrink-0 transition-transform', collapsed && '-rotate-90')}
        />
        <BookmarkIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{i18n.t('Bookmarks')}</span>
        <span className="text-fg-dim/70 font-normal tracking-normal tabular-nums">
          {bookmarks.length}
        </span>
      </button>
      {!collapsed &&
        bookmarks.map((b) => <BookmarkRow key={b.id} bookmark={b} stale={isStale(b, liveness)} />)}
    </section>
  );
}

function BookmarkRow({ bookmark, stale }: { bookmark: Bookmark; stale: boolean }) {
  i18n.useLocale();
  const { title, detail } = bookmarkText(bookmark);
  const Icon = bookmark.type === 'object' ? kindIcon(kindKey(bookmark.gvk)) : LayoutList;
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => openBookmark(bookmark)}
        title={stale ? i18n.t('{name} no longer exists', { name: title }) : `${title}\n${detail}`}
        className={cn(
          'hover:bg-fg/4 relative flex w-full items-center gap-2 rounded-md py-[5px] pr-7 pl-2.5 text-left text-[12.5px] transition-colors',
          stale ? 'text-fg-dim/70' : 'text-fg-muted hover:text-fg',
        )}
      >
        {stale ? (
          <TriangleAlert className="text-status-starting h-3.5 w-3.5 shrink-0" />
        ) : (
          <Icon className="text-fg-dim group-hover:text-fg-muted h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', stale && 'line-through')}>{title}</span>
          <span className="text-fg-dim block truncate text-[10.5px]">
            {stale ? i18n.t('Missing') : detail}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={i18n.t('Remove bookmark')}
        title={i18n.t('Remove bookmark')}
        onClick={() => useBookmarksStore.getState().remove(bookmark.id)}
        className={cn(
          'text-fg-dim hover:text-fg absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition',
          stale ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
