import { describe, expect, it } from 'vitest';
import { horizontalWheelDelta } from './wheelScroll';

describe('horizontalWheelDelta', () => {
  it('maps vertical wheels to horizontal pixels', () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 40, deltaMode: 0 })).toBe(40);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 })).toBe(-240);
  });
  it('keeps a dominant horizontal delta (trackpads)', () => {
    expect(horizontalWheelDelta({ deltaX: -25, deltaY: 4, deltaMode: 0 })).toBe(-25);
  });
});
