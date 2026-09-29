//! Alert contract types: serde mirrors of the `Alert*` types in
//! `apps/desktop/src/types/index.ts`, plus the settings filters.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::fleet_search::glob_match;

/// What went wrong. The strings are Kubernetes vocabulary (or close to it)
/// and are shown verbatim in the UI, like other Kubernetes reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum AlertReason {
    /// A container entered `CrashLoopBackOff`.
    CrashLoopBackOff,
    /// A container terminated with reason `OOMKilled`.
    #[serde(rename = "OOMKilled")]
    OomKilled,
    /// A container is waiting in `ImagePullBackOff` or `ErrImagePull`.
    ImagePullBackOff,
    /// The pod was evicted (`phase: Failed`, `reason: Evicted`).
    Evicted,
    /// A Job got the `Failed` condition.
    JobFailed,
    /// A node's `Ready` condition left `True` (False or Unknown).
    NodeNotReady,
    /// A node reported `MemoryPressure`, `DiskPressure` or `PIDPressure`.
    NodePressure,
    /// A Deployment's `Progressing` condition has `ProgressDeadlineExceeded`.
    ProgressDeadlineExceeded,
    /// A recommendation scan found a new high-confidence saving on a
    /// workload (optional, `Settings.recommendations.alerts`; raised by
    /// `recommendations::scan`, not by a watch).
    RightsizingSaving,
}

impl AlertReason {
    pub const ALL: [AlertReason; 9] = [
        AlertReason::CrashLoopBackOff,
        AlertReason::OomKilled,
        AlertReason::ImagePullBackOff,
        AlertReason::Evicted,
        AlertReason::JobFailed,
        AlertReason::NodeNotReady,
        AlertReason::NodePressure,
        AlertReason::ProgressDeadlineExceeded,
        AlertReason::RightsizingSaving,
    ];

    pub fn severity(self) -> AlertSeverity {
        match self {
            AlertReason::CrashLoopBackOff
            | AlertReason::OomKilled
            | AlertReason::JobFailed
            | AlertReason::NodeNotReady => AlertSeverity::Critical,
            AlertReason::ImagePullBackOff
            | AlertReason::Evicted
            | AlertReason::NodePressure
            | AlertReason::ProgressDeadlineExceeded
            | AlertReason::RightsizingSaving => AlertSeverity::Warning,
        }
    }

    /// The kind whose watch detects this reason (`None`: no watch does).
    pub fn kind(self) -> Option<WatchedKind> {
        match self {
            AlertReason::CrashLoopBackOff
            | AlertReason::OomKilled
            | AlertReason::ImagePullBackOff
            | AlertReason::Evicted => Some(WatchedKind::Pods),
            AlertReason::JobFailed => Some(WatchedKind::Jobs),
            AlertReason::NodeNotReady | AlertReason::NodePressure => Some(WatchedKind::Nodes),
            AlertReason::ProgressDeadlineExceeded => Some(WatchedKind::Deployments),
            AlertReason::RightsizingSaving => None,
        }
    }
}

/// The kinds the alert monitor watches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum WatchedKind {
    Pods,
    Jobs,
    Nodes,
    Deployments,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertSeverity {
    Critical,
    Warning,
}

/// The object an alert is about. `name` is empty for a collapsed burst
/// (see [`Alert::group`]).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AlertObjectRef {
    /// API group; `""` is the core group.
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

/// A burst of the same reason in one namespace, collapsed into one alert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertGroup {
    /// Distinct objects affected so far.
    pub total: u32,
    /// Their names, capped (see `book::GROUP_NAME_LIMIT`).
    pub names: Vec<String>,
}

/// One entry of the notification center.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Alert {
    pub id: String,
    pub cluster_id: String,
    pub severity: AlertSeverity,
    pub reason: AlertReason,
    pub object: AlertObjectRef,
    /// Container the alert is about (pod reasons).
    pub container: Option<String>,
    /// Node condition type (`NodePressure`: `DiskPressure`, …).
    pub condition: Option<String>,
    /// Kubernetes' own words (waiting/condition message, exit code). Never
    /// translated.
    pub message: String,
    /// Epoch milliseconds.
    pub first_seen: i64,
    pub last_seen: i64,
    /// Occurrences merged into this entry (cooldown dedupe, bursts).
    pub count: u32,
    pub read: bool,
    pub group: Option<AlertGroup>,
}

/// Payload core hands to [`EventSink::alert`](crate::EventSink::alert).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlertEvent {
    pub alert: Alert,
    /// A new entry (worth a notification) rather than a merged repeat.
    pub fresh: bool,
}

/// Alert preferences (`Settings.alerts`). Every field has a default so
/// older `settings.json` files keep loading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AlertSettings {
    /// Master switch: watch connected clusters for alerts.
    pub enabled: bool,
    /// Reasons that never raise an alert. Unknown names (from a newer
    /// version) are ignored instead of failing the whole settings file.
    #[serde(deserialize_with = "lenient_reasons")]
    pub disabled_reasons: Vec<AlertReason>,
    /// Namespace globs (`*`, `?`); empty = every namespace. Nodes are
    /// cluster-scoped and ignore namespace filters.
    pub include_namespaces: Vec<String>,
    /// Namespace globs that never alert (applied after `include`).
    pub exclude_namespaces: Vec<String>,
    /// Clusters that are not watched at all.
    pub disabled_clusters: Vec<String>,
    /// Clusters whose alerts are recorded but never notify: id → until
    /// (epoch ms), `null` = until unmuted.
    pub muted_clusters: BTreeMap<String, Option<i64>>,
    /// OS notifications paused until this time (epoch ms).
    pub snoozed_until: Option<i64>,
    /// Post OS notifications for new alerts.
    pub os_notifications: bool,
    /// Only while no Kubepit window is focused.
    pub background_only: bool,
}

impl Default for AlertSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            disabled_reasons: Vec::new(),
            include_namespaces: Vec::new(),
            exclude_namespaces: Vec::new(),
            disabled_clusters: Vec::new(),
            muted_clusters: BTreeMap::new(),
            snoozed_until: None,
            os_notifications: true,
            background_only: true,
        }
    }
}

fn lenient_reasons<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<AlertReason>, D::Error> {
    let raw = Option::<Vec<Value>>::deserialize(d)?.unwrap_or_default();
    let mut out: Vec<AlertReason> = raw
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    out.sort();
    out.dedup();
    Ok(out)
}

fn clean_list(items: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim().to_string();
        if !item.is_empty() && !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    glob_match(&p, &t)
}

impl AlertSettings {
    /// Trimmed, de-duplicated patterns and ids (what `settings_set` stores).
    pub fn normalized(mut self) -> Self {
        self.include_namespaces = clean_list(self.include_namespaces);
        self.exclude_namespaces = clean_list(self.exclude_namespaces);
        self.disabled_clusters = clean_list(self.disabled_clusters);
        self.disabled_reasons.sort();
        self.disabled_reasons.dedup();
        self.muted_clusters.retain(|id, _| !id.trim().is_empty());
        self
    }

    /// Whether `cluster_id` is watched at all.
    pub fn monitors(&self, cluster_id: &str) -> bool {
        self.enabled && !self.disabled_clusters.iter().any(|c| c == cluster_id)
    }

    pub fn reason_enabled(&self, reason: AlertReason) -> bool {
        !self.disabled_reasons.contains(&reason)
    }

    /// Kinds worth watching: those with at least one enabled reason.
    pub fn watched_kinds(&self) -> Vec<WatchedKind> {
        let mut kinds: Vec<WatchedKind> = AlertReason::ALL
            .into_iter()
            .filter(|r| self.reason_enabled(*r))
            .filter_map(AlertReason::kind)
            .collect();
        kinds.sort();
        kinds.dedup();
        kinds
    }

    /// Namespace filters; `None` (cluster-scoped objects) always passes.
    pub fn namespace_allowed(&self, namespace: Option<&str>) -> bool {
        let Some(ns) = namespace else {
            return true;
        };
        let included = self.include_namespaces.is_empty()
            || self.include_namespaces.iter().any(|p| glob(p, ns));
        included && !self.exclude_namespaces.iter().any(|p| glob(p, ns))
    }

    /// Whether a finding of `reason` on an object in `namespace` is recorded.
    pub fn records(&self, reason: AlertReason, namespace: Option<&str>) -> bool {
        self.reason_enabled(reason) && self.namespace_allowed(namespace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reasons_use_the_kubernetes_spelling() {
        assert_eq!(
            serde_json::to_value(AlertReason::OomKilled).unwrap(),
            "OOMKilled"
        );
        assert_eq!(
            serde_json::to_value(AlertReason::CrashLoopBackOff).unwrap(),
            "CrashLoopBackOff"
        );
        assert_eq!(
            serde_json::to_value(AlertSeverity::Critical).unwrap(),
            "critical"
        );
        assert_eq!(
            serde_json::to_value(AlertReason::RightsizingSaving).unwrap(),
            "RightsizingSaving"
        );
    }

    #[test]
    fn scan_reasons_start_no_watch() {
        assert_eq!(AlertReason::RightsizingSaving.kind(), None);
        assert_eq!(
            AlertReason::RightsizingSaving.severity(),
            AlertSeverity::Warning
        );
        let only_savings = AlertSettings {
            disabled_reasons: AlertReason::ALL
                .into_iter()
                .filter(|r| *r != AlertReason::RightsizingSaving)
                .collect(),
            ..Default::default()
        };
        assert!(only_savings.watched_kinds().is_empty());
        assert_eq!(
            AlertSettings::default().watched_kinds(),
            vec![
                WatchedKind::Pods,
                WatchedKind::Jobs,
                WatchedKind::Nodes,
                WatchedKind::Deployments
            ]
        );
    }

    #[test]
    fn settings_default_and_tolerate_unknown_reasons() {
        let s: AlertSettings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(s, AlertSettings::default());
        assert!(s.enabled && s.os_notifications && s.background_only);

        let s: AlertSettings = serde_json::from_value(json!({
            "disabled_reasons": ["JobFailed", "FromTheFuture", "OOMKilled", "JobFailed"],
            "muted_clusters": {"c1": null, "c2": 1700000000000i64}
        }))
        .unwrap();
        assert_eq!(
            s.disabled_reasons,
            vec![AlertReason::OomKilled, AlertReason::JobFailed]
        );
        assert_eq!(s.muted_clusters["c1"], None);
        assert_eq!(s.muted_clusters["c2"], Some(1_700_000_000_000));
    }

    #[test]
    fn cluster_and_reason_filters() {
        let mut s = AlertSettings {
            disabled_clusters: vec!["off".into()],
            disabled_reasons: vec![
                AlertReason::JobFailed,
                AlertReason::ProgressDeadlineExceeded,
            ],
            ..Default::default()
        };
        assert!(s.monitors("on"));
        assert!(!s.monitors("off"));
        assert!(!s.records(AlertReason::JobFailed, Some("shop")));
        assert!(s.records(AlertReason::CrashLoopBackOff, Some("shop")));
        assert_eq!(
            s.watched_kinds(),
            vec![WatchedKind::Pods, WatchedKind::Nodes],
            "no jobs or deployments watch when all their reasons are off"
        );
        s.enabled = false;
        assert!(!s.monitors("on"), "the master switch wins");
    }

    #[test]
    fn namespace_globs_include_then_exclude() {
        let s = AlertSettings {
            include_namespaces: vec!["team-*".into(), "shop".into()],
            exclude_namespaces: vec!["team-sandbox?".into()],
            ..Default::default()
        };
        assert!(s.namespace_allowed(Some("team-a")));
        assert!(s.namespace_allowed(Some("shop")));
        assert!(
            !s.namespace_allowed(Some("shop-2")),
            "globs match whole names"
        );
        assert!(!s.namespace_allowed(Some("kube-system")));
        assert!(!s.namespace_allowed(Some("team-sandbox1")));
        assert!(s.namespace_allowed(Some("team-sandbox12")));
        assert!(s.namespace_allowed(None), "cluster-scoped objects pass");

        let exclude_only = AlertSettings {
            exclude_namespaces: vec!["kube-*".into()],
            ..Default::default()
        };
        assert!(exclude_only.namespace_allowed(Some("default")));
        assert!(!exclude_only.namespace_allowed(Some("kube-system")));
    }

    #[test]
    fn normalizing_trims_and_dedupes() {
        let s = AlertSettings {
            include_namespaces: vec![" shop ".into(), "".into(), "shop".into()],
            exclude_namespaces: vec!["   ".into()],
            disabled_clusters: vec!["c1".into(), "c1".into()],
            muted_clusters: [(" ".to_string(), None), ("c2".to_string(), None)].into(),
            ..Default::default()
        }
        .normalized();
        assert_eq!(s.include_namespaces, vec!["shop"]);
        assert!(s.exclude_namespaces.is_empty());
        assert_eq!(s.disabled_clusters, vec!["c1"]);
        assert_eq!(s.muted_clusters.len(), 1);
    }
}
