//! End-to-end tests of Helm values schemas and the upgrade preview against
//! a fake `helm` (a shell script that records its arguments) and the fake
//! API server in `support/`. No network, no cluster, and no real helm
//! configuration is ever touched.
#![cfg(unix)]

mod support;

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use kubepit_core::error::is_read_only;
use kubepit_core::helm_preview::HelmPreviewChange;
use kubepit_core::types::{DryRunOperation, HelmUpgradeRequest};
use kubepit_core::Kubepit;
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const SCHEMA: &str = r#"{"$schema":"http://json-schema.org/draft-07/schema#","type":"object",
 "properties":{"replicaCount":{"type":"integer","minimum":1}},"required":["replicaCount"]}"#;

/// What `helm upgrade --dry-run --output json` prints: the next revision.
const DRY_RUN_RELEASE: &str = r#"{"name":"web","namespace":"shop","version":4,
 "info":{"status":"pending-upgrade","description":"Dry run complete","notes":"Upgraded"},
 "chart":{"metadata":{"name":"nginx","version":"18.10.0"},"values":{"replicaCount":1}},
 "config":{"replicaCount":3},
 "manifest":"---\n# Source: nginx/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 3\n---\n# Source: nginx/templates/svc.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  ports:\n  - port: 80\n"}"#;

/// `pull` unpacks a chart into `--destination`, with a schema only when
/// the `with-schema` marker exists; `upgrade` prints the dry-run release.
const SCRIPT: &str = r#"#!/bin/sh
dir="$(dirname "$0")"
printf '%s\n' "$*" >> "$dir/calls.log"
case "$1 $2" in
  "version --short") echo "v3.15.4+gfa9efb0" ;;
  pull\ *)
    dest=""
    for a in "$@"; do
      case "$a" in --destination=*) dest="${a#--destination=}" ;; esac
    done
    mkdir -p "$dest/nginx/templates"
    printf 'apiVersion: v2\nname: nginx\nversion: 18.10.0\n' > "$dest/nginx/Chart.yaml"
    if [ -f "$dir/with-schema" ]; then cp "$dir/schema.json" "$dest/nginx/values.schema.json"; fi
    echo "$dest" > "$dir/last-destination" ;;
  upgrade\ *) cat "$dir/release.json" ;;
  *) echo "Error: unexpected call: $*" >&2; exit 1 ;;
esac
"#;

struct FakeHelm {
    dir: tempfile::TempDir,
}

impl FakeHelm {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("helm");
        std::fs::write(&path, SCRIPT).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.path().join("release.json"), DRY_RUN_RELEASE).unwrap();
        std::fs::write(dir.path().join("schema.json"), SCHEMA).unwrap();
        Self { dir }
    }

    fn path(&self) -> PathBuf {
        self.dir.path().join("helm")
    }

    fn marker(&self, name: &str) {
        std::fs::write(self.dir.path().join(name), "").unwrap();
    }

    fn read(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.path().join(name)).ok()
    }

    fn calls(&self) -> Vec<String> {
        self.read("calls.log")
            .unwrap_or_default()
            .lines()
            .filter(|l| *l != "version --short")
            .map(str::to_string)
            .collect()
    }
}

fn app_with(
    helm: &FakeHelm,
    server: &str,
    read_only: bool,
) -> (tempfile::TempDir, Arc<Kubepit>, String) {
    let (dir, app, _recorder, id) = setup(server, read_only);
    let mut settings = app.settings();
    settings.helm_path = Some(helm.path().to_string_lossy().to_string());
    app.set_settings(settings).unwrap();
    (dir, app, id)
}

fn release_payload() -> String {
    use std::io::Write as _;
    let engine = base64::engine::general_purpose::STANDARD;
    let release = json!({
        "name": "web", "namespace": "shop", "version": 3,
        "info": {"status": "deployed"},
        "chart": {"metadata": {"name": "nginx", "version": "18.2.4"},
                  "values": {"replicaCount": 1},
                  // helm stores `[]byte` fields base64-encoded.
                  "schema": engine.encode(SCHEMA)},
        "config": {"replicaCount": 2},
        "manifest": "---\n# Source: nginx/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n---\n# Source: nginx/templates/cm.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\n"
    });
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(release.to_string().as_bytes()).unwrap();
    engine.encode(engine.encode(gz.finish().unwrap()))
}

fn deployment(replicas: i64) -> Value {
    json!({"apiVersion": "apps/v1", "kind": "Deployment",
           "metadata": {"name": "web", "namespace": "shop", "uid": "uid-web", "resourceVersion": "5"},
           "spec": {"replicas": replicas}})
}

fn router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        if req.method != "GET" && !query.contains("dryRun=All") {
            panic!("the preview sent a real write: {} {}", req.method, req.path);
        }
        match (req.method.as_str(), path) {
            ("GET", "/version") => Reply::Json(
                200,
                json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
                       "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
                       "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
            ),
            ("GET", "/api/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    {"name": "services", "singularName": "service", "namespaced": true, "kind": "Service",
                     "verbs": ["create", "get", "list", "patch"]},
                    {"name": "configmaps", "singularName": "configmap", "namespaced": true, "kind": "ConfigMap",
                     "verbs": ["create", "get", "list", "patch"]}
                ]}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": [
                    {"name": "apps", "versions": [{"groupVersion": "apps/v1", "version": "v1"}],
                     "preferredVersion": {"groupVersion": "apps/v1", "version": "v1"}}]}),
            ),
            ("GET", "/apis/apps/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "apps/v1", "resources": [
                    {"name": "deployments", "singularName": "deployment", "namespaced": true,
                     "kind": "Deployment", "verbs": ["create", "get", "list", "patch"]}]}),
            ),
            ("GET", "/api/v1/namespaces/shop/secrets") => Reply::Json(
                200,
                json!({"kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1",
                       "metadata": {"resourceVersion": "1"}, "items": [
                    {"metadata": {"name": "sh.helm.release.v1.web.v2", "namespace": "shop",
                                  "labels": {"owner": "helm", "name": "web", "version": "2"}}},
                    {"metadata": {"name": "sh.helm.release.v1.web.v3", "namespace": "shop",
                                  "labels": {"owner": "helm", "name": "web", "version": "3"}}}]}),
            ),
            ("GET", "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.web.v3") => Reply::Json(
                200,
                json!({"apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1",
                       "metadata": {"name": "sh.helm.release.v1.web.v3", "namespace": "shop"},
                       "data": {"release": release_payload()}}),
            ),
            ("GET", "/apis/apps/v1/namespaces/shop/deployments/web") => {
                Reply::Json(200, deployment(2))
            }
            ("PATCH", "/apis/apps/v1/namespaces/shop/deployments/web") => {
                let mut result = deployment(2);
                result["spec"] = body["spec"].clone();
                result["metadata"]["resourceVersion"] = json!("6");
                Reply::Json(200, result)
            }
            ("PATCH", "/api/v1/namespaces/shop/services/web") => {
                let mut result = body.clone();
                result["metadata"]["uid"] = json!("uid-svc");
                Reply::Json(201, result)
            }
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn values_schemas_from_releases_and_charts() {
    let server = start(router()).await;
    let helm = FakeHelm::new();
    let (_dir, app, id) = app_with(&helm, &server.url, true);

    // Installed release: read natively from the newest revision's secret.
    let schema = app
        .helm_release_values_schema(&id, "shop", "web")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(schema["required"][0], "replicaCount");
    assert!(helm.calls().is_empty(), "release schemas never shell out");
    assert!(app
        .helm_release_values_schema(&id, "shop", "../web")
        .await
        .is_err());

    // Repository chart without a schema.
    assert_eq!(
        app.helm_chart_values_schema("bitnami/nginx", Some("18.2.4"))
            .await
            .unwrap(),
        None
    );
    // With one: pulled into a private scratch directory that is removed again.
    helm.marker("with-schema");
    let pulled = app
        .helm_chart_values_schema("bitnami/nginx", Some("18.10.0"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pulled["properties"]["replicaCount"]["minimum"], 1);
    let calls = helm.calls();
    let pull = calls.last().unwrap();
    assert!(
        pull.starts_with("pull bitnami/nginx --untar --destination=")
            && pull.ends_with(" --version=18.10.0"),
        "{pull}"
    );
    let destination = helm.read("last-destination").unwrap();
    assert!(destination.contains("helm-pull-"), "{destination}");
    assert!(
        !std::path::Path::new(destination.trim()).exists(),
        "scratch dir removed"
    );
    // Cached: the same version does not pull again.
    app.helm_chart_values_schema("bitnami/nginx", Some("18.10.0"))
        .await
        .unwrap();
    assert_eq!(helm.calls().len(), calls.len());
    // Invalid references never reach helm.
    assert!(app.helm_chart_values_schema("--help", None).await.is_err());
    assert_eq!(helm.calls().len(), calls.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upgrade_preview_diffs_objects_and_live_state_on_read_only_clusters() {
    let server = start(router()).await;
    let helm = FakeHelm::new();
    let (_dir, app, id) = app_with(&helm, &server.url, true);
    let request = HelmUpgradeRequest {
        chart_ref: "bitnami/nginx".into(),
        version: Some("18.10.0".into()),
        values_yaml: "replicaCount: 3\n".into(),
        ..Default::default()
    };

    let preview = app
        .helm_upgrade_preview(&id, "shop", "web", &request, true)
        .await
        .unwrap();
    assert_eq!(preview.current_revision, 3);
    assert_eq!(preview.result.release.as_ref().unwrap().revision, 4);
    assert!(preview.live_checked && !preview.live_truncated);
    let call = helm.calls().pop().unwrap();
    assert!(
        call.starts_with("upgrade web bitnami/nginx --version=18.10.0 --values=")
            && call.contains("--dry-run=server"),
        "the preview is a dry-run upgrade: {call}"
    );
    let summary: Vec<(HelmPreviewChange, &str)> = preview
        .objects
        .iter()
        .map(|o| (o.change, o.key.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (HelmPreviewChange::Added, "/Service/shop/web"),
            (HelmPreviewChange::Changed, "apps/Deployment/shop/web"),
            (HelmPreviewChange::Removed, "/ConfigMap/shop/web-config"),
        ]
    );
    let service = &preview.objects[0];
    assert_eq!(service.source.as_deref(), Some("nginx/templates/svc.yaml"));
    assert_eq!(
        service.live.as_ref().unwrap().operation,
        DryRunOperation::Create
    );
    let deployment = &preview.objects[1];
    assert_eq!(deployment.before.as_ref().unwrap()["spec"]["replicas"], 2);
    assert_eq!(deployment.after.as_ref().unwrap()["spec"]["replicas"], 3);
    let live = deployment.live.as_ref().unwrap();
    assert_eq!(live.operation, DryRunOperation::Update);
    assert_eq!(live.live.as_ref().unwrap()["spec"]["replicas"], 2);
    assert_eq!(live.result.as_ref().unwrap()["spec"]["replicas"], 3);
    assert!(
        preview.objects[2].live.is_none(),
        "removed objects are not applied"
    );

    // Every write the server saw was a dry run of the rendered objects.
    let writes: Vec<String> = server
        .log
        .lock()
        .iter()
        .filter(|r| r.method != "GET")
        .map(|r| r.path.clone())
        .collect();
    assert_eq!(writes.len(), 2, "{writes:?}");
    assert!(
        writes.iter().all(|p| p.contains("dryRun=All")),
        "{writes:?}"
    );

    // Without the live check nothing is sent to the objects.
    let before = server.log.lock().len();
    let quick = app
        .helm_upgrade_preview(&id, "shop", "web", &request, false)
        .await
        .unwrap();
    assert!(!quick.live_checked);
    assert!(quick.objects.iter().all(|o| o.live.is_none()));
    assert!(server.log.lock()[before..]
        .iter()
        .all(|r| r.method == "GET" && !r.path.contains("/deployments/")));

    // The upgrade itself stays blocked on the read-only cluster.
    let err = app
        .helm_upgrade(&id, "shop", "web", &request)
        .await
        .unwrap_err();
    assert!(is_read_only(&err), "{err:#}");
}
