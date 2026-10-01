//! Incident capture against an in-process fake Kubernetes API. Every
//! kubeconfig and store lives in a temp directory; no real cluster is used.
mod support;

use std::sync::Arc;

use kubepit_core::investigations::{
    EvidenceKind, EvidenceReason, EvidenceStatus, InvestigationCaptureRequest,
};
use kubepit_core::types::Gvk;
use kubepit_core::{Kubepit, NullSink};
use serde_json::{json, Value};
use support::{home_contains, setup, start, status, Reply, Router};

fn request() -> InvestigationCaptureRequest {
    InvestigationCaptureRequest {
        gvk: Gvk {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            plural: "pods".into(),
            namespaced: true,
        },
        namespace: "team-a".into(),
        name: "web-0".into(),
        title: "Investigate web-0".into(),
        lookback_minutes: 15,
    }
}

fn pod() -> Value {
    json!({
        "apiVersion":"v1", "kind":"Pod",
        "metadata":{
            "name":"web-0", "namespace":"team-a", "uid":"uid-web-0",
            "resourceVersion":"1", "annotations":{"custom":"fixture-annotation-secret"}
        },
        "spec":{"containers":[{"name":"app","image":"fixture:v1","env":[
            {"name":"ORDINARY","value":"fixture-literal-secret"},
            {"name":"PASSWORD","value":"fixture-env-secret"}
        ]}]},
        "status":{"phase":"Running","containerStatuses":[{
            "name":"app","image":"fixture:v1","imageID":"fixture","ready":true,
            "restartCount":1,"state":{"running":{}},"lastState":{"terminated":{"exitCode":1}}
        }]}
    })
}

fn event(name: &str, time: chrono::DateTime<chrono::Utc>, message: &str) -> Value {
    json!({
        "metadata":{"name":name,"namespace":"team-a","uid":format!("uid-{name}"),"creationTimestamp":time.to_rfc3339()},
        "involvedObject":{"kind":"Pod","name":"web-0","namespace":"team-a","uid":"uid-web-0"},
        "reason":"Unhealthy","type":"Warning","message":message,
        "lastTimestamp":time.to_rfc3339()
    })
}

fn router(forbid_object: bool) -> Router {
    let fixture_now = chrono::Utc::now();
    let log_time = (fixture_now - chrono::Duration::seconds(30)).to_rfc3339();
    Arc::new(move |req, _| {
        let (path, query) = req.path.split_once('?').unwrap_or((&req.path, ""));
        match path {
            "/version" => Reply::Json(
                200,
                json!({
                    "major":"1","minor":"31","gitVersion":"v1.31.0","gitCommit":"abc",
                    "gitTreeState":"clean","buildDate":"2024-01-01T00:00:00Z",
                    "goVersion":"go1.22","compiler":"gc","platform":"linux/amd64"
                }),
            ),
            "/apis" => Reply::Json(
                200,
                json!({"kind":"APIGroupList","apiVersion":"v1","groups":[]}),
            ),
            "/api/v1/namespaces/team-a/pods/web-0" if forbid_object => {
                Reply::Json(403, status(403, "Forbidden", "fixture object denied"))
            }
            "/api/v1/namespaces/team-a/pods/web-0" => Reply::Json(200, pod()),
            "/api/v1/namespaces/team-a/pods/web-0/log" => {
                assert!(query.contains("container=app"), "{query}");
                assert!(query.contains("timestamps=true"), "{query}");
                assert!(query.contains("tailLines=200"), "{query}");
                assert!(!query.contains("follow=true"), "{query}");
                if query.contains("previous=true") {
                    Reply::Text(format!(
                        "{log_time} previous crash password=fixture-previous-secret\n"
                    ))
                } else {
                    Reply::Text(
                        (0..200)
                            .map(|line| {
                                format!("{log_time} request {line} password=fixture-log-secret\n")
                            })
                            .collect(),
                    )
                }
            }
            "/api/v1/namespaces/team-a/events" => {
                assert!(
                    query.contains("fieldSelector=involvedObject.uid%3Duid-web-0"),
                    "{query}"
                );
                assert!(query.contains("limit=100"), "{query}");
                Reply::Json(
                    200,
                    json!({"kind":"EventList","apiVersion":"v1","metadata":{"resourceVersion":"1"},"items":[
                        event("current", fixture_now-chrono::Duration::minutes(1), "recent readiness failure token=fixture-event-secret"),
                        event("old", fixture_now-chrono::Duration::hours(2), "old-event-outside-window"),
                        event("future", fixture_now+chrono::Duration::hours(2), "future-event-outside-window")
                    ]}),
                )
            }
            _ => Reply::Json(404, status(404, "NotFound", "fixture data unavailable")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_capture_freezes_redacted_samples_and_reopens_offline() {
    let server = start(router(false)).await;
    let (_dir, app, _, id) = setup(&server.url, true);
    app.cluster_connect(&id).await.unwrap();
    let record = app.investigation_capture(&id, request()).await.unwrap();
    assert!(record
        .evidence
        .iter()
        .any(|e| e.kind == EvidenceKind::Object && e.status == EvidenceStatus::Captured));
    let logs: Vec<_> = record
        .evidence
        .iter()
        .filter(|e| e.kind == EvidenceKind::Logs)
        .collect();
    assert_eq!(logs.len(), 2);
    let current = logs
        .iter()
        .find(|e| !e.label.ends_with("#previous"))
        .unwrap();
    assert_eq!(
        current.status,
        EvidenceStatus::Truncated,
        "a full 200-line tail cannot claim the entire lookback window"
    );
    assert_eq!(current.reason, Some(EvidenceReason::CaptureLimit));
    assert!(current.content.contains("request 199"));
    assert!(logs
        .iter()
        .any(|e| e.label.ends_with("#previous") && e.content.contains("previous crash")));
    let events = record
        .evidence
        .iter()
        .find(|e| e.kind == EvidenceKind::Events)
        .unwrap();
    assert!(events.content.contains("recent readiness failure"));
    assert!(!events.content.contains("outside-window"));
    let metrics = record
        .evidence
        .iter()
        .find(|e| e.kind == EvidenceKind::Metrics)
        .unwrap();
    assert_eq!(metrics.status, EvidenceStatus::Unavailable);
    assert_eq!(metrics.reason, Some(EvidenceReason::NotFound));
    assert!(
        record
            .evidence
            .iter()
            .any(|e| e.kind == EvidenceKind::Changes
                && e.reason == Some(EvidenceReason::NotRecording))
    );

    let exported = app.investigation_export(&record.id, None).unwrap();
    for secret in [
        "fixture-annotation-secret",
        "fixture-literal-secret",
        "fixture-env-secret",
        "fixture-log-secret",
        "fixture-previous-secret",
        "fixture-event-secret",
    ] {
        assert!(!exported.contains(secret), "export retained {secret}");
        assert!(
            !home_contains(app.paths().root(), secret),
            "local files retained {secret}"
        );
    }
    let reopened = Kubepit::open(app.paths().clone(), Arc::new(NullSink)).unwrap();
    let restored = reopened.investigation_get(&record.id).unwrap();
    assert_eq!(restored.captured_at, record.captured_at);
    assert_eq!(restored.evidence.len(), record.evidence.len());
    assert_eq!(
        restored
            .evidence
            .iter()
            .map(|e| &e.content)
            .collect::<Vec<_>>(),
        record
            .evidence
            .iter()
            .map(|e| &e.content)
            .collect::<Vec<_>>()
    );
    assert_eq!(reopened.investigations_list(Some(&id)).unwrap().len(), 1);
    assert!(server.log.lock().iter().all(|r| r.method == "GET"));
    assert!(!server
        .log
        .lock()
        .iter()
        .any(|r| r.path.contains("/exec") || r.path.contains("/secrets")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forbidden_object_is_saved_as_explicit_gaps_without_false_empty_evidence() {
    let server = start(router(true)).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let record = app.investigation_capture(&id, request()).await.unwrap();
    for kind in [EvidenceKind::Object, EvidenceKind::Pods] {
        let evidence = record.evidence.iter().find(|e| e.kind == kind).unwrap();
        assert_eq!(evidence.status, EvidenceStatus::Unavailable);
        assert_eq!(evidence.reason, Some(EvidenceReason::Forbidden));
        assert!(evidence.content.is_empty());
    }
    assert!(record.incomplete_count >= 2);
    assert!(!server
        .log
        .lock()
        .iter()
        .any(|r| r.path.contains("/log") || r.path.contains("fieldSelector=")));
    assert!(app.investigation_get(&record.id).is_ok());
}

#[tokio::test]
async fn secret_targets_are_rejected_before_any_api_access() {
    let server = start(router(false)).await;
    let (_dir, app, _, id) = setup(&server.url, true);
    let mut capture = request();
    capture.gvk.kind = "Secret".into();
    capture.gvk.plural = "secrets".into();
    assert!(app
        .investigation_capture(&id, capture)
        .await
        .unwrap_err()
        .to_string()
        .contains("unsupported-target"));
    assert!(server.log.lock().is_empty());
}

#[tokio::test]
async fn disconnected_capture_does_not_reconnect_or_start_background_workers() {
    let server = start(router(false)).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    assert!(app
        .investigation_capture(&id, request())
        .await
        .unwrap_err()
        .to_string()
        .contains("disconnected"));
    assert!(server.log.lock().is_empty());
}
