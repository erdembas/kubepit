//! Persistent history: the own-action audit log plus (opt-in per cluster)
//! Kubernetes Events and change-journal entries, in a local SQLite database
//! `~/.kubepit/history.db` that never leaves this machine.
//!
//! - **Storage** ([`db`]): WAL mode, versioned migrations, incremental
//!   vacuum. One writer thread ([`writer`]) behind a bounded queue owns all
//!   writes, so commands never wait for the disk; queries use their own
//!   read connection (on the blocking pool at the IPC edge).
//! - **Audit log** ([`audit`], [`audited`]): every mutating command's public
//!   entry point records who (the cached `access_whoami` user), what
//!   (action, targets, redacted request), when, how long, the outcome and —
//!   where a GET or the response gives it cheaply — redacted before/after
//!   objects. Read-only rejections are not recorded; dry runs are, flagged.
//! - **Persistence** ([`persist`]): Events and journal entries of clusters
//!   listed in `Settings.history.persist_clusters`, while connected.
//! - **Retention**: audit and data retention in days plus a size cap,
//!   applied every ten minutes (and after a settings change).
//!
//! Like alerts and the change journal, recording is opt-in per process
//! ([`Kubepit::set_history_recording`]): the desktop shell enables it; tests
//! and headless tools do not, so no audit GETs or watchers change their
//! request logs. Queries and clears work either way.

pub mod audit;
pub mod audited;
pub mod db;
pub mod persist;
pub mod redact;
pub mod types;
pub mod writer;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use kube::Client;
use parking_lot::Mutex;
use rusqlite::Connection;

use crate::app::Kubepit;
use crate::change_journal::normalize::Redactor;
use crate::change_journal::{ChangeDetail, ChangeFilter};
use crate::objects::now_millis;
use crate::tasks::TaskRegistry;
use db::{PrunePolicy, PruneReport};
use writer::{WriteOp, Writer, QUEUE_CAPACITY};

pub use types::*;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Retention runs this often while recording.
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// First retention run after recording starts (keeps startup quiet).
const MAINTENANCE_DELAY: Duration = Duration::from_secs(60);

/// History state owned by [`Kubepit`].
pub struct History {
    path: PathBuf,
    writer: Mutex<Option<Arc<Writer>>>,
    open_error: Mutex<Option<String>>,
    reader: Mutex<Option<Connection>>,
    /// Recording is opt-in per process ([`Kubepit::set_history_recording`]).
    active: AtomicBool,
    /// Username of the last successful `access_whoami` per cluster.
    identities: Mutex<HashMap<String, String>>,
    /// Keyed hashes for Secret values in audit entries (random per process).
    pub(crate) redactor: Redactor,
    recorders: TaskRegistry,
    persisting: Arc<Mutex<HashSet<String>>>,
    maintenance: TaskRegistry,
    /// Copy of `Settings.history` for the retention task.
    settings: Arc<Mutex<HistorySettings>>,
}

fn recorder_id(cluster_id: &str) -> String {
    format!("history:{cluster_id}")
}

const MAINTENANCE_ID: &str = "history:maintenance";

impl History {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            writer: Mutex::new(None),
            open_error: Mutex::new(None),
            reader: Mutex::new(None),
            active: AtomicBool::new(false),
            identities: Mutex::new(HashMap::new()),
            redactor: Redactor::new(),
            recorders: TaskRegistry::default(),
            persisting: Arc::default(),
            maintenance: TaskRegistry::default(),
            settings: Arc::default(),
        }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// The writer, started on first use; `None` (error kept for the status)
    /// when the database cannot be opened.
    fn writer(&self) -> Option<Arc<Writer>> {
        let mut slot = self.writer.lock();
        if let Some(writer) = slot.as_ref() {
            return Some(writer.clone());
        }
        match Writer::start(self.path.clone(), QUEUE_CAPACITY) {
            Ok(writer) => {
                let writer = Arc::new(writer);
                *slot = Some(writer.clone());
                *self.open_error.lock() = None;
                Some(writer)
            }
            Err(e) => {
                tracing::warn!("history database unavailable: {e:#}");
                *self.open_error.lock() = Some(format!("{e:#}"));
                None
            }
        }
    }

    fn require_writer(&self) -> Result<Arc<Writer>> {
        self.writer().ok_or_else(|| {
            anyhow!(
                "the history database is unavailable: {}",
                self.open_error.lock().clone().unwrap_or_default()
            )
        })
    }

    /// Queue a write without waiting; false when it was dropped.
    pub(crate) fn submit(&self, op: WriteOp) -> bool {
        match self.writer() {
            Some(writer) => writer.submit(op),
            None => false,
        }
    }

    /// Run `f` on the read connection (opened, and migrated, on first use).
    fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut slot = self.reader.lock();
        if slot.is_none() {
            *slot = Some(db::open(&self.path)?);
        }
        f(slot.as_ref().expect("opened above"))
    }

    pub fn remember_identity(&self, cluster_id: &str, username: &str) {
        if username.is_empty() {
            return;
        }
        self.identities
            .lock()
            .insert(cluster_id.to_string(), username.to_string());
    }

    pub fn identity(&self, cluster_id: &str) -> Option<String> {
        self.identities.lock().get(cluster_id).cloned()
    }

    /// Stop persisting `cluster_id` (disconnect, removal, opt-out).
    pub fn stop_cluster(&self, cluster_id: &str) {
        self.recorders.stop_cluster(cluster_id);
        self.persisting.lock().remove(cluster_id);
    }

    /// A removed cluster: also forget its identity.
    pub fn forget_cluster(&self, cluster_id: &str) {
        self.stop_cluster(cluster_id);
        self.identities.lock().remove(cluster_id);
    }

    pub fn is_persisting(&self, cluster_id: &str) -> bool {
        self.persisting.lock().contains(cluster_id)
    }

    fn stop_recording(&self) {
        self.recorders.stop_all();
        self.persisting.lock().clear();
        self.maintenance.stop_all();
    }

    /// Stop background work and wait (bounded) for queued writes.
    pub fn shutdown(&self) {
        self.stop_recording();
        if let Some(writer) = self.writer.lock().clone() {
            writer.flush(Duration::from_secs(2));
        }
    }
}

fn policy(settings: &HistorySettings, now: i64) -> PrunePolicy {
    PrunePolicy {
        audit_before: now - i64::from(settings.audit_retention_days) * DAY_MS,
        data_before: now - i64::from(settings.retention_days) * DAY_MS,
        max_bytes: u64::from(settings.max_size_mb) * 1024 * 1024,
    }
}

impl Kubepit {
    /// Turn history recording on or off for this process, like
    /// [`Kubepit::set_change_journal_recording`]: the desktop shell enables
    /// it; tests and headless tools do not. On: opens the database, starts
    /// retention and persistence of connected opted-in clusters (inside a
    /// Tokio runtime). Off: nothing new is recorded.
    pub fn set_history_recording(&self, on: bool) {
        self.history.active.store(on, Ordering::SeqCst);
        if !on {
            self.history.stop_recording();
            return;
        }
        let Some(writer) = self.history.writer() else {
            return;
        };
        *self.history.settings.lock() = self.settings().history;
        if tokio::runtime::Handle::try_current().is_ok() {
            let settings = self.history.settings.clone();
            self.history
                .maintenance
                .spawn(MAINTENANCE_ID, "", async move {
                    tokio::time::sleep(MAINTENANCE_DELAY).await;
                    loop {
                        let current = settings.lock().clone();
                        writer.submit(WriteOp::Prune(policy(&current, now_millis()), None));
                        tokio::time::sleep(MAINTENANCE_INTERVAL).await;
                    }
                });
        }
        self.sync_history();
    }

    /// Called once a connect succeeded: persist the cluster's events and
    /// changes when this process records and the cluster opted in.
    pub(crate) fn start_history_persistence(&self, cluster_id: &str, client: Client) {
        if !self.history.is_active() || !self.settings().history.persists(cluster_id) {
            return;
        }
        let Some(writer) = self.history.writer() else {
            return;
        };
        let persist = persist::Persist {
            cluster_id: cluster_id.to_string(),
            client,
            writer,
            journal: self.change_journals.reader(),
            fallback_namespaces: self
                .cluster_def(cluster_id)
                .map(|c| c.accessible_namespaces)
                .unwrap_or_default(),
        };
        self.history.recorders.stop(&recorder_id(cluster_id));
        self.history
            .persisting
            .lock()
            .insert(cluster_id.to_string());
        self.history.recorders.spawn(
            &recorder_id(cluster_id),
            cluster_id,
            persist::run(Arc::new(persist)),
        );
    }

    /// Start or stop persistence after a settings change and apply the new
    /// retention right away.
    pub(crate) fn sync_history(&self) {
        let settings = self.settings().history;
        *self.history.settings.lock() = settings.clone();
        let active = self.history.is_active();
        let has_runtime = tokio::runtime::Handle::try_current().is_ok();
        for cluster in self.store.clusters() {
            let wanted = active && settings.persists(&cluster.id);
            let running = self.history.is_persisting(&cluster.id);
            if !wanted && running {
                self.history.stop_cluster(&cluster.id);
            } else if wanted && !running && has_runtime {
                if let Some(client) = self.pool.connected_client(&cluster.id) {
                    self.start_history_persistence(&cluster.id, client);
                }
            }
        }
        if active {
            if let Some(writer) = self.history.writer.lock().clone() {
                writer.submit(WriteOp::Prune(policy(&settings, now_millis()), None));
            }
        }
    }

    /// `history_status`.
    pub fn history_status(&self) -> HistoryStatus {
        let mut status = HistoryStatus {
            path: self.history.path.to_string_lossy().to_string(),
            size_bytes: db::size_on_disk(&self.history.path),
            available: false,
            error: self.history.open_error.lock().clone(),
            recording: self.history.is_active(),
            audit: HistoryTableStatus::default(),
            events: HistoryTableStatus::default(),
            changes: HistoryTableStatus::default(),
            dropped: self
                .history
                .writer
                .lock()
                .as_ref()
                .map_or(0, |w| w.stats().dropped.load(Ordering::Relaxed)),
            persisting: {
                let mut ids: Vec<String> = self.history.persisting.lock().iter().cloned().collect();
                ids.sort();
                ids
            },
        };
        let tables = self.history.read(|conn| {
            Ok((
                db::table_status(conn, "audit", "ts")?,
                db::table_status(conn, "events", "last_ts")?,
                db::table_status(conn, "changes", "ts")?,
            ))
        });
        match tables {
            Ok((audit, events, changes)) => {
                status.available = true;
                status.audit = audit;
                status.events = events;
                status.changes = changes;
                // Opening the reader may have created the file.
                status.size_bytes = db::size_on_disk(&self.history.path);
            }
            Err(e) => status.error = Some(format!("{e:#}")),
        }
        status
    }

    /// `history_audit_list`: own actions matching `filter`, newest first.
    pub fn history_audit_list(&self, filter: &AuditFilter) -> Result<AuditPage> {
        self.history.read(|conn| db::list_audit(conn, filter))
    }

    /// `history_audit_get`: one entry with its before/after objects.
    pub fn history_audit_get(&self, id: i64) -> Result<AuditDetail> {
        self.history
            .read(|conn| db::get_audit(conn, id))?
            .ok_or_else(|| anyhow!("audit entry {id} is no longer in the history"))
    }

    /// `history_audit_export`: the filtered entries as JSON lines.
    pub fn history_audit_export(&self, filter: &AuditFilter) -> Result<String> {
        self.history.read(|conn| db::export_audit(conn, filter))
    }

    /// `history_events_list`: persisted Events of a cluster.
    pub fn history_events_list(
        &self,
        cluster_id: &str,
        filter: &HistoryEventFilter,
    ) -> Result<HistoryEventPage> {
        self.history
            .read(|conn| db::list_events(conn, cluster_id, filter))
    }

    /// `history_changes_list`: persisted change-journal entries of a cluster.
    pub fn history_changes_list(
        &self,
        cluster_id: &str,
        filter: &ChangeFilter,
    ) -> Result<HistoryChangePage> {
        self.history
            .read(|conn| db::list_changes(conn, cluster_id, filter))
    }

    /// `history_changes_get`: one persisted entry with its before/after YAML.
    pub fn history_changes_get(&self, cluster_id: &str, id: u64) -> Result<ChangeDetail> {
        self.history
            .read(|conn| db::get_change(conn, cluster_id, id as i64))?
            .ok_or_else(|| anyhow!("change {id} is no longer in the history"))
    }

    /// `history_clear`: delete one kind of data (all clusters or one) and
    /// compact the file. Runs after every write queued before it.
    pub fn history_clear(
        &self,
        kind: HistoryKind,
        cluster_id: Option<&str>,
    ) -> Result<HistoryStatus> {
        self.history
            .require_writer()?
            .clear(kind, cluster_id.map(str::to_string))?;
        Ok(self.history_status())
    }

    /// Apply retention and the size cap now (also runs periodically).
    pub fn history_prune(&self) -> Result<PruneReport> {
        let settings = self.settings().history;
        self.history
            .require_writer()?
            .prune(policy(&settings, now_millis()))
    }

    /// Wait (bounded) until every queued write reached the database.
    pub fn history_flush(&self) -> bool {
        match self.history.writer.lock().clone() {
            Some(writer) => writer.flush(Duration::from_secs(10)),
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_and_normalize() {
        let s = HistorySettings::default();
        assert!(s.audit, "audit log on by default");
        assert!(s.persist_clusters.is_empty(), "persistence is opt-in");
        assert_eq!((s.audit_retention_days, s.retention_days), (90, 7));
        let n = HistorySettings {
            audit_retention_days: 0,
            retention_days: 99_999,
            max_size_mb: 1,
            persist_clusters: vec!["b".into(), " ".into(), "a".into(), "b".into()],
            ..HistorySettings::default()
        }
        .normalized();
        assert_eq!(n.audit_retention_days, 1);
        assert_eq!(n.retention_days, 3650);
        assert_eq!(n.max_size_mb, 16);
        assert_eq!(n.persist_clusters, vec!["a", "b"]);
        assert!(n.persists("a") && !n.persists("c"));
    }

    #[test]
    fn retention_policy_uses_days_and_megabytes() {
        let p = policy(
            &HistorySettings {
                audit_retention_days: 2,
                retention_days: 1,
                max_size_mb: 16,
                ..HistorySettings::default()
            },
            10 * DAY_MS,
        );
        assert_eq!(p.audit_before, 8 * DAY_MS);
        assert_eq!(p.data_before, 9 * DAY_MS);
        assert_eq!(p.max_bytes, 16 * 1024 * 1024);
    }

    #[test]
    fn identities_are_remembered_per_cluster() {
        let dir = tempfile::tempdir().unwrap();
        let h = History::new(dir.path().join("history.db"));
        assert!(!h.is_active(), "off unless a process enables it");
        h.remember_identity("c1", "dev@acme.io");
        h.remember_identity("c2", "");
        assert_eq!(h.identity("c1").as_deref(), Some("dev@acme.io"));
        assert_eq!(h.identity("c2"), None);
        h.forget_cluster("c1");
        assert_eq!(h.identity("c1"), None);
        assert!(!dir.path().join("history.db").exists(), "opened lazily");
    }
}
