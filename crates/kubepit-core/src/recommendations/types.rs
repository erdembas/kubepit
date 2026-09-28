//! Serde mirrors of the recommendation types in `apps/desktop/src/types/index.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::rightsizing::strategy::RecommendationStrategy;
use crate::rightsizing::RightsizingSettings;

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
    /// clusters without blanks; a blank strategy is automatic; every
    /// override normalized (blank ids dropped).
    pub fn normalized(mut self) -> Self {
        self.interval_minutes = self.interval_minutes.clamp(15, 1440);
        self.retention_days = self.retention_days.clamp(1, 90);
        self.scan_clusters.retain(|id| !id.trim().is_empty());
        self.scan_clusters.sort();
        self.scan_clusters.dedup();
        self.strategy = self
            .strategy
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
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
