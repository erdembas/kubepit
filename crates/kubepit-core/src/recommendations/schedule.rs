//! Background scans (spec §12): one scheduler per connected cluster that
//! opted in (`Settings.recommendations.scan_clusters`), in a process that
//! turned them on ([`Kubepit::set_recommendation_scans`], the desktop shell
//! only — tests and other binaries start no scheduler).
//!
//! - **Due time** ([`next_due`]): `max(connected_at + 120 s + jitter,
//!   last_attempt_end + interval)`, where the last attempt is the cluster's
//!   newest run of any status, so a failure waits a full interval (no hot
//!   retry). A Prometheus configuration change makes the next scan due in
//!   120 s; a scan of the old source (still running at the change, or
//!   before a reconnect) neither clears that nor counts as the last
//!   attempt.
//! - **One loop per cluster**: starts (connect, settings syncs) check,
//!   stop the old loop and spawn under the `schedules` lock, and every
//!   start has its own task id and generation, so an old loop's end never
//!   untracks the new one and overlapping starts leave exactly one.
//! - **Waiting** in slices of at most [`SLICE`] against the wall clock, so
//!   missed ticks after laptop sleep collapse into one scan; settings and
//!   source changes wake the scheduler at once.
//! - **Stopping**: everything that stops cluster work (disconnect, removal,
//!   shutdown) stops the scheduler and aborts a running scan; opting out
//!   stops the scheduler and its scan, a manual scan keeps running.
//!   Scans never connect: the scheduler only runs while connected.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::Notify;

use super::scan::{run_claimed, source_config};
use super::types::ScanTrigger;
use crate::app::Kubepit;
use crate::history::recommendations as rec;
use crate::history::HistoryKind;
use crate::objects::now_millis;

/// The first scan after a connect (or a source change) waits this long …
pub const FIRST_DELAY_MS: i64 = 120_000;
/// … plus up to this much, so clusters connected together spread out.
pub const MAX_JITTER_MS: i64 = 60_000;
/// Longest single sleep of a scheduler.
pub const SLICE: Duration = Duration::from_secs(60);
/// How long a removal waits for a stopped scan's history writes.
const REMOVAL_WAIT: Duration = Duration::from_secs(5);

/// When the next background scan of a cluster is due (epoch ms):
/// `max(connected_at + FIRST_DELAY_MS + jitter, last_attempt_end +
/// interval)`; without a last attempt, the first term.
pub fn next_due(
    connected_at: i64,
    jitter_ms: i64,
    last_attempt_end: Option<i64>,
    interval_ms: i64,
) -> i64 {
    let first = connected_at + FIRST_DELAY_MS + jitter_ms;
    match last_attempt_end {
        Some(end) => first.max(end + interval_ms),
        None => first,
    }
}

/// A random jitter in `0..=MAX_JITTER_MS` (the process' random hasher
/// keys; no dependency for one number per connect).
fn jitter_ms() -> i64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_i64(now_millis());
    (hasher.finish() % (MAX_JITTER_MS as u64 + 1)) as i64
}

/// Starts of schedulers: each gets its own task id and generation, so a
/// stopped loop's entry never shadows (and its end never removes) the
/// entry of the loop that replaced it.
static SCHEDULE_SEQ: AtomicU64 = AtomicU64::new(0);

/// The scheduler of one cluster.
pub(crate) struct Schedule {
    /// Which start this is; a loop of an older one exits.
    generation: u64,
    connected_at: i64,
    jitter_ms: i64,
    /// A source change: the next scan is due then, whatever ran before.
    due_override: Option<i64>,
    /// When the cluster's last scan ended and the source configuration it
    /// used (also when `history.db` could not record it, so a broken
    /// database cannot cause a hot loop).
    last_end: Option<(i64, String)>,
    wake: Arc<Notify>,
}

impl Kubepit {
    /// Turn background scans on or off for this process (the desktop
    /// shell turns them on; tests and headless tools never do). On:
    /// schedulers start for connected, opted-in clusters (inside a Tokio
    /// runtime) and for clusters that connect later. Off: every scheduler
    /// stops; manual scans keep working.
    pub fn set_recommendation_scans(self: &Arc<Self>, on: bool) {
        *self.recommendations.app.lock() = Some(Arc::downgrade(self));
        self.recommendations.active.store(on, Ordering::SeqCst);
        self.sync_recommendation_scans();
    }

    fn scans_active(&self) -> bool {
        self.recommendations.active.load(Ordering::SeqCst)
    }

    /// Whether `cluster_id` should have a scheduler now: this process scans
    /// in the background, the cluster opted in and it is connected.
    fn schedule_wanted(&self, cluster_id: &str) -> bool {
        self.scans_active()
            && self.settings().recommendations.scans(cluster_id)
            && self.pool.connected_client(cluster_id).is_some()
    }

    /// Called once a connect succeeded: restart the cluster's scheduler
    /// when this process scans in the background and the cluster opted in.
    pub(crate) fn start_recommendation_scans(&self, cluster_id: &str) {
        self.start_schedule(cluster_id, true);
    }

    /// Start the cluster's scheduler: always (`restart`, replacing a
    /// running one) or only when none runs. The check, the stop of an old
    /// loop, the new entry and the spawn happen under the `schedules`
    /// lock, so overlapping starts (a connect during `settings_set`, two
    /// syncs) leave exactly one tracked loop.
    fn start_schedule(&self, cluster_id: &str, restart: bool) {
        if !self.schedule_wanted(cluster_id) || tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let Some(app) = self.recommendations.app.lock().clone() else {
            return;
        };
        let connected_at = self
            .cluster_status(cluster_id)
            .connected_at
            .unwrap_or_else(now_millis);
        let jitter = jitter_ms();
        let wake = Arc::new(Notify::new());
        let mut schedules = self.recommendations.schedules.lock();
        // Again under the lock: an opt-out or disconnect since the check
        // above has already run its stop, which would miss this loop.
        if (!restart && schedules.contains_key(cluster_id)) || !self.schedule_wanted(cluster_id) {
            return;
        }
        self.recommendations.scheduled.stop_cluster(cluster_id);
        let generation = SCHEDULE_SEQ.fetch_add(1, Ordering::Relaxed);
        schedules.insert(
            cluster_id.to_string(),
            Schedule {
                generation,
                connected_at,
                jitter_ms: jitter,
                due_override: None,
                last_end: None,
                wake: wake.clone(),
            },
        );
        self.recommendations.scheduled.spawn(
            &format!("rec-schedule:{cluster_id}:{generation}"),
            cluster_id,
            scheduler(app, cluster_id.to_string(), generation, wake),
        );
        // The earliest possible due time until the scheduler has read the
        // last attempt (it corrects `next_at` right away). Published under
        // the lock, so a stop that follows is shown after it.
        let first = connected_at + FIRST_DELAY_MS + jitter;
        self.update_scan_status(cluster_id, |s| {
            s.scheduled = true;
            s.next_at = Some(s.next_at.map_or(first, |t| t.max(first)));
        });
    }

    /// Stop the cluster's scheduler (and the scheduled scan it runs).
    fn stop_schedule(&self, cluster_id: &str) {
        let mut schedules = self.recommendations.schedules.lock();
        self.recommendations.scheduled.stop_cluster(cluster_id);
        let was = schedules.remove(cluster_id);
        let shown = self
            .recommendations
            .statuses
            .lock()
            .get(cluster_id)
            .is_some_and(|s| s.scheduled || s.next_at.is_some());
        if was.is_some() || shown {
            self.update_scan_status(cluster_id, |s| {
                s.scheduled = false;
                s.next_at = None;
            });
        }
    }

    /// Disconnect, removal, shutdown: stop the scheduler and abort any
    /// running scan of the cluster, manual ones too (their runs end as
    /// interrupted, `stopped`).
    pub(crate) fn stop_recommendation_scans(&self, cluster_id: &str) {
        self.stop_schedule(cluster_id);
        self.recommendations.manual.stop_cluster(cluster_id);
    }

    /// Start or stop schedulers after a settings change (or when the
    /// process turned scans on or off); wake the running ones so a new
    /// interval shows at once.
    pub(crate) fn sync_recommendation_scans(&self) {
        let settings = self.settings().recommendations;
        let active = self.scans_active();
        let has_runtime = tokio::runtime::Handle::try_current().is_ok();
        for cluster in self.store.clusters() {
            let wanted = active
                && settings.scans(&cluster.id)
                && self.pool.connected_client(&cluster.id).is_some();
            let wake = self
                .recommendations
                .schedules
                .lock()
                .get(&cluster.id)
                .map(|s| s.wake.clone());
            match (wanted, wake) {
                (false, Some(_)) => self.stop_schedule(&cluster.id),
                // Checked again under the lock: another start may win.
                (true, None) if has_runtime => self.start_schedule(&cluster.id, false),
                (true, Some(wake)) => wake.notify_one(),
                _ => {}
            }
        }
    }

    /// `ClusterDef.prometheus` or its access settings changed: the next
    /// background scan is due in [`FIRST_DELAY_MS`].
    pub(crate) fn recommendations_source_changed(&self, cluster_id: &str) {
        let wake = {
            let mut schedules = self.recommendations.schedules.lock();
            let Some(schedule) = schedules.get_mut(cluster_id) else {
                return;
            };
            schedule.due_override = Some(now_millis() + FIRST_DELAY_MS);
            schedule.wake.clone()
        };
        wake.notify_one();
    }

    /// The source configuration `cluster_id` has now (`None` once removed).
    fn current_source_config(&self, cluster_id: &str) -> Option<String> {
        self.store.cluster(cluster_id).map(|c| source_config(&c))
    }

    /// A scan of `cluster_id` ended (see `ScanTask::end`) that used
    /// `used` (`None`: it stored no run, so the current one): the scheduler
    /// counts the next interval from now, and shows it at once. A pending
    /// source change stays due unless the scan already used the new source.
    pub(crate) fn recommendation_scan_ended(
        &self,
        cluster_id: &str,
        at: i64,
        used: Option<String>,
    ) {
        let current = self.current_source_config(cluster_id);
        let Some(used) = used.or_else(|| current.clone()) else {
            return;
        };
        let wake = {
            let mut schedules = self.recommendations.schedules.lock();
            let Some(schedule) = schedules.get_mut(cluster_id) else {
                return;
            };
            if current.as_deref() == Some(used.as_str()) {
                schedule.due_override = None;
            }
            schedule.last_end = Some((at, used));
            schedule.wake.clone()
        };
        wake.notify_one();
    }

    /// App shutdown: stop every scheduler and scan.
    pub(crate) fn stop_all_recommendation_scans(&self) {
        self.recommendations.active.store(false, Ordering::SeqCst);
        self.recommendations.scheduled.stop_all();
        self.recommendations.schedules.lock().clear();
        self.recommendations.manual.stop_all();
    }

    /// A removed cluster: stop its scans, wait (bounded) until nothing will
    /// write a run of it any more, then clear its stored scans.
    pub(crate) async fn forget_recommendations(&self, cluster_id: &str) {
        self.stop_recommendation_scans(cluster_id);
        let deadline = tokio::time::Instant::now() + REMOVAL_WAIT;
        while self.recommendations.is_running(cluster_id) && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.recommendations.statuses.lock().remove(cluster_id);
        self.recommendations.last_manual.lock().remove(cluster_id);
        // Nothing stored yet: no database to open just to clear it.
        if !self.history.path().exists() {
            return;
        }
        let writer = match self.history.require_writer() {
            Ok(writer) => writer,
            Err(e) => {
                tracing::warn!("recommendation scans of a removed cluster are kept: {e:#}");
                return;
            }
        };
        let id = cluster_id.to_string();
        let cleared = tokio::task::spawn_blocking(move || {
            writer.clear(HistoryKind::Recommendations, Some(id))
        })
        .await;
        match cleared {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(
                    "failed to clear the recommendation scans of a removed cluster: {e:#}"
                )
            }
            Err(e) => {
                tracing::warn!("failed to clear the recommendation scans of a removed cluster: {e}")
            }
        }
    }

    /// When the next background scan of `cluster_id` is due, published as
    /// `next_at`; `None` once its scheduler (start `generation`) was
    /// stopped or replaced, or the cluster removed. The last attempt counts
    /// only when it used the current source configuration: a scan of the
    /// old source does not delay the first one of the new source.
    async fn scan_due(self: &Arc<Self>, cluster_id: &str, generation: u64) -> Option<i64> {
        let current = self.current_source_config(cluster_id)?;
        let app = self.clone();
        let id = cluster_id.to_string();
        let stored = tokio::task::spawn_blocking(move || {
            app.history
                .rec_read(|conn| rec::last_attempt_source(conn, &id))
                .ok()
                .flatten()
        })
        .await
        .ok()
        .flatten();
        let of_current = |attempt: &Option<(i64, String)>| {
            attempt
                .as_ref()
                .filter(|(_, used)| *used == current)
                .map(|(end, _)| *end)
        };
        let interval = self.scan_interval_minutes();
        let interval_ms = i64::from(interval) * 60_000;
        let mut schedules = self.recommendations.schedules.lock();
        schedules
            .get(cluster_id)
            .filter(|s| s.generation == generation)?;
        // A loop left behind by a start that raced a stop (a disconnect
        // stops the scheduler before it drops the connection) ends itself.
        if !self.schedule_wanted(cluster_id) {
            schedules.remove(cluster_id);
            self.update_scan_status(cluster_id, |s| {
                s.scheduled = false;
                s.next_at = None;
            });
            return None;
        }
        let schedule = schedules.get(cluster_id)?;
        let due = match schedule.due_override {
            Some(at) => at,
            None => next_due(
                schedule.connected_at,
                schedule.jitter_ms,
                of_current(&stored).max(of_current(&schedule.last_end)),
                interval_ms,
            ),
        };
        let shown = self
            .recommendations
            .statuses
            .lock()
            .get(cluster_id)
            .map(|s| (s.next_at, s.scheduled, s.interval_minutes));
        // Under the lock: a stop always shows after this.
        if shown != Some((Some(due), true, interval)) {
            self.update_scan_status(cluster_id, |s| {
                s.next_at = Some(due);
                s.scheduled = true;
            });
        }
        Some(due)
    }

    /// Tests: scheduler loops tracked (and so stoppable) right now.
    #[doc(hidden)]
    pub fn recommendations_scheduler_tasks_for_tests(&self) -> usize {
        self.recommendations.scheduled.len()
    }

    /// Tests: restart the scheduler of `cluster_id` (like a connect does).
    #[doc(hidden)]
    pub fn recommendations_restart_scheduler_for_tests(&self, cluster_id: &str) {
        self.start_schedule(cluster_id, true);
    }

    /// Tests: make the next background scan of `cluster_id` due now.
    #[doc(hidden)]
    pub fn recommendations_due_now_for_tests(&self, cluster_id: &str) {
        let wake = {
            let mut schedules = self.recommendations.schedules.lock();
            let Some(schedule) = schedules.get_mut(cluster_id) else {
                return;
            };
            schedule.due_override = Some(now_millis());
            schedule.wake.clone()
        };
        wake.notify_one();
    }
}

/// The scheduler loop of one cluster (see the module docs). It holds the
/// app only while it works, never while it sleeps.
async fn scheduler(app: Weak<Kubepit>, cluster_id: String, generation: u64, wake: Arc<Notify>) {
    loop {
        let Some(strong) = app.upgrade() else {
            return;
        };
        let Some(due) = strong.scan_due(&cluster_id, generation).await else {
            return;
        };
        let now = now_millis();
        if now >= due {
            // A manual scan in progress: its end moves the due time.
            if let Some(claim) = strong.recommendations.claim(&cluster_id) {
                if let Err(e) = run_claimed(strong, claim, ScanTrigger::Schedule).await {
                    tracing::debug!(cluster = %cluster_id, "scheduled recommendation scan ended: {e:#}");
                }
                continue;
            }
        }
        let wait = if now >= due {
            SLICE
        } else {
            Duration::from_millis(u64::try_from(due - now).unwrap_or(0)).min(SLICE)
        };
        drop(strong);
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_due_follows_the_rules() {
        // First connect: 120 s plus the jitter.
        assert_eq!(next_due(1_000, 30_000, None, 3_600_000), 151_000);
        // A failure (or success) waits a full interval.
        assert_eq!(next_due(1_000, 0, Some(10_000), 3_600_000), 3_610_000);
        // Long ago, or after laptop sleep: after the first delay.
        assert_eq!(
            next_due(10_000_000, 0, Some(10_000), 3_600_000),
            10_120_000,
            "long ago: after the first delay"
        );
        // Missed ticks collapse: one due time, not one per interval.
        assert_eq!(next_due(0, 0, Some(1_000), 60_000), 120_000);
    }

    #[test]
    fn jitter_stays_within_a_minute() {
        for _ in 0..1_000 {
            assert!((0..=MAX_JITTER_MS).contains(&jitter_ms()));
        }
    }
}
