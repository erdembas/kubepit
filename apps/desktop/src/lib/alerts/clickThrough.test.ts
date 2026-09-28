import { describe, expect, it, vi } from 'vitest';
import { CLICK_WINDOW_MS, createClickThrough } from './clickThrough';

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
