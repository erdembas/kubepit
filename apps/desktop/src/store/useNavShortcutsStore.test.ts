import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN } from '@/lib/kube/catalog';
import { VIEW_KEYS } from '@/lib/kube/nav';
import {
  DEFAULT_NAV_SHORTCUTS,
  shortcutForChord,
  shortcutForKey,
  useNavShortcutsStore,
} from './useNavShortcutsStore';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  useNavShortcutsStore.setState({ shortcuts: { ...DEFAULT_NAV_SHORTCUTS } });
});

afterEach(() => vi.unstubAllGlobals());

const state = () => useNavShortcutsStore.getState();

describe('navigator shortcut defaults', () => {
  it('ships Alt+1…9 for the important kinds only', () => {
    expect(shortcutForKey(VIEW_KEYS.clusterOverview)).toBe('alt+1');
    expect(shortcutForKey(BUILTIN.Pod.key)).toBe('alt+2');
    expect(shortcutForKey(BUILTIN.Service.key)).toBe('alt+4');
    expect(shortcutForKey(BUILTIN.Ingress.key)).toBe('alt+5');
    expect(shortcutForKey(BUILTIN.Secret.key)).toBe('alt+9');
    // Less-used kinds start unassigned.
    expect(shortcutForKey(BUILTIN.DaemonSet.key)).toBe('');
    expect(shortcutForKey(BUILTIN.Job.key)).toBe('');
  });
});

describe('assigning shortcuts', () => {
  it('assigns a chord to a kind and resolves it back', () => {
    state().setShortcut(BUILTIN.DaemonSet.key, 'alt+4');
    expect(shortcutForKey(BUILTIN.DaemonSet.key)).toBe('alt+4');
    expect(shortcutForChord('alt+4')).toBe(BUILTIN.DaemonSet.key);
  });

  it('moves a chord off the previous owner so one chord opens one kind', () => {
    state().setShortcut(BUILTIN.DaemonSet.key, 'alt+2');
    expect(shortcutForKey(BUILTIN.Pod.key)).toBe('');
    expect(shortcutForKey(BUILTIN.DaemonSet.key)).toBe('alt+2');
    expect(shortcutForChord('alt+2')).toBe(BUILTIN.DaemonSet.key);
  });

  it('clears the shortcut with an empty chord and with clearShortcut', () => {
    state().setShortcut(BUILTIN.Pod.key, '');
    expect(shortcutForKey(BUILTIN.Pod.key)).toBe('');
    state().setShortcut(BUILTIN.Pod.key, 'alt+3');
    state().clearShortcut(BUILTIN.Pod.key);
    expect(shortcutForKey(BUILTIN.Pod.key)).toBe('');
  });

  it('trims whitespace when assigning', () => {
    state().setShortcut(BUILTIN.Job.key, '  alt+7  ');
    expect(shortcutForKey(BUILTIN.Job.key)).toBe('alt+7');
  });
});

describe('reset to defaults', () => {
  it('restores the default assignments after edits', () => {
    state().setShortcut(BUILTIN.DaemonSet.key, 'alt+2');
    state().clearShortcut(BUILTIN.Service.key);
    state().resetDefaults();
    expect(shortcutForKey(BUILTIN.Pod.key)).toBe('alt+2');
    expect(shortcutForKey(BUILTIN.Service.key)).toBe('alt+4');
    expect(shortcutForKey(BUILTIN.DaemonSet.key)).toBe('');
  });
});
