/**
 * Shared frontend ⇄ backend contract. Every shape here is produced or
 * consumed by a Tauri command in `apps/desktop/src-tauri/src/ipc/*` and
 * mirrored by a serde struct in `crates/kubepit-core`. Field names are
 * snake_case because they cross the IPC boundary verbatim.
 */

// ---------------------------------------------------------------------------
// Workspace organisation (sidebar sections, ordering)
// ---------------------------------------------------------------------------

export type ClusterId = string;
export type SectionId = string;

export type SectionColor =
  'blue' | 'green' | 'orange' | 'purple' | 'pink' | 'cyan' | 'yellow' | 'slate';

export interface Section {
  id: SectionId;
  name: string;
  color: SectionColor;
}

/** Opaque UI snapshot persisted to `~/.kubepit/workspace.json`. */
export interface WorkspaceSnapshot {
  version: 1;
  sections: Section[];
  clusterSection: Record<ClusterId, SectionId>;
  collapsedSections: Record<SectionId, boolean>;
  sectionItemOrder: Record<SectionId, string[]>;
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

export type ClusterEnvironment = 'production' | 'staging' | 'development' | 'testing' | 'local';

export interface ClusterDef {
  id: ClusterId;
  /** Display name. Defaults to the context name on import. */
  name: string;
  /** Context name inside `kubeconfig_path`. */
  context: string;
  /** Absolute path of the kubeconfig file that holds `context`. */
  kubeconfig_path: string;
  /** True when Kubepit owns the file (pasted kubeconfig stored under ~/.kubepit/kubeconfigs). */
  managed: boolean;
  tags: string[];
  environment: ClusterEnvironment | null;
  /** Hex colour used for the cluster avatar. */
  color: string | null;
  /** Namespace the workbench opens on. `null` = all namespaces. */
  default_namespace: string | null;
  /**
   * Namespaces the user can access when RBAC forbids listing namespaces.
   * When non-empty, the namespace picker offers exactly these.
   */
  accessible_namespaces: string[];
  /** Blocks every mutating command for this cluster (UI + backend). */
  read_only: boolean;
  notes: string;
  created_at: number;
  last_connected_at: number | null;
}

export interface ClusterInput {
  name: string;
  context: string;
  /** Existing kubeconfig on disk. Exactly one of path/text must be set. */
  kubeconfig_path?: string | null;
  /** Pasted kubeconfig. Stored as a managed file. */
  kubeconfig_text?: string | null;
  tags: string[];
  environment: ClusterEnvironment | null;
  color: string | null;
  default_namespace: string | null;
  accessible_namespaces: string[];
  read_only: boolean;
  notes: string;
}

export type ConnState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ClusterStatus {
  id: ClusterId;
  state: ConnState;
  error: string | null;
  /** gitVersion reported by the API server, e.g. `v1.31.2-eks-7f9249a`. */
  version: string | null;
  /** Best-effort distribution: EKS, GKE, AKS, OpenShift, k3s, kind, minikube, Docker Desktop, … */
  platform: string | null;
  server: string | null;
  connected_at: number | null;
}

export interface KubeconfigContext {
  name: string;
  cluster: string;
  user: string;
  namespace: string | null;
  server: string | null;
}

export interface KubeconfigSource {
  /** Absolute path, or '' for pasted text. */
  path: string;
  contexts: KubeconfigContext[];
  current_context: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Kubernetes resources
// ---------------------------------------------------------------------------

/** Enough to address any served resource type. */
export interface Gvk {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
}

export interface ApiResourceInfo extends Gvk {
  /** `apps/v1` or `v1`. */
  api_version: string;
  verbs: string[];
  short_names: string[];
  categories: string[];
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
    controller?: boolean;
  }>;
  finalizers?: string[];
}

/** Raw Kubernetes object as returned by the API server (managedFields stripped). */
export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: ObjectMeta;
  // Resource-specific payload; tables read it through typed accessors.
  spec?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  status?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  [key: string]: unknown;
}

export interface ResourceList {
  items: KubeObject[];
  resource_version: string;
}

/**
 * Watch deliveries are batched on the backend (~150 ms) so a busy
 * namespace cannot flood the webview. Apply in order: when `reset` is
 * true, clear the local cache first; then apply `upserts`, then drop
 * `deletes` (uids).
 */
export interface WatchBatch {
  watch_id: string;
  reset: boolean;
  upserts: KubeObject[];
  deletes: string[];
  /** True once the initial list has been fully delivered. */
  synced: boolean;
  error: string | null;
}

export type ApplyMode = 'apply' | 'replace' | 'create';
export type PatchType = 'merge' | 'json' | 'strategic';
export type DeletePropagation = 'Background' | 'Foreground' | 'Orphan';

export interface DeleteOptions {
  propagation?: DeletePropagation | null;
  grace_period_seconds?: number | null;
}

// -- Workload operations (rollout history, set image, dry run) ---------------

/** One container's image: listed by rollout history, sent by set image. */
export interface ContainerImage {
  container: string;
  image: string;
  init: boolean;
}

/**
 * One rollout revision: a Deployment's ReplicaSet, or a StatefulSet's /
 * DaemonSet's ControllerRevision. Lists are newest first.
 */
export interface RolloutRevision {
  revision: number;
  /** ReplicaSet or ControllerRevision name. */
  name: string;
  created: string | null;
  /** `kubernetes.io/change-cause`. */
  change_cause: string | null;
  /** App containers first, then init containers. */
  images: ContainerImage[];
  /** Pod template (`pod-template-hash` / `controller-revision-hash` stripped). */
  template: Record<string, unknown>;
  /** ReplicaSets only: `status.replicas` / `status.readyReplicas`. */
  replicas: number | null;
  ready_replicas: number | null;
  /** The revision the workload's spec currently runs. */
  current: boolean;
}

export type DryRunOperation = 'create' | 'update' | 'unchanged';

/**
 * Server-side dry run (`dryRun=All`) of one manifest document. `operation`
 * is what the request would do (`create` when nothing is live); `error` is
 * set when the server or Kubepit rejected the document.
 */
export interface DryRunResult {
  api_version: string;
  kind: string;
  name: string;
  namespace: string | null;
  operation: DryRunOperation;
  live: KubeObject | null;
  result: KubeObject | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogOptions {
  follow: boolean;
  tail_lines: number | null;
  since_seconds: number | null;
  timestamps: boolean;
  previous: boolean;
}

export interface LogChunk {
  stream_id: string;
  /** Raw text; may contain several lines and ANSI escapes. */
  data: string;
  done: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Metrics & overview
// ---------------------------------------------------------------------------

export interface Quantity {
  cpu_millicores: number;
  memory_bytes: number;
}

export interface NodeMetric extends Quantity {
  name: string;
}

export interface PodMetric extends Quantity {
  namespace: string;
  name: string;
  containers: Array<Quantity & { name: string }>;
}

export interface MetricsResult<T> {
  /** False when metrics.k8s.io is not served (no metrics-server). */
  available: boolean;
  items: T[];
}

export interface ClusterOverview {
  version: string | null;
  platform: string | null;
  nodes: { total: number; ready: number };
  pods: {
    total: number;
    running: number;
    pending: number;
    failed: number;
    succeeded: number;
    unknown: number;
  };
  namespaces: number;
  deployments: { total: number; available: number };
  capacity: Quantity & { pods: number };
  allocatable: Quantity & { pods: number };
  requests: Quantity;
  limits: Quantity;
  /** Null when metrics-server is unavailable. */
  usage: Quantity | null;
  /** Most recent Warning events, newest first (max 50). */
  warnings: KubeObject[];
}

// ---------------------------------------------------------------------------
// Port forwarding
// ---------------------------------------------------------------------------

export type PortForwardState = 'starting' | 'active' | 'error' | 'stopped';

export interface PortForwardRequest {
  cluster_id: ClusterId;
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  remote_port: number;
  /** null/0 = pick a free port. */
  local_port: number | null;
}

export interface PortForward extends PortForwardRequest {
  id: string;
  local_port: number;
  state: PortForwardState;
  error: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helm (read natively from release secrets; mutations use the helm CLI)
// ---------------------------------------------------------------------------

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  chart_version: string;
  app_version: string | null;
  updated: string | null;
  description: string | null;
}

export interface HelmReleaseDetail {
  release: HelmRelease;
  history: HelmRelease[];
  values_yaml: string;
  computed_values_yaml: string;
  manifest: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// Terminal (RunHQ PTY pipeline, extended for Kubernetes sessions)
// ---------------------------------------------------------------------------

export type TerminalSpec =
  /** Local login shell. With a cluster, KUBECONFIG points at that cluster's context. */
  | { kind: 'local'; cluster_id: ClusterId | null; namespace: string | null }
  | {
      kind: 'pod-exec';
      cluster_id: ClusterId;
      namespace: string;
      pod: string;
      container: string | null;
      /** Defaults to `sh -c "clear; (bash || ash || sh)"`. */
      command: string[] | null;
    }
  | {
      kind: 'pod-attach';
      cluster_id: ClusterId;
      namespace: string;
      pod: string;
      container: string | null;
    }
  /** Privileged helper pod + nsenter on the node; deleted when the terminal closes. */
  | { kind: 'node-shell'; cluster_id: ClusterId; node: string };

export interface TerminalOutput {
  /** Base64-encoded raw PTY bytes. */
  data: string;
  stream_id: string;
}

// ---------------------------------------------------------------------------
// App info & settings
// ---------------------------------------------------------------------------

export interface ToolInfo {
  path: string | null;
  version: string | null;
}

export interface AppInfo {
  version: string;
  platform: 'macos' | 'linux' | 'windows';
  data_dir: string;
  kubectl: ToolInfo;
  helm: ToolInfo;
}

export interface Settings {
  kubectl_path: string | null;
  helm_path: string | null;
  shell_path: string | null;
  /** Extra folders scanned for kubeconfig files by discovery. */
  kubeconfig_sync_paths: string[];
  terminal_font_size: number;
  log_tail_lines: number;
  /** Ask before delete/scale/drain on every cluster, not only production ones. */
  confirm_destructive: boolean;
  /** Image used by node shells. */
  node_shell_image: string;
}

// ---------------------------------------------------------------------------
// Access (RBAC self-reviews: SelfSubjectAccessReview / RulesReview / Review)
// ---------------------------------------------------------------------------

/** One `kubectl auth can-i` question. `namespace: null` asks cluster-wide. */
export interface AccessCheck {
  verb: string;
  /** API group; '' is the core group. */
  group: string;
  /** Plural resource name (`pods`, `deployments`). */
  resource: string;
  subresource?: string | null;
  namespace?: string | null;
  name?: string | null;
}

export interface AccessDecision {
  allowed: boolean;
  /** An authorizer explicitly denied (not just "no authorizer allowed"). */
  denied: boolean;
  reason: string | null;
  /** The review itself failed: neither allowed nor denied is known. */
  error: string | null;
}

export interface AccessResourceRule {
  verbs: string[];
  api_groups: string[];
  resources: string[];
  /** Empty = every name. */
  resource_names: string[];
}

export interface AccessNonResourceRule {
  verbs: string[];
  non_resource_urls: string[];
}

/** SelfSubjectRulesReview for one namespace (includes cluster-wide grants). */
export interface AccessRules {
  resource_rules: AccessResourceRule[];
  non_resource_rules: AccessNonResourceRule[];
  /** Some authorizer (typically a webhook) could not list its rules. */
  incomplete: boolean;
  evaluation_error: string | null;
}

/** The authenticated identity (`kubectl auth whoami`). */
export interface WhoAmI {
  username: string;
  uid: string | null;
  groups: string[];
  extra: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Fleet: metrics history & fleet search
// ---------------------------------------------------------------------------

/** Which series `metrics_history` returns. Named series are summed per sample. */
export type MetricsHistoryQuery =
  | { scope: 'cluster' }
  | { scope: 'nodes'; names: string[] }
  /** A workload's series = the sum of its pods. */
  | { scope: 'pods'; namespace: string; names: string[] };

export interface MetricsPoint extends Quantity {
  /** Epoch ms. */
  ts: number;
}

export interface MetricsSeries {
  /** Seconds between points: 15 at full resolution, 60 when downsampled. */
  interval_secs: number;
  /** False while metrics-server is known to be unavailable. */
  available: boolean;
  /** Oldest first, last 60 minutes. Paused sampling shows up as gaps. */
  points: MetricsPoint[];
}

export interface FleetSearchQuery {
  /** Name pattern: substring (default), glob (`web-*`) or `/regex/`; terms are ANDed. */
  text: string;
  kinds: Gvk[];
  /** Empty = every registered cluster; disconnected ones are reported as skipped. */
  cluster_ids: ClusterId[];
  namespace: string | null;
  label_selector: string | null;
  limit_per_kind: number;
}

export type FleetSearchEventKind =
  'results' | 'cluster-done' | 'cluster-error' | 'cluster-skipped' | 'done';

export interface FleetSearchItem {
  /** The version this cluster serves. */
  gvk: Gvk;
  namespace: string | null;
  name: string;
  uid: string;
  /** creationTimestamp (RFC 3339). */
  created: string | null;
  labels: Record<string, string>;
}

export interface FleetSearchEvent {
  search_id: string;
  /** Null only on the final `done`. */
  cluster_id: ClusterId | null;
  kind: FleetSearchEventKind;
  items: FleetSearchItem[];
  /** `results`: more matches than `limit_per_kind`. */
  truncated: boolean;
  /** `cluster-done` / `cluster-error`: kinds RBAC did not allow listing. */
  forbidden_kinds: string[];
  error: string | null;
}
