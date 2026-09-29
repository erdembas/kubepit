//! Recommendations: stored, scheduled right-sizing scans (see
//! `docs/superpowers/specs/2026-09-28-kubefit-recommendations-design.md`).
//!
//! - [`types`]: `Settings.recommendations` (which clusters scan, how often,
//!   retention, the strategy and per-strategy overrides), the effective
//!   settings of a strategy, the scan status, and stored scan runs and
//!   trends (kept in `history.db` by [`crate::history::recommendations`]).
//! - [`scan`]: the scan runner — one collection per cluster at a time, two
//!   overall, stored as a run whose failure keeps the last good result.

pub mod scan;
pub mod types;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;

pub use types::*;

use crate::tasks::TaskRegistry;
use scan::MAX_CONCURRENT_SCANS;

/// Recommendation scan state owned by [`Kubepit`](crate::Kubepit).
pub struct Recommendations {
    /// The last status of every cluster that was asked about or scanned.
    pub(crate) statuses: Mutex<HashMap<String, RecommendationScanStatus>>,
    /// Clusters with a scan in progress (see [`scan::Claim`]).
    pub(crate) running: Arc<Mutex<HashSet<String>>>,
    /// Scans that may collect at the same time (the rest are `queued`).
    pub(crate) semaphore: Arc<tokio::sync::Semaphore>,
    /// When "Scan now" last started a scan, per cluster (epoch ms).
    pub(crate) last_manual: Mutex<HashMap<String, i64>>,
    /// Running manual scans, tagged with their cluster.
    pub(crate) manual: TaskRegistry,
}

impl Default for Recommendations {
    fn default() -> Self {
        Self {
            statuses: Mutex::default(),
            running: Arc::default(),
            semaphore: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_SCANS)),
            last_manual: Mutex::default(),
            manual: TaskRegistry::default(),
        }
    }
}

impl Recommendations {
    /// Whether a scan of `cluster_id` is in progress (its history writes
    /// included).
    pub fn is_running(&self, cluster_id: &str) -> bool {
        self.running.lock().contains(cluster_id)
    }

    /// Mark `cluster_id` busy; `None` when a scan of it is in progress.
    pub(crate) fn claim(&self, cluster_id: &str) -> Option<scan::Claim> {
        scan::Claim::take(&self.running, cluster_id)
    }
}
