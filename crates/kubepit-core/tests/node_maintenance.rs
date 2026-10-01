//! Loopback API fixtures only. Explicit temporary paths never read ~/.kube.
mod support;

use kubepit_core::nodes::{NodeMaintenanceDrainRequest, NodeMaintenancePlan};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use support::{setup, start, status, Reply, Router};

#[derive(Default)]
struct State {
    replaced: AtomicBool,
    cordoned: AtomicBool,
    evicted: AtomicBool,
    partial: AtomicBool,
    deny_eviction: AtomicBool,
    pdb_blocks: AtomicBool,
}
fn pod(name: &str, uid: &str, node: &str) -> Value {
    json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":name,"uid":uid,"namespace":"team-a","resourceVersion":"10","labels":{"app":"web"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"web-rs","uid":"owner-a","controller":true}]},"spec":{"nodeName":node,"containers":[{"name":"app","image":"fixture"}],"volumes":[{"name":"cache","emptyDir":{}}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}})
}
fn router(state: Arc<State>) -> Router {
    Arc::new(move |req, _| {
        let node = || json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"node-a","uid":if state.replaced.load(Ordering::SeqCst){"node-replaced"}else{"node-original"},"resourceVersion":"10"},"spec":{"unschedulable":state.cordoned.load(Ordering::SeqCst)}});
        match (req.method.as_str(), req.path_only()) {
            (_, "/version") => Reply::Json(
                200,
                json!({"major":"1","minor":"31","gitVersion":"v1.31.0","gitCommit":"abc","gitTreeState":"clean","buildDate":"2024-01-01T00:00:00Z","goVersion":"go1.22","compiler":"gc","platform":"linux/amd64"}),
            ),
            (_, "/apis") => Reply::Json(
                200,
                json!({"apiVersion":"v1","kind":"APIGroupList","groups":[]}),
            ),
            ("GET", "/api/v1/nodes/node-a") => Reply::Json(200, node()),
            ("PATCH", "/api/v1/nodes/node-a") => {
                let body: Value = serde_json::from_str(&req.body).unwrap();
                assert_eq!(
                    body,
                    json!([{"op":"test","path":"/metadata/uid","value":"node-original"},{"op":"test","path":"/metadata/resourceVersion","value":"10"},{"op":"add","path":"/spec/unschedulable","value":true}])
                );
                state.cordoned.store(true, Ordering::SeqCst);
                Reply::Json(200, node())
            }
            ("GET", "/api/v1/pods") => {
                assert!(req.path.contains("fieldSelector=spec.nodeName"));
                Reply::Json(
                    200,
                    json!({"apiVersion":"v1","kind":"PodList","metadata":{},"items":[pod("web-0","source-0","node-a"),pod("web-1","source-1","node-a")]}),
                )
            }
            ("GET", "/api/v1/namespaces/team-a/pods") => {
                let items = if state.evicted.load(Ordering::SeqCst) {
                    vec![
                        pod("web-new-0", "replacement-0", "node-b"),
                        pod("web-new-1", "replacement-1", "node-b"),
                        pod("web-existing", "existing", "node-b"),
                    ]
                } else {
                    vec![
                        pod("web-0", "source-0", "node-a"),
                        pod("web-1", "source-1", "node-a"),
                        pod("web-existing", "existing", "node-b"),
                    ]
                };
                Reply::Json(
                    200,
                    json!({"apiVersion":"v1","kind":"PodList","metadata":{"continue":if state.partial.load(Ordering::SeqCst){"more"}else{""}},"items":items}),
                )
            }
            ("GET", "/apis/policy/v1/poddisruptionbudgets") => Reply::Json(
                200,
                json!({"apiVersion":"policy/v1","kind":"PodDisruptionBudgetList","metadata":{},"items":[{"apiVersion":"policy/v1","kind":"PodDisruptionBudget","metadata":{"name":"web-budget","namespace":"team-a","uid":"budget-a","generation":1},"spec":{"minAvailable":2,"selector":{"matchLabels":{"app":"web"}}},"status":{"observedGeneration":1,"currentHealthy":3,"desiredHealthy":2,"disruptionsAllowed":1,"expectedPods":3}}]}),
            ),
            ("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews") => {
                let body: Value = serde_json::from_str(&req.body).unwrap();
                let attributes = &body["spec"]["resourceAttributes"];
                // Namespace-wide eviction is denied; resourceNames grants allow
                // only each reviewed Pod. The implementation must fall back.
                let allowed = attributes["resource"] == "nodes"
                    || (!state.deny_eviction.load(Ordering::SeqCst)
                        && matches!(attributes["name"].as_str(), Some("web-0" | "web-1")));
                Reply::Json(
                    201,
                    json!({"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":body["spec"],"status":{"allowed":allowed}}),
                )
            }
            ("POST", path) if path.ends_with("/eviction") => {
                assert!(state.cordoned.load(Ordering::SeqCst));
                let body: Value = serde_json::from_str(&req.body).unwrap();
                let uid = if path.contains("/web-0/") {
                    "source-0"
                } else {
                    "source-1"
                };
                assert_eq!(body["deleteOptions"]["preconditions"]["uid"], uid);
                if state.pdb_blocks.load(Ordering::SeqCst) && uid == "source-1" {
                    return Reply::Json(
                        429,
                        status(
                            429,
                            "TooManyRequests",
                            "fixture shared PDB budget exhausted",
                        ),
                    );
                }
                state.evicted.store(true, Ordering::SeqCst);
                Reply::Json(
                    200,
                    json!({"apiVersion":"v1","kind":"Status","status":"Success","code":200}),
                )
            }
            _ => Reply::Json(404, status(404, "NotFound", "fixture route missing")),
        }
    })
}
fn request(plan: &NodeMaintenancePlan) -> NodeMaintenanceDrainRequest {
    NodeMaintenanceDrainRequest {
        plan_id: plan.plan_id.clone(),
        name: plan.node_name.clone(),
        node_uid: plan.node_uid.clone(),
        fingerprint: plan.fingerprint.clone(),
    }
}
fn mutated(log: &support::Log) -> bool {
    log.lock()
        .iter()
        .any(|req| req.method == "PATCH" || req.path.contains("/eviction"))
}

#[tokio::test]
async fn read_only_preflight_is_available_but_mutation_guard_runs_before_any_api_request() {
    let state = Arc::new(State::default());
    let server = start(router(state)).await;
    let (_dir, app, _, id) = setup(&server.url, true);
    let invalid = NodeMaintenanceDrainRequest {
        plan_id: "untrusted".into(),
        name: "node-a".into(),
        node_uid: "untrusted".into(),
        fingerprint: "untrusted".into(),
    };
    assert!(app
        .node_maintenance_drain(&id, &invalid)
        .await
        .unwrap_err()
        .to_string()
        .contains("read-only"));
    assert!(server.log.lock().is_empty());
    app.cluster_connect(&id).await.unwrap();
    server.log.lock().clear();
    let plan = app.node_maintenance_preflight(&id, "node-a").await.unwrap();
    assert!(plan.read_only);
    assert!(plan.inventory_complete);
    assert_eq!(plan.pods.len(), 2);
    assert_eq!(plan.pdbs[0].matched_pods.len(), 2);
    assert_eq!(plan.pdbs[0].required_disruptions, 2);
    assert_eq!(plan.pdbs[0].disruptions_allowed, Some(1));
    assert_eq!(plan.pods[0].volumes[0].kind, "empty-dir");
    assert!(server.log.lock().iter().all(|req| req.method == "GET"));
    let count = server.log.lock().len();
    assert!(app
        .node_maintenance_drain(&id, &request(&plan))
        .await
        .unwrap_err()
        .to_string()
        .contains("read-only"));
    assert_eq!(server.log.lock().len(), count);
}

#[tokio::test]
async fn replaced_node_rejects_reviewed_plan_before_cordon_or_eviction() {
    let state = Arc::new(State::default());
    let server = start(router(state.clone())).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let plan = app.node_maintenance_preflight(&id, "node-a").await.unwrap();
    state.replaced.store(true, Ordering::SeqCst);
    let error = app
        .node_maintenance_drain(&id, &request(&plan))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("stale-plan"), "{error}");
    assert!(!mutated(&server.log));
}

#[tokio::test]
async fn denied_named_eviction_permission_does_not_cordon() {
    let state = Arc::new(State::default());
    state.deny_eviction.store(true, Ordering::SeqCst);
    let server = start(router(state)).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let plan = app.node_maintenance_preflight(&id, "node-a").await.unwrap();
    let error = app
        .node_maintenance_drain(&id, &request(&plan))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("permission-denied"), "{error}");
    assert!(!mutated(&server.log));
}

#[tokio::test]
async fn drain_guards_mutations_by_uid_and_progress_requires_complete_new_pod_inventory() {
    let state = Arc::new(State::default());
    let server = start(router(state.clone())).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let plan = app.node_maintenance_preflight(&id, "node-a").await.unwrap();
    let receipt = app
        .node_maintenance_drain(&id, &request(&plan))
        .await
        .unwrap();
    assert!(receipt.node_cordoned);
    assert_eq!(receipt.evictions.len(), 2);
    assert!(receipt
        .evictions
        .iter()
        .all(|item| item.status == "accepted"));
    let progress = app
        .node_maintenance_progress(&id, &plan.plan_id)
        .await
        .unwrap();
    assert!(progress.sources.iter().all(|item| item.state == "gone"));
    assert!(progress.workloads[0].complete);
    assert_eq!(progress.workloads[0].replacements.len(), 2);
    assert!(progress.workloads[0].replacements.iter().all(|item| item
        .uid
        .starts_with("replacement-")
        && item.ready
        && item.node == "node-b"));
    state.partial.store(true, Ordering::SeqCst);
    let partial = app
        .node_maintenance_progress(&id, &plan.plan_id)
        .await
        .unwrap();
    assert!(partial.sources.iter().all(|item| item.state == "unknown"));
    assert!(!partial.workloads[0].complete);
    assert!(partial
        .warnings
        .iter()
        .any(|warning| warning == "workloads-partial"));
    let count = server
        .log
        .lock()
        .iter()
        .filter(|r| r.method == "PATCH")
        .count();
    assert!(app
        .node_maintenance_drain(&id, &request(&plan))
        .await
        .unwrap_err()
        .to_string()
        .contains("stale-plan"));
    assert_eq!(
        server
            .log
            .lock()
            .iter()
            .filter(|r| r.method == "PATCH")
            .count(),
        count
    );
}

#[tokio::test]
async fn a_shared_pdb_rejection_returns_partial_receipt_and_failed_audit() {
    use kubepit_core::history::{AuditAction, AuditFilter, AuditOutcome};
    let state = Arc::new(State::default());
    state.pdb_blocks.store(true, Ordering::SeqCst);
    let server = start(router(state)).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.set_history_recording(true);
    app.cluster_connect(&id).await.unwrap();
    let plan = app.node_maintenance_preflight(&id, "node-a").await.unwrap();
    assert_eq!(plan.pdbs[0].required_disruptions, 2);
    assert_eq!(plan.pdbs[0].disruptions_allowed, Some(1));
    let receipt = app
        .node_maintenance_drain(&id, &request(&plan))
        .await
        .unwrap();
    assert!(receipt.node_cordoned);
    assert_eq!(
        receipt
            .evictions
            .iter()
            .find(|item| item.uid == "source-0")
            .unwrap()
            .status,
        "accepted"
    );
    let rejected = receipt
        .evictions
        .iter()
        .find(|item| item.uid == "source-1")
        .unwrap();
    assert_eq!(rejected.status, "pdb-blocked");
    assert!(rejected
        .error
        .as_deref()
        .unwrap()
        .contains("shared PDB budget exhausted"));
    assert!(app.history_flush());
    let entries = app
        .history_audit_list(&AuditFilter::default())
        .unwrap()
        .entries;
    let entry = entries
        .iter()
        .find(|entry| entry.action == AuditAction::Drain)
        .unwrap();
    assert_eq!(entry.outcome, AuditOutcome::Error);
}
