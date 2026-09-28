//! End-to-end tests of the Pod Security enforce dry run
//! (`pod_security_dry_run`) against the fake API server in `support/`.
//! No real cluster is involved.

mod support;

use std::sync::Arc;

use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const NAMESPACE: &str = "/api/v1/namespaces/web";

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn namespace(labels: Value) -> Value {
    json!({"apiVersion": "v1", "kind": "Namespace",
           "metadata": {"name": "web", "uid": "ns-1", "resourceVersion": "7", "labels": labels},
           "spec": {"finalizers": ["kubernetes"]}, "status": {"phase": "Active"}})
}

fn warning(text: &str) -> (String, String) {
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    ("Warning".to_string(), format!("299 - \"{escaped}\""))
}

/// `web` enforces baseline; a dry run to anything stricter answers with the
/// warnings the PodSecurity admission plugin sends. `forbid` makes the patch
/// fail the way RBAC rejects it.
fn router(forbid: bool) -> Router {
    Arc::new(move |req: &Request, _log: &Log| {
        let path = req.path.split('?').next().unwrap_or_default();
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", NAMESPACE) => Reply::Json(
                200,
                namespace(json!({"pod-security.kubernetes.io/enforce": "baseline"})),
            ),
            ("PATCH", NAMESPACE) if forbid => Reply::Json(
                403,
                status(
                    403,
                    "Forbidden",
                    "namespaces \"web\" is forbidden: User \"dev\" cannot patch resource \"namespaces\"",
                ),
            ),
            ("PATCH", NAMESPACE) => {
                let patch: Value = serde_json::from_str(&req.body).unwrap();
                let labels = patch["metadata"]["labels"].clone();
                Reply::JsonWithHeaders(
                    200,
                    namespace(labels),
                    vec![
                        warning(
                            "existing pods in namespace \"web\" violate the new PodSecurity enforce level \"restricted:latest\"",
                        ),
                        warning(
                            "debug-toolbox-6f7d9-x2k4q: privileged (container \"toolbox\" must not set securityContext.privileged=true), hostPath volumes (volume \"docker-sock\")",
                        ),
                        warning(
                            "storefront-5d8c7-abcde (and 2 other pods): allowPrivilegeEscalation != false (containers \"web\", \"proxy\" must set securityContext.allowPrivilegeEscalation=false), seccompProfile (pod or containers \"web\", \"proxy\" must set securityContext.seccompProfile.type to \"RuntimeDefault\" or \"Localhost\")",
                        ),
                    ],
                )
            }
            _ => Reply::Json(
                404,
                status(
                    404,
                    "NotFound",
                    "the server could not find the requested resource",
                ),
            ),
        }
    })
}

fn patches(log: &Log) -> Vec<Request> {
    log.lock()
        .iter()
        .filter(|r| r.method == "PATCH")
        .cloned()
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dry_run_reports_violations_and_never_persists() {
    let server = start(router(false)).await;
    // A dry run only reads, so it must work on read-only clusters.
    let (_dir, app, _recorder, id) = setup(&server.url, true);

    let result = app
        .pod_security_dry_run(&id, "web", "restricted", "latest")
        .await
        .unwrap();
    assert!(!result.unchanged);
    assert_eq!(result.namespace, "web");
    assert_eq!(result.warnings.len(), 3);
    assert!(result.notes.is_empty(), "{:?}", result.notes);
    assert_eq!(result.violations.len(), 2);
    let debug = &result.violations[0];
    assert_eq!(debug.pod, "debug-toolbox-6f7d9-x2k4q");
    assert_eq!(debug.others, 0);
    assert_eq!(debug.checks.len(), 2);
    assert!(debug.checks[1].starts_with("hostPath volumes"));
    let web = &result.violations[1];
    assert_eq!(web.pod, "storefront-5d8c7-abcde");
    assert_eq!(web.others, 2);
    assert_eq!(web.checks.len(), 2);
    assert!(web.checks[0].contains(r#"containers "web", "proxy""#));

    let sent = patches(&server.log);
    assert_eq!(sent.len(), 1);
    assert!(sent[0].path.contains("dryRun=All"), "{}", sent[0].path);
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(
        body,
        json!({"metadata": {"labels": {
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "latest"
        }}})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_current_policy_is_not_sent() {
    let server = start(router(false)).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let result = app
        .pod_security_dry_run(&id, "web", "baseline", "latest")
        .await
        .unwrap();
    assert!(result.unchanged);
    assert!(result.warnings.is_empty() && result.violations.is_empty());
    assert!(patches(&server.log).is_empty());

    // A different version of the same level is a change the server evaluates.
    let versioned = app
        .pod_security_dry_run(&id, "web", "baseline", "v1.30")
        .await
        .unwrap();
    assert!(!versioned.unchanged);
    assert_eq!(patches(&server.log).len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_policies_and_rbac_errors_are_reported() {
    let server = start(router(true)).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let err = app
        .pod_security_dry_run(&id, "web", "strict", "latest")
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("unknown Pod Security level"));
    let err = app
        .pod_security_dry_run(&id, "web", "baseline", "1.30")
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("unknown Pod Security version"));
    // Nothing reached the server for invalid input.
    assert!(server.log.lock().iter().all(|r| r.method != "PATCH"));

    let err = app
        .pod_security_dry_run(&id, "web", "restricted", "latest")
        .await
        .unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains("cannot patch resource"), "{text}");
    assert_eq!(kubepit_core::error::api_code(&err), Some(403));

    let err = app
        .pod_security_dry_run(&id, "missing", "restricted", "latest")
        .await
        .unwrap_err();
    assert_eq!(kubepit_core::error::api_code(&err), Some(404));
}
