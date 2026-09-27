import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '@/lib/ipc/invoke';
import type { SplitLayout } from '@/store/splitLayout';

/**
 * Which app window this is, and the state it was opened with.
 *
 * Every window runs the whole UI against one backend (connections, port
 * forwards, PTYs) and one origin (localStorage). `main` owns the persisted
 * session (cluster view layouts, namespaces); a window opened with "New
 * Window" starts as a copy of its opener — the `WindowSeed` the opener
 * stashes under the new window's label — and then keeps its session to
 * itself (see `store/windowStorage.ts`). Stores read this at creation, so
 * the module has no store dependencies.
 */

export const MAIN_WINDOW = 'main';

/** Tauri's window label; `?window=` in browser previews (`pnpm dev:ui`). */
export const windowLabel: string = (() => {
  if (isTauri) {
    try {
      return getCurrentWindow().label;
    } catch {
      return MAIN_WINDOW;
    }
  }
  if (typeof location === 'undefined') return MAIN_WINDOW;
  return new URLSearchParams(location.search).get('window') ?? MAIN_WINDOW;
})();

export const isMainWindow = windowLabel === MAIN_WINDOW;

/** The per-window part of the workbench store (see `useWorkbenchStore`). */
export interface WorkbenchSession {
  layouts: Record<string, SplitLayout>;
  activeKind: Record<string, string>;
  namespaces: Record<string, string[]>;
}

export interface WindowSeed {
  mainLayout: SplitLayout;
  workbench: WorkbenchSession;
}

const seedKey = (label: string) => `kubepit.window-seed.${label}`;

/** Hand `seed` to the window about to open as `label`. */
export function stashWindowSeed(label: string, seed: WindowSeed): void {
  try {
    localStorage.setItem(seedKey(label), JSON.stringify(seed));
  } catch {
    /* Storage can be blocked; the window then starts from the persisted session. */
  }
}

export function dropWindowSeed(label: string): void {
  try {
    localStorage.removeItem(seedKey(label));
  } catch {
    /* ignore */
  }
}

/** What this window was opened with; read and cleared once, at startup. */
export const windowSeed: WindowSeed | null = (() => {
  if (isMainWindow) return null;
  try {
    const raw = localStorage.getItem(seedKey(windowLabel));
    if (!raw) return null;
    localStorage.removeItem(seedKey(windowLabel));
    return JSON.parse(raw) as WindowSeed;
  } catch {
    return null;
  }
})();
