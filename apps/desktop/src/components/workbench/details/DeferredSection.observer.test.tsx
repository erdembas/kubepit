import { Fragment, type ReactElement, type ReactNode, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The IntersectionObserver path of `DeferredSection`. Vitest runs in Node
 * without a DOM library, so this file uses a fake IntersectionObserver and a
 * minimal hook harness: `react`'s useState / useRef / useEffect are replaced
 * by a single-component runtime that renders, attaches the placeholder's ref
 * to a fake element, runs effects and re-renders after a state change.
 */

// -- Minimal hook runtime ---------------------------------------------------

type Effect = { deps?: readonly unknown[]; cleanup?: void | (() => void) };

const harness = vi.hoisted(() => {
  const h = {
    states: [] as unknown[],
    refs: [] as Array<{ current: unknown }>,
    effects: [] as Effect[],
    queued: [] as Array<() => void>,
    cursor: { s: 0, r: 0, e: 0 },
    dirty: false,
    useState(init: unknown) {
      const i = h.cursor.s++;
      if (!(i in h.states)) h.states[i] = init;
      const set = (next: unknown) => {
        h.states[i] =
          typeof next === 'function' ? (next as (v: unknown) => unknown)(h.states[i]) : next;
        h.dirty = true;
      };
      return [h.states[i], set];
    },
    useRef(init: unknown) {
      const i = h.cursor.r++;
      h.refs[i] ??= { current: init };
      return h.refs[i];
    },
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]) {
      const i = h.cursor.e++;
      const prev = h.effects[i];
      const same =
        prev?.deps &&
        deps &&
        deps.length === prev.deps.length &&
        deps.every((d, k) => Object.is(d, prev.deps![k]));
      if (same) return;
      h.queued.push(() => {
        if (typeof prev?.cleanup === 'function') prev.cleanup();
        h.effects[i] = { deps, cleanup: fn() };
      });
    },
    reset() {
      h.states = [];
      h.refs = [];
      h.effects = [];
      h.queued = [];
      h.dirty = false;
    },
  };
  return h;
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: harness.useState,
    useRef: harness.useRef,
    useEffect: harness.useEffect,
  };
});

const { DeferredSection, whenNearlyVisible } = await import('./DeferredSection');

/** Renders `DeferredSection` like React would: render, attach the ref, run effects, repeat. */
function mount(children: ReactNode, placeholder: Element) {
  harness.reset();
  let out: ReactElement | null = null;
  const render = () => {
    harness.cursor = { s: 0, r: 0, e: 0 };
    harness.dirty = false;
    out = DeferredSection({ children }) as ReactElement;
    const ref = (out as unknown as { ref?: RefObject<unknown> }).ref;
    if (ref) (ref as { current: unknown }).current = placeholder;
    const effects = harness.queued.splice(0);
    effects.forEach((run) => run());
  };
  const flush = () => {
    while (harness.dirty) render();
  };
  render();
  flush();
  return {
    get output() {
      return out!;
    },
    /** Re-renders pending state changes (after an observer callback). */
    flush,
    unmount() {
      for (const e of harness.effects) if (typeof e?.cleanup === 'function') e.cleanup();
    },
  };
}

// -- Fake IntersectionObserver ----------------------------------------------

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  /** Whether a newly observed element starts inside the root (+ margin). */
  static initiallyVisible = false;
  observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
    // Browsers report the initial state asynchronously, right after observe().
    const visible = FakeIntersectionObserver.initiallyVisible;
    queueMicrotask(() => this.emit(visible));
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Deliver an entry for the observed element (nothing once disconnected). */
  emit(isIntersecting: boolean) {
    if (this.disconnected) return;
    const entries = this.observed.map(
      (target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

const scroller = { id: 'details-scroll' } as unknown as Element;
const fakeElement = () =>
  ({
    closest: vi.fn((sel: string) => (sel === '[data-details-scroll]' ? scroller : null)),
  }) as unknown as Element;
const tick = () => new Promise<void>((r) => queueMicrotask(r));

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  FakeIntersectionObserver.initiallyVisible = false;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// -- whenNearlyVisible ------------------------------------------------------

describe('whenNearlyVisible', () => {
  it('observes the element against the details scroller with a bottom preload margin', () => {
    const el = fakeElement();
    whenNearlyVisible(el, () => {});
    const [io] = FakeIntersectionObserver.instances;
    expect(io!.observed).toEqual([el]);
    expect(io!.options.root).toBe(scroller);
    expect(io!.options.rootMargin).toMatch(/^0px 0px \d+px 0px$/);
  });

  it('fires when an entry becomes intersecting, then disconnects', async () => {
    const onVisible = vi.fn();
    whenNearlyVisible(fakeElement(), onVisible);
    const io = FakeIntersectionObserver.instances[0]!;
    await tick();
    expect(onVisible).not.toHaveBeenCalled();
    io.emit(false);
    expect(onVisible).not.toHaveBeenCalled();
    io.emit(true);
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(io.disconnected).toBe(true);
    io.emit(true);
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('fires right away when the element is already in view', async () => {
    FakeIntersectionObserver.initiallyVisible = true;
    const onVisible = vi.fn();
    whenNearlyVisible(fakeElement(), onVisible);
    await tick();
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true);
  });

  it('fires synchronously without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onVisible = vi.fn();
    const cleanup = whenNearlyVisible(fakeElement(), onVisible);
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(() => cleanup()).not.toThrow();
  });

  it('disconnects on cleanup and never fires afterwards', async () => {
    const onVisible = vi.fn();
    const cleanup = whenNearlyVisible(fakeElement(), onVisible);
    const io = FakeIntersectionObserver.instances[0]!;
    cleanup();
    expect(io.disconnected).toBe(true);
    io.emit(true);
    await tick();
    expect(onVisible).not.toHaveBeenCalled();
  });
});

// -- DeferredSection --------------------------------------------------------

describe('DeferredSection (hook harness)', () => {
  const content = <p>heavy</p>;
  const isPlaceholder = (el: ReactElement) =>
    el.type === 'div' && (el.props as Record<string, unknown>)['data-deferred-section'] === true;
  const isContent = (el: ReactElement) =>
    el.type === Fragment && (el.props as { children: ReactNode }).children === content;

  it('mounts its children when the placeholder starts intersecting', async () => {
    const view = mount(content, fakeElement());
    expect(isPlaceholder(view.output)).toBe(true);
    const io = FakeIntersectionObserver.instances[0]!;
    await tick();
    view.flush();
    expect(isPlaceholder(view.output)).toBe(true);
    io.emit(true);
    view.flush();
    expect(isContent(view.output)).toBe(true);
    // Shown for good: the observer is gone and no new one was created.
    expect(io.disconnected).toBe(true);
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
  });

  it('mounts right away when the placeholder is already in view', async () => {
    FakeIntersectionObserver.initiallyVisible = true;
    const view = mount(content, fakeElement());
    await tick();
    view.flush();
    expect(isContent(view.output)).toBe(true);
    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true);
  });

  it('mounts on the first effect without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const view = mount(content, fakeElement());
    expect(isContent(view.output)).toBe(true);
  });

  it('disconnects when unmounted before it was shown', async () => {
    const view = mount(content, fakeElement());
    const io = FakeIntersectionObserver.instances[0]!;
    view.unmount();
    expect(io.disconnected).toBe(true);
    io.emit(true);
    await tick();
    view.flush();
    expect(isPlaceholder(view.output)).toBe(true);
  });
});
