import YAML from 'yaml';
import { actionApplies } from '@/lib/customActions';
import { historySettings, TERMINAL_STARTED } from '@/lib/history/audit';
import { kindKey, resolveRef } from '@/lib/kube/catalog';
import type {
  AuditAction,
  AuditDetail,
  AuditEntry,
  AuditFilter,
  AuditObject,
  AuditPage,
  AuditTarget,
  ChangeDetail,
  ChangeFilter,
  ChangeSummary,
  ClusterDef,
  ClusterStatus,
  CustomAction,
  CustomActionMode,
  CustomActionResult,
  CustomActionsState,
  CustomActionTarget,
  Gvk,
  HistoryChangePage,
  HistoryEventFilter,
  HistoryEventPage,
  HistoryKind,
  HistoryStatus,
  HistoryTableStatus,
  KubeObject,
  ManifestApplyResult,
  Settings,
} from '@/types';
import { changedPaths, MAX_PATHS, normalize, seedHistory } from './fixtures/changes';
import { find, getDb, list } from './fixtures/db';
import { BOOT, DAY, HOUR, MIN, hashString, iso } from './fixtures/util';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo persistent history. The audit log is derived from the preview's own
 * mutations: every mutating demo command is wrapped (registered last, so it
 * sees the final handlers) and recorded like the backend does — targets,
 * redacted request, normalized before/after, outcome and duration, not on
 * read-only rejections, dry runs flagged. A few older entries are seeded so
 * the Activity view is not empty. `staging-gke` ships with persisted events
 * and changes older than the in-memory journal (as if Kubepit had been
 * keeping them for days).
 */

type Json = Record<string, unknown>;

interface Stored {
  entry: AuditEntry;
  objects: AuditObject[];
}

const audit: Stored[] = [];
let nextAuditId = 1;
const identities = new Map<string, string>();
let seeded = false;
/** Kinds of persisted data the user cleared (seeds do not come back). */
const cleared = new Set<string>();

/**
 * Stored recommendation scans of the demo backend as the history sees them:
 * rows and the oldest run for the status, and how to clear them.
 */
export interface RecommendationHistory {
  table(): HistoryTableStatus;
  clear(clusterId: string | null): void;
}

let recommendationHistory: RecommendationHistory | null = null;

/** Show the demo's stored recommendation scans in the history status and clears. */
export function provideRecommendationHistory(source: RecommendationHistory) {
  recommendationHistory = source;
}

function recommendationTable(): HistoryTableStatus {
  return recommendationHistory?.table() ?? { rows: 0, oldest_ts: null };
}

function settings(): Settings | undefined {
  return handlers.settings_get?.({}) as Settings | undefined;
}

function clusters(): ClusterDef[] {
  return (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
}

function statuses(): Record<string, ClusterStatus> {
  return (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined) ?? {};
}

// -- Redaction (keys stay, values become markers) -------------------------------

function marker(path: string, value: unknown): string {
  return `<redacted #${(hashString(`${path}\u0000${JSON.stringify(value)}`) >>> 0).toString(16).padStart(8, '0')}>`;
}

function redactLeaves(value: unknown, path: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => redactLeaves(v, `${path}[${i}]`));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Json).map(([k, v]) => [k, redactLeaves(v, `${path}.${k}`)]),
    );
  return value === null ? null : marker(path, value);
}

const secretLike = (kind: string) => kind.toLowerCase().endsWith('secret');

function redactPatch(kind: string, patch: unknown): unknown {
  if (!secretLike(kind)) return patch;
  if (Array.isArray(patch))
    return patch.map((op, i) =>
      op && typeof op === 'object'
        ? Object.fromEntries(
            Object.entries(op as Json).map(([k, v]) => [
              k,
              ['op', 'path', 'from'].includes(k) ? v : redactLeaves(v, `[${i}].${k}`),
            ]),
          )
        : redactLeaves(op, `[${i}]`),
    );
  return redactLeaves(patch, '');
}

function redactValues(values: string): unknown {
  if (!values.trim()) return {};
  try {
    return redactLeaves(YAML.parse(values), 'values');
  } catch {
    return `<unparsed values: ${values.length} bytes>`;
  }
}

function hasMarkers(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('<redacted #');
  if (Array.isArray(value)) return value.some(hasMarkers);
  if (value && typeof value === 'object') return Object.values(value as Json).some(hasMarkers);
  return false;
}

// -- Targets and objects -------------------------------------------------------

function objectTarget(gvk: Gvk, namespace: string | null, name: string): AuditTarget {
  return {
    api_version: gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version,
    kind: gvk.kind,
    gvk,
    namespace: gvk.namespaced ? (namespace ?? null) : null,
    name,
    error: null,
  };
}

function coreTarget(kind: 'Node' | 'Pod', namespace: string | null, name: string): AuditTarget {
  return objectTarget(
    {
      group: '',
      version: 'v1',
      kind,
      plural: kind === 'Node' ? 'nodes' : 'pods',
      namespaced: kind === 'Pod',
    },
    namespace,
    name,
  );
}

function releaseTarget(namespace: string, name: string): AuditTarget {
  return { api_version: 'helm.sh/v3', kind: 'Release', gvk: null, namespace, name, error: null };
}

function docTarget(doc: KubeObject | null, namespace: string | null): AuditTarget {
  const gvk = doc ? resolveRef(doc.apiVersion, doc.kind) : null;
  const name = doc?.metadata?.name ?? '?';
  if (gvk) return objectTarget(gvk, doc?.metadata?.namespace || namespace || 'default', name);
  return {
    api_version: doc?.apiVersion ?? '',
    kind: doc?.kind ?? 'object',
    gvk: null,
    namespace: doc?.metadata?.namespace ?? namespace,
    name,
    error: null,
  };
}

function live(clusterId: string, target: AuditTarget): KubeObject | null {
  if (!target.gvk) return null;
  const found = find(getDb(clusterId), kindKey(target.gvk), target.namespace, target.name);
  return found ? structuredClone(found) : null;
}

function parseDocs(text: string): (KubeObject | null)[] {
  try {
    return YAML.parseAllDocuments(text).map((d) => (d.toJSON() as KubeObject | null) ?? null);
  } catch {
    return [];
  }
}

const REVERTIBLE: AuditAction[] = ['apply', 'replace', 'patch', 'scale', 'set-image', 'rightsize'];

function objectOf(
  action: AuditAction,
  dryRun: boolean,
  target: AuditTarget,
  index: number,
  before: KubeObject | null,
  after: KubeObject | null,
): AuditObject | null {
  if (!before && !after) return null;
  const b = before ? normalize(before) : null;
  const a = after ? normalize(after) : null;
  const yaml = (o: Json | null) => (o ? YAML.stringify(o, { lineWidth: 0 }) : null);
  const revertible =
    REVERTIBLE.includes(action) &&
    !dryRun &&
    !secretLike(target.kind) &&
    !!b &&
    !!a &&
    JSON.stringify(b) !== JSON.stringify(a) &&
    !hasMarkers(b);
  return {
    target: index,
    before_yaml: yaml(b),
    after_yaml: yaml(a),
    omitted: false,
    revertible,
  };
}

// -- Recording -----------------------------------------------------------------

interface Plan {
  clusterId: string;
  action: AuditAction;
  targets: AuditTarget[];
  dryRun?: boolean;
  request?: Json | null;
  /** Objects before the call (per target). */
  before?: () => (KubeObject | null)[];
  /** Objects after the call (per target). */
  after?: (result: unknown) => (KubeObject | null)[];
  result?: (result: unknown) => string | null;
  /** A call that returned but partially failed (manifests apply). */
  failure?: (result: unknown, targets: AuditTarget[]) => string | null;
}

function record(
  plan: Plan,
  cluster: ClusterDef,
  started: number,
  error: string | null,
  before: (KubeObject | null)[],
  after: (KubeObject | null)[],
  result: string | null,
) {
  const dryRun = plan.dryRun ?? false;
  const objects = plan.targets
    .map((t, i) => objectOf(plan.action, dryRun, t, i, before[i] ?? null, after[i] ?? null))
    .filter((o): o is AuditObject => o !== null)
    .map((o) => (error ? { ...o, revertible: false } : o));
  audit.push({
    entry: {
      id: nextAuditId++,
      ts: started,
      cluster_id: cluster.id,
      cluster_name: cluster.name,
      context: cluster.context,
      identity: identities.get(cluster.id) ?? null,
      action: plan.action,
      dry_run: dryRun,
      outcome: error ? 'error' : 'ok',
      error,
      duration_ms: Math.max(1, Date.now() - started),
      targets: plan.targets,
      request: plan.request ?? null,
      result,
      has_diff: objects.some((o) => o.before_yaml || o.after_yaml),
      revertible: objects.some((o) => o.revertible),
    },
    objects,
  });
}

function wrap(command: string, plan: (args: MockArgs) => Plan | null) {
  const inner = handlers[command];
  if (!inner) return;
  register({
    [command]: async (args: MockArgs) => {
      const p = plan(args);
      const cluster = p ? clusters().find((c) => c.id === p.clusterId) : undefined;
      const recording =
        p &&
        cluster &&
        historySettings(settings()).audit &&
        (!cluster.read_only || (p.dryRun ?? false));
      if (!recording || !p || !cluster) return inner(args);
      const started = Date.now();
      const before = p.before?.() ?? [];
      try {
        const result = await inner(args);
        const failure = p.failure?.(result, p.targets) ?? null;
        record(
          p,
          cluster,
          started,
          failure,
          before,
          p.after?.(result) ?? [],
          p.result?.(result) ?? null,
        );
        return result;
      } catch (e) {
        record(p, cluster, started, e instanceof Error ? e.message : String(e), before, [], null);
        throw e;
      }
    },
  });
}

function objectPlan(
  action: AuditAction,
  args: MockArgs,
  extra: Partial<Plan> = {},
  capture = true,
): Plan {
  const target = objectTarget(args.gvk as Gvk, args.namespace ?? null, String(args.name));
  const clusterId = String(args.clusterId);
  return {
    clusterId,
    action,
    targets: [target],
    before: capture ? () => [live(clusterId, target)] : undefined,
    after: capture ? () => [live(clusterId, target)] : undefined,
    ...extra,
  };
}

wrap('resource_apply_yaml', (args) => {
  const clusterId = String(args.clusterId);
  const docs = parseDocs(String(args.yaml ?? '')).filter(Boolean);
  const targets = docs.map((d) => docTarget(d, args.namespace ?? null));
  const mode = String(args.mode);
  return {
    clusterId,
    action: mode === 'create' ? 'create' : mode === 'replace' ? 'replace' : 'apply',
    targets,
    request: { namespace: args.namespace ?? null, documents: docs.length },
    before: () => targets.map((t) => live(clusterId, t)),
    after: (result) => (Array.isArray(result) ? (result as KubeObject[]) : []),
  };
});
wrap('resource_delete', (args) =>
  objectPlan('delete', args, {
    request: (args.options as Json | undefined) ?? {},
    after: undefined,
  }),
);
wrap('resource_patch', (args) =>
  objectPlan('patch', args, {
    request: {
      patch_type: args.patchType,
      patch: redactPatch(String((args.gvk as Gvk).kind), args.patch),
    },
    after: (result) => [result as KubeObject],
  }),
);
wrap('resource_scale', (args) => {
  const plan = objectPlan('scale', args);
  const previous = live(plan.clusterId, plan.targets[0]!)?.spec?.replicas ?? null;
  return { ...plan, request: { replicas: Number(args.replicas), previous } };
});
wrap('resource_restart', (args) => objectPlan('restart', args, {}, false));
wrap('resource_set_image', (args) =>
  objectPlan('set-image', args, {
    request: { images: args.images },
    after: (result) => [result as KubeObject],
  }),
);
wrap('rightsizing_apply', (args) => {
  const target = args.target as { kind: string; namespace: string; name: string };
  const plural = `${target.kind.toLowerCase()}s`;
  return objectPlan(
    'rightsize',
    {
      clusterId: args.clusterId,
      gvk: { group: 'apps', version: 'v1', kind: target.kind, plural, namespaced: true },
      namespace: target.namespace,
      name: target.name,
    },
    { dryRun: Boolean(args.dryRun), request: { changes: args.changes } },
  );
});
wrap('rollout_undo', (args) =>
  objectPlan('rollout-undo', args, { request: { revision: Number(args.revision) } }, false),
);
wrap('cronjob_trigger', (args) => ({
  clusterId: String(args.clusterId),
  action: 'cronjob-trigger',
  targets: [
    objectTarget(
      { group: 'batch', version: 'v1', kind: 'CronJob', plural: 'cronjobs', namespaced: true },
      String(args.namespace),
      String(args.name),
    ),
  ],
  result: (job) => `Job ${String(args.namespace)}/${String(job)}`,
}));
wrap('node_cordon', (args) => ({
  clusterId: String(args.clusterId),
  action: args.unschedulable ? 'cordon' : 'uncordon',
  targets: [coreTarget('Node', null, String(args.name))],
}));
wrap('node_drain', (args) => ({
  clusterId: String(args.clusterId),
  action: 'drain',
  targets: [coreTarget('Node', null, String(args.name))],
  request: { force: !!args.force },
}));
wrap('helm_rollback', (args) => ({
  clusterId: String(args.clusterId),
  action: 'helm-rollback',
  targets: [releaseTarget(String(args.namespace), String(args.name))],
  request: { revision: Number(args.revision) },
}));
wrap('helm_uninstall', (args) => ({
  clusterId: String(args.clusterId),
  action: 'helm-uninstall',
  targets: [releaseTarget(String(args.namespace), String(args.name))],
}));
wrap('helm_upgrade_values', (args) => ({
  clusterId: String(args.clusterId),
  action: 'helm-upgrade',
  targets: [releaseTarget(String(args.namespace), String(args.name))],
  request: { values: redactValues(String(args.values ?? '')) },
}));
function helmResult(result: unknown): string | null {
  const release = (result as { release?: { revision: number; status: string } | null } | null)
    ?.release;
  return release ? `revision ${release.revision} (${release.status})` : null;
}
wrap('helm_install', (args) => {
  const req = args.request as Json;
  return {
    clusterId: String(args.clusterId),
    action: 'helm-install',
    dryRun: !!req.dry_run,
    targets: [releaseTarget(String(req.namespace), String(req.release_name))],
    request: {
      chart_ref: req.chart_ref,
      version: req.version ?? null,
      create_namespace: req.create_namespace,
      wait: req.wait,
      atomic: req.atomic,
      values: redactValues(String(req.values_yaml ?? '')),
    },
    result: helmResult,
  };
});
wrap('helm_upgrade', (args) => {
  const req = args.request as Json;
  return {
    clusterId: String(args.clusterId),
    action: 'helm-upgrade',
    dryRun: !!req.dry_run,
    targets: [releaseTarget(String(args.namespace), String(args.name))],
    request: {
      chart_ref: req.chart_ref,
      version: req.version ?? null,
      reuse_values: req.reuse_values,
      reset_values: req.reset_values,
      values: redactValues(String(req.values_yaml ?? '')),
    },
    result: helmResult,
  };
});
wrap('manifests_apply', (args) => {
  const clusterId = String(args.clusterId);
  const namespace = (args.namespace as string | null) || null;
  const docs = ((args.documents as string[]) ?? []).map((d) => parseDocs(d)[0] ?? null);
  const targets = docs.map((d) => docTarget(d, namespace));
  return {
    clusterId,
    action: 'manifests-apply',
    targets,
    request: { namespace, documents: docs.length },
    before: () => targets.map((t) => live(clusterId, t)),
    after: (result) => ((result as ManifestApplyResult[]) ?? []).map((r) => r.object ?? null),
    failure: (result, ts) => {
      const results = (result as ManifestApplyResult[]) ?? [];
      results.forEach((r, i) => {
        if (r.error && ts[i]) ts[i]!.error = r.error;
      });
      const failed = results.filter((r) => r.error).length;
      return failed ? `${failed} of ${results.length} documents failed` : null;
    },
  };
});
wrap('pod_debug', (args) => ({
  clusterId: String(args.clusterId),
  action: 'pod-debug',
  targets: [coreTarget('Pod', String(args.namespace), String(args.pod))],
  request: {
    image: (args.request as Json | undefined)?.image ?? null,
    target_container: (args.request as Json | undefined)?.target_container ?? null,
  },
  result: (container) => `container ${String(container)}`,
}));
wrap('pod_fs_upload', (args) => ({
  clusterId: String(args.clusterId),
  action: 'file-upload',
  targets: [coreTarget('Pod', String(args.namespace), String(args.pod))],
  request: {
    container: args.container ?? null,
    file: String(args.localPath ?? '')
      .split(/[\\/]/)
      .pop(),
    remote_dir: args.remoteDir,
  },
  result: (t) => {
    const transfer = t as { path?: string; bytes?: number } | null;
    return transfer?.path ? `${transfer.path} (${transfer.bytes ?? 0} bytes)` : null;
  },
}));
// Mutating custom actions: background runs keep the exit code, terminal
// launches are recorded when they start. The command is re-resolved with
// annotation values (and labels of Secret-like kinds) replaced by markers;
// output is never kept. Refused runs (disabled, out of scope, read-only) are
// not recorded, like in the backend.
const MAX_ACTION_TARGETS = 20;

function customActionPlan(
  clusterId: string,
  actionId: string,
  target: CustomActionTarget,
  mode: CustomActionMode,
): Plan | null {
  const state = handlers.custom_actions_list?.({}) as CustomActionsState | undefined;
  const action = state?.actions.find((a: CustomAction) => a.id === actionId);
  const cluster = clusters().find((c) => c.id === clusterId);
  if (!action || !cluster || !action.enabled || !action.mutating || action.mode !== mode)
    return null;
  const applies = actionApplies(action, {
    cluster,
    kind: target.kind,
    group: target.group ?? '',
    namespace: target.namespace,
  });
  if (!applies) return null;
  const selected = target.selection.filter(Boolean);
  const names = selected.length ? selected : target.name ? [target.name] : [];
  const version = target.version || 'v1';
  const targets: AuditTarget[] =
    target.kind && names.length
      ? names.slice(0, MAX_ACTION_TARGETS).map((name) => ({
          api_version: target.group ? `${target.group}/${version}` : version,
          kind: target.kind!,
          gvk: null,
          namespace: target.namespace || null,
          name,
          error: null,
        }))
      : [
          {
            api_version: '',
            kind: 'Cluster',
            gvk: null,
            namespace: null,
            name: cluster.name,
            error: null,
          },
        ];
  const mask = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, marker(k, v)]));
  const redacted: CustomActionTarget = {
    ...target,
    annotations: mask(target.annotations),
    labels: secretLike(target.kind ?? '') ? mask(target.labels) : target.labels,
  };
  let command: string | null = null;
  try {
    command =
      (
        handlers.custom_action_resolve?.({ action, clusterId, target: redacted }) as
          { command: string } | undefined
      )?.command ?? null;
  } catch {
    command = null;
  }
  return {
    clusterId,
    action: 'custom-action',
    targets,
    request: { action: action.name, id: action.id, mode, command, targets: names.length },
    result: (r) => {
      if (mode === 'terminal') return TERMINAL_STARTED;
      const out = r as CustomActionResult;
      return out.timed_out || out.exit_code === null ? null : `exit ${out.exit_code}`;
    },
    failure: (r) => {
      if (mode === 'terminal') return null;
      const out = r as CustomActionResult;
      if (out.timed_out) return `timed out after ${Math.max(1, action.timeout_secs)}s`;
      if (out.exit_code === null) return 'terminated by a signal';
      return out.exit_code !== 0 ? `exit ${out.exit_code}` : null;
    },
  };
}

wrap('custom_action_run', (args) =>
  customActionPlan(
    String(args.clusterId),
    String(args.actionId),
    args.target as CustomActionTarget,
    'background',
  ),
);
wrap('terminal_create', (args) => {
  const spec = args.spec as
    | {
        kind?: string;
        cluster_id?: string;
        node?: string;
        action_id?: string;
        target?: CustomActionTarget;
      }
    | undefined;
  if (spec?.kind === 'custom-action' && spec.cluster_id && spec.action_id && spec.target)
    return customActionPlan(spec.cluster_id, spec.action_id, spec.target, 'terminal');
  if (spec?.kind !== 'node-shell' || !spec.cluster_id) return null;
  return {
    clusterId: spec.cluster_id,
    action: 'node-shell',
    targets: [coreTarget('Node', null, String(spec.node))],
  };
});

// The audit log names the user of the cluster's last `access_whoami`.
const whoami = handlers.access_whoami;
if (whoami)
  register({
    access_whoami: async (args: MockArgs) => {
      const who = (await whoami(args)) as { username?: string };
      if (who?.username) identities.set(String(args.clusterId), who.username);
      return who;
    },
  });

// -- Seeded audit trail ----------------------------------------------------------

function seedAudit() {
  if (seeded) return;
  seeded = true;
  if (cleared.has('audit|*')) return;
  const byId = new Map(clusters().map((c) => [c.id, c]));
  const out: Stored[] = [];
  const add = (
    clusterId: string,
    ago: number,
    action: AuditAction,
    targets: AuditTarget[],
    extra: Partial<AuditEntry> = {},
    objects: AuditObject[] = [],
  ) => {
    const cluster = byId.get(clusterId);
    if (!cluster || !targets.length) return;
    out.push({
      entry: {
        id: 0,
        ts: BOOT - ago,
        cluster_id: cluster.id,
        cluster_name: cluster.name,
        context: cluster.context,
        identity: 'dev@acme.io',
        action,
        dry_run: false,
        outcome: 'ok',
        error: null,
        duration_ms: 180 + (hashString(`${clusterId}${ago}`) % 900),
        targets,
        request: null,
        result: null,
        has_diff: objects.length > 0,
        revertible: objects.some((o) => o.revertible),
        ...extra,
      },
      objects,
    });
  };
  const deployment = (id: string) => list(getDb(id), 'deployments.apps')[0];
  const configMap = (id: string) =>
    list(getDb(id), 'configmaps').find((c) => c.metadata.namespace !== 'kube-system');
  const node = (id: string) => list(getDb(id), 'nodes')[0];
  const release = (id: string) => [...getDb(id).helm.values()][0]?.history.at(-1);
  const gvkOf = (o: KubeObject) => resolveRef(o.apiVersion, o.kind);

  // Scaled up two hours ago (revertible: the live object carries the change).
  const dep = deployment('c-staging');
  const depGvk = dep && gvkOf(dep);
  if (dep && depGvk) {
    const after = structuredClone(dep);
    const before = structuredClone(dep);
    const replicas = Number(dep.spec?.replicas ?? 2);
    before.spec = { ...before.spec, replicas: Math.max(1, replicas - 1) };
    const target = objectTarget(depGvk, dep.metadata.namespace ?? null, dep.metadata.name);
    add(
      'c-staging',
      2 * HOUR + 14 * MIN,
      'scale',
      [target],
      { request: { replicas, previous: Math.max(1, replicas - 1) } },
      [objectOf('scale', false, target, 0, before, after)!].filter(Boolean),
    );
  }
  // A ConfigMap edit yesterday.
  const cm = configMap('c-dev');
  const cmGvk = cm && gvkOf(cm);
  if (cm && cmGvk) {
    const after = structuredClone(cm);
    const before = structuredClone(cm);
    const data = { ...((before.data as Json | undefined) ?? {}) };
    const key = Object.keys(data)[0] ?? 'LOG_LEVEL';
    data[key] = key === 'LOG_LEVEL' ? 'info' : `${String(data[key] ?? '')}-previous`;
    before.data = data;
    const target = objectTarget(cmGvk, cm.metadata.namespace ?? null, cm.metadata.name);
    add(
      'c-dev',
      DAY + 3 * HOUR,
      'patch',
      [target],
      {
        request: {
          patch_type: 'merge',
          patch: { data: { [key]: (after.data as Json | undefined)?.[key] ?? null } },
        },
      },
      [objectOf('patch', false, target, 0, before, after)!].filter(Boolean),
    );
  }
  const rel = release('c-prod-us');
  if (rel)
    add('c-prod-us', 2 * DAY + 5 * HOUR, 'helm-upgrade', [releaseTarget(rel.namespace, rel.name)], {
      request: { chart_ref: `bitnami/${rel.chart}`, version: rel.chart_version, values: {} },
      result: `revision ${rel.revision} (deployed)`,
    });
  const n = node('c-staging');
  if (n)
    add('c-staging', 3 * DAY + 2 * HOUR, 'drain', [coreTarget('Node', null, n.metadata.name)], {
      outcome: 'error',
      error: `node ${n.metadata.name} is cordoned but the drain did not finish.\nBlocked by a PodDisruptionBudget (1): checkout/payment-api-7c9f6. Retry once replacement pods are ready.`,
      request: { force: false },
      duration_ms: 31_400,
    });
  if (n)
    add('c-staging', 3 * DAY + 2 * HOUR + 30_000, 'cordon', [
      coreTarget('Node', null, n.metadata.name),
    ]);
  const pod = list(getDb('c-dev'), 'pods')[0];
  if (pod) {
    add('c-dev', 4 * DAY + HOUR, 'delete', [
      coreTarget('Pod', pod.metadata.namespace ?? null, pod.metadata.name),
    ]);
    add(
      'c-dev',
      35 * MIN,
      'pod-debug',
      [coreTarget('Pod', pod.metadata.namespace ?? null, pod.metadata.name)],
      {
        request: { image: 'docker.io/library/busybox:1.36', target_container: null },
        result: 'container debugger-k3x9d',
      },
    );
  }
  const prodDep = deployment('c-prod-us');
  const prodGvk = prodDep && gvkOf(prodDep);
  if (prodDep && prodGvk)
    add(
      'c-prod-us',
      6 * DAY + 4 * HOUR,
      'rollout-undo',
      [objectTarget(prodGvk, prodDep.metadata.namespace ?? null, prodDep.metadata.name)],
      { request: { revision: 0 }, identity: null },
    );
  const prodRel = release('c-prod-eu');
  if (prodRel)
    add(
      'c-prod-eu',
      DAY + 7 * HOUR,
      'helm-upgrade',
      [releaseTarget(prodRel.namespace, prodRel.name)],
      {
        dry_run: true,
        request: {
          chart_ref: `bitnami/${prodRel.chart}`,
          version: prodRel.chart_version,
          values: {},
        },
        result: `revision ${prodRel.revision + 1} (pending-upgrade)`,
      },
    );
  add(
    'c-kind',
    9 * DAY + 6 * HOUR,
    'manifests-apply',
    [
      docTarget({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'demo', uid: '' } }, null),
      docTarget(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'demo-config', namespace: 'demo', uid: '' },
        },
        null,
      ),
      docTarget(
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'demo', namespace: 'demo', uid: '' },
        },
        null,
      ),
    ],
    { request: { namespace: 'demo', documents: 3 } },
  );
  out.sort((a, b) => a.entry.ts - b.entry.ts);
  for (const s of out) s.entry.id = nextAuditId++;
  audit.unshift(...out);
}

// -- Persisted events and changes (staging-gke) ---------------------------------

const PERSISTED_DEMO = 'c-staging';
let persistedEvents: KubeObject[] | null = null;
interface PersistedChange {
  summary: ChangeSummary;
  before: Json | null;
  after: Json | null;
}
let persistedChanges: PersistedChange[] | null = null;

function eventTs(e: KubeObject): number {
  return Date.parse(String(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? 0));
}

/** Older copies of the demo cluster's events, spread over the last days. */
function seedEvents(): KubeObject[] {
  if (persistedEvents) return persistedEvents;
  const base = list(getDb(PERSISTED_DEMO), 'events');
  const out: KubeObject[] = [];
  const offsets = [3 * HOUR, 9 * HOUR, 26 * HOUR, 2 * DAY + 5 * HOUR, 4 * DAY + HOUR, 6 * DAY];
  offsets.forEach((offset, round) => {
    base.forEach((e, i) => {
      if ((i + round) % 3 !== 0) return;
      const copy = structuredClone(e);
      const ts = BOOT - offset - i * 7 * MIN;
      copy.metadata = { ...copy.metadata, uid: `persisted-${round}-${e.metadata.uid}` };
      copy.lastTimestamp = iso(ts);
      copy.firstTimestamp = iso(ts - 20 * MIN);
      out.push(copy);
    });
  });
  persistedEvents = out;
  return out;
}

function seedChanges() {
  if (persistedChanges) return persistedChanges;
  const drafts = seedHistory(getDb(PERSISTED_DEMO));
  const out: PersistedChange[] = [];
  let id = 1;
  for (const shift of [5 * DAY, 2 * DAY]) {
    for (const d of [...drafts].reverse()) {
      const secret = d.gvk.kind === 'Secret';
      const paths = d.before && d.after ? changedPaths(d.before, d.after, secret) : [];
      if (d.op === 'modified' && !paths.length) continue;
      out.push({
        summary: {
          id: id++,
          ts: d.ts - shift,
          cluster_id: PERSISTED_DEMO,
          gvk: d.gvk,
          namespace: d.namespace,
          name: d.name,
          uid: d.uid,
          op: d.op,
          actor: d.actor,
          paths: paths.slice(0, MAX_PATHS),
          path_count: paths.length,
          truncated: false,
        },
        before: d.before,
        after: d.after,
      });
    }
  }
  out.sort((a, b) => a.summary.ts - b.summary.ts);
  out.forEach((c, i) => (c.summary.id = i + 1));
  persistedChanges = out;
  return out;
}

function eventsOf(clusterId: string): KubeObject[] {
  if (cleared.has(`events|${clusterId}`) || cleared.has('events|*')) return [];
  const connected = statuses()[clusterId]?.state === 'connected';
  const recording = historySettings(settings()).persist_clusters.includes(clusterId) && connected;
  const liveEvents = recording ? list(getDb(clusterId), 'events') : [];
  const seededEvents = clusterId === PERSISTED_DEMO ? seedEvents() : [];
  return [...liveEvents, ...seededEvents];
}

function changesOf(clusterId: string) {
  if (cleared.has(`changes|${clusterId}`) || cleared.has('changes|*')) return [];
  return clusterId === PERSISTED_DEMO ? seedChanges() : [];
}

function parseCursor(cursor: string | null): [number, number] | null {
  if (!cursor) return null;
  const [ts, id] = cursor.split(':').map(Number);
  return Number.isFinite(ts) && Number.isFinite(id) ? [ts!, id!] : null;
}

function auditMatches(e: AuditEntry, f: AuditFilter) {
  if (f.cluster_ids.length && !f.cluster_ids.includes(e.cluster_id)) return false;
  if (f.actions.length && !f.actions.includes(e.action)) return false;
  if (f.outcome && e.outcome !== f.outcome) return false;
  if (f.since !== null && e.ts < f.since) return false;
  if (f.until !== null && e.ts > f.until) return false;
  const text = (f.text ?? '').trim().toLowerCase();
  if (!text) return true;
  const haystack = [
    e.cluster_name,
    e.context,
    e.identity ?? '',
    e.action,
    ...e.targets.map((t) => `${t.kind} ${t.namespace ?? ''}/${t.name} ${t.error ?? ''}`),
    e.error ?? '',
    e.result ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(text);
}

function sortedAudit(f: AuditFilter): AuditEntry[] {
  seedAudit();
  return audit
    .map((s) => s.entry)
    .filter((e) => auditMatches(e, f))
    .sort((a, b) => b.ts - a.ts || b.id - a.id);
}

function sizeBytes() {
  const events = allPersistedEvents();
  return (
    96 * 1024 +
    audit.length * 3_000 +
    events * 1_400 +
    (persistedChanges?.length ?? 0) * 4_000 +
    recommendationTable().rows * 800
  );
}

function allPersistedEvents() {
  return clusters().reduce((n, c) => n + eventsOf(c.id).length, 0);
}

function table(rows: { ts: number }[]) {
  return { rows: rows.length, oldest_ts: rows.length ? Math.min(...rows.map((r) => r.ts)) : null };
}

function status(): HistoryStatus {
  seedAudit();
  const events = clusters().flatMap((c) => eventsOf(c.id).map((e) => ({ ts: eventTs(e) })));
  const changes = clusters().flatMap((c) => changesOf(c.id).map((ch) => ({ ts: ch.summary.ts })));
  const s = historySettings(settings());
  return {
    path: '~/.kubepit/history.db',
    size_bytes: sizeBytes(),
    available: true,
    error: null,
    recording: true,
    audit: table(audit.map((a) => ({ ts: a.entry.ts }))),
    events: table(events),
    changes: table(changes),
    recommendations: recommendationTable(),
    dropped: 0,
    persisting: clusters()
      .filter((c) => s.persist_clusters.includes(c.id) && statuses()[c.id]?.state === 'connected')
      .map((c) => c.id),
  };
}

register({
  history_status: () => status(),
  history_audit_list: ({ filter }: MockArgs): AuditPage => {
    const f = filter as AuditFilter;
    const all = sortedAudit(f);
    const cursor = parseCursor(f.cursor);
    const rest = cursor
      ? all.filter((e) => e.ts < cursor[0] || (e.ts === cursor[0] && e.id < cursor[1]))
      : all;
    const limit = Math.min(1000, Math.max(1, f.limit));
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return {
      entries: structuredClone(page),
      next_cursor: rest.length > limit && last ? `${last.ts}:${last.id}` : null,
      total: all.length,
    };
  },
  history_audit_get: ({ id }: MockArgs): AuditDetail => {
    seedAudit();
    const stored = audit.find((s) => s.entry.id === Number(id));
    if (!stored) throw new Error(`audit entry ${id} is no longer in the history`);
    return structuredClone({ entry: stored.entry, objects: stored.objects });
  },
  history_audit_export: ({ filter }: MockArgs) =>
    sortedAudit(filter as AuditFilter)
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(''),
  history_events_list: ({ clusterId, filter }: MockArgs): HistoryEventPage => {
    const f = filter as HistoryEventFilter;
    const text = (f.text ?? '').trim().toLowerCase();
    const rows = eventsOf(String(clusterId))
      .map((e, index) => ({ e, ts: eventTs(e), index }))
      .filter(({ e, ts }) => {
        const inv = (e.involvedObject ?? {}) as { uid?: string; kind?: string; name?: string };
        if (f.namespaces.length && !f.namespaces.includes(e.metadata.namespace ?? '')) return false;
        if (f.involved_uid) {
          const sameObject =
            inv.uid === f.involved_uid ||
            (!!f.involved_kind &&
              !!f.involved_name &&
              inv.kind === f.involved_kind &&
              inv.name === f.involved_name);
          if (!sameObject) return false;
        } else {
          if (f.involved_kind && inv.kind !== f.involved_kind) return false;
          if (f.involved_name && inv.name !== f.involved_name) return false;
        }
        if (f.types.length && !f.types.includes(String(e.type ?? ''))) return false;
        if (f.since !== null && ts < f.since) return false;
        if (f.until !== null && ts > f.until) return false;
        if (text) {
          const haystack =
            `${String(e.reason ?? '')} ${inv.kind ?? ''} ${e.metadata.namespace ?? ''}/${inv.name ?? ''} ${String(e.message ?? '')}`.toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        return true;
      })
      .sort((a, b) => b.ts - a.ts || b.index - a.index);
    const cursor = parseCursor(f.cursor);
    const rest = cursor
      ? rows.filter((r) => r.ts < cursor[0] || (r.ts === cursor[0] && r.index < cursor[1]))
      : rows;
    const limit = Math.min(1000, Math.max(1, f.limit));
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: structuredClone(page.map((r) => r.e)),
      next_cursor: rest.length > limit && last ? `${last.ts}:${last.index}` : null,
    };
  },
  history_changes_list: ({ clusterId, filter }: MockArgs): HistoryChangePage => {
    const f = filter as ChangeFilter;
    const text = (f.text ?? '').trim().toLowerCase();
    const matching = changesOf(String(clusterId))
      .map((c) => c.summary)
      .filter((s) => {
        if (f.since !== null && s.ts < f.since) return false;
        if (f.until !== null && s.ts > f.until) return false;
        if (f.cursor !== null && s.id >= f.cursor) return false;
        if (f.kinds.length && !f.kinds.includes(s.gvk.kind)) return false;
        if (f.namespaces.length) {
          const included = s.namespace
            ? f.namespaces.includes(s.namespace)
            : s.gvk.kind === 'Namespace' && f.namespaces.includes(s.name);
          if (!included) return false;
        }
        if (f.name && s.name !== f.name) return false;
        if (!text) return true;
        return [
          s.gvk.kind,
          `${s.namespace ?? ''}/${s.name}`,
          s.actor?.manager ?? '',
          ...s.paths.map((p) => p.path),
        ]
          .join(' ')
          .toLowerCase()
          .includes(text);
      })
      .sort((a, b) => b.id - a.id);
    const limit = Math.min(1000, Math.max(1, f.limit));
    const page = matching.slice(0, limit);
    return {
      entries: structuredClone(page),
      next_cursor: matching.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  },
  history_changes_get: ({ clusterId, id }: MockArgs): ChangeDetail => {
    const found = changesOf(String(clusterId)).find((c) => c.summary.id === Number(id));
    if (!found) throw new Error(`change ${id} is no longer in the history`);
    const yaml = (o: Json | null) => (o ? YAML.stringify(o, { lineWidth: 0 }) : null);
    return {
      summary: structuredClone(found.summary),
      before_yaml: yaml(found.before),
      after_yaml: yaml(found.after),
      omitted: false,
    };
  },
  history_clear: ({ kind, clusterId }: MockArgs): HistoryStatus => {
    const k = kind as HistoryKind;
    const scope = (clusterId as string | null) ?? '*';
    const kinds: HistoryKind[] =
      k === 'all' ? ['audit', 'events', 'changes', 'recommendations'] : [k];
    seedAudit();
    for (const each of kinds) {
      cleared.add(`${each}|${scope}`);
      if (each === 'audit') {
        for (let i = audit.length - 1; i >= 0; i--)
          if (scope === '*' || audit[i]!.entry.cluster_id === scope) audit.splice(i, 1);
      }
      if (each === 'recommendations') recommendationHistory?.clear(scope === '*' ? null : scope);
    }
    return status();
  },
});
