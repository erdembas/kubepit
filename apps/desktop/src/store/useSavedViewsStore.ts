import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { defaultKey, uniqueName, type SavedView } from '@/lib/savedViews';
import { syncPreferences, windowStorage } from './windowStorage';

/**
 * Saved table views (see `lib/savedViews.ts`). Stored like column prefs:
 * persisted to localStorage (`kubepit.views.v1`), shared by every window
 * and synced live (`windowStorage.ts`). Which view a tab currently shows
 * is session state.
 */

interface SavedViewsState {
  views: SavedView[];
  /** Default view id per `defaultKey(clusterId, kindKey)`. */
  defaults: Record<string, string>;
  /** Session: the view last applied per `${clusterId}|${kindKey}`. */
  applied: Record<string, string>;

  /** Adds a view (its name made unique within kind and scope) and returns it. */
  save: (view: Omit<SavedView, 'id' | 'createdAt'>, makeDefault?: boolean) => SavedView;
  update: (id: string, patch: Partial<Omit<SavedView, 'id' | 'createdAt'>>) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  setDefault: (id: string, on: boolean) => void;
  markApplied: (clusterId: string, kindKey: string, id: string | null) => void;
}

const STORAGE_KEY = 'kubepit.views.v1';
const STORAGE_VERSION = 1;
const PREF_KEYS = ['views', 'defaults'] as const;
type Persisted = Pick<SavedViewsState, (typeof PREF_KEYS)[number]>;

export const useSavedViewsStore = create<SavedViewsState>()(
  persist<SavedViewsState, [], [], Persisted>(
    (set, get) => ({
      views: [],
      defaults: {},
      applied: {},

      save: (input, makeDefault = false) => {
        const view: SavedView = {
          ...input,
          name: uniqueName(get().views, input.name, input.kindKey, input.clusterId),
          id: crypto.randomUUID(),
          createdAt: Date.now(),
        };
        set((s) => ({
          views: [...s.views, view],
          defaults: makeDefault
            ? { ...s.defaults, [defaultKey(view.clusterId, view.kindKey)]: view.id }
            : s.defaults,
        }));
        return view;
      },
      update: (id, patch) =>
        set((s) => ({ views: s.views.map((v) => (v.id === id ? { ...v, ...patch, id } : v)) })),
      rename: (id, name) =>
        set((s) => {
          const view = s.views.find((v) => v.id === id);
          if (!view || !name.trim()) return {};
          const unique = uniqueName(s.views, name, view.kindKey, view.clusterId, id);
          return { views: s.views.map((v) => (v.id === id ? { ...v, name: unique } : v)) };
        }),
      remove: (id) =>
        set((s) => ({
          views: s.views.filter((v) => v.id !== id),
          defaults: Object.fromEntries(Object.entries(s.defaults).filter(([, v]) => v !== id)),
          applied: Object.fromEntries(Object.entries(s.applied).filter(([, v]) => v !== id)),
        })),
      setDefault: (id, on) =>
        set((s) => {
          const view = s.views.find((v) => v.id === id);
          if (!view) return {};
          const key = defaultKey(view.clusterId, view.kindKey);
          const defaults = { ...s.defaults };
          if (on) defaults[key] = id;
          else if (defaults[key] === id) delete defaults[key];
          return { defaults };
        }),
      markApplied: (clusterId, kindKey, id) =>
        set((s) => {
          const applied = { ...s.applied };
          if (id) applied[`${clusterId}|${kindKey}`] = id;
          else delete applied[`${clusterId}|${kindKey}`];
          return { applied };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: windowStorage<Persisted>({ session: [], seed: null, version: STORAGE_VERSION }),
      partialize: (s) => ({ views: s.views, defaults: s.defaults }),
    },
  ),
);

syncPreferences<SavedViewsState>(STORAGE_KEY, PREF_KEYS, useSavedViewsStore);
