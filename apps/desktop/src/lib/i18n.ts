import { initializeLocale } from '@/i18n/core';

let started = false;

/** Storage sync keeps every open window on the same language without a remount. */
export function initializeDesktopLocale() {
  if (started) return;
  started = true;
  const stop = initializeLocale();
  import.meta.hot?.dispose(() => {
    stop();
    started = false;
  });
}
