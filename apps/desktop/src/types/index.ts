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

/** `workspace://changed`: the window labelled `source` saved `snapshot`. */
export interface WorkspaceChanged {
  source: string;
  snapshot: WorkspaceSnapshot;
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
  /**
   * Connectivity: proxy for this cluster (`http://`, `https://`, `socks5://`,
   * `socks5h://`). Overrides the kubeconfig's `proxy-url`; null = none.
   */
  proxy_url?: string | null;
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
  /** Connectivity: per-cluster proxy override (see `ClusterDef.proxy_url`). */
  proxy_url?: string | null;
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
// Workload logs, debug containers, container files
// ---------------------------------------------------------------------------

export interface WorkloadLogOptions {
  /** Containers to follow in every pod; empty = every regular container. */
  containers: string[];
  /** Also follow init containers. */
  init_containers: boolean;
  /** Backlog per container when it is first attached. */
  tail_lines: number | null;
  since_seconds: number | null;
  /** Keep the RFC 3339 prefix the API server adds to every line. */
  timestamps: boolean;
}

export type WorkloadLogEventKind =
  /** Complete lines of one source. */
  | 'lines'
  /** A stream for pod/container started (again after a restart). */
  | 'source-added'
  /** That stream finished (`message` when it failed); a restart re-adds it. */
  | 'source-ended'
  /** The pod is gone; nothing follows for this source. */
  | 'source-removed'
  /** Not followed: the concurrent stream limit (64) is reached. */
  | 'source-skipped'
  /** Stream-level problem that does not end the stream. */
  | 'warning';

export interface WorkloadLogEvent {
  kind: WorkloadLogEventKind;
  /** Empty for stream-level warnings. */
  pod: string;
  container: string;
  /** `lines` only: complete lines without their newline. */
  lines: string[];
  message: string | null;
}

/**
 * One ~100 ms flush of a workload log stream. Per source, `source-added`
 * precedes its lines and `source-ended` / `source-removed` follow the last
 * one; within a batch, lines of different pods are ordered by time.
 */
export interface WorkloadLogBatch {
  stream_id: string;
  events: WorkloadLogEvent[];
  /** Last batch of the stream. */
  done: boolean;
  /** Set on the last batch when the stream failed as a whole. */
  error: string | null;
}

/** `kubectl debug --profile`: general adds nothing, netadmin adds NET_ADMIN/NET_RAW, sysadmin is privileged. */
export type DebugProfile = 'general' | 'netadmin' | 'sysadmin';

export interface PodDebugRequest {
  /** Empty = `settings.debug_image`. */
  image: string;
  /** Share this container's process namespace. */
  target_container: string | null;
  /** Defaults to `debugger-<5 chars>`. */
  name: string | null;
  /** Defaults to the image's entrypoint. */
  command: string[] | null;
  profile: DebugProfile | null;
}

export type PodFsKind = 'file' | 'dir' | 'symlink' | 'other';

export interface PodFsEntry {
  name: string;
  kind: PodFsKind;
  size: number | null;
  /** `ls -l` style, e.g. `drwxr-xr-x`. */
  mode: string | null;
  /** Modification time, epoch seconds. */
  modified: number | null;
  link_target: string | null;
  /** Symlink whose target is a directory. */
  link_to_dir: boolean;
}

export interface PodDirListing {
  /** Absolute path of the listed directory. */
  path: string;
  /** Directories first, then by name. */
  entries: PodFsEntry[];
  /** More entries exist than were returned (5 000 max). */
  truncated: boolean;
}

export interface PodFileContent {
  path: string;
  size: number | null;
  /** UTF-8 text (not binary). */
  text: string | null;
  /** Raw bytes of binary content. */
  base64: string | null;
  /** Only the first `max_bytes` were read. */
  truncated: boolean;
  binary: boolean;
}

export interface PodFsTransfer {
  /** Local file (download) or remote file (upload) that was written. */
  path: string;
  bytes: number;
  /** The download is a tar archive of a directory. */
  archive: boolean;
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
  /** The saved definition this forward was started from or saved as. */
  saved_id?: string | null;
}

/** A port forward kept in `~/.kubepit/port_forwards.json` (unique per target). */
export interface SavedPortForward {
  id: string;
  cluster_id: ClusterId;
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  remote_port: number;
  /** Fixed local port; null picks a free port on every start. */
  local_port: number | null;
  label: string | null;
  /** Start automatically whenever the cluster connects. */
  start_on_connect: boolean;
  created_at: number;
}

export type SavedPortForwardInput = Omit<SavedPortForward, 'id' | 'created_at'>;

/** `port_forward_local_port`: whether a local port is free, and a free alternative. */
export interface LocalPortStatus {
  port: number;
  available: boolean;
  suggestion: number | null;
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

// -- Helm charts: repositories, catalog, install / upgrade -------------------
// Repositories and the catalog are the user's helm configuration (local
// commands); `helm_hub_search` queries artifacthub.io.

export interface HelmRepo {
  name: string;
  url: string;
}

export interface HelmRepoAddOptions {
  username: string | null;
  /** Fed to `helm repo add --password-stdin`; never on the command line. */
  password: string | null;
  insecure_skip_tls_verify: boolean;
  pass_credentials: boolean;
  /** Replace an existing repository with the same name. */
  force_update: boolean;
}

export interface HelmRepoUpdateResult {
  name: string;
  ok: boolean;
  error: string | null;
}

export interface HelmSearchOptions {
  /** Every version instead of only the newest per chart. */
  versions: boolean;
  /** Include pre-release versions. */
  devel: boolean;
}

export interface HelmChartSummary {
  /** `repo/chart`, the reference `helm install` takes. */
  name: string;
  repo: string;
  chart: string;
  version: string;
  app_version: string | null;
  description: string;
  deprecated: boolean;
}

export interface HelmChartVersion {
  version: string;
  app_version: string | null;
}

export interface HelmHubChart {
  /** Artifact Hub package page. */
  url: string;
  version: string;
  app_version: string | null;
  description: string;
  repository_name: string;
  repository_url: string;
}

export interface HelmChartMaintainer {
  name: string;
  email: string | null;
  url: string | null;
}

export interface HelmChartDependency {
  name: string;
  version: string | null;
  repository: string | null;
  condition: string | null;
}

/** `Chart.yaml` as `helm show chart` prints it. */
export interface HelmChartMetadata {
  name: string;
  version: string;
  app_version: string | null;
  description: string | null;
  home: string | null;
  icon: string | null;
  sources: string[];
  keywords: string[];
  maintainers: HelmChartMaintainer[];
  dependencies: HelmChartDependency[];
  kube_version: string | null;
  /** `application` or `library`. */
  chart_type: string | null;
  deprecated: boolean;
}

export interface HelmChartDetail {
  metadata: HelmChartMetadata;
  readme: string;
  values_yaml: string;
}

export interface HelmInstallRequest {
  release_name: string;
  namespace: string;
  /** `repo/chart` or `oci://…`. */
  chart_ref: string;
  /** null installs the newest stable version. */
  version: string | null;
  /** User values; '' installs the chart defaults. */
  values_yaml: string;
  create_namespace: boolean;
  wait: boolean;
  atomic: boolean;
  timeout_secs: number | null;
  description: string | null;
  /** Render against the cluster without changing it (allowed on read-only clusters). */
  dry_run: boolean;
}

export interface HelmUpgradeRequest {
  chart_ref: string;
  version: string | null;
  values_yaml: string;
  reuse_values: boolean;
  reset_values: boolean;
  wait: boolean;
  atomic: boolean;
  timeout_secs: number | null;
  dry_run: boolean;
}

export interface HelmInstallResult {
  /** The release helm reports (the would-be release for dry runs). */
  release: HelmRelease | null;
  manifest: string;
  notes: string;
  /** User-supplied values of the (previewed) revision. */
  values_yaml: string;
  computed_values_yaml: string;
}

/** One stored revision of a release. */
export interface HelmRevisionDetail {
  release: HelmRelease;
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
  /** Default image for ephemeral debug containers. */
  debug_image: string;
  /**
   * Connectivity: pasted kubeconfigs live in the OS credential store.
   * Read-only here: change it with `kubeconfigStorageSet`, which migrates.
   */
  keychain_kubeconfigs: boolean;
}

// ---------------------------------------------------------------------------
// Connectivity: kubeconfig watching, proxies
// ---------------------------------------------------------------------------

/** A context that appeared in a watched kubeconfig and is not registered yet. */
export interface KubeconfigNewContext {
  /** Canonical path of the kubeconfig file (as discovery reports it). */
  path: string;
  context: string;
  server: string | null;
}

/** `kubeconfig://changed`: watched kubeconfig files changed on disk. */
export interface KubeconfigChanged {
  paths: string[];
  new_contexts: KubeconfigNewContext[];
  /** Connected clusters whose kubeconfig changed: reconnect to use it. */
  reconnect: ClusterId[];
}

export type ProxySource = 'cluster' | 'kubeconfig';

/** The proxy a cluster's connections go through (credentials masked). */
export interface ClusterProxyInfo {
  url: string | null;
  source: ProxySource | null;
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
