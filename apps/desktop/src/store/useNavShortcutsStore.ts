import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { BUILTIN } from '@/lib/kube/catalog';
import { VIEW_KEYS } from '@/lib/kube/nav';
import { syncPreferences, windowStorage } from './windowStorage';

/**
 * Keyboard shortcuts for the cluster navigator's left menu items (Pods,
 * Services, Ingresses, …). One chord opens one kind; the chord is shown as a
 * badge on the navigator row and fired by `KeyboardHost` while a cluster
 * workbench is focused. Shortcuts are user-editable in Settings → Keyboard;
 * only the most-used kinds have a default, every other kind can be assigned.
 *
 * Persisted to `kubepit.nav-shortcuts.v1` and shared across windows like the
 * other layout prefs. A chord maps to at most one kind: assigning it to a new
 * kind clears it from the previous one.
 */

/** Default shortcuts for the important kinds (Alt+1…9). */
export const DEFAULT_NAV_SHORTCUTS: Record<string, string> = {
  [VIEW_KEYS.clusterOverview]: 'alt+1',
  [BUILTIN.Pod.key]: 'alt+2',
  [BUILTIN.Deployment.key]: 'alt+3',
  [BUILTIN.Service.key]: 'alt+4',
  [BUILTIN.Ingress.key]: 'alt+5',
  [BUILTIN.Namespace.key]: 'alt+6',
  [BUILTIN.Node.key]: 'alt+7',
  [BUILTIN.ConfigMap.key]: 'alt+8',
  [BUILTIN.Secret.key]: 'alt+9',
};

interface NavShortcutsState {
  /** Effective shortcut per navigator key; missing or '' = unassigned. */
  shortcuts: Record<string, string>;
  /**
   * Kind key the settings page should focus its shortcut capture on next time
   * it mounts (set by “Assign shortcut” in the navigator context menu). Not
   * persisted; consumed and cleared by the settings section.
   */
  pendingFocusKey: string | null;
  /** Set (or clear with an empty chord) the shortcut for a navigator key. */
  setShortcut: (key: string, chord: string) => void;
  /** Remove the shortcut for a navigator key. */
  clearShortcut: (key: string) => void;
  /** Restore the default shortcuts for the important kinds. */
  resetDefaults: () => void;
  /** Ask the settings page to focus the capture for a kind. */
  requestFocus: (key: string) => void;
  /** Clear the pending focus request. */
  clearFocus: () => void;
}

const STORAGE_KEY = 'kubepit.nav-shortcuts.v1';
const STORAGE_VERSION = 1;
const PREF_KEYS = ['shortcuts'] as const;
type Persisted = Pick<NavShortcutsState, (typeof PREF_KEYS)[number]>;

export const useNavShortcutsStore = create<NavShortcutsState>()(
  persist<NavShortcutsState, [], [], Persisted>(
    (set) => ({
      shortcuts: { ...DEFAULT_NAV_SHORTCUTS },
      pendingFocusKey: null,
      setShortcut: (key, chord) =>
        set((s) => {
          const next = { ...s.shortcuts };
          const value = chord.trim();
          // A chord maps to at most one navigator item.
          if (value) {
            for (const [k, c] of Object.entries(next)) if (c === value && k !== key) delete next[k];
            next[key] = value;
          } else {
            delete next[key];
          }
          return { shortcuts: next };
        }),
      clearShortcut: (key) =>
        set((s) => {
          if (!(key in s.shortcuts)) return {};
          const next = { ...s.shortcuts };
          delete next[key];
          return { shortcuts: next };
        }),
      resetDefaults: () => set({ shortcuts: { ...DEFAULT_NAV_SHORTCUTS } }),
      requestFocus: (key) => set({ pendingFocusKey: key }),
      clearFocus: () => set({ pendingFocusKey: null }),
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: windowStorage<Persisted>({
        session: [],
        seed: null,
        version: STORAGE_VERSION,
      }),
      // Defaults fill in for kinds the user has not touched; user edits (and
      // explicit clears) win. New defaults added in a release appear for keys
      // the user never assigned.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Persisted>;
        const user = (p.shortcuts ?? {}) as Record<string, string>;
        return { ...current, shortcuts: { ...DEFAULT_NAV_SHORTCUTS, ...user } };
      },
      partialize: (s) => ({ shortcuts: s.shortcuts }),
    },
  ),
);

syncPreferences<NavShortcutsState>(STORAGE_KEY, PREF_KEYS, useNavShortcutsStore);

/** The chord bound to a navigator key, or '' when unassigned (outside React). */
export function shortcutForKey(key: string): string {
  return useNavShortcutsStore.getState().shortcuts[key] ?? '';
}

/** The navigator key bound to a chord, or undefined (outside React). */
export function shortcutForChord(chord: string): string | undefined {
  const shortcuts = useNavShortcutsStore.getState().shortcuts;
  for (const [key, c] of Object.entries(shortcuts)) if (c === chord) return key;
  return undefined;
}

/** The chord bound to a navigator key, or '' when unassigned (in React). */
export function useNavShortcut(key: string): string {
  return useNavShortcutsStore((s) => s.shortcuts[key] ?? '');
}
