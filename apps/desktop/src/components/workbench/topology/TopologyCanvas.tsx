import * as i18n from '@/i18n';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { kindIcon } from '@/lib/kube/icons';
import {
  centerOn,
  clampZoom,
  EDGE_FAMILIES,
  EDGE_FAMILY,
  ensureVisible,
  fitView,
  nodeInDirection,
  zoomAt,
  type Direction,
  type PlacedNode,
  type TopoEdge,
  type TopologyLayout,
  type TopoNode,
  type Viewport,
} from '@/lib/kube/topology';
import { useEvent } from '../util';
import { edgeDescription, flagLabel } from './labels';
// NetworkPolicy simulator: optional reachability overlay.
import { aggregateReach, type ReachState } from '@/lib/kube/netpol/overlay';
import { REACH_FILL, REACH_STROKE } from '../netpol/labels';
import {
  FAMILY_DASH,
  FAMILY_FILL,
  FAMILY_STROKE,
  TONE_BAR_FILL,
  TONE_ICON,
  TONE_SOFT_FILL,
  TONE_TEXT_FILL,
} from './styles';

/**
 * SVG renderer of a laid-out relationship map: drag to pan, wheel / pinch
 * to zoom, hover highlights a node's relationships, click or Enter opens a
 * node, arrow keys move between nodes. Colours come from theme tokens only,
 * so the map follows light and dark themes.
 */

export interface FocusRequest {
  id: string;
  rev: number;
}

interface Props {
  label: string;
  nodes: ReadonlyMap<string, TopoNode>;
  edges: readonly TopoEdge[];
  layout: TopologyLayout;
  /** The active node: the details panel's object or the map's selection (accent strip). */
  activeId: string | null;
  matches: ReadonlySet<string>;
  /** Prefix names with their namespace (map spans several namespaces). */
  showNamespace: boolean;
  /** Bump to fit the whole map into view. */
  fitRequest: number;
  focusRequest: FocusRequest | null;
  onActivate: (node: TopoNode) => void;
  /** Reachability overlay: nodes coloured by state, the rest dimmed. */
  overlay?: ReadonlyMap<string, ReachState> | null;
}

/** Overlay state of a node; collapsed pod groups combine their members. */
function reachOf(
  overlay: ReadonlyMap<string, ReachState> | null | undefined,
  node: TopoNode | undefined,
): ReachState | undefined {
  if (!overlay || !node) return undefined;
  return (
    overlay.get(node.id) ??
    (node.group ? aggregateReach(node.group.members.map((id) => overlay.get(id))) : undefined)
  );
}

const LABEL_FONT = 'system-ui, sans-serif';
let fontFamily: string | null = null;
let measureCtx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();

/** Text width in px for SVG labels (canvas metrics, cached). */
function measure(text: string, size: number, weight: number, tracking = 0): number {
  const key = `${weight}|${size}|${tracking}|${text}`;
  const cached = widths.get(key);
  if (cached !== undefined) return cached;
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    fontFamily = getComputedStyle(document.body).fontFamily || LABEL_FONT;
  }
  let width = text.length * size * 0.56;
  if (measureCtx) {
    measureCtx.font = `${weight} ${size}px ${fontFamily}`;
    width = measureCtx.measureText(text).width + tracking * size * text.length;
  }
  if (widths.size > 20_000) widths.clear();
  widths.set(key, width);
  return width;
}

/** Middle ellipsis so pod hashes and suffixes stay readable. */
function fit(text: string, max: number, size: number, weight: number, tracking = 0): string {
  if (max <= 0) return '';
  if (measure(text, size, weight, tracking) <= max) return text;
  const cut = (n: number) => {
    const head = Math.ceil(n * 0.6);
    return `${text.slice(0, head)}…${text.slice(text.length - (n - head))}`;
  };
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(cut(mid), size, weight, tracking) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? cut(lo) : '…';
}

type Emphasis = 'normal' | 'strong' | 'dim';

const NodeView = memo(function NodeView({
  node,
  placed,
  emphasis,
  active,
  match,
  focused,
  tabbable,
  showNamespace,
  reach,
  overlayOn,
}: {
  node: TopoNode;
  placed: PlacedNode;
  emphasis: Emphasis;
  active: boolean;
  match: boolean;
  focused: boolean;
  tabbable: boolean;
  showNamespace: boolean;
  reach?: ReachState;
  overlayOn?: boolean;
}) {
  i18n.useLocale();
  const { x, y, w, h } = placed;
  const Icon = kindIcon(node.kindKey);
  const tone = node.tone;
  const placeholder = !!node.flag && node.flag !== 'no-endpoints';
  const textX = x + 44;
  const textW = w - 44 - 10;
  const kindText = node.group
    ? `${node.kind} × ${node.group.count}`
    : node.aggregate
      ? `${node.kind} × ${node.aggregate.count}`
      : node.kind;
  const kindLabel = fit(kindText.toUpperCase(), textW * 0.62, 9.5, 600, 0.08);
  const statusRoom = textW - measure(kindLabel, 9.5, 600, 0.08) - 8;
  const statusText = node.group ? '' : fit(node.status, statusRoom, 10, 500);
  const nsPrefix = showNamespace && node.namespace ? `${node.namespace}/` : '';
  const title = node.aggregate
    ? i18n.t('{count} more objects of this kind (map limit reached)', {
        count: node.aggregate.count,
      })
    : node.name;
  const nameRoom = textW - (nsPrefix ? Math.min(measure(nsPrefix, 12, 400), textW * 0.45) : 0);
  const nsText = nsPrefix ? fit(nsPrefix, textW * 0.45, 12, 400) : '';
  const nameText = fit(title, nameRoom, 12, 500);
  const tooltip = [
    `${node.kind} ${node.namespace ? `${node.namespace}/` : ''}${node.name}`.trim(),
    node.status && !node.group ? node.status : null,
    node.group
      ? i18n.t('{count} pods · click to expand', { count: node.group.count })
      : node.aggregate
        ? title
        : null,
    node.flag ? flagLabel(node.flag) : null,
  ]
    .filter(Boolean)
    .join('\n');

  const segments = useMemo(() => {
    if (!node.group) return [];
    const order = ['error', 'warning', 'info', 'success', 'muted'] as const;
    const total = node.group.count;
    let offset = 0;
    return order
      .filter((t) => node.group!.tones[t])
      .map((t) => {
        const width = ((node.group!.tones[t] ?? 0) / total) * textW;
        const seg = { tone: t, x: offset, width };
        offset += width;
        return seg;
      });
  }, [node.group, textW]);

  return (
    <g
      data-node-id={node.id}
      role="button"
      tabIndex={tabbable ? 0 : -1}
      aria-label={tooltip.replace(/\n/g, ', ')}
      className={cn(
        'cursor-pointer transition-opacity duration-150 outline-none',
        emphasis === 'dim' && 'opacity-30',
        overlayOn && !reach && emphasis !== 'dim' && 'opacity-40',
      )}
    >
      <title>{tooltip}</title>
      {(node.group || node.aggregate) && (
        <>
          <rect
            x={x + 6}
            y={y + 6}
            width={w}
            height={h}
            rx={9}
            className="fill-surface-raised stroke-border"
          />
          <rect
            x={x + 3}
            y={y + 3}
            width={w}
            height={h}
            rx={9}
            className="fill-surface-raised stroke-border"
          />
        </>
      )}
      {(match || focused) && (
        <rect
          x={x - 4}
          y={y - 4}
          width={w + 8}
          height={h + 8}
          rx={12}
          className={cn('fill-none', focused ? 'stroke-accent' : 'stroke-accent/45')}
          strokeWidth={focused ? 2 : 3}
        />
      )}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={9}
        strokeWidth={active ? 1.5 : reach ? 2 : 1}
        strokeDasharray={placeholder || node.aggregate ? '4 3' : undefined}
        className={cn(
          placeholder ? 'fill-surface' : 'fill-surface-raised',
          active
            ? 'stroke-accent'
            : reach
              ? REACH_STROKE[reach]
              : node.flag === 'missing'
                ? 'stroke-status-error/70'
                : emphasis === 'strong'
                  ? 'stroke-border-strong'
                  : 'stroke-border',
        )}
      />
      {active && (
        <rect x={x} y={y + 9} width={3} height={h - 18} rx={1.5} className="fill-accent" />
      )}
      {reach && !active && (
        <rect x={x} y={y + 9} width={3} height={h - 18} rx={1.5} className={REACH_FILL[reach]} />
      )}
      <rect
        x={x + 10}
        y={y + 10}
        width={26}
        height={26}
        rx={7}
        className={tone ? TONE_SOFT_FILL[tone] : 'fill-fg/5'}
      />
      <Icon
        x={x + 16}
        y={y + 16}
        width={14}
        height={14}
        strokeWidth={2}
        className={tone ? TONE_ICON[tone] : 'text-fg-muted'}
        aria-hidden
      />
      <text
        x={textX}
        y={y + 18}
        className="fill-fg-dim text-[9.5px] font-semibold"
        style={{ letterSpacing: '0.08em' }}
      >
        {kindLabel}
      </text>
      {statusText && (
        <text
          x={x + w - 10}
          y={y + 18}
          textAnchor="end"
          className={cn(
            'text-[10px] font-medium tabular-nums',
            tone ? TONE_TEXT_FILL[tone] : 'fill-fg-dim',
          )}
        >
          {statusText}
        </text>
      )}
      <text
        x={textX}
        y={y + 34}
        className={cn(
          'text-[12px] font-medium',
          placeholder ? 'fill-fg-muted' : node.aggregate ? 'fill-fg-muted' : 'fill-fg',
        )}
      >
        {nsText && <tspan className="fill-fg-dim font-normal">{nsText}</tspan>}
        {node.aggregate ? i18n.t('+{count} more', { count: node.aggregate.count }) : nameText}
      </text>
      {segments.map((s) => (
        <rect
          key={s.tone}
          x={textX + s.x}
          y={y + h - 6}
          width={Math.max(0, s.width - 1)}
          height={2.5}
          rx={1.25}
          className={TONE_BAR_FILL[s.tone]}
        />
      ))}
    </g>
  );
});

const EdgesLayer = memo(function EdgesLayer({
  layout,
  edges,
  nodes,
  hoveredId,
  dimAll,
  markerPrefix,
  overlay,
}: {
  layout: TopologyLayout;
  edges: readonly TopoEdge[];
  nodes: ReadonlyMap<string, TopoNode>;
  hoveredId: string | null;
  dimAll: boolean;
  markerPrefix: string;
  overlay?: ReadonlyMap<string, ReachState> | null;
}) {
  i18n.useLocale();
  const byId = useMemo(() => new Map(edges.map((e) => [e.id, e])), [edges]);
  const nameOf = (id: string) => {
    const n = nodes.get(id);
    return n ? `${n.kind} ${n.name || '…'}` : id;
  };
  return (
    <g fill="none">
      {layout.edges.map((pe) => {
        const edge = byId.get(pe.id);
        if (!edge) return null;
        const family = EDGE_FAMILY[edge.kind];
        const touching = hoveredId !== null && (edge.from === hoveredId || edge.to === hoveredId);
        const reach = overlay ? reachOf(overlay, nodes.get(edge.to)) : undefined;
        const dimmed = hoveredId !== null ? !touching : dimAll || (!!overlay && !reach);
        return (
          <g key={pe.id}>
            <path
              d={pe.d}
              strokeWidth={touching ? 2 : 1.25}
              strokeDasharray={FAMILY_DASH[family]}
              markerEnd={`url(#${markerPrefix}-${family})`}
              className={cn(
                reach && reach !== 'source' ? REACH_STROKE[reach] : FAMILY_STROKE[family],
                'transition-opacity duration-150',
                dimmed ? 'opacity-15' : touching ? 'opacity-100' : 'opacity-60',
              )}
            />
            <path d={pe.d} strokeWidth={10} className="stroke-transparent">
              <title>{edgeDescription(edge.kind, nameOf(edge.from), nameOf(edge.to))}</title>
            </path>
          </g>
        );
      })}
    </g>
  );
});

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Viewport;
  nodeId: string | null;
  moved: boolean;
}

export function TopologyCanvas({
  label,
  nodes,
  edges,
  layout,
  activeId,
  matches,
  showNamespace,
  fitRequest,
  focusRequest,
  onActivate,
  overlay,
}: Props) {
  i18n.useLocale();
  const uid = useId().replace(/:/g, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  /** Focus rings only for keyboard use. */
  const [keyboard, setKeyboard] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const pinch = useRef<{ dist: number; pointers: Map<number, { x: number; y: number }> }>({
    dist: 0,
    pointers: new Map(),
  });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit when asked (new scope / root, data synced), then apply a pending
  // focus request, as soon as the canvas has a size and the node exists.
  const fittedFor = useRef<number | null>(null);
  const handledFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!size.width || !size.height || !layout.nodes.size) return;
    let next = viewportRef.current;
    let changed = false;
    if (fittedFor.current !== fitRequest) {
      fittedFor.current = fitRequest;
      next = fitView(layout, size, 28, 1);
      changed = true;
    }
    if (focusRequest && handledFocus.current !== focusRequest.rev) {
      const placed = layout.nodes.get(focusRequest.id);
      if (placed) {
        handledFocus.current = focusRequest.rev;
        next = centerOn(next, placed, size, 0.8);
        changed = true;
      }
    }
    if (changed) setViewport(next);
  }, [fitRequest, focusRequest, size, layout]);

  // Wheel zoom (and trackpad pinch, which arrives as ctrl+wheel) needs a non-passive listener.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      const delta = e.deltaY * unit;
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015));
      setViewport((v) => zoomAt(v, factor, e.clientX - rect.left, e.clientY - rect.top));
    };
    // WebKit (macOS webview) reports trackpad pinch as gesture events.
    let gestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      const rect = el.getBoundingClientRect();
      const factor = ge.scale / gestureScale;
      gestureScale = ge.scale;
      setViewport((v) => zoomAt(v, factor, ge.clientX - rect.left, ge.clientY - rect.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, []);

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      (map.get(e.from) ?? map.set(e.from, new Set()).get(e.from)!).add(e.to);
      (map.get(e.to) ?? map.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    return map;
  }, [edges]);

  const activate = useEvent((id: string) => {
    const node = nodes.get(id);
    if (node) onActivate(node);
  });

  const nodeIdAt = (target: EventTarget | null) =>
    target instanceof Element
      ? (target.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null)
      : null;

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    setKeyboard(false);
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const pointers = pinch.current.pointers;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch.current.dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      gesture.current = null;
      return;
    }
    gesture.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: viewportRef.current,
      nodeId: nodeIdAt(e.target),
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const pointers = pinch.current.pointers;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch.current.dist > 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        const factor = dist / pinch.current.dist;
        setViewport((v) =>
          zoomAt(v, factor, (a!.x + b!.x) / 2 - rect.left, (a!.y + b!.y) / 2 - rect.top),
        );
      }
      pinch.current.dist = dist;
      return;
    }
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    if (!g.moved) {
      g.moved = true;
      setPanning(true);
    }
    setViewport({ ...g.origin, x: g.origin.x + dx, y: g.origin.y + dy });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pinch.current.pointers.delete(e.pointerId);
    if (pinch.current.pointers.size < 2) pinch.current.dist = 0;
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (g && g.pointerId === e.pointerId && !g.moved && g.nodeId) {
      setFocusedId(g.nodeId);
      activate(g.nodeId);
    }
  };

  const zoomBy = (factor: number) =>
    setViewport((v) => zoomAt(v, factor, sizeRef.current.width / 2, sizeRef.current.height / 2));
  const fitAll = () => setViewport(fitView(layout, size, 28, 1));

  const moveFocus = (dir: Direction) => {
    const next = nodeInDirection(layout, focusedId, dir);
    if (!next) return;
    setFocusedId(next);
    const placed = layout.nodes.get(next);
    if (placed) setViewport((v) => ensureVisible(v, placed, sizeRef.current));
    containerRef.current
      ?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(next)}"]`)
      ?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target.closest('button, input')) return;
    const dirs: Record<string, Direction> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };
    const dir = dirs[e.key];
    setKeyboard(true);
    if (dir) {
      e.preventDefault();
      moveFocus(dir);
    } else if ((e.key === 'Enter' || e.key === ' ') && focusedId) {
      e.preventDefault();
      activate(focusedId);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(1.2);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomBy(1 / 1.2);
    } else if (e.key === '0') {
      e.preventDefault();
      fitAll();
    }
  };

  const onFocusCapture = (e: React.FocusEvent) => {
    const id = nodeIdAt(e.target);
    if (!id) return;
    setFocusedId(id);
    // Focus without a pointer gesture came from the keyboard (Tab).
    if (!gesture.current && !pinch.current.pointers.size) setKeyboard(true);
  };

  // A node keeps keyboard focus reachable even after the map changes.
  const tabbableId =
    focusedId && layout.nodes.has(focusedId)
      ? focusedId
      : activeId && layout.nodes.has(activeId)
        ? activeId
        : (layout.columns.find((c) => c.length)?.[0] ?? null);

  const hoverSet = hoveredId ? neighbours.get(hoveredId) : undefined;
  const searching = matches.size > 0;
  const grid = 22 * viewport.k;

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={label}
      aria-roledescription={i18n.t('relationship map')}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocusCapture}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none"
    >
      <svg
        width="100%"
        height="100%"
        className={cn('block touch-none select-none', panning ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerOver={(e) => setHoveredId(nodeIdAt(e.target))}
        onPointerLeave={() => setHoveredId(null)}
      >
        <defs>
          <pattern
            id={`${uid}-grid`}
            width={grid}
            height={grid}
            patternUnits="userSpaceOnUse"
            x={viewport.x % grid}
            y={viewport.y % grid}
          >
            <circle cx={1} cy={1} r={Math.max(0.6, viewport.k)} className="fill-fg/10" />
          </pattern>
          {EDGE_FAMILIES.map((f) => (
            <marker
              key={f}
              id={`${uid}-${f}`}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M0,1 L9,5 L0,9 z" className={FAMILY_FILL[f]} />
            </marker>
          ))}
        </defs>
        <rect width="100%" height="100%" fill={`url(#${uid}-grid)`} />
        <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.k})`}>
          <EdgesLayer
            layout={layout}
            edges={edges}
            nodes={nodes}
            hoveredId={hoveredId}
            dimAll={searching}
            markerPrefix={uid}
            overlay={overlay}
          />
          <g>
            {[...layout.nodes.values()].map((placed) => {
              const node = nodes.get(placed.id);
              if (!node) return null;
              const emphasis: Emphasis = hoveredId
                ? placed.id === hoveredId || hoverSet?.has(placed.id)
                  ? 'strong'
                  : 'dim'
                : searching && !matches.has(placed.id)
                  ? 'dim'
                  : 'normal';
              return (
                <NodeView
                  key={placed.id}
                  node={node}
                  placed={placed}
                  emphasis={emphasis}
                  active={placed.id === activeId}
                  match={searching && matches.has(placed.id)}
                  focused={keyboard && placed.id === focusedId}
                  tabbable={placed.id === tabbableId}
                  showNamespace={showNamespace}
                  reach={reachOf(overlay, node)}
                  overlayOn={!!overlay}
                />
              );
            })}
          </g>
        </g>
      </svg>
      <div className="border-border bg-surface-raised/95 absolute right-3 bottom-3 flex flex-col items-center gap-0.5 rounded-lg border p-0.5 shadow-sm backdrop-blur">
        <IconButton label={i18n.t('Zoom in')} icon={<Plus />} onClick={() => zoomBy(1.25)} />
        <IconButton label={i18n.t('Zoom out')} icon={<Minus />} onClick={() => zoomBy(0.8)} />
        <IconButton label={i18n.t('Fit to view')} icon={<Maximize />} onClick={fitAll} />
        <button
          type="button"
          onClick={() =>
            setViewport((v) =>
              zoomAt(v, clampZoom(1) / v.k, sizeRef.current.width / 2, sizeRef.current.height / 2),
            )
          }
          title={i18n.t('Reset zoom to 100%')}
          className="text-fg-dim hover:bg-fg/10 hover:text-fg w-7 rounded-md py-0.5 text-[10px] font-medium tabular-nums"
        >
          {Math.round(viewport.k * 100)}%
        </button>
      </div>
    </div>
  );
}
