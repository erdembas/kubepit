//! End-to-end test of the alert monitor against the fake API server in
//! `support/`: real `kube::runtime` watchers list the baseline, then watch
//! streams deliver transitions. No real cluster is involved.

mod support;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use kubepit_core::alerts::{AlertEvent, AlertReason};
use kubepit_core::types::{ClusterDef, ClusterInput, ClusterStatus, ConnState, PortForward};
use kubepit_core::{EventSink, Kubepit, Paths};
use parking_lot::Mutex;
use serde_json::{json, Value};
use support::{kubeconfig_for, start, status, Log, Reply, Request, Router};

#[derive(Default)]
struct AlertRecorder {
    alerts: Mutex<Vec<AlertEvent>>,
    changed: Mutex<usize>,
}

impl EventSink for AlertRecorder {
    fn cluster_status(&self, _status: &ClusterStatus) {}
    fn cluster_list(&self, _clusters: &[ClusterDef]) {}
    fn port_forwards(&self, _forwards: &[PortForward]) {}
    fn alert(&self, event: &AlertEvent) {
        self.alerts.lock().push(event.clone());
    }
    fn alerts_changed(&self) {
        *self.changed.lock() += 1;
    }
}

fn setup(
    server: &str,
    read_only: bool,
) -> (tempfile::TempDir, Arc<Kubepit>, Arc<AlertRecorder>, String) {
    let dir = tempfile::tempdir().unwrap();
    let recorder = Arc::new(AlertRecorder::default());
    let app =
        Arc::new(Kubepit::open(Paths::new(dir.path().join("home")), recorder.clone()).unwrap());
    let cluster = app
        .cluster_add(vec![ClusterInput {
            name: "Fake".into(),
            context: "fake".into(),
            kubeconfig_text: Some(kubeconfig_for(server)),
            read_only,
            ..Default::default()
        }])
        .unwrap()
        .remove(0);
    (dir, app, recorder, cluster.id)
}

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn meta(name: &str, namespace: Option<&str>, rv: &str) -> Value {
    let mut m = json!({"name": name, "uid": format!("uid-{name}"), "resourceVersion": rv,
                       "managedFields": [{"manager": "kubelet"}]});
    if let Some(ns) = namespace {
        m["namespace"] = json!(ns);
    }
    m
}

fn pod(name: &str, rv: &str, state: Value) -> Value {
    json!({"apiVersion": "v1", "kind": "Pod", "metadata": meta(name, Some("shop"), rv),
           "spec": {"containers": [{"name": "app", "image": "web:1"}]},
           "status": {"phase": "Running", "containerStatuses": [
               {"name": "app", "restartCount": 2, "state": state}]}})
}

fn crashing() -> Value {
    json!({"waiting": {"reason": "CrashLoopBackOff",
                       "message": "back-off 40s restarting failed container=app"}})
}

fn running() -> Value {
    json!({"running": {"startedAt": "2024-01-01T00:00:00Z"}})
}

fn node(ready: &str, rv: &str) -> Value {
    json!({"apiVersion": "v1", "kind": "Node", "metadata": meta("n1", None, rv),
           "status": {"conditions": [{"type": "Ready", "status": ready, "reason": "KubeletNotReady",
                                      "message": "container runtime is down"}]}})
}

fn job(failed: bool, rv: &str) -> Value {
    let conditions = if failed {
        json!([{"type": "Failed", "status": "True", "reason": "BackoffLimitExceeded",
                "message": "Job has reached the specified backoff limit"}])
    } else {
        json!([])
    };
    json!({"apiVersion": "batch/v1", "kind": "Job", "metadata": meta("nightly", Some("batch"), rv),
           "status": {"conditions": conditions}})
}

fn deployment(stuck: bool, rv: &str) -> Value {
    let reason = if stuck {
        "ProgressDeadlineExceeded"
    } else {
        "NewReplicaSetAvailable"
    };
    json!({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": meta("web", Some("shop"), rv),
           "status": {"conditions": [{"type": "Progressing", "status": if stuck { "False" } else { "True" },
                                      "reason": reason, "message": "ReplicaSet \"web-7d4\" has timed out progressing."}]}})
}

fn list(kind: &str, items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": format!("{kind}List"), "apiVersion": "v1",
               "metadata": {"resourceVersion": "10"}, "items": items}),
    )
}

/// First watch of a path streams `events`; re-watches stay quiet.
fn watch_once(log: &Log, path: &str, events: Vec<Value>) -> Reply {
    let earlier = log
        .lock()
        .iter()
        .filter(|r| r.path.starts_with(&format!("{path}?")) && r.path.contains("watch=true"))
        .count();
    Reply::Stream(if earlier == 0 { events } else { Vec::new() })
}

fn router() -> Router {
    Arc::new(|req: &Request, log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        let watching = query.contains("watch=true");
        match (req.method.as_str(), path, watching) {
            ("GET", "/version", _) => version(),
            ("GET", "/apis", _) => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            // Baseline: web-1 healthy, api-0 already crash-looping.
            ("GET", "/api/v1/pods", false) => list(
                "Pod",
                vec![pod("web-1", "5", running()), pod("api-0", "6", crashing())],
            ),
            ("GET", "/api/v1/pods", true) => watch_once(
                log,
                path,
                vec![
                    json!({"type": "MODIFIED", "object": pod("api-0", "11", crashing())}),
                    json!({"type": "MODIFIED", "object": pod("web-1", "12", crashing())}),
                    // A repeat within the cooldown merges into the same alert.
                    json!({"type": "MODIFIED", "object": pod("web-1", "13", running())}),
                    json!({"type": "MODIFIED", "object": pod("web-1", "14", crashing())}),
                ],
            ),
            ("GET", "/api/v1/nodes", false) => list("Node", vec![node("True", "5")]),
            ("GET", "/api/v1/nodes", true) => watch_once(
                log,
                path,
                vec![json!({"type": "MODIFIED", "object": node("Unknown", "12")})],
            ),
            ("GET", "/apis/batch/v1/jobs", false) => list("Job", vec![job(false, "5")]),
            ("GET", "/apis/batch/v1/jobs", true) => watch_once(
                log,
                path,
                vec![json!({"type": "MODIFIED", "object": job(true, "12")})],
            ),
            ("GET", "/apis/apps/v1/deployments", false) => {
                list("Deployment", vec![deployment(false, "5")])
            }
            ("GET", "/apis/apps/v1/deployments", true) => watch_once(
                log,
                path,
                vec![json!({"type": "MODIFIED", "object": deployment(true, "12")})],
            ),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

async fn wait_for(recorder: &AlertRecorder, count: usize) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while recorder.alerts.lock().len() < count && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watches_report_transitions_not_the_baseline() {
    let server = start(router()).await;
    // Read-only: alerts only read, so they run on read-only clusters too.
    let (_dir, app, recorder, id) = setup(&server.url, true);
    app.set_alert_monitoring(true);

    let status = app.cluster_connect(&id).await.unwrap();
    assert_eq!(status.state, ConnState::Connected, "{status:?}");
    assert_eq!(app.alert_monitored_clusters(), vec![id.clone()]);

    // web-1 enters CrashLoopBackOff twice (one fresh alert + one merged
    // repeat), n1 goes NotReady, the Job fails, the Deployment gets stuck.
    wait_for(&recorder, 5).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let events = recorder.alerts.lock().clone();
    let fresh: BTreeSet<(AlertReason, String)> = events
        .iter()
        .filter(|e| e.fresh)
        .map(|e| (e.alert.reason, e.alert.object.name.clone()))
        .collect();
    assert_eq!(
        fresh,
        BTreeSet::from([
            (AlertReason::CrashLoopBackOff, "web-1".to_string()),
            (AlertReason::NodeNotReady, "n1".to_string()),
            (AlertReason::JobFailed, "nightly".to_string()),
            (AlertReason::ProgressDeadlineExceeded, "web".to_string()),
        ]),
        "api-0 crashing since before the connect is the baseline: {events:#?}"
    );
    assert_eq!(events.len(), 5, "{events:#?}");
    let repeat = events.iter().find(|e| !e.fresh).unwrap();
    assert_eq!(repeat.alert.object.name, "web-1");
    assert_eq!(repeat.alert.count, 2);

    let web = events
        .iter()
        .find(|e| e.alert.object.name == "web-1")
        .unwrap();
    assert_eq!(web.alert.object.kind, "Pod");
    assert_eq!(web.alert.object.namespace.as_deref(), Some("shop"));
    assert_eq!(web.alert.container.as_deref(), Some("app"));
    assert_eq!(web.alert.cluster_id, id);
    let n1 = events.iter().find(|e| e.alert.object.name == "n1").unwrap();
    assert_eq!(n1.alert.object.namespace, None);
    assert!(n1.alert.message.starts_with("Ready=Unknown"));

    // The notification center: list, mark read, clear.
    let alerts = app.alerts_list();
    assert_eq!(alerts.len(), 4);
    assert!(alerts.iter().all(|a| !a.read));
    let web_id = alerts
        .iter()
        .find(|a| a.object.name == "web-1")
        .unwrap()
        .id
        .clone();
    assert_eq!(app.alerts_mark_read(Some(vec![web_id.clone()])), 1);
    assert_eq!(*recorder.changed.lock(), 1);
    assert_eq!(app.alerts_mark_read(Some(vec![web_id.clone()])), 0);
    assert_eq!(*recorder.changed.lock(), 1, "nothing changed, no event");
    assert_eq!(app.alerts_clear(Some(vec![web_id])), 1);
    assert_eq!(app.alerts_list().len(), 3);

    // Disconnect stops the monitor and keeps the alerts.
    app.cluster_disconnect(&id);
    assert!(app.alert_monitored_clusters().is_empty());
    assert_eq!(app.alerts_list().len(), 3);

    // Removing the cluster drops its alerts.
    app.cluster_remove(&id).await.unwrap();
    assert!(app.alerts_list().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_filter_findings_and_switch_monitors() {
    let server = start(router()).await;
    let (_dir, app, recorder, id) = setup(&server.url, false);
    app.set_alert_monitoring(true);

    // Pods in "shop" are excluded and Job failures are off, so jobs are not
    // even watched.
    let mut settings = app.settings();
    settings.alerts.exclude_namespaces = vec!["sh*".into()];
    settings.alerts.disabled_reasons = vec![AlertReason::JobFailed];
    app.set_settings(settings.clone()).unwrap();

    app.cluster_connect(&id).await.unwrap();
    wait_for(&recorder, 1).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let reasons: BTreeSet<AlertReason> = recorder
        .alerts
        .lock()
        .iter()
        .map(|e| e.alert.reason)
        .collect();
    assert_eq!(reasons, BTreeSet::from([AlertReason::NodeNotReady]));
    assert!(
        !server
            .log
            .lock()
            .iter()
            .any(|r| r.path.starts_with("/apis/batch/v1/jobs")),
        "a kind without enabled reasons is not watched"
    );

    // Disabling the cluster stops its monitor; enabling restarts it.
    settings.alerts.disabled_clusters = vec![id.clone()];
    app.set_settings(settings.clone()).unwrap();
    assert!(app.alert_monitored_clusters().is_empty());
    settings.alerts.disabled_clusters.clear();
    app.set_settings(settings.clone()).unwrap();
    assert_eq!(app.alert_monitored_clusters(), vec![id.clone()]);

    // The master switch stops everything.
    settings.alerts.enabled = false;
    app.set_settings(settings).unwrap();
    assert!(app.alert_monitored_clusters().is_empty());
}

const WATCHED_PATHS: [&str; 4] = [
    "/api/v1/pods",
    "/api/v1/nodes",
    "/apis/batch/v1/jobs",
    "/apis/apps/v1/deployments",
];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn monitoring_is_opt_in_and_forbidden_kinds_are_dropped() {
    let forbidden: Router = Arc::new(|req: &Request, _log: &Log| {
        let path = req.path.split('?').next().unwrap_or_default();
        match path {
            "/version" => version(),
            p if WATCHED_PATHS.contains(&p) => {
                Reply::Json(403, status(403, "Forbidden", "forbidden"))
            }
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    });
    let server = start(forbidden).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    // Off by default: connecting starts no watch.
    app.cluster_connect(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(app.alert_monitored_clusters().is_empty());
    let watched = |log: &Log| {
        log.lock()
            .iter()
            .filter(|r| {
                let path = r.path.split('?').next().unwrap_or_default();
                WATCHED_PATHS.contains(&path)
            })
            .count()
    };
    assert_eq!(watched(&server.log), 0);

    // Turned on while connected: the monitor starts; every list is
    // forbidden, so each kind is tried once and given up.
    app.set_alert_monitoring(true);
    assert_eq!(app.alert_monitored_clusters(), vec![id]);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let first = watched(&server.log);
    assert_eq!(first, WATCHED_PATHS.len(), "one list attempt per kind");
    tokio::time::sleep(Duration::from_millis(2000)).await;
    assert_eq!(watched(&server.log), first, "no retry loop on 403");
}
