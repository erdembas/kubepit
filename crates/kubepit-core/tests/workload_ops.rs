//! End-to-end tests of the workload operations (rollout history / undo, set
//! image, server-side dry run) against the fake API server in `support/`.
//! No real cluster is involved.

mod support;

use std::sync::Arc;

use kubepit_core::types::{ApplyMode, ContainerImage, DryRunOperation, Gvk};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const REVISION: &str = "deployment.kubernetes.io/revision";
const CHANGE_CAUSE: &str = "kubernetes.io/change-cause";

fn apps(kind: &str, plural: &str) -> Gvk {
    Gvk {
        group: "apps".into(),
        version: "v1".into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced: true,
    }
}

fn pods() -> Gvk {
    Gvk {
        group: String::new(),
        version: "v1".into(),
        kind: "Pod".into(),
        plural: "pods".into(),
        namespaced: true,
    }
}

fn pod_template(app: &str, image: &str) -> Value {
    json!({
        "metadata": {"labels": {"app": app}},
        "spec": {"containers": [{"name": app, "image": image}, {"name": "envoy", "image": "envoy:v1.32"}]}
    })
}

fn deployment(name: &str, paused: bool) -> Value {
    json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": name, "namespace": "shop", "uid": format!("{name}-uid"), "resourceVersion": "40",
                     "annotations": {REVISION: "3", "team": "shop", CHANGE_CAUSE: "deploy nginx:1.27"}},
        "spec": {"paused": paused, "replicas": 2, "selector": {"matchLabels": {"app": "web"}},
                 "template": pod_template("web", "nginx:1.27")}
    })
}

fn replica_set(revision: u32, image: &str, owner: &str) -> Value {
    let mut template = pod_template("web", image);
    template["metadata"]["labels"]["pod-template-hash"] = json!(format!("h{revision}"));
    json!({
        "apiVersion": "apps/v1", "kind": "ReplicaSet",
        "metadata": {"name": format!("web-h{revision}"), "namespace": "shop",
                     "creationTimestamp": format!("2024-05-0{revision}T10:00:00Z"),
                     "annotations": {REVISION: revision.to_string(), CHANGE_CAUSE: format!("deploy {image}")},
                     "ownerReferences": [{"apiVersion": "apps/v1", "kind": "Deployment", "name": "web",
                                          "uid": owner, "controller": true}]},
        "spec": {"replicas": if revision == 3 { 2 } else { 0 }, "template": template},
        "status": {"replicas": if revision == 3 { 2 } else { 0 }, "readyReplicas": if revision == 3 { 1 } else { 0 }}
    })
}

fn controller_revision(revision: i64, image: &str) -> Value {
    let mut template = pod_template("db", image);
    template["$patch"] = json!("replace");
    json!({
        "apiVersion": "apps/v1", "kind": "ControllerRevision",
        "metadata": {"name": format!("db-r{revision}"), "namespace": "shop",
                     "annotations": {CHANGE_CAUSE: format!("upgrade to {image}")},
                     "ownerReferences": [{"uid": "db-uid", "controller": true, "kind": "StatefulSet", "name": "db"}]},
        "revision": revision,
        "data": {"spec": {"template": template}}
    })
}

fn list(kind: &str, items: Vec<Value>) -> Value {
    json!({"kind": format!("{kind}List"), "apiVersion": "apps/v1", "metadata": {"resourceVersion": "1"}, "items": items})
}

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0", "gitCommit": "abc",
               "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z", "goVersion": "go1.22",
               "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn not_found(what: &str) -> Reply {
    Reply::Json(404, status(404, "NotFound", &format!("{what} not found")))
}

/// Deployments `web` / `paused`, StatefulSet `db`, their revisions and a pod.
fn workload_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/apis/apps/v1/namespaces/shop/deployments/web") => {
                Reply::Json(200, deployment("web", false))
            }
            ("GET", "/apis/apps/v1/namespaces/shop/deployments/paused") => {
                Reply::Json(200, deployment("paused", true))
            }
            ("GET", "/apis/apps/v1/namespaces/shop/replicasets") => {
                assert!(query.contains("labelSelector=app%3Dweb"), "{query}");
                Reply::Json(
                    200,
                    list(
                        "ReplicaSet",
                        vec![
                            replica_set(1, "nginx:1.25", "web-uid"),
                            replica_set(3, "nginx:1.27", "web-uid"),
                            replica_set(2, "nginx:1.26", "web-uid"),
                            replica_set(7, "nginx:9", "someone-else"),
                        ],
                    ),
                )
            }
            ("PATCH", "/apis/apps/v1/namespaces/shop/deployments/web") => {
                let mut dep = deployment("web", false);
                if let Some(image) = body.pointer("/spec/template/spec/containers/0/image") {
                    dep["spec"]["template"]["spec"]["containers"][0]["image"] = image.clone();
                }
                Reply::Json(200, dep)
            }
            ("GET", "/apis/apps/v1/namespaces/shop/statefulsets/db") => Reply::Json(
                200,
                json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
                       "metadata": {"name": "db", "namespace": "shop", "uid": "db-uid"},
                       "spec": {"selector": {"matchLabels": {"app": "db"}}, "template": pod_template("db", "postgres:16")},
                       "status": {"currentRevision": "db-r2", "updateRevision": "db-r2"}}),
            ),
            ("GET", "/apis/apps/v1/namespaces/shop/controllerrevisions") => {
                assert!(query.contains("labelSelector=app%3Ddb"), "{query}");
                Reply::Json(
                    200,
                    list(
                        "ControllerRevision",
                        vec![
                            controller_revision(1, "postgres:15"),
                            controller_revision(2, "postgres:16"),
                        ],
                    ),
                )
            }
            ("PATCH", "/apis/apps/v1/namespaces/shop/statefulsets/db") => Reply::Json(
                200,
                json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
                       "metadata": {"name": "db", "namespace": "shop", "uid": "db-uid"}}),
            ),
            ("GET", "/api/v1/namespaces/shop/pods/api-0") => Reply::Json(
                200,
                json!({"apiVersion": "v1", "kind": "Pod",
                       "metadata": {"name": "api-0", "namespace": "shop", "uid": "pod-uid"},
                       "spec": {"containers": [{"name": "api", "image": "api:1"}],
                                "initContainers": [{"name": "init", "image": "busybox:1.36"}]}}),
            ),
            ("PATCH", "/api/v1/namespaces/shop/pods/api-0") => Reply::Json(
                200,
                json!({"apiVersion": "v1", "kind": "Pod",
                       "metadata": {"name": "api-0", "namespace": "shop", "uid": "pod-uid",
                                    "managedFields": [{"manager": "kubepit"}]},
                       "spec": body["spec"].clone()}),
            ),
            _ => not_found(path),
        }
    })
}

fn patches(log: &Log, path: &str) -> Vec<Value> {
    log.lock()
        .iter()
        .filter(|r| r.method == "PATCH" && r.path.split('?').next() == Some(path))
        .map(|r| serde_json::from_str(&r.body).unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollout_history_and_undo_against_fake_apiserver() {
    let server = start(workload_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    let deployments = apps("Deployment", "deployments");
    let dep_path = "/apis/apps/v1/namespaces/shop/deployments/web";

    // History: owned ReplicaSets only, newest first, current by annotation.
    let history = app
        .rollout_history(&id, &deployments, "shop", "web")
        .await
        .unwrap();
    let summary: Vec<(i64, bool, &str)> = history
        .iter()
        .map(|r| (r.revision, r.current, r.images[0].image.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (3, true, "nginx:1.27"),
            (2, false, "nginx:1.26"),
            (1, false, "nginx:1.25")
        ]
    );
    assert_eq!(history[0].replicas, Some(2));
    assert_eq!(history[0].ready_replicas, Some(1));
    assert_eq!(
        history[1].change_cause.as_deref(),
        Some("deploy nginx:1.26")
    );
    assert!(history[0].template["metadata"]["labels"]
        .get("pod-template-hash")
        .is_none());

    // Undo to the previous revision: an RFC 6902 patch replacing the template.
    app.rollout_undo(&id, &deployments, "shop", "web", 0)
        .await
        .unwrap();
    let sent = patches(&server.log, dep_path);
    assert_eq!(sent.len(), 1);
    let ops = sent[0].as_array().expect("a JSON patch");
    assert_eq!(ops[0]["op"], "replace");
    assert_eq!(ops[0]["path"], "/spec/template");
    assert_eq!(
        ops[0]["value"]["spec"]["containers"][0]["image"],
        "nginx:1.26"
    );
    assert!(ops[0]["value"]["metadata"]["labels"]
        .get("pod-template-hash")
        .is_none());
    assert_eq!(ops[1]["path"], "/metadata/annotations");
    assert_eq!(ops[1]["value"][CHANGE_CAUSE], "deploy nginx:1.26");
    assert_eq!(ops[1]["value"]["team"], "shop");

    // Explicit revision; the current one and unknown ones are refused.
    app.rollout_undo(&id, &deployments, "shop", "web", 1)
        .await
        .unwrap();
    assert_eq!(
        patches(&server.log, dep_path)[1][0]["value"]["spec"]["containers"][0]["image"],
        "nginx:1.25"
    );
    let err = app
        .rollout_undo(&id, &deployments, "shop", "web", 3)
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("already the current revision"),
        "{err:#}"
    );
    let err = app
        .rollout_undo(&id, &deployments, "shop", "web", 9)
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("revision 9 not found"),
        "{err:#}"
    );
    let err = app
        .rollout_undo(&id, &deployments, "shop", "paused", 0)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is paused"), "{err:#}");
    assert_eq!(
        patches(&server.log, dep_path).len(),
        2,
        "refused undos send nothing"
    );

    // StatefulSet: ControllerRevisions, strategic merge of the revision data.
    let statefulsets = apps("StatefulSet", "statefulsets");
    let history = app
        .rollout_history(&id, &statefulsets, "shop", "db")
        .await
        .unwrap();
    assert_eq!(
        history
            .iter()
            .map(|r| (r.revision, r.current))
            .collect::<Vec<_>>(),
        vec![(2, true), (1, false)]
    );
    assert!(history[1].template.get("$patch").is_none());
    assert_eq!(history[1].replicas, None);
    app.rollout_undo(&id, &statefulsets, "shop", "db", 0)
        .await
        .unwrap();
    let sent = patches(&server.log, "/apis/apps/v1/namespaces/shop/statefulsets/db");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["spec"]["template"]["$patch"], "replace");
    assert_eq!(
        sent[0]["spec"]["template"]["spec"]["containers"][0]["image"],
        "postgres:15"
    );
    assert_eq!(
        sent[0]["metadata"]["annotations"][CHANGE_CAUSE],
        "upgrade to postgres:15"
    );

    // Kinds without history are refused up front.
    assert!(app
        .rollout_history(&id, &apps("ReplicaSet", "replicasets"), "shop", "web-h3")
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_image_patches_the_pod_spec_and_records_change_cause() {
    let server = start(workload_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    let deployments = apps("Deployment", "deployments");
    let image = |container: &str, image: &str, init: bool| ContainerImage {
        container: container.into(),
        image: image.into(),
        init,
    };

    let updated = app
        .resource_set_image(
            &id,
            &deployments,
            Some("shop"),
            "web",
            vec![
                image("web", "nginx:1.28", false),
                image("envoy", "envoy:v1.32", false),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        updated["spec"]["template"]["spec"]["containers"][0]["image"],
        "nginx:1.28"
    );
    let sent = patches(&server.log, "/apis/apps/v1/namespaces/shop/deployments/web");
    assert_eq!(
        sent,
        vec![json!({
            "metadata": {"annotations": {CHANGE_CAUSE: "kubepit set image deployment/web web=nginx:1.28"}},
            "spec": {"template": {"spec": {"containers": [{"name": "web", "image": "nginx:1.28"}]}}}
        })],
        "unchanged containers are left out"
    );

    // Pods: spec.containers / initContainers, no change-cause, managedFields stripped.
    let pod = app
        .resource_set_image(
            &id,
            &pods(),
            Some("shop"),
            "api-0",
            vec![image("init", "busybox:1.37", true)],
        )
        .await
        .unwrap();
    assert!(pod["metadata"].get("managedFields").is_none());
    assert_eq!(
        patches(&server.log, "/api/v1/namespaces/shop/pods/api-0"),
        vec![json!({"spec": {"initContainers": [{"name": "init", "image": "busybox:1.37"}]}})]
    );

    // Unknown containers, no-ops and malformed images send no PATCH.
    let before = server.log.lock().len();
    let err = app
        .resource_set_image(
            &id,
            &pods(),
            Some("shop"),
            "api-0",
            vec![image("sidecar", "x:1", false)],
        )
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("container \"sidecar\" not found"),
        "{err:#}"
    );
    let err = app
        .resource_set_image(
            &id,
            &pods(),
            Some("shop"),
            "api-0",
            vec![image("api", "api:1", false)],
        )
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("already runs these images"),
        "{err:#}"
    );
    let gets = server.log.lock().len() - before;
    assert_eq!(gets, 2, "only the two GETs reached the server");
    let err = app
        .resource_set_image(
            &id,
            &pods(),
            Some("shop"),
            "api-0",
            vec![image("api", "api 2", false)],
        )
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("whitespace"), "{err:#}");
    assert_eq!(
        server.log.lock().len() - before,
        2,
        "validated before any request"
    );
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

fn configmap(name: &str, data: Value) -> Value {
    json!({"apiVersion": "v1", "kind": "ConfigMap",
           "metadata": {"name": name, "namespace": "default", "uid": format!("uid-{name}"),
                        "resourceVersion": "7", "managedFields": [{"manager": "kubectl"}]},
           "data": data})
}

fn dry_run_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        let cm = "/api/v1/namespaces/default/configmaps";
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/api/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    {"name": "configmaps", "singularName": "configmap", "namespaced": true, "kind": "ConfigMap",
                     "verbs": ["create", "get", "list", "patch", "update"]}
                ]}),
            ),
            ("GET", p) if p == format!("{cm}/existing") => {
                Reply::Json(200, configmap("existing", json!({"k": "v"})))
            }
            ("GET", p) if p == format!("{cm}/same") => {
                Reply::Json(200, configmap("same", json!({"k": "v"})))
            }
            ("GET", p) if p.starts_with(&format!("{cm}/")) => not_found(p),
            ("PATCH" | "PUT" | "POST", _) if !query.contains("dryRun=All") => {
                panic!("a dry run sent a real write: {} {}", req.method, req.path)
            }
            ("PATCH", p) if p == format!("{cm}/bad") => Reply::Json(
                422,
                status(
                    422,
                    "Invalid",
                    "ConfigMap \"bad\" is invalid: data[bad key]: Invalid value: \"bad key\"",
                ),
            ),
            ("PATCH", p) if p == format!("{cm}/same") => {
                let mut live = configmap("same", json!({"k": "v"}));
                live["metadata"]["managedFields"] = json!([{"manager": "kubepit"}]);
                Reply::Json(200, live)
            }
            ("PATCH" | "PUT", p) if p.starts_with(&format!("{cm}/")) => {
                let mut obj = body.clone();
                obj["metadata"]["uid"] = json!("uid-existing");
                obj["metadata"]["resourceVersion"] = json!("7");
                Reply::Json(200, obj)
            }
            ("POST", p) if p == cm => {
                let mut obj = body.clone();
                obj["metadata"]["uid"] = json!("uid-new");
                Reply::Json(201, obj)
            }
            _ => not_found(path),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dry_run_reviews_each_document_without_writing() {
    let server = start(dry_run_router()).await;
    // Read-only on purpose: a dry run is allowed there, applying is not.
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    let yaml = r#"
apiVersion: v1
kind: ConfigMap
metadata: {name: existing}
data: {k: changed}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: fresh}
data: {k: v}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: same, namespace: default}
data: {k: v}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: bad}
data: {"bad key": v}
---
apiVersion: example.com/v1
kind: Widget
metadata: {name: w}
"#;
    let results = app
        .resource_dry_run_yaml(&id, yaml, ApplyMode::Apply, Some("default"))
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
            ("fresh", DryRunOperation::Create, false),
            ("same", DryRunOperation::Unchanged, false),
            ("bad", DryRunOperation::Create, true),
            ("w", DryRunOperation::Create, true),
        ]
    );
    let existing = &results[0];
    assert_eq!(existing.kind, "ConfigMap");
    assert_eq!(existing.api_version, "v1");
    assert_eq!(existing.namespace.as_deref(), Some("default"));
    let live = existing.live.as_ref().expect("live object");
    assert_eq!(live["data"]["k"], "v");
    assert!(live["metadata"].get("managedFields").is_none());
    assert_eq!(existing.result.as_ref().unwrap()["data"]["k"], "changed");
    assert!(results[1].live.is_none());
    assert!(results[3]
        .error
        .as_deref()
        .unwrap()
        .contains("Invalid value"));
    assert!(results[3].result.is_none());
    assert!(results[4].error.as_deref().unwrap().contains("not served"));

    // Every write carried dryRun=All, as the same server-side apply request.
    let writes: Vec<String> = server
        .log
        .lock()
        .iter()
        .filter(|r| r.method != "GET")
        .map(|r| r.path.clone())
        .collect();
    assert_eq!(writes.len(), 4, "{writes:?}");
    for path in &writes {
        assert!(path.contains("dryRun=All"), "{path}");
        assert!(path.contains("fieldManager=kubepit"), "{path}");
        assert!(path.contains("force=true"), "{path}");
    }

    // Create and replace modes dry-run their own verbs.
    let created = app
        .resource_dry_run_yaml(
            &id,
            "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: fresh}\n",
            ApplyMode::Create,
            None,
        )
        .await
        .unwrap();
    assert_eq!(created[0].operation, DryRunOperation::Create);
    assert_eq!(created[0].error, None);
    let replaced = app
        .resource_dry_run_yaml(
            &id,
            "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: existing, resourceVersion: \"7\"}\ndata: {k: w}\n",
            ApplyMode::Replace,
            None,
        )
        .await
        .unwrap();
    assert_eq!(replaced[0].operation, DryRunOperation::Update);
    let verbs: Vec<String> = server
        .log
        .lock()
        .iter()
        .filter(|r| r.method == "POST" || r.method == "PUT")
        .map(|r| format!("{} {}", r.method, r.path))
        .collect();
    assert_eq!(verbs.len(), 2, "{verbs:?}");
    assert!(verbs.iter().all(|v| v.contains("dryRun=All")), "{verbs:?}");

    // Applying is still refused on the read-only cluster.
    let err = app
        .resource_apply_yaml(&id, yaml, ApplyMode::Apply, None)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is read-only"));
}

#[tokio::test]
async fn read_only_clusters_block_rollback_and_set_image() {
    let server = start(workload_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    let deployments = apps("Deployment", "deployments");
    let err = app
        .rollout_undo(&id, &deployments, "shop", "web", 0)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is read-only"), "{err:#}");
    let err = app
        .resource_set_image(
            &id,
            &deployments,
            Some("shop"),
            "web",
            vec![ContainerImage {
                container: "web".into(),
                image: "nginx:1.28".into(),
                init: false,
            }],
        )
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("is read-only"), "{err:#}");
    assert!(
        server.log.lock().is_empty(),
        "no request may reach the API server"
    );
    // Reading history is fine.
    assert_eq!(
        app.rollout_history(&id, &deployments, "shop", "web")
            .await
            .unwrap()
            .len(),
        3
    );
}
