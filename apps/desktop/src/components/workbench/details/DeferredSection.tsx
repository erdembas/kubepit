import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Mount a deferred section this far before it scrolls into view. */
const PRELOAD_PX = 160;

/**
 * Mounts `children` only once this spot comes within `PRELOAD_PX` of the
 * visible part of the details scroller (`[data-details-scroll]`), then keeps
 * them mounted. Below-the-fold sections (usage charts, right-sizing, pods,
 * security) thus start their watches, polls and computations when they are
 * about to be seen instead of when a view with a selected object opens, and
 * a hidden view tab never starts them. Key it by object so a new selection
 * defers again.
 */
export function DeferredSection({
  children,
  placeholderHeight = 240,
}: {
  children: ReactNode;
  /** Space held until the content mounts (keeps the scrollbar stable). */
  placeholderHeight?: number;
}) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (shown || !el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown(true);
      },
      {
        root: el.closest('[data-details-scroll]'),
        rootMargin: `0px 0px ${PRELOAD_PX}px 0px`,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);
  if (shown) return <>{children}</>;
  return <div ref={ref} aria-hidden data-deferred-section style={{ height: placeholderHeight }} />;
}
