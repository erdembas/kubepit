//! Serde mirrors of the change-timeline section of
//! `apps/desktop/src/types/index.ts` (`ChangeSummary`, `ChangeFilter`, …).
//!
//! They live next to the journal instead of in `types.rs` so the feature
//! stays in its own module; the field names are the snake_case names of the
//! TypeScript contract all the same.

use serde::{Deserialize, Serialize};

use crate::types::Gvk;

/// What happened to the object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeOp {
    Added,
    Modified,
    Deleted,
}

/// Who made the change: the most recent `managedFields` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeActor {
    /// Field manager: `kubectl-client-side-apply`, `helm`, `argocd-controller`, …
    pub manager: String,
    /// `Apply` (server-side apply) or `Update`.
    pub operation: Option<String>,
    /// Subresource the manager wrote through (`scale`), when any.
    pub subresource: Option<String>,
}

/// One changed field. `before` / `after` are short renderings of the old and
/// new value; `None` means the field was absent on that side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedPath {
    /// `spec.replicas`, `spec.template.spec.containers[api].image`,
    /// `metadata.labels["app.kubernetes.io/version"]`.
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    /// Secret data: `before` / `after` only hold salted hash markers, never
    /// values, so the UI says "changed" instead of showing them.
    pub redacted: bool,
}

/// One journal entry without its object bodies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeSummary {
    /// Monotonic per cluster journal; newer entries have larger ids.
    pub id: u64,
    /// Epoch ms when Kubepit observed the change.
    pub ts: i64,
    pub cluster_id: String,
    pub gvk: Gvk,
    pub namespace: Option<String>,
    pub name: String,
    pub uid: String,
    pub op: ChangeOp,
    pub actor: Option<ChangeActor>,
    /// The first changed fields (modifications only), in document order.
    pub paths: Vec<ChangedPath>,
    /// Number of changed fields, including the ones left out of `paths`.
    pub path_count: u32,
    /// Long values were shortened (or the bodies dropped) to fit the
    /// per-entry size cap.
    pub truncated: bool,
}

fn default_limit() -> u32 {
    200
}

/// `changes_list` filter. Every field is optional; empty lists match all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeFilter {
    /// Namespaces to include. Cluster-scoped objects are left out when set,
    /// except the Namespace objects named here.
    #[serde(default)]
    pub namespaces: Vec<String>,
    /// Kind names (`Deployment`, `ConfigMap`).
    #[serde(default)]
    pub kinds: Vec<String>,
    /// Exact object name.
    #[serde(default)]
    pub name: Option<String>,
    /// Case-insensitive substring over kind, namespace, name, actor and
    /// changed paths.
    #[serde(default)]
    pub text: Option<String>,
    /// Epoch ms, inclusive.
    #[serde(default)]
    pub since: Option<i64>,
    /// Epoch ms, inclusive.
    #[serde(default)]
    pub until: Option<i64>,
    #[serde(default = "default_limit")]
    pub limit: u32,
    /// `next_cursor` of the previous page: return entries older than it.
    #[serde(default)]
    pub cursor: Option<u64>,
}

impl Default for ChangeFilter {
    fn default() -> Self {
        Self {
            namespaces: Vec::new(),
            kinds: Vec::new(),
            name: None,
            text: None,
            since: None,
            until: None,
            limit: default_limit(),
            cursor: None,
        }
    }
}

/// Recording state of one journaled kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKindState {
    /// Listing the baseline.
    Syncing,
    /// Baseline done, recording changes.
    Watching,
    /// The user may not list it (not even in the configured namespaces).
    Forbidden,
    /// The cluster does not serve this API version.
    NotServed,
    /// The watch is failing and retrying.
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeKindStatus {
    pub kind: String,
    pub state: ChangeKindState,
    pub message: Option<String>,
}

/// Whether and how the journal of a cluster records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeJournalStatus {
    /// The settings allow recording this cluster.
    pub enabled: bool,
    /// A journal exists (the cluster is connected and recording).
    pub recording: bool,
    /// Epoch ms when recording started (changes before it are unknown).
    pub started_at: Option<i64>,
    /// Every watchable kind finished its baseline list.
    pub synced: bool,
    pub kinds: Vec<ChangeKindStatus>,
    /// Entries currently kept.
    pub entries: u32,
    /// Entries dropped by the age, count or memory bounds.
    pub evicted: u64,
    pub oldest_ts: Option<i64>,
}

impl ChangeJournalStatus {
    pub fn idle(enabled: bool) -> Self {
        Self {
            enabled,
            recording: false,
            started_at: None,
            synced: false,
            kinds: Vec::new(),
            entries: 0,
            evicted: 0,
            oldest_ts: None,
        }
    }
}

/// One page of `changes_list`, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangePage {
    pub entries: Vec<ChangeSummary>,
    /// Pass as `cursor` to continue with older entries.
    pub next_cursor: Option<u64>,
    pub status: ChangeJournalStatus,
}

/// `changes_get`: an entry with its normalized objects as YAML.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeDetail {
    pub summary: ChangeSummary,
    /// `None` for additions (and when `omitted`).
    pub before_yaml: Option<String>,
    /// `None` for deletions (and when `omitted`).
    pub after_yaml: Option<String>,
    /// The objects were too large for the per-entry cap and were not kept;
    /// only the changed paths are known.
    pub omitted: bool,
}
