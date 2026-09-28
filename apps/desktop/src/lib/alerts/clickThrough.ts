/**
 * Desktop notification click-through.
 *
 * `tauri-plugin-notification` reports no clicks on desktop, but clicking a
 * notification brings Kubepit to the front. So the notifier window remembers
 * what the last notification it posted while Kubepit was in the background
 * would open, and runs it when a Kubepit window gains focus within
 * `CLICK_WINDOW_MS`. Bringing Kubepit to the front by other means within
 * that time does the same (a documented limitation).
 */

/** How long after posting a notification focusing Kubepit counts as its click. */
export const CLICK_WINDOW_MS = 10_000;

export interface ClickThrough {
  /** A notification that opens `run` was posted at `now`; it replaces an older one. */
  posted(run: () => void, now: number): void;
  /** Kubepit gained focus at `now`: the pending action, at most once, or null. */
  focused(now: number): (() => void) | null;
  /** Forget the pending action. */
  clear(): void;
}

export function createClickThrough(windowMs: number = CLICK_WINDOW_MS): ClickThrough {
  let pending: { run: () => void; at: number } | null = null;
  return {
    posted(run, now) {
      pending = { run, at: now };
    },
    focused(now) {
      const last = pending;
      pending = null;
      if (!last || now - last.at > windowMs) return null;
      return last.run;
    },
    clear() {
      pending = null;
    },
  };
}
