//! Fixture-only permission and source revalidation tests. The API server is
//! loopback; its explicit temp-dir kubeconfig never reads the user's kubeconfig.
mod support;

use kubepit_core::network_diagnostics::{NetworkDiagnosticsRequest, NetworkProbeProtocol};
use serde_json::{json, Value};
use std::sync::Arc;
use support::{setup, start, status, Reply, Router};

fn request() -> NetworkDiagnosticsRequest {
    NetworkDiagnosticsRequest {
        namespace: "team-a".into(),
        pod: "web-0".into(),
        container: "app".into(),
        target_namespace: "team-a".into(),
        service: "web".into(),
        port: 80,
        protocol: NetworkProbeProtocol::Http,
        path: "/".into(),
    }
}

fn router(allowed: bool) -> Router {
    Arc::new(move |req, _log| match req.path_only() {
        "/version" => Reply::Json(
            200,
            json!({"major":"1","minor":"31","gitVersion":"v1.31.0","gitCommit":"abc","gitTreeState":"clean","buildDate":"2024-01-01T00:00:00Z","goVersion":"go1.22","compiler":"gc","platform":"linux/amd64"}),
        ),
        "/apis" => Reply::Json(
            200,
            json!({"kind":"APIGroupList","apiVersion":"v1","groups":[]}),
        ),
        "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" => {
            let body: Value = serde_json::from_str(&req.body).unwrap();
            assert_eq!(body["spec"]["resourceAttributes"]["subresource"], "exec");
            assert_eq!(body["spec"]["resourceAttributes"]["verb"], "create");
            Reply::Json(
                201,
                json!({"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":body["spec"],"status":{"allowed":allowed,"reason":"fixture decision"}}),
            )
        }
        "/api/v1/namespaces/team-a/pods/web-0" => Reply::Json(
            200,
            json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"web-0","namespace":"team-a"},"status":{"containerStatuses":[{"name":"app","image":"fixture","imageID":"fixture","ready":false,"restartCount":1,"state":{"waiting":{"reason":"CrashLoopBackOff"}}}]}}),
        ),
        _ => Reply::Json(404, status(404, "NotFound", "fixture route missing")),
    })
}

#[tokio::test]
async fn read_only_guard_does_not_contact_the_api() {
    let server = start(router(true)).await;
    let (_dir, app, _, id) = setup(&server.url, true);
    assert!(app
        .network_diagnostics_run(&id, &request())
        .await
        .unwrap_err()
        .to_string()
        .contains("read-only"));
    assert!(server.log.lock().is_empty());
}

#[tokio::test]
async fn denied_exec_never_attempts_to_fetch_or_exec_the_pod() {
    let server = start(router(false)).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    let error = app
        .network_diagnostics_run(&id, &request())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("network-diagnostics:exec-permission"),
        "{error}"
    );
    assert!(!server.log.lock().iter().any(|r| r.path.contains("/pods/")));
}

#[tokio::test]
async fn source_container_is_revalidated_before_any_exec() {
    let server = start(router(true)).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    let error = app
        .network_diagnostics_run(&id, &request())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("network-diagnostics:source-not-running"),
        "{error}"
    );
    assert!(server
        .log
        .lock()
        .iter()
        .any(|r| r.path.ends_with("/pods/web-0")));
    assert!(!server.log.lock().iter().any(|r| r.path.contains("/exec")));
}
