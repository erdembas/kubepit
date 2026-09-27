import * as i18n from '@/i18n';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { formatPercent } from '@/lib/format';
import {
  areaPath,
  clip,
  fitTicks,
  localOffset,
  monotonePath,
  nearest,
  niceScale,
  peak,
  segments,
  tickFormat,
  timeStep,
  timeTicks,
  tooltipFormat,
  type SeriesPoint,
} from '@/lib/fleet/timeSeries';

/**
 * Hand-drawn SVG time series in the language of `charts.tsx`: accent area
 * with a soft gradient, hairline grid, reference lines (capacity,
 * allocatable, requests, limits) and a hover crosshair with a tooltip.
 * Gaps longer than 2.5 sample intervals break the line instead of
 * pretending the usage was interpolated. `lines` adds secondary series that
 * change over time (Prometheus requests / limits, network transmit), drawn
 * as plain lines and listed in the tooltip.
 */

export interface ChartRef {
  key: string;
  label: string;
  value: number;
  /** Tailwind stroke + fill-for-text classes, e.g. `stroke-cat-frontend` / `fill-cat-frontend`. */
  stroke: string;
  text: string;
  dashed?: boolean;
}

/** A secondary series: a reference that varies over time. */
export interface ChartLine extends Omit<ChartRef, 'value'> {
  points: readonly SeriesPoint[];
  /** Tooltip swatch, e.g. `bg-cat-frontend`. */
  swatch: string;
  /** `false`: the main value as a percentage of this line means nothing (tx vs rx). */
  ratio?: boolean;
}

const MARGIN = { top: 14, right: 10, bottom: 20, left: 44 };
/** Refs more than this factor above the data's peak do not stretch the axis. */
const OFF_SCALE = 4;

export function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** `url(#…)`-safe id (React ids contain colons). */
export function useSvgId(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export function TimeSeriesChart({
  points,
  from,
  to,
  intervalMs,
  formatTick,
  formatValue,
  binary = false,
  minScale = 1,
  refs = [],
  lines = [],
  height = 132,
  label,
  overlay,
}: {
  points: readonly SeriesPoint[];
  from: number;
  to: number;
  intervalMs: number;
  formatTick: (v: number) => string;
  formatValue: (v: number) => string;
  /** Byte axis (1024 steps). */
  binary?: boolean;
  /** Smallest axis maximum, so an idle series does not look like a wall. */
  minScale?: number;
  refs?: ChartRef[];
  lines?: ChartLine[];
  height?: number;
  label: string;
  /** Centered message instead of the line (collecting, unavailable). */
  overlay?: ReactNode;
}) {
  i18n.useLocale();
  const [containerRef, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useSvgId('ts-fill');
  const clipId = useSvgId('ts-clip');

  const visible = useMemo(() => clip(points, from, to), [points, from, to]);
  const clippedLines = useMemo(
    () =>
      lines
        .map((l) => {
          const pts = clip(l.points, from, to);
          return { ...l, visible: pts, value: pts.length ? peak(pts) : 0 };
        })
        .filter((l) => l.visible.length > 0),
    [lines, from, to],
  );
  // Reference lines far above the data (a 4-core limit on a 60m pod) would
  // flatten the curve: they stay off the axis and are named at the top edge.
  const { scale, inScale, offScale, linesIn, linesOff } = useMemo(() => {
    const top = Math.max(peak(visible) * 1.12, minScale);
    const fits = (r: { value: number }) => !visible.length || r.value <= top * OFF_SCALE;
    const inScale = refs.filter(fits);
    const linesIn = clippedLines.filter(fits);
    const refMax = [...inScale, ...linesIn].reduce((m, r) => Math.max(m, r.value), 0);
    return {
      scale: niceScale(Math.max(top, refMax * 1.04), 3, binary),
      inScale,
      offScale: refs.filter((r) => !fits(r)),
      linesIn,
      linesOff: clippedLines.filter((l) => !fits(l)),
    };
  }, [visible, refs, clippedLines, minScale, binary]);

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const span = Math.max(1, to - from);
  const x = (t: number) => MARGIN.left + ((t - from) / span) * plotW;
  const y = (v: number) => MARGIN.top + plotH - (Math.min(v, scale.max) / scale.max) * plotH;
  const baseline = MARGIN.top + plotH;

  const paths = useMemo(
    () =>
      segments(visible, intervalMs * 2.5).map((seg) => {
        const xy = seg.map((p) => [x(p.t), y(p.v)] as [number, number]);
        return {
          line: monotonePath(xy),
          area: areaPath(xy, baseline),
          dot: xy.length === 1 ? xy[0]! : null,
        };
      }),
    // x/y derive from the listed inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, intervalMs, width, height, scale.max, from, to],
  );

  const linePaths = useMemo(
    () =>
      linesIn.map((l) => ({
        line: l,
        paths: segments(l.visible, intervalMs * 2.5).map((seg) =>
          monotonePath(seg.map((p) => [x(p.t), y(p.v)] as [number, number])),
        ),
      })),
    // x/y derive from the listed inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linesIn, intervalMs, width, height, scale.max, from, to],
  );

  const tickStep = timeStep(span);
  const xTicks = fitTicks(
    timeTicks(from, to, tickStep, tickStep >= 3_600_000 ? localOffset(from) : 0),
    plotW,
  );
  const hovered = hover !== null ? visible[hover] : undefined;
  // Lines are labelled at their latest value, next to the fixed references.
  const refLabels = placeRefLabels(
    [...inScale, ...linesIn.map((l) => ({ ...l, value: l.visible[l.visible.length - 1]!.v }))],
    y,
  );
  const offScaleLabels = [
    ...offScale,
    ...linesOff.map((l) => ({ ...l, value: l.visible[l.visible.length - 1]!.v })),
  ];

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (!visible.length || overlay) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left) / Math.max(1, rect.width)) * span;
    setHover(nearest(visible, t));
  };

  const last = visible[visible.length - 1];
  return (
    <div ref={containerRef} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={
            last ? i18n.t('{label}: {value} now', { label, value: formatValue(last.v) }) : label
          }
          className="block overflow-visible"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'rgb(var(--accent))', stopOpacity: 0.26 }} />
              <stop offset="100%" style={{ stopColor: 'rgb(var(--accent))', stopOpacity: 0.02 }} />
            </linearGradient>
            <clipPath id={clipId}>
              <rect x={MARGIN.left} y={MARGIN.top - 2} width={plotW} height={plotH + 2} />
            </clipPath>
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
                {formatTick(tick)}
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

          {inScale.map((r) => (
            <line
              key={r.key}
              x1={MARGIN.left}
              x2={MARGIN.left + plotW}
              y1={y(r.value)}
              y2={y(r.value)}
              className={r.stroke}
              strokeWidth={1}
              strokeDasharray={r.dashed ? '4 3' : undefined}
              shapeRendering="crispEdges"
            />
          ))}
          {offScaleLabels.length > 0 && (
            <text
              x={MARGIN.left + plotW - 2}
              y={MARGIN.top - 5}
              textAnchor="end"
              className="text-[9.5px] font-medium"
            >
              {offScaleLabels.map((r, i) => (
                <tspan key={r.key} className={r.text} dx={i ? 8 : 0}>
                  {`${r.label} ${formatValue(r.value)} ↑`}
                </tspan>
              ))}
            </text>
          )}
          {refLabels.map(({ ref: r, y: labelY }) => (
            <text
              key={r.key}
              x={MARGIN.left + plotW - 2}
              y={labelY}
              textAnchor="end"
              className={cn('text-[9.5px] font-medium', r.text)}
            >
              {r.label}
            </text>
          ))}

          {!overlay && (
            <g clipPath={`url(#${clipId})`}>
              {linePaths.map(({ line, paths: segs }) =>
                segs.map((d, i) => (
                  <path
                    key={`${line.key}-${i}`}
                    d={d}
                    fill="none"
                    strokeWidth={1.25}
                    strokeLinejoin="round"
                    strokeDasharray={line.dashed ? '4 3' : undefined}
                    className={line.stroke}
                  />
                )),
              )}
              {paths.map((p, i) => (
                <g key={i}>
                  {!p.dot && <path d={p.area} fill={`url(#${gradientId})`} />}
                  {p.dot ? (
                    <circle cx={p.dot[0]} cy={p.dot[1]} r={2.5} className="fill-accent" />
                  ) : (
                    <path
                      d={p.line}
                      fill="none"
                      strokeWidth={1.6}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      className="stroke-accent"
                    />
                  )}
                </g>
              ))}
            </g>
          )}

          {hovered && (
            <g pointerEvents="none">
              <line
                x1={x(hovered.t)}
                x2={x(hovered.t)}
                y1={MARGIN.top}
                y2={baseline}
                className="stroke-fg/25"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <circle
                cx={x(hovered.t)}
                cy={y(hovered.v)}
                r={3.5}
                strokeWidth={2}
                className="fill-surface-raised stroke-accent"
              />
            </g>
          )}

          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
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

      {hovered && width > 0 && (
        <ChartTooltip
          left={x(hovered.t)}
          width={width}
          time={hovered.t}
          timeFormat={tooltipFormat(span)}
          value={formatValue(hovered.v)}
          label={label}
          refs={refs.map((r) => ({
            key: r.key,
            label: r.label,
            percent: formatPercent(r.value > 0 ? (hovered.v / r.value) * 100 : 0),
          }))}
          lines={clippedLines.flatMap((l) => {
            const at = l.visible[nearest(l.visible, hovered.t)];
            if (!at || Math.abs(at.t - hovered.t) > intervalMs * 1.5) return [];
            return [
              {
                key: l.key,
                label: l.label,
                swatch: l.swatch,
                value: formatValue(at.v),
                percent:
                  l.ratio !== false && at.v > 0 ? formatPercent((hovered.v / at.v) * 100) : null,
              },
            ];
          })}
        />
      )}
    </div>
  );
}

/** Right-edge labels for reference lines, skipping ones that would overlap. */
function placeRefLabels(refs: ChartRef[], y: (v: number) => number) {
  const placed: Array<{ ref: ChartRef; y: number }> = [];
  for (const r of [...refs].sort((a, b) => b.value - a.value)) {
    const at = y(r.value) - 3;
    if (at < MARGIN.top + 6) continue;
    if (placed.some((p) => Math.abs(p.y - at) < 11)) continue;
    placed.push({ ref: r, y: at });
  }
  return placed;
}

function ChartTooltip({
  left,
  width,
  time,
  timeFormat,
  value,
  label,
  refs,
  lines,
}: {
  left: number;
  width: number;
  time: number;
  timeFormat: Intl.DateTimeFormatOptions;
  value: string;
  label: string;
  refs: Array<{ key: string; label: string; percent: string }>;
  lines: Array<{
    key: string;
    label: string;
    swatch: string;
    value: string;
    percent: string | null;
  }>;
}) {
  const boxWidth = lines.length ? 200 : 168;
  const flip = left + 12 + boxWidth > width;
  return (
    <div
      className="border-border bg-surface-raised/95 pointer-events-none absolute top-1 z-10 rounded-md border px-2.5 py-1.5 shadow-[0_8px_24px_-8px_rgb(0_0_0/0.3)] backdrop-blur-sm"
      style={{
        left: flip ? undefined : left + 12,
        right: flip ? width - left + 12 : undefined,
        minWidth: 120,
        maxWidth: boxWidth,
      }}
    >
      <p className="text-fg-dim text-[10px] tabular-nums">{i18n.date(time, timeFormat)}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px]">
        <span className="bg-accent h-2 w-2 shrink-0 rounded-sm" aria-hidden />
        <span className="text-fg-muted">{label}</span>
        <span className="text-fg ml-auto font-medium tabular-nums">{value}</span>
      </p>
      {lines.map((l) => (
        <p key={l.key} className="mt-0.5 flex items-center gap-1.5 text-[10.5px] tabular-nums">
          <span className={cn('h-[2px] w-2 shrink-0 rounded-full', l.swatch)} aria-hidden />
          <span className="text-fg-muted truncate">{l.label}</span>
          <span className="text-fg ml-auto">{l.value}</span>
          {l.percent && <span className="text-fg-dim">{l.percent}</span>}
        </p>
      ))}
      {refs.slice(0, 3).map((r) => (
        <p key={r.key} className="text-fg-dim mt-0.5 flex gap-2 text-[10.5px] tabular-nums">
          <span className="truncate">{r.label}</span>
          <span className="ml-auto">{r.percent}</span>
        </p>
      ))}
    </div>
  );
}

/** Tiny axis-less trend line (dashboard cards). */
export function Sparkline({
  points,
  from,
  to,
  intervalMs,
  height = 22,
  label,
  className,
}: {
  points: readonly SeriesPoint[];
  from: number;
  to: number;
  intervalMs: number;
  height?: number;
  label: string;
  className?: string;
}) {
  const [containerRef, width] = useWidth();
  const gradientId = useSvgId('spark');
  const visible = useMemo(() => clip(points, from, to), [points, from, to]);
  // Min–max scale: a sparkline shows the trend, not the absolute level.
  const values = visible.map((p) => p.v);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const pad = (hi - lo) * 0.2 || hi * 0.05 || 1;
  const min = Math.max(0, lo - pad);
  const range = Math.max(1e-9, hi + pad - min);
  const span = Math.max(1, to - from);
  const x = (t: number) => ((t - from) / span) * width;
  const y = (v: number) => 1 + (height - 2) * (1 - (v - min) / range);
  const segs = segments(visible, intervalMs * 2.5).filter((s) => s.length > 1);
  return (
    <div ref={containerRef} className={cn('w-full', className)} style={{ height }}>
      {width > 0 && segs.length > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} className="block">
          <title>{label}</title>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'rgb(var(--accent))', stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: 'rgb(var(--accent))', stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {segs.map((seg, i) => {
            const xy = seg.map((p) => [x(p.t), y(p.v)] as [number, number]);
            return (
              <g key={i}>
                <path d={areaPath(xy, height)} fill={`url(#${gradientId})`} />
                <path
                  d={monotonePath(xy)}
                  fill="none"
                  strokeWidth={1.25}
                  strokeLinejoin="round"
                  className="stroke-accent"
                />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
