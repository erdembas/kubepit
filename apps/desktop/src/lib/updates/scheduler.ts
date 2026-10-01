/** Give the initial workspace a moment to settle before the first network check. */
export const STARTUP_UPDATE_DELAY_MS = 8_000;
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

/** Completion-based polling never overlaps a slow request or resumes after cleanup. */
export function startUpdateScheduler(check: () => Promise<void>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    try {
      await check();
    } catch {
      // The store reports errors. A failed check must not stop later checks.
    } finally {
      if (!stopped) timer = setTimeout(() => void run(), UPDATE_CHECK_INTERVAL_MS);
    }
  };
  timer = setTimeout(() => void run(), STARTUP_UPDATE_DELAY_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
