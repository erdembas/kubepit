//! The scan runner (spec §12): one strategy-free collection of every
//! workload the user can read, stored as a run in `history.db`.
//!
//! - **One scan per cluster, two overall.** A [`Claim`] marks the cluster
//!   busy from "Scan now" (or the scheduler's due time) until the scan and
//!   the history writes it handed off are over; a semaphore of
//!   [`MAX_CONCURRENT_SCANS`] keeps the rest `queued`.
//! - **Stored as it runs.** `rec_begin` inserts a `running` run, the
//!   collection runs (`compute_rightsizing` with the effective settings,
//!   under [`SCAN_TIMEOUT`]), and `rec_finish` records how it ended. Only a
//!   success moves the latest pointer, so a failure keeps the last good
//!   result. Any `source_abort` fails the run, typed and never parsed from
//!   notes — the metrics-server fallback in its report is never stored —
//!   and so does a report without a usage source (`no-usage-source`).
//! - **Stopping.** A scan is cancelled only by dropping its future (a
//!   disconnect, removal or shutdown aborts its task; the timeout drops the
//!   collection), which is safe because a collection has no side effects.
//!   The [`RunGuard`] then finishes the run as interrupted (`stopped`)
//!   without blocking. It is disarmed the moment the real outcome is handed
//!   to the writer, whether or not storing it then succeeds: the writer
//!   applies the first finish of a run, and a detached stop could otherwise
//!   overtake a success whose queueing timed out.
//! - **Status.** `recommendations://scan` carries the status at every state
//!   change and at most every 250 ms while the progress moves. Every scan
//!   ends with one terminal status (`success`, `failed` or `interrupted`,
//!   without progress), emitted after its last progress.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use serde::Serialize;

use super::types::{RecommendationRun, RecommendationScanStatus, ScanState, ScanTrigger};
use crate::app::Kubepit;
use crate::history::recommendations::{
    self as rec, LatestRead, ScanBegin, ScanOutcome, ERROR_STOPPED,
};
use crate::objects::now_millis;
use crate::prometheus::access::PrometheusAccess;
use crate::prometheus::matchers::CLUSTER_LABEL_MISMATCH;
use crate::rightsizing::collect::{RightsizingOutcome, ScanProgress, SourceAbort, SourceAbortKind};
use crate::rightsizing::summary::summarize;
use crate::rightsizing::{RightsizingRequest, RightsizingSource};
use crate::types::{ClusterDef, PrometheusConfig};

/// "Scan now" is refused this long after the last manual scan started.
pub const MANUAL_COOLDOWN_MS: i64 = 60_000;
/// Scans collecting at the same time (every cluster together).
pub const MAX_CONCURRENT_SCANS: usize = 2;
/// A collection still running after this fails as `timed-out`.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Progress statuses are emitted at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// Error of a scan whose report had no usage source at all.
pub const ERROR_NO_USAGE_SOURCE: &str = "no-usage-source";
/// Error of a scan that ran into [`SCAN_TIMEOUT`].
pub const ERROR_TIMED_OUT: &str = "timed-out";

/// What [`source_config`] serializes, in this order.
#[derive(Serialize)]
struct SourceConfig<'a> {
    prometheus: &'a PrometheusConfig,
    access: &'a PrometheusAccess,
}

/// The Prometheus configuration a scan used: canonical JSON of the source
/// (`ClusterDef.prometheus`: mode, service, port, scheme, path prefix) and
/// its access settings (tenant, cluster labels, the auth Secret
/// *reference* — never a value — and TLS). Stored with every run and
/// compared verbatim by [`rec::latest`] (`source_changed`); built here
/// only, and never exported.
pub fn source_config(cluster: &ClusterDef) -> String {
    serde_json::to_string(&SourceConfig {
        prometheus: &cluster.prometheus,
        access: &cluster.prometheus_access,
    })
    .expect("plain data serializes")
}

/// A cluster marked busy with a scan, free again when the last holder
/// drops it: the scan task and the history closures it hands work to (so
/// a removal can wait until nothing will write a run of the cluster).
pub(crate) struct Claim {
    running: Arc<Mutex<HashSet<String>>>,
    cluster_id: String,
}

impl Claim {
    pub(crate) fn take(running: &Arc<Mutex<HashSet<String>>>, cluster_id: &str) -> Option<Self> {
        running.lock().insert(cluster_id.to_string()).then(|| Self {
            running: running.clone(),
            cluster_id: cluster_id.to_string(),
        })
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.running.lock().remove(&self.cluster_id);
    }
}

/// Where the run of a scan stands, shared by the scan and its begin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunSlot {
    /// The begin has not answered yet.
    Waiting,
    Begun(i64),
    /// The scan was dropped.
    Abandoned,
    /// The outcome went to the writer.
    HandedOver,
}

/// Finishes the run of a dropped scan as interrupted (`stopped`) without
/// blocking, unless its outcome was handed over (see the module docs).
pub(crate) struct RunGuard {
    slot: Arc<Mutex<RunSlot>>,
    stop: Option<Box<dyn FnOnce(i64) + Send + Sync>>,
}

impl RunGuard {
    fn new(stop: impl FnOnce(i64) + Send + Sync + 'static) -> Self {
        Self {
            slot: Arc::new(Mutex::new(RunSlot::Waiting)),
            stop: Some(Box::new(stop)),
        }
    }

    /// For the begin, which may outlive the scan.
    fn slot(&self) -> Arc<Mutex<RunSlot>> {
        self.slot.clone()
    }

    /// Record the begun run. False when the scan was dropped meanwhile: the
    /// caller then finishes the run itself.
    fn begun(slot: &Mutex<RunSlot>, run_id: i64) -> bool {
        let mut slot = slot.lock();
        if *slot == RunSlot::Waiting {
            *slot = RunSlot::Begun(run_id);
            true
        } else {
            false
        }
    }

    /// Disarm, then hand the outcome to the writer (`finish`). The guard
    /// never finishes the run from here on, even when storing fails or
    /// the scan is dropped before `finish`'s result arrives.
    fn hand_over<R>(&self, finish: impl FnOnce() -> R) -> R {
        *self.slot.lock() = RunSlot::HandedOver;
        finish()
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let begun = {
            let mut slot = self.slot.lock();
            match *slot {
                RunSlot::Begun(run_id) => {
                    *slot = RunSlot::Abandoned;
                    Some(run_id)
                }
                RunSlot::Waiting => {
                    *slot = RunSlot::Abandoned;
                    None
                }
                RunSlot::Abandoned | RunSlot::HandedOver => None,
            }
        };
        if let (Some(run_id), Some(stop)) = (begun, self.stop.take()) {
            stop(run_id);
        }
    }
}

/// The error a failed collection stores: the typed abort's detail
/// (`cluster-label-mismatch` for a label mismatch).
fn abort_error(abort: &SourceAbort) -> String {
    match abort.kind {
        SourceAbortKind::LabelMismatch => CLUSTER_LABEL_MISMATCH.to_string(),
        SourceAbortKind::Proxy | SourceAbortKind::Tunnel | SourceAbortKind::AllBatchesFailed => {
            abort.detail.clone()
        }
    }
}

/// How a collection ends as a stored run (`None`: it timed out): any
/// source abort fails it, although the report then holds a fallback; a
/// report without a usage source fails as `no-usage-source`.
pub(crate) fn scan_outcome(result: Option<Result<RightsizingOutcome>>) -> ScanOutcome {
    match result {
        None => ScanOutcome::Failed(ERROR_TIMED_OUT.into()),
        Some(Err(e)) => ScanOutcome::Failed(format!("{e:#}")),
        Some(Ok(RightsizingOutcome {
            source_abort: Some(abort),
            ..
        })) => ScanOutcome::Failed(abort_error(&abort)),
        Some(Ok(RightsizingOutcome { report, .. })) if report.source == RightsizingSource::None => {
            ScanOutcome::Failed(ERROR_NO_USAGE_SOURCE.into())
        }
        Some(Ok(RightsizingOutcome { report, .. })) => ScanOutcome::Success {
            summary: summarize(&report),
            settings: report.settings.clone(),
            report,
        },
    }
}

fn queued(s: &mut RecommendationScanStatus, trigger: ScanTrigger) {
    s.state = ScanState::Queued;
    s.trigger = Some(trigger);
    s.run_id = None;
    s.progress = None;
    s.started_at = None;
    s.finished_at = None;
    s.error = None;
}

/// Unique task ids (a finished task's entry must never shadow a new one).
static TASK_SEQ: AtomicU64 = AtomicU64::new(0);

fn manual_task_id(cluster_id: &str) -> String {
    format!(
        "rec-manual:{cluster_id}:{}",
        TASK_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

impl Kubepit {
    /// The status of `cluster_id`, created on first use from the settings
    /// and the stored latest run (blocking: may read `history.db`).
    pub(crate) fn scan_status_entry(&self, cluster_id: &str) -> RecommendationScanStatus {
        let interval = self.scan_interval_minutes();
        if let Some(status) = self.recommendations.statuses.lock().get_mut(cluster_id) {
            status.interval_minutes = interval;
            return status.clone();
        }
        let last_success_at = self
            .history
            .rec_read(|conn| rec::latest_run(conn, cluster_id))
            .ok()
            .flatten()
            .and_then(|run| run.finished_at);
        self.recommendations
            .statuses
            .lock()
            .entry(cluster_id.to_string())
            .or_insert_with(|| RecommendationScanStatus {
                last_success_at,
                ..RecommendationScanStatus::idle(cluster_id, interval)
            })
            .clone()
    }

    /// Minutes between background scans (settings files are not normalized
    /// on load: clamped like `normalized`).
    pub(crate) fn scan_interval_minutes(&self) -> u32 {
        self.settings()
            .recommendations
            .interval_minutes
            .clamp(15, 1440)
    }

    /// Change the status of `cluster_id` and emit it (under the status
    /// lock, so emitted statuses keep the order of their changes).
    pub(crate) fn update_scan_status(
        &self,
        cluster_id: &str,
        change: impl FnOnce(&mut RecommendationScanStatus),
    ) -> RecommendationScanStatus {
        let interval = self.scan_interval_minutes();
        let mut statuses = self.recommendations.statuses.lock();
        let status = statuses
            .entry(cluster_id.to_string())
            .or_insert_with(|| RecommendationScanStatus::idle(cluster_id, interval));
        status.interval_minutes = interval;
        change(status);
        let status = status.clone();
        self.sink.recommendation_scan(&status);
        status
    }

    /// `recommendations_status` (blocking on first use: see
    /// [`Self::scan_status_entry`]).
    pub fn recommendations_status(&self, cluster_id: &str) -> RecommendationScanStatus {
        self.scan_status_entry(cluster_id)
    }

    /// `recommendations_scan` ("Scan now"): refused while disconnected
    /// (scans never connect on their own) and within
    /// [`MANUAL_COOLDOWN_MS`] of the last manual scan; while a scan of the
    /// cluster runs, its status. Otherwise the scan is queued in the
    /// background and its `queued` status returned.
    pub async fn recommendations_scan(
        self: &Arc<Self>,
        cluster_id: &str,
    ) -> Result<RecommendationScanStatus> {
        self.cluster_def(cluster_id)?;
        if self.pool.connected_client(cluster_id).is_none() {
            bail!("connect to the cluster first");
        }
        let app = self.clone();
        let id = cluster_id.to_string();
        tokio::task::spawn_blocking(move || app.scan_status_entry(&id)).await?;
        let Some(claim) = self.recommendations.claim(cluster_id) else {
            return Ok(self.scan_status_entry(cluster_id));
        };
        let now = now_millis();
        {
            let mut last = self.recommendations.last_manual.lock();
            if let Some(available) = last
                .get(cluster_id)
                .map(|t| t + MANUAL_COOLDOWN_MS)
                .filter(|t| *t > now)
            {
                drop(claim);
                bail!(
                    "wait {} s before scanning again",
                    (available - now + 999) / 1000
                );
            }
            last.insert(cluster_id.to_string(), now);
        }
        let status = self.update_scan_status(cluster_id, |s| {
            queued(s, ScanTrigger::Manual);
            s.manual_available_at = Some(now + MANUAL_COOLDOWN_MS);
        });
        let app = self.clone();
        let id = cluster_id.to_string();
        self.recommendations
            .manual
            .spawn(&manual_task_id(cluster_id), cluster_id, async move {
                if let Err(e) = run_claimed(app, claim, ScanTrigger::Manual).await {
                    tracing::debug!(cluster = %id, "recommendation scan ended: {e:#}");
                }
            });
        Ok(status)
    }

    /// Tests: the latest stored scan of `cluster_id` under its current
    /// source configuration (`recommendations_latest` replaces it).
    #[doc(hidden)]
    pub fn history_rec_latest_for_tests(&self, cluster_id: &str) -> LatestRead {
        let config = source_config(&self.cluster_def(cluster_id).expect("registered"));
        self.history
            .rec_read(|conn| rec::latest(conn, cluster_id, &config))
            .expect("history.db readable")
    }

    /// Tests: the stored runs of `cluster_id`, newest first, after every
    /// queued history write (`recommendations_runs` replaces it).
    #[doc(hidden)]
    pub fn history_rec_runs_for_tests(&self, cluster_id: &str) -> Vec<RecommendationRun> {
        assert!(self.history_flush(), "history writes flushed");
        self.history
            .rec_read(|conn| rec::runs(conn, cluster_id, rec::MAX_RUNS))
            .expect("history.db readable")
    }

    /// Tests: run one scheduled scan of `cluster_id` now and wait for it
    /// (no cooldown); returns its run id.
    #[doc(hidden)]
    pub async fn recommendations_run_for_tests(self: &Arc<Self>, cluster_id: &str) -> Result<i64> {
        run_scan(self.clone(), cluster_id.to_string(), ScanTrigger::Schedule).await
    }
}

/// Run one scan of `cluster_id` now (see the module docs); fails when one
/// is already in progress. Returns the stored run's id.
pub(crate) async fn run_scan(
    app: Arc<Kubepit>,
    cluster_id: String,
    trigger: ScanTrigger,
) -> Result<i64> {
    let claim = app
        .recommendations
        .claim(&cluster_id)
        .ok_or_else(|| anyhow!("a recommendation scan of this cluster is already running"))?;
    run_claimed(app, claim, trigger).await
}

/// One scan of a claimed cluster, from `queued` to its terminal status.
pub(crate) async fn run_claimed(
    app: Arc<Kubepit>,
    claim: Claim,
    trigger: ScanTrigger,
) -> Result<i64> {
    let cluster_id = claim.cluster_id.clone();
    let stop_app = app.clone();
    let mut task = ScanTask {
        app: app.clone(),
        cluster_id: cluster_id.clone(),
        claim: Some(Arc::new(claim)),
        ended: false,
        guard: RunGuard::new(move |run_id| {
            stop_app
                .history
                .rec_finish_detached(run_id, ScanOutcome::Interrupted(ERROR_STOPPED.into()));
        }),
    };
    let status = app.scan_status_entry_nonblocking(&cluster_id);
    if status.state != ScanState::Queued || status.trigger != Some(trigger) {
        app.update_scan_status(&cluster_id, |s| queued(s, trigger));
    }
    let _permit = app
        .recommendations
        .semaphore
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| anyhow!("recommendation scans stopped"))?;
    match task.scan(trigger).await {
        Ok((run_id, outcome)) => {
            let (state, error) = match &outcome {
                ScanOutcome::Success { .. } => (ScanState::Success, None),
                ScanOutcome::Failed(e) => (ScanState::Failed, Some(e.clone())),
                ScanOutcome::Interrupted(e) => (ScanState::Interrupted, Some(e.clone())),
            };
            match task.store(run_id, outcome).await {
                Ok(()) => task.end(state, error),
                Err(e) => task.end(
                    ScanState::Failed,
                    Some(format!("the scan could not be stored: {e:#}")),
                ),
            }
            Ok(run_id)
        }
        Err((state, error)) => {
            task.end(state, Some(error.clone()));
            Err(anyhow!(error))
        }
    }
}

/// A scan in progress: its claim, its run guard and its status.
struct ScanTask {
    app: Arc<Kubepit>,
    cluster_id: String,
    /// Released with the terminal status (see [`Self::end`]).
    claim: Option<Arc<Claim>>,
    /// A terminal status was recorded.
    ended: bool,
    guard: RunGuard,
}

impl ScanTask {
    fn claim(&self) -> Arc<Claim> {
        self.claim.clone().expect("held until the scan ends")
    }

    /// Begin the run and collect: the run id and how it ended, or the
    /// terminal state and error of a scan that stored no run.
    async fn scan(
        &self,
        trigger: ScanTrigger,
    ) -> std::result::Result<(i64, ScanOutcome), (ScanState, String)> {
        let app = self.app.clone();
        let cluster_id = self.cluster_id.clone();
        let cluster = app
            .cluster_def(&cluster_id)
            .map_err(|e| (ScanState::Failed, format!("{e:#}")))?;
        if app.pool.connected_client(&cluster_id).is_none() {
            return Err((ScanState::Interrupted, ERROR_STOPPED.into()));
        }
        let started = now_millis();
        let run_id = self
            .begin(ScanBegin {
                cluster_id: cluster_id.clone(),
                started,
                trigger,
                source_config: source_config(&cluster),
            })
            .await
            .map_err(|e| (ScanState::Failed, format!("{e:#}")))?;
        app.update_scan_status(&cluster_id, |s| {
            s.state = ScanState::Running;
            s.run_id = Some(run_id);
            s.started_at = Some(started);
            s.progress = Some(ScanProgress::default());
        });

        let last_emit = Mutex::new(Instant::now());
        let on_progress = |p: ScanProgress| {
            let mut statuses = app.recommendations.statuses.lock();
            let Some(status) = statuses.get_mut(&cluster_id) else {
                return;
            };
            if status.run_id != Some(run_id) || status.state != ScanState::Running {
                return;
            }
            status.progress = Some(p);
            let mut last = last_emit.lock();
            if last.elapsed() >= PROGRESS_EVERY {
                *last = Instant::now();
                app.sink.recommendation_scan(status);
            }
        };
        // Strategy-free: the saved strategy (else automatic) with its
        // effective settings, every readable namespace.
        let request = RightsizingRequest::default();
        let collected = tokio::time::timeout(
            SCAN_TIMEOUT,
            app.compute_rightsizing(&cluster_id, &request, &on_progress),
        )
        .await
        .ok();
        Ok((run_id, scan_outcome(collected)))
    }

    /// `rec_begin` on the blocking pool. A scan dropped while its run is
    /// begun leaves the run to the begin, which finishes it as `stopped`.
    async fn begin(&self, scan: ScanBegin) -> Result<i64> {
        let slot = self.guard.slot();
        let app = self.app.clone();
        let claim = self.claim();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::task::spawn_blocking(move || {
            let result = app.history.rec_begin(scan);
            if let Ok(run_id) = &result {
                if !RunGuard::begun(&slot, *run_id) {
                    let stopped = ScanOutcome::Interrupted(ERROR_STOPPED.into());
                    if let Err(e) = app.history.rec_finish(*run_id, stopped) {
                        tracing::warn!("failed to stop recommendation run {run_id}: {e:#}");
                    }
                }
            }
            drop(claim);
            let _ = tx.send(result);
        });
        rx.await
            .map_err(|_| anyhow!("the recommendation scan did not start"))?
    }

    /// `rec_finish` on the blocking pool, after the guard handed the run
    /// over (see the module docs).
    async fn store(&self, run_id: i64, outcome: ScanOutcome) -> Result<()> {
        let app = self.app.clone();
        let claim = self.claim();
        let finish = self.guard.hand_over(|| {
            tokio::task::spawn_blocking(move || {
                let stored = app.history.rec_finish(run_id, outcome);
                drop(claim);
                stored
            })
        });
        finish
            .await
            .map_err(|e| anyhow!("the recommendation scan was not stored: {e}"))?
    }

    /// Record the terminal status: the claim is released with it (under the
    /// status lock), so a next scan's `queued` is always emitted after it.
    fn end(&mut self, state: ScanState, error: Option<String>) {
        self.ended = true;
        let claim = self.claim.take();
        let now = now_millis();
        self.app.recommendation_scan_ended(&self.cluster_id, now);
        self.app.update_scan_status(&self.cluster_id, |s| {
            s.state = state;
            s.progress = None;
            s.finished_at = Some(now);
            s.error = error;
            if state == ScanState::Success {
                s.last_success_at = Some(now);
            }
            drop(claim);
        });
    }
}

impl Drop for ScanTask {
    fn drop(&mut self) {
        // Dropped before its end: aborted (disconnect, removal, shutdown).
        // The guard (a later field) then finishes the run as `stopped`.
        if !self.ended {
            self.end(ScanState::Interrupted, Some(ERROR_STOPPED.into()));
        }
    }
}

impl Kubepit {
    /// The status of `cluster_id` without reading `history.db` (an idle one
    /// when nothing is known yet).
    fn scan_status_entry_nonblocking(&self, cluster_id: &str) -> RecommendationScanStatus {
        self.recommendations
            .statuses
            .lock()
            .get(cluster_id)
            .cloned()
            .unwrap_or_else(|| {
                RecommendationScanStatus::idle(cluster_id, self.scan_interval_minutes())
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::CostPlatform;
    use crate::prometheus::access::{KeyRef, KeyRefKind, PrometheusAuth, TunnelTls};
    use crate::rightsizing::{strategy, RightsizingReport, RightsizingSettings};
    use crate::types::PromScheme;

    fn report(source: RightsizingSource) -> RightsizingReport {
        let pricing = CostPlatform::Generic.default_pricing();
        RightsizingReport {
            source,
            window_secs: 3_600,
            settings: RightsizingSettings::default(),
            currency: pricing.currency.clone(),
            pricing,
            workloads: Vec::new(),
            notes: Vec::new(),
            strategy: "percentile-headroom".into(),
            strategies: strategy::strategies(),
            computed_at: 1,
            strategy_auto: true,
            window_end: 1,
        }
    }

    fn outcome(source: RightsizingSource, abort: Option<SourceAbort>) -> ScanOutcome {
        scan_outcome(Some(Ok(RightsizingOutcome {
            report: report(source),
            source_abort: abort,
        })))
    }

    #[test]
    fn any_source_abort_fails_the_scan_despite_a_fallback_report() {
        // The live report fell back to metrics-server; a scan must not store
        // that as a success over the last good Prometheus result.
        let failed = outcome(
            RightsizingSource::MetricsServer,
            Some(SourceAbort {
                kind: SourceAbortKind::AllBatchesFailed,
                detail: "cpu_p95: too many samples".into(),
            }),
        );
        assert_eq!(
            failed,
            ScanOutcome::Failed("cpu_p95: too many samples".into())
        );
        let mismatch = outcome(
            RightsizingSource::MetricsServer,
            Some(SourceAbort {
                kind: SourceAbortKind::LabelMismatch,
                detail: "anything".into(),
            }),
        );
        assert_eq!(mismatch, ScanOutcome::Failed(CLUSTER_LABEL_MISMATCH.into()));
        let unverified = outcome(
            RightsizingSource::None,
            Some(SourceAbort {
                kind: SourceAbortKind::AllBatchesFailed,
                detail: "cluster-label-unverified".into(),
            }),
        );
        assert_eq!(
            unverified,
            ScanOutcome::Failed("cluster-label-unverified".into())
        );
        for kind in [SourceAbortKind::Proxy, SourceAbortKind::Tunnel] {
            let failed = outcome(
                RightsizingSource::MetricsServer,
                Some(SourceAbort {
                    kind,
                    detail: "no Prometheus was found on this cluster".into(),
                }),
            );
            assert!(matches!(failed, ScanOutcome::Failed(_)));
        }
    }

    #[test]
    fn a_scan_needs_a_usage_source_and_can_time_out() {
        assert_eq!(
            outcome(RightsizingSource::None, None),
            ScanOutcome::Failed(ERROR_NO_USAGE_SOURCE.into())
        );
        assert_eq!(
            scan_outcome(None),
            ScanOutcome::Failed(ERROR_TIMED_OUT.into())
        );
        assert_eq!(
            scan_outcome(Some(Err(anyhow!("failed to list deployments")))),
            ScanOutcome::Failed("failed to list deployments".into())
        );
        // A metrics-server report without an abort is a (low-confidence)
        // success.
        let ScanOutcome::Success {
            report, settings, ..
        } = outcome(RightsizingSource::MetricsServer, None)
        else {
            panic!("a success");
        };
        assert_eq!(settings, report.settings);
    }

    fn recorder() -> (RunGuard, Arc<Mutex<Vec<i64>>>) {
        let stopped = Arc::new(Mutex::new(Vec::new()));
        let sink = stopped.clone();
        (RunGuard::new(move |id| sink.lock().push(id)), stopped)
    }

    #[test]
    fn a_dropped_scan_stops_its_run() {
        let (guard, stopped) = recorder();
        assert!(RunGuard::begun(&guard.slot(), 7));
        drop(guard);
        assert_eq!(*stopped.lock(), vec![7]);

        // Dropped before the begin answered: the begin stops the run itself.
        let (guard, stopped) = recorder();
        let slot = guard.slot();
        drop(guard);
        assert!(!RunGuard::begun(&slot, 8), "the begin must finish it");
        assert!(stopped.lock().is_empty());
    }

    #[test]
    fn a_handed_over_outcome_disarms_the_guard_even_when_storing_fails() {
        // The success timed out in the writer's queue (it is still queued,
        // or waiting in a detached thread): a stop from the guard could
        // overtake it, and the first finish of a run wins.
        let (guard, stopped) = recorder();
        assert!(RunGuard::begun(&guard.slot(), 9));
        let stored: Result<()> = guard.hand_over(|| {
            Err(anyhow!(
                "timed out storing a recommendation scan (it is still queued)"
            ))
        });
        assert!(stored.is_err());
        drop(guard);
        assert!(stopped.lock().is_empty(), "never finished twice");
    }

    #[test]
    fn claims_are_one_per_cluster() {
        let running = Arc::default();
        let a = Claim::take(&running, "c1").unwrap();
        assert!(Claim::take(&running, "c1").is_none());
        let b = Claim::take(&running, "c2").unwrap();
        let shared = Arc::new(a);
        let copy = shared.clone();
        drop(shared);
        assert!(running.lock().contains("c1"), "held by the copy");
        drop(copy);
        assert!(!running.lock().contains("c1"));
        drop(b);
        assert!(running.lock().is_empty());
    }

    fn cluster() -> ClusterDef {
        serde_json::from_value(serde_json::json!({
            "id": "c1", "name": "one", "context": "ctx", "kubeconfig_path": "/k",
            "created_at": 0
        }))
        .unwrap()
    }

    #[test]
    fn source_config_covers_the_source_and_every_access_setting() {
        let base = cluster();
        let plain = source_config(&base);
        assert_eq!(
            plain,
            r#"{"prometheus":{"mode":"auto"},"access":{"tenant":"","cluster_labels":{},"auth":null,"tls":null}}"#
        );
        let changed = |edit: &dyn Fn(&mut ClusterDef)| {
            let mut c = base.clone();
            edit(&mut c);
            source_config(&c)
        };
        let variants = [
            changed(&|c| {
                c.prometheus = PrometheusConfig::Service {
                    namespace: "monitoring".into(),
                    service: "prometheus-operated".into(),
                    port: 9090,
                    scheme: PromScheme::Http,
                    path_prefix: String::new(),
                }
            }),
            changed(&|c| c.prometheus_access.tenant = "team-a".into()),
            changed(&|c| {
                c.prometheus_access
                    .cluster_labels
                    .insert("cluster".into(), "prod".into());
            }),
            changed(&|c| {
                c.prometheus_access.auth = Some(PrometheusAuth::Bearer {
                    namespace: "monitoring".into(),
                    secret: "prom-auth".into(),
                    token_key: "token".into(),
                })
            }),
            changed(&|c| {
                c.prometheus_access.tls = Some(TunnelTls {
                    ca: Some(KeyRef {
                        kind: KeyRefKind::ConfigMap,
                        namespace: "monitoring".into(),
                        name: "ca".into(),
                        key: "ca.crt".into(),
                    }),
                    insecure_skip_verify: false,
                })
            }),
        ];
        for (i, v) in variants.iter().enumerate() {
            assert_ne!(v, &plain, "variant {i}");
        }
        // Labels are canonical: a BTreeMap serializes sorted.
        let ab = changed(&|c| {
            c.prometheus_access
                .cluster_labels
                .extend([("b".into(), "2".into()), ("a".into(), "1".into())]);
        });
        assert!(ab.contains(r#""cluster_labels":{"a":"1","b":"2"}"#), "{ab}");
    }
}
