//! End-to-end tests of the logs & debug features against the fake API
//! server in `support/`: selector-based pod watching with log fan-out,
//! the ephemeral-container PATCH, exec request shapes and read-only
//! refusals. No real cluster is involved.

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use kubepit_core::types::{
    PodDebugRequest, WorkloadLogBatch, WorkloadLogEventKind, WorkloadLogOptions,
};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const TS: &str = "2024-05-01T10:00:00.123456789Z";

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

/// A pod whose containers have a `containerID` (they ran) unless `None`.
fn pod(name: &str, containers: &[(&str, Option<&str>)], extra_status: Value) -> Value {
    let spec: Vec<Value> = containers
        .iter()
        .map(|(c, _)| json!({"name": c, "image": "nginx"}))
        .collect();
    let statuses: Vec<Value> = containers
        .iter()
        .map(|(c, id)| {
            json!({"name": c, "image": "nginx", "imageID": "", "ready": id.is_some(),
                   "restartCount": 0, "containerID": id.unwrap_or(""),
                   "state": if id.is_some() { json!({"running": {}}) }
                            else { json!({"waiting": {"reason": "ContainerCreating"}}) }})
        })
        .collect();
    let mut status = json!({"phase": "Running", "containerStatuses": statuses});
    if let (Some(target), Some(extra)) = (status.as_object_mut(), extra_status.as_object()) {
        for (k, v) in extra {
            target.insert(k.clone(), v.clone());
        }
    }
    json!({"apiVersion": "v1", "kind": "Pod",
           "metadata": {"name": name, "namespace": "shop", "uid": format!("uid-{name}"),
                        "resourceVersion": "10", "labels": {"app": "web"}},
           "spec": {"containers": spec}, "status": status})
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))
}

fn workload_router() -> Router {
    Arc::new(|req: &Request, log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/api/v1/namespaces/shop/pods") if query.contains("watch=true") => {
                assert!(query.contains("labelSelector=app%3Dweb"), "{query}");
                let earlier = log
                    .lock()
                    .iter()
                    .filter(|r| r.path.contains("watch=true"))
                    .count();
                if earlier == 0 {
                    // Scale-up while following: web-3 joins.
                    Reply::Stream(vec![json!({"type": "ADDED",
                        "object": pod("web-3", &[("app", Some("containerd://3"))], json!({}))})])
                } else {
                    Reply::Stream(vec![])
                }
            }
            ("GET", "/api/v1/namespaces/shop/pods") => {
                assert!(query.contains("labelSelector=app%3Dweb"), "{query}");
                Reply::Json(
                    200,
                    json!({"kind": "PodList", "apiVersion": "v1",
                           "metadata": {"resourceVersion": "10"}, "items": [
                        pod("web-0", &[("app", None)], json!({})),
                        pod("web-1", &[("app", Some("containerd://1a")),
                                       ("sidecar", Some("containerd://1s"))], json!({})),
                        pod("web-2", &[("app", Some("containerd://2"))], json!({})),
                    ]}),
                )
            }
            ("GET", p) if p.starts_with("/api/v1/namespaces/shop/pods/") && p.ends_with("/log") => {
                let pod = p.split('/').nth(6).unwrap();
                let container = query_param(query, "container").unwrap_or("?");
                assert_eq!(query_param(query, "follow"), Some("true"), "{query}");
                assert_eq!(query_param(query, "timestamps"), Some("true"), "{query}");
                Reply::Text(format!(
                    "{TS} hello from {pod}/{container}\n{TS} second line\n"
                ))
            }
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workload_logs_follow_every_matching_pod() {
    let server = start(workload_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WorkloadLogBatch>();
    let options = WorkloadLogOptions {
        tail_lines: Some(20),
        ..Default::default()
    };
    let stream_id = app
        .workload_logs_stream(&id, "shop", "app=web", options, move |batch| {
            tx.send(batch).is_ok()
        })
        .await
        .unwrap();

    let expected: BTreeSet<&str> = ["web-1/app", "web-1/sidecar", "web-2/app", "web-3/app"]
        .into_iter()
        .collect();
    let mut added: Vec<String> = Vec::new();
    let mut ended: BTreeSet<String> = BTreeSet::new();
    let mut lines: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while ended.len() < expected.len() && tokio::time::Instant::now() < deadline {
        let Ok(Some(batch)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await else {
            break;
        };
        assert_eq!(batch.stream_id, stream_id);
        assert!(!batch.done, "{:?}", batch.error);
        for event in batch.events {
            let source = format!("{}/{}", event.pod, event.container);
            match event.kind {
                WorkloadLogEventKind::SourceAdded => added.push(source),
                WorkloadLogEventKind::Lines => {
                    assert!(
                        added.contains(&source),
                        "lines of {source} before source-added"
                    );
                    assert!(
                        !ended.contains(&source),
                        "lines of {source} after source-ended"
                    );
                    lines.entry(source).or_default().extend(event.lines);
                }
                WorkloadLogEventKind::SourceEnded => {
                    assert_eq!(event.message, None, "{source}");
                    ended.insert(source);
                }
                other => panic!("unexpected {other:?} for {source}"),
            }
        }
    }
    app.workload_logs_stop(&stream_id);

    assert_eq!(
        ended.iter().map(String::as_str).collect::<BTreeSet<_>>(),
        expected
    );
    assert!(
        !added.iter().any(|s| s.starts_with("web-0/")),
        "a container that never ran has no logs"
    );
    // Timestamps are always requested (for ordering) and stripped here.
    assert_eq!(
        lines["web-1/sidecar"],
        vec!["hello from web-1/sidecar", "second line"]
    );
    assert_eq!(lines["web-3/app"][0], "hello from web-3/app");

    let requests = server.log.lock().clone();
    let log_queries: Vec<&str> = requests
        .iter()
        .filter(|r| r.path.contains("/log?"))
        .map(|r| r.path.as_str())
        .collect();
    assert_eq!(log_queries.len(), 4, "{log_queries:?}");
    assert!(
        log_queries.iter().all(|q| q.contains("tailLines=20")),
        "{log_queries:?}"
    );
}

#[tokio::test]
async fn workload_logs_fail_fast_when_pods_are_forbidden() {
    let router: Router = Arc::new(|req: &Request, _log: &Log| {
        match (req.method.as_str(), req.path.split('?').next().unwrap()) {
            ("GET", "/version") => version(),
            ("GET", "/api/v1/namespaces/shop/pods") => Reply::Json(
                403,
                status(
                    403,
                    "Forbidden",
                    "pods is forbidden: User \"dev\" cannot list pods",
                ),
            ),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    });
    let server = start(router).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WorkloadLogBatch>();
    app.workload_logs_stream(
        &id,
        "shop",
        "app=web",
        WorkloadLogOptions::default(),
        move |b| tx.send(b).is_ok(),
    )
    .await
    .unwrap();
    let last = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("final batch")
        .unwrap();
    assert!(last.done);
    assert!(last.error.unwrap().contains("forbidden"));
    assert!(app
        .workload_logs_stream(&id, "shop", "  ", WorkloadLogOptions::default(), |_| true)
        .await
        .is_err());
}

// ---------------------------------------------------------------------------
// Debug containers and container files
// ---------------------------------------------------------------------------

fn patched_name(log: &Log, pod: &str) -> Option<String> {
    log.lock().iter().rev().find_map(|r| {
        (r.method == "PATCH" && r.path.contains(&format!("/pods/{pod}/ephemeralcontainers")))
            .then(|| {
                let body: Value = serde_json::from_str(&r.body).ok()?;
                body["spec"]["ephemeralContainers"][0]["name"]
                    .as_str()
                    .map(String::from)
            })
            .flatten()
    })
}

fn debug_router() -> Router {
    Arc::new(|req: &Request, log: &Log| {
        let (path, _query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        let parts: Vec<&str> = path.split('/').collect();
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("PATCH", p) if p.ends_with("/ephemeralcontainers") => match parts[6] {
                "old-1" => Reply::Json(
                    404,
                    status(
                        404,
                        "NotFound",
                        "the server could not find the requested resource",
                    ),
                ),
                name => Reply::Json(200, pod(name, &[("app", Some("c://1"))], json!({}))),
            },
            ("GET", p) if p.starts_with("/api/v1/namespaces/shop/pods/") && parts.len() == 7 => {
                let name = parts[6];
                let extra = match patched_name(log, name) {
                    None => json!({}),
                    Some(debugger) => {
                        let state = if name == "badimage" {
                            json!({"waiting": {"reason": "ImagePullBackOff",
                                               "message": "Back-off pulling image \"nope:1\""}})
                        } else {
                            json!({"running": {"startedAt": "2024-05-01T10:00:00Z"}})
                        };
                        json!({"ephemeralContainerStatuses": [{"name": debugger, "image": "busybox",
                               "imageID": "", "ready": false, "restartCount": 0, "state": state}]})
                    }
                };
                Reply::Json(200, pod(name, &[("app", Some("c://1"))], extra))
            }
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn debug_containers_are_patched_in_and_awaited() {
    let server = start(debug_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let name = app
        .pod_debug(
            &id,
            "shop",
            "web-1",
            PodDebugRequest {
                image: String::new(), // → settings.debug_image
                target_container: Some("app".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(name.starts_with("debugger-"), "{name}");
    let patch = server
        .log
        .lock()
        .iter()
        .find(|r| r.method == "PATCH")
        .cloned()
        .expect("PATCH sent");
    assert!(
        patch
            .path
            .starts_with("/api/v1/namespaces/shop/pods/web-1/ephemeralcontainers"),
        "{}",
        patch.path
    );
    let body: Value = serde_json::from_str(&patch.body).unwrap();
    assert_eq!(
        body,
        json!({"spec": {"ephemeralContainers": [{
            "name": name, "image": "docker.io/library/busybox:1.36", "stdin": true, "tty": true,
            "terminationMessagePolicy": "File", "targetContainerName": "app"}]}})
    );

    // Clusters without the subresource get a clear message.
    let err = app
        .pod_debug(
            &id,
            "shop",
            "old-1",
            PodDebugRequest {
                image: "busybox".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("does not support ephemeral containers"),
        "{err:#}"
    );

    // Image pull failures end the wait early.
    let started = tokio::time::Instant::now();
    let err = app
        .pod_debug(
            &id,
            "shop",
            "badimage",
            PodDebugRequest {
                image: "nope:1".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("ImagePullBackOff"), "{err:#}");
    assert!(started.elapsed() < Duration::from_secs(10));

    // Name clashes and unknown targets never reach the PATCH.
    let patches = || {
        server
            .log
            .lock()
            .iter()
            .filter(|r| r.method == "PATCH")
            .count()
    };
    let before = patches();
    let clash = PodDebugRequest {
        image: "busybox".into(),
        name: Some("app".into()),
        ..Default::default()
    };
    assert!(app.pod_debug(&id, "shop", "web-2", clash).await.is_err());
    let unknown_target = PodDebugRequest {
        image: "busybox".into(),
        target_container: Some("nope".into()),
        ..Default::default()
    };
    let err = app
        .pod_debug(&id, "shop", "web-2", unknown_target)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("no container named nope"));
    assert_eq!(patches(), before);
}

#[tokio::test]
async fn file_commands_exec_a_positional_sh_script() {
    let server = start(debug_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    // The fake server cannot upgrade to a websocket; the request shape is
    // what matters here, and the failure must stay readable.
    let err = app
        .pod_fs_list(&id, "shop", "web-1", Some("app"), "/var/log")
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("cannot exec into web-1"),
        "{err:#}"
    );
    let exec = server
        .log
        .lock()
        .iter()
        .find(|r| r.path.contains("/exec?"))
        .cloned()
        .expect("exec request sent");
    assert!(exec
        .path
        .starts_with("/api/v1/namespaces/shop/pods/web-1/exec?"));
    assert!(exec.path.contains("container=app"), "{}", exec.path);
    assert!(
        exec.path.contains("command=sh&command=-c&command="),
        "{}",
        exec.path
    );
    // The path is an argument after the script, not part of it.
    assert!(
        exec.path
            .contains("&command=sh&command=%2Fvar%2Flog&command=5000"),
        "{}",
        exec.path
    );
}

#[tokio::test]
async fn read_only_clusters_refuse_debug_and_upload() {
    let server = start(debug_router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, true);
    let err = app
        .pod_debug(
            &id,
            "shop",
            "web-1",
            PodDebugRequest {
                image: "busybox".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is read-only"), "{err:#}");
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "hello").unwrap();
    let err = app
        .pod_fs_upload(&id, "shop", "web-1", None, &file.to_string_lossy(), "/tmp")
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is read-only"), "{err:#}");
    assert!(
        server.log.lock().is_empty(),
        "no request may reach the API server"
    );
}
