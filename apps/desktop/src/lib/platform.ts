/**
 * Platform-aware keyboard shortcut labels.
 *
 * macOS users expect `⌘` / `Cmd`; Windows and Linux users expect `Ctrl` — VS
 * Code, Slack, Linear, Chrome, etc. all follow this convention, and mixing
 * them (e.g. showing `Cmd+K` to a Windows user) reads as "this app isn't for
 * me". We centralise the detection here so no component has to reinvent the
 * `navigator.userAgent` dance, and so a future Chromebook / iPad edge case
 * only needs fixing in one place.
 *
 * Intentionally a plain module-scope constant (not a hook). The platform
 * does not change during a session, so every render recomputing it would be
 * wasted work, and we want the value available from top-level consts too
 * (e.g. `SHORTCUT: '${MOD_SYMBOL}K'`).
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** `⌘` on macOS, `Ctrl` elsewhere — intended for compact `<kbd>` glyphs. */
export const MOD_SYMBOL = IS_MAC ? '⌘' : 'Ctrl';

/** `Cmd` on macOS, `Ctrl` elsewhere — intended for spelled-out prose. */
export const MOD_LABEL = IS_MAC ? 'Cmd' : 'Ctrl';

/**
 * Format a single-key shortcut ("1", "K", "N") with the platform's primary
 * modifier. macOS is contracted (`⌘K`) because the glyph itself reads as the
 * chord; Windows/Linux gets an explicit separator (`Ctrl+K`) because
 * `CtrlK` would be unreadable.
 */
export function modChord(key: string): string {
  return IS_MAC ? `${MOD_SYMBOL}${key}` : `${MOD_SYMBOL}+${key}`;
}
