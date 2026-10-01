import * as i18n from '@/i18n/core';
import { create } from 'zustand';
import { openAndConnect } from '@/lib/clusterActions';
import { BUILTIN_KINDS, kindKey, resolveKindName } from '@/lib/kube/catalog';
import { VIEW_KEYS } from '@/lib/kube/nav';
import { useAppStore } from '@/store/useAppStore';
import { navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterDef } from '@/types';

/**
 * The k9s-style command bar (`:`): jump to a kind by name or short name
 * (`:po`, `:deploy kube-system`), `:ns <namespace>`, `:ctx <cluster>`,
 * `:q` and a few pages (`:overview`, `:health`, …).
 */

interface KeyboardUi {
  commandOpen: boolean;
  helpOpen: boolean;
  openCommand: () => void;
  closeCommand: () => void;
  toggleHelp: (open?: boolean) => void;
}

export const useKeyboardUi = create<KeyboardUi>((set) => ({
  commandOpen: false,
  helpOpen: false,
  openCommand: () => set({ commandOpen: true, helpOpen: false }),
  closeCommand: () => set({ commandOpen: false }),
  toggleHelp: (open) => set((s) => ({ helpOpen: open ?? !s.helpOpen, commandOpen: false })),
}));

/** Pages reachable by name (never translated: they are commands). */
export const VIEW_COMMANDS: Record<string, string> = {
  overview: VIEW_KEYS.clusterOverview,
  workloads: VIEW_KEYS.workloadsOverview,
  map: VIEW_KEYS.resourceMap,
  pf: VIEW_KEYS.portForwards,
  portforwards: VIEW_KEYS.portForwards,
  helm: VIEW_KEYS.helmReleases,
  charts: VIEW_KEYS.helmCharts,
  access: VIEW_KEYS.myPermissions,
  health: VIEW_KEYS.clusterHealth,
  explain: VIEW_KEYS.apiExplorer,
  gitops: VIEW_KEYS.gitops,
  changes: VIEW_KEYS.changes,
  recommendations: VIEW_KEYS.recommendations,
  investigations: VIEW_KEYS.investigations,
  doctor: VIEW_KEYS.connectionDoctor,
  network: VIEW_KEYS.networkDiagnostics,
};

const ALL_NAMESPACES = new Set(['all', '-a', '*']);
const QUIT = new Set(['q', 'q!', 'quit']);
const NS = new Set(['ns', 'namespace', 'namespaces']);
const CTX = new Set(['ctx', 'context', 'contexts']);
const HELP = new Set(['help', '?', 'h']);

export interface BarContext {
  clusterId: string | null;
  apiResources: readonly ApiResourceInfo[] | null;
  namespaces: readonly string[];
  clusters: readonly ClusterDef[];
}

export interface Suggestion {
  /** Text the input becomes when the suggestion is taken. */
  value: string;
  label: string;
  hint: string;
}

const tokens = (input: string) => input.replace(/^:+/, '').trim().split(/\s+/).filter(Boolean);

interface KindEntry {
  names: string[];
  kind: string;
  group: string;
  plural: string;
}

function kindEntries(apiResources: readonly ApiResourceInfo[] | null): KindEntry[] {
  const out = new Map<string, KindEntry>();
  for (const k of BUILTIN_KINDS)
    out.set(k.key, {
      names: [k.plural, k.kind.toLowerCase(), ...k.shortNames],
      kind: k.kind,
      group: k.group,
      plural: k.plural,
    });
  for (const r of apiResources ?? []) {
    const key = kindKey(r);
    if (out.has(key) || r.plural.includes('/')) continue;
    out.set(key, {
      names: [r.plural, r.kind.toLowerCase(), ...r.short_names],
      kind: r.kind,
      group: r.group,
      plural: r.plural,
    });
  }
  return [...out.values()];
}

function clusterMatch(clusters: readonly ClusterDef[], query: string): ClusterDef | null {
  const q = query.toLowerCase();
  const by = (f: (c: ClusterDef) => boolean) => clusters.filter(f);
  for (const found of [
    by((c) => c.name.toLowerCase() === q),
    by((c) => c.context.toLowerCase() === q),
    by((c) => c.name.toLowerCase().startsWith(q)),
    by((c) => c.name.toLowerCase().includes(q) || c.context.toLowerCase().includes(q)),
  ])
    if (found.length === 1) return found[0]!;
  return null;
}

export function suggestions(input: string, ctx: BarContext): Suggestion[] {
  const parts = tokens(input);
  const trailingSpace = /\s$/.test(input);
  const [head = '', second = ''] = parts;
  const first = head.toLowerCase();
  const typingFirst = parts.length <= 1 && !trailingSpace;
  if (typingFirst) {
    const out: Suggestion[] = [];
    const add = (value: string, label: string, hint: string) => {
      if (value.startsWith(first) && !out.some((s) => s.value === value))
        out.push({ value, label, hint });
    };
    add('ns', 'ns', i18n.t('Switch namespace'));
    add('ctx', 'ctx', i18n.t('Switch cluster'));
    add('q', 'q', i18n.t('Close the current tab'));
    for (const name of Object.keys(VIEW_COMMANDS)) add(name, name, i18n.t('Page'));
    const kinds = kindEntries(ctx.apiResources)
      .map((k) => ({ k, name: k.names.find((n) => n.startsWith(first)) }))
      .filter((x): x is { k: KindEntry; name: string } => !!x.name && !!first)
      .sort((a, b) => a.name.length - b.name.length || a.k.plural.localeCompare(b.k.plural));
    for (const { k, name } of kinds) add(name, name, `${k.kind}${k.group ? ` · ${k.group}` : ''}`);
    return first ? out.slice(0, 8) : out.slice(0, 3);
  }
  const prefix = (trailingSpace && parts.length === 1 ? '' : second).toLowerCase();
  if (CTX.has(first))
    return ctx.clusters
      .filter((c) => c.name.toLowerCase().includes(prefix))
      .slice(0, 8)
      .map((c) => ({ value: `${head} ${c.name}`, label: c.name, hint: c.context }));
  const kind = NS.has(first) ? null : resolveKindName(first, ctx.apiResources);
  if (NS.has(first) || kind?.namespaced) {
    const names = ['all', ...ctx.namespaces].filter((n) => n.toLowerCase().startsWith(prefix));
    return names.slice(0, 8).map((n) => ({
      value: `${head} ${n}`,
      label: n,
      hint: n === 'all' ? i18n.t('All namespaces') : i18n.t('Namespace'),
    }));
  }
  return [];
}

/** Run a command; returns an error message, or null when it ran. */
export function execute(input: string, ctx: BarContext): string | null {
  const parts = tokens(input);
  if (!parts.length) return null;
  const [head, arg] = parts as [string, string | undefined];
  const first = head.toLowerCase();
  const app = useAppStore.getState();
  const wb = useWorkbenchStore.getState();

  if (HELP.has(first)) {
    useKeyboardUi.getState().toggleHelp(true);
    return null;
  }
  if (CTX.has(first)) {
    if (!arg) {
      app.goHome();
      return null;
    }
    const cluster = clusterMatch(ctx.clusters, parts.slice(1).join(' '));
    if (!cluster)
      return i18n.t('No single cluster matches “{query}”', { query: parts.slice(1).join(' ') });
    openAndConnect(cluster.id);
    return null;
  }
  const clusterId = ctx.clusterId;
  if (!clusterId) return i18n.t('Open a cluster first');
  if (QUIT.has(first)) {
    const active = wb.activeKind[clusterId];
    if (active) wb.closeTab(clusterId, active);
    return null;
  }
  const setNamespace = (value: string) =>
    wb.setNamespaces(clusterId, ALL_NAMESPACES.has(value.toLowerCase()) ? [] : [value]);
  if (NS.has(first)) {
    if (arg) setNamespace(arg);
    else {
      const gvk = resolveKindName('Namespace', ctx.apiResources);
      if (gvk) navigateTo(clusterId, gvk);
    }
    return null;
  }
  const view = VIEW_COMMANDS[first];
  if (view) {
    wb.setActiveKind(clusterId, view);
    return null;
  }
  const gvk = resolveKindName(head, ctx.apiResources);
  if (!gvk) return i18n.t('Unknown command or kind “{name}”', { name: head });
  if (arg && gvk.namespaced) setNamespace(arg);
  navigateTo(clusterId, gvk);
  return null;
}
