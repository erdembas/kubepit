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

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `incoming` with the entries `draft` changed against `base` (one level; nested values whole). */
function mergeEdits(draft: Plain, base: Plain, incoming: Plain): Plain {
  const next = { ...incoming };
  for (const key of new Set([...Object.keys(draft), ...Object.keys(base)])) {
    if (same(draft[key], base[key])) continue;
    if (key in draft) next[key] = draft[key];
    else delete next[key];
  }
  return next;
}

/**
 * The settings draft after the saved settings changed from `base` (what the
 * draft started from) to `incoming`, for example in another window or by an
 * instant save elsewhere in this one (the Recommendations header's switch).
 * An unchanged draft adopts `incoming`; a dirty one keeps the fields it
 * edited and takes the others from `incoming`. Groups of settings (plain
 * objects such as `recommendations`, `alerts`, `history`) are merged one
 * level deep, so editing one field of a group never reverts another field
 * of it saved meanwhile; arrays and deeper objects count as values.
 */
export function rebaseDraft<T extends object>(
  draft: T | null,
  base: T | null,
  incoming: T | null,
): T | null {
  if (!draft || !base || !incoming || same(draft, base)) return incoming;
  const next = { ...incoming };
  for (const key of Object.keys(draft) as Array<keyof T>) {
    const [d, b, i] = [draft[key], base[key], incoming[key]];
    if (same(d, b)) continue;
    next[key] = isPlain(d) && isPlain(b) && isPlain(i) ? (mergeEdits(d, b, i) as T[keyof T]) : d;
  }
  return next;
}
