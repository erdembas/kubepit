import * as i18n from '@/i18n';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { VolumeBucket } from '@/lib/logs/loki';

const CHART_HEIGHT = 34;
const AXIS_HEIGHT = 12;

function tickLabel(t: number, withDate: boolean): string {
  return withDate
    ? i18n.date(t, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : i18n.date(t, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Log volume over the query range (SVG, theme tokens): one bar per bucket,
 * the part already loaded in accent, the rest muted. Hover shows the count;
 * click a bar or drag across bars to zoom the range in.
 */
export function VolumeHistogram({
  buckets,
  stepSecs,
  start,
  end,
  loadedFrom,
  onZoom,
}: {
  buckets: VolumeBucket[];
  stepSecs: number;
  start: number;
  end: number;
  /** Oldest loaded line (epoch ms); bars from here on are highlighted. */
  loadedFrom: number | null;
  onZoom: (start: number, end: number) => void;
}) {
  i18n.useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry?.contentRect.width ?? 0)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const span = Math.max(1, end - start);
  const step = stepSecs * 1000;
  const max = useMemo(() => Math.max(1, ...buckets.map((b) => b.count)), [buckets]);
  const x = (t: number) => ((t - start) / span) * width;
  const timeAt = (px: number) =>
    start + (Math.min(Math.max(px, 0), width) / Math.max(1, width)) * span;
  const barWidth = Math.max(1, (step / span) * width - 1);
  const withDate = span > 24 * 3_600_000;
  const ticks = useMemo(() => {
    const count = width < 360 ? 2 : width < 640 ? 3 : 5;
    return Array.from({ length: count }, (_, i) => start + ((i + 0.5) / count) * span);
  }, [start, span, width]);

  const localX = (e: React.PointerEvent) =>
    e.clientX - (ref.current?.getBoundingClientRect().left ?? 0);
  const bucketAt = (px: number) => {
    const t = timeAt(px);
    const index = buckets.findIndex((b) => t >= b.t && t < b.t + step);
    return index < 0 ? null : index;
  };

  const hovered = hover === null ? null : buckets[hover];
  const total = buckets.reduce((n, b) => n + b.count, 0);

  return (
    <div className="relative px-3">
      <div
        ref={ref}
        className="relative cursor-crosshair touch-none select-none"
        style={{ height: CHART_HEIGHT + AXIS_HEIGHT }}
        onPointerMove={(e) => {
          const px = localX(e);
          setHover(bucketAt(px));
          if (drag) setDrag({ ...drag, to: px });
        }}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const px = localX(e);
          setDrag({ from: px, to: px });
        }}
        onPointerUp={() => {
          if (!drag) return;
          const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
          setDrag(null);
          if (b - a < 4) {
            const index = bucketAt(a);
            const bucket = index === null ? null : buckets[index];
            if (bucket && bucket.count > 0) onZoom(bucket.t, Math.min(end, bucket.t + step));
            return;
          }
          onZoom(Math.floor(timeAt(a)), Math.ceil(timeAt(b)));
        }}
        role="img"
        aria-label={i18n.plural(
          'Log volume: {count} line in this range',
          'Log volume: {count} lines in this range',
          total,
        )}
      >
        {width > 0 && (
          <svg width={width} height={CHART_HEIGHT + AXIS_HEIGHT} className="block overflow-visible">
            <line
              x1={0}
              x2={width}
              y1={CHART_HEIGHT + 0.5}
              y2={CHART_HEIGHT + 0.5}
              className="stroke-border"
              strokeWidth={1}
            />
            {buckets.map((b, i) => {
              if (b.count <= 0) return null;
              const h = Math.max(1.5, (b.count / max) * (CHART_HEIGHT - 2));
              const loaded = loadedFrom !== null && b.t + step > loadedFrom;
              return (
                <rect
                  key={b.t}
                  x={x(b.t)}
                  y={CHART_HEIGHT - h}
                  width={barWidth}
                  height={h}
                  rx={1}
                  className={cn(
                    hover === i ? 'fill-accent' : loaded ? 'fill-accent/55' : 'fill-fg-dim/35',
                  )}
                />
              );
            })}
            {drag && Math.abs(drag.to - drag.from) >= 4 && (
              <rect
                x={Math.min(drag.from, drag.to)}
                y={0}
                width={Math.abs(drag.to - drag.from)}
                height={CHART_HEIGHT}
                className="fill-accent/15 stroke-accent/60"
                strokeWidth={1}
              />
            )}
            {ticks.map((t) => (
              <text
                key={t}
                x={x(t)}
                y={CHART_HEIGHT + AXIS_HEIGHT - 1}
                textAnchor="middle"
                className="fill-fg-dim text-[10px] tabular-nums"
              >
                {tickLabel(t, withDate)}
              </text>
            ))}
          </svg>
        )}
        {hovered && hover !== null && (
          <div
            className="border-border bg-surface-overlay text-fg pointer-events-none absolute -top-7 z-10 rounded border px-1.5 py-0.5 text-[10.5px] whitespace-nowrap tabular-nums shadow-sm"
            style={{
              left: Math.min(Math.max(x(hovered.t), 0), Math.max(0, width - 170)),
            }}
          >
            {i18n.plural('{count} line', '{count} lines', Math.round(hovered.count))}
            <span className="text-fg-dim">
              {' · '}
              {tickLabel(hovered.t, withDate)}–{tickLabel(hovered.t + step, withDate)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
