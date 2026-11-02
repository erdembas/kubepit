import * as i18n from '@/i18n';
import { memo, useMemo, useState } from 'react';
import { kindIcon } from '@/lib/kube/icons';
import {
  ENVOY_KINDS,
  GATEWAY_KINDS,
  NODE_H,
  NODE_W,
  type GwTopoEdge,
  type GwTopoNode,
  type GwTopology,
  type KnownKind,
} from '@/lib/kube/gateway';
import type { StatusTone } from '@/lib/kube/pods';
import { cn } from '@/lib/cn';
import { TONE_BAR_FILL, TONE_ICON, TONE_SOFT_FILL } from '../topology/styles';

/**
 * SVG drawing of the Gateway API traffic topology (`buildGatewayTopology`):
 * GatewayClass → Gateway → route → backend. Hovering a node highlights its
 * connections; clicking opens the object. Theme tokens only.
 */

const EDGE_STROKE: Record<StatusTone, string> = {
  success: 'stroke-status-running/70',
  warning: 'stroke-status-starting/80',
  error: 'stroke-status-error/80',
  info: 'stroke-cat-frontend/70',
  muted: 'stroke-fg-dim/50',
};

const COLUMN_LABELS = () => ['GatewayClass', 'Gateway', i18n.t('Routes'), i18n.t('Backends')];

const CHAR_W = 6.4;

function clip(text: string, width: number): string {
  const max = Math.max(4, Math.floor(width / CHAR_W));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function iconFor(n: GwTopoNode) {
  const gateway = (GATEWAY_KINDS as Record<string, KnownKind | undefined>)[n.kind];
  if (gateway) return kindIcon(gateway.key);
  const envoy = (ENVOY_KINDS as Record<string, KnownKind | undefined>)[n.kind];
  if (envoy) return kindIcon(envoy.key);
  return kindIcon(n.kind === 'Service' ? 'services' : n.kind);
}

const Node = memo(function Node({
  node,
  dim,
  active,
  onOpen,
  onHover,
}: {
  node: GwTopoNode;
  dim: boolean;
  active: boolean;
  onOpen: (n: GwTopoNode) => void;
  onHover: (id: string | null) => void;
}) {
  const Icon = iconFor(node);
  const ns = node.namespace ? `${node.namespace}/` : '';
  const label = clip(`${ns}${node.name}`, NODE_W - 54);
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${node.kind} ${ns}${node.name}`}
      onClick={() => onOpen(node)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(node);
        }
      }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.id)}
      onBlur={() => onHover(null)}
      className={cn(
        'cursor-pointer transition-opacity duration-150 outline-none',
        dim && 'opacity-30',
      )}
    >
      <title>
        {[`${node.kind} ${ns}${node.name}`, node.sub, node.missing ? i18n.t('Not found') : '']
          .filter(Boolean)
          .join('\n')}
      </title>
      <rect
        x={node.x}
        y={node.y}
        width={NODE_W}
        height={NODE_H}
        rx={9}
        strokeWidth={active ? 1.5 : 1}
        strokeDasharray={node.missing ? '4 3' : undefined}
        className={cn(
          node.missing ? 'fill-surface' : 'fill-surface-raised',
          active ? 'stroke-accent' : node.missing ? 'stroke-status-error/70' : 'stroke-border',
        )}
      />
      {active && (
        <rect
          x={node.x}
          y={node.y + 9}
          width={3}
          height={NODE_H - 18}
          rx={1.5}
          className="fill-accent"
        />
      )}
      <rect
        x={node.x + 9}
        y={node.y + 10}
        width={26}
        height={26}
        rx={7}
        className={TONE_SOFT_FILL[node.tone]}
      />
      <Icon
        x={node.x + 15}
        y={node.y + 16}
        width={14}
        height={14}
        strokeWidth={2}
        className={TONE_ICON[node.tone]}
        aria-hidden
      />
      <text
        x={node.x + 44}
        y={node.y + 19}
        className={cn('text-[12px] font-medium', node.missing ? 'fill-fg-muted' : 'fill-fg')}
      >
        {label}
      </text>
      <text x={node.x + 44} y={node.y + 34} className="fill-fg-dim text-[10.5px]">
        {clip(node.missing ? i18n.t('Not found') : node.sub || node.kind, NODE_W - 54)}
      </text>
      <rect
        x={node.x + NODE_W - 12}
        y={node.y + 10}
        width={3}
        height={NODE_H - 20}
        rx={1.5}
        className={TONE_BAR_FILL[node.tone]}
      />
    </g>
  );
});

function edgePath(from: GwTopoNode, to: GwTopoNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = (x2 - x1) / 2;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

export function GatewayTopologyCanvas({
  topology,
  activeId,
  onOpen,
  className,
}: {
  topology: GwTopology;
  activeId?: string | null;
  onOpen: (node: GwTopoNode) => void;
  className?: string;
}) {
  i18n.useLocale();
  const [hovered, setHovered] = useState<string | null>(null);
  const byId = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n])), [topology.nodes]);
  const linked = useMemo(() => {
    if (!hovered) return null;
    const out = new Set([hovered]);
    for (const e of topology.edges)
      if (e.from === hovered || e.to === hovered) {
        out.add(e.from);
        out.add(e.to);
      }
    return out;
  }, [hovered, topology.edges]);
  const columns = COLUMN_LABELS();
  const isLinked = (e: GwTopoEdge) => !hovered || e.from === hovered || e.to === hovered;

  if (!topology.nodes.length)
    return (
      <p className="text-fg-dim flex flex-1 items-center justify-center p-8 text-[12px]">
        {i18n.t('No Gateways or routes in the selected namespaces.')}
      </p>
    );
  return (
    <div className={cn('overlay-scroll min-h-0 overflow-auto', className)}>
      <svg
        width={topology.width}
        height={topology.height + 22}
        viewBox={`0 -22 ${topology.width} ${topology.height + 22}`}
        role="img"
        aria-label={i18n.t('Gateway API topology')}
        className="block select-none"
      >
        {columns.map((label, i) => (
          <text
            key={label}
            x={16 + i * (NODE_W + 92)}
            y={-6}
            className="fill-fg-dim text-[9.5px] font-semibold uppercase"
            style={{ letterSpacing: '0.1em' }}
          >
            {label}
          </text>
        ))}
        <g>
          {topology.edges.map((e) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            const on = isLinked(e);
            return (
              <g key={e.id} className={cn('transition-opacity duration-150', !on && 'opacity-20')}>
                <path
                  d={edgePath(from, to)}
                  fill="none"
                  strokeWidth={on && hovered ? 2 : 1.4}
                  strokeDasharray={e.dashed ? '5 4' : undefined}
                  className={EDGE_STROKE[e.tone]}
                />
                {e.label && (
                  <text
                    x={to.x - 8}
                    y={to.y + NODE_H / 2 - 5}
                    textAnchor="end"
                    className="fill-fg-dim text-[9.5px]"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        {topology.nodes.map((n) => (
          <Node
            key={n.id}
            node={n}
            dim={!!linked && !linked.has(n.id)}
            active={n.id === activeId}
            onOpen={onOpen}
            onHover={setHovered}
          />
        ))}
      </svg>
    </div>
  );
}
