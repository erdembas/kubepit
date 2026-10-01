mod support;

use std::sync::Arc;

use serde_json::json;
use support::{Reply, Request};

fn response(request: &Request) -> Reply {
    match request.path_only() {
        "/version" => Reply::Json(
            200,
            json!({"major":"1", "minor":"34", "gitVersion":"v1.34.0", "gitCommit":"fixture", "gitTreeState":"clean", "buildDate":"2026-01-01T00:00:00Z", "goVersion":"go1.24", "compiler":"gc", "platform":"linux/amd64"}),
        ),
        "/apis/authentication.k8s.io/v1/selfsubjectreviews" => Reply::Json(
            201,
            json!({"apiVersion":"authentication.k8s.io/v1", "kind":"SelfSubjectReview", "status":{"userInfo":{"username":"fixture-user"}}}),
        ),
        "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" => Reply::Json(
            201,
            json!({"apiVersion":"authorization.k8s.io/v1", "kind":"SelfSubjectAccessReview", "status":{"allowed":true}}),
        ),
        "/apis/metrics.k8s.io/v1beta1" => Reply::Json(
            200,
            json!({"apiVersion":"v1", "kind":"APIResourceList", "groupVersion":"metrics.k8s.io/v1beta1", "resources":[{"name":"pods", "singularName":"", "namespaced":true, "kind":"PodMetrics", "verbs":["get", "list"]}]}),
        ),
        _ => panic!("unexpected doctor request {}", request.path),
    }
}

#[tokio::test]
async fn checks_fixture_without_connecting_writing_or_mutating() {
    let server = support::start(Arc::new(|request, _| response(request))).await;
    let (_dir, core, recorder, id) = support::setup(&server.url, true);
    let before = core.cluster_list();
    let run_path = core.paths().run_kubeconfig(&id).unwrap();
    let run_before = std::fs::read(&run_path).ok();
    let report = core
        .connection_doctor_run(&id, Some("team-a"))
        .await
        .unwrap();
    assert_eq!(report.namespace, "team-a");
    assert_eq!(report.steps.len(), 7);
    assert!(report.steps.iter().all(|step| step.status != "failed"));
    assert_eq!(report.capabilities.len(), 8);
    assert_eq!(report.metrics_api, "available");
    assert!(report.capabilities.iter().all(|c| c.allowed == Some(true)));
    assert_eq!(
        report
            .capabilities
            .iter()
            .filter(|c| c.blocked_by_read_only)
            .count(),
        2
    );
    assert!(recorder.statuses.lock().is_empty());
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(core.cluster_list()).unwrap()
    );
    assert_eq!(
        core.cluster_status(&id).state,
        kubepit_core::types::ConnState::Disconnected
    );
    assert_eq!(std::fs::read(run_path).ok(), run_before);
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("test-token"));
    assert!(!serialized.contains("fixture-user"));
    assert_eq!(server.log.lock().len(), 11);
    for request in server.log.lock().iter() {
        assert!(request.method == "GET" || request.path_only().ends_with("reviews"));
        if request.path_only().ends_with("selfsubjectaccessreviews") {
            let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
            let attrs = &body["spec"]["resourceAttributes"];
            if attrs["resource"] != "namespaces" {
                assert_eq!(attrs["namespace"], "team-a");
            }
        }
    }
}

#[tokio::test]
async fn unauthorized_is_distinct_and_never_exposes_server_error_body() {
    let server = support::start(Arc::new(|_, _| {
        Reply::Json(
            401,
            support::status(401, "Unauthorized", "fixture-sensitive-error-token"),
        )
    }))
    .await;
    let (_dir, core, _, id) = support::setup(&server.url, false);
    let report = core.connection_doctor_run(&id, None).await.unwrap();
    assert!(report
        .steps
        .iter()
        .any(|s| s.stage == "authentication" && s.code == "unauthorized"));
    assert!(report.capabilities.is_empty());
    assert_eq!(server.log.lock().len(), 1);
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("fixture-sensitive-error-token"));
}

#[tokio::test]
async fn unavailable_identity_and_denied_reviews_are_not_reported_healthy() {
    let server = support::start(Arc::new(|request, _| match request.path_only() {
        "/apis/authentication.k8s.io/v1/selfsubjectreviews" => Reply::Json(404, support::status(404, "NotFound", "unsupported")),
        "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" => Reply::Json(201, json!({"apiVersion":"authorization.k8s.io/v1", "kind":"SelfSubjectAccessReview", "status":{"allowed":false}})),
        _ => response(request),
    })).await;
    let (_dir, core, _, id) = support::setup(&server.url, false);
    let report = core.connection_doctor_run(&id, None).await.unwrap();
    assert!(report
        .steps
        .iter()
        .any(|s| s.code == "identity-unavailable" && s.status == "warning"));
    assert!(report
        .steps
        .iter()
        .any(|s| s.code == "permissions-limited" && s.status == "warning"));
    assert!(report.capabilities.iter().all(|c| c.allowed == Some(false)));
}

#[tokio::test]
async fn missing_helper_stops_before_any_network_request() {
    let server = support::start(Arc::new(|request, _| response(request))).await;
    let (_dir, core, _, id) = support::setup(&server.url, false);
    let cluster = core
        .cluster_list()
        .into_iter()
        .find(|c| c.id == id)
        .unwrap();
    let config = support::kubeconfig_for(&server.url).replace("token: test-token", "exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: /missing/kubepit-fixture-auth\n      interactiveMode: Never");
    std::fs::write(cluster.kubeconfig_path, config).unwrap();
    let report = core.connection_doctor_run(&id, None).await.unwrap();
    assert!(report
        .steps
        .iter()
        .any(|s| s.code == "auth-helper-missing" && s.status == "failed"));
    assert!(server.log.lock().is_empty());
}

#[tokio::test]
async fn invalid_namespace_stops_before_network() {
    let server = support::start(Arc::new(|request, _| response(request))).await;
    let (_dir, core, _, id) = support::setup(&server.url, false);
    let report = core
        .connection_doctor_run(&id, Some("default/../../secret"))
        .await
        .unwrap();
    assert_eq!(report.steps[0].code, "namespace-invalid");
    assert!(server.log.lock().is_empty());
}
