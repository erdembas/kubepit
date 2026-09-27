import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Gvk } from '@/types';
import { syncPreferences, windowStorage } from './windowStorage';

/**
 * Bookmarks (Lens hotbar-like): objects (cluster + GVK + namespace + name)
 * and views (a kind's table on a cluster, optionally with a saved view).
 * Persisted like the layout prefs (`kubepit.bookmarks.v1`, shared by every
 * window). Whether a bookmarked object still exists is session state,
 * filled in by the navigator's liveness checks.
 */

export type Bookmark =
  | {
      id: string;
      type: 'object';
      clusterId: string;
      gvk: Gvk;
      namespace: string | null;
      name: string;
      createdAt: number;
    }
  | {
      id: string;
      type: 'view';
      clusterId: string;
      kindKey: string;
      /** Saved view applied when the bookmark opens; `null` = the table as it is. */
      viewId: string | null;
      createdAt: number;
    };

export type ObjectBookmark = Extract<Bookmark, { type: 'object' }>;
export type ViewBookmark = Extract<Bookmark, { type: 'view' }>;

/** `ok` exists, `missing` got a 404, `unknown` not checked (or the check failed otherwise). */
export type BookmarkLiveness = 'ok' | 'missing' | 'unknown';

interface BookmarksState {
  bookmarks: Bookmark[];
  /** Session: liveness per object bookmark id. */
  liveness: Record<string, BookmarkLiveness>;
  /** Adds the object, or removes it when already bookmarked. Returns true when added. */
  toggleObject: (clusterId: string, gvk: Gvk, namespace: string | null, name: string) => boolean;
  /** Adds the view, or removes it when already bookmarked. Returns true when added. */
  toggleView: (clusterId: string, kindKey: string, viewId: string | null) => boolean;
  remove: (id: string) => void;
  /** Drop view bookmarks of a deleted saved view. */
  forgetView: (viewId: string) => void;
  setLiveness: (updates: Record<string, BookmarkLiveness>) => void;
}

const STORAGE_KEY = 'kubepit.bookmarks.v1';
const STORAGE_VERSION = 1;
const PREF_KEYS = ['bookmarks'] as const;
type Persisted = Pick<BookmarksState, (typeof PREF_KEYS)[number]>;

export function sameObject(
  b: Bookmark,
  clusterId: string,
  gvk: Pick<Gvk, 'group' | 'kind'>,
  namespace: string | null,
  name: string,
): boolean {
  return (
    b.type === 'object' &&
    b.clusterId === clusterId &&
    b.gvk.group === gvk.group &&
    b.gvk.kind === gvk.kind &&
    (b.namespace ?? null) === (namespace ?? null) &&
    b.name === name
  );
}

export function sameView(
  b: Bookmark,
  clusterId: string,
  kindKey: string,
  viewId: string | null,
): boolean {
  return (
    b.type === 'view' && b.clusterId === clusterId && b.kindKey === kindKey && b.viewId === viewId
  );
}

export const useBookmarksStore = create<BookmarksState>()(
  persist<BookmarksState, [], [], Persisted>(
    (set, get) => ({
      bookmarks: [],
      liveness: {},

      toggleObject: (clusterId, gvk, namespace, name) => {
        const ns = gvk.namespaced ? namespace : null;
        const existing = get().bookmarks.find((b) => sameObject(b, clusterId, gvk, ns, name));
        if (existing) {
          get().remove(existing.id);
          return false;
        }
        const bookmark: Bookmark = {
          id: crypto.randomUUID(),
          type: 'object',
          clusterId,
          gvk: { ...gvk },
          namespace: ns,
          name,
          createdAt: Date.now(),
        };
        set((s) => ({ bookmarks: [...s.bookmarks, bookmark] }));
        return true;
      },
      toggleView: (clusterId, kindKey, viewId) => {
        const existing = get().bookmarks.find((b) => sameView(b, clusterId, kindKey, viewId));
        if (existing) {
          get().remove(existing.id);
          return false;
        }
        const bookmark: Bookmark = {
          id: crypto.randomUUID(),
          type: 'view',
          clusterId,
          kindKey,
          viewId,
          createdAt: Date.now(),
        };
        set((s) => ({ bookmarks: [...s.bookmarks, bookmark] }));
        return true;
      },
      remove: (id) =>
        set((s) => {
          const liveness = { ...s.liveness };
          delete liveness[id];
          return { bookmarks: s.bookmarks.filter((b) => b.id !== id), liveness };
        }),
      forgetView: (viewId) =>
        set((s) => ({
          bookmarks: s.bookmarks.filter((b) => b.type !== 'view' || b.viewId !== viewId),
        })),
      setLiveness: (updates) => set((s) => ({ liveness: { ...s.liveness, ...updates } })),
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: windowStorage<Persisted>({ session: [], seed: null, version: STORAGE_VERSION }),
      partialize: (s) => ({ bookmarks: s.bookmarks }),
    },
  ),
);

syncPreferences<BookmarksState>(STORAGE_KEY, PREF_KEYS, useBookmarksStore);
