import type { Settings, SettingsChanged } from '@/types';

/**
 * The settings to apply from a `settings://changed` event, or null when this
 * window saved them itself: it already holds them, and applying its own
 * broadcast again would reset an open settings draft.
 */
export function remoteSettings(event: SettingsChanged, ownLabel: string): Settings | null {
  return event.source === ownLabel ? null : event.settings;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The settings draft after the saved settings changed from `base` (what the
 * draft started from) to `incoming`, for example in another window. An
 * unchanged draft adopts `incoming`; a dirty one keeps the fields it edited
 * and takes the others from `incoming`.
 */
export function rebaseDraft<T extends object>(
  draft: T | null,
  base: T | null,
  incoming: T | null,
): T | null {
  if (!draft || !base || !incoming || same(draft, base)) return incoming;
  const next = { ...incoming };
  for (const key of Object.keys(draft) as Array<keyof T>) {
    if (!same(draft[key], base[key])) next[key] = draft[key];
  }
  return next;
}
