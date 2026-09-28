import * as i18n from '@/i18n/core';
import type {
  ClusterDef,
  CustomAction,
  CustomActionIcon,
  CustomActionTarget,
  Gvk,
  KubeObject,
} from '@/types';

/**
 * Pure helpers for custom actions (k9s-plugin style). Scope matching mirrors
 * `custom_actions/model.rs` so the UI offers exactly what the backend runs;
 * placeholder substitution itself only happens in the backend.
 */

export const CUSTOM_ACTION_ICONS: readonly CustomActionIcon[] = [
  'terminal',
  'play',
  'file-text',
  'search',
  'external-link',
  'bug',
  'zap',
  'wrench',
  'eye',
  'list',
  'activity',
  'git-branch',
  'cloud',
  'database',
  'shield',
  'trash',
  'refresh',
  'tag',
  'gauge',
  'rocket',
];

export const SCOPE_ANY = '*';
export const SCOPE_CLUSTER = 'cluster';
export const DEFAULT_TIMEOUT_SECS = 30;
export const MAX_TIMEOUT_SECS = 600;

/** Placeholders offered by the editor; tokens are identifiers and never translated. */
export const PLACEHOLDERS: ReadonlyArray<{ token: string; label: () => string }> = [
  { token: '{name}', label: () => i18n.t('Object name') },
  { token: '{namespace}', label: () => i18n.t('Namespace') },
  { token: '{kind}', label: () => i18n.t('Kind') },
  { token: '{resource}', label: () => i18n.t('Resource (plural)') },
  { token: '{group}', label: () => i18n.t('API group') },
  { token: '{version}', label: () => i18n.t('API version') },
  { token: '{container}', label: () => i18n.t('Container (asks when there are several)') },
  { token: '{labels.app}', label: () => i18n.t('A label value') },
  { token: '{annotations.key}', label: () => i18n.t('An annotation value') },
  { token: '{selection.names}', label: () => i18n.t('Every selected name (multi-select)') },
  { token: '{cluster}', label: () => i18n.t('Cluster name') },
  { token: '{context}', label: () => i18n.t('Kubeconfig context') },
  { token: '{kubeconfig}', label: () => i18n.t('Path of the cluster kubeconfig') },
];

export const usesContainer = (a: Pick<CustomAction, 'command'>) =>
  a.command.includes('{container}');

/** Actions using `{selection.names}` are offered for multi-select. */
export const isMultiSelect = (a: Pick<CustomAction, 'command'>) =>
  a.command.includes('{selection.names}');

export const isClusterLevel = (a: Pick<CustomAction, 'scopes'>) => a.scopes.includes(SCOPE_CLUSTER);

function scopeMatchesKind(scope: string, group: string, kind: string): boolean {
  if (scope === SCOPE_ANY) return true;
  if (scope === SCOPE_CLUSTER) return false;
  const at = scope.lastIndexOf('/');
  if (at < 0) return scope.toLowerCase() === kind.toLowerCase();
  const scopeGroup = scope.slice(0, at).toLowerCase();
  const scopeKind = scope.slice(at + 1);
  const groupOk = scopeGroup === 'core' ? group === '' : scopeGroup === group.toLowerCase();
  return groupOk && (scopeKind === '*' || scopeKind.toLowerCase() === kind.toLowerCase());
}

/** `*` / `?` glob, like the backend. */
export function globMatch(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(text);
}

export interface ScopeContext {
  cluster: Pick<ClusterDef, 'tags'> | undefined;
  /** Null for cluster-level contexts (no object). */
  kind: string | null;
  group: string;
  namespace: string | null;
}

/** Whether `action` is offered in `ctx` (enabled flag not included). */
export function actionApplies(action: CustomAction, ctx: ScopeContext): boolean {
  if (action.cluster_tags.length) {
    const tags = (ctx.cluster?.tags ?? []).map((t) => t.toLowerCase());
    if (!action.cluster_tags.some((t) => tags.includes(t.toLowerCase()))) return false;
  }
  if (!ctx.kind) return isClusterLevel(action);
  if (!action.scopes.some((s) => scopeMatchesKind(s, ctx.group, ctx.kind!))) return false;
  if (ctx.namespace && action.namespaces.length)
    return action.namespaces.some((g) => globMatch(g, ctx.namespace!));
  return true;
}

/** Target of one object. */
export function targetFor(
  obj: KubeObject,
  gvk: Gvk,
  container: string | null = null,
): CustomActionTarget {
  return {
    namespace: obj.metadata.namespace ?? null,
    name: obj.metadata.name,
    kind: gvk.kind,
    group: gvk.group,
    version: gvk.version,
    resource: gvk.plural,
    container,
    labels: { ...(obj.metadata.labels ?? {}) },
    annotations: { ...(obj.metadata.annotations ?? {}) },
    selection: [],
  };
}

/** Target of a multi-selection: the first object plus every name. */
export function selectionTarget(objs: readonly KubeObject[], gvk: Gvk): CustomActionTarget {
  const first = objs[0]!;
  const namespaces = new Set(objs.map((o) => o.metadata.namespace ?? ''));
  return {
    ...targetFor(first, gvk),
    namespace: namespaces.size === 1 ? (first.metadata.namespace ?? null) : null,
    selection: objs.map((o) => o.metadata.name),
  };
}

/** Target of a cluster-level run (`namespace` = the one in scope, if exactly one). */
export function clusterTarget(namespace: string | null): CustomActionTarget {
  return {
    namespace,
    name: null,
    kind: null,
    group: null,
    version: null,
    resource: null,
    container: null,
    labels: {},
    annotations: {},
    selection: [],
  };
}

interface Sample {
  kind: string;
  group: string;
  version: string;
  resource: string;
  name: string;
  namespace: string | null;
}

const SAMPLES: Sample[] = [
  {
    kind: 'Pod',
    group: '',
    version: 'v1',
    resource: 'pods',
    name: 'web-7d9f8c6b5-x2x9k',
    namespace: 'shop',
  },
  {
    kind: 'Deployment',
    group: 'apps',
    version: 'v1',
    resource: 'deployments',
    name: 'web',
    namespace: 'shop',
  },
  {
    kind: 'StatefulSet',
    group: 'apps',
    version: 'v1',
    resource: 'statefulsets',
    name: 'db',
    namespace: 'shop',
  },
  {
    kind: 'DaemonSet',
    group: 'apps',
    version: 'v1',
    resource: 'daemonsets',
    name: 'node-exporter',
    namespace: 'monitoring',
  },
  {
    kind: 'Service',
    group: '',
    version: 'v1',
    resource: 'services',
    name: 'web',
    namespace: 'shop',
  },
  { kind: 'Node', group: '', version: 'v1', resource: 'nodes', name: 'node-1', namespace: null },
  {
    kind: 'Namespace',
    group: '',
    version: 'v1',
    resource: 'namespaces',
    name: 'shop',
    namespace: null,
  },
  {
    kind: 'Application',
    group: 'argoproj.io',
    version: 'v1alpha1',
    resource: 'applications',
    name: 'shop',
    namespace: 'argocd',
  },
];

/** Sample object for the editor preview, picked from the action's first scope. */
export function sampleTarget(action: Pick<CustomAction, 'scopes' | 'command'>): CustomActionTarget {
  const scope = action.scopes.find((s) => s !== SCOPE_ANY && s !== SCOPE_CLUSTER);
  if (!scope && isClusterLevel(action) && !action.scopes.includes(SCOPE_ANY))
    return clusterTarget('default');
  const kindName = scope?.split('/').pop() ?? 'Pod';
  const group = scope?.includes('/') ? scope.slice(0, scope.lastIndexOf('/')) : null;
  const known =
    SAMPLES.find(
      (s) =>
        s.kind.toLowerCase() === kindName.toLowerCase() &&
        (group === null || (group === 'core' ? s.group === '' : s.group === group)),
    ) ?? SAMPLES[0]!;
  const sample: Sample =
    kindName === '*' || !scope || known.kind.toLowerCase() === kindName.toLowerCase()
      ? known
      : {
          kind: kindName,
          group: group === 'core' ? '' : (group ?? ''),
          version: 'v1',
          resource: `${kindName.toLowerCase()}s`,
          name: `my-${kindName.toLowerCase()}`,
          namespace: 'default',
        };
  return {
    namespace: sample.namespace,
    name: sample.name,
    kind: sample.kind,
    group: sample.group,
    version: sample.version,
    resource: sample.resource,
    container: sample.kind === 'Pod' || sample.kind === 'Deployment' ? 'app' : null,
    labels: { app: sample.name, 'app.kubernetes.io/name': sample.name },
    annotations: {},
    selection: isMultiSelect(action) ? [sample.name, `${sample.name}-2`] : [],
  };
}

export function blankAction(): CustomAction {
  return {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    icon: 'terminal',
    enabled: true,
    scopes: [SCOPE_ANY],
    namespaces: [],
    cluster_tags: [],
    command: '',
    mode: 'terminal',
    confirm: false,
    mutating: false,
    shortcut: null,
    timeout_secs: DEFAULT_TIMEOUT_SECS,
  };
}

/** `incoming` with ids (and shortcuts already taken) changed so they fit next to `existing`. */
export function withUniqueIds(
  existing: readonly CustomAction[],
  incoming: readonly CustomAction[],
) {
  const ids = new Set(existing.map((a) => a.id));
  return incoming.map((a) => {
    let id = a.id;
    if (!id || ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    return { ...a, id };
  });
}

/** Human summary of scopes: `Pod, apps/Deployment` / "Every object" / "Cluster". */
export function scopeSummary(scopes: readonly string[]): string {
  return scopes
    .map((s) =>
      s === SCOPE_ANY ? i18n.t('Every object') : s === SCOPE_CLUSTER ? i18n.t('Cluster') : s,
    )
    .join(', ');
}

/** Parse a comma / newline separated list field. */
export function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Kubepit's export format (what `custom_actions_import` reads back). */
export function exportActions(actions: readonly CustomAction[]): string {
  return `${JSON.stringify({ kubepit: 'custom-actions', version: 1, actions }, null, 2)}\n`;
}
