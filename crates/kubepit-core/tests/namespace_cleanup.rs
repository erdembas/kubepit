//! Loopback API fixtures only. Explicit temporary paths never read ~/.kube.
mod support;

use kubepit_core::history::{AuditAction, AuditFilter, AuditOutcome};
use kubepit_core::namespace_cleanup::NamespaceCleanupRequest;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::{setup, start, status, Reply, Router};

#[derive(Default)]
struct State {
    /// DELETE request order, as `plural:kind` markers.
    deleted: Mutex<Vec<String>>,
    /// Paths that answer 404 (already gone) or 500 (broken).
    outcomes: Mutex<Vec<(String, u16)>>,
}

fn meta_list(kind: &str, names: &[&str]) -> Value {
    json!({
        "apiVersion": "v1", "kind": format!("{kind}List"), "metadata": {},
        "items": names.iter().map(|n| json!({
            "metadata": {"name": n, "namespace": "team-a", "uid": format!("uid-{n}"),
                         "resourceVersion": "1"}
        })).collect::<Vec<_>>(),
    })
}

fn namespaced(plural: &str) -> String {
    format!("/api/v1/namespaces/team-a/{plural}")
}

fn router(state: Arc<State>) -> Router {
    let deploy_list = |n: &[&str]| {
        json!({
            "apiVersion": "apps/v1", "kind": "DeploymentList", "metadata": {},
            "items": n.iter().map(|name| json!({
                "metadata": {"name": name, "namespace": "team-a", "uid": format!("uid-{name}"),
                             "resourceVersion": "1"}
            })).collect::<Vec<_>>(),
        })
    };
    Arc::new(move |req, _| {
        let path = req.path_only().to_string();
        match (req.method.as_str(), path.as_str()) {
            (_, "/version") => Reply::Json(
                200,
                json!({"major":"1","minor":"31","gitVersion":"v1.31.0","gitCommit":"abc","gitTreeState":"clean","buildDate":"2024-01-01T00:00:00Z","goVersion":"go1.22","compiler":"gc","platform":"linux/amd64"}),
            ),
            // -- Discovery -----------------------------------------------------
            ("GET", "/api/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    {"name": "pods", "singularName": "pod", "namespaced": true, "kind": "Pod",
                     "verbs": ["get", "list", "watch", "delete"]},
                    {"name": "services", "singularName": "service", "namespaced": true, "kind": "Service",
                     "verbs": ["get", "list", "watch", "delete"]},
                    {"name": "persistentvolumeclaims", "singularName": "persistentvolumeclaim",
                     "namespaced": true, "kind": "PersistentVolumeClaim",
                     "verbs": ["get", "list", "watch", "delete"]},
                    {"name": "events", "singularName": "event", "namespaced": true, "kind": "Event",
                     "verbs": ["get", "list", "watch", "delete"]},
                    {"name": "namespaces", "singularName": "namespace", "namespaced": false,
                     "kind": "Namespace", "verbs": ["get", "list", "watch", "delete"]},
                    {"name": "bindings", "singularName": "binding", "namespaced": true,
                     "kind": "Binding", "verbs": ["get", "list", "create"]}
                ]}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"apiVersion":"v1","kind":"APIGroupList","groups":[
                    {"name":"apps","versions":[{"groupVersion":"apps/v1","version":"v1"}],
                     "preferredVersion":{"groupVersion":"apps/v1","version":"v1"}}]}),
            ),
            ("GET", "/apis/apps/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "apps/v1", "resources": [
                    {"name": "deployments", "singularName": "deployment", "namespaced": true,
                     "kind": "Deployment", "verbs": ["get", "list", "watch", "delete"]}
                ]}),
            ),
            // -- The namespace itself ------------------------------------------
            ("GET", "/api/v1/namespaces/team-a") => Reply::Json(
                200,
                json!({"apiVersion":"v1","kind":"Namespace",
                       "metadata":{"name":"team-a","uid":"ns-1","resourceVersion":"9"},
                       "status":{"phase":"Active"}}),
            ),
            ("GET", "/api/v1/namespaces/missing") => Reply::Json(
                404,
                status(404, "NotFound", "namespaces \"missing\" not found"),
            ),
            // -- Inventory lists ------------------------------------------------
            ("GET", p) if p == namespaced("pods") => {
                Reply::Json(200, meta_list("Pod", &["web-0", "web-gone"]))
            }
            ("GET", p) if p == namespaced("services") => {
                Reply::Json(200, meta_list("Service", &["web"]))
            }
            ("GET", p) if p == namespaced("persistentvolumeclaims") => {
                Reply::Json(200, meta_list("PersistentVolumeClaim", &["data-0"]))
            }
            ("GET", p) if p == namespaced("events") => {
                Reply::Json(200, meta_list("Event", &["e-0", "e-1"]))
            }
            ("GET", "/apis/apps/v1/namespaces/team-a/deployments") => {
                Reply::Json(200, deploy_list(&["web"]))
            }
            // -- Deletes --------------------------------------------------------
            ("DELETE", p) => {
                let name = p.rsplit('/').next().unwrap_or_default().to_string();
                let code = state
                    .outcomes
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(needle, _)| *needle == name)
                    .map(|(_, code)| *code)
                    .unwrap_or(200);
                if code == 200 {
                    state.deleted.lock().unwrap().push(p.to_string());
                    Reply::Json(
                        200,
                        json!({"apiVersion":"v1","kind":"Status","status":"Success","code":200}),
                    )
                } else {
                    Reply::Json(code, status(code, "Broken", "fixture delete failure"))
                }
            }
            _ => Reply::Json(404, status(404, "NotFound", "fixture route missing")),
        }
    })
}

fn deletes(log: &support::Log) -> Vec<String> {
    log.lock()
        .iter()
        .filter(|r| r.method == "DELETE")
        .map(|r| r.path_only().to_string())
        .collect()
}

#[tokio::test]
async fn preview_lists_kinds_in_deletion_order_and_refuses_system_namespaces() {
    let server = start(router(Arc::new(State::default()))).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();

    let plan = app.namespace_cleanup_preview(&id, "team-a").await.unwrap();
    let kinds: Vec<&str> = plan.kinds.iter().map(|k| k.gvk.kind.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            "Deployment", // controllers first
            "Service",    // ordinary kinds
            "Pod",
            "PersistentVolumeClaim", // data last (before events)
            "Event",
        ]
    );
    assert_eq!(plan.total_objects, 7);
    assert!(plan.inventory_complete);
    assert!(!plan.read_only);
    assert!(!plan.terminating);
    assert!(plan.warnings.is_empty());
    assert_eq!(plan.kinds[0].count, 1);
    assert_eq!(plan.kinds[2].names, vec!["web-0", "web-gone"]);

    for system in ["kube-system", "default", "kube-public", "kube-node-lease"] {
        let err = app
            .namespace_cleanup_preview(&id, system)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("system-namespace"), "{err}");
    }
    let err = app
        .namespace_cleanup_preview(&id, "missing")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not-found"), "{err}");
    assert!(deletes(&server.log).is_empty());
}

#[tokio::test]
async fn read_only_clusters_may_inspect_but_never_purge() {
    let server = start(router(Arc::new(State::default()))).await;
    let (_dir, app, _, id) = setup(&server.url, true);
    app.cluster_connect(&id).await.unwrap();

    let plan = app.namespace_cleanup_preview(&id, "team-a").await.unwrap();
    assert!(plan.read_only);
    assert_eq!(plan.total_objects, 7);

    let err = app
        .namespace_cleanup_run(
            &id,
            &NamespaceCleanupRequest {
                namespace: "team-a".into(),
                confirm_name: "team-a".into(),
            },
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("is read-only"), "{err}");
    assert!(deletes(&server.log).is_empty(), "no delete may be sent");
}

#[tokio::test]
async fn the_run_demands_the_typed_namespace_name_again() {
    let state = Arc::new(State::default());
    let server = start(router(state.clone())).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();

    let err = app
        .namespace_cleanup_run(
            &id,
            &NamespaceCleanupRequest {
                namespace: "team-a".into(),
                confirm_name: "typo".into(),
            },
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("confirm-mismatch"), "{err}");
    assert!(
        deletes(&server.log).is_empty(),
        "a wrong confirmation must not delete anything"
    );
    assert!(state.deleted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn run_deletes_in_order_reports_churn_and_failures_and_audits() {
    let state = Arc::new(State::default());
    // `web-gone` vanishes between inventory and delete; `e-1` fails hard.
    state
        .outcomes
        .lock()
        .unwrap()
        .extend([("web-gone".to_string(), 404), ("e-1".to_string(), 500)]);
    let server = start(router(state.clone())).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.set_history_recording(true);
    app.cluster_connect(&id).await.unwrap();

    let result = app
        .namespace_cleanup_run(
            &id,
            &NamespaceCleanupRequest {
                namespace: "team-a".into(),
                confirm_name: "team-a".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(result.deleted, 5);
    assert_eq!(result.already_gone, 1);
    assert_eq!(result.failed, 1);
    let events = result.kinds.iter().find(|k| k.gvk.kind == "Event").unwrap();
    assert_eq!(events.failed, 1);
    assert_eq!(events.errors.len(), 1);
    assert!(events.errors[0].starts_with("e-1: "), "{:?}", events.errors);
    assert_eq!(
        state.deleted.lock().unwrap().clone(),
        vec![
            "/apis/apps/v1/namespaces/team-a/deployments/web",
            "/api/v1/namespaces/team-a/services/web",
            "/api/v1/namespaces/team-a/pods/web-0",
            "/api/v1/namespaces/team-a/persistentvolumeclaims/data-0",
            "/api/v1/namespaces/team-a/events/e-0",
        ],
        "kinds are deleted stage by stage, names within a kind in order"
    );

    // Audit: one namespace-cleanup entry, one target per kind, failed → error.
    assert!(app.history_flush());
    let entries = app
        .history_audit_list(&AuditFilter::default())
        .unwrap()
        .entries;
    let entry = entries
        .iter()
        .find(|e| e.action == AuditAction::NamespaceCleanup)
        .expect("the purge is recorded");
    assert_eq!(entry.outcome, AuditOutcome::Error);
    assert!(!entry.dry_run);
    let mut target_kinds: Vec<&str> = entry.targets.iter().map(|t| t.kind.as_str()).collect();
    target_kinds.sort();
    assert_eq!(
        target_kinds,
        vec![
            "Deployment",
            "Event",
            "PersistentVolumeClaim",
            "Pod",
            "Service"
        ]
    );
    assert!(entry
        .targets
        .iter()
        .all(|t| t.name == "(all)" && t.namespace.as_deref() == Some("team-a")));
    assert_eq!(entry.request.as_ref().unwrap()["confirm"], "team-a");
    assert!(entry
        .result
        .as_deref()
        .unwrap()
        .contains("deleted 5 objects in 5 kinds"));
}

#[tokio::test]
async fn purges_of_system_namespaces_are_refused_before_any_request() {
    let server = start(router(Arc::new(State::default()))).await;
    let (_dir, app, _, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let err = app
        .namespace_cleanup_run(
            &id,
            &NamespaceCleanupRequest {
                namespace: "kube-system".into(),
                confirm_name: "kube-system".into(),
            },
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("system-namespace"), "{err}");
    assert!(deletes(&server.log).is_empty());
}
