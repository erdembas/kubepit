//! End-to-end tests of the Kubernetes-facing paths against the fake API
//! server in `support/`. No real cluster is involved.

mod support;

use std::sync::Arc;
use std::time::Duration;

use kubepit_core::types::{ApplyMode, ConnState, DeleteOptions, Gvk, WatchBatch};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

fn configmap(name: &str, uid: &str, rv: &str) -> Value {
    json!({"apiVersion": "v1", "kind": "ConfigMap",
           "metadata": {"name": name, "namespace": "default", "uid": uid, "resourceVersion": rv}})
}

/// Routes for a minimal cluster with ConfigMaps in `default`.
fn cluster_router() -> Router {
    Arc::new(|req: &Request, log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        match (req.method.as_str(), path) {
            ("GET", "/version") => Reply::Json(
                200,
                json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0+k3s1",
                       "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
                       "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/api/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    {"name": "configmaps", "singularName": "configmap", "namespaced": true, "kind": "ConfigMap",
                     "verbs": ["create", "delete", "get", "list", "patch", "update", "watch"], "shortNames": ["cm"]},
                    {"name": "namespaces", "singularName": "namespace", "namespaced": false, "kind": "Namespace",
                     "verbs": ["get", "list"], "shortNames": ["ns"]}
                ]}),
            ),
            ("GET", "/api/v1/namespaces") => Reply::Json(
                403,
                status(
                    403,
                    "Forbidden",
                    "namespaces is forbidden: User \"dev\" cannot list resource \"namespaces\"",
                ),
            ),
            ("GET", p) if p.starts_with("/apis/metrics.k8s.io/") => Reply::Json(
                404,
                status(
                    404,
                    "NotFound",
                    "the server could not find the requested resource",
                ),
            ),
            ("GET", "/api/v1/namespaces/default/configmaps") if query.contains("watch=true") => {
                let earlier_watches = log
                    .lock()
                    .iter()
                    .filter(|r| r.path.contains("watch=true"))
                    .count();
                if earlier_watches == 0 {
                    Reply::Stream(vec![
                        json!({"type": "ADDED", "object": configmap("b", "uid-b", "11")}),
                        json!({"type": "DELETED", "object": configmap("a", "uid-a", "12")}),
                    ])
                } else {
                    Reply::Stream(vec![])
                }
            }
            ("GET", "/api/v1/namespaces/default/configmaps") => Reply::Json(
                200,
                json!({"kind": "ConfigMapList", "apiVersion": "v1", "metadata": {"resourceVersion": "10"},
                       "items": [{"metadata": {"name": "a", "namespace": "default", "uid": "uid-a",
                                               "resourceVersion": "9",
                                               "managedFields": [{"manager": "kubectl", "operation": "Apply"}]},
                                  "data": {"k": "v"}}]}),
            ),
            ("PATCH", p) if p.starts_with("/api/v1/namespaces/default/configmaps/") => {
                let mut obj: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
                obj["metadata"]["uid"] = json!("uid-applied");
                obj["metadata"]["resourceVersion"] = json!("20");
                Reply::Json(200, obj)
            }
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

fn configmaps() -> Gvk {
    Gvk {
        group: String::new(),
        version: "v1".into(),
        kind: "ConfigMap".into(),
        plural: "configmaps".into(),
        namespaced: true,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_list_watch_apply_against_fake_apiserver() {
    let server = start(cluster_router()).await;
    let (_dir, app, recorder, id) = setup(&server.url, false);

    // Connect: version + platform detection, statuses emitted in order.
    let status = app.cluster_connect(&id).await.unwrap();
    assert_eq!(status.state, ConnState::Connected, "{status:?}");
    assert_eq!(status.version.as_deref(), Some("v1.31.0+k3s1"));
    assert_eq!(status.platform.as_deref(), Some("k3s"));
    let states: Vec<ConnState> = recorder.statuses.lock().iter().map(|s| s.state).collect();
    assert_eq!(states, vec![ConnState::Connecting, ConnState::Connected]);
    assert!(app.cluster_list()[0].last_connected_at.is_some());

    // List: type meta filled in, managedFields stripped.
    let list = app
        .resource_list(&id, &configmaps(), Some("default"), None, None)
        .await
        .unwrap();
    assert_eq!(list.resource_version, "10");
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.items[0]["kind"], "ConfigMap");
    assert_eq!(list.items[0]["apiVersion"], "v1");
    assert!(list.items[0]["metadata"].get("managedFields").is_none());

    // Watch: first batch resets with the initial list, then incremental changes.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WatchBatch>();
    let watch_id = app
        .resource_watch(&id, &configmaps(), vec!["default".into()], move |batch| {
            tx.send(batch).is_ok()
        })
        .await
        .unwrap();
    let mut batches = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut store = std::collections::BTreeMap::<String, Value>::new();
    while tokio::time::Instant::now() < deadline {
        let Ok(Some(batch)) = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await else {
            break;
        };
        assert_eq!(batch.watch_id, watch_id);
        if batch.reset {
            store.clear();
        }
        for obj in &batch.upserts {
            store.insert(
                obj["metadata"]["uid"].as_str().unwrap().to_string(),
                Value::clone(obj),
            );
        }
        for uid in &batch.deletes {
            store.remove(uid);
        }
        batches.push(batch);
        if store.contains_key("uid-b") && !store.contains_key("uid-a") {
            break;
        }
    }
    assert!(batches[0].reset, "first batch must reset");
    assert!(batches.iter().any(|b| b.synced));
    assert_eq!(store.keys().cloned().collect::<Vec<_>>(), vec!["uid-b"]);
    assert_eq!(store["uid-b"]["kind"], "ConfigMap");
    app.resource_unwatch(&watch_id);

    // Server-side apply: resolved through discovery, field manager kubepit, forced,
    // server-owned fields stripped.
    let yaml = r#"
apiVersion: v1
kind: ConfigMap
metadata:
  name: applied
  resourceVersion: "5"
  uid: stale
data:
  hello: world
status:
  ignored: true
"#;
    let applied = app
        .resource_apply_yaml(&id, yaml, ApplyMode::Apply, Some("default"))
        .await
        .unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0]["metadata"]["uid"], "uid-applied");
    let patch = server
        .log
        .lock()
        .iter()
        .find(|r| r.method == "PATCH")
        .cloned()
        .expect("apply sent a PATCH");
    assert!(patch
        .path
        .starts_with("/api/v1/namespaces/default/configmaps/applied?"));
    assert!(
        patch.path.contains("fieldManager=kubepit"),
        "{}",
        patch.path
    );
    assert!(patch.path.contains("force=true"), "{}", patch.path);
    let body: Value = serde_json::from_str(&patch.body).unwrap();
    assert_eq!(body["metadata"]["namespace"], "default");
    assert!(body["metadata"].get("resourceVersion").is_none());
    assert!(body["metadata"].get("uid").is_none());
    assert!(body.get("status").is_none());
    assert_eq!(body["data"]["hello"], "world");

    // metrics-server missing → available: false, not an error.
    let metrics = app.metrics_nodes(&id).await.unwrap();
    assert!(!metrics.available);
    assert!(metrics.items.is_empty());

    // RBAC forbids listing namespaces → configured accessible namespaces.
    assert_eq!(
        app.namespace_names(&id).await.unwrap(),
        vec!["team-a", "team-b"]
    );

    // Discovery is cached and exposes short names.
    let resources = app.api_resources(&id).await.unwrap();
    let cm = resources.iter().find(|r| r.kind == "ConfigMap").unwrap();
    assert_eq!(cm.short_names, vec!["cm"]);

    // Disconnect emits and drops the client.
    app.cluster_disconnect(&id);
    assert_eq!(app.cluster_statuses()[&id].state, ConnState::Disconnected);
}

#[tokio::test]
async fn read_only_clusters_never_reach_the_server() {
    let server = start(cluster_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    let err = app
        .resource_delete(
            &id,
            &configmaps(),
            Some("default"),
            "a",
            DeleteOptions::default(),
        )
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is read-only"));
    let err = app
        .resource_apply_yaml(
            &id,
            "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x}\n",
            ApplyMode::Apply,
            None,
        )
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is read-only"));
    assert!(app.node_drain(&id, "n1", false).await.is_err());
    assert!(app.helm_uninstall(&id, "default", "web").await.is_err());
    assert!(
        server.log.lock().is_empty(),
        "no request may reach the API server"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_headers_are_recorded() {
    let server = start(cluster_router()).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let log = server.log.lock();
    let version = log.iter().find(|r| r.path_only() == "/version").unwrap();
    assert_eq!(version.header("Authorization"), Some("Bearer test-token"));
    assert!(version
        .headers
        .iter()
        .all(|(name, _)| *name == name.to_lowercase()));
}

#[tokio::test]
async fn unreachable_server_reports_error_status() {
    // Grab a free port and close it again so nothing listens there.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (_dir, app, recorder, id) = setup(&format!("http://127.0.0.1:{port}"), false);
    let status = app.cluster_connect(&id).await.unwrap();
    assert_eq!(status.state, ConnState::Error);
    assert!(status.error.is_some());
    let states: Vec<ConnState> = recorder.statuses.lock().iter().map(|s| s.state).collect();
    assert_eq!(states, vec![ConnState::Connecting, ConnState::Error]);
    let err = app
        .resource_list(&id, &configmaps(), None, None, None)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("not connected"), "{err:#}");
}

// ---------------------------------------------------------------------------
// Logs, Helm and overview
// ---------------------------------------------------------------------------

fn helm_release_payload(name: &str, revision: i64, status: &str) -> String {
    use base64::Engine as _;
    use std::io::Write as _;
    let release = json!({
        "name": name, "namespace": "shop", "version": revision,
        "info": {"status": status, "last_deployed": "2024-02-01T10:00:00Z",
                 "description": format!("rev {revision}"), "notes": "NOTES"},
        "chart": {"metadata": {"name": "nginx", "version": "15.4.2", "appVersion": "1.25.3"},
                  "values": {"replicaCount": 1}},
        "config": {"replicaCount": revision},
        "manifest": "---\nkind: Deployment\n"
    });
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(release.to_string().as_bytes()).unwrap();
    let helm_encoded = base64::engine::general_purpose::STANDARD.encode(gz.finish().unwrap());
    // The Secret API wraps `data` values in one more base64 layer.
    base64::engine::general_purpose::STANDARD.encode(helm_encoded)
}

fn secret_meta(release: &str, revision: i64, status: &str) -> Value {
    json!({"kind": "PartialObjectMetadata", "apiVersion": "meta.k8s.io/v1",
           "metadata": {"name": format!("sh.helm.release.v1.{release}.v{revision}"), "namespace": "shop",
                        "labels": {"owner": "helm", "name": release, "version": revision.to_string(), "status": status}}})
}

fn workload_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        match (req.method.as_str(), path) {
            ("GET", "/version") => Reply::Json(
                200,
                json!({"major": "1", "minor": "30", "gitVersion": "v1.30.2-eks-1552ad0",
                       "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
                       "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            // Logs
            ("GET", "/api/v1/namespaces/default/pods/web/log") => {
                assert!(query.contains("container=app"), "{query}");
                assert!(query.contains("tailLines=100"), "{query}");
                Reply::Text("first line\nsecond ✓ line\n".into())
            }
            ("GET", "/api/v1/namespaces/default/pods/gone/log") => {
                Reply::Json(404, status(404, "NotFound", "pods \"gone\" not found"))
            }
            // Helm
            ("GET", "/api/v1/namespaces/shop/secrets") => {
                assert!(query.contains("labelSelector=owner%3Dhelm"), "{query}");
                assert!(
                    query.contains("fieldSelector=type%3Dhelm.sh%2Frelease.v1"),
                    "{query}"
                );
                let name_filter = query.contains("name%3Dweb");
                let mut items = vec![
                    secret_meta("web", 1, "superseded"),
                    secret_meta("web", 2, "deployed"),
                ];
                if !name_filter {
                    items.push(secret_meta("db", 1, "failed"));
                }
                Reply::Json(
                    200,
                    json!({"kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1",
                                        "metadata": {"resourceVersion": "1"}, "items": items}),
                )
            }
            ("GET", p) if p.starts_with("/api/v1/namespaces/shop/secrets/sh.helm.release.v1.") => {
                let secret = p.rsplit('/').next().unwrap();
                let rest = secret.trim_start_matches("sh.helm.release.v1.");
                let (release, rev) = rest.rsplit_once(".v").unwrap();
                let revision: i64 = rev.parse().unwrap();
                let status = if release == "db" {
                    "failed"
                } else if revision == 2 {
                    "deployed"
                } else {
                    "superseded"
                };
                Reply::Json(
                    200,
                    json!({"apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1",
                    "metadata": {"name": secret, "namespace": "shop"},
                    "data": {"release": helm_release_payload(release, revision, status)}}),
                )
            }
            // Overview
            ("GET", "/api/v1/nodes") => Reply::Json(
                200,
                json!({"kind": "NodeList", "apiVersion": "v1",
                "metadata": {"resourceVersion": "1"}, "items": [
                    {"metadata": {"name": "n1"}, "status": {
                        "conditions": [{"type": "Ready", "status": "True"}],
                        "capacity": {"cpu": "4", "memory": "8Gi", "pods": "110"},
                        "allocatable": {"cpu": "3900m", "memory": "7Gi", "pods": "110"}}},
                    {"metadata": {"name": "n2"}, "status": {
                        "conditions": [{"type": "Ready", "status": "Unknown"}],
                        "capacity": {"cpu": "2", "memory": "4Gi", "pods": "110"}}}
                ]}),
            ),
            ("GET", "/api/v1/pods") => Reply::Json(
                200,
                json!({"kind": "PodList", "apiVersion": "v1",
                "metadata": {"resourceVersion": "1"}, "items": [
                    {"metadata": {"name": "a", "namespace": "shop"},
                     "spec": {"containers": [{"name": "c", "resources": {"requests": {"cpu": "250m", "memory": "256Mi"},
                                                                       "limits": {"cpu": "1", "memory": "512Mi"}}}]},
                     "status": {"phase": "Running"}},
                    {"metadata": {"name": "b", "namespace": "shop"},
                     "spec": {"containers": [{"name": "c"}]}, "status": {"phase": "Pending"}}
                ]}),
            ),
            ("GET", "/apis/apps/v1/deployments") => Reply::Json(
                403,
                status(403, "Forbidden", "deployments.apps is forbidden"),
            ),
            ("GET", "/api/v1/namespaces") => Reply::Json(
                200,
                json!({"kind": "PartialObjectMetadataList",
                "apiVersion": "meta.k8s.io/v1", "metadata": {"resourceVersion": "1"}, "items": [
                    {"kind": "PartialObjectMetadata", "apiVersion": "meta.k8s.io/v1", "metadata": {"name": "default"}},
                    {"kind": "PartialObjectMetadata", "apiVersion": "meta.k8s.io/v1", "metadata": {"name": "shop"}}
                ]}),
            ),
            ("GET", "/api/v1/events") => {
                assert!(query.contains("fieldSelector=type%3DWarning"), "{query}");
                Reply::Json(
                    200,
                    json!({"kind": "EventList", "apiVersion": "v1",
                    "metadata": {"resourceVersion": "1"}, "items": [
                        {"metadata": {"name": "old", "namespace": "shop", "uid": "e1"}, "type": "Warning",
                         "reason": "BackOff", "lastTimestamp": "2024-01-01T00:00:00Z",
                         "involvedObject": {"kind": "Pod", "name": "a"}},
                        {"metadata": {"name": "new", "namespace": "shop", "uid": "e2"}, "type": "Warning",
                         "reason": "FailedMount", "eventTime": "2024-01-02T00:00:00.000000Z",
                         "involvedObject": {"kind": "Pod", "name": "b"}}
                    ]}),
                )
            }
            ("GET", p) if p.starts_with("/apis/metrics.k8s.io/") => Reply::Json(
                404,
                status(
                    404,
                    "NotFound",
                    "the server could not find the requested resource",
                ),
            ),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn logs_helm_and_overview_against_fake_apiserver() {
    let server = start(workload_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    let status = app.cluster_connect(&id).await.unwrap();
    assert_eq!(status.platform.as_deref(), Some("EKS"));

    // Logs: text arrives in chunks, the stream ends with done: true.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let options = kubepit_core::types::LogOptions {
        follow: false,
        tail_lines: Some(100),
        since_seconds: None,
        timestamps: false,
        previous: false,
    };
    let stream_id = app
        .pod_logs_stream(
            &id,
            "default",
            "web",
            Some("app".into()),
            options.clone(),
            move |chunk| tx.send(chunk).is_ok(),
        )
        .await
        .unwrap();
    let mut text = String::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("log chunk")
            .expect("stream open");
        assert_eq!(chunk.stream_id, stream_id);
        text.push_str(&chunk.data);
        if chunk.done {
            assert_eq!(chunk.error, None);
            break;
        }
    }
    assert_eq!(text, "first line\nsecond ✓ line\n");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.pod_logs_stream(&id, "default", "gone", None, options, move |chunk| {
        tx.send(chunk).is_ok()
    })
    .await
    .unwrap();
    let last = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(last.done);
    assert!(last.error.unwrap().contains("not found"));

    // Helm: newest revision per release, decoded through the typed Secret API.
    let releases = app.helm_releases(&id, Some("shop")).await.unwrap();
    let summary: Vec<(String, i64, String)> = releases
        .iter()
        .map(|r| (r.name.clone(), r.revision, r.status.clone()))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("db".into(), 1, "failed".into()),
            ("web".into(), 2, "deployed".into())
        ]
    );
    assert_eq!(releases[1].chart, "nginx");
    assert_eq!(releases[1].app_version.as_deref(), Some("1.25.3"));

    let detail = app.helm_release_detail(&id, "shop", "web").await.unwrap();
    assert_eq!(detail.release.revision, 2);
    assert_eq!(
        detail
            .history
            .iter()
            .map(|h| h.revision)
            .collect::<Vec<_>>(),
        vec![2, 1]
    );
    assert_eq!(detail.values_yaml.trim(), "replicaCount: 2");
    assert_eq!(detail.computed_values_yaml.trim(), "replicaCount: 2");
    assert_eq!(detail.notes, "NOTES");

    // Overview: deployments are forbidden (zeros), metrics missing (usage null).
    let overview = app.cluster_overview(&id).await.unwrap();
    assert_eq!(overview.version.as_deref(), Some("v1.30.2-eks-1552ad0"));
    assert_eq!(overview.nodes.total, 2);
    assert_eq!(overview.nodes.ready, 1);
    assert_eq!(overview.pods.running, 1);
    assert_eq!(overview.pods.pending, 1);
    assert_eq!(overview.namespaces, 2);
    assert_eq!(overview.deployments.total, 0);
    assert_eq!(overview.capacity.cpu_millicores, 6000.0);
    assert_eq!(overview.allocatable.cpu_millicores, 3900.0);
    assert_eq!(overview.requests.cpu_millicores, 250.0);
    assert_eq!(overview.limits.memory_bytes, 512.0 * 1024.0 * 1024.0);
    assert!(overview.usage.is_none());
    let warnings: Vec<&str> = overview
        .warnings
        .iter()
        .map(|w| w["metadata"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(warnings, vec!["new", "old"]);
    assert_eq!(overview.warnings[0]["kind"], "Event");
}
