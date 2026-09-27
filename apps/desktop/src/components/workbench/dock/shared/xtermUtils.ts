import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Terminal } from '@xterm/xterm';

// Ported from RunHQ `components/terminalPaneUtils.ts`.

export const NERD_FONT_STACK =
  '"MesloLGS NF", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "FiraCode Nerd Font", "Hack Nerd Font", "Menlo", "Monaco", "Consolas", "Courier New", monospace';

export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains('dark')),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

/**
 * Decode the base64 payload that the Rust PTY pipeline ships through
 * `Channel<TerminalOutput>`. `atob` returns a binary string (one char per
 * byte), copied into a `Uint8Array` whose length equals the PTY chunk — the
 * exact byte count acknowledged back for flow control.
 */
export function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Write a red error banner into the xterm itself (shows up in scrollback). */
export function writeError(term: Terminal, message: string): void {
  term.write(`\r\n\x1b[31m✖ ${message}\x1b[0m\r\n`);
}

export interface MatchInfo {
  /** 1-indexed position of the active match for human display. */
  index: number;
  /** Total matches currently visible in the buffer. */
  count: number;
}

/** True for Cmd+F (macOS) / Ctrl+F without other modifiers. */
export function isFindShortcut(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'f'
  );
}

/** Ctrl+` toggles the dock; terminals must not swallow it. */
export function isDockToggleShortcut(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.code === 'Backquote' || event.key === '`')
  );
}
