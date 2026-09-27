import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { isMainWindow } from '@/lib/windowSeed';

/**
 * `persist` storage that splits a store between session and preferences
 * when several windows share one localStorage.
 *
 * The main window reads and writes the whole value as usual. Any other
 * window keeps the `session` keys to itself — in sessionStorage, which is
 * per window and survives a reload — starting from `seed` (its opener's
 * session) and falling back to main's persisted session; its preference
 * changes are merged into the shared value without touching main's session.
 * Pair with `syncPreferences` so every window picks those changes up live.
 */
export function windowStorage<S extends object>(options: {
  session: readonly (keyof S)[];
  seed: Partial<S> | null;
  /** The store's `persist` version: a seed comes from a window running this build. */
  version: number;
}): PersistStorage<S> {
  const isSession = (key: string) => (options.session as readonly string[]).includes(key);
  const split = (state: S) => {
    const session: Record<string, unknown> = {};
    const prefs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state))
      (isSession(key) ? session : prefs)[key] = value;
    return { session, prefs };
  };
  let seed = options.seed;

  return {
    getItem: (name) => {
      const shared = read<S>(localStorage, name);
      if (isMainWindow) return shared;
      const own = read<S>(sessionStorage, name);
      const fromSeed = seed;
      seed = null;
      const session = fromSeed ?? own?.state ?? {};
      if (!shared && !own && !fromSeed) return null;
      return {
        state: { ...(shared?.state ?? {}), ...session } as S,
        version: fromSeed ? options.version : (own?.version ?? shared?.version ?? options.version),
      };
    },
    setItem: (name, value) => {
      if (isMainWindow) return write(localStorage, name, value);
      const { session, prefs } = split(value.state);
      write(sessionStorage, name, { state: session as S, version: value.version });
      const shared = read<S>(localStorage, name);
      write(localStorage, name, {
        state: { ...(shared?.state ?? {}), ...prefs } as S,
        version: value.version,
      });
    },
    removeItem: (name) => {
      if (isMainWindow) localStorage.removeItem(name);
      else sessionStorage.removeItem(name);
    },
  };
}

/**
 * Apply preference changes another window wrote to `name`. Only keys whose
 * value actually differs are set, so the write this triggers here settles
 * instead of bouncing between windows.
 */
export function syncPreferences<S extends object>(
  name: string,
  prefs: readonly (keyof S)[],
  store: { getState: () => S; setState: (patch: Partial<S>) => void },
): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (event) => {
    if (event.key !== name || !event.newValue || event.storageArea !== localStorage) return;
    let next: Partial<S>;
    try {
      next = (JSON.parse(event.newValue) as StorageValue<S>).state;
    } catch {
      return;
    }
    const current = store.getState();
    const patch: Partial<S> = {};
    for (const key of prefs) {
      if (!(key in next)) continue;
      if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) patch[key] = next[key];
    }
    if (Object.keys(patch).length) store.setState(patch);
  });
}

function read<S>(area: Storage, name: string): StorageValue<S> | null {
  try {
    const raw = area.getItem(name);
    return raw ? (JSON.parse(raw) as StorageValue<S>) : null;
  } catch {
    return null;
  }
}

function write<S>(area: Storage, name: string, value: StorageValue<S>): void {
  try {
    area.setItem(name, JSON.stringify(value));
  } catch {
    /* Storage can be blocked; layout state is a convenience. */
  }
}
