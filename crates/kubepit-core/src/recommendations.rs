//! Recommendations: stored, scheduled right-sizing scans (see
//! `docs/superpowers/specs/2026-09-28-kubefit-recommendations-design.md`).
//!
//! - [`types`]: `Settings.recommendations` (which clusters scan, how often,
//!   retention, the strategy and per-strategy overrides), the effective
//!   settings of a strategy, the scan status, and stored scan runs and
//!   trends (kept in `history.db` by [`crate::history::recommendations`]).
//! - [`scan`]: the scan runner — one collection per cluster at a time, two
//!   overall, stored as a run whose failure keeps the last good result.
//! - [`schedule`]: background scans of connected, opted-in clusters in a
//!   process that turned them on.

pub mod scan;
pub mod schedule;
pub mod types;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Weak};

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
    /// Scheduler loops (and the scans they run), tagged with their cluster.
    pub(crate) scheduled: TaskRegistry,
    /// The state of every running scheduler.
    pub(crate) schedules: Mutex<HashMap<String, schedule::Schedule>>,
    /// Background scans are opt-in per process
    /// ([`Kubepit::set_recommendation_scans`](crate::Kubepit::set_recommendation_scans)).
    pub(crate) active: AtomicBool,
    /// The app, for the scheduler loops (set with the process switch).
    pub(crate) app: Mutex<Option<Weak<crate::Kubepit>>>,
}

impl Default for Recommendations {
    fn default() -> Self {
        Self {
            statuses: Mutex::default(),
            running: Arc::default(),
            semaphore: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_SCANS)),
            last_manual: Mutex::default(),
            manual: TaskRegistry::default(),
            scheduled: TaskRegistry::default(),
            schedules: Mutex::default(),
            active: AtomicBool::new(false),
            app: Mutex::new(None),
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
