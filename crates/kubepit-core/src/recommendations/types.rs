//! Serde mirrors of the recommendation types in `apps/desktop/src/types/index.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::rightsizing::collect::ScanProgress;
use crate::rightsizing::strategy::{RecommendationStrategy, STRATEGIES};
use crate::rightsizing::summary::RecommendationSummary;
use crate::rightsizing::{
    Confidence, RightsizingReport, RightsizingSettings, RightsizingSource, Verdict,
};

/// Default minutes between background scans.
pub const DEFAULT_INTERVAL_MINUTES: u32 = 60;
/// Default days scan runs are kept.
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

/// `Settings.recommendations`: background scans and recommendation
/// settings. The backend owns them so background scans use the same
/// settings as the UI. Every field has a default, so settings saved by an
/// older build keep loading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RecommendationSettings {
    /// Clusters scanned in the background while connected (opt-in per cluster).
    pub scan_clusters: Vec<String>,
    /// Minutes between background scans (15–1440).
    pub interval_minutes: u32,
    /// Days scan runs are kept (1–90).
    pub retention_days: u32,
    /// Strategy id; `None` = chosen automatically.
    pub strategy: Option<String>,
    /// Settings per strategy id; a strategy without one uses its defaults.
    pub overrides: BTreeMap<String, RightsizingSettings>,
    /// Alert on new high-confidence savings (optional, off by default).
    pub alerts: bool,
}

impl Default for RecommendationSettings {
    fn default() -> Self {
        Self {
            scan_clusters: Vec::new(),
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
            retention_days: DEFAULT_RETENTION_DAYS,
            strategy: None,
            overrides: BTreeMap::new(),
            alerts: false,
        }
    }
}

impl RecommendationSettings {
    /// Clamp out-of-range values instead of persisting them: the interval
    /// to 15–1440 minutes, the retention to 1–90 days; sorted, deduplicated
    /// clusters without blanks; a blank or unknown strategy is automatic;
    /// every override normalized (blank ids dropped).
    pub fn normalized(mut self) -> Self {
        self.interval_minutes = self.interval_minutes.clamp(15, 1440);
        self.retention_days = self.retention_days.clamp(1, 90);
        self.scan_clusters.retain(|id| !id.trim().is_empty());
        self.scan_clusters.sort();
        self.scan_clusters.dedup();
        self.strategy = self
            .strategy
            .map(|s| s.trim().to_string())
            .filter(|s| is_known_strategy(s));
        self.overrides = self
            .overrides
            .into_iter()
            .filter_map(|(id, settings)| {
                let id = id.trim().to_string();
                (!id.is_empty()).then(|| (id, settings.normalized()))
            })
            .collect();
        self
    }

    /// Whether `cluster_id` opted in to background scans.
    pub fn scans(&self, cluster_id: &str) -> bool {
        self.scan_clusters.iter().any(|id| id == cluster_id)
    }

    /// The saved strategy id when this build offers it; `None` (automatic)
    /// for a blank or unknown one — settings files are not normalized on
    /// load, so an id from a newer build or a hand edit must not make every
    /// report fail.
    pub fn saved_strategy(&self) -> Option<&str> {
        self.strategy
            .as_deref()
            .map(str::trim)
            .filter(|s| is_known_strategy(s))
    }
}

/// Whether `id` names a strategy this build offers.
fn is_known_strategy(id: &str) -> bool {
    STRATEGIES.iter().any(|s| s.info().id == id)
}

/// The settings `strategy` runs with: its override, else its own
/// defaults, normalized.
pub fn effective_settings(
    rec: &RecommendationSettings,
    strategy: &dyn RecommendationStrategy,
) -> RightsizingSettings {
    let info = strategy.info();
    rec.overrides
        .get(&info.id)
        .cloned()
        .unwrap_or(info.defaults)
        .normalized()
}

/// Where a stored scan run stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Success,
    Failed,
    /// Stopped (disconnect, removal, opt-out) or cut short by an app restart.
    Interrupted,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::Running,
            Self::Success,
            Self::Failed,
            Self::Interrupted,
        ]
        .into_iter()
        .find(|s| s.as_str() == text)
    }
}

/// What started a scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanTrigger {
    /// "Scan now".
    Manual,
    /// The background scheduler.
    Schedule,
}

impl ScanTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Schedule => "schedule",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [Self::Manual, Self::Schedule]
            .into_iter()
            .find(|t| t.as_str() == text)
    }
}

/// Where a cluster's scan stands (spec §12): `idle` until a scan is due or
/// "Scan now" is pressed, `queued` while it waits for one of the
/// [`MAX_CONCURRENT_SCANS`](super::scan::MAX_CONCURRENT_SCANS) slots,
/// `running` while it collects, then how the last scan ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanState {
    Idle,
    Queued,
    Running,
    Success,
    Failed,
    /// Stopped (disconnect, removal, opt-out, shutdown) before it finished.
    Interrupted,
}

/// `recommendations_status` and the `recommendations://scan` event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecommendationScanStatus {
    pub cluster_id: String,
    /// A background scheduler runs for the cluster (opted in and connected).
    pub scheduled: bool,
    /// Minutes between background scans.
    pub interval_minutes: u32,
    pub state: ScanState,
    /// The stored run of the current or last scan (none while queued).
    pub run_id: Option<i64>,
    pub trigger: Option<ScanTrigger>,
    /// While running: answered queries against planned ones (the total
    /// grows when a batch splits or the window is collected again); `None`
    /// once the scan ended.
    pub progress: Option<ScanProgress>,
    /// Epoch ms.
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    /// Why the last scan failed or stopped: a message or a code
    /// (`stopped`, `app-restarted`, `no-usage-source`, `timed-out`,
    /// `cluster-label-mismatch`, `cluster-label-unverified`).
    pub error: Option<String>,
    /// When the latest successful scan finished.
    pub last_success_at: Option<i64>,
    /// When the scheduler runs the next scan.
    pub next_at: Option<i64>,
    /// "Scan now" is refused before this (epoch ms; `None` before the first
    /// manual scan).
    pub manual_available_at: Option<i64>,
}

impl RecommendationScanStatus {
    /// A cluster nothing is known about yet.
    pub fn idle(cluster_id: &str, interval_minutes: u32) -> Self {
        Self {
            cluster_id: cluster_id.to_string(),
            scheduled: false,
            interval_minutes,
            state: ScanState::Idle,
            run_id: None,
            trigger: None,
            progress: None,
            started_at: None,
            finished_at: None,
            error: None,
            last_success_at: None,
            next_at: None,
            manual_available_at: None,
        }
    }
}

/// One stored scan run (successful or not), without its rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecommendationRun {
    pub id: i64,
    pub cluster_id: String,
    /// Epoch ms.
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: RunStatus,
    pub trigger: ScanTrigger,
    /// A message or a code (`app-restarted`, `stopped`, `no-usage-source`).
    pub error: Option<String>,
    /// Successful runs only.
    pub source: Option<RightsizingSource>,
    pub strategy: Option<String>,
    pub window_secs: Option<u64>,
    pub workloads: u32,
    /// The run's rows are still stored (thinning keeps the run and its summary).
    pub rows_kept: bool,
    /// Successful runs only (`None` for runs of older builds too).
    pub summary: Option<RecommendationSummary>,
}

/// A stored successful scan as `recommendations_latest` shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecommendationScanView {
    pub run: RecommendationRun,
    /// Re-evaluated with the current strategy and settings when they
    /// differ from the stored ones (`reevaluated`); the window, the notes
    /// and `computed_at` are the scan's.
    pub report: RightsizingReport,
    /// The current strategy or settings differ from the stored ones.
    pub reevaluated: bool,
    /// The current `days` differ from the window the scan collected (the
    /// next scan collects the new one).
    pub days_changed: bool,
}

/// `recommendations_latest`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecommendationLatest {
    /// The latest successful scan (or the requested run), unless the
    /// latest used another Prometheus configuration.
    pub scan: Option<RecommendationScanView>,
    /// The latest scan used another Prometheus configuration (hidden).
    pub source_changed: bool,
    /// The newest failed or interrupted run after the latest success.
    pub last_failure: Option<RecommendationRun>,
}

/// One registered cluster in `recommendations_fleet` (no cluster access).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClusterRecommendationSummary {
    pub cluster_id: String,
    /// A background scheduler runs for it.
    pub scheduled: bool,
    /// Its latest scan used another Prometheus configuration.
    pub source_changed: bool,
    /// Its latest successful run (with the summary), if any.
    pub run: Option<RecommendationRun>,
    /// The newest failed or interrupted run after that one (or of a
    /// cluster that never had a successful scan).
    pub last_failure: Option<RecommendationRun>,
}

/// `recommendations_export` formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecommendationExportFormat {
    Json,
    Yaml,
}

/// One container of a [`RecommendationTrendPoint`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecommendationTrendContainer {
    pub name: String,
    pub cpu_request: Option<f64>,
    pub cpu_recommended: Option<f64>,
    pub memory_request: Option<f64>,
    pub memory_recommended: Option<f64>,
    pub cpu_p95: Option<f64>,
    pub memory_max: Option<f64>,
}

/// A workload in one stored run whose rows are kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecommendationTrendPoint {
    pub run_id: i64,
    /// When the run started (epoch ms).
    pub at: i64,
    pub verdict: Verdict,
    pub confidence: Confidence,
    pub monthly_delta: f64,
    pub containers: Vec<RecommendationTrendContainer>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rightsizing::percentile::PercentileHeadroom;
    use crate::rightsizing::workload_history::WorkloadHistory;
    use crate::rightsizing::RightsizingSettings;

    #[test]
    fn recommendation_settings_default_and_normalize() {
        let d = RecommendationSettings::default();
        assert_eq!(
            (d.interval_minutes, d.retention_days, d.alerts),
            (60, 30, false)
        );
        assert!(d.scan_clusters.is_empty() && d.strategy.is_none() && d.overrides.is_empty());
        let n = RecommendationSettings {
            interval_minutes: 5,
            retention_days: 400,
            strategy: Some(" ".into()),
            scan_clusters: vec!["b".into(), " ".into(), "a".into(), "b".into()],
            ..d.clone()
        }
        .normalized();
        assert_eq!(
            (n.interval_minutes, n.retention_days, n.strategy.clone()),
            (15, 90, None)
        );
        assert_eq!(n.scan_clusters, vec!["a", "b"]);
        assert!(n.scans("a") && !n.scans("c"));
        let upper = RecommendationSettings {
            interval_minutes: 10_000,
            retention_days: 0,
            strategy: Some(" workload-history ".into()),
            overrides: [(
                "workload-history".into(),
                RightsizingSettings {
                    days: 99,
                    ..WorkloadHistory::defaults()
                },
            )]
            .into(),
            ..d
        }
        .normalized();
        assert_eq!((upper.interval_minutes, upper.retention_days), (1440, 1));
        assert_eq!(upper.strategy.as_deref(), Some("workload-history"));
        assert_eq!(
            upper.overrides["workload-history"].days, 30,
            "overrides normalize"
        );
        // Settings saved before this field existed still load.
        let old: crate::types::Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(old.recommendations, RecommendationSettings::default());
    }

    #[test]
    fn run_status_and_trigger_round_trip_their_wire_names() {
        for status in [
            RunStatus::Running,
            RunStatus::Success,
            RunStatus::Failed,
            RunStatus::Interrupted,
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), status.as_str());
            assert_eq!(RunStatus::parse(status.as_str()), Some(status));
        }
        for trigger in [ScanTrigger::Manual, ScanTrigger::Schedule] {
            assert_eq!(serde_json::to_value(trigger).unwrap(), trigger.as_str());
            assert_eq!(ScanTrigger::parse(trigger.as_str()), Some(trigger));
        }
        assert_eq!(RunStatus::parse("paused"), None);
    }

    #[test]
    fn unknown_saved_strategies_fall_back_to_automatic() {
        // A strategy id this build does not know (a downgrade, a hand-edited
        // settings.json) must not make every report fail.
        let gone = RecommendationSettings {
            strategy: Some("gone-strategy".into()),
            ..RecommendationSettings::default()
        };
        assert_eq!(gone.saved_strategy(), None, "never normalized: ignored");
        assert_eq!(gone.normalized().strategy, None, "dropped when saved");
        let known = RecommendationSettings {
            strategy: Some("workload-history".into()),
            ..RecommendationSettings::default()
        };
        assert_eq!(known.saved_strategy(), Some("workload-history"));
        assert_eq!(
            known.normalized().strategy.as_deref(),
            Some("workload-history")
        );
    }

    #[test]
    fn effective_settings_prefer_overrides_then_strategy_defaults() {
        let d = RecommendationSettings::default();
        assert_eq!(
            effective_settings(&d, &WorkloadHistory).cpu_headroom_percent,
            20.0
        );
        let o = RecommendationSettings {
            overrides: [(
                "workload-history".into(),
                RightsizingSettings {
                    cpu_headroom_percent: 35.0,
                    ..WorkloadHistory::defaults()
                },
            )]
            .into(),
            ..d
        };
        assert_eq!(
            effective_settings(&o, &WorkloadHistory).cpu_headroom_percent,
            35.0
        );
        assert_eq!(
            effective_settings(&o, &PercentileHeadroom).cpu_headroom_percent,
            15.0,
            "an unrelated override is ignored"
        );
    }
}
