import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronsDownUp, Info, Loader2, Search, TriangleAlert, Workflow, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { kindIcon } from '@/lib/kube/icons';
import {
  DEFAULT_MAX_NODES,
  deriveView,
  EDGE_FAMILY,
  layoutTopology,
  matchNodes,
  type EdgeFamily,
  type TopoGraph,
  type TopologyView,
  type TopoNode,
} from '@/lib/kube/topology';
import { pausedMemo, type PausedMemo } from './dataKey';
import { TopologyCanvas, type FocusRequest } from './TopologyCanvas';
import { TopologyLegend } from './TopologyLegend';
import { isStringArray, usePersistentJson } from './persist';
import type { TopologyWatchError } from './useTopologyData';
import type { ReachState } from '@/lib/kube/netpol/overlay';

/**
 * A relationship map with its controls: search, kind filter chips, pod
 * group expansion, legend and notices. Shared by the namespace Resource Map
 * view and the details panel's Map tab.
 */
export function TopologyMap({
  label,
  graph,
  rootId,
  hops,
  selectedId,
  showNamespace,
  persistKey,
  active,
  synced,
  errors,
  fitKey,
  focusRequest,
  onOpen,
  toolbar,
  footer,
  emptyText,
  overlay,
  overlayNotice,
}: {
  label: string;
  graph: TopoGraph;
  rootId: string | null;
  hops: number;
  /** Highlighted node (accent strip); defaults to the root. */
  selectedId: string | null;
  showNamespace: boolean;
  /** Separate filter preferences per surface. */
  persistKey: string;
  /** False while the surface is hidden: the view and layout are not recomputed. */
  active: boolean;
  synced: boolean;
  errors: readonly TopologyWatchError[];
  /** Changing it (scope, root) refits the map and collapses groups. */
  fitKey: string;
  focusRequest: FocusRequest | null;
  onOpen: (node: TopoNode) => void;
  toolbar?: ReactNode;
  /** Status bar under the map, with the counts of the scoped graph. */
  footer?: (stats: { objects: number; relationships: number }) => ReactNode;
  emptyText: string;
  /** Reachability overlay (NetworkPolicy simulator) and its legend. */
  overlay?: ReadonlyMap<string, ReachState> | null;
  overlayNotice?: ReactNode;
}) {
  i18n.useLocale();
  const [search, setSearch] = useState('');
  const [hiddenList, setHiddenList] = usePersistentJson<string[]>(
    `kubepit.topology.hidden.${persistKey}`,
    [],
    isStringArray,
  );
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [fitRequest, setFitRequest] = useState(0);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  /** Index of the match the last Enter jumped to (-1: none yet). */
  const matchCursor = useRef(-1);

  useEffect(() => {
    setExpanded(new Set());
    setFitRequest((n) => n + 1);
  }, [fitKey]);
  // Refit once every watch delivered its list (the map grows while they sync).
  const wasSynced = useRef(false);
  useEffect(() => {
    if (synced && !wasSynced.current) setFitRequest((n) => n + 1);
    wasSynced.current = synced;
  }, [synced]);
  // External focus requests apply after that fit, in the same frame.
  useEffect(() => {
    if (focusRequest && synced) setFocus({ ...focusRequest, rev: Date.now() });
  }, [focusRequest, synced]);

  // Paused while hidden, so leaving the view never re-derives or re-lays out.
  const viewMemo = useRef<PausedMemo<TopologyView> | null>(null);
  viewMemo.current = pausedMemo(
    viewMemo.current,
    [graph, rootId, hops, expanded, hidden],
    active,
    () =>
      deriveView(graph, {
        rootId,
        hops,
        expanded,
        hiddenKinds: hidden,
        maxNodes: DEFAULT_MAX_NODES,
      }),
  );
  const view = viewMemo.current.value;

  // Layout only depends on structure, so status changes never move nodes.
  const structure = useMemo(
    () =>
      `${view.nodes.map((n) => `${n.id}@${n.tier}`).join('\n')}#${view.edges.map((e) => e.id).join('\n')}`,
    [view],
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const layout = useMemo(
    () => layoutTopology(viewRef.current.nodes, viewRef.current.edges),
    [structure],
  );
  const nodes = useMemo(() => new Map(view.nodes.map((n) => [n.id, n])), [view]);

  const matches = useMemo(() => new Set(matchNodes(view.nodes, search)), [view.nodes, search]);
  const matchList = useMemo(
    () => [...layout.columns.flat()].filter((id) => matches.has(id)),
    [layout, matches],
  );
  useEffect(() => {
    matchCursor.current = -1;
  }, [search]);

  const activeId = useMemo(() => {
    const wanted = selectedId ?? rootId;
    if (!wanted) return null;
    if (nodes.has(wanted)) return wanted;
    return view.nodes.find((n) => n.group?.members.includes(wanted))?.id ?? null;
  }, [selectedId, rootId, nodes, view.nodes]);

  const families = useMemo(() => {
    const set = new Set<EdgeFamily>();
    for (const e of view.edges) set.add(EDGE_FAMILY[e.kind]);
    return set;
  }, [view.edges]);

  const activate = (node: TopoNode) => {
    if (node.aggregate) return;
    if (node.group) {
      const next = new Set(expanded);
      next.add(node.id);
      setExpanded(next);
      return;
    }
    onOpen(node);
  };

  const toggleKind = (kind: string) =>
    setHiddenList(
      hidden.has(kind) ? hiddenList.filter((k) => k !== kind) : [...hiddenList, kind].sort(),
    );

  const nextMatch = (step: 1 | -1) => {
    const n = matchList.length;
    if (!n) return;
    const i =
      matchCursor.current < 0 ? (step > 0 ? 0 : n - 1) : (matchCursor.current + step + n) % n;
    matchCursor.current = i;
    setFocus({ id: matchList[i]!, rev: Date.now() });
  };

  const loadingEmpty = !synced && view.nodes.length === 0;
  const hiddenKinds = view.kinds.filter((k) => hidden.has(k.kind));
  const forbidden = errors.filter((e) => e.forbidden).map((e) => e.kind);
  const failed = errors.filter((e) => !e.forbidden).map((e) => e.kind);
  const expandedGroups = [...expanded].filter((id) => id.startsWith('group|'));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex h-10 shrink-0 items-center gap-2 border-b px-3">
        {toolbar}
        <div className="bg-surface border-border focus-within:border-accent/50 flex h-7 w-52 min-w-24 shrink items-center gap-2 rounded-lg border px-2.5 transition-colors">
          <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearch('');
              if (e.key === 'Enter') nextMatch(e.shiftKey ? -1 : 1);
            }}
            placeholder={i18n.t('Search the map…')}
            aria-label={i18n.t('Search the map')}
            title={i18n.t('Highlights matching names; Enter jumps to the next match')}
            className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={i18n.t('Clear search')}
              className="text-fg-dim hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {search && (
          <span className="text-fg-dim shrink-0 text-[11px] tabular-nums">
            {i18n.plural('{count} match', '{count} matches', matchList.length)}
          </span>
        )}
        <span className="flex-1" />
        {expandedGroups.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(new Set())}
            className="text-fg-muted hover:bg-fg/5 hover:text-fg flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px]"
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
            {i18n.t('Collapse pods')}
          </button>
        )}
      </div>
      {view.kinds.length > 0 && (
        <div
          role="toolbar"
          aria-label={i18n.t('Filter kinds')}
          className="border-border/60 overlay-scroll flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-1.5"
        >
          {view.kinds.map((k) => {
            const Icon = kindIcon(k.kindKey);
            const off = hidden.has(k.kind);
            return (
              <button
                key={k.kind}
                type="button"
                aria-pressed={!off}
                onClick={() => toggleKind(k.kind)}
                title={
                  off
                    ? i18n.t('Show {kind}', { kind: k.kind })
                    : i18n.t('Hide {kind}', { kind: k.kind })
                }
                className={cn(
                  'flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition',
                  off
                    ? 'border-border/60 text-fg-dim hover:text-fg-muted border-dashed'
                    : 'border-border bg-surface-raised text-fg-muted hover:border-border-strong hover:text-fg',
                )}
              >
                <Icon className={cn('h-3 w-3', off ? 'opacity-50' : 'text-fg-dim')} />
                <span className={cn(off && 'decoration-fg-dim/60 line-through')}>{k.kind}</span>
                <span className="text-fg-dim tabular-nums">{k.count}</span>
              </button>
            );
          })}
          {hiddenKinds.length > 0 && (
            <button
              type="button"
              onClick={() => setHiddenList([])}
              className="text-accent hover:bg-accent/10 ml-1 h-6 shrink-0 rounded-md px-2 text-[11px] font-medium"
            >
              {i18n.t('Show all')}
            </button>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {view.nodes.length > 0 && (
          <TopologyCanvas
            label={label}
            nodes={nodes}
            edges={view.edges}
            layout={layout}
            activeId={activeId}
            matches={matches}
            showNamespace={showNamespace}
            fitRequest={fitRequest}
            focusRequest={focus}
            onActivate={activate}
            overlay={overlay}
          />
        )}
        {view.nodes.length > 0 && <TopologyLegend families={families} />}
        {(view.aggregated > 0 || forbidden.length > 0 || failed.length > 0 || !!overlayNotice) && (
          <div className="pointer-events-none absolute top-2 left-3 flex max-w-[calc(100%-1.5rem)] flex-col gap-1">
            {overlayNotice}
            {view.aggregated > 0 && (
              <p className="border-border bg-surface-raised/95 text-fg-muted pointer-events-auto flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] shadow-sm">
                <Info className="text-cat-frontend mt-px h-3.5 w-3.5 shrink-0" />
                {i18n.t(
                  'Showing {shown} of {total} objects: {folded} are folded into “+N more” nodes. Pick fewer namespaces or hide kinds to see them.',
                  {
                    shown: view.nodes.length,
                    total: view.total,
                    folded: view.aggregated,
                  },
                )}
              </p>
            )}
            {forbidden.length > 0 && (
              <p className="border-border bg-surface-raised/95 text-fg-muted pointer-events-auto flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] shadow-sm">
                <TriangleAlert className="text-status-starting mt-px h-3.5 w-3.5 shrink-0" />
                {i18n.t('No access to {kinds}; their relationships are incomplete.', {
                  kinds: forbidden.join(', '),
                })}
              </p>
            )}
            {failed.length > 0 && (
              <p className="border-border bg-surface-raised/95 text-fg-muted pointer-events-auto flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] shadow-sm">
                <TriangleAlert className="text-status-error mt-px h-3.5 w-3.5 shrink-0" />
                {i18n.t('Could not load {kinds}.', { kinds: failed.join(', ') })}
              </p>
            )}
          </div>
        )}
        {view.nodes.length === 0 && (
          <div className="text-fg-muted flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-[12px]">
            {loadingEmpty ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {i18n.t('Loading relationships…')}
              </>
            ) : (
              <>
                <span className="bg-fg/5 text-fg-dim flex h-10 w-10 items-center justify-center rounded-xl">
                  <Workflow className="h-5 w-5" />
                </span>
                <span>
                  {hiddenKinds.length ? i18n.t('Every kind on this map is hidden.') : emptyText}
                </span>
              </>
            )}
          </div>
        )}
      </div>
      {footer?.({ objects: view.total, relationships: view.relationships })}
    </div>
  );
}
