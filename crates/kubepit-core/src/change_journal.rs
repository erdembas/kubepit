//! Change journal: "what changed in the last hour?"
//!
//! While a cluster is connected (and the `change_journal` setting allows
//! it), one recorder task watches [`JOURNALED_KINDS`] cluster-wide with
//! `kube::runtime` watchers and records every addition, modification and
//! deletion into an in-memory [`ClusterJournal`]. Like the metrics history,
//! it starts after a successful connect and stops (dropping the journal)
//! on disconnect, removal, shutdown or when the settings turn it off.
//!
//! - The initial list of every kind is only the baseline; nothing is
//!   journaled until something changes afterwards.
//! - A kind the user cannot list cluster-wide is retried in the cluster's
//!   configured `accessible_namespaces`; kinds that stay forbidden or are
//!   not served are skipped and reported in the status, never retried.
//! - Noise (status, resourceVersion, heartbeats, …) is normalized away and
//!   Secret values are never stored — see [`normalize`].
//! - Memory only: bounded per cluster by age (24 h), count (5 000 entries),
//!   bytes (32 MiB of entries) and a per-entry body cap (64 KiB). The
//!   baseline holds one compact JSON string per watched object, roughly
//!   what an informer cache would hold.

pub mod diff;
pub mod journal;
pub mod normalize;
pub mod types;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use futures::StreamExt;
use kube::api::DynamicObject;
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use kube::Client;
use parking_lot::Mutex;
use tokio::task::JoinSet;

use crate::app::Kubepit;
use crate::error::{watcher_error_code, watcher_error_message};
use crate::objects::{api_resource, dynamic_api, fill_type_meta, now_millis, object_key};
use crate::tasks::TaskRegistry;
use crate::types::{Gvk, Settings};

pub use journal::{ClusterJournal, JournalLimits, Prepared};
pub use normalize::Redactor;
pub use types::*;

/// A kind the journal records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindSpec {
    pub group: &'static str,
    pub version: &'static str,
    pub kind: &'static str,
    pub plural: &'static str,
    pub namespaced: bool,
}

impl KindSpec {
    pub fn gvk(&self) -> Gvk {
        Gvk {
            group: self.group.to_string(),
            version: self.version.to_string(),
            kind: self.kind.to_string(),
            plural: self.plural.to_string(),
            namespaced: self.namespaced,
        }
    }
}

const fn spec(
    group: &'static str,
    version: &'static str,
    kind: &'static str,
    plural: &'static str,
    namespaced: bool,
) -> KindSpec {
    KindSpec {
        group,
        version,
        kind,
        plural,
        namespaced,
    }
}

/// What the journal watches, in display order.
pub const JOURNALED_KINDS: &[KindSpec] = &[
    spec("apps", "v1", "Deployment", "deployments", true),
    spec("apps", "v1", "StatefulSet", "statefulsets", true),
    spec("apps", "v1", "DaemonSet", "daemonsets", true),
    spec("batch", "v1", "CronJob", "cronjobs", true),
    spec("", "v1", "Service", "services", true),
    spec("networking.k8s.io", "v1", "Ingress", "ingresses", true),
    spec("", "v1", "ConfigMap", "configmaps", true),
    spec("", "v1", "Secret", "secrets", true),
    spec(
        "autoscaling",
        "v2",
        "HorizontalPodAutoscaler",
        "horizontalpodautoscalers",
        true,
    ),
    spec(
        "policy",
        "v1",
        "PodDisruptionBudget",
        "poddisruptionbudgets",
        true,
    ),
    spec(
        "networking.k8s.io",
        "v1",
        "NetworkPolicy",
        "networkpolicies",
        true,
    ),
    spec("", "v1", "Namespace", "namespaces", false),
    spec("", "v1", "Node", "nodes", false),
    spec("rbac.authorization.k8s.io", "v1", "Role", "roles", true),
    spec(
        "rbac.authorization.k8s.io",
        "v1",
        "RoleBinding",
        "rolebindings",
        true,
    ),
    spec(
        "rbac.authorization.k8s.io",
        "v1",
        "ClusterRole",
        "clusterroles",
        false,
    ),
    spec(
        "rbac.authorization.k8s.io",
        "v1",
        "ClusterRoleBinding",
        "clusterrolebindings",
        false,
    ),
];

/// Whether `settings` let the journal record `cluster_id`.
pub fn journal_enabled(settings: &Settings, cluster_id: &str) -> bool {
    settings.change_journal
        && !settings
            .change_journal_disabled
            .iter()
            .any(|id| id == cluster_id)
}

/// Turn a watched object into what the journal keeps; `None` for objects
/// that are never journaled. Secret values are hashed here and dropped
/// with `obj`.
pub fn prepare(gvk: &Arc<Gvk>, obj: DynamicObject, redactor: &Redactor) -> Option<Prepared> {
    let key = object_key(&obj);
    let namespace = obj.metadata.namespace.clone();
    let name = obj.metadata.name.clone().unwrap_or_default();
    let uid = obj.metadata.uid.clone().unwrap_or_default();
    let mut raw = serde_json::to_value(&obj).ok()?;
    drop(obj);
    fill_type_meta(&mut raw, &api_resource(gvk));
    if normalize::is_ignored(gvk, &raw) {
        return None;
    }
    let actor = normalize::actor(&raw);
    let object = normalize::normalize(gvk, &raw, redactor);
    Some(Prepared {
        key,
        gvk: gvk.clone(),
        namespace,
        name,
        uid,
        object,
        actor,
    })
}

struct Slot {
    generation: u64,
    journal: ClusterJournal,
}

type Journals = Arc<Mutex<HashMap<String, Slot>>>;

/// Every recording cluster's journal plus its recorder task.
#[derive(Default)]
pub struct ChangeJournals {
    journals: Journals,
    recorders: TaskRegistry,
    generation: AtomicU64,
    /// Recording is opt-in per process ([`Kubepit::set_change_journal_recording`]).
    active: AtomicBool,
}

fn recorder_id(cluster_id: &str) -> String {
    format!("change-journal:{cluster_id}")
}

impl ChangeJournals {
    /// (Re)start recording `cluster_id`; any previous journal is dropped.
    /// `fallback_namespaces` are tried for kinds that are forbidden
    /// cluster-wide.
    pub fn start(
        &self,
        cluster_id: &str,
        client: Client,
        fallback_namespaces: Vec<String>,
        limits: JournalLimits,
    ) {
        self.recorders.stop(&recorder_id(cluster_id));
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let mut journal = ClusterJournal::new(cluster_id, now_millis(), limits);
        for kind in JOURNALED_KINDS {
            journal.register_kind(kind.kind);
        }
        self.journals.lock().insert(
            cluster_id.to_string(),
            Slot {
                generation,
                journal,
            },
        );
        let recorder = Recorder {
            cluster_id: cluster_id.to_string(),
            generation,
            journals: self.journals.clone(),
            client,
            redactor: Redactor::new(),
        };
        self.recorders.spawn(
            &recorder_id(cluster_id),
            cluster_id,
            run_recorder(Arc::new(recorder), fallback_namespaces),
        );
    }

    /// Stop recording and drop the journal (disconnect, removal, opt-out).
    pub fn stop_cluster(&self, cluster_id: &str) {
        self.recorders.stop_cluster(cluster_id);
        self.journals.lock().remove(cluster_id);
    }

    pub fn stop_all(&self) {
        self.recorders.stop_all();
        self.journals.lock().clear();
    }

    pub fn is_recording(&self, cluster_id: &str) -> bool {
        self.journals.lock().contains_key(cluster_id)
    }

    fn with<T>(&self, cluster_id: &str, f: impl FnOnce(&mut ClusterJournal) -> T) -> Option<T> {
        self.journals
            .lock()
            .get_mut(cluster_id)
            .map(|slot| f(&mut slot.journal))
    }
}

/// Read access to every journal for background tasks (history persistence
/// copies new entries to disk).
#[derive(Clone)]
pub struct JournalReader {
    journals: Journals,
}

impl JournalReader {
    /// The journal's start time and up to `limit` entries newer than
    /// `after` (oldest first); `None` while `cluster_id` is not recording.
    pub fn details_after(
        &self,
        cluster_id: &str,
        after: u64,
        limit: usize,
    ) -> Option<(i64, Vec<ChangeDetail>)> {
        let journals = self.journals.lock();
        let journal = &journals.get(cluster_id)?.journal;
        let started = journal.started_at();
        Some((started, journal.details_after(after, limit)))
    }
}

impl ChangeJournals {
    pub fn reader(&self) -> JournalReader {
        JournalReader {
            journals: self.journals.clone(),
        }
    }
}

/// What one recorder task needs; shared by its watcher tasks.
struct Recorder {
    cluster_id: String,
    generation: u64,
    journals: Journals,
    client: Client,
    redactor: Redactor,
}

impl Recorder {
    /// Apply `f` to the journal, unless it was stopped or replaced (a
    /// watcher racing a restart must not write into the new journal).
    fn update(&self, f: impl FnOnce(&mut ClusterJournal)) {
        let mut journals = self.journals.lock();
        if let Some(slot) = journals.get_mut(&self.cluster_id) {
            if slot.generation == self.generation {
                f(&mut slot.journal);
            }
        }
    }

    fn fold(&self, source: &str, gvk: &Arc<Gvk>, event: Event<DynamicObject>) {
        let ts = now_millis();
        match event {
            Event::Init => self.update(|j| j.begin_list(source)),
            Event::InitApply(obj) => {
                if let Some(item) = prepare(gvk, obj, &self.redactor) {
                    self.update(|j| j.list_item(source, item, ts));
                }
            }
            Event::InitDone => self.update(|j| j.end_list(source, ts)),
            Event::Apply(obj) => {
                if let Some(item) = prepare(gvk, obj, &self.redactor) {
                    self.update(|j| j.apply(source, item, ts));
                }
            }
            Event::Delete(obj) => {
                if let Some(item) = prepare(gvk, obj, &self.redactor) {
                    self.update(|j| j.delete(source, item, ts));
                }
            }
        }
    }
}

fn source_id(kind: &KindSpec, namespace: Option<&str>) -> String {
    let resource = if kind.group.is_empty() {
        kind.plural.to_string()
    } else {
        format!("{}.{}", kind.plural, kind.group)
    };
    format!("{resource}@{}", namespace.unwrap_or("*"))
}

/// Why a watcher gave up before its first complete list.
struct SourceEnd {
    kind: &'static KindSpec,
    namespace: Option<String>,
    /// HTTP status (403 forbidden, 404/405 not served); `None` = the
    /// stream ended on its own.
    code: Option<u16>,
    message: String,
}

/// One watcher: runs until its stream ends, or returns early when the very
/// first list is forbidden / not served (retrying those would only spam
/// the API server).
async fn run_source(
    recorder: Arc<Recorder>,
    kind: &'static KindSpec,
    namespace: Option<String>,
) -> SourceEnd {
    let gvk = Arc::new(kind.gvk());
    let ar = api_resource(&gvk);
    let api = dynamic_api(
        recorder.client.clone(),
        &ar,
        kind.namespaced,
        namespace.as_deref(),
    );
    let source = source_id(kind, namespace.as_deref());
    recorder.update(|j| j.register_source(&source, kind.kind));
    let mut stream = watcher::watcher(api, watcher::Config::default().any_semantic())
        .default_backoff()
        .boxed();
    let mut synced = false;
    while let Some(item) = stream.next().await {
        match item {
            Ok(event) => {
                synced |= matches!(event, Event::InitDone);
                recorder.fold(&source, &gvk, event);
            }
            Err(err) => {
                let message = watcher_error_message(&err);
                let code = watcher_error_code(&err);
                if !synced && matches!(code, Some(403..=405)) {
                    recorder.update(|j| j.remove_source(&source));
                    return SourceEnd {
                        kind,
                        namespace,
                        code,
                        message,
                    };
                }
                tracing::debug!(cluster = %recorder.cluster_id, "change journal {source}: {message}");
                recorder.update(|j| j.source_error(&source, message));
            }
        }
    }
    SourceEnd {
        kind,
        namespace,
        code: None,
        message: String::new(),
    }
}

/// The recorder of one cluster: a watcher per kind, falling back to the
/// configured namespaces for kinds forbidden cluster-wide. Dropping this
/// future (abort) drops the `JoinSet`, which aborts every watcher.
async fn run_recorder(recorder: Arc<Recorder>, fallback_namespaces: Vec<String>) {
    let mut watchers = JoinSet::new();
    for kind in JOURNALED_KINDS {
        watchers.spawn(run_source(recorder.clone(), kind, None));
    }
    // Namespaced sources still running per kind (fallback mode).
    let mut remaining: HashMap<&'static str, usize> = HashMap::new();
    while let Some(joined) = watchers.join_next().await {
        let Ok(end) = joined else { continue };
        let Some(code) = end.code else { continue };
        let kind = end.kind;
        match end.namespace {
            None if code == 403 && kind.namespaced && !fallback_namespaces.is_empty() => {
                remaining.insert(kind.kind, fallback_namespaces.len());
                for ns in &fallback_namespaces {
                    watchers.spawn(run_source(recorder.clone(), kind, Some(ns.clone())));
                }
            }
            None => {
                recorder.update(|j| j.set_kind_state(kind.kind, state_for(code), Some(end.message)))
            }
            Some(_) => {
                let left = remaining.entry(kind.kind).or_insert(1);
                *left = left.saturating_sub(1);
                if *left == 0 {
                    recorder.update(|j| {
                        j.set_kind_state(kind.kind, state_for(code), Some(end.message))
                    });
                }
            }
        }
    }
}

fn state_for(code: u16) -> ChangeKindState {
    if code == 403 {
        ChangeKindState::Forbidden
    } else {
        ChangeKindState::NotServed
    }
}

impl Kubepit {
    /// Turn change recording on or off for this process, like
    /// [`Kubepit::set_alert_monitoring`]: the desktop shell enables it, tests
    /// and headless tools do not, so request logs stay deterministic. On:
    /// connected clusters the settings allow start recording (inside a Tokio
    /// runtime). Off: every recorder stops.
    pub fn set_change_journal_recording(&self, on: bool) {
        self.change_journals.active.store(on, Ordering::SeqCst);
        if on {
            self.sync_change_journals();
        } else {
            self.change_journals.stop_all();
        }
    }

    /// Called once a connect succeeded (and when the settings turn the
    /// journal on for a connected cluster).
    pub(crate) fn start_change_journal(&self, cluster_id: &str, client: Client) {
        if !self.change_journals.active.load(Ordering::SeqCst)
            || !journal_enabled(&self.settings(), cluster_id)
        {
            return;
        }
        let namespaces = self
            .cluster_def(cluster_id)
            .map(|c| c.accessible_namespaces)
            .unwrap_or_default();
        self.change_journals
            .start(cluster_id, client, namespaces, JournalLimits::default());
    }

    /// Start or stop journals of connected clusters after a settings change.
    pub(crate) fn sync_change_journals(&self) {
        let settings = self.settings();
        let has_runtime = tokio::runtime::Handle::try_current().is_ok();
        for cluster in self.store.clusters() {
            let enabled = self.change_journals.active.load(Ordering::SeqCst)
                && journal_enabled(&settings, &cluster.id);
            let recording = self.change_journals.is_recording(&cluster.id);
            if !enabled && recording {
                self.change_journals.stop_cluster(&cluster.id);
            } else if enabled && !recording && has_runtime {
                if let Some(client) = self.pool.connected_client(&cluster.id) {
                    self.start_change_journal(&cluster.id, client);
                }
            }
        }
    }

    /// `changes_list`: journal entries matching `filter`, newest first.
    pub fn changes_list(&self, cluster_id: &str, filter: &ChangeFilter) -> Result<ChangePage> {
        self.cluster_def(cluster_id)?;
        let enabled = journal_enabled(&self.settings(), cluster_id);
        let page = self.change_journals.with(cluster_id, |j| {
            let (entries, next_cursor) = j.query(filter, now_millis());
            let mut status = j.status();
            status.enabled = enabled;
            ChangePage {
                entries,
                next_cursor,
                status,
            }
        });
        Ok(page.unwrap_or_else(|| ChangePage {
            entries: Vec::new(),
            next_cursor: None,
            status: ChangeJournalStatus::idle(enabled),
        }))
    }

    /// `changes_get`: one entry with its normalized before/after YAML.
    pub fn changes_get(&self, cluster_id: &str, id: u64) -> Result<ChangeDetail> {
        self.cluster_def(cluster_id)?;
        self.change_journals
            .with(cluster_id, |j| j.detail(id))
            .flatten()
            .ok_or_else(|| anyhow!("change {id} is no longer in the journal"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_journaled_kind_has_a_unique_source_and_name() {
        let mut ids: Vec<String> = JOURNALED_KINDS.iter().map(|k| source_id(k, None)).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), JOURNALED_KINDS.len());
        assert_eq!(
            source_id(&JOURNALED_KINDS[0], Some("shop")),
            "deployments.apps@shop"
        );
        assert_eq!(source_id(&JOURNALED_KINDS[6], None), "configmaps@*");
    }

    #[test]
    fn settings_enable_globally_with_per_cluster_opt_out() {
        let mut settings = Settings::default();
        assert!(settings.change_journal, "on by default");
        assert!(journal_enabled(&settings, "c1"));
        settings.change_journal_disabled = vec!["c1".into()];
        assert!(!journal_enabled(&settings, "c1"));
        assert!(journal_enabled(&settings, "c2"));
        settings.change_journal = false;
        assert!(!journal_enabled(&settings, "c2"));
    }

    #[test]
    fn prepare_extracts_actor_and_redacts_before_dropping_the_object() {
        let gvk = Arc::new(JOURNALED_KINDS[7].gvk());
        assert_eq!(gvk.kind, "Secret");
        let obj: DynamicObject = serde_json::from_value(json!({
            "metadata": {"name": "db", "namespace": "shop", "uid": "u-1",
                "managedFields": [{"manager": "external-secrets", "operation": "Update",
                                   "time": "2024-01-01T00:00:00Z"}]},
            "type": "Opaque",
            "data": {"PASSWORD": "aHVudGVyMg=="}
        }))
        .unwrap();
        let item = prepare(&gvk, obj, &Redactor::new()).unwrap();
        assert_eq!(item.key, "u-1");
        assert_eq!(item.actor.unwrap().manager, "external-secrets");
        assert_eq!(item.object["kind"], "Secret");
        assert_eq!(item.object["apiVersion"], "v1");
        assert!(!item.object.to_string().contains("aHVudGVyMg=="));

        let helm: DynamicObject = serde_json::from_value(json!({
            "metadata": {"name": "sh.helm.release.v1.web.v1", "namespace": "shop"},
            "type": "helm.sh/release.v1", "data": {"release": "H4sI"}
        }))
        .unwrap();
        assert!(prepare(&gvk, helm, &Redactor::new()).is_none());
    }
}
