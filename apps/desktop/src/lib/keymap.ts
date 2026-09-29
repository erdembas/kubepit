import * as i18n from '@/i18n/core';
import { IS_MAC } from '@/lib/platform';

/**
 * Data-driven key map of the k9s-style keyboard mode, plus the chord
 * helpers shared with custom action shortcuts.
 *
 * A *chord* is a canonical, lowercase string: modifiers in
 * `ctrl+alt+shift+meta` order, then one key — a letter, a digit, a typed
 * punctuation character (`?`, `:`, `/`; Shift is part of the character) or
 * a named key (`enter`, `escape`, `f5`, `up`). The backend normalises custom
 * action shortcuts to the same form (`custom_actions/model.rs`).
 */

export type KeyCommand =
  | 'down'
  | 'up'
  | 'top'
  | 'bottom'
  | 'open'
  | 'back'
  | 'filter'
  | 'command'
  | 'help'
  | 'logs'
  | 'shell'
  | 'edit'
  | 'yaml'
  | 'details'
  | 'delete'
  | 'kill'
  | 'restart'
  | 'scale'
  | 'port-forward';

export type KeyGroup = 'navigation' | 'actions' | 'general';

export interface KeyBinding {
  command: KeyCommand;
  /** Chords, first one shown first. */
  keys: string[];
  group: KeyGroup;
  label: () => string;
}

/** Keyboard mode bindings (active on workbench tables, outside inputs and editors). */
export const KEYMAP: readonly KeyBinding[] = [
  { command: 'down', keys: ['j', 'down'], group: 'navigation', label: () => i18n.t('Move down') },
  { command: 'up', keys: ['k', 'up'], group: 'navigation', label: () => i18n.t('Move up') },
  { command: 'top', keys: ['g'], group: 'navigation', label: () => i18n.t('Go to the first row') },
  {
    command: 'bottom',
    keys: ['shift+g'],
    group: 'navigation',
    label: () => i18n.t('Go to the last row'),
  },
  {
    command: 'open',
    keys: ['enter'],
    group: 'navigation',
    label: () => i18n.t('Open details'),
  },
  {
    command: 'back',
    keys: ['escape'],
    group: 'navigation',
    label: () => i18n.t('Close details or clear the filter'),
  },
  { command: 'filter', keys: ['/'], group: 'navigation', label: () => i18n.t('Filter the table') },
  { command: 'logs', keys: ['l'], group: 'actions', label: () => i18n.t('Logs') },
  { command: 'shell', keys: ['s'], group: 'actions', label: () => i18n.t('Shell') },
  { command: 'edit', keys: ['e'], group: 'actions', label: () => i18n.t('Edit') },
  { command: 'yaml', keys: ['y'], group: 'actions', label: () => i18n.t('YAML tab') },
  { command: 'details', keys: ['d'], group: 'actions', label: () => i18n.t('Details tab') },
  { command: 'delete', keys: ['ctrl+d'], group: 'actions', label: () => i18n.t('Delete') },
  {
    command: 'kill',
    // ⌃K is free on macOS (⌘K is the palette); elsewhere Ctrl+K is the palette.
    keys: [IS_MAC ? 'ctrl+k' : 'ctrl+shift+k'],
    group: 'actions',
    label: () => i18n.t('Kill pod (delete immediately)'),
  },
  { command: 'restart', keys: ['r'], group: 'actions', label: () => i18n.t('Restart') },
  { command: 'scale', keys: ['shift+s'], group: 'actions', label: () => i18n.t('Scale') },
  { command: 'port-forward', keys: ['f'], group: 'actions', label: () => i18n.t('Port forward') },
  { command: 'command', keys: [':'], group: 'general', label: () => i18n.t('Command bar') },
  { command: 'help', keys: ['?'], group: 'general', label: () => i18n.t('Keyboard help') },
];

export const KEY_GROUPS: ReadonlyArray<{ id: KeyGroup; label: () => string }> = [
  { id: 'navigation', label: () => i18n.t('Navigation') },
  { id: 'actions', label: () => i18n.t('Actions on the row') },
  { id: 'general', label: () => i18n.t('General') },
];

export interface GlobalShortcut {
  keys: string[];
  label: () => string;
}

const MOD = IS_MAC ? 'meta' : 'ctrl';

/** App-wide shortcuts (`useAppShortcuts`, the dock, UI zoom); they always win. */
export const GLOBAL_SHORTCUTS: readonly GlobalShortcut[] = [
  { keys: [`${MOD}+k`], label: () => i18n.t('Command palette') },
  { keys: [`${MOD}+shift+f`], label: () => i18n.t('Fleet search') },
  { keys: [`${MOD}+n`], label: () => i18n.t('Add cluster') },
  { keys: [`${MOD}+shift+n`], label: () => i18n.t('New window') },
  { keys: [`${MOD}+,`], label: () => i18n.t('Settings') },
  { keys: [`${MOD}+b`], label: () => i18n.t('Toggle the sidebar') },
  { keys: [`${MOD}+w`], label: () => i18n.t('Close tab (dock, view, then cluster)') },
  { keys: [`${MOD}+shift+w`], label: () => i18n.t('Close the cluster tab') },
  {
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => `${MOD}+${d}`),
    label: () => i18n.t('Switch to tab 1–9'),
  },
  { keys: [`${MOD}+shift+[`, `${MOD}+shift+]`], label: () => i18n.t('Previous / next tab') },
  { keys: ['ctrl+`'], label: () => i18n.t('Toggle the dock') },
  { keys: [`${MOD}+=`, `${MOD}+-`, `${MOD}+0`], label: () => i18n.t('Zoom in / out / reset') },
];

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

const NAMED: Record<string, string> = {
  Enter: 'enter',
  Escape: 'escape',
  Esc: 'escape',
  ' ': 'space',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const IGNORED = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified']);

/** The chord of a key event, or null for bare modifier presses. */
export function chordFromEvent(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (IGNORED.has(e.key)) return null;
  const combo = e.ctrlKey || e.altKey || e.metaKey;
  let key: string;
  let shift = e.shiftKey;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit(\d)$/.exec(e.code);
  if (combo && letter) key = letter[1]!.toLowerCase();
  else if (e.key.length === 1 && /[a-z]/i.test(e.key)) key = e.key.toLowerCase();
  else if (combo && digit) {
    key = digit[1]!;
    shift = false;
  } else if (NAMED[e.key]) key = NAMED[e.key]!;
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key.toLowerCase();
  else if (e.key.length === 1) {
    // Typed characters already carry Shift (`?`, `:`); Alt may change them on macOS.
    key = e.key;
    shift = false;
  } else return null;
  const mods = MODIFIER_ORDER.filter((m) =>
    m === 'ctrl' ? e.ctrlKey : m === 'alt' ? e.altKey : m === 'shift' ? shift : e.metaKey,
  );
  return [...mods, key].join('+');
}

/** Canonical chord of user input (`Shift+Ctrl+L` → `ctrl+shift+l`), or null when invalid. */
export function normalizeChord(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  let key: string;
  let head: string;
  if (text === '+') [head, key] = ['', '+'];
  else if (text.endsWith('++')) [head, key] = [text.slice(0, -2), '+'];
  else {
    const at = text.lastIndexOf('+');
    [head, key] = at < 0 ? ['', text] : [text.slice(0, at), text.slice(at + 1)];
  }
  const alias: Record<string, string> = {
    control: 'ctrl',
    option: 'alt',
    opt: 'alt',
    cmd: 'meta',
    command: 'meta',
    win: 'meta',
    super: 'meta',
  };
  const mods = new Set<string>();
  for (const part of head ? head.split('+') : []) {
    const name = alias[part] ?? part;
    if (!(MODIFIER_ORDER as readonly string[]).includes(name) || mods.has(name)) return null;
    mods.add(name);
  }
  if (key === 'esc' || key === 'escape' || !key) return null;
  if (key.length === 1) {
    if (mods.has('shift') && !/[a-z]/.test(key)) return null;
  } else if (
    !Object.values(NAMED).includes(key) &&
    !/^f([1-9]|1[0-2])$/.test(key) &&
    key !== 'space'
  )
    return null;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

const GLYPHS: Record<string, string> = IS_MAC
  ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
  : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };

const KEY_LABELS: Record<string, string> = {
  enter: '↵',
  escape: 'Esc',
  space: 'Space',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
  insert: 'Ins',
};

/** Display parts of a chord: `shift+g` → `['⇧', 'G']`, `j` → `['j']`. */
export function chordParts(chord: string): string[] {
  // `ctrl++` / `+`: the plus key itself.
  const plus = chord === '+' || chord.endsWith('++');
  const at = plus ? chord.length - 1 : chord.lastIndexOf('+');
  const head = at <= 0 ? '' : chord.slice(0, plus ? at - 1 : at);
  const key = plus ? '+' : at <= 0 ? chord : chord.slice(at + 1);
  const mods = head ? head.split('+') : [];
  const label =
    KEY_LABELS[key] ??
    (/^f\d+$/.test(key) ? key.toUpperCase() : mods.length ? key.toUpperCase() : key);
  return [...mods.map((m) => GLYPHS[m] ?? m), label];
}

/** A chord as one string (`⌃D`, `Ctrl+D`, `G`). */
export function formatChord(chord: string): string {
  const parts = chordParts(chord);
  return IS_MAC ? parts.join('') : parts.join('+');
}

export interface ShortcutConflict {
  /** Id of the custom action whose shortcut conflicts. */
  actionId: string;
  chord: string;
  kind: 'global' | 'keymap' | 'action';
  /** What it collides with (a label or another action's name). */
  with: string;
}

/** The binding that owns `chord` in keyboard mode, if any. */
export function keymapCommandFor(chord: string): KeyBinding | undefined {
  return KEYMAP.find((b) => b.keys.includes(chord));
}

export function globalShortcutFor(chord: string): GlobalShortcut | undefined {
  return GLOBAL_SHORTCUTS.find((s) => s.keys.includes(chord));
}

/**
 * Conflicts of custom action shortcuts with the app's global shortcuts,
 * the keyboard mode key map and each other (enabled actions only). Global
 * shortcuts and keyboard mode keys win, so the action's shortcut is unused.
 */
export function shortcutConflicts(
  actions: ReadonlyArray<{ id: string; name: string; enabled: boolean; shortcut: string | null }>,
): ShortcutConflict[] {
  const out: ShortcutConflict[] = [];
  const seen = new Map<string, string>();
  for (const a of actions) {
    if (!a.enabled || !a.shortcut) continue;
    const chord = a.shortcut;
    const global = globalShortcutFor(chord);
    if (global) out.push({ actionId: a.id, chord, kind: 'global', with: global.label() });
    const binding = keymapCommandFor(chord);
    if (binding) out.push({ actionId: a.id, chord, kind: 'keymap', with: binding.label() });
    const other = seen.get(chord);
    if (other !== undefined) out.push({ actionId: a.id, chord, kind: 'action', with: other });
    else seen.set(chord, a.name);
  }
  return out;
}
