//! Guard: connecting starts no background traffic unless the process opted
//! in (`Kubepit::set_*` switches; only the desktop shell turns them on).
//! Runs against the fake API server in `support/`; no real cluster.

mod support;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use kubepit_core::history::HistorySettings;
use kubepit_core::types::{ClusterInput, Settings};
use kubepit_core::{Kubepit, Paths};
use serde_json::{json, Value};
use support::{kubeconfig_for, start, Log, Recorder, Reply, Request, Router};

fn resources(group_version: &str, resources: &[(&str, &str, bool)]) -> Reply {
    let resources: Vec<Value> = resources
        .iter()
        .map(|(name, kind, namespaced)| {
            json!({"name": name, "singularName": "", "namespaced": namespaced, "kind": kind,
                   "verbs": ["get", "list", "watch"]})
        })
        .collect();
    Reply::Json(
        200,
        json!({"kind": "APIResourceList", "groupVersion": group_version, "resources": resources}),
    )
}

fn group(name: &str, version: &str) -> Value {
    let gv = format!("{name}/{version}");
    json!({"name": name, "versions": [{"groupVersion": gv, "version": version}],
           "preferredVersion": {"groupVersion": gv, "version": version}})
}

/// Answers discovery, empty lists and quiet watches for every path.
fn quiet_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        if req.path.contains("watch=true") {
            return Reply::Stream(vec![]);
        }
        match req.path_only() {
            "/version" => Reply::Json(
                200,
                json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
                       "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
                       "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
            ),
            "/apis" => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": [
                    group("apps", "v1"), group("batch", "v1"), group("metrics.k8s.io", "v1beta1")
                ]}),
            ),
            "/api" => Reply::Json(
                200,
                json!({"kind": "APIVersions", "versions": ["v1"], "serverAddressByClientCIDRs": []}),
            ),
            "/api/v1" => resources(
                "v1",
                &[
                    ("pods", "Pod", true),
                    ("nodes", "Node", false),
                    ("events", "Event", true),
                    ("configmaps", "ConfigMap", true),
                ],
            ),
            "/apis/apps/v1" => resources("apps/v1", &[("deployments", "Deployment", true)]),
            "/apis/batch/v1" => resources("batch/v1", &[("jobs", "Job", true)]),
            "/apis/metrics.k8s.io/v1beta1" => resources(
                "metrics.k8s.io/v1beta1",
                &[
                    ("nodes", "NodeMetrics", false),
                    ("pods", "PodMetrics", true),
                ],
            ),
            // Every other GET is a list: empty.
            _ => Reply::Json(
                200,
                json!({"kind": "List", "apiVersion": "v1",
                       "metadata": {"resourceVersion": "1"}, "items": []}),
            ),
        }
    })
}

/// Like `support::setup`, but with the defaults: no accessible namespaces
/// (cluster-wide) and `Settings.change_journal` untouched.
fn setup_defaults(url: &str) -> (tempfile::TempDir, Arc<Kubepit>, String) {
    let dir = tempfile::tempdir().unwrap();
    let app = Arc::new(
        Kubepit::open(
            Paths::new(dir.path().join("home")),
            Arc::new(Recorder::default()),
        )
        .unwrap(),
    );
    let cluster = app
        .cluster_add(vec![ClusterInput {
            name: "Quiet".into(),
            context: "fake".into(),
            kubeconfig_text: Some(kubeconfig_for(url)),
            ..Default::default()
        }])
        .unwrap()
        .remove(0);
    (dir, app, cluster.id)
}

fn seen(log: &Log) -> BTreeSet<String> {
    log.lock()
        .iter()
        .map(|r| format!("{} {}", r.method, r.path_only()))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_starts_no_background_work_unless_opted_in() {
    let server = start(quiet_router()).await;
    let (_dir, app, id) = setup_defaults(&server.url);
    assert!(!app.metrics_sampling());
    app.cluster_connect(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(
        seen(&server.log),
        BTreeSet::from(["GET /apis".to_string(), "GET /version".to_string()])
    );
    assert!(app.alert_monitored_clusters().is_empty());
    assert!(!app.history_status().recording);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_opt_in_starts_its_own_traffic() {
    let server = start(quiet_router()).await;
    let (_dir, app, id) = setup_defaults(&server.url);
    app.set_metrics_sampling(true);
    assert!(app.metrics_sampling());
    app.set_alert_monitoring(true);
    app.set_change_journal_recording(true);
    app.set_history_recording(true);
    app.set_settings(Settings {
        history: HistorySettings {
            persist_clusters: vec![id.clone()],
            ..Default::default()
        },
        ..app.settings()
    })
    .unwrap();
    app.cluster_connect(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let paths = seen(&server.log);
    for expected in [
        // metrics sampling
        "GET /apis/metrics.k8s.io/v1beta1/nodes",
        // alert monitoring
        "GET /api/v1/pods",
        // change journal (and alerts)
        "GET /apis/apps/v1/deployments",
        // change journal only
        "GET /api/v1/configmaps",
        // persistent history
        "GET /api/v1/events",
    ] {
        assert!(paths.contains(expected), "missing {expected} in {paths:#?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_metrics_sampling_off_stops_the_samplers() {
    let server = start(quiet_router()).await;
    let (_dir, app, id) = setup_defaults(&server.url);
    app.set_metrics_sampling(true);
    app.cluster_connect(&id).await.unwrap();
    assert!(
        !app.metrics_history_fleet().is_empty(),
        "sampled once connected"
    );
    app.set_metrics_sampling(false);
    assert!(!app.metrics_sampling());
    assert!(app.metrics_history_fleet().is_empty(), "histories dropped");
}
