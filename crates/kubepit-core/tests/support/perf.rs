//! Shared by the structural probe (`tests/perf_probe.rs`) and the Criterion
//! benches (`benches/*.rs`, which include `support` through `#[path]`): a
//! `Kubepit` wired to a scale fixture server, and the request-log readers
//! that pin watch fan-out and pagination.
//!
//! Only the in-process fake API server on 127.0.0.1 is contacted; paths are
//! explicit temp dirs, so `KUBEPIT_HOME` and `~/.kube` are never read.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use kubepit_core::history::HistorySettings;
use kubepit_core::types::{ClusterInput, Gvk, Settings, WatchBatch};
use kubepit_core::{Kubepit, NullSink, Paths};

use super::scale::is_list_path;
use super::{kubeconfig_for, Log};

/// A `Kubepit` in a temp dir with one cluster pointing at `url`, with the
/// defaults: no accessible namespaces (cluster-wide) and
/// `Settings.change_journal` untouched (on). Background watchers stay off
/// until the caller opts in with the `set_*` switches.
pub fn scale_setup(url: &str) -> (tempfile::TempDir, Arc<Kubepit>, String) {
    let dir = tempfile::tempdir().unwrap();
    let app =
        Arc::new(Kubepit::open(Paths::new(dir.path().join("home")), Arc::new(NullSink)).unwrap());
    let cluster = app
        .cluster_add(vec![ClusterInput {
            name: "Scale".into(),
            context: "fake".into(),
            kubeconfig_text: Some(kubeconfig_for(url)),
            ..Default::default()
        }])
        .unwrap()
        .remove(0);
    (dir, app, cluster.id)
}

/// Opt cluster `id` into persistent history (Events and journal entries);
/// persistence runs once `set_history_recording(true)` and a connect.
pub fn persist_history(app: &Kubepit, id: &str) {
    app.set_settings(Settings {
        history: HistorySettings {
            persist_clusters: vec![id.to_string()],
            ..Default::default()
        },
        ..app.settings()
    })
    .unwrap();
}

pub fn gvk(group: &str, version: &str, kind: &str, plural: &str, namespaced: bool) -> Gvk {
    Gvk {
        group: group.into(),
        version: version.into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced,
    }
}

pub fn pods() -> Gvk {
    gvk("", "v1", "Pod", "pods", true)
}

/// Start a cluster-wide `resource_watch` of `gvk` and wait for its first
/// `synced` batch, acknowledging each batch like the UI; returns the watch
/// id. The watch keeps running (its sink never refuses a batch) until
/// unwatched or disconnected, or until later batches, which nobody
/// acknowledges, fill its window for `watch::ACK_TIMEOUT` (the quiet
/// fixture sends none).
pub async fn wait_synced(app: &Kubepit, id: &str, gvk: &Gvk) -> String {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WatchBatch>();
    let watch = app
        .resource_watch(id, gvk, vec![], move |batch| {
            let _ = tx.send(batch);
            true
        })
        .await
        .unwrap();
    loop {
        let batch = tokio::time::timeout(Duration::from_secs(60), rx.recv())
            .await
            .expect("the watch syncs within 60 s")
            .expect("the watch is running");
        assert!(batch.error.is_none(), "watch error: {:?}", batch.error);
        app.resource_watch_ack(&watch, batch.seq);
        if batch.synced {
            return watch;
        }
    }
}

/// Watch streams opened per resource path: GETs with `watch=true`, keyed by
/// the path without the query.
pub fn watch_streams_per_path(log: &Log) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for req in log.lock().iter() {
        if req.method == "GET" && query_has(&req.path, "watch", Some("true")) {
            *out.entry(req.path_only().to_string()).or_insert(0) += 1;
        }
    }
    out
}

/// List-shaped paths requested without `limit=` (and not as a watch): the
/// unpaged lists, keyed by the path without the query. Paths the fixture
/// does not serve (answered 404) count too.
pub fn unpaged_lists(log: &Log) -> BTreeSet<String> {
    log.lock()
        .iter()
        .filter(|req| req.method == "GET")
        .filter(|req| !query_has(&req.path, "watch", Some("true")))
        .filter(|req| !query_has(&req.path, "limit", None))
        .filter(|req| is_list_path(req.path_only()))
        .map(|req| req.path_only().to_string())
        .collect()
}

/// Whether the query of `path` has parameter `name` (with `value`, if given).
fn query_has(path: &str, name: &str, value: Option<&str>) -> bool {
    let query = path.split_once('?').map_or("", |(_, q)| q);
    query.split('&').any(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        k == name && value.is_none_or(|want| v == want)
    })
}
