import { describe, expect, it, vi } from 'vitest';
import { CLICK_WINDOW_MS, createClickThrough, postedInBackground } from './clickThrough';

describe('click-through', () => {
  it('returns the last posted target when focus follows within the window, once', () => {
    const ct = createClickThrough();
    const a = vi.fn();
    const b = vi.fn();
    ct.posted(a, 1_000);
    ct.posted(b, 2_000);
    expect(ct.focused(2_000 + CLICK_WINDOW_MS - 1)).toBe(b);
    expect(ct.focused(2_500)).toBeNull();
  });
  it('expires after the window', () => {
    const ct = createClickThrough();
    ct.posted(() => {}, 0);
    expect(ct.focused(CLICK_WINDOW_MS + 1)).toBeNull();
  });
});

describe('postedInBackground', () => {
  const away = { app_focused: false };
  const front = { app_focused: true };
  it('arms only while no Kubepit window is focused', () => {
    expect(postedInBackground(false, [away, away])).toBe(true);
    expect(postedInBackground(true, [away])).toBe(false);
  });
  it('does not arm while another Kubepit window is focused', () => {
    expect(postedInBackground(false, [away, front])).toBe(false);
  });
});
