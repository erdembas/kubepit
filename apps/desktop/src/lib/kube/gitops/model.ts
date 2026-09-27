import type { KubeObject } from '@/types';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  condition,
  isObject,
  spec,
  status,
  type Condition,
} from '../accessors';
import type { ObjectRef } from '../columns/types';
import type { StatusTone } from '../pods';
import {
  defaultApiVersion,
  isArgoApplication,
  isFluxHelmRelease,
  isFluxKustomization,
  toolOf,
  type GitOpsTool,
} from './kinds';

/**
 * Pure readers over Argo CD and Flux objects: sync / health / readiness,
 * revisions, sources, destinations, managed resources and the normalized
 * row the GitOps overview lists. Status words (Synced, OutOfSync, Healthy,
 * Ready, ReconciliationSucceeded…) are Kubernetes data and never translated.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Shorten commit SHAs and digests inside a revision (`main@sha1:0123abc…` → `main@0123abc`). */
export function shortRevision(revision: string | null | undefined): string {
  if (!revision) return '';
  return revision.replace(
    /(sha1:|sha256:)?([0-9a-f]{12,})/gi,
    (_, algo: string | undefined, hex) =>
      algo?.toLowerCase() === 'sha256:' ? `sha256:${hex.slice(0, 7)}` : hex.slice(0, 7),
  );
}

/** `https://github.com/acme/gitops.git` → `github.com/acme/gitops`. */
export function repoShort(url: string | null | undefined): string {
  if (!url) return '';
  return url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

const IN_CLUSTER = 'https://kubernetes.default.svc';

export function timestampOf(value: unknown): number {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// ---------------------------------------------------------------------------
// Argo CD
// ---------------------------------------------------------------------------

export interface ArgoSource {
  repoURL: string;
  path: string;
  chart: string;
  targetRevision: string;
  ref: string;
  name: string;
}

function argoSource(value: unknown): ArgoSource {
  const s = asObject(value);
  return {
    repoURL: asString(s.repoURL),
    path: asString(s.path),
    chart: asString(s.chart),
    targetRevision: asString(s.targetRevision),
    ref: asString(s.ref),
    name: asString(s.name),
  };
}

/** `spec.sources` (multi-source apps) or the single `spec.source`. */
export function argoSources(obj: KubeObject): ArgoSource[] {
  const s = spec(obj);
  const many = asArray(s.sources).filter(isObject);
  if (many.length) return many.map(argoSource);
  return isObject(s.source) ? [argoSource(s.source)] : [];
}

export function argoSourceText(source: ArgoSource): string {
  const repo = repoShort(source.repoURL);
  if (source.chart) return `${source.chart}@${source.targetRevision || '*'} · ${repo}`;
  if (source.path) return `${repo} · ${source.path}`;
  return repo;
}

export interface ArgoDestination {
  server: string;
  name: string;
  namespace: string;
  /** `in-cluster/web`, `prod-eu/payments`, `api.example.com/web`. */
  text: string;
}

export function argoDestination(obj: KubeObject): ArgoDestination {
  const d = asObject(spec(obj).destination);
  const server = asString(d.server);
  const name = asString(d.name);
  const namespace = asString(d.namespace);
  const cluster =
    name || (server === IN_CLUSTER ? 'in-cluster' : server.replace(/^https?:\/\//, '')) || '—';
  return { server, name, namespace, text: namespace ? `${cluster}/${namespace}` : cluster };
}

export interface ArgoAppStatus {
  sync: string;
  health: string;
  healthMessage: string;
  /** Synced revision (first source of a multi-source app). */
  revision: string;
  revisions: string[];
  operationPhase: string;
  operationMessage: string;
  /** An operation is requested or in progress (sync, terminate). */
  operationRunning: boolean;
  operationStartedAt: string;
  operationFinishedAt: string;
  /** Last finished sync (operation or history). */
  lastSync: string;
  reconciledAt: string;
  automated: boolean;
  prune: boolean;
  selfHeal: boolean;
  allowEmpty: boolean;
  syncOptions: string[];
}

export function argoAppStatus(obj: KubeObject): ArgoAppStatus {
  const st = status(obj);
  const sync = asObject(st.sync);
  const health = asObject(st.health);
  const op = asObject(st.operationState);
  const policy = asObject(spec(obj).syncPolicy);
  const automated = isObject(policy.automated) ? policy.automated : null;
  const revisions = asArray(sync.revisions).map((r) => asString(r));
  const phase = asString(op.phase);
  const history = argoHistory(obj);
  return {
    sync: asString(sync.status),
    health: asString(health.status),
    healthMessage: asString(health.message),
    revision: asString(sync.revision) || revisions[0] || '',
    revisions,
    operationPhase: phase,
    operationMessage: asString(op.message),
    operationRunning: phase === 'Running' || phase === 'Terminating' || isObject(obj.operation),
    operationStartedAt: asString(op.startedAt),
    operationFinishedAt: asString(op.finishedAt),
    lastSync: asString(op.finishedAt) || history[0]?.deployedAt || '',
    reconciledAt: asString(st.reconciledAt),
    automated: !!automated && automated.enabled !== false,
    prune: automated?.prune === true,
    selfHeal: automated?.selfHeal === true,
    allowEmpty: automated?.allowEmpty === true,
    syncOptions: asArray(policy.syncOptions).map((o) => asString(o)),
  };
}

export function argoSyncTone(sync: string): StatusTone {
  if (sync === 'Synced') return 'success';
  if (sync === 'OutOfSync') return 'warning';
  return 'muted';
}

export function argoHealthTone(health: string): StatusTone {
  switch (health) {
    case 'Healthy':
      return 'success';
    case 'Progressing':
      return 'info';
    case 'Degraded':
      return 'error';
    case 'Missing':
      return 'warning';
    case 'Suspended':
      return 'info';
    default:
      return 'muted';
  }
}

export function argoOperationTone(phase: string): StatusTone {
  switch (phase) {
    case 'Succeeded':
      return 'success';
    case 'Running':
    case 'Terminating':
      return 'info';
    case 'Failed':
    case 'Error':
      return 'error';
    default:
      return 'muted';
  }
}

export interface ArgoResource {
  group: string;
  version: string;
  kind: string;
  namespace: string;
  name: string;
  status: string;
  health: string;
  healthMessage: string;
  hook: boolean;
  requiresPruning: boolean;
}

/** Top-level resources the Application manages (`status.resources`). */
export function argoResources(obj: KubeObject): ArgoResource[] {
  return asArray(status(obj).resources)
    .filter(isObject)
    .map((r) => {
      const h = asObject(r.health);
      return {
        group: asString(r.group),
        version: asString(r.version),
        kind: asString(r.kind),
        namespace: asString(r.namespace),
        name: asString(r.name),
        status: asString(r.status),
        health: asString(h.status),
        healthMessage: asString(h.message),
        hook: r.hook === true,
        requiresPruning: r.requiresPruning === true,
      };
    });
}

export function argoResourceRef(r: ArgoResource): ObjectRef {
  return {
    apiVersion: r.group ? `${r.group}/${r.version || 'v1'}` : r.version || 'v1',
    kind: r.kind,
    name: r.name,
    namespace: r.namespace || null,
  };
}

export interface ArgoHistoryEntry {
  id: number;
  revision: string;
  deployedAt: string;
  deployStartedAt: string;
  initiatedBy: string;
  automated: boolean;
  source: string;
}

/** Deployment history, newest first. */
export function argoHistory(obj: KubeObject): ArgoHistoryEntry[] {
  return asArray(status(obj).history)
    .filter(isObject)
    .map((h) => {
      const by = asObject(h.initiatedBy);
      const revisions = asArray(h.revisions).map((r) => asString(r));
      const sources = asArray(h.sources).filter(isObject).map(argoSource);
      const source = isObject(h.source) ? [argoSource(h.source)] : sources;
      return {
        id: asNumber(h.id),
        revision: asString(h.revision) || revisions[0] || '',
        deployedAt: asString(h.deployedAt),
        deployStartedAt: asString(h.deployStartedAt),
        initiatedBy: asString(by.username),
        automated: by.automated === true,
        source: source[0] ? argoSourceText(source[0]) : '',
      };
    })
    .sort((a, b) => b.id - a.id || timestampOf(b.deployedAt) - timestampOf(a.deployedAt));
}

export interface ArgoCondition {
  type: string;
  message: string;
  lastTransitionTime: string;
}

/** Argo conditions carry no status: every entry is an active warning or error. */
export function argoConditions(obj: KubeObject): ArgoCondition[] {
  return asArray(status(obj).conditions)
    .filter(isObject)
    .map((c) => ({
      type: asString(c.type),
      message: asString(c.message),
      lastTransitionTime: asString(c.lastTransitionTime),
    }));
}

export function argoConditionTone(type: string): StatusTone {
  return /Error$/.test(type) ? 'error' : /Warning$/.test(type) ? 'warning' : 'info';
}

// ---------------------------------------------------------------------------
// Flux
// ---------------------------------------------------------------------------

/** Flux readiness words (kstatus vocabulary), derived from the conditions. */
export type FluxHealth = 'Ready' | 'Not Ready' | 'Reconciling' | 'Stalled' | 'Unknown';

export interface FluxStatus {
  ready: Condition | undefined;
  health: FluxHealth;
  reconciling: boolean;
  stalled: boolean;
  suspended: boolean;
  lastAppliedRevision: string;
  lastAttemptedRevision: string;
  lastHandledReconcileAt: string;
  interval: string;
  observedGeneration: number;
}

export function fluxStatus(obj: KubeObject): FluxStatus {
  const st = status(obj);
  const ready = condition(obj, 'Ready');
  const reconciling = condition(obj, 'Reconciling')?.status === 'True';
  const stalled = condition(obj, 'Stalled')?.status === 'True';
  const health: FluxHealth = stalled
    ? 'Stalled'
    : ready?.status === 'True'
      ? 'Ready'
      : reconciling || ready?.status === 'Unknown'
        ? 'Reconciling'
        : ready?.status === 'False'
          ? 'Not Ready'
          : 'Unknown';
  const history = helmHistory(obj);
  const deployed = history.find((h) => h.status === 'deployed');
  return {
    ready,
    health,
    reconciling,
    stalled,
    suspended: spec(obj).suspend === true,
    lastAppliedRevision:
      asString(st.lastAppliedRevision) ||
      (deployed ? deployed.chartVersion : '') ||
      asString(asObject(st.artifact).revision),
    lastAttemptedRevision: asString(st.lastAttemptedRevision),
    lastHandledReconcileAt: asString(st.lastHandledReconcileAt),
    interval: asString(spec(obj).interval),
    observedGeneration: asNumber(st.observedGeneration, -1),
  };
}

export function fluxHealthTone(health: FluxHealth): StatusTone {
  switch (health) {
    case 'Ready':
      return 'success';
    case 'Reconciling':
      return 'info';
    case 'Not Ready':
    case 'Stalled':
      return 'error';
    default:
      return 'muted';
  }
}

export function readyTone(c: Condition | undefined): StatusTone {
  if (!c) return 'muted';
  return c.status === 'True' ? 'success' : c.status === 'False' ? 'error' : 'info';
}

/** A Flux cross-namespace reference (`sourceRef`, `chartRef`, `dependsOn`). */
function fluxRef(
  value: unknown,
  fallbackNs: string | null,
  fallbackKind?: string,
): ObjectRef | null {
  const r = asObject(value);
  const name = asString(r.name);
  const refKind = asString(r.kind) || fallbackKind || '';
  if (!name || !refKind) return null;
  return {
    apiVersion: asString(r.apiVersion) || defaultApiVersion(refKind) || undefined,
    kind: refKind,
    name,
    namespace: asString(r.namespace) || fallbackNs,
  };
}

/** The source a Kustomization or HelmRelease (or HelmChart) reconciles from. */
export function fluxSourceRef(obj: KubeObject): ObjectRef | null {
  const s = spec(obj);
  const ns = obj.metadata.namespace ?? null;
  if (isFluxHelmRelease(obj)) {
    if (isObject(s.chartRef)) return fluxRef(s.chartRef, ns);
    return fluxRef(asObject(asObject(s.chart).spec).sourceRef, ns);
  }
  return fluxRef(s.sourceRef, ns);
}

/** `dependsOn` entries resolve to objects of the same kind. */
export function fluxDependsOn(obj: KubeObject): ObjectRef[] {
  return asArray(spec(obj).dependsOn)
    .map((d) =>
      fluxRef(
        { ...asObject(d), kind: obj.kind, apiVersion: obj.apiVersion },
        obj.metadata.namespace ?? null,
      ),
    )
    .filter((r): r is ObjectRef => !!r);
}

export interface HelmChartSpec {
  chart: string;
  version: string;
}

export function helmReleaseChart(obj: KubeObject): HelmChartSpec {
  const c = asObject(asObject(spec(obj).chart).spec);
  return { chart: asString(c.chart), version: asString(c.version) };
}

export interface HelmHistoryEntry {
  version: number;
  chartName: string;
  chartVersion: string;
  appVersion: string;
  status: string;
  firstDeployed: string;
  lastDeployed: string;
  digest: string;
}

/** `status.history` of a helm.toolkit.fluxcd.io/v2 HelmRelease, newest first. */
export function helmHistory(obj: KubeObject): HelmHistoryEntry[] {
  return asArray(status(obj).history)
    .filter(isObject)
    .map((h) => ({
      version: asNumber(h.version),
      chartName: asString(h.chartName),
      chartVersion: asString(h.chartVersion),
      appVersion: asString(h.appVersion),
      status: asString(h.status),
      firstDeployed: asString(h.firstDeployed),
      lastDeployed: asString(h.lastDeployed),
      digest: asString(h.digest),
    }))
    .sort((a, b) => b.version - a.version);
}

/** Helm release a HelmRelease manages (name and storage namespace, as helm-controller derives them). */
export function helmReleaseTarget(obj: KubeObject): { name: string; namespace: string } {
  const s = spec(obj);
  const st = status(obj);
  const ns = obj.metadata.namespace ?? 'default';
  const target = asString(s.targetNamespace);
  const fromStatus = asString(st.storageNamespace);
  const name =
    asString(s.releaseName) || (target ? `${target}-${obj.metadata.name}` : obj.metadata.name);
  return {
    name: name.length > 53 ? name.slice(0, 53) : name,
    namespace: fromStatus || asString(s.storageNamespace) || ns,
  };
}

export interface InventoryEntry {
  namespace: string;
  name: string;
  group: string;
  kind: string;
  version: string;
}

/** Parse a cli-utils object id: `<namespace>_<name>_<group>_<kind>` (`:` in names encoded as `__`). */
export function parseInventoryId(id: string, version: string): InventoryEntry | null {
  const k = id.lastIndexOf('_');
  if (k < 0) return null;
  const kindName = id.slice(k + 1);
  const rest = id.slice(0, k);
  const g = rest.lastIndexOf('_');
  if (g < 0) return null;
  const group = rest.slice(g + 1);
  const head = rest.slice(0, g);
  const n = head.indexOf('_');
  if (n < 0 || !kindName) return null;
  const name = head.slice(n + 1).replace(/__/g, ':');
  if (!name) return null;
  return { namespace: head.slice(0, n), name, group, kind: kindName, version };
}

/** Objects a Kustomization applied (`status.inventory.entries`). */
export function fluxInventory(obj: KubeObject): InventoryEntry[] {
  return asArray(asObject(status(obj).inventory).entries)
    .filter(isObject)
    .map((e) => parseInventoryId(asString(e.id), asString(e.v)))
    .filter((e): e is InventoryEntry => !!e);
}

export function inventoryRef(e: InventoryEntry): ObjectRef {
  return {
    apiVersion: e.group ? `${e.group}/${e.version || 'v1'}` : e.version || 'v1',
    kind: e.kind,
    name: e.name,
    namespace: e.namespace || null,
  };
}

/** Human "what" of a Flux source: branch/tag/semver for Git and OCI, chart for HelmChart. */
export function fluxSourceReference(obj: KubeObject): string {
  const s = spec(obj);
  const ref = asObject(s.ref);
  if (obj.kind === 'GitRepository') {
    for (const key of ['commit', 'name', 'tag', 'semver', 'branch'] as const)
      if (asString(ref[key])) return `${key === 'name' ? 'ref' : key}: ${asString(ref[key])}`;
    return '';
  }
  if (obj.kind === 'OCIRepository') {
    for (const key of ['digest', 'semver', 'tag'] as const)
      if (asString(ref[key])) return `${key}: ${asString(ref[key])}`;
    return 'tag: latest';
  }
  if (obj.kind === 'HelmChart') return `${asString(s.chart)}@${asString(s.version) || '*'}`;
  if (obj.kind === 'Bucket') return asString(s.bucketName);
  if (obj.kind === 'HelmRepository') return asString(s.type) || 'default';
  return '';
}

export interface FluxArtifact {
  revision: string;
  digest: string;
  lastUpdateTime: string;
  size: number;
  url: string;
}

export function fluxArtifact(obj: KubeObject): FluxArtifact | null {
  const a = status(obj).artifact;
  if (!isObject(a)) return null;
  return {
    revision: asString(a.revision),
    digest: asString(a.digest),
    lastUpdateTime: asString(a.lastUpdateTime),
    size: asNumber(a.size),
    url: asString(a.url),
  };
}

// ---------------------------------------------------------------------------
// Overview rows
// ---------------------------------------------------------------------------

export type GitOpsBucket =
  'healthy' | 'outOfSync' | 'degraded' | 'progressing' | 'suspended' | 'unknown';

/** Worst first: the overview sorts attention-worthy rows to the top. */
export const BUCKET_ORDER: readonly GitOpsBucket[] = [
  'degraded',
  'outOfSync',
  'progressing',
  'suspended',
  'unknown',
  'healthy',
];

export interface GitOpsRow {
  uid: string;
  obj: KubeObject;
  tool: GitOpsTool;
  kind: string;
  name: string;
  namespace: string;
  sync: string;
  syncTone: StatusTone;
  health: string;
  healthTone: StatusTone;
  revision: string;
  revisionFull: string;
  source: string;
  sourceRef: ObjectRef | null;
  destination: string;
  destNamespace: string;
  lastSync: string;
  suspended: boolean;
  /** Argo auto-sync; `null` for Flux (always reconciles unless suspended). */
  autoSync: boolean | null;
  /** Running Argo operation phase (`Running`, `Terminating`). */
  operation: string;
  message: string;
  bucket: GitOpsBucket;
}

function argoRow(obj: KubeObject): GitOpsRow {
  const s = argoAppStatus(obj);
  const sources = argoSources(obj);
  const dest = argoDestination(obj);
  const conds = argoConditions(obj);
  const failedOp = s.operationPhase === 'Failed' || s.operationPhase === 'Error';
  const bucket: GitOpsBucket =
    s.health === 'Degraded' || s.health === 'Missing' || (failedOp && s.sync !== 'Synced')
      ? 'degraded'
      : s.operationRunning || s.health === 'Progressing'
        ? 'progressing'
        : s.sync === 'OutOfSync'
          ? 'outOfSync'
          : s.health === 'Suspended'
            ? 'suspended'
            : s.sync === 'Synced' && s.health === 'Healthy'
              ? 'healthy'
              : 'unknown';
  const revision =
    s.revisions.length > 1
      ? `${shortRevision(s.revisions[0])} +${s.revisions.length - 1}`
      : shortRevision(s.revision);
  return {
    uid: obj.metadata.uid,
    obj,
    tool: 'argo',
    kind: obj.kind,
    name: obj.metadata.name,
    namespace: obj.metadata.namespace ?? '',
    sync: s.sync || 'Unknown',
    syncTone: argoSyncTone(s.sync),
    health: s.health || 'Unknown',
    healthTone: argoHealthTone(s.health),
    revision,
    revisionFull: s.revisions.length ? s.revisions.join('\n') : s.revision,
    source:
      sources.length > 1
        ? `${argoSourceText(sources[0]!)} +${sources.length - 1}`
        : sources[0]
          ? argoSourceText(sources[0])
          : '',
    sourceRef: null,
    destination: dest.text,
    destNamespace: dest.namespace,
    lastSync: s.lastSync,
    suspended: false,
    autoSync: s.automated,
    operation: s.operationRunning ? s.operationPhase || 'Running' : '',
    message:
      (s.operationRunning || failedOp ? s.operationMessage : '') ||
      s.healthMessage ||
      conds[0]?.message ||
      '',
    bucket,
  };
}

function fluxRow(obj: KubeObject): GitOpsRow {
  const f = fluxStatus(obj);
  const src = fluxSourceRef(obj);
  const s = spec(obj);
  const bucket: GitOpsBucket = f.suspended
    ? 'suspended'
    : f.health === 'Stalled' || f.health === 'Not Ready'
      ? 'degraded'
      : f.health === 'Reconciling'
        ? 'progressing'
        : f.health === 'Ready'
          ? 'healthy'
          : 'unknown';
  let source = src ? `${src.kind}/${src.name}` : '';
  let destNamespace = asString(s.targetNamespace);
  if (isFluxHelmRelease(obj)) {
    const chart = helmReleaseChart(obj);
    if (chart.chart) source = `${chart.chart}@${chart.version || '*'} · ${source}`;
    destNamespace ||= obj.metadata.namespace ?? '';
  } else if (isFluxKustomization(obj) && asString(s.path)) {
    source = `${source} · ${asString(s.path)}`;
  }
  const remote = isObject(s.kubeConfig);
  const revision = f.lastAppliedRevision || f.lastAttemptedRevision;
  return {
    uid: obj.metadata.uid,
    obj,
    tool: 'flux',
    kind: obj.kind,
    name: obj.metadata.name,
    namespace: obj.metadata.namespace ?? '',
    sync: f.ready?.reason ?? (f.ready ? f.ready.status : ''),
    syncTone: readyTone(f.ready),
    health: f.health,
    healthTone: fluxHealthTone(f.health),
    revision: shortRevision(revision),
    revisionFull:
      f.lastAttemptedRevision && f.lastAttemptedRevision !== f.lastAppliedRevision
        ? `${f.lastAppliedRevision}\n→ ${f.lastAttemptedRevision}`
        : revision,
    source,
    sourceRef: src,
    destination: `${remote ? 'remote' : 'in-cluster'}${destNamespace ? `/${destNamespace}` : ''}`,
    destNamespace,
    lastSync: f.ready?.lastTransitionTime ?? '',
    suspended: f.suspended,
    autoSync: null,
    operation: '',
    message: f.ready?.message ?? '',
    bucket,
  };
}

/** Normalized overview row for an Argo Application, Flux Kustomization or HelmRelease. */
export function gitopsRow(obj: KubeObject): GitOpsRow | null {
  if (isArgoApplication(obj)) return argoRow(obj);
  if (toolOf(obj) === 'flux' && (isFluxKustomization(obj) || isFluxHelmRelease(obj)))
    return fluxRow(obj);
  return null;
}

export function countBuckets(rows: readonly GitOpsRow[]): Record<GitOpsBucket, number> {
  const out: Record<GitOpsBucket, number> = {
    healthy: 0,
    outOfSync: 0,
    degraded: 0,
    progressing: 0,
    suspended: 0,
    unknown: 0,
  };
  for (const r of rows) out[r.bucket]++;
  return out;
}

/** Attention first, then kind, namespace and name. */
export function sortRows(rows: GitOpsRow[]): GitOpsRow[] {
  return rows.sort(
    (a, b) =>
      BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
      a.name.localeCompare(b.name) ||
      a.namespace.localeCompare(b.namespace) ||
      a.kind.localeCompare(b.kind),
  );
}

export function rowSearchText(r: GitOpsRow): string {
  return `${r.name} ${r.namespace} ${r.kind} ${r.sync} ${r.health} ${r.revisionFull} ${r.source} ${r.destination} ${r.message}`.toLowerCase();
}
