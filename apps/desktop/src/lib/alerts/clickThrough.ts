/**
 * Desktop notification click-through.
 *
 * `tauri-plugin-notification` reports no clicks on desktop, but clicking a
 * notification brings Kubepit to the front. So the notifier window remembers
 * what the last notification it posted while no Kubepit window was focused
 * would open, and runs it when it gains focus itself within
 * `CLICK_WINDOW_MS`. Documented limitations: bringing that window to the
 * front by other means within that time does the same, and a click that
 * brings another Kubepit window to the front opens nothing.
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

/**
 * Whether a notification for `notices` was posted with no Kubepit window in
 * front, so a focus soon after is its click. `documentFocused` is this
 * window; `app_focused` covers every window when the alerts were raised.
 */
export function postedInBackground(
  documentFocused: boolean,
  notices: readonly { app_focused: boolean }[],
): boolean {
  return !documentFocused && notices.every((n) => !n.app_focused);
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
