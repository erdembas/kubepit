import type { CollisionDetection } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { viewTabCollision } from './viewTabCollision';

type CollisionArgs = Parameters<CollisionDetection>[0];
type Container = CollisionArgs['droppableContainers'][number];

function rect(left: number, right: number, top = 0, bottom = 36) {
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

function viewport(left: number, right: number): Element {
  return { getBoundingClientRect: () => rect(left, right) } as Element;
}

function container(id: string, bounds: ReturnType<typeof rect>, clip?: Element): Container {
  return {
    id,
    key: id,
    disabled: false,
    data: { current: {} },
    node: { current: { closest: () => clip ?? null } as unknown as HTMLElement },
    rect: { current: bounds },
  };
}

function hit(containers: Container[], x: number, y = 18) {
  return viewTabCollision({
    active: {
      id: 'dragged',
      data: { current: {} },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: rect(x - 10, x + 10),
    droppableContainers: containers,
    droppableRects: new Map(containers.map((item) => [item.id, item.rect.current!])),
    pointerCoordinates: { x, y },
  }).map((collision) => collision.id);
}

describe('view tab drop targets', () => {
  it('drops on a fixed pin instead of the scrolled tab hidden behind it', () => {
    const clip = viewport(100, 300);
    expect(
      hit(
        [
          container('hidden', rect(0, 90), clip),
          container('pinned', rect(0, 90)),
          container('strip:one', rect(0, 300)),
        ],
        45,
      ),
    ).toEqual(['pinned']);
  });

  it('accepts the visible portion of a partially clipped tab', () => {
    const clip = viewport(100, 300);
    const targets = [
      container('partial', rect(50, 150), clip),
      container('strip:one', rect(0, 300)),
    ];
    expect(hit(targets, 125)).toEqual(['partial']);
    expect(hit(targets, 75)).toEqual(['strip:one']);
  });

  it('does not let a right-clipped tab intercept a drop into a neighbouring pane', () => {
    const clip = viewport(100, 300);
    expect(
      hit(
        [
          container('overflow', rect(280, 480), clip),
          container('strip:one', rect(0, 300)),
          container('pane:two', rect(300, 600, 0, 300)),
        ],
        350,
      ),
    ).toEqual(['pane:two']);
  });

  it('preserves tab priority over strip and pane drop targets', () => {
    const clip = viewport(100, 300);
    expect(
      hit(
        [
          container('pane:one', rect(0, 300, 0, 300)),
          container('strip:one', rect(0, 300)),
          container('visible', rect(100, 200), clip),
        ],
        150,
      ),
    ).toEqual(['visible']);
  });
});
