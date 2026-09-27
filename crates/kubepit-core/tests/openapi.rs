//! End-to-end tests of the OpenAPI v3 commands (`openapi_v3_index`,
//! `openapi_v3_document`) and their per-connection cache, against the fake
//! API server in `support/`. No real cluster is involved.

mod support;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

/// Knobs the tests turn while the fake server runs.
#[derive(Default)]
struct State {
    /// Bumped to publish a new `apps/v1` document hash.
    apps_revision: AtomicU32,
    /// Serve `cert-manager.io/v1` (a CRD installed while connected).
    crd_installed: AtomicBool,
    /// Answer `/openapi/v3` with 404 (an old or locked-down API server).
    no_openapi: AtomicBool,
}

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn schema_doc(schemas: Value) -> Value {
    json!({
        "openapi": "3.0.0",
        "info": {"title": "Kubernetes", "version": "v1.31.0"},
        "paths": {"/apis/apps/v1/deployments": {"get": {"description": "list"}}},
        "components": {"schemas": schemas, "securitySchemes": {"BearerToken": {"type": "apiKey"}}}
    })
}

fn deployment_schema(revision: u32) -> Value {
    json!({
        "io.k8s.api.apps.v1.Deployment": {
            "type": "object",
            "description": format!("Deployment revision {revision}"),
            "properties": {"spec": {"allOf": [{"$ref": "#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec"}]}},
            "x-kubernetes-group-version-kind": [{"group": "apps", "kind": "Deployment", "version": "v1"}]
        },
        "io.k8s.api.apps.v1.DeploymentSpec": {
            "type": "object",
            "required": ["selector", "template"],
            "properties": {"replicas": {"type": "integer", "format": "int32"}}
        }
    })
}

fn router(state: Arc<State>) -> Router {
    Arc::new(move |req: &Request, _log: &Log| {
        let path = req.path.split('?').next().unwrap_or_default();
        let apps_hash = format!("APPS{}", state.apps_revision.load(Ordering::SeqCst));
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/openapi/v3") if state.no_openapi.load(Ordering::SeqCst) => Reply::Json(
                404,
                status(
                    404,
                    "NotFound",
                    "the server could not find the requested resource",
                ),
            ),
            ("GET", "/openapi/v3") => {
                let mut paths = json!({
                    "api": {"serverRelativeURL": "/openapi/v3/api?hash=API"},
                    "api/v1": {"serverRelativeURL": "/openapi/v3/api/v1?hash=CORE1"},
                    "apis": {"serverRelativeURL": "/openapi/v3/apis?hash=APIS"},
                    "apis/apps": {"serverRelativeURL": "/openapi/v3/apis/apps?hash=GROUP"},
                    "apis/apps/v1": {"serverRelativeURL": format!("/openapi/v3/apis/apps/v1?hash={apps_hash}")},
                    ".well-known/openid-configuration": {"serverRelativeURL": "/openapi/v3/.well-known/openid-configuration?hash=OIDC"},
                    "version": {"serverRelativeURL": "/openapi/v3/version?hash=VERSION"}
                });
                if state.crd_installed.load(Ordering::SeqCst) {
                    paths["apis/cert-manager.io/v1"] = json!({"serverRelativeURL": "/openapi/v3/apis/cert-manager.io/v1?hash=CM1"});
                }
                Reply::Json(200, json!({ "paths": paths }))
            }
            ("GET", "/openapi/v3/api/v1") => Reply::Json(
                200,
                schema_doc(json!({"io.k8s.api.core.v1.Pod": {
                    "type": "object",
                    "x-kubernetes-group-version-kind": [{"group": "", "kind": "Pod", "version": "v1"}]
                }})),
            ),
            ("GET", "/openapi/v3/apis/apps/v1") => Reply::Json(
                200,
                schema_doc(deployment_schema(
                    state.apps_revision.load(Ordering::SeqCst),
                )),
            ),
            ("GET", "/openapi/v3/apis/cert-manager.io/v1")
                if state.crd_installed.load(Ordering::SeqCst) =>
            {
                Reply::Json(
                    200,
                    schema_doc(json!({"io.cert-manager.v1.Certificate": {
                        "type": "object",
                        "x-kubernetes-group-version-kind": [{"group": "cert-manager.io", "kind": "Certificate", "version": "v1"}]
                    }})),
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

/// Requests whose path (without the query) is `path`.
fn hits(log: &Log, path: &str) -> Vec<String> {
    log.lock()
        .iter()
        .filter(|r| r.path.split('?').next() == Some(path))
        .map(|r| r.path.clone())
        .collect()
}

#[tokio::test]
async fn index_lists_group_versions_and_works_on_read_only_clusters() {
    let state = Arc::new(State::default());
    let server = start(router(state)).await;
    let (_dir, app, _rec, id) = setup(&server.url, true);

    let index = app.openapi_v3_index(&id, false).await.unwrap();
    let versions: Vec<&str> = index
        .group_versions
        .iter()
        .map(|gv| gv.api_version.as_str())
        .collect();
    assert_eq!(versions, ["v1", "apps/v1"]);
    assert_eq!(index.group_versions[1].path, "apis/apps/v1");
    assert_eq!(index.group_versions[1].hash.as_deref(), Some("APPS0"));

    // A second call within the TTL is served from memory.
    let again = app.openapi_v3_index(&id, false).await.unwrap();
    assert_eq!(again, index);
    assert_eq!(hits(&server.log, "/openapi/v3").len(), 1);
    // `refresh` always asks the server.
    app.openapi_v3_index(&id, true).await.unwrap();
    assert_eq!(hits(&server.log, "/openapi/v3").len(), 2);
}

#[tokio::test]
async fn documents_are_trimmed_fetched_by_hash_and_cached() {
    let state = Arc::new(State::default());
    let server = start(router(state.clone())).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);

    let doc = app.openapi_v3_document(&id, "apps/v1").await.unwrap();
    assert!(doc.get("paths").is_none(), "paths are stripped");
    assert!(doc.pointer("/components/securitySchemes").is_none());
    assert_eq!(
        doc.pointer("/components/schemas/io.k8s.api.apps.v1.Deployment/description"),
        Some(&json!("Deployment revision 0"))
    );
    assert_eq!(
        hits(&server.log, "/openapi/v3/apis/apps/v1"),
        ["/openapi/v3/apis/apps/v1?hash=APPS0"]
    );

    let core = app.openapi_v3_document(&id, "v1").await.unwrap();
    assert!(core
        .pointer("/components/schemas/io.k8s.api.core.v1.Pod")
        .is_some());

    // Unchanged hash: no new requests.
    app.openapi_v3_document(&id, "apps/v1").await.unwrap();
    app.openapi_v3_document(&id, "v1").await.unwrap();
    assert_eq!(hits(&server.log, "/openapi/v3/apis/apps/v1").len(), 1);
    assert_eq!(hits(&server.log, "/openapi/v3/api/v1").len(), 1);
    assert_eq!(hits(&server.log, "/openapi/v3").len(), 1);

    // A new apps/v1 hash (e.g. an upgrade) refetches only that document.
    state.apps_revision.store(1, Ordering::SeqCst);
    let index = app.openapi_v3_index(&id, true).await.unwrap();
    assert_eq!(index.group_versions[1].hash.as_deref(), Some("APPS1"));
    let doc = app.openapi_v3_document(&id, "apps/v1").await.unwrap();
    assert_eq!(
        doc.pointer("/components/schemas/io.k8s.api.apps.v1.Deployment/description"),
        Some(&json!("Deployment revision 1"))
    );
    assert_eq!(
        hits(&server.log, "/openapi/v3/apis/apps/v1"),
        [
            "/openapi/v3/apis/apps/v1?hash=APPS0",
            "/openapi/v3/apis/apps/v1?hash=APPS1"
        ]
    );
    app.openapi_v3_document(&id, "v1").await.unwrap();
    assert_eq!(hits(&server.log, "/openapi/v3/api/v1").len(), 1);
}

#[tokio::test]
async fn disconnect_drops_the_cache() {
    let state = Arc::new(State::default());
    let server = start(router(state)).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);

    app.openapi_v3_document(&id, "apps/v1").await.unwrap();
    app.cluster_disconnect(&id);
    // The next call reconnects and starts from an empty cache.
    app.openapi_v3_document(&id, "apps/v1").await.unwrap();
    assert_eq!(hits(&server.log, "/openapi/v3").len(), 2);
    assert_eq!(hits(&server.log, "/openapi/v3/apis/apps/v1").len(), 2);
}

#[tokio::test]
async fn a_crd_installed_while_connected_is_found() {
    let state = Arc::new(State::default());
    let server = start(router(state.clone())).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);

    let err = app
        .openapi_v3_document(&id, "cert-manager.io/v1")
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("cert-manager.io/v1 has no OpenAPI v3 document"),
        "{err:#}"
    );
    // The cached index was re-read once before giving up.
    assert_eq!(hits(&server.log, "/openapi/v3").len(), 2);

    state.crd_installed.store(true, Ordering::SeqCst);
    let doc = app
        .openapi_v3_document(&id, "cert-manager.io/v1")
        .await
        .unwrap();
    assert!(doc
        .pointer("/components/schemas/io.cert-manager.v1.Certificate")
        .is_some());
}

#[tokio::test]
async fn clusters_without_openapi_v3_get_a_clear_error() {
    let state = Arc::new(State::default());
    state.no_openapi.store(true, Ordering::SeqCst);
    let server = start(router(state)).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);

    let err = app.openapi_v3_index(&id, false).await.unwrap_err();
    assert!(
        format!("{err:#}").contains("does not publish OpenAPI v3 schemas"),
        "{err:#}"
    );
    assert!(app.openapi_v3_document(&id, "v1").await.is_err());
}
