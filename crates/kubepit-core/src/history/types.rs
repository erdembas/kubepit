//! Serde mirrors of the history section of `apps/desktop/src/types/index.ts`
//! (`HistorySettings`, `AuditEntry`, `AuditFilter`, …).
//!
//! Like the change journal's types they live next to the feature instead of
//! in `types.rs`; field names are the snake_case names of the TS contract.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::Gvk;

/// Default retention of the own-action audit log.
pub const DEFAULT_AUDIT_RETENTION_DAYS: u32 = 90;
/// Default retention of persisted events and changes.
pub const DEFAULT_RETENTION_DAYS: u32 = 7;
/// Default cap of `history.db` (database + write-ahead log).
pub const DEFAULT_MAX_SIZE_MB: u32 = 512;

/// `Settings.history`. Everything lives only on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HistorySettings {
    /// Record every mutation Kubepit performs (on by default).
    pub audit: bool,
    pub audit_retention_days: u32,
    /// Clusters whose Kubernetes Events and change-journal entries are kept
    /// on disk (opt-in per cluster).
    pub persist_clusters: Vec<String>,
    /// Retention of persisted events and changes.
    pub retention_days: u32,
    /// Upper bound of the database size; the oldest events and changes go first.
    pub max_size_mb: u32,
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            audit: true,
            audit_retention_days: DEFAULT_AUDIT_RETENTION_DAYS,
            persist_clusters: Vec::new(),
            retention_days: DEFAULT_RETENTION_DAYS,
            max_size_mb: DEFAULT_MAX_SIZE_MB,
        }
    }
}

impl HistorySettings {
    /// Clamp out-of-range values instead of persisting them.
    pub fn normalized(mut self) -> Self {
        self.audit_retention_days = self.audit_retention_days.clamp(1, 3650);
        self.retention_days = self.retention_days.clamp(1, 3650);
        self.max_size_mb = self.max_size_mb.clamp(16, 64 * 1024);
        self.persist_clusters.retain(|id| !id.trim().is_empty());
        self.persist_clusters.sort();
        self.persist_clusters.dedup();
        self
    }

    pub fn persists(&self, cluster_id: &str) -> bool {
        self.persist_clusters.iter().any(|id| id == cluster_id)
    }
}

/// What Kubepit did. Kebab-case on the wire (`set-image`, `helm-install`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuditAction {
    /// `resource_apply_yaml` in `apply` mode (server-side apply).
    Apply,
    Create,
    Replace,
    Patch,
    Delete,
    Scale,
    Restart,
    SetImage,
    RolloutUndo,
    CronjobTrigger,
    Cordon,
    Uncordon,
    Drain,
    HelmInstall,
    HelmUpgrade,
    HelmRollback,
    HelmUninstall,
    ManifestsApply,
    PodDebug,
    FileUpload,
    NodeShell,
    /// `rightsizing_apply`: container requests/limits from a recommendation.
    Rightsize,
}

impl AuditAction {
    pub const ALL: &'static [AuditAction] = &[
        Self::Apply,
        Self::Create,
        Self::Replace,
        Self::Patch,
        Self::Delete,
        Self::Scale,
        Self::Restart,
        Self::SetImage,
        Self::RolloutUndo,
        Self::CronjobTrigger,
        Self::Cordon,
        Self::Uncordon,
        Self::Drain,
        Self::HelmInstall,
        Self::HelmUpgrade,
        Self::HelmRollback,
        Self::HelmUninstall,
        Self::ManifestsApply,
        Self::PodDebug,
        Self::FileUpload,
        Self::NodeShell,
        Self::Rightsize,
    ];

    /// The wire name (`set-image`), also stored in the database.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::Create => "create",
            Self::Replace => "replace",
            Self::Patch => "patch",
            Self::Delete => "delete",
            Self::Scale => "scale",
            Self::Restart => "restart",
            Self::SetImage => "set-image",
            Self::RolloutUndo => "rollout-undo",
            Self::CronjobTrigger => "cronjob-trigger",
            Self::Cordon => "cordon",
            Self::Uncordon => "uncordon",
            Self::Drain => "drain",
            Self::HelmInstall => "helm-install",
            Self::HelmUpgrade => "helm-upgrade",
            Self::HelmRollback => "helm-rollback",
            Self::HelmUninstall => "helm-uninstall",
            Self::ManifestsApply => "manifests-apply",
            Self::PodDebug => "pod-debug",
            Self::FileUpload => "file-upload",
            Self::NodeShell => "node-shell",
            Self::Rightsize => "rightsize",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|a| a.as_str() == text)
    }

    /// Actions whose before-state can be re-applied (Revert).
    pub fn revertible(self) -> bool {
        matches!(
            self,
            Self::Apply
                | Self::Replace
                | Self::Patch
                | Self::Scale
                | Self::SetImage
                | Self::Rightsize
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditOutcome {
    Ok,
    Error,
}

impl AuditOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
        }
    }
}

/// API version of the pseudo targets that stand for Helm releases.
pub const HELM_RELEASE_API_VERSION: &str = "helm.sh/v3";
/// Kind of the pseudo targets that stand for Helm releases.
pub const HELM_RELEASE_KIND: &str = "Release";

/// One object an action addressed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditTarget {
    /// `apps/v1`; [`HELM_RELEASE_API_VERSION`] for Helm releases.
    pub api_version: String,
    pub kind: String,
    /// The full resource descriptor when the command was addressed by one
    /// (or the kind was resolved through discovery).
    pub gvk: Option<Gvk>,
    pub namespace: Option<String>,
    pub name: String,
    /// This target failed while others succeeded (manifests apply).
    pub error: Option<String>,
}

impl AuditTarget {
    pub fn object(gvk: &Gvk, namespace: Option<&str>, name: &str) -> Self {
        Self {
            api_version: gvk.api_version(),
            kind: gvk.kind.clone(),
            gvk: Some(gvk.clone()),
            namespace: namespace
                .filter(|ns| gvk.namespaced && !ns.is_empty())
                .map(str::to_string),
            name: name.to_string(),
            error: None,
        }
    }

    pub fn core(kind: &str, namespace: Option<&str>, name: &str) -> Self {
        let (plural, namespaced) = match kind {
            "Node" => ("nodes", false),
            "Pod" => ("pods", true),
            _ => ("", namespace.is_some()),
        };
        let gvk = Gvk {
            group: String::new(),
            version: "v1".into(),
            kind: kind.to_string(),
            plural: plural.to_string(),
            namespaced,
        };
        Self::object(&gvk, namespace, name)
    }

    pub fn helm_release(namespace: &str, name: &str) -> Self {
        Self {
            api_version: HELM_RELEASE_API_VERSION.into(),
            kind: HELM_RELEASE_KIND.into(),
            gvk: None,
            namespace: Some(namespace.to_string()),
            name: name.to_string(),
            error: None,
        }
    }

    /// A manifest document before discovery resolved it.
    pub fn document(api_version: &str, kind: &str, namespace: Option<&str>, name: &str) -> Self {
        Self {
            api_version: api_version.to_string(),
            kind: kind.to_string(),
            gvk: None,
            namespace: namespace.map(str::to_string),
            name: name.to_string(),
            error: None,
        }
    }

    /// `Deployment shop/web`.
    pub fn label(&self) -> String {
        match &self.namespace {
            Some(ns) => format!("{} {ns}/{}", self.kind, self.name),
            None => format!("{} {}", self.kind, self.name),
        }
    }
}

/// One audit entry without object bodies (`history_audit_list`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: i64,
    /// Epoch ms when the action started.
    pub ts: i64,
    pub cluster_id: String,
    pub cluster_name: String,
    pub context: String,
    /// Username from the last `access_whoami` of the cluster; `None` = unknown.
    pub identity: Option<String>,
    pub action: AuditAction,
    pub dry_run: bool,
    pub outcome: AuditOutcome,
    pub error: Option<String>,
    pub duration_ms: i64,
    pub targets: Vec<AuditTarget>,
    /// Parameters of the action (replicas, images, patch, …). Anything that
    /// may hold Secret data is redacted (salted hash markers, keys kept).
    pub request: Option<Value>,
    /// What the action produced (Job name, debug container, helper pod).
    pub result: Option<String>,
    /// Before/after objects were kept for at least one target.
    pub has_diff: bool,
    /// At least one target has a before-state that can be re-applied.
    pub revertible: bool,
}

/// Before/after of one target (`history_audit_get`), normalized YAML.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditObject {
    /// Index into [`AuditEntry::targets`].
    pub target: u32,
    pub before_yaml: Option<String>,
    pub after_yaml: Option<String>,
    /// The bodies were too large and were not kept.
    pub omitted: bool,
    pub revertible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditDetail {
    pub entry: AuditEntry,
    pub objects: Vec<AuditObject>,
}

fn default_limit() -> u32 {
    200
}

/// `history_audit_list` / `history_audit_export` filter; empty lists match all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AuditFilter {
    pub cluster_ids: Vec<String>,
    pub actions: Vec<AuditAction>,
    pub outcome: Option<AuditOutcome>,
    /// Case-insensitive substring over cluster, identity, action, targets,
    /// error and result.
    pub text: Option<String>,
    /// Epoch ms, inclusive.
    pub since: Option<i64>,
    /// Epoch ms, inclusive.
    pub until: Option<i64>,
    pub limit: u32,
    /// `next_cursor` of the previous page.
    pub cursor: Option<String>,
}

impl Default for AuditFilter {
    fn default() -> Self {
        Self {
            cluster_ids: Vec::new(),
            actions: Vec::new(),
            outcome: None,
            text: None,
            since: None,
            until: None,
            limit: default_limit(),
            cursor: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    pub next_cursor: Option<String>,
    /// Entries matching the filter (all pages).
    pub total: u64,
}

/// `history_events_list` filter; empty lists match all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HistoryEventFilter {
    pub namespaces: Vec<String>,
    /// `involvedObject.uid`.
    pub involved_uid: Option<String>,
    /// `involvedObject.kind` + `.name` (earlier incarnations of an object).
    pub involved_kind: Option<String>,
    pub involved_name: Option<String>,
    /// `Warning`, `Normal`.
    pub types: Vec<String>,
    pub text: Option<String>,
    /// Epoch ms over the event's last occurrence, inclusive.
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub limit: u32,
    pub cursor: Option<String>,
}

impl Default for HistoryEventFilter {
    fn default() -> Self {
        Self {
            namespaces: Vec::new(),
            involved_uid: None,
            involved_kind: None,
            involved_name: None,
            types: Vec::new(),
            text: None,
            since: None,
            until: None,
            limit: default_limit(),
            cursor: None,
        }
    }
}

/// Persisted Events, newest occurrence first, as raw Kubernetes JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryEventPage {
    pub events: Vec<Value>,
    pub next_cursor: Option<String>,
}

/// Persisted change-journal entries, newest first. `id`s are the
/// database's (use `history_changes_get`), not the live journal's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryChangePage {
    pub entries: Vec<crate::change_journal::ChangeSummary>,
    pub next_cursor: Option<u64>,
}

/// Which data `history_clear` removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryKind {
    Audit,
    Events,
    Changes,
    All,
}

/// Rows and time span of one table.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryTableStatus {
    pub rows: u64,
    pub oldest_ts: Option<i64>,
}

/// `history_status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryStatus {
    /// `~/.kubepit/history.db`.
    pub path: String,
    /// Database + write-ahead log on disk.
    pub size_bytes: u64,
    /// The database could be opened (else `error` says why).
    pub available: bool,
    pub error: Option<String>,
    /// This process records (the desktop app; tests and tools do not).
    pub recording: bool,
    pub audit: HistoryTableStatus,
    pub events: HistoryTableStatus,
    pub changes: HistoryTableStatus,
    /// Writes dropped because the writer queue was full.
    pub dropped: u64,
    /// Connected clusters whose events and changes are being persisted now.
    pub persisting: Vec<String>,
}
