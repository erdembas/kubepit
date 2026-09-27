import * as i18n from '@/i18n';
import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import {
  clip,
  localOffset,
  monotonePath,
  nearest,
  niceRange,
  segments,
  tickFormat,
  timeStep,
  timeTicks,
  tooltipFormat,
  type SeriesPoint,
} from '@/lib/fleet/timeSeries';
import type { SeriesColor } from '@/lib/prometheus';
import { useSvgId, useWidth } from './TimeSeriesChart';

/**
 * Several series on one axis (PromQL results) in the language of
 * `TimeSeriesChart`: hairline grid, monotone lines, gaps where samples are
 * missing, a crosshair and a tooltip listing the values at that time. The
 * axis may go below zero. A single series also gets the accent area.
 */

export interface MultiSeries {
  key: string;
  label: string;
  points: readonly SeriesPoint[];
  color: SeriesColor;
}

const MARGIN = { top: 12, right: 12, bottom: 20, left: 52 };
const TOOLTIP_ROWS = 8;

export function MultiSeriesChart({
  series,
  from,
  to,
  intervalMs,
  formatValue,
  highlight,
  height = 220,
  label,
  overlay,
}: {
  series: readonly MultiSeries[];
  from: number;
  to: number;
  intervalMs: number;
  formatValue: (v: number) => string;
  /** Key of a series to emphasise (legend hover). */
  highlight?: string | null;
  height?: number;
  label: string;
  overlay?: ReactNode;
}) {
  i18n.useLocale();
  const [containerRef, width] = useWidth();
  const [hoverT, setHoverT] = useState<number | null>(null);
  const clipId = useSvgId('ms-clip');
  const gradientId = useSvgId('ms-fill');

  const visible = useMemo(
    () => series.map((s) => ({ ...s, visible: clip(s.points, from, to) })),
    [series, from, to],
  );
  const scale = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of visible)
      for (const p of s.visible) {
        if (p.v < lo) lo = p.v;
        if (p.v > hi) hi = p.v;
      }
    if (!Number.isFinite(lo)) return niceRange(0, 1, 4);
    return niceRange(Math.min(lo, 0), hi > 0 ? hi * 1.08 : hi, 4);
  }, [visible]);

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const span = Math.max(1, to - from);
  const range = Math.max(1e-12, scale.max - scale.min);
  const x = (t: number) => MARGIN.left + ((t - from) / span) * plotW;
  const y = (v: number) =>
    MARGIN.top +
    plotH -
    ((Math.min(Math.max(v, scale.min), scale.max) - scale.min) / range) * plotH;

  const paths = useMemo(
    () =>
      visible.map((s) => ({
        key: s.key,
        color: s.color,
        segs: segments(s.visible, intervalMs * 2.5).map((seg) =>
          seg.map((p) => [x(p.t), y(p.v)] as [number, number]),
        ),
      })),
    // x/y derive from the listed inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, intervalMs, width, height, scale.min, scale.max, from, to],
  );

  const tickStep = timeStep(span);
  const xTicks = timeTicks(from, to, tickStep, tickStep >= 3_600_000 ? localOffset(from) : 0);
  const baseline = y(Math.max(scale.min, 0));

  // Tooltip rows: every series with a sample near the hovered time.
  const rows = useMemo(() => {
    if (hoverT === null) return [];
    return visible
      .flatMap((s) => {
        const p = s.visible[nearest(s.visible, hoverT)];
        return p && Math.abs(p.t - hoverT) <= intervalMs * 1.5
          ? [{ key: s.key, label: s.label, color: s.color, v: p.v }]
          : [];
      })
      .sort((a, b) => b.v - a.v);
  }, [visible, hoverT, intervalMs]);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (overlay || !visible.some((s) => s.visible.length)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left) / Math.max(1, rect.width)) * span;
    // Snap to the densest series' nearest sample.
    const dense = visible.reduce((a, b) => (b.visible.length > a.visible.length ? b : a));
    const p = dense.visible[nearest(dense.visible, t)];
    setHoverT(p ? p.t : t);
  };

  const single = visible.length === 1;
  return (
    <div ref={containerRef} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} className="block">
          <defs>
            <clipPath id={clipId}>
              <rect x={MARGIN.left} y={MARGIN.top - 2} width={plotW} height={plotH + 4} />
            </clipPath>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'rgb(var(--accent))', stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: 'rgb(var(--accent))', stopOpacity: 0.02 }} />
            </linearGradient>
          </defs>
          {scale.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotW}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === 0 ? 'stroke-fg/15' : 'stroke-fg/6'}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={MARGIN.left - 7}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-fg-dim text-[10px] tabular-nums"
              >
                {formatValue(tick)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text
              key={t}
              x={x(t)}
              y={height - 5}
              textAnchor="middle"
              className="fill-fg-dim text-[10px] tabular-nums"
            >
              {i18n.date(t, tickFormat(tickStep))}
            </text>
          ))}
          {!overlay && (
            <g clipPath={`url(#${clipId})`}>
              {paths.map(({ key, color, segs }) => {
                const dim = highlight && highlight !== key;
                return (
                  <g key={key} className={cn('transition-opacity', dim && 'opacity-20')}>
                    {segs.map((xy, i) =>
                      xy.length === 1 ? (
                        <circle
                          key={i}
                          cx={xy[0]![0]}
                          cy={xy[0]![1]}
                          r={2}
                          className={color.text}
                        />
                      ) : (
                        <g key={i}>
                          {single && (
                            <path
                              d={`${monotonePath(xy)}L${xy[xy.length - 1]![0]},${baseline}L${xy[0]![0]},${baseline}Z`}
                              fill={`url(#${gradientId})`}
                            />
                          )}
                          <path
                            d={monotonePath(xy)}
                            fill="none"
                            strokeWidth={highlight === key ? 2 : 1.4}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            className={color.stroke}
                          />
                        </g>
                      ),
                    )}
                  </g>
                );
              })}
            </g>
          )}
          {hoverT !== null && rows.length > 0 && (
            <line
              x1={x(hoverT)}
              x2={x(hoverT)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
              className="stroke-fg/25"
              strokeWidth={1}
              shapeRendering="crispEdges"
              pointerEvents="none"
            />
          )}
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={() => setHoverT(null)}
          />
        </svg>
      )}
      {overlay && (
        <div
          className="pointer-events-none absolute flex items-center justify-center"
          style={{
            left: MARGIN.left,
            right: MARGIN.right,
            top: MARGIN.top,
            bottom: MARGIN.bottom,
          }}
        >
          {overlay}
        </div>
      )}
      {hoverT !== null && rows.length > 0 && width > 0 && (
        <SeriesTooltip
          left={x(hoverT)}
          width={width}
          time={hoverT}
          timeFormat={tooltipFormat(span)}
          rows={rows}
          formatValue={formatValue}
        />
      )}
    </div>
  );
}

function SeriesTooltip({
  left,
  width,
  time,
  timeFormat,
  rows,
  formatValue,
}: {
  left: number;
  width: number;
  time: number;
  timeFormat: Intl.DateTimeFormatOptions;
  rows: Array<{ key: string; label: string; color: SeriesColor; v: number }>;
  formatValue: (v: number) => string;
}) {
  i18n.useLocale();
  const boxWidth = 300;
  const flip = left + 12 + boxWidth > width;
  const hidden = rows.length - TOOLTIP_ROWS;
  return (
    <div
      className="border-border bg-surface-raised/95 pointer-events-none absolute top-1 z-10 rounded-md border px-2.5 py-1.5 shadow-[0_8px_24px_-8px_rgb(0_0_0/0.3)] backdrop-blur-sm"
      style={{
        left: flip ? undefined : left + 12,
        right: flip ? width - left + 12 : undefined,
        minWidth: 140,
        maxWidth: boxWidth,
      }}
    >
      <p className="text-fg-dim text-[10px] tabular-nums">{i18n.date(time, timeFormat)}</p>
      {rows.slice(0, TOOLTIP_ROWS).map((r) => (
        <p key={r.key} className="mt-0.5 flex items-center gap-1.5 text-[11px]">
          <span className={cn('h-2 w-2 shrink-0 rounded-sm', r.color.bg)} aria-hidden />
          <span className="text-fg-muted min-w-0 truncate font-mono text-[10.5px]">{r.label}</span>
          <span className="text-fg ml-auto pl-2 font-medium tabular-nums">{formatValue(r.v)}</span>
        </p>
      ))}
      {hidden > 0 && (
        <p className="text-fg-dim mt-0.5 text-[10.5px]">
          {i18n.plural('+{count} more series', '+{count} more series', hidden)}
        </p>
      )}
    </div>
  );
}
