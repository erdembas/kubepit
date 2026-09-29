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
//! - The read commands below: the latest scan re-evaluated with the current
//!   strategy and settings, runs, trends, the fleet and exports. They read
//!   `history.db` only (blocking; the IPC edge runs them on the blocking
//!   pool) and never touch a cluster.

pub mod scan;
pub mod schedule;
pub mod types;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Weak};

use anyhow::{anyhow, Result};
use parking_lot::Mutex;

pub use types::*;

use crate::app::Kubepit;
use crate::history::recommendations::{self as rec, StoredScan};
use crate::rightsizing::export::{export_json, export_yaml};
use crate::rightsizing::strategy::{self, RecommendationStrategy};
use crate::rightsizing::{reevaluate, EvidenceIdentity, RightsizingReport, WorkloadRef};
use crate::tasks::TaskRegistry;
use scan::{source_config, MAX_CONCURRENT_SCANS};

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

/// Whether the pods behind `report` were resolved through owner metrics
/// (any container evidence that is not a name match).
fn owner_metrics(report: &RightsizingReport) -> bool {
    report
        .workloads
        .iter()
        .flat_map(|w| &w.containers)
        .filter_map(|c| c.evidence.as_ref())
        .any(|e| e.identity != EvidenceIdentity::NameMatch)
}

/// The strategy a stored `report` is shown with now: the saved one, else
/// automatic — the scan's own automatic choice (made from its owner
/// metrics), else resolved from its evidence.
fn current_strategy(
    saved: &RecommendationSettings,
    report: &RightsizingReport,
) -> Result<(&'static dyn RecommendationStrategy, bool)> {
    if let Some(id) = saved.saved_strategy() {
        return Ok((strategy::strategy(Some(id))?, false));
    }
    if report.strategy_auto {
        if let Ok(chosen) = strategy::strategy(Some(&report.strategy)) {
            return Ok((chosen, true));
        }
    }
    strategy::resolve(None, owner_metrics(report))
}

impl Kubepit {
    /// `stored` with the current strategy and effective settings (see
    /// [`RecommendationScanView`]); the scan's pricing stays.
    fn scan_view(&self, stored: StoredScan) -> Result<RecommendationScanView> {
        let saved = self.settings().recommendations;
        let (strategy, auto) = current_strategy(&saved, &stored.report)?;
        let settings = effective_settings(&saved, strategy);
        let reevaluated =
            strategy.info().id != stored.report.strategy || settings != stored.settings;
        let days_changed = settings.days != stored.settings.days;
        let report = if reevaluated {
            reevaluate(
                &stored.report,
                strategy,
                auto,
                &settings,
                &stored.report.pricing,
            )
        } else {
            // Same numbers; only whether the choice is automatic may differ.
            RightsizingReport {
                strategy_auto: auto,
                ..stored.report
            }
        };
        Ok(RecommendationScanView {
            run: stored.run,
            report,
            reevaluated,
            days_changed,
        })
    }

    /// `recommendations_latest`: the latest successful scan of `cluster_id`
    /// (or its successful run `run_id`), re-evaluated with the current
    /// strategy and settings. A latest scan of another Prometheus
    /// configuration is hidden (`source_changed`).
    pub fn recommendations_latest(
        &self,
        cluster_id: &str,
        run_id: Option<i64>,
    ) -> Result<RecommendationLatest> {
        let config = source_config(&self.cluster_def(cluster_id)?);
        let (latest, picked) = self.history.rec_read(|conn| {
            let latest = rec::latest(conn, cluster_id, &config)?;
            let picked = match run_id {
                Some(id) => Some(
                    rec::scan(conn, cluster_id, id)?
                        .ok_or_else(|| anyhow!("scan {id} is no longer stored"))?,
                ),
                None => None,
            };
            Ok((latest, picked))
        })?;
        Ok(RecommendationLatest {
            scan: picked
                .or(latest.scan)
                .map(|stored| self.scan_view(stored))
                .transpose()?,
            source_changed: latest.source_changed,
            last_failure: latest.last_failure,
        })
    }

    /// `recommendations_runs`: the stored runs of `cluster_id`, newest
    /// first (1 to 500).
    pub fn recommendations_runs(
        &self,
        cluster_id: &str,
        limit: u32,
    ) -> Result<Vec<RecommendationRun>> {
        self.history
            .rec_read(|conn| rec::runs(conn, cluster_id, limit))
    }

    /// `recommendations_trend`: `workload` in every successful run of
    /// `cluster_id` whose rows are kept, oldest first.
    pub fn recommendations_trend(
        &self,
        cluster_id: &str,
        workload: &WorkloadRef,
    ) -> Result<Vec<RecommendationTrendPoint>> {
        let key = rec::row_key(&workload.kind, &workload.namespace, &workload.name);
        self.history
            .rec_read(|conn| rec::trend(conn, cluster_id, &key))
    }

    /// `recommendations_fleet`: every registered cluster with its latest
    /// successful run and the newest failure after it (stored data only,
    /// no cluster access).
    pub fn recommendations_fleet(&self) -> Result<Vec<ClusterRecommendationSummary>> {
        let (stored, failures) = self
            .history
            .rec_read(|conn| Ok((rec::fleet(conn)?, rec::fleet_failures(conn)?)))?;
        let stored: HashMap<String, (RecommendationRun, String)> = stored
            .into_iter()
            .map(|(cluster_id, run, config)| (cluster_id, (run, config)))
            .collect();
        let mut failures: HashMap<String, RecommendationRun> = failures
            .into_iter()
            .map(|run| (run.cluster_id.clone(), run))
            .collect();
        let scheduled: HashSet<String> = self
            .recommendations
            .schedules
            .lock()
            .keys()
            .cloned()
            .collect();
        Ok(self
            .store
            .clusters()
            .iter()
            .map(|cluster| {
                let entry = stored.get(&cluster.id);
                ClusterRecommendationSummary {
                    cluster_id: cluster.id.clone(),
                    scheduled: scheduled.contains(&cluster.id),
                    source_changed: entry
                        .is_some_and(|(_, config)| *config != source_config(cluster)),
                    run: entry.map(|(run, _)| run.clone()),
                    last_failure: failures.remove(&cluster.id),
                }
            })
            .collect())
    }

    /// `recommendations_export`: the selected workloads (`workloads` empty
    /// = every one) of the latest scan (or run `run_id`), re-evaluated, as
    /// JSON or YAML fragments. No connection metadata (see
    /// [`crate::rightsizing::export`]).
    pub fn recommendations_export(
        &self,
        cluster_id: &str,
        run_id: Option<i64>,
        workloads: &[WorkloadRef],
        format: RecommendationExportFormat,
    ) -> Result<String> {
        let cluster = self.cluster_def(cluster_id)?;
        let latest = self.recommendations_latest(cluster_id, run_id)?;
        let Some(scan) = latest.scan else {
            return Err(anyhow!(if latest.source_changed {
                "the last scan used another Prometheus configuration; scan again to export"
            } else {
                "there is no scan to export yet"
            }));
        };
        match format {
            RecommendationExportFormat::Json => export_json(
                &scan.report,
                &cluster.name,
                scan.report.computed_at,
                workloads,
            ),
            RecommendationExportFormat::Yaml => Ok(export_yaml(&scan.report, workloads)),
        }
    }
}
