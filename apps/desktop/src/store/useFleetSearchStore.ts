import { create } from 'zustand';
import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import {
  DEFAULT_SEARCH_KINDS,
  SEARCH_KINDS,
  buildFleetQuery,
  effectiveKinds,
  parseSearchInput,
  type ParsedSearch,
} from '@/lib/fleet/searchQuery';
import type {
  ApiResourceInfo,
  ClusterDef,
  ClusterEnvironment,
  ClusterId,
  FleetSearchEvent,
  FleetSearchItem,
} from '@/types';
import { useAppStore } from './useAppStore';
import { useWorkbenchStore } from './useWorkbenchStore';
import {
  savedSearchScopeExists,
  searchSnapshot,
  type FleetSearchSnapshot,
} from '@/lib/fleet/savedSearches';

/**
 * Fleet search state (the "Fleet search" main tab). Lives in a store so
 * results survive switching tabs and the palette / ⌘⇧F can hand over a
 * query. Every run bumps `generation`; events of an older run are ignored,
 * and the backend search it started is cancelled.
 */

export type SearchScope =
  | { kind: 'all' }
  | { kind: 'section'; id: string }
  | { kind: 'environment'; env: ClusterEnvironment };

export type ClusterSearchState = 'running' | 'done' | 'error' | 'skipped';

export interface ClusterResult {
  state: ClusterSearchState;
  items: FleetSearchItem[];
  truncated: boolean;
  forbidden: string[];
  error: string | null;
  /** ms from start to this cluster's last event. */
  elapsed: number | null;
}

interface FleetSearchState {
  input: string;
  /** Kind chips (kind keys). */
  kinds: string[];
  scope: SearchScope;
  generation: number;
  searchId: string | null;
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
  /** The query could not start (invalid regex, no kinds…). */
  error: string | null;
  /** The input the current results belong to (for highlighting). */
  query: string;
  /** `searchSignature` of the last run; the view re-runs when it changes. */
  signature: string;
  parsed: ParsedSearch | null;
  order: ClusterId[];
  results: Record<ClusterId, ClusterResult>;
  /** Bumped to move keyboard focus into the search box. */
  focusToken: number;
  setInput: (input: string) => void;
  toggleKind: (key: string) => void;
  setScope: (scope: SearchScope) => void;
  /** Restore all query fields together; the visible view runs its normal
   * validation/debounce. This never connects a cluster. */
  applySavedSearch: (snapshot: FleetSearchSnapshot) => 'applied' | 'missing-section' | 'invalid';
  run: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

const PREFS_KEY = 'kubepit.fleetSearch.v1';

function loadPrefs(): { kinds: string[]; scope: SearchScope } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as {
      kinds?: unknown;
      scope?: SearchScope;
    } | null;
    const known = new Set(SEARCH_KINDS.map((k) => k.def.key));
    const kinds = Array.isArray(raw?.kinds)
      ? raw.kinds.filter((k): k is string => typeof k === 'string' && known.has(k))
      : null;
    return {
      kinds: kinds?.length ? kinds : DEFAULT_SEARCH_KINDS,
      scope: raw?.scope ?? { kind: 'all' },
    };
  } catch {
    return { kinds: DEFAULT_SEARCH_KINDS, scope: { kind: 'all' } };
  }
}

function savePrefs(kinds: string[], scope: SearchScope) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ kinds, scope }));
  } catch {
    /* storage unavailable */
  }
}

/** Discovery of any open workbench, so `kind:certificate` resolves CRDs too. */
function knownResources(): ApiResourceInfo[] {
  const seen = new Map<string, ApiResourceInfo>();
  for (const list of Object.values(useWorkbenchStore.getState().apiResources))
    for (const r of list) seen.set(`${r.group}/${r.plural}`, r);
  return [...seen.values()];
}

/** Clusters a search covers: the scope, narrowed by `cluster:` / `env:` tokens. */
export function targetClusters(
  clusters: ClusterDef[],
  scope: SearchScope,
  clusterSection: Record<ClusterId, string>,
  parsed: ParsedSearch | null,
): ClusterDef[] {
  return clusters.filter((c) => {
    if (scope.kind === 'section' && clusterSection[c.id] !== scope.id) return false;
    if (scope.kind === 'environment' && c.environment !== scope.env) return false;
    if (parsed?.environments.length && !parsed.environments.includes(c.environment!)) return false;
    if (parsed?.clusters.length) {
      const name = c.name.toLowerCase();
      if (!parsed.clusters.some((q) => name.includes(q))) return false;
    }
    return true;
  });
}

const KIND_ORDER = new Map(SEARCH_KINDS.map((k, i) => [`${k.def.group}/${k.def.plural}`, i]));

function compareItems(a: FleetSearchItem, b: FleetSearchItem) {
  const ka = KIND_ORDER.get(`${a.gvk.group}/${a.gvk.plural}`) ?? 99;
  const kb = KIND_ORDER.get(`${b.gvk.group}/${b.gvk.plural}`) ?? 99;
  return (
    ka - kb ||
    a.gvk.kind.localeCompare(b.gvk.kind) ||
    (a.namespace ?? '').localeCompare(b.namespace ?? '') ||
    a.name.localeCompare(b.name)
  );
}

/** Identity of a search request; the view re-runs when the inputs change. */
export function searchSignature(input: string, kinds: string[], scope: SearchScope): string {
  return `${input.trim()}\u0000${kinds.join(',')}\u0000${JSON.stringify(scope)}`;
}

function emptyResult(state: ClusterSearchState): ClusterResult {
  return { state, items: [], truncated: false, forbidden: [], error: null, elapsed: null };
}

const prefs = loadPrefs();

export const useFleetSearchStore = create<FleetSearchState>((set, get) => {
  const apply = (event: FleetSearchEvent) => {
    set((s) => {
      if (event.kind === 'done') return { running: false, finishedAt: Date.now() };
      const id = event.cluster_id;
      if (!id) return s;
      const current = s.results[id] ?? emptyResult('running');
      const elapsed = Date.now() - s.startedAt;
      let next: ClusterResult = current;
      switch (event.kind) {
        case 'results':
          next = {
            ...current,
            items: [...current.items, ...event.items].sort(compareItems),
            truncated: current.truncated || event.truncated,
          };
          break;
        case 'cluster-done':
          next = { ...current, state: 'done', forbidden: event.forbidden_kinds, elapsed };
          break;
        case 'cluster-error':
          next = {
            ...current,
            state: 'error',
            forbidden: event.forbidden_kinds,
            error: event.error,
            elapsed,
          };
          break;
        case 'cluster-skipped':
          next = { ...current, state: 'skipped', error: event.error, elapsed };
          break;
      }
      return {
        results: { ...s.results, [id]: next },
        order: s.order.includes(id) ? s.order : [...s.order, id],
      };
    });
  };

  return {
    input: '',
    kinds: prefs.kinds,
    scope: prefs.scope,
    generation: 0,
    searchId: null,
    running: false,
    startedAt: 0,
    finishedAt: null,
    error: null,
    query: '',
    signature: '',
    parsed: null,
    order: [],
    results: {},
    focusToken: 0,
    setInput: (input) => set({ input }),
    toggleKind: (key) => {
      const current = get().kinds;
      const kinds = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      set({ kinds });
      savePrefs(kinds, get().scope);
    },
    setScope: (scope) => {
      set({ scope });
      savePrefs(get().kinds, scope);
    },
    applySavedSearch: (value) => {
      const snapshot = searchSnapshot(value);
      if (!snapshot) return 'invalid';
      if (!savedSearchScopeExists(snapshot.scope, useAppStore.getState().sections))
        return 'missing-section';
      const { searchId, running } = get();
      if (searchId && running) void ipc.fleetSearchCancel(searchId).catch(() => undefined);
      set((state) => ({
        ...snapshot,
        generation: state.generation + 1,
        focusToken: state.focusToken + 1,
        running: false,
        searchId: null,
        query: '',
        signature: '',
        parsed: null,
        order: [],
        results: {},
        error: null,
        finishedAt: null,
      }));
      savePrefs(snapshot.kinds, snapshot.scope);
      return 'applied';
    },
    cancel: () => {
      const { searchId, running } = get();
      if (searchId && running) void ipc.fleetSearchCancel(searchId).catch(() => undefined);
      set((s) => ({ running: false, generation: s.generation + 1, finishedAt: Date.now() }));
    },
    reset: () => {
      get().cancel();
      set({
        query: '',
        signature: '',
        parsed: null,
        order: [],
        results: {},
        error: null,
        finishedAt: null,
      });
    },
    run: async () => {
      const { input, kinds, scope, searchId: previous, running } = get();
      if (previous && running) void ipc.fleetSearchCancel(previous).catch(() => undefined);
      const parsed = parseSearchInput(input, knownResources());
      const app = useAppStore.getState();
      const targets = targetClusters(app.clusters, scope, app.clusterSection, parsed);
      const gvks = effectiveKinds(parsed, kinds);
      const generation = get().generation + 1;
      const base = {
        generation,
        query: input,
        signature: searchSignature(input, kinds, scope),
        parsed,
        searchId: null,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
      };
      if (!gvks.length || !targets.length) {
        set({
          ...base,
          running: false,
          order: [],
          results: {},
          error: !gvks.length
            ? i18n.t('Choose at least one kind to search.')
            : i18n.t('No cluster matches this scope.'),
        });
        return;
      }
      // Connected clusters first, in sidebar order; the rest are reported as skipped.
      const live = (c: ClusterDef) => app.statuses[c.id]?.state === 'connected';
      const ordered = [...targets.filter(live), ...targets.filter((c) => !live(c))];
      set({
        ...base,
        running: true,
        order: ordered.map((c) => c.id),
        results: Object.fromEntries(
          ordered.map((c) => [c.id, emptyResult(live(c) ? 'running' : 'skipped')]),
        ),
      });
      try {
        const query = buildFleetQuery(
          parsed,
          gvks,
          ordered.map((c) => c.id),
        );
        const id = await ipc.fleetSearch(query, (event) => {
          if (get().generation === generation) apply(event);
        });
        if (get().generation === generation) set({ searchId: id });
        else void ipc.fleetSearchCancel(id).catch(() => undefined);
      } catch (error) {
        if (get().generation !== generation) return;
        set({
          running: false,
          finishedAt: Date.now(),
          order: [],
          results: {},
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
});

/** Open (or focus) the Fleet search tab, optionally running `query` right away. */
export function openFleetSearch(query?: string) {
  const store = useFleetSearchStore.getState();
  useAppStore.getState().openMainTab({ kind: 'search' });
  if (query !== undefined && query.trim()) {
    store.setInput(query.trim());
    void store.run();
  }
  useFleetSearchStore.setState((s) => ({ focusToken: s.focusToken + 1 }));
}
