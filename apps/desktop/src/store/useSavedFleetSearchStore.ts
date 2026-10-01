import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  MAX_PINNED_SEARCHES,
  MAX_SAVED_SEARCHES,
  MAX_SAVED_SEARCH_STORAGE,
  sanitizeSavedSearches,
  savedSearchName,
  searchSnapshot,
  type FleetSearchSnapshot,
  type SavedFleetSearch,
} from '@/lib/fleet/savedSearches';
import { windowStorage } from './windowStorage';

export const SAVED_FLEET_SEARCH_KEY = 'kubepit.savedFleetSearches.v1';
export type SavedSearchError =
  'invalid' | 'duplicate-name' | 'limit' | 'pin-limit' | 'missing' | 'storage';
export type SavedSearchResult =
  { ok: true; search: SavedFleetSearch } | { ok: false; error: SavedSearchError };
interface SavedFleetSearchState {
  searches: SavedFleetSearch[];
  save: (name: string, snapshot: FleetSearchSnapshot, pinned: boolean) => SavedSearchResult;
  rename: (id: string, name: string) => SavedSearchResult;
  setPinned: (id: string, pinned: boolean) => SavedSearchResult;
  remove: (id: string) => SavedSearchResult;
}
type Persisted = Pick<SavedFleetSearchState, 'searches'>;
const shared = windowStorage<Persisted>({ session: [], seed: null, version: 1 });

/** Saved queries must be durable before the UI reports success. The shared
 * layout adapter intentionally swallows quota/permission failures, so use a
 * strict write first. Every field here is a shared preference (no session
 * fields), and the following persist write stores the same envelope. */
function persistSearches(searches: SavedFleetSearch[]): boolean {
  try {
    localStorage.setItem(
      SAVED_FLEET_SEARCH_KEY,
      JSON.stringify({ state: { searches }, version: 1 }),
    );
    return true;
  } catch {
    return false;
  }
}

export const useSavedFleetSearchStore = create<SavedFleetSearchState>()(
  persist<SavedFleetSearchState, [], [], Persisted>(
    (set, get) => ({
      searches: [],
      save: (rawName, value, pinned) => {
        const name = savedSearchName(rawName);
        const snapshot = searchSnapshot(value);
        if (!name || !snapshot) return { ok: false, error: 'invalid' };
        const current = get().searches;
        if (current.length >= MAX_SAVED_SEARCHES) return { ok: false, error: 'limit' };
        if (current.some((item) => item.name.toLowerCase() === name.toLowerCase()))
          return { ok: false, error: 'duplicate-name' };
        if (pinned && current.filter((item) => item.pinned).length >= MAX_PINNED_SEARCHES)
          return { ok: false, error: 'pin-limit' };
        const search = {
          ...snapshot,
          id: crypto.randomUUID(),
          name,
          pinned,
          createdAt: Date.now(),
        };
        const searches = [search, ...current];
        if (!persistSearches(searches)) return { ok: false, error: 'storage' };
        set({ searches });
        return { ok: true, search };
      },
      rename: (id, rawName) => {
        const name = savedSearchName(rawName);
        if (!name) return { ok: false, error: 'invalid' };
        const current = get().searches;
        const found = current.find((item) => item.id === id);
        if (!found) return { ok: false, error: 'missing' };
        if (
          current.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())
        )
          return { ok: false, error: 'duplicate-name' };
        const search = { ...found, name };
        const searches = current.map((item) => (item.id === id ? search : item));
        if (!persistSearches(searches)) return { ok: false, error: 'storage' };
        set({ searches });
        return { ok: true, search };
      },
      setPinned: (id, pinned) => {
        const current = get().searches;
        const found = current.find((item) => item.id === id);
        if (!found) return { ok: false, error: 'missing' };
        if (
          pinned &&
          !found.pinned &&
          current.filter((item) => item.pinned).length >= MAX_PINNED_SEARCHES
        )
          return { ok: false, error: 'pin-limit' };
        const search = { ...found, pinned };
        const searches = current.map((item) => (item.id === id ? search : item));
        if (!persistSearches(searches)) return { ok: false, error: 'storage' };
        set({ searches });
        return { ok: true, search };
      },
      remove: (id) => {
        const current = get().searches;
        const search = current.find((item) => item.id === id);
        if (!search) return { ok: false, error: 'missing' };
        const searches = current.filter((item) => item.id !== id);
        if (!persistSearches(searches)) return { ok: false, error: 'storage' };
        set({ searches });
        return { ok: true, search };
      },
    }),
    {
      name: SAVED_FLEET_SEARCH_KEY,
      version: 1,
      storage: {
        ...shared,
        getItem: (name) => {
          try {
            // Guard before windowStorage parses either the shared preference
            // document or a secondary window's session envelope.
            if (
              (localStorage.getItem(name)?.length ?? 0) > MAX_SAVED_SEARCH_STORAGE ||
              (typeof sessionStorage !== 'undefined' &&
                (sessionStorage.getItem(name)?.length ?? 0) > MAX_SAVED_SEARCH_STORAGE)
            )
              return null;
            return shared.getItem(name);
          } catch {
            return null;
          }
        },
      },
      partialize: (state) => ({ searches: state.searches }),
      merge: (persisted, current) => ({
        ...current,
        searches: sanitizeSavedSearches((persisted as Partial<Persisted> | null)?.searches),
      }),
    },
  ),
);

/** Same shared-preference behavior as saved views, with schema checks on
 * cross-window updates as well as initial hydration. */
export function acceptSavedSearchStorage(raw: string | null): void {
  if (raw === null) {
    useSavedFleetSearchStore.setState({ searches: [] });
    return;
  }
  if (raw.length > MAX_SAVED_SEARCH_STORAGE) return;
  try {
    const value = JSON.parse(raw) as { version?: unknown; state?: { searches?: unknown } } | null;
    if (value?.version !== 1 || !Array.isArray(value.state?.searches)) return;
    const searches = sanitizeSavedSearches(value.state.searches);
    if (JSON.stringify(searches) !== JSON.stringify(useSavedFleetSearchStore.getState().searches))
      useSavedFleetSearchStore.setState({ searches });
  } catch {
    /* Ignore malformed cross-window data. */
  }
}

if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === SAVED_FLEET_SEARCH_KEY && event.storageArea === localStorage)
      acceptSavedSearchStorage(event.newValue);
  });
