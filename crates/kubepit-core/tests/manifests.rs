//! End-to-end tests of local manifests: rendering folders (plain files and
//! fake `kubectl` / `helm` scripts standing in for Kustomize and Helm) and
//! the per-document dry run / apply against the fake API server in
//! `support/`. No real cluster, kubeconfig or tool is involved: every tool is
//! a shell script in a temp dir configured through the settings overrides.

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use kubepit_core::types::{
    DryRunOperation, ManifestHelmOptions, ManifestSource, ManifestSourceKind, ManifestsWatchEvent,
    Settings,
};
use kubepit_core::{Kubepit, NullSink, Paths};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

fn write(root: &Path, rel: &str, content: &str) -> PathBuf {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, content).unwrap();
    path
}

fn offline_app(dir: &Path) -> Kubepit {
    Kubepit::open(Paths::new(dir.join("home")), Arc::new(NullSink)).unwrap()
}

fn source(path: &Path, kind: ManifestSourceKind) -> ManifestSource {
    ManifestSource {
        paths: vec![path.to_string_lossy().to_string()],
        kind,
        helm: None,
    }
}

#[tokio::test]
async fn plain_folders_render_with_sources_and_are_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let app = offline_app(dir.path());
    let project = dir.path().join("shop");
    write(
        &project,
        "base/namespace.yaml",
        "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n",
    );
    write(
        &project,
        "base/app.yaml",
        "# the app\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: cfg, namespace: shop}\n---\n\
         apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web, namespace: shop}\n",
    );
    write(&project, "base/broken.yaml", "kind: [nope\n");
    write(
        &project,
        "overlays/prod/kustomization.yaml",
        "resources: [../../base]\n",
    );
    write(&project, ".git/HEAD.yaml", "ref: main\n");

    let render = app
        .manifests_render(&source(&project, ManifestSourceKind::Auto))
        .await
        .unwrap();
    assert_eq!(render.kind, ManifestSourceKind::Plain);
    assert_eq!(render.root, project.to_string_lossy());
    assert_eq!(render.files, 3);
    assert_eq!(render.command, None);
    let docs: Vec<(&str, &str, usize)> = render
        .documents
        .iter()
        .map(|d| (d.source.as_str(), d.kind.as_str(), d.line))
        .collect();
    assert_eq!(
        docs,
        vec![
            ("base/app.yaml", "ConfigMap", 1),
            ("base/app.yaml", "Deployment", 6),
            ("base/namespace.yaml", "Namespace", 1),
        ]
    );
    assert_eq!(render.problems.len(), 1);
    assert_eq!(render.problems[0].source, "base/broken.yaml");
    assert_eq!(render.nested.len(), 1);
    assert_eq!(render.nested[0].relative, "overlays/prod");
    assert_eq!(render.nested[0].kind, ManifestSourceKind::Kustomize);

    // The fingerprint stays the same until a file changes.
    let src = source(&project, ManifestSourceKind::Auto);
    let again = app.manifests_render(&src).await.unwrap();
    assert_eq!(again.fingerprint, render.fingerprint);
    write(
        &project,
        "base/extra.yml",
        "apiVersion: v1\nkind: Secret\nmetadata: {name: s}\n",
    );
    let edited = app.manifests_render(&src).await.unwrap();
    assert_ne!(edited.fingerprint, render.fingerprint);

    // Successful renders are remembered, newest first.
    let recent = app.manifests_recent_list();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].source, src);
    assert!(app.manifests_recent_remove(&src.paths).unwrap().is_empty());
    assert!(dir.path().join("home/manifests.json").is_file());

    // Failures are not remembered.
    let missing = dir.path().join("missing");
    let err = app
        .manifests_render(&source(&missing, ManifestSourceKind::Auto))
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("does not exist"), "{err:#}");
    assert!(app.manifests_recent_list().is_empty());
}

#[cfg(unix)]
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
fn use_tools(app: &Kubepit, kubectl: Option<&Path>, helm: Option<&Path>) {
    let path = |p: Option<&Path>| p.map(|p| p.to_string_lossy().to_string());
    app.set_settings(Settings {
        kubectl_path: path(kubectl),
        helm_path: path(helm),
        ..app.settings()
    })
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn kustomize_folders_render_through_the_configured_kubectl() {
    let dir = tempfile::tempdir().unwrap();
    let app = offline_app(dir.path());
    let tools = dir.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let args_file = tools.join("kubectl.args");
    let kubectl = script(
        &tools,
        "kubectl",
        &format!(
            "printf '%s\\n' \"$*\" > '{}'\nprintf 'apiVersion: v1\\nkind: ConfigMap\\nmetadata:\\n  name: prod-cfg\\n---\\napiVersion: apps/v1\\nkind: Deployment\\nmetadata:\\n  name: web\\n'\n",
            args_file.display()
        ),
    );
    use_tools(&app, Some(&kubectl), None);
    let overlay = dir.path().join("overlays/prod");
    write(&overlay, "kustomization.yaml", "resources: []\n");

    let render = app
        .manifests_render(&source(&overlay, ManifestSourceKind::Auto))
        .await
        .unwrap();
    assert_eq!(render.kind, ManifestSourceKind::Kustomize);
    assert_eq!(
        std::fs::read_to_string(&args_file).unwrap().trim(),
        format!("kustomize {}", overlay.display())
    );
    assert_eq!(
        render.command.as_deref(),
        Some(format!("kubectl kustomize {}", overlay.display()).as_str())
    );
    let names: Vec<(&str, &str)> = render
        .documents
        .iter()
        .map(|d| (d.source.as_str(), d.name.as_str()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("kustomization.yaml", "prod-cfg"),
            ("kustomization.yaml", "web")
        ]
    );

    // A failing kustomize build surfaces the tool's own message.
    let failing = script(
        &tools,
        "kubectl-broken",
        "echo 'Error: accumulating resources: missing.yaml: no such file or directory' >&2\nexit 1\n",
    );
    use_tools(&app, Some(&failing), None);
    let err = app
        .manifests_render(&source(&overlay, ManifestSourceKind::Kustomize))
        .await
        .unwrap_err();
    assert_eq!(
        format!("{err:#}"),
        "kubectl kustomize failed: accumulating resources: missing.yaml: no such file or directory"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn helm_charts_render_with_release_values_and_template_sources() {
    let dir = tempfile::tempdir().unwrap();
    let app = offline_app(dir.path());
    let tools = dir.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let args_file = tools.join("helm.args");
    let helm = script(
        &tools,
        "helm",
        &format!(
            "printf '%s\\n' \"$@\" > '{}'\nprintf -- '---\\n# Source: shop/templates/service.yaml\\napiVersion: v1\\nkind: Service\\nmetadata:\\n  name: shop\\n---\\n# Source: shop/templates/deployment.yaml\\napiVersion: apps/v1\\nkind: Deployment\\nmetadata:\\n  name: shop\\n'\n",
            args_file.display()
        ),
    );
    use_tools(&app, None, Some(&helm));
    let chart = dir.path().join("shop");
    write(
        &chart,
        "Chart.yaml",
        "apiVersion: v2\nname: shop\nversion: 0.1.0\n",
    );
    write(&chart, "values-prod.yaml", "replicas: 3\n");

    let mut src = source(&chart, ManifestSourceKind::Auto);
    src.helm = Some(ManifestHelmOptions {
        release_name: "shop-prod".into(),
        namespace: Some("store".into()),
        values_files: vec!["values-prod.yaml".into()],
    });
    let render = app.manifests_render(&src).await.unwrap();
    assert_eq!(render.kind, ManifestSourceKind::Helm);
    let args: Vec<String> = std::fs::read_to_string(&args_file)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(
        args,
        vec![
            "template".to_string(),
            "shop-prod".to_string(),
            chart.to_string_lossy().to_string(),
            "--namespace=store".to_string(),
            "--include-crds".to_string(),
            format!("--values={}", chart.join("values-prod.yaml").display()),
        ]
    );
    let sources: Vec<&str> = render.documents.iter().map(|d| d.source.as_str()).collect();
    assert_eq!(
        sources,
        vec![
            "shop/templates/service.yaml",
            "shop/templates/deployment.yaml"
        ]
    );
    // The values file is part of the fingerprint.
    write(&chart, "values-prod.yaml", "replicas: 5\n");
    let edited = app.manifests_render(&src).await.unwrap();
    assert_ne!(edited.fingerprint, render.fingerprint);

    // Missing chart dependencies get a hint; a missing helm names the fix.
    let failing = script(
        &tools,
        "helm-deps",
        "echo 'Error: found in Chart.yaml, but missing in charts/ directory: redis' >&2\nexit 1\n",
    );
    use_tools(&app, None, Some(&failing));
    let err = app.manifests_render(&src).await.unwrap_err();
    assert!(
        format!("{err:#}").contains("run `helm dependency build`"),
        "{err:#}"
    );
    use_tools(&app, None, Some(&tools.join("no-such-helm")));
    let err = app.manifests_render(&src).await.unwrap_err();
    assert!(format!("{err:#}").contains("helm was not found"), "{err:#}");
}

// ---------------------------------------------------------------------------
// Dry run and apply against the fake API server
// ---------------------------------------------------------------------------

fn configmap(name: &str, data: Value) -> Value {
    json!({"apiVersion": "v1", "kind": "ConfigMap",
           "metadata": {"name": name, "namespace": "default", "uid": format!("uid-{name}"),
                        "resourceVersion": "7"},
           "data": data})
}

fn not_found(what: &str) -> Reply {
    Reply::Json(404, status(404, "NotFound", &format!("{what} not found")))
}

fn router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        let cm = "/api/v1/namespaces/default/configmaps";
        let dry_run = query.contains("dryRun=All");
        match (req.method.as_str(), path) {
            ("GET", "/version") => Reply::Json(
                200,
                json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0", "gitCommit": "abc",
                       "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
                       "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/api/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    {"name": "configmaps", "singularName": "configmap", "namespaced": true,
                     "kind": "ConfigMap", "verbs": ["create", "get", "list", "patch", "update"]},
                    {"name": "namespaces", "singularName": "namespace", "namespaced": false,
                     "kind": "Namespace", "verbs": ["create", "get", "list", "patch", "update"]}
                ]}),
            ),
            ("GET", p) if p == format!("{cm}/existing") || p == format!("{cm}/same") => {
                let name = p.rsplit('/').next().unwrap();
                Reply::Json(200, configmap(name, json!({"k": "v"})))
            }
            ("GET", p) => not_found(p),
            ("PATCH", p) if p == format!("{cm}/bad") => Reply::Json(
                422,
                status(
                    422,
                    "Invalid",
                    "ConfigMap \"bad\" is invalid: data[bad key]: Invalid value: \"bad key\"",
                ),
            ),
            ("PATCH", p) if dry_run && p == format!("{cm}/same") => {
                Reply::Json(200, configmap("same", json!({"k": "v"})))
            }
            ("PATCH", _) => {
                let mut obj = body.clone();
                obj["metadata"]["uid"] = json!("uid-x");
                obj["metadata"]["resourceVersion"] = json!(if dry_run { "7" } else { "8" });
                Reply::Json(200, obj)
            }
            _ => not_found(path),
        }
    })
}

fn documents() -> Vec<String> {
    [
        "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: existing}\ndata: {k: changed}\n",
        "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: same}\ndata: {k: v}\n",
        "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: bad}\ndata: {\"bad key\": v}\n",
        "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: b}\n",
        "apiVersion: v1\nkind: Namespace\nmetadata: {name: shop}\n",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifests_dry_run_reports_every_document_and_never_writes() {
    let server = start(router()).await;
    // Read-only on purpose: diffing is allowed there, applying is not.
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    let results = app
        .manifests_dry_run(&id, &documents(), Some("default"))
        .await
        .unwrap();
    let summary: Vec<(&str, DryRunOperation, bool)> = results
        .iter()
        .map(|r| (r.name.as_str(), r.operation, r.error.is_some()))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("existing", DryRunOperation::Update, false),
            ("same", DryRunOperation::Unchanged, false),
            ("bad", DryRunOperation::Create, true),
            ("", DryRunOperation::Create, true),
            ("shop", DryRunOperation::Create, false),
        ]
    );
    assert!(results[2]
        .error
        .as_deref()
        .unwrap()
        .contains("Invalid value"));
    assert!(results[3]
        .error
        .as_deref()
        .unwrap()
        .contains("one object per document"));
    assert_eq!(results[4].namespace, None);
    assert_eq!(results[0].namespace.as_deref(), Some("default"));
    assert_eq!(results[0].live.as_ref().unwrap()["data"]["k"], "v");
    assert_eq!(results[0].result.as_ref().unwrap()["data"]["k"], "changed");
    let writes: Vec<String> = server
        .log
        .lock()
        .iter()
        .filter(|r| r.method != "GET")
        .map(|r| r.path.clone())
        .collect();
    assert_eq!(writes.len(), 4, "{writes:?}");
    assert!(
        writes.iter().all(|p| p.contains("dryRun=All")),
        "{writes:?}"
    );

    // Applying is refused before any request reaches the server.
    let before = server.log.lock().len();
    let err = app
        .manifests_apply(&id, &documents(), Some("default"))
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is read-only"), "{err:#}");
    assert_eq!(server.log.lock().len(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifests_apply_orders_dependencies_and_keeps_going_after_failures() {
    let server = start(router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    let results = app
        .manifests_apply(&id, &documents(), Some("default"))
        .await
        .unwrap();
    assert_eq!(results.len(), 5);
    let ok: Vec<bool> = results.iter().map(|r| r.error.is_none()).collect();
    assert_eq!(ok, vec![true, true, false, false, true]);
    assert_eq!(
        results[0].object.as_ref().unwrap()["metadata"]["resourceVersion"],
        "8"
    );
    assert!(results[2]
        .error
        .as_deref()
        .unwrap()
        .contains("Invalid value"));
    assert_eq!(
        results[4].object.as_ref().unwrap()["metadata"]["name"],
        "shop"
    );

    // The Namespace went first although it was listed last; every write
    // was a real server-side apply (no dryRun), namespaced objects got the
    // default namespace.
    let writes: Vec<String> = server
        .log
        .lock()
        .iter()
        .filter(|r| r.method == "PATCH")
        .map(|r| r.path.clone())
        .collect();
    assert_eq!(writes.len(), 4, "{writes:?}");
    assert!(
        writes[0].starts_with("/api/v1/namespaces/shop?"),
        "{writes:?}"
    );
    assert!(writes[1].starts_with("/api/v1/namespaces/default/configmaps/existing?"));
    for path in &writes {
        assert!(!path.contains("dryRun"), "{path}");
        assert!(path.contains("fieldManager=kubepit"), "{path}");
        assert!(path.contains("force=true"), "{path}");
    }
}

// ---------------------------------------------------------------------------
// Watch (notify): each test opts in by starting one, on temp dirs only
// ---------------------------------------------------------------------------

const CONFIGMAP_A: &str = "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n";
const CONFIGMAP_B: &str =
    "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: b}\ndata: {key: value}\n";

/// A temp folder holding `files`, and an app whose data directory is a
/// hidden folder inside it (walks skip hidden folders, so the app's own
/// files never change the source's fingerprint).
fn app_with_folder(files: &[(&str, &str)]) -> (tempfile::TempDir, Kubepit) {
    let dir = tempfile::tempdir().unwrap();
    for (rel, content) in files {
        write(dir.path(), rel, content);
    }
    let app = Kubepit::open(Paths::new(dir.path().join(".kubepit")), Arc::new(NullSink)).unwrap();
    (dir, app)
}

fn folder_source(path: &Path) -> ManifestSource {
    source(path, ManifestSourceKind::Auto)
}

async fn next_event(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<ManifestsWatchEvent>,
    within: Duration,
) -> Option<ManifestsWatchEvent> {
    tokio::time::timeout(within, rx.recv()).await.ok().flatten()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifests_watch_reports_edits_after_debounce() {
    let (dir, app) = app_with_folder(&[("a.yaml", CONFIGMAP_A)]);
    let source = folder_source(dir.path());
    let initial = app.manifests_render(&source).await.unwrap().fingerprint;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let id = app
        .manifests_watch(&source, move |e| tx.send(e).is_ok())
        .unwrap();
    std::fs::write(dir.path().join("b.yaml"), CONFIGMAP_B).unwrap();
    let event = next_event(&mut rx, Duration::from_secs(3))
        .await
        .expect("an event");
    assert_eq!(event.watch_id, id);
    assert_ne!(event.fingerprint, initial);
    assert!(
        next_event(&mut rx, Duration::from_millis(800))
            .await
            .is_none(),
        "one event per burst"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifests_watch_sees_atomic_rename_saves() {
    let (dir, app) = app_with_folder(&[("a.yaml", CONFIGMAP_A)]);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.manifests_watch(&folder_source(dir.path()), move |e| tx.send(e).is_ok())
        .unwrap();
    std::fs::write(dir.path().join(".a.yaml.swp"), CONFIGMAP_B).unwrap();
    std::fs::rename(dir.path().join(".a.yaml.swp"), dir.path().join("a.yaml")).unwrap();
    assert!(next_event(&mut rx, Duration::from_secs(3)).await.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifests_watch_ignores_skipped_files_and_stops_on_unwatch() {
    let (dir, app) = app_with_folder(&[("a.yaml", CONFIGMAP_A)]);
    std::fs::create_dir(dir.path().join("node_modules")).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let id = app
        .manifests_watch(&folder_source(dir.path()), move |e| tx.send(e).is_ok())
        .unwrap();
    std::fs::write(dir.path().join("node_modules/x.yaml"), CONFIGMAP_B).unwrap();
    assert!(next_event(&mut rx, Duration::from_secs(1)).await.is_none());
    app.manifests_unwatch(&id);
    std::fs::write(dir.path().join("c.yaml"), CONFIGMAP_B).unwrap();
    assert!(next_event(&mut rx, Duration::from_secs(1)).await.is_none());
}
