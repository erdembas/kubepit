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
//!   overtake a success whose queueing timed out. From that moment the
//!   store and the terminal status run in a task of their own, so aborting
//!   the scan then cannot show `interrupted` next to a stored success. A
//!   scan whose cluster was removed meanwhile stores nothing (its run ends
//!   as `stopped` and what it wrote is cleared).
//! - **Status.** `recommendations://scan` carries the status at every state
//!   change and at most every 250 ms while the progress moves. Every scan
//!   ends with one terminal status (`success`, `failed` or `interrupted`,
//!   without progress), emitted after its last progress.
//! - **Alerts (optional).** When a success is stored, workloads with a
//!   large high-confidence saving that the cluster's previous successful
//!   run did not have raise a `RightsizingSaving` alert
//!   ([`saving_alerts`]), only with `Settings.recommendations.alerts` on
//!   and alert monitoring on in this process (the desktop app; never in
//!   tests or other binaries unless they turn it on). A scan raises at
//!   most [`SAVING_ALERTS_PER_SCAN`] of them plus one group alert for the
//!   rest, and a scan without a previous run one summary alert.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use serde::Serialize;

use super::types::{RecommendationScanStatus, ScanState, ScanTrigger};
use crate::alerts::book::GROUP_NAME_LIMIT;
use crate::alerts::{AlertGroup, AlertObjectRef, AlertReason, AlertSettings, Finding};
use crate::app::Kubepit;
use crate::history::recommendations::{self as rec, ScanBegin, ScanOutcome, ERROR_STOPPED};
use crate::history::HistoryKind;
use crate::objects::now_millis;
use crate::prometheus::access::PrometheusAccess;
use crate::prometheus::matchers::CLUSTER_LABEL_MISMATCH;
use crate::rightsizing::collect::{RightsizingOutcome, ScanProgress, SourceAbort, SourceAbortKind};
use crate::rightsizing::summary::summarize;
use crate::rightsizing::{
    workload_gvk, Confidence, RightsizingReport, RightsizingRequest, RightsizingSource, Verdict,
    WorkloadRecommendation,
};
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

/// A saving alerts when it is at least this share of the workload's
/// monthly requests...
pub const SAVING_ALERT_SHARE: f64 = 0.5;
/// ...and one container's CPU request drops by this many millicores...
pub const SAVING_ALERT_CPU_MILLICORES: f64 = 250.0;
/// ...or its memory request by this many bytes (the thresholds of the
/// Health `workload-overprovisioned` rule).
pub const SAVING_ALERT_MEMORY_BYTES: f64 = 512.0 * 1024.0 * 1024.0;

/// A high-confidence, over-provisioned workload whose saving is at least
/// half its monthly requests, with a container whose request drops by at
/// least 250m CPU or 512 MiB (the UI's `healthVerdict` "over").
fn large_saving(w: &WorkloadRecommendation) -> bool {
    let fall = |now: Option<f64>, next: Option<f64>| now.unwrap_or(0.0) - next.unwrap_or(0.0);
    w.changed
        && w.verdict == Verdict::Over
        && w.confidence == Confidence::High
        && w.monthly_current > 0.0
        && -w.monthly_delta >= w.monthly_current * SAVING_ALERT_SHARE
        && w.containers.iter().any(|c| {
            fall(c.current.cpu_request, c.recommended.cpu_request) >= SAVING_ALERT_CPU_MILLICORES
                || fall(c.current.memory_request, c.recommended.memory_request)
                    >= SAVING_ALERT_MEMORY_BYTES
        })
}

/// The workloads of `next` with a large saving (high confidence, ≥ 50 % of
/// its monthly requests, a container dropping ≥ 250m or ≥ 512 MiB) that
/// did not have one in `previous`, the cluster's latest successful run
/// before `next` (`None`: there is none). A workload therefore alerts once,
/// not at every scan, and again only after its saving went away and came
/// back.
pub fn saving_alerts<'a>(
    previous: Option<&RightsizingReport>,
    next: &'a RightsizingReport,
) -> Vec<&'a WorkloadRecommendation> {
    let key = |w: &WorkloadRecommendation| rec::row_key(&w.kind, &w.namespace, &w.name);
    let before: HashSet<String> = previous
        .map(|r| {
            r.workloads
                .iter()
                .filter(|w| large_saving(w))
                .map(key)
                .collect()
        })
        .unwrap_or_default();
    next.workloads
        .iter()
        .filter(|w| large_saving(w) && !before.contains(&key(w)))
        .collect()
}

/// New savings alerted one by one per scan (the largest); the rest share
/// one group alert, so a large cluster never floods the shared alert
/// history.
pub const SAVING_ALERTS_PER_SCAN: usize = 5;
/// `Finding.condition` of the group alert for the savings beyond
/// [`SAVING_ALERTS_PER_SCAN`] (the first scan's summary has none).
pub const SAVING_ALERT_MORE: &str = "more";
/// `AlertObjectRef.kind` of a group alert about workloads of any kind.
pub const SAVING_ALERT_GROUP_KIND: &str = "Workload";

/// One alert a scan raises for its new savings.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SavingAlert {
    pub object: AlertObjectRef,
    pub finding: Finding,
    /// Several workloads in one alert (`object.name` is empty).
    pub group: Option<AlertGroup>,
}

/// The alert of one workload with a new large saving. Its message is an
/// English data string with the share only: never a source, Secret or any
/// configuration.
fn saving_alert(w: &WorkloadRecommendation) -> SavingAlert {
    let (group, version) = workload_gvk(&w.kind)
        .map(|g| (g.group, g.version))
        .unwrap_or_else(|| (String::new(), "v1".to_string()));
    let share = (-w.monthly_delta / w.monthly_current * 100.0).clamp(0.0, 100.0);
    SavingAlert {
        object: AlertObjectRef {
            group,
            version,
            kind: w.kind.clone(),
            namespace: Some(w.namespace.clone()),
            name: w.name.clone(),
        },
        finding: Finding {
            reason: AlertReason::RightsizingSaving,
            container: None,
            condition: None,
            message: format!("Requests could shrink by {share:.0}%"),
        },
        group: None,
    }
}

/// One group alert for `workloads` across the cluster (`namespace/name`,
/// at most [`GROUP_NAME_LIMIT`] listed), `condition` telling a summary
/// (`None`) from the rest beyond the cap ([`SAVING_ALERT_MORE`]).
fn saving_group(workloads: &[&WorkloadRecommendation], condition: Option<&str>) -> SavingAlert {
    let total = workloads.len();
    let message = match condition {
        Some(_) => format!("{total} more workloads could shrink their requests by half or more"),
        None => format!("{total} workloads could shrink their requests by half or more"),
    };
    SavingAlert {
        object: AlertObjectRef {
            group: String::new(),
            version: String::new(),
            kind: SAVING_ALERT_GROUP_KIND.into(),
            namespace: None,
            name: String::new(),
        },
        finding: Finding {
            reason: AlertReason::RightsizingSaving,
            container: None,
            condition: condition.map(str::to_string),
            message,
        },
        group: Some(AlertGroup {
            total: u32::try_from(total).unwrap_or(u32::MAX),
            names: workloads
                .iter()
                .take(GROUP_NAME_LIMIT)
                .map(|w| format!("{}/{}", w.namespace, w.name))
                .collect(),
        }),
    }
}

/// The alerts one successful scan raises for its new large savings
/// ([`saving_alerts`]), largest saving first:
/// - without a previous run (the first scan, or after a clear) one summary
///   alert for the cluster, not one per workload;
/// - otherwise the [`SAVING_ALERTS_PER_SCAN`] largest one by one, and one
///   group alert for the rest.
///
/// Only workloads in namespaces `alerts` allows count (its include and
/// exclude globs), so no alert, single or grouped, names a workload of an
/// excluded namespace: a cluster-wide group passes the book's namespace
/// filter by itself.
pub(crate) fn plan_saving_alerts(
    previous: Option<&RightsizingReport>,
    next: &RightsizingReport,
    alerts: &AlertSettings,
) -> Vec<SavingAlert> {
    let mut new = saving_alerts(previous, next);
    new.retain(|w| alerts.namespace_allowed(Some(&w.namespace)));
    if new.is_empty() {
        return Vec::new();
    }
    new.sort_by(|a, b| {
        a.monthly_delta
            .total_cmp(&b.monthly_delta)
            .then_with(|| (&a.namespace, &a.kind, &a.name).cmp(&(&b.namespace, &b.kind, &b.name)))
    });
    if previous.is_none() {
        return vec![saving_group(&new, None)];
    }
    let rest = new.split_off(new.len().min(SAVING_ALERTS_PER_SCAN));
    let mut alerts: Vec<SavingAlert> = new.into_iter().map(saving_alert).collect();
    if !rest.is_empty() {
        alerts.push(saving_group(&rest, Some(SAVING_ALERT_MORE)));
    }
    alerts
}

impl Kubepit {
    /// Alerts on new savings are wanted: alert monitoring is on in this
    /// process and `Settings.recommendations.alerts` is on.
    fn saving_alerts_wanted(&self) -> bool {
        self.alerts.monitoring() && self.settings().recommendations.alerts
    }

    /// The alerts a successful `outcome` of `cluster_id` raises, found
    /// against the cluster's latest successful run before it is stored
    /// (blocking: reads `history.db`). None unless wanted; when the
    /// previous run cannot be read, none rather than old ones again.
    pub(crate) fn new_saving_alerts(
        &self,
        cluster_id: &str,
        outcome: &ScanOutcome,
    ) -> Vec<SavingAlert> {
        let ScanOutcome::Success { report, .. } = outcome else {
            return Vec::new();
        };
        if !self.saving_alerts_wanted() {
            return Vec::new();
        }
        let previous = self.history.rec_read(|conn| {
            let Some(run) = rec::latest_run(conn, cluster_id)? else {
                return Ok(None);
            };
            Ok(rec::scan(conn, cluster_id, run.id)?.map(|stored| stored.report))
        });
        match previous {
            Ok(previous) => plan_saving_alerts(previous.as_ref(), report, &self.settings().alerts),
            Err(e) => {
                tracing::warn!(cluster = %cluster_id, "saving alerts skipped: {e:#}");
                Vec::new()
            }
        }
    }

    /// Raise `alerts` of the stored run `run_id` through the alert center
    /// (its filters, mutes and book), once the latest pointer names that
    /// run (a run a clear deleted mid-scan is never stored: the writer
    /// applies only a run's first finish). Returns how many were recorded.
    pub(crate) fn raise_saving_alerts(
        &self,
        cluster_id: &str,
        run_id: i64,
        alerts: Vec<SavingAlert>,
    ) -> usize {
        if alerts.is_empty() {
            return 0;
        }
        let latest = self
            .history
            .rec_read(|conn| rec::latest_run(conn, cluster_id))
            .ok()
            .flatten();
        if latest.is_none_or(|run| run.id != run_id) {
            return 0;
        }
        alerts
            .into_iter()
            .filter(|alert| {
                let (object, finding) = (alert.object.clone(), alert.finding.clone());
                match alert.group.clone() {
                    Some(group) => {
                        self.alerts
                            .raise_group(&*self.sink, cluster_id, object, finding, group)
                    }
                    None => self.alerts.raise(&*self.sink, cluster_id, object, finding),
                }
            })
            .count()
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
    let mut task = ScanTask::new(app.clone(), claim);
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
            hand_off(task, run_id, outcome).await?;
            Ok(run_id)
        }
        Err((state, error)) => {
            task.end(state, Some(error.clone()));
            Err(anyhow!(error))
        }
    }
}

/// Store `outcome` and end the status in a task of its own: once the
/// outcome is handed over, aborting the scan (a disconnect) can no longer
/// leave an `interrupted` status next to a stored success.
async fn hand_off(task: ScanTask, run_id: i64, outcome: ScanOutcome) -> Result<()> {
    tokio::spawn(task.finish(run_id, outcome))
        .await
        .map_err(|e| anyhow!("the recommendation scan was not stored: {e}"))
}

/// A scan in progress: its claim, its run guard and its status.
struct ScanTask {
    app: Arc<Kubepit>,
    cluster_id: String,
    /// Released with the terminal status (see [`Self::end`]).
    claim: Option<Arc<Claim>>,
    /// A terminal status was recorded.
    ended: bool,
    /// The source configuration of the run once begun.
    source_config: Option<String>,
    guard: RunGuard,
}

impl ScanTask {
    fn new(app: Arc<Kubepit>, claim: Claim) -> Self {
        let stop_app = app.clone();
        Self {
            app,
            cluster_id: claim.cluster_id.clone(),
            claim: Some(Arc::new(claim)),
            ended: false,
            source_config: None,
            guard: RunGuard::new(move |run_id| {
                stop_app
                    .history
                    .rec_finish_detached(run_id, ScanOutcome::Interrupted(ERROR_STOPPED.into()));
            }),
        }
    }

    /// Store `outcome`, then record the terminal status.
    async fn finish(mut self, run_id: i64, outcome: ScanOutcome) {
        let (state, error) = match &outcome {
            ScanOutcome::Success { .. } => (ScanState::Success, None),
            ScanOutcome::Failed(e) => (ScanState::Failed, Some(e.clone())),
            ScanOutcome::Interrupted(e) => (ScanState::Interrupted, Some(e.clone())),
        };
        match self.store(run_id, outcome).await {
            Ok(true) => self.end(state, error),
            Ok(false) => self.end(ScanState::Interrupted, Some(ERROR_STOPPED.into())),
            Err(e) => self.end(
                ScanState::Failed,
                Some(format!("the scan could not be stored: {e:#}")),
            ),
        }
    }

    fn claim(&self) -> Arc<Claim> {
        self.claim.clone().expect("held until the scan ends")
    }

    /// Begin the run and collect: the run id and how it ended, or the
    /// terminal state and error of a scan that stored no run.
    async fn scan(
        &mut self,
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
        let config = source_config(&cluster);
        self.source_config = Some(config.clone());
        let run_id = self
            .begin(ScanBegin {
                cluster_id: cluster_id.clone(),
                started,
                trigger,
                source_config: config,
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
    ///
    /// A scan whose cluster was removed meanwhile stores nothing: its run
    /// ends as `stopped` and whatever it wrote is cleared (`Ok(false)`).
    async fn store(&self, run_id: i64, outcome: ScanOutcome) -> Result<bool> {
        let app = self.app.clone();
        let claim = self.claim();
        let cluster_id = self.cluster_id.clone();
        let finish = self.guard.hand_over(|| {
            tokio::task::spawn_blocking(move || {
                let removed = || app.store.cluster(&cluster_id).is_none();
                let gone = removed();
                let outcome = if gone {
                    ScanOutcome::Interrupted(ERROR_STOPPED.into())
                } else {
                    outcome
                };
                // Against the previous latest run, before this one replaces it.
                let alerts = app.new_saving_alerts(&cluster_id, &outcome);
                let stored = app.history.rec_finish(run_id, outcome);
                // Removed before or while it was stored: clean up after it.
                let cleared = if gone || removed() {
                    app.history
                        .require_writer()
                        .and_then(|w| {
                            w.clear(HistoryKind::Recommendations, Some(cluster_id.clone()))
                        })
                        .map(|()| false)
                } else {
                    Ok(true)
                };
                if stored.is_ok() && matches!(cleared, Ok(true)) {
                    app.raise_saving_alerts(&cluster_id, run_id, alerts);
                }
                drop(claim);
                stored.and(cleared)
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
        self.app
            .recommendation_scan_ended(&self.cluster_id, now, self.source_config.clone());
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
    use crate::rightsizing::{strategy, RightsizingSettings};
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

    /// Records every scan status.
    #[derive(Default)]
    struct Statuses(Mutex<Vec<RecommendationScanStatus>>);

    impl crate::events::EventSink for Statuses {
        fn cluster_status(&self, _status: &crate::types::ClusterStatus) {}
        fn cluster_list(&self, _clusters: &[ClusterDef]) {}
        fn port_forwards(&self, _forwards: &[crate::types::PortForward]) {}
        fn recommendation_scan(&self, status: &RecommendationScanStatus) {
            self.0.lock().push(status.clone());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_handed_over_outcome_is_stored_and_shown_even_if_the_scan_is_aborted() {
        use crate::history::writer::WriteOp;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let sink = Arc::new(Statuses::default());
        let app = Arc::new(
            Kubepit::open(
                crate::paths::Paths::new(dir.path().join("home")),
                sink.clone(),
            )
            .unwrap(),
        );
        // A registered cluster (never connected) whose scan collected a result.
        let cluster = register(&app);
        let run_id = app
            .history
            .rec_begin(ScanBegin {
                cluster_id: cluster.id.clone(),
                started: 1,
                trigger: ScanTrigger::Manual,
                source_config: source_config(&cluster),
            })
            .unwrap();
        let mut task = ScanTask::new(app.clone(), app.recommendations.claim(&cluster.id).unwrap());
        task.source_config = Some(source_config(&cluster));
        assert!(RunGuard::begun(&task.guard.slot(), run_id));
        let report = report(RightsizingSource::Prometheus);
        let outcome = ScanOutcome::Success {
            summary: summarize(&report),
            settings: report.settings.clone(),
            report,
        };

        // The writer is busy: the store waits while the scan is aborted.
        let (release, gate) = std::sync::mpsc::channel();
        assert!(app.history.submit(WriteOp::Block(gate)));
        let scan = tokio::spawn(hand_off(task, run_id, outcome));
        tokio::time::sleep(Duration::from_millis(100)).await;
        scan.abort();
        tokio::time::sleep(Duration::from_millis(100)).await;
        release.send(()).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let done = sink
                .0
                .lock()
                .last()
                .is_some_and(|s| s.state == ScanState::Success);
            if done && !app.recommendations.is_running(&cluster.id) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{:?}", sink.0.lock());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let statuses = sink.0.lock().clone();
        assert!(
            statuses.iter().all(|s| s.state != ScanState::Interrupted),
            "{statuses:?}"
        );
        assert!(statuses.last().unwrap().last_success_at.is_some());
        assert!(app.history_flush());
        let runs = app
            .history
            .rec_read(|conn| rec::runs(conn, &cluster.id, 5))
            .unwrap();
        assert_eq!(
            (runs[0].id, runs[0].status),
            (run_id, crate::recommendations::RunStatus::Success)
        );
    }

    const MIB: f64 = 1024.0 * 1024.0;

    /// A Deployment in `shop` whose one container goes from `cpu_now` to
    /// `cpu_next` millicores (memory 1 GiB → 900 MiB, too little to count).
    fn workload(
        name: &str,
        confidence: Confidence,
        (cpu_now, cpu_next): (f64, f64),
        (monthly_current, monthly_delta): (f64, f64),
    ) -> WorkloadRecommendation {
        use crate::rightsizing::math::change_of;
        use crate::rightsizing::{Change, ContainerRecommendation, ResourceValues};
        let current = ResourceValues {
            cpu_request: Some(cpu_now),
            memory_request: Some(1024.0 * MIB),
            ..Default::default()
        };
        let recommended = ResourceValues {
            cpu_request: Some(cpu_next),
            memory_request: Some(900.0 * MIB),
            ..Default::default()
        };
        WorkloadRecommendation {
            kind: "Deployment".into(),
            namespace: "shop".into(),
            name: name.into(),
            uid: format!("uid-{name}"),
            replicas: 2,
            confidence,
            verdict: Verdict::Over,
            coverage_hours: 168.0,
            containers: vec![ContainerRecommendation {
                name: "app".into(),
                current,
                recommended,
                usage: None,
                cpu: change_of(current.cpu_request, recommended.cpu_request),
                memory: change_of(current.memory_request, recommended.memory_request),
                memory_limit: Change::Unchanged,
                cpu_limit: Change::Unchanged,
                confidence,
                warnings: Vec::new(),
                cpu_limit_raised: false,
                memory_limit_raised: false,
                evidence: None,
            }],
            monthly_delta,
            monthly_current,
            changed: true,
            pods: Vec::new(),
            pods_truncated: false,
            hpa: None,
            lenses: Vec::new(),
            cost_replicas: 2.0,
        }
    }

    /// A high-confidence saving of 75 % with an 800m drop.
    fn big(name: &str) -> WorkloadRecommendation {
        workload(name, Confidence::High, (1000.0, 200.0), (40.0, -30.0))
    }

    fn with(workloads: Vec<WorkloadRecommendation>) -> RightsizingReport {
        RightsizingReport {
            workloads,
            ..report(RightsizingSource::Prometheus)
        }
    }

    fn with_big_saving() -> RightsizingReport {
        with(vec![big("web")])
    }

    fn medium_confidence_saving() -> RightsizingReport {
        with(vec![workload(
            "web",
            Confidence::Medium,
            (1000.0, 200.0),
            (40.0, -30.0),
        )])
    }

    #[test]
    fn new_large_savings_alert_once() {
        assert_eq!(saving_alerts(None, &with_big_saving()).len(), 1);
        assert!(saving_alerts(Some(&with_big_saving()), &with_big_saving()).is_empty());
        assert!(saving_alerts(None, &medium_confidence_saving()).is_empty());

        // A saving the previous run did not have (lost confidence, or a new
        // workload) alerts; the others do not.
        let next = with(vec![big("web"), big("api")]);
        let names = |alerts: Vec<&WorkloadRecommendation>| -> Vec<String> {
            alerts.into_iter().map(|w| w.name.clone()).collect()
        };
        assert_eq!(
            names(saving_alerts(Some(&with_big_saving()), &next)),
            ["api"]
        );
        assert_eq!(
            names(saving_alerts(Some(&medium_confidence_saving()), &next)),
            ["web", "api"]
        );

        // Below the thresholds: under half the monthly requests, a drop
        // under 250m and 512 MiB, not over-provisioned, or unchanged.
        let half = workload("half", Confidence::High, (1000.0, 200.0), (40.0, -19.0));
        let small = workload("small", Confidence::High, (400.0, 200.0), (40.0, -30.0));
        let mut under = big("under");
        under.verdict = Verdict::Under;
        let mut same = big("same");
        same.changed = false;
        let mut free = big("free");
        free.monthly_current = 0.0;
        assert!(saving_alerts(None, &with(vec![half, small, under, same, free])).is_empty());
        // Memory alone counts too.
        let mut memory = workload("memory", Confidence::High, (500.0, 400.0), (40.0, -30.0));
        memory.containers[0].recommended.memory_request = Some(256.0 * MIB);
        assert_eq!(saving_alerts(None, &with(vec![memory])).len(), 1);
    }

    #[test]
    fn saving_alerts_name_the_workload_and_the_share_only() {
        let SavingAlert {
            object,
            finding,
            group,
        } = saving_alert(&big("web"));
        assert_eq!(group, None);
        assert_eq!(
            object,
            AlertObjectRef {
                group: "apps".into(),
                version: "v1".into(),
                kind: "Deployment".into(),
                namespace: Some("shop".into()),
                name: "web".into(),
            }
        );
        assert_eq!(finding.reason, AlertReason::RightsizingSaving);
        assert_eq!(finding.message, "Requests could shrink by 75%");
        assert_eq!((finding.container, finding.condition), (None, None));
        let mut job = big("nightly");
        job.kind = "CronJob".into();
        assert_eq!(saving_alert(&job).object.group, "batch");
    }

    /// `name` saving `delta` a month (all qualify: ≥ half of 1000).
    fn saving(name: &str, delta: f64) -> WorkloadRecommendation {
        workload(name, Confidence::High, (1000.0, 200.0), (1000.0, -delta))
    }

    /// Alert settings that allow every namespace.
    fn every() -> AlertSettings {
        AlertSettings::default()
    }

    #[test]
    fn excluded_namespaces_never_appear_in_saving_alerts() {
        let in_ns = |ns: &str, name: &str, delta: f64| WorkloadRecommendation {
            namespace: ns.into(),
            ..saving(name, delta)
        };
        let previous = with(vec![in_ns("shop", "old", 900.0)]);
        let next = with(vec![
            in_ns("shop", "old", 900.0),
            in_ns("kube-system", "dns", 990.0),
            in_ns("shop", "a", 800.0),
            in_ns("team-a", "b", 700.0),
            in_ns("kube-public", "c", 650.0),
            in_ns("shop", "d", 600.0),
            in_ns("team-a", "e", 550.0),
            in_ns("shop", "f", 540.0),
            in_ns("kube-system", "g", 530.0),
            in_ns("team-b", "h", 520.0),
        ]);
        let filters = AlertSettings {
            exclude_namespaces: vec!["kube-*".into()],
            ..AlertSettings::default()
        };
        let named = |plan: &[SavingAlert]| -> Vec<String> {
            plan.iter()
                .flat_map(|a| match &a.group {
                    Some(group) => group.names.clone(),
                    None => vec![format!(
                        "{}/{}",
                        a.object.namespace.as_deref().unwrap_or(""),
                        a.object.name
                    )],
                })
                .collect()
        };
        let capped = plan_saving_alerts(Some(&previous), &next, &filters);
        assert_eq!(
            named(&capped),
            ["shop/a", "team-a/b", "shop/d", "team-a/e", "shop/f", "team-b/h"]
        );
        assert_eq!(capped.last().unwrap().group.as_ref().unwrap().total, 1);
        let summary = plan_saving_alerts(None, &next, &filters);
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].group.as_ref().unwrap().total, 7);
        assert!(named(&summary).iter().all(|n| !n.starts_with("kube-")));
        // Include globs narrow it the same way.
        let only_team = AlertSettings {
            include_namespaces: vec!["team-*".into()],
            ..AlertSettings::default()
        };
        assert_eq!(
            named(&plan_saving_alerts(Some(&previous), &next, &only_team)),
            ["team-a/b", "team-a/e", "team-b/h"]
        );

        // Everything excluded: nothing at all.
        let none = AlertSettings {
            exclude_namespaces: vec!["*".into()],
            ..AlertSettings::default()
        };
        assert!(plan_saving_alerts(Some(&previous), &next, &none).is_empty());
        assert!(plan_saving_alerts(None, &next, &none).is_empty());
    }

    #[test]
    fn a_scan_alerts_its_five_largest_new_savings_and_groups_the_rest() {
        let previous = with(vec![saving("old", 900.0)]);
        let next = with(vec![
            saving("old", 900.0),
            saving("a", 510.0),
            saving("b", 800.0),
            saving("c", 600.0),
            saving("d", 990.0),
            saving("e", 700.0),
            saving("f", 520.0),
            saving("g", 950.0),
            saving("h", 500.0),
        ]);
        let plan = plan_saving_alerts(Some(&previous), &next, &every());
        assert_eq!(plan.len(), SAVING_ALERTS_PER_SCAN + 1);
        let singles: Vec<&str> = plan[..5].iter().map(|a| a.object.name.as_str()).collect();
        assert_eq!(singles, ["d", "g", "b", "e", "c"], "largest saving first");
        assert!(plan[..5].iter().all(|a| a.group.is_none()));
        let rest = &plan[5];
        assert_eq!(rest.object.kind, SAVING_ALERT_GROUP_KIND);
        assert_eq!(
            (rest.object.name.as_str(), &rest.object.namespace),
            ("", &None)
        );
        assert_eq!(rest.finding.condition.as_deref(), Some(SAVING_ALERT_MORE));
        assert_eq!(
            rest.finding.message,
            "3 more workloads could shrink their requests by half or more"
        );
        assert_eq!(
            rest.group,
            Some(AlertGroup {
                total: 3,
                names: vec!["shop/f".into(), "shop/a".into(), "shop/h".into()],
            })
        );

        // Up to the cap: one alert each, no group.
        let few = with(vec![
            saving("old", 900.0),
            saving("a", 510.0),
            saving("b", 800.0),
        ]);
        let plan = plan_saving_alerts(Some(&previous), &few, &every());
        assert_eq!(plan.len(), 2);
        assert!(plan.iter().all(|a| a.group.is_none()));
        assert!(plan_saving_alerts(Some(&few), &few, &every()).is_empty());
    }

    #[test]
    fn without_a_previous_scan_one_summary_alert_per_cluster() {
        let many: Vec<WorkloadRecommendation> = (0..60)
            .map(|i| saving(&format!("w{i:02}"), 500.0 + f64::from(i)))
            .collect();
        let plan = plan_saving_alerts(None, &with(many), &every());
        assert_eq!(plan.len(), 1);
        let summary = &plan[0];
        assert_eq!(summary.finding.condition, None);
        assert_eq!(summary.finding.reason, AlertReason::RightsizingSaving);
        assert_eq!(
            summary.finding.message,
            "60 workloads could shrink their requests by half or more"
        );
        let group = summary.group.as_ref().unwrap();
        assert_eq!(group.total, 60);
        assert_eq!(group.names.len(), GROUP_NAME_LIMIT);
        assert_eq!(group.names[0], "shop/w59", "largest saving first");
        // One saving is still a summary; none is nothing.
        let one = plan_saving_alerts(None, &with_big_saving(), &every());
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].group.as_ref().unwrap().total, 1);
        assert!(plan_saving_alerts(None, &medium_confidence_saving(), &every()).is_empty());
    }

    /// Records every alert.
    #[derive(Default)]
    struct Alerts(Mutex<Vec<crate::alerts::AlertEvent>>);

    impl crate::events::EventSink for Alerts {
        fn cluster_status(&self, _status: &crate::types::ClusterStatus) {}
        fn cluster_list(&self, _clusters: &[ClusterDef]) {}
        fn port_forwards(&self, _forwards: &[crate::types::PortForward]) {}
        fn alert(&self, event: &crate::alerts::AlertEvent) {
            self.0.lock().push(event.clone());
        }
    }

    /// A registered cluster that is never connected.
    fn register(app: &Kubepit) -> ClusterDef {
        app.cluster_add(vec![crate::types::ClusterInput {
            name: "One".into(),
            context: "one".into(),
            kubeconfig_text: Some(
                "apiVersion: v1\nkind: Config\nclusters:\n- name: one\n  cluster:\n    server: http://127.0.0.1:9\ncontexts:\n- name: one\n  context:\n    cluster: one\n    user: u\nusers:\n- name: u\n  user:\n    token: t\ncurrent-context: one\n"
                    .into(),
            ),
            ..Default::default()
        }])
        .unwrap()
        .remove(0)
    }

    /// Store a successful scan of `cluster` the way a scan hands it off.
    async fn store_success(app: &Arc<Kubepit>, cluster: &ClusterDef, report: RightsizingReport) {
        let run_id = app
            .history
            .rec_begin(ScanBegin {
                cluster_id: cluster.id.clone(),
                started: now_millis(),
                trigger: ScanTrigger::Schedule,
                source_config: source_config(cluster),
            })
            .unwrap();
        let mut task = ScanTask::new(app.clone(), app.recommendations.claim(&cluster.id).unwrap());
        task.source_config = Some(source_config(cluster));
        assert!(RunGuard::begun(&task.guard.slot(), run_id));
        let outcome = ScanOutcome::Success {
            summary: summarize(&report),
            settings: report.settings.clone(),
            report,
        };
        hand_off(task, run_id, outcome).await.unwrap();
        let latest = app
            .history
            .rec_read(|conn| rec::latest_run(conn, &cluster.id))
            .unwrap();
        assert_eq!(latest.map(|r| r.id), Some(run_id), "stored");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn new_savings_alert_once_and_only_when_turned_on() {
        let dir = tempfile::tempdir().unwrap();
        let sink = Arc::new(Alerts::default());
        let app = Arc::new(
            Kubepit::open(
                crate::paths::Paths::new(dir.path().join("home")),
                sink.clone(),
            )
            .unwrap(),
        );
        let cluster = register(&app);
        let alerts = || sink.0.lock().clone();
        let set_toggle = |on: bool| {
            let mut settings = app.settings();
            settings.recommendations.alerts = on;
            app.set_settings(settings).unwrap();
        };
        let savings = |names: &[&str]| with(names.iter().map(|name| big(name)).collect::<Vec<_>>());

        // Off by default in tests: neither monitoring nor the toggle.
        store_success(&app, &cluster, savings(&["web"])).await;
        set_toggle(true);
        store_success(&app, &cluster, savings(&["web", "db"])).await;
        assert!(alerts().is_empty(), "monitoring is off in this process");

        // Both on: only the saving the previous scan did not have.
        app.set_alert_monitoring(true);
        store_success(&app, &cluster, savings(&["web", "db", "api"])).await;
        let raised = alerts();
        assert_eq!(raised.len(), 1, "{raised:?}");
        let alert = &raised[0].alert;
        assert!(raised[0].fresh);
        assert_eq!(alert.reason, AlertReason::RightsizingSaving);
        assert_eq!(alert.severity, crate::alerts::AlertSeverity::Warning);
        assert_eq!(alert.cluster_id, cluster.id);
        assert_eq!(
            (alert.object.kind.as_str(), alert.object.name.as_str()),
            ("Deployment", "api")
        );
        assert_eq!(alert.message, "Requests could shrink by 75%");
        assert_eq!(
            app.alerts_list().len(),
            1,
            "recorded in the notification center"
        );

        // A repeat raises nothing.
        store_success(&app, &cluster, savings(&["web", "db", "api"])).await;
        assert_eq!(alerts().len(), 1);

        // The toggle off: nothing.
        set_toggle(false);
        store_success(&app, &cluster, savings(&["web", "db", "api", "cache"])).await;
        assert_eq!(alerts().len(), 1);

        // The alert filters apply: a disabled reason records nothing.
        set_toggle(true);
        let mut settings = app.settings();
        settings.alerts.disabled_reasons = vec![AlertReason::RightsizingSaving];
        app.set_settings(settings).unwrap();
        store_success(&app, &cluster, savings(&["web", "queue"])).await;
        assert_eq!(alerts().len(), 1);

        // Monitoring off again: nothing.
        let mut settings = app.settings();
        settings.alerts.disabled_reasons.clear();
        app.set_settings(settings).unwrap();
        app.set_alert_monitoring(false);
        store_success(&app, &cluster, savings(&["web", "search"])).await;
        assert_eq!(alerts().len(), 1);

        // After a clear there is no previous scan: one summary for the
        // cluster, not one alert per workload.
        app.set_alert_monitoring(true);
        app.history_clear(HistoryKind::Recommendations, Some(&cluster.id))
            .unwrap();
        let names: Vec<String> = (0..12).map(|i| format!("w{i}")).collect();
        let many: Vec<&str> = names.iter().map(String::as_str).collect();
        store_success(&app, &cluster, savings(&many)).await;
        let raised = alerts();
        assert_eq!(raised.len(), 2, "{raised:?}");
        let summary = &raised[1].alert;
        assert_eq!(summary.object.name, "");
        assert_eq!(summary.count, 1);
        assert_eq!(summary.group.as_ref().map(|g| g.total), Some(12));

        // Then the cap: 7 new savings raise 5 alerts and one group.
        let seven: Vec<String> = (0..7).map(|i| format!("n{i}")).collect();
        let next: Vec<&str> = many
            .iter()
            .copied()
            .chain(seven.iter().map(String::as_str))
            .collect();
        store_success(&app, &cluster, savings(&next)).await;
        let raised = alerts();
        assert_eq!(raised.len(), 2 + SAVING_ALERTS_PER_SCAN + 1, "{raised:?}");
        let last = &raised.last().unwrap().alert;
        assert_eq!(last.condition.as_deref(), Some(SAVING_ALERT_MORE));
        assert_eq!(last.group.as_ref().map(|g| g.total), Some(2));

        // The namespace filters apply to summaries too: every namespace
        // excluded, a scan without a previous run raises nothing.
        let mut settings = app.settings();
        settings.alerts.exclude_namespaces = vec!["*".into()];
        app.set_settings(settings).unwrap();
        app.history_clear(HistoryKind::Recommendations, Some(&cluster.id))
            .unwrap();
        store_success(&app, &cluster, savings(&next)).await;
        assert_eq!(alerts().len(), 2 + SAVING_ALERTS_PER_SCAN + 1);
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
