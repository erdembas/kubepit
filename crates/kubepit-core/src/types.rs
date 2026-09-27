//! Serde mirrors of `apps/desktop/src/types/index.ts`.
//!
//! Every struct here crosses the IPC boundary verbatim, so field names are
//! the snake_case names written in the TypeScript contract. Kubernetes
//! objects themselves (`KubeObject`) are passed through as raw
//! [`serde_json::Value`] and keep their camelCase API fields.
//!
//! Keep this file boring: plain data, no behaviour beyond defaults. Anything
//! that needs logic lives next to the module that owns it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Raw Kubernetes object as returned by the API server (managedFields stripped).
pub type KubeObject = Value;

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClusterEnvironment {
    Production,
    Staging,
    Development,
    Testing,
    Local,
}

/// A registered cluster: one context inside one kubeconfig file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClusterDef {
    pub id: String,
    pub name: String,
    pub context: String,
    pub kubeconfig_path: String,
    #[serde(default)]
    pub managed: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub environment: Option<ClusterEnvironment>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub default_namespace: Option<String>,
    #[serde(default)]
    pub accessible_namespaces: Vec<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub last_connected_at: Option<i64>,
}

/// What the "add cluster" flow sends. Exactly one of `kubeconfig_path` /
/// `kubeconfig_text` must be set.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ClusterInput {
    #[serde(default)]
    pub name: String,
    pub context: String,
    #[serde(default)]
    pub kubeconfig_path: Option<String>,
    #[serde(default)]
    pub kubeconfig_text: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub environment: Option<ClusterEnvironment>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub default_namespace: Option<String>,
    #[serde(default)]
    pub accessible_namespaces: Vec<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClusterStatus {
    pub id: String,
    pub state: ConnState,
    pub error: Option<String>,
    pub version: Option<String>,
    pub platform: Option<String>,
    pub server: Option<String>,
    pub connected_at: Option<i64>,
}

impl ClusterStatus {
    /// The status of a cluster nobody has connected to yet.
    pub fn disconnected(id: &str) -> Self {
        Self {
            id: id.to_string(),
            state: ConnState::Disconnected,
            error: None,
            version: None,
            platform: None,
            server: None,
            connected_at: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KubeconfigContext {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub server: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KubeconfigSource {
    /// Absolute path, or `""` for pasted text.
    pub path: String,
    pub contexts: Vec<KubeconfigContext>,
    pub current_context: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Kubernetes resources
// ---------------------------------------------------------------------------

/// Enough to address any served resource type.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Gvk {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
}

impl Gvk {
    /// `apps/v1` for grouped resources, plain `v1` for the core group.
    pub fn api_version(&self) -> String {
        if self.group.is_empty() {
            self.version.clone()
        } else {
            format!("{}/{}", self.group, self.version)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiResourceInfo {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
    pub api_version: String,
    pub verbs: Vec<String>,
    pub short_names: Vec<String>,
    pub categories: Vec<String>,
}

impl ApiResourceInfo {
    pub fn gvk(&self) -> Gvk {
        Gvk {
            group: self.group.clone(),
            version: self.version.clone(),
            kind: self.kind.clone(),
            plural: self.plural.clone(),
            namespaced: self.namespaced,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceList {
    pub items: Vec<KubeObject>,
    pub resource_version: String,
}

/// One batched delivery of a resource watch. Apply in order: `reset`
/// (clear), `upserts`, then `deletes` (uids).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WatchBatch {
    pub watch_id: String,
    pub reset: bool,
    pub upserts: Vec<KubeObject>,
    pub deletes: Vec<String>,
    pub synced: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApplyMode {
    Apply,
    Replace,
    Create,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchType {
    Merge,
    Json,
    Strategic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeletePropagation {
    Background,
    Foreground,
    Orphan,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeleteOptions {
    #[serde(default)]
    pub propagation: Option<DeletePropagation>,
    #[serde(default)]
    pub grace_period_seconds: Option<i64>,
}

// -- Workload operations (rollout history, set image, dry run) ---------------

/// One container's image: listed by rollout history, sent by set image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerImage {
    pub container: String,
    pub image: String,
    #[serde(default)]
    pub init: bool,
}

/// One rollout revision: a Deployment's ReplicaSet, or a StatefulSet's /
/// DaemonSet's ControllerRevision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RolloutRevision {
    pub revision: i64,
    /// Name of the ReplicaSet or ControllerRevision.
    pub name: String,
    pub created: Option<String>,
    pub change_cause: Option<String>,
    pub images: Vec<ContainerImage>,
    /// Pod template (`pod-template-hash` / `controller-revision-hash` stripped).
    pub template: Value,
    /// ReplicaSets only: `status.replicas` / `status.readyReplicas`.
    pub replicas: Option<i64>,
    pub ready_replicas: Option<i64>,
    /// The revision the workload's spec currently runs.
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DryRunOperation {
    Create,
    Update,
    Unchanged,
}

/// Outcome of a server-side dry run for one document. `operation` is what
/// the request would do (create when nothing is live); `error` is set when
/// the server (or Kubepit) rejected the document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DryRunResult {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub operation: DryRunOperation,
    pub live: Option<KubeObject>,
    pub result: Option<KubeObject>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LogOptions {
    #[serde(default)]
    pub follow: bool,
    #[serde(default)]
    pub tail_lines: Option<i64>,
    #[serde(default)]
    pub since_seconds: Option<i64>,
    #[serde(default)]
    pub timestamps: bool,
    #[serde(default)]
    pub previous: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogChunk {
    pub stream_id: String,
    pub data: String,
    pub done: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Workload logs, debug containers, container files
// ---------------------------------------------------------------------------

/// Options of a merged workload log stream (`workload_logs_stream`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkloadLogOptions {
    /// Containers to follow in every pod; empty = every regular container.
    #[serde(default)]
    pub containers: Vec<String>,
    /// Also follow init containers.
    #[serde(default)]
    pub init_containers: bool,
    /// Backlog per container when it is first attached.
    #[serde(default)]
    pub tail_lines: Option<i64>,
    #[serde(default)]
    pub since_seconds: Option<i64>,
    /// Keep the RFC 3339 prefix the API server adds to every line.
    #[serde(default)]
    pub timestamps: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkloadLogEventKind {
    /// Complete lines of one source.
    Lines,
    /// A log stream for pod/container started (again, after a restart).
    SourceAdded,
    /// That stream finished (container exited, or the stream failed:
    /// `message`). A restart sends `source-added` again.
    SourceEnded,
    /// The pod is gone (deleted or no longer matched); nothing follows.
    SourceRemoved,
    /// Not followed because the concurrent stream limit is reached.
    SourceSkipped,
    /// Stream-level problem that does not end the stream (`message`).
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkloadLogEvent {
    pub kind: WorkloadLogEventKind,
    /// Empty for stream-level warnings.
    pub pod: String,
    pub container: String,
    /// `lines` only: complete lines without their newline.
    pub lines: Vec<String>,
    pub message: Option<String>,
}

/// One flush (~100 ms) of a workload log stream; `workload_logs.rs`
/// documents the ordering guarantees.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkloadLogBatch {
    pub stream_id: String,
    pub events: Vec<WorkloadLogEvent>,
    /// Last batch of the stream.
    pub done: bool,
    /// Set on the last batch when the stream failed as a whole.
    pub error: Option<String>,
}

/// `kubectl debug --profile`: extra privileges for the debug container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DebugProfile {
    General,
    Netadmin,
    Sysadmin,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PodDebugRequest {
    pub image: String,
    /// Share this container's process namespace.
    #[serde(default)]
    pub target_container: Option<String>,
    /// Defaults to `debugger-<5 chars>`.
    #[serde(default)]
    pub name: Option<String>,
    /// Defaults to the image's entrypoint.
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub profile: Option<DebugProfile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PodFsKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PodFsEntry {
    pub name: String,
    pub kind: PodFsKind,
    pub size: Option<u64>,
    /// `ls -l` style, e.g. `drwxr-xr-x`.
    pub mode: Option<String>,
    /// Modification time, epoch seconds.
    pub modified: Option<i64>,
    pub link_target: Option<String>,
    /// Symlink whose target is a directory.
    pub link_to_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PodDirListing {
    /// Absolute path of the listed directory, as the container's shell sees it.
    pub path: String,
    /// Directories first, then by name.
    pub entries: Vec<PodFsEntry>,
    /// More entries exist than were returned.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PodFileContent {
    pub path: String,
    /// Size on disk, when the container could report it.
    pub size: Option<u64>,
    /// UTF-8 text (not binary).
    pub text: Option<String>,
    /// Raw bytes of binary content.
    pub base64: Option<String>,
    /// Only the first `max_bytes` were read.
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PodFsTransfer {
    /// Local file (download) or remote file (upload) that was written.
    pub path: String,
    pub bytes: u64,
    /// The download is a tar archive of a directory.
    pub archive: bool,
}

// ---------------------------------------------------------------------------
// Metrics & overview
// ---------------------------------------------------------------------------

/// CPU in millicores (fractional: metrics report nanocores) and memory in bytes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Quantity {
    pub cpu_millicores: f64,
    pub memory_bytes: f64,
}

impl Quantity {
    pub fn add(&mut self, other: Quantity) {
        self.cpu_millicores += other.cpu_millicores;
        self.memory_bytes += other.memory_bytes;
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeMetric {
    pub name: String,
    pub cpu_millicores: f64,
    pub memory_bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContainerMetric {
    pub name: String,
    pub cpu_millicores: f64,
    pub memory_bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PodMetric {
    pub namespace: String,
    pub name: String,
    pub cpu_millicores: f64,
    pub memory_bytes: f64,
    pub containers: Vec<ContainerMetric>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetricsResult<T> {
    pub available: bool,
    pub items: Vec<T>,
}

impl<T> MetricsResult<T> {
    pub fn unavailable() -> Self {
        Self {
            available: false,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct NodeCounts {
    pub total: u64,
    pub ready: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct PodCounts {
    pub total: u64,
    pub running: u64,
    pub pending: u64,
    pub failed: u64,
    pub succeeded: u64,
    pub unknown: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct DeploymentCounts {
    pub total: u64,
    pub available: u64,
}

/// `Quantity & { pods: number }` from the contract.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Capacity {
    pub cpu_millicores: f64,
    pub memory_bytes: f64,
    pub pods: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClusterOverview {
    pub version: Option<String>,
    pub platform: Option<String>,
    pub nodes: NodeCounts,
    pub pods: PodCounts,
    pub namespaces: u64,
    pub deployments: DeploymentCounts,
    pub capacity: Capacity,
    pub allocatable: Capacity,
    pub requests: Quantity,
    pub limits: Quantity,
    pub usage: Option<Quantity>,
    pub warnings: Vec<KubeObject>,
}

// ---------------------------------------------------------------------------
// Port forwarding
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortForwardState {
    Starting,
    Active,
    Error,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortForwardKind {
    Pod,
    Service,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortForwardRequest {
    pub cluster_id: String,
    pub namespace: String,
    pub kind: PortForwardKind,
    pub name: String,
    pub remote_port: u16,
    /// `None`/`0` picks a free port.
    #[serde(default)]
    pub local_port: Option<u16>,
}

/// `PortForwardRequest & { id, local_port: number, state, error, created_at }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortForward {
    pub id: String,
    pub cluster_id: String,
    pub namespace: String,
    pub kind: PortForwardKind,
    pub name: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub state: PortForwardState,
    pub error: Option<String>,
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Helm
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: i64,
    pub status: String,
    pub chart: String,
    pub chart_version: String,
    pub app_version: Option<String>,
    pub updated: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelmReleaseDetail {
    pub release: HelmRelease,
    pub history: Vec<HelmRelease>,
    pub values_yaml: String,
    pub computed_values_yaml: String,
    pub manifest: String,
    pub notes: String,
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/// What runs inside a PTY. Internally tagged on `kind`; the variant names
/// are kebab-case while the fields stay snake_case, exactly like the TS union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TerminalSpec {
    Local {
        #[serde(default)]
        cluster_id: Option<String>,
        #[serde(default)]
        namespace: Option<String>,
    },
    PodExec {
        cluster_id: String,
        namespace: String,
        pod: String,
        #[serde(default)]
        container: Option<String>,
        #[serde(default)]
        command: Option<Vec<String>>,
    },
    PodAttach {
        cluster_id: String,
        namespace: String,
        pod: String,
        #[serde(default)]
        container: Option<String>,
    },
    NodeShell {
        cluster_id: String,
        node: String,
    },
}

// ---------------------------------------------------------------------------
// App info & settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolInfo {
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppInfo {
    pub version: String,
    /// `macos` | `linux` | `windows`.
    pub platform: String,
    pub data_dir: String,
    pub kubectl: ToolInfo,
    pub helm: ToolInfo,
}

/// Default image for node shells: small, multi-arch, ships `nsenter` (busybox).
pub const DEFAULT_NODE_SHELL_IMAGE: &str = "docker.io/library/alpine:3.20";
/// Default image for ephemeral debug containers (`kubectl debug`).
pub const DEFAULT_DEBUG_IMAGE: &str = "docker.io/library/busybox:1.36";

/// User preferences. Every field has a default so older or hand-edited
/// `settings.json` files keep loading after new fields are added.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub kubectl_path: Option<String>,
    pub helm_path: Option<String>,
    pub shell_path: Option<String>,
    pub kubeconfig_sync_paths: Vec<String>,
    pub terminal_font_size: u32,
    pub log_tail_lines: u32,
    pub confirm_destructive: bool,
    pub node_shell_image: String,
    /// Default image for ephemeral debug containers.
    pub debug_image: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            kubectl_path: None,
            helm_path: None,
            shell_path: None,
            kubeconfig_sync_paths: Vec::new(),
            terminal_font_size: 13,
            log_tail_lines: 1000,
            confirm_destructive: true,
            node_shell_image: DEFAULT_NODE_SHELL_IMAGE.to_string(),
            debug_image: DEFAULT_DEBUG_IMAGE.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Access (RBAC self-reviews)
// ---------------------------------------------------------------------------

/// One `kubectl auth can-i` question. `namespace: None` asks cluster-wide
/// (cluster-scoped kinds, or every namespace for namespaced ones).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AccessCheck {
    pub verb: String,
    /// API group; `""` is the core group.
    #[serde(default)]
    pub group: String,
    /// Plural resource name (`pods`, `deployments`).
    pub resource: String,
    #[serde(default)]
    pub subresource: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Answer to one [`AccessCheck`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AccessDecision {
    pub allowed: bool,
    /// An authorizer explicitly denied (not just "no authorizer allowed").
    pub denied: bool,
    pub reason: Option<String>,
    /// The review itself failed: neither `allowed` nor `denied` is known.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AccessResourceRule {
    pub verbs: Vec<String>,
    pub api_groups: Vec<String>,
    pub resources: Vec<String>,
    /// Empty = every name.
    pub resource_names: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AccessNonResourceRule {
    pub verbs: Vec<String>,
    pub non_resource_urls: Vec<String>,
}

/// `SelfSubjectRulesReview` for one namespace.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AccessRules {
    pub resource_rules: Vec<AccessResourceRule>,
    pub non_resource_rules: Vec<AccessNonResourceRule>,
    /// Some authorizer (typically a webhook) could not list its rules.
    pub incomplete: bool,
    pub evaluation_error: Option<String>,
}

/// The authenticated identity (`kubectl auth whoami`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WhoAmI {
    pub username: String,
    pub uid: Option<String>,
    pub groups: Vec<String>,
    pub extra: std::collections::BTreeMap<String, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Fleet: metrics history & fleet search
// ---------------------------------------------------------------------------

/// Which series `metrics_history` returns. Internally tagged on `scope`,
/// exactly like the TS union (`{ scope: 'pods', namespace, names }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum MetricsHistoryQuery {
    /// Cluster total (sum of nodes).
    Cluster,
    /// Sum of the named nodes.
    Nodes { names: Vec<String> },
    /// Sum of the named pods of one namespace (a workload = its pods).
    Pods {
        namespace: String,
        names: Vec<String>,
    },
}

/// One sample; `ts` is epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MetricsPoint {
    pub ts: i64,
    pub cpu_millicores: f64,
    pub memory_bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetricsSeries {
    /// Seconds between points (15 at full resolution, 60 when downsampled).
    pub interval_secs: u32,
    /// False while metrics-server is known to be unavailable.
    pub available: bool,
    /// Oldest first. Paused sampling shows up as missing points (gaps).
    pub points: Vec<MetricsPoint>,
}

/// Default cap on matches per (cluster, kind).
pub const DEFAULT_FLEET_SEARCH_LIMIT: u32 = 200;

fn default_fleet_search_limit() -> u32 {
    DEFAULT_FLEET_SEARCH_LIMIT
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FleetSearchQuery {
    /// Name pattern: substring (default), glob (`web-*`) or `/regex/`;
    /// space-separated terms must all match. Empty matches every name.
    #[serde(default)]
    pub text: String,
    pub kinds: Vec<Gvk>,
    /// Empty = every registered cluster (disconnected ones are skipped).
    #[serde(default)]
    pub cluster_ids: Vec<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub label_selector: Option<String>,
    #[serde(default = "default_fleet_search_limit")]
    pub limit_per_kind: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FleetSearchEventKind {
    Results,
    ClusterDone,
    ClusterError,
    ClusterSkipped,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FleetSearchItem {
    /// The version the cluster serves, which may differ from the query's.
    pub gvk: Gvk,
    pub namespace: Option<String>,
    pub name: String,
    pub uid: String,
    /// `metadata.creationTimestamp` (RFC 3339).
    pub created: Option<String>,
    pub labels: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FleetSearchEvent {
    pub search_id: String,
    /// `None` only on the final `done` event.
    pub cluster_id: Option<String>,
    pub kind: FleetSearchEventKind,
    pub items: Vec<FleetSearchItem>,
    /// `results`: the kind had more matches than `limit_per_kind`.
    pub truncated: bool,
    /// `cluster-done` / `cluster-error`: kinds RBAC did not allow listing.
    pub forbidden_kinds: Vec<String>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terminal_spec_uses_kebab_case_tags_and_snake_case_fields() {
        let spec: TerminalSpec = serde_json::from_value(json!({
            "kind": "pod-exec",
            "cluster_id": "c1",
            "namespace": "default",
            "pod": "web-0",
            "container": null,
            "command": null
        }))
        .unwrap();
        assert_eq!(
            spec,
            TerminalSpec::PodExec {
                cluster_id: "c1".into(),
                namespace: "default".into(),
                pod: "web-0".into(),
                container: None,
                command: None,
            }
        );
        let node: TerminalSpec =
            serde_json::from_value(json!({"kind": "node-shell", "cluster_id": "c", "node": "n1"}))
                .unwrap();
        assert!(matches!(node, TerminalSpec::NodeShell { .. }));
        let local: TerminalSpec =
            serde_json::from_value(json!({"kind": "local", "cluster_id": null, "namespace": null}))
                .unwrap();
        assert_eq!(
            local,
            TerminalSpec::Local {
                cluster_id: None,
                namespace: None
            }
        );
        let attach = serde_json::to_value(TerminalSpec::PodAttach {
            cluster_id: "c".into(),
            namespace: "ns".into(),
            pod: "p".into(),
            container: Some("app".into()),
        })
        .unwrap();
        assert_eq!(attach["kind"], "pod-attach");
        assert_eq!(attach["cluster_id"], "c");
    }

    #[test]
    fn settings_defaults_fill_missing_fields() {
        let s: Settings = serde_json::from_value(json!({"terminal_font_size": 15})).unwrap();
        assert_eq!(s.terminal_font_size, 15);
        assert_eq!(s.log_tail_lines, 1000);
        assert!(s.confirm_destructive);
        assert_eq!(s.node_shell_image, DEFAULT_NODE_SHELL_IMAGE);
        assert_eq!(s.debug_image, DEFAULT_DEBUG_IMAGE);
        assert!(s.kubeconfig_sync_paths.is_empty());
    }

    #[test]
    fn port_forward_serializes_flat_contract_shape() {
        let pf = PortForward {
            id: "pf".into(),
            cluster_id: "c".into(),
            namespace: "ns".into(),
            kind: PortForwardKind::Service,
            name: "web".into(),
            remote_port: 80,
            local_port: 8080,
            state: PortForwardState::Active,
            error: None,
            created_at: 1,
        };
        let v = serde_json::to_value(pf).unwrap();
        assert_eq!(v["kind"], "service");
        assert_eq!(v["state"], "active");
        assert_eq!(v["local_port"], 8080);
    }

    #[test]
    fn enums_match_contract_strings() {
        assert_eq!(
            serde_json::to_value(ConnState::Connecting).unwrap(),
            "connecting"
        );
        assert_eq!(
            serde_json::to_value(ClusterEnvironment::Production).unwrap(),
            "production"
        );
        assert_eq!(
            serde_json::to_value(DeletePropagation::Foreground).unwrap(),
            "Foreground"
        );
        assert_eq!(
            serde_json::from_value::<PatchType>(json!("strategic")).unwrap(),
            PatchType::Strategic
        );
        assert_eq!(
            serde_json::from_value::<ApplyMode>(json!("replace")).unwrap(),
            ApplyMode::Replace
        );
    }
}
