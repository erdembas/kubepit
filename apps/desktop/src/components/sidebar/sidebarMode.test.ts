import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { setSidebarMode, sidebarModeOf } from './sidebarMode';

describe('sidebarModeOf', () => {
  it('maps pin and hover to a mode', () => {
    expect(sidebarModeOf(true, true)).toBe('expanded');
    expect(sidebarModeOf(true, false)).toBe('expanded');
    expect(sidebarModeOf(false, true)).toBe('hover');
    expect(sidebarModeOf(false, false)).toBe('compact');
  });
});

describe('setSidebarMode', () => {
  beforeEach(() => useAppStore.setState({ sidebarPinned: true, sidebarHoverExpand: true }));

  const mode = () => {
    const s = useAppStore.getState();
    return sidebarModeOf(s.sidebarPinned, s.sidebarHoverExpand);
  };

  it('round-trips every mode', () => {
    for (const next of ['compact', 'hover', 'expanded'] as const) {
      setSidebarMode(next);
      expect(mode()).toBe(next);
    }
  });

  it('keeps the hover choice while pinned', () => {
    setSidebarMode('compact');
    setSidebarMode('expanded');
    useAppStore.getState().setSidebarPinned(false);
    expect(mode()).toBe('compact');
  });
});
