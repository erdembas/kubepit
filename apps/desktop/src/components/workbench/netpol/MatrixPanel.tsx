import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { Grid3x3, Radar, X } from 'lucide-react';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import {
  namespaceMatrix,
  simulate,
  type Coverage,
  type MatrixCell,
  type NpSelection,
  type Protocol,
  type WorkloadGroup,
} from '@/lib/kube/netpol';
import type { SearchableOption } from '@/lib/selectSearch';
import type { ClusterId } from '@/types';
import { Card } from '../overview/charts';
import { CoverageChip, PairExplanation, type ExplainLinks } from './Explanation';
import {
  COVERAGE_DOT,
  COVERAGE_FILL,
  coverageLabel,
  parsePortInput,
  PROTOCOL_OPTIONS,
} from './labels';
import { openNetpolSimulator, useNetpolStore, useNetpolViewState } from './netpolStore';
import type { NetpolData } from './useNetpolData';

/** Workload × workload reachability of one namespace as an SVG grid (theme tokens only). */

const CELL = 22;
const GAP = 2;
const EXTERNAL = -1;

interface CellRef {
  row: number; // group index or EXTERNAL
  col: number;
}

const EXTERNAL_CIDR = '0.0.0.0/0';

function textWidth(text: string, size = 11) {
  return text.length * size * 0.58;
}

function selectionOf(namespace: string, group: WorkloadGroup | null): NpSelection {
  return group
    ? { type: 'workload', namespace, kind: group.workload.kind, name: group.workload.name }
    : { type: 'external', cidr: EXTERNAL_CIDR };
}

export function MatrixPanel({
  clusterId,
  data,
  namespaces,
  links,
}: {
  clusterId: ClusterId;
  data: NetpolData;
  namespaces: readonly string[];
  links: ExplainLinks;
}) {
  i18n.useLocale();
  const state = useNetpolViewState(clusterId);
  const patch = useNetpolStore.getState().patch;
  const { cluster } = data;

  const nsOptions = useMemo<SearchableOption[]>(
    () =>
      [...cluster.podsByNamespace.keys()].sort().map((name) => ({
        value: name,
        label: name,
        badge: String(cluster.policiesByNamespace.get(name)?.length ?? 0),
        description: i18n.plural(
          '{count} NetworkPolicy',
          '{count} NetworkPolicies',
          cluster.policiesByNamespace.get(name)?.length ?? 0,
        ),
      })),
    [cluster],
  );
  const namespace =
    state.matrixNamespace && cluster.podsByNamespace.has(state.matrixNamespace)
      ? state.matrixNamespace
      : (namespaces.find((n) => cluster.podsByNamespace.has(n)) ??
        [...cluster.policiesByNamespace.keys()].find((n) => cluster.podsByNamespace.has(n)) ??
        nsOptions[0]?.value ??
        null);

  const portInput = parsePortInput(state.matrixPort);
  const port =
    typeof portInput === 'number' ? { protocol: state.matrixProtocol, port: portInput } : null;
  const matrix = useMemo(
    () => (namespace ? namespaceMatrix(cluster, namespace, port) : null),
    // `port` is rebuilt every render; its fields are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cluster, namespace, port?.protocol, port?.port],
  );

  const [hover, setHover] = useState<CellRef | null>(null);
  const [pinned, setPinned] = useState<CellRef | null>(null);
  const [cursor, setCursor] = useState<CellRef | null>(null);
  const active = hover ?? pinned;

  const groups = matrix?.groups ?? [];
  const names = groups.map((g) => g.workload.name);
  const outsideLabel = i18n.t('Outside the cluster');
  const rowLabels = [...names, outsideLabel];
  const labelW = Math.min(200, Math.max(90, ...rowLabels.map((n) => textWidth(n) + 16)));
  const headerH = Math.min(
    150,
    Math.max(60, ...rowLabels.map((n) => Math.min(textWidth(n), 190) * 0.82 + 18)),
  );
  const n = groups.length;
  const size = n + 1; // + outside
  const gridW = size * (CELL + GAP);
  const width = labelW + gridW + 8;
  const height = headerH + gridW + 4;

  const cellAt = (ref: CellRef): MatrixCell | null => {
    if (!matrix) return null;
    if (ref.row === EXTERNAL && ref.col === EXTERNAL) return null;
    if (ref.row === EXTERNAL) return matrix.fromExternal[ref.col] ?? null;
    if (ref.col === EXTERNAL) return matrix.toExternal[ref.row] ?? null;
    return matrix.cells[ref.row]?.[ref.col] ?? null;
  };
  const idx = (i: number) => (i === EXTERNAL ? n : i);
  const fromIdx = (i: number) => (i === n ? EXTERNAL : i);

  const explanation = useMemo(() => {
    if (!active || !namespace || !cellAt(active)) return null;
    const src = selectionOf(namespace, active.row === EXTERNAL ? null : groups[active.row]!);
    const dst = selectionOf(namespace, active.col === EXTERNAL ? null : groups[active.col]!);
    return {
      src,
      dst,
      result: simulate(cluster, {
        source: src,
        destination: dst,
        protocol: state.matrixProtocol,
        port: typeof portInput === 'number' || typeof portInput === 'string' ? portInput : null,
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.row, active?.col, matrix, namespace, state.matrixProtocol, state.matrixPort]);

  const counts = useMemo(() => {
    const c: Record<Coverage, number> = { all: 0, some: 0, none: 0 };
    for (const row of matrix?.cells ?? []) for (const cell of row) c[cell.coverage]++;
    return c;
  }, [matrix]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cur = cursor ?? { row: 0, col: 0 };
    const move: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const m = move[e.key];
    if (m) {
      e.preventDefault();
      const r = Math.max(0, Math.min(size - 1, idx(cur.row) + m[0]));
      const c = Math.max(0, Math.min(size - 1, idx(cur.col) + m[1]));
      const next = { row: fromIdx(r), col: fromIdx(c) };
      setCursor(next);
      setHover(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (cursor) setPinned(cursor);
    } else if (e.key === 'Escape') {
      setPinned(null);
      setHover(null);
    }
  };

  const cellTitle = (ref: CellRef, cell: MatrixCell) => {
    const from = ref.row === EXTERNAL ? outsideLabel : names[ref.row];
    const to = ref.col === EXTERNAL ? outsideLabel : names[ref.col];
    return `${from} → ${to}: ${coverageLabel(cell.coverage)} · ${i18n.t(
      '{reachable} of {total} pod pairs',
      { reachable: cell.reachable, total: cell.pairs },
    )}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchableSelect
          value={namespace ?? ''}
          onChange={(v) => {
            patch(clusterId, { matrixNamespace: v });
            setPinned(null);
            setHover(null);
          }}
          options={nsOptions}
          label="Namespace"
          placeholder={i18n.t('Namespace…')}
          compact
          className="border-border/70 max-w-[260px] border"
        />
        <Select<Protocol>
          value={state.matrixProtocol}
          onChange={(matrixProtocol) => patch(clusterId, { matrixProtocol })}
          options={PROTOCOL_OPTIONS}
          ariaLabel={i18n.t('Protocol')}
        />
        <input
          value={state.matrixPort}
          onChange={(e) => patch(clusterId, { matrixPort: e.target.value })}
          placeholder={i18n.t('Declared ports')}
          aria-label={i18n.t('Filter by port')}
          spellCheck={false}
          className={cn(
            'bg-surface border-border text-fg placeholder:text-fg-dim focus:border-accent/50 h-7 w-32 min-w-0 rounded-md border px-2 font-mono text-[12px] outline-none',
            portInput === 'invalid' && 'border-status-error/60',
          )}
        />
        <span className="flex-1" />
        <div className="flex flex-wrap items-center gap-3">
          {(['all', 'some', 'none'] as const).map((c) => (
            <span key={c} className="text-fg-dim flex items-center gap-1.5 text-[11px]">
              <span className={cn('h-2 w-2 rounded-[3px]', COVERAGE_DOT[c])} />
              {coverageLabel(c)}
              <span className="tabular-nums">{counts[c]}</span>
            </span>
          ))}
        </div>
      </div>
      {typeof portInput === 'string' && portInput !== 'invalid' && (
        <p className="text-fg-dim text-[11.5px]">
          {i18n.t('The grid uses port numbers; named ports are evaluated when you pick a cell.')}
        </p>
      )}
      <Card
        title={i18n.t('Who can reach whom')}
        icon={<Grid3x3 />}
        actions={
          namespace ? (
            <span lang="en" className="text-fg-dim truncate font-mono text-[11px]">
              {namespace}
            </span>
          ) : undefined
        }
      >
        {!matrix || !groups.length ? (
          <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
            {i18n.t('No running pods in this namespace.')}
          </p>
        ) : (
          <div className="overlay-scroll overflow-auto p-3">
            <svg
              width={width}
              height={height}
              role="img"
              tabIndex={0}
              aria-label={i18n.t('Reachability matrix of {namespace}', {
                namespace: namespace ?? '',
              })}
              onKeyDown={onKeyDown}
              onPointerLeave={() => setHover(null)}
              className="block outline-none"
            >
              <text
                x={labelW - 6}
                y={headerH - 6}
                textAnchor="end"
                className="fill-fg-dim text-[9.5px] font-semibold"
                style={{ letterSpacing: '0.1em' }}
              >
                {i18n.t('FROM ↓  TO →')}
              </text>
              {rowLabels.map((label, c) => {
                const col = fromIdx(c);
                const x = labelW + c * (CELL + GAP) + CELL / 2;
                const hot = active?.col === col;
                return (
                  <text
                    key={`col-${c}`}
                    transform={`translate(${x + 4},${headerH - 6}) rotate(-55)`}
                    className={cn(
                      'text-[11px]',
                      hot
                        ? 'fill-fg font-medium'
                        : col === EXTERNAL
                          ? 'fill-fg-dim italic'
                          : 'fill-fg-muted',
                    )}
                  >
                    <title>
                      {col === EXTERNAL ? outsideLabel : `${groups[col]!.workload.kind} ${label}`}
                    </title>
                    {label.length > 30 ? `${label.slice(0, 29)}…` : label}
                  </text>
                );
              })}
              {rowLabels.map((label, r) => {
                const row = fromIdx(r);
                const y = headerH + r * (CELL + GAP) + CELL / 2 + 4;
                const hot = active?.row === row;
                const max = Math.floor((labelW - 12) / (11 * 0.58));
                return (
                  <text
                    key={`row-${r}`}
                    x={labelW - 8}
                    y={y}
                    textAnchor="end"
                    className={cn(
                      'text-[11px]',
                      hot
                        ? 'fill-fg font-medium'
                        : row === EXTERNAL
                          ? 'fill-fg-dim italic'
                          : 'fill-fg-muted',
                    )}
                  >
                    <title>
                      {row === EXTERNAL ? outsideLabel : `${groups[row]!.workload.kind} ${label}`}
                    </title>
                    {label.length > max ? `${label.slice(0, max - 1)}…` : label}
                  </text>
                );
              })}
              {rowLabels.map((_, r) =>
                rowLabels.map((__, c) => {
                  const ref = { row: fromIdx(r), col: fromIdx(c) };
                  const cell = cellAt(ref);
                  const x = labelW + c * (CELL + GAP);
                  const y = headerH + r * (CELL + GAP);
                  if (!cell)
                    return (
                      <rect
                        key={`${r}-${c}`}
                        x={x}
                        y={y}
                        width={CELL}
                        height={CELL}
                        rx={4}
                        className="fill-fg/4"
                      />
                    );
                  const isActive = active?.row === ref.row && active.col === ref.col;
                  const isPinned = pinned?.row === ref.row && pinned.col === ref.col;
                  const dim =
                    active && !isActive && active.row !== ref.row && active.col !== ref.col;
                  return (
                    <rect
                      key={`${r}-${c}`}
                      x={x}
                      y={y}
                      width={CELL}
                      height={CELL}
                      rx={4}
                      onPointerEnter={() => setHover(ref)}
                      onClick={() => {
                        setPinned(isPinned ? null : ref);
                        setCursor(ref);
                      }}
                      strokeWidth={isActive || isPinned ? 2 : 0}
                      className={cn(
                        'cursor-pointer transition-opacity duration-100',
                        COVERAGE_FILL[cell.coverage],
                        (isActive || isPinned) && 'stroke-fg',
                        dim && 'opacity-45',
                      )}
                    >
                      <title>{cellTitle(ref, cell)}</title>
                    </rect>
                  );
                }),
              )}
            </svg>
          </div>
        )}
      </Card>
      {explanation && active && namespace && (
        <Card
          title={i18n.t('Selected cell')}
          icon={<Radar />}
          actions={
            <>
              <button
                type="button"
                onClick={() =>
                  openNetpolSimulator(clusterId, {
                    mode: 'simulate',
                    source: explanation.src,
                    destination: explanation.dst,
                    protocol: state.matrixProtocol,
                    port: state.matrixPort,
                  })
                }
                className="text-accent hover:bg-accent/10 rounded-md px-2 py-0.5 text-[11px] font-medium"
              >
                {i18n.t('Open in simulator')}
              </button>
              {pinned && (
                <button
                  type="button"
                  onClick={() => setPinned(null)}
                  aria-label={i18n.t('Unpin')}
                  className="text-fg-dim hover:text-fg rounded-md p-0.5"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          }
        >
          <div className="space-y-3 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <CoverageChip
                coverage={
                  explanation.result.verdict === 'allowed'
                    ? 'all'
                    : explanation.result.verdict === 'partial'
                      ? 'some'
                      : 'none'
                }
              />
              <span className="text-fg-dim text-[11.5px] tabular-nums">
                {i18n.t('{allowed} of {total} connections allowed', {
                  allowed: explanation.result.counts.all + explanation.result.counts.some,
                  total: explanation.result.pairs,
                })}
              </span>
            </div>
            {explanation.result.groups[0] && (
              <PairExplanation pair={explanation.result.groups[0].example} links={links} />
            )}
            {explanation.result.groups.length > 1 && (
              <p className="text-fg-dim text-[11px]">
                {i18n.plural(
                  '{count} other kind of connection; open the simulator to see them all.',
                  '{count} other kinds of connections; open the simulator to see them all.',
                  explanation.result.groups.length - 1,
                )}
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
