//! Alerts: the data behind desktop notifications and the notification
//! center.
//!
//! While a cluster is connected and alerts are enabled for it, one monitor
//! (started after a successful connect, stopped with the connection) watches
//! pods, Jobs, nodes and Deployments with `kube::runtime` watchers and
//! reports **transitions only**: the first list is the baseline and never
//! alerts. Detected reasons:
//!
//! | Kind       | Reason                                               |
//! |------------|------------------------------------------------------|
//! | Pod        | `CrashLoopBackOff`, `OOMKilled`, `ImagePullBackOff` / `ErrImagePull`, `Evicted` |
//! | Job        | `JobFailed` (`Failed` condition)                     |
//! | Node       | `NodeNotReady` (Ready → False/Unknown), `NodePressure` |
//! | Deployment | `ProgressDeadlineExceeded`                           |
//!
//! Cost: watches deserialise only metadata identity and the status fields
//! detection needs (`detect.rs`), keep a compact snapshot per object and
//! never make per-object API calls. Kinds whose reasons are all disabled
//! are not watched; a kind the user may not list (403) is dropped after
//! the first attempt.
//!
//! Alerts are read-only observations, so they run on read-only clusters
//! too. Findings pass the settings filters (reasons, namespace globs), then
//! the [`AlertBook`] (dedupe with cooldown, burst collapse, bounded
//! history) and are pushed through [`EventSink::alert`]. Whether an alert
//! becomes an OS notification (mute, snooze, focus) is decided by the UI,
//! which knows the locale and the window focus.
//!
//! Monitoring is opt-in per process ([`Kubepit::set_alert_monitoring`]): the
//! desktop shell turns it on, tests and headless tools leave it off so no
//! background watches run unless asked for.
//!
//! Findings that no watch detects go through [`AlertCenter::raise`] (the
//! optional `RightsizingSaving` of recommendation scans): the same filters
//! and book, and only while monitoring is on and the cluster is watched.

pub mod book;
pub mod detect;
pub mod model;
mod monitor;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use kube::Client;
use parking_lot::{Mutex, RwLock};

pub use book::AlertBook;
pub use detect::Finding;
pub use model::{
    Alert, AlertEvent, AlertGroup, AlertObjectRef, AlertReason, AlertSettings, AlertSeverity,
    WatchedKind,
};

use crate::app::Kubepit;
use crate::events::EventSink;
use crate::objects::now_millis;
use crate::tasks::TaskRegistry;
use monitor::{spawn_monitor, MonitorCtx};

/// Filter, record and announce one finding: the settings' reason and
/// namespace filters, then the book (dedupe, bursts), then the sink.
/// Returns whether it was recorded.
pub(crate) fn record_finding(
    book: &Mutex<AlertBook>,
    settings: &RwLock<AlertSettings>,
    sink: &dyn EventSink,
    cluster_id: &str,
    object: AlertObjectRef,
    finding: Finding,
) -> bool {
    let recorded = settings
        .read()
        .records(finding.reason, object.namespace.as_deref());
    if !recorded {
        return false;
    }
    let event = book
        .lock()
        .record(cluster_id, object, finding, now_millis());
    sink.alert(&event);
    true
}

/// Alert state owned by [`Kubepit`].
pub struct AlertCenter {
    book: Arc<Mutex<AlertBook>>,
    settings: Arc<RwLock<AlertSettings>>,
    monitors: TaskRegistry,
    /// Clusters with a running monitor and the kinds it watches.
    running: Mutex<HashMap<String, Vec<WatchedKind>>>,
    active: AtomicBool,
}

impl AlertCenter {
    pub fn new(settings: AlertSettings) -> Self {
        Self {
            book: Arc::default(),
            settings: Arc::new(RwLock::new(settings)),
            monitors: TaskRegistry::default(),
            running: Mutex::default(),
            active: AtomicBool::new(false),
        }
    }

    fn stop_cluster(&self, cluster_id: &str) {
        self.monitors.stop_cluster(cluster_id);
        self.running.lock().remove(cluster_id);
    }

    pub(crate) fn stop_all(&self) {
        self.monitors.stop_all();
        self.running.lock().clear();
    }

    /// Alert monitoring is on in this process
    /// ([`Kubepit::set_alert_monitoring`]).
    pub fn monitoring(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Raise a finding no watch detects (a recommendation scan's
    /// `RightsizingSaving`) through the same filters, book and sink as the
    /// monitors: only while monitoring is on in this process and alerts
    /// are enabled for `cluster_id`. Returns whether it was recorded.
    pub fn raise(
        &self,
        sink: &dyn EventSink,
        cluster_id: &str,
        object: AlertObjectRef,
        finding: Finding,
    ) -> bool {
        if !self.monitoring() || !self.settings.read().monitors(cluster_id) {
            return false;
        }
        record_finding(
            &self.book,
            &self.settings,
            sink,
            cluster_id,
            object,
            finding,
        )
    }
}

impl Kubepit {
    /// Turn alert monitoring on or off for this process. On: clusters that
    /// connect from now on are monitored (and connected ones right away
    /// when called inside a Tokio runtime). Off: every monitor stops; the
    /// history is kept.
    pub fn set_alert_monitoring(&self, on: bool) {
        self.alerts.active.store(on, Ordering::SeqCst);
        if !on {
            self.alerts.stop_all();
            return;
        }
        if tokio::runtime::Handle::try_current().is_ok() {
            let settings = self.alerts.settings.read().clone();
            self.reconcile_alert_monitors(&settings);
        }
    }

    /// Called once a connect succeeded; restarts the cluster's monitor with
    /// a fresh baseline.
    pub(crate) fn start_alert_monitor(&self, cluster_id: &str, client: Client) {
        if !self.alerts.active.load(Ordering::SeqCst) {
            return;
        }
        let settings = self.alerts.settings.read().clone();
        if !settings.monitors(cluster_id) {
            return;
        }
        let kinds = settings.watched_kinds();
        let namespaces = self
            .cluster_def(cluster_id)
            .map(|c| c.accessible_namespaces)
            .unwrap_or_default();
        self.alerts.stop_cluster(cluster_id);
        let ctx = Arc::new(MonitorCtx {
            cluster_id: cluster_id.to_string(),
            book: self.alerts.book.clone(),
            settings: self.alerts.settings.clone(),
            sink: self.sink.clone(),
        });
        spawn_monitor(&self.alerts.monitors, ctx, &client, &kinds, &namespaces);
        self.alerts
            .running
            .lock()
            .insert(cluster_id.to_string(), kinds);
    }

    /// Disconnect: stop watching, keep the cluster's alerts.
    pub(crate) fn stop_alert_monitor(&self, cluster_id: &str) {
        self.alerts.stop_cluster(cluster_id);
    }

    /// Cluster removed: its alerts go too.
    pub(crate) fn forget_alerts(&self, cluster_id: &str) {
        self.alerts.stop_cluster(cluster_id);
        if self.alerts.book.lock().remove_cluster(cluster_id) > 0 {
            self.sink.alerts_changed();
        }
    }

    /// `settings_set`: new filters apply to the next finding; monitors
    /// start, stop or restart when a cluster's switch or the watched kinds
    /// changed.
    pub(crate) fn apply_alert_settings(&self, settings: &AlertSettings) {
        *self.alerts.settings.write() = settings.clone();
        if self.alerts.active.load(Ordering::SeqCst) {
            self.reconcile_alert_monitors(settings);
        }
    }

    fn reconcile_alert_monitors(&self, settings: &AlertSettings) {
        for cluster in self.store.clusters() {
            let want = settings
                .monitors(&cluster.id)
                .then(|| settings.watched_kinds());
            let have = self.alerts.running.lock().get(&cluster.id).cloned();
            match (want, have) {
                (Some(want), Some(have)) if want == have => {}
                (Some(_), _) => {
                    if let Some(client) = self.pool.connected_client(&cluster.id) {
                        self.start_alert_monitor(&cluster.id, client);
                    }
                }
                (None, Some(_)) => self.alerts.stop_cluster(&cluster.id),
                (None, None) => {}
            }
        }
    }

    /// Clusters with a running monitor (diagnostics and tests).
    pub fn alert_monitored_clusters(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.alerts.running.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// `alerts_list`: every alert, newest activity first.
    pub fn alerts_list(&self) -> Vec<Alert> {
        self.alerts.book.lock().list()
    }

    /// `alerts_mark_read`: `None` marks everything read.
    pub fn alerts_mark_read(&self, ids: Option<Vec<String>>) -> usize {
        let changed = self.alerts.book.lock().mark_read(ids.as_deref());
        if changed > 0 {
            self.sink.alerts_changed();
        }
        changed
    }

    /// `alerts_clear`: `None` clears everything.
    pub fn alerts_clear(&self, ids: Option<Vec<String>>) -> usize {
        let removed = self.alerts.book.lock().clear(ids.as_deref());
        if removed > 0 {
            self.sink.alerts_changed();
        }
        removed
    }
}
