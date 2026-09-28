//! End-to-end tests of the persistent history against the fake API server
//! in `support/`: the audit log around every mutating command family,
//! read-only and dry-run rules, Secret redaction in what reaches the
//! database file, identity, persisted events and change-journal entries,
//! and that nothing records unless the process enables it. No real cluster
//! is involved; the database lives in the test's temp home.

mod support;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use kubepit_core::change_journal::ChangeFilter;
use kubepit_core::custom_actions::CustomActionTarget;
use kubepit_core::history::{
    AuditAction, AuditEntry, AuditFilter, AuditOutcome, HistoryEventFilter, HistoryKind,
    HistorySettings,
};
use kubepit_core::types::{
    ApplyMode, ContainerImage, DeleteOptions, Gvk, HelmInstallRequest, HelmUpgradeRequest,
    PatchType, PodDebugRequest, Settings, TerminalSpec,
};
use kubepit_core::Kubepit;
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const PASSWORD: &str = "hunter2";
const PASSWORD_B64: &str = "aHVudGVyMg==";
const NEW_PASSWORD: &str = "s3cr3t-rotated";
const NEW_PASSWORD_B64: &str = "czNjcjN0LXJvdGF0ZWQ=";
const TOKEN: &str = "tok-9f8e7d6c5b";
const HELM_SECRET: &str = "helm-admin-pw-42";

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0", "gitCommit": "abc",
               "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn resource(name: &str, kind: &str, namespaced: bool) -> Value {
    json!({"name": name, "singularName": "", "namespaced": namespaced, "kind": kind,
           "verbs": ["create", "delete", "get", "list", "patch", "update", "watch"]})
}

fn not_found(what: &str) -> Reply {
    Reply::Json(404, status(404, "NotFound", &format!("{what} not found")))
}

fn configmap(name: &str, data: Value) -> Value {
    json!({"apiVersion": "v1", "kind": "ConfigMap",
           "metadata": {"name": name, "namespace": "default", "uid": format!("uid-{name}"),
                        "resourceVersion": "10", "managedFields": [{"manager": "kubectl"}]},
           "data": data})
}

fn secret(data_b64: &str) -> Value {
    json!({"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
           "metadata": {"name": "db", "namespace": "default", "uid": "uid-db", "resourceVersion": "3",
                        "annotations": {"kubectl.kubernetes.io/last-applied-configuration":
                            format!("{{\"data\":{{\"PASSWORD\":\"{data_b64}\"}}}}")}},
           "data": {"PASSWORD": data_b64, "USER": "YWRtaW4="}})
}

fn deployment(image: &str) -> Value {
    json!({"apiVersion": "apps/v1", "kind": "Deployment",
           "metadata": {"name": "web", "namespace": "default", "uid": "uid-web", "resourceVersion": "40"},
           "spec": {"replicas": 2, "selector": {"matchLabels": {"app": "web"}},
                    "template": {"metadata": {"labels": {"app": "web"}},
                                 "spec": {"containers": [{"name": "web", "image": image}]}}},
           "status": {"readyReplicas": 2}})
}

fn event(uid: &str, reason: &str, last: &str) -> Value {
    json!({"apiVersion": "v1", "kind": "Event",
           "metadata": {"name": format!("web-0.{uid}"), "namespace": "default", "uid": uid,
                        "resourceVersion": "5"},
           "involvedObject": {"kind": "Pod", "name": "web-0", "namespace": "default", "uid": "uid-web-0"},
           "reason": reason, "message": format!("{reason} for web-0"), "type": "Warning",
           "count": 1, "lastTimestamp": last})
}

fn list(kind: &str, items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": format!("{kind}List"), "apiVersion": "v1",
               "metadata": {"resourceVersion": "100"}, "items": items}),
    )
}

fn earlier_watches(log: &Log, path: &str) -> usize {
    log.lock()
        .iter()
        .filter(|r| r.path.starts_with(path) && r.path.contains("watch=true"))
        .count()
}

/// Merge `patch.data` into `object.data` (enough of a merge patch here).
fn merged(mut object: Value, patch: &Value) -> Value {
    if let Some(data) = patch.get("data").and_then(Value::as_object) {
        for (k, v) in data {
            object["data"][k] = v.clone();
        }
    }
    object
}

fn router() -> Router {
    Arc::new(|req: &Request, log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        let watch = query.contains("watch=true");
        let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        let cm = "/api/v1/namespaces/default/configmaps";
        let sec = "/api/v1/namespaces/default/secrets";
        let echo = |mut obj: Value| {
            obj["metadata"]["uid"] = json!("uid-echo");
            obj["metadata"]["resourceVersion"] = json!("50");
            Reply::Json(200, obj)
        };
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/api/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    resource("configmaps", "ConfigMap", true),
                    resource("secrets", "Secret", true),
                    resource("pods", "Pod", true),
                    resource("nodes", "Node", false),
                    resource("events", "Event", true),
                    resource("namespaces", "Namespace", false),
                ]}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": [
                    {"name": "apps", "versions": [{"groupVersion": "apps/v1", "version": "v1"}],
                     "preferredVersion": {"groupVersion": "apps/v1", "version": "v1"}},
                    {"name": "batch", "versions": [{"groupVersion": "batch/v1", "version": "v1"}],
                     "preferredVersion": {"groupVersion": "batch/v1", "version": "v1"}}
                ]}),
            ),
            ("GET", "/apis/apps/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "apps/v1", "resources": [
                    resource("deployments", "Deployment", true),
                    resource("replicasets", "ReplicaSet", true),
                ]}),
            ),
            ("GET", "/apis/batch/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "batch/v1", "resources": [
                    resource("cronjobs", "CronJob", true),
                    resource("jobs", "Job", true),
                ]}),
            ),
            ("POST", "/apis/authentication.k8s.io/v1/selfsubjectreviews") => Reply::Json(
                201,
                json!({"apiVersion": "authentication.k8s.io/v1", "kind": "SelfSubjectReview",
                       "metadata": {}, "status": {"userInfo": {"username": "dev@acme.io",
                                                                "groups": ["system:authenticated"]}}}),
            ),
            // ConfigMaps
            ("GET", p) if p == format!("{cm}/app-config") => {
                Reply::Json(200, configmap("app-config", json!({"LOG_LEVEL": "info"})))
            }
            ("PATCH", p) if p == format!("{cm}/app-config") => Reply::Json(
                200,
                merged(configmap("app-config", json!({"LOG_LEVEL": "info"})), &body),
            ),
            ("DELETE", p) if p == format!("{cm}/app-config") => Reply::Json(
                200,
                json!({"kind": "Status", "apiVersion": "v1", "status": "Success"}),
            ),
            ("GET", p) if p == format!("{cm}/locked") => {
                Reply::Json(200, configmap("locked", json!({"a": "b"})))
            }
            ("PATCH", p) if p == format!("{cm}/locked") || p == format!("{cm}/bad-doc") => {
                Reply::Json(
                    422,
                    status(
                        422,
                        "Invalid",
                        "ConfigMap is invalid: admission webhook denied",
                    ),
                )
            }
            ("PATCH", p) if p.starts_with(cm) => echo(body),
            // Secrets
            ("GET", p) if p == format!("{sec}/db") => Reply::Json(200, secret(PASSWORD_B64)),
            ("PATCH", p) if p == format!("{sec}/db") => {
                Reply::Json(200, merged(secret(PASSWORD_B64), &body))
            }
            ("DELETE", p) if p == format!("{sec}/db") => Reply::Json(
                200,
                json!({"kind": "Status", "apiVersion": "v1", "status": "Success"}),
            ),
            // Server-side apply of new Secrets echoes what was sent (stringData included).
            ("PATCH", p) if p.starts_with(sec) => echo(body),
            // Workloads
            ("GET", "/apis/apps/v1/namespaces/default/deployments/web") => {
                Reply::Json(200, deployment("nginx:1.27"))
            }
            ("PATCH", "/apis/apps/v1/namespaces/default/deployments/web/scale") => Reply::Json(
                200,
                json!({"apiVersion": "autoscaling/v1", "kind": "Scale",
                       "metadata": {"name": "web", "namespace": "default"},
                       "spec": {"replicas": body.pointer("/spec/replicas")}}),
            ),
            ("PATCH", "/apis/apps/v1/namespaces/default/deployments/web") => {
                let image = body
                    .pointer("/spec/template/spec/containers/0/image")
                    .and_then(Value::as_str)
                    .unwrap_or("nginx:1.27");
                Reply::Json(200, deployment(image))
            }
            ("GET", "/apis/apps/v1/namespaces/default/replicasets") => list("ReplicaSet", vec![]),
            ("GET", "/apis/batch/v1/namespaces/default/cronjobs/backup") => Reply::Json(
                200,
                json!({"apiVersion": "batch/v1", "kind": "CronJob",
                       "metadata": {"name": "backup", "namespace": "default", "uid": "uid-backup"},
                       "spec": {"schedule": "0 * * * *", "jobTemplate": {"spec": {"template": {
                           "spec": {"containers": [{"name": "b", "image": "busybox"}],
                                    "restartPolicy": "OnFailure"}}}}}}),
            ),
            ("POST", "/apis/batch/v1/namespaces/default/jobs") => Reply::Json(201, body),
            // Nodes and pods
            ("PATCH", "/api/v1/nodes/n1") => Reply::Json(
                200,
                json!({"apiVersion": "v1", "kind": "Node", "metadata": {"name": "n1"},
                       "spec": {"unschedulable": body.pointer("/spec/unschedulable")}}),
            ),
            ("GET", "/api/v1/pods") => list("Pod", vec![]),
            ("GET", "/api/v1/namespaces/default/pods/web-0") => Reply::Json(
                200,
                json!({"apiVersion": "v1", "kind": "Pod",
                       "metadata": {"name": "web-0", "namespace": "default", "uid": "uid-web-0"},
                       "spec": {"containers": [{"name": "web", "image": "nginx"}]}}),
            ),
            ("POST", p) if p.ends_with("/pods") => Reply::Json(
                403,
                status(
                    403,
                    "Forbidden",
                    "pods is forbidden: User \"dev\" cannot create pods",
                ),
            ),
            // Persisted events
            ("GET", "/api/v1/events") if watch => {
                if earlier_watches(log, path) > 0 {
                    return Reply::Stream(vec![]);
                }
                Reply::Stream(vec![json!({"type": "ADDED",
                    "object": event("ev-3", "Killing", "2024-05-01T10:03:00Z")})])
            }
            ("GET", "/api/v1/events") => list(
                "Event",
                vec![
                    event("ev-1", "BackOff", "2024-05-01T10:01:00Z"),
                    event("ev-2", "Unhealthy", "2024-05-01T10:02:00Z"),
                ],
            ),
            // The change journal: only ConfigMaps are served for it.
            ("GET", "/api/v1/configmaps") if watch => {
                if earlier_watches(log, path) > 0 {
                    return Reply::Stream(vec![]);
                }
                Reply::Stream(vec![json!({"type": "MODIFIED",
                    "object": configmap("app-config", json!({"LOG_LEVEL": "trace"}))})])
            }
            ("GET", "/api/v1/configmaps") => list(
                "ConfigMap",
                vec![configmap("app-config", json!({"LOG_LEVEL": "info"}))],
            ),
            (_, p) => not_found(p),
        }
    })
}

fn configmaps() -> Gvk {
    Gvk {
        group: String::new(),
        version: "v1".into(),
        kind: "ConfigMap".into(),
        plural: "configmaps".into(),
        namespaced: true,
    }
}

fn secrets() -> Gvk {
    Gvk {
        kind: "Secret".into(),
        plural: "secrets".into(),
        ..configmaps()
    }
}

fn deployments() -> Gvk {
    Gvk {
        group: "apps".into(),
        version: "v1".into(),
        kind: "Deployment".into(),
        plural: "deployments".into(),
        namespaced: true,
    }
}

/// Recording on, tools pointing at paths that do not exist (helm fails
/// fast) or at a plain file (kubectl only has to exist for node shells).
fn enable(app: &Kubepit, dir: &std::path::Path, history: HistorySettings) {
    let kubectl = dir.join("kubectl");
    std::fs::write(&kubectl, "#!/bin/sh\n").unwrap();
    app.set_settings(Settings {
        helm_path: Some(dir.join("no-such-helm").to_string_lossy().to_string()),
        kubectl_path: Some(kubectl.to_string_lossy().to_string()),
        history,
        ..app.settings()
    })
    .unwrap();
    app.set_history_recording(true);
}

fn entries(app: &Kubepit) -> Vec<AuditEntry> {
    assert!(app.history_flush());
    let mut page = app
        .history_audit_list(&AuditFilter {
            limit: 1000,
            ..AuditFilter::default()
        })
        .unwrap()
        .entries;
    page.reverse(); // oldest first
    page
}

fn find(entries: &[AuditEntry], action: AuditAction) -> &AuditEntry {
    entries
        .iter()
        .find(|e| e.action == action)
        .unwrap_or_else(|| panic!("no {action:?} entry in {entries:#?}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_is_recorded_unless_the_process_enables_history() {
    let server = start(router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, false);
    app.set_settings(Settings {
        history: HistorySettings {
            persist_clusters: vec![id.clone()],
            ..HistorySettings::default()
        },
        ..app.settings()
    })
    .unwrap();
    app.cluster_connect(&id).await.unwrap();
    app.resource_patch(
        &id,
        &configmaps(),
        Some("default"),
        "app-config",
        json!({"data": {"LOG_LEVEL": "debug"}}),
        PatchType::Merge,
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let requests: Vec<String> = server
        .log
        .lock()
        .iter()
        .map(|r| format!("{} {}", r.method, r.path))
        .collect();
    assert!(
        !requests
            .iter()
            .any(|r| r.starts_with("GET /api/v1/namespaces/default/configmaps/app-config")),
        "no before-state GET: {requests:?}"
    );
    assert!(
        !requests.iter().any(|r| r.contains("/api/v1/events")),
        "no events watcher: {requests:?}"
    );
    assert!(
        !dir.path().join("home").join("history.db").exists(),
        "the database is not even created"
    );
    let status = app.history_status();
    assert!(!status.recording && status.available);
    assert_eq!(status.audit.rows, 0);
    assert!(status.persisting.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_mutating_command_family_is_recorded_on_success_and_error() {
    let server = start(router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, false);
    enable(&app, dir.path(), HistorySettings::default());
    app.access_whoami(&id).await.unwrap();

    // Resources
    app.resource_patch(
        &id,
        &configmaps(),
        Some("default"),
        "app-config",
        json!({"data": {"LOG_LEVEL": "debug"}}),
        PatchType::Merge,
    )
    .await
    .unwrap();
    app.resource_patch(
        &id,
        &configmaps(),
        Some("default"),
        "locked",
        json!({"data": {"a": "c"}}),
        PatchType::Merge,
    )
    .await
    .unwrap_err();
    app.resource_scale(&id, &deployments(), "default", "web", 5)
        .await
        .unwrap();
    app.resource_set_image(
        &id,
        &deployments(),
        Some("default"),
        "web",
        vec![ContainerImage {
            container: "web".into(),
            image: "nginx:1.28".into(),
            init: false,
        }],
    )
    .await
    .unwrap();
    app.resource_restart(&id, &deployments(), "default", "web")
        .await
        .unwrap();
    app.resource_apply_yaml(
        &id,
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: new-config\ndata:\n  a: b\n",
        ApplyMode::Apply,
        Some("default"),
    )
    .await
    .unwrap();
    app.resource_delete(
        &id,
        &configmaps(),
        Some("default"),
        "app-config",
        DeleteOptions::default(),
    )
    .await
    .unwrap();
    let job = app.cronjob_trigger(&id, "default", "backup").await.unwrap();
    // Nodes
    app.node_cordon(&id, "n1", true).await.unwrap();
    app.node_cordon(&id, "n1", false).await.unwrap();
    app.node_drain(&id, "n1", false).await.unwrap();
    // Rollouts: no revisions to go back to.
    app.rollout_undo(&id, &deployments(), "default", "web", 0)
        .await
        .unwrap_err();
    // Helm (helm is not installed here: every call fails and is recorded).
    app.helm_rollback(&id, "default", "shop", 2)
        .await
        .unwrap_err();
    app.helm_uninstall(&id, "default", "shop")
        .await
        .unwrap_err();
    app.helm_install(
        &id,
        &HelmInstallRequest {
            release_name: "shop".into(),
            namespace: "default".into(),
            chart_ref: "bitnami/nginx".into(),
            values_yaml: format!("auth:\n  password: {HELM_SECRET}\n"),
            ..HelmInstallRequest::default()
        },
    )
    .await
    .unwrap_err();
    app.helm_upgrade(
        &id,
        "default",
        "shop",
        &HelmUpgradeRequest {
            chart_ref: "bitnami/nginx".into(),
            ..HelmUpgradeRequest::default()
        },
    )
    .await
    .unwrap_err();
    // Manifests: one document applies, one is rejected.
    let results = app
        .manifests_apply(
            &id,
            &[
                "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: ok-doc}\ndata: {k: v}\n".into(),
                "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: bad-doc}\ndata: {k: v}\n".into(),
            ],
            Some("default"),
        )
        .await
        .unwrap();
    assert!(results[0].error.is_none() && results[1].error.is_some());
    // Logs & debug: ephemeral containers are not served; the file is missing.
    app.pod_debug(
        &id,
        "default",
        "web-0",
        PodDebugRequest {
            image: "busybox".into(),
            ..PodDebugRequest::default()
        },
    )
    .await
    .unwrap_err();
    app.pod_fs_upload(
        &id,
        "default",
        "web-0",
        Some("web"),
        &dir.path().join("missing.txt").to_string_lossy(),
        "/tmp",
    )
    .await
    .unwrap_err();
    // Node shell: the helper pod is refused in every candidate namespace.
    app.prepare_terminal(
        "t1",
        &TerminalSpec::NodeShell {
            cluster_id: id.clone(),
            node: "n1".into(),
        },
        &|_| true,
    )
    .await
    .unwrap_err();

    let all = entries(&app);
    let actions: Vec<AuditAction> = all.iter().map(|e| e.action).collect();
    use AuditAction::*;
    assert_eq!(
        actions,
        vec![
            Patch,
            Patch,
            Scale,
            SetImage,
            Restart,
            Apply,
            Delete,
            CronjobTrigger,
            Cordon,
            Uncordon,
            Drain,
            RolloutUndo,
            HelmRollback,
            HelmUninstall,
            HelmInstall,
            HelmUpgrade,
            ManifestsApply,
            PodDebug,
            FileUpload,
            NodeShell,
        ],
        "one entry per command; the drain's own cordon is not separate"
    );
    for entry in &all {
        assert_eq!(entry.cluster_id, id);
        assert_eq!(entry.cluster_name, "Fake");
        assert_eq!(entry.context, "fake");
        assert_eq!(entry.identity.as_deref(), Some("dev@acme.io"), "{entry:?}");
        assert!(!entry.dry_run);
        assert_eq!(entry.outcome == AuditOutcome::Error, entry.error.is_some());
    }
    let outcomes: BTreeSet<(String, bool)> = all
        .iter()
        .map(|e| (e.action.as_str().to_string(), e.outcome == AuditOutcome::Ok))
        .collect();
    for (action, ok) in [
        ("scale", true),
        ("set-image", true),
        ("restart", true),
        ("apply", true),
        ("delete", true),
        ("cronjob-trigger", true),
        ("cordon", true),
        ("uncordon", true),
        ("drain", true),
        ("rollout-undo", false),
        ("helm-rollback", false),
        ("helm-uninstall", false),
        ("helm-install", false),
        ("helm-upgrade", false),
        ("manifests-apply", false),
        ("pod-debug", false),
        ("file-upload", false),
        ("node-shell", false),
    ] {
        assert!(
            outcomes.contains(&(action.to_string(), ok)),
            "{action} ok={ok}"
        );
    }

    // The patch: target, request, before/after and a revertible diff.
    let patch = &all[0];
    assert_eq!(patch.outcome, AuditOutcome::Ok);
    assert_eq!(patch.targets[0].kind, "ConfigMap");
    assert_eq!(patch.targets[0].namespace.as_deref(), Some("default"));
    assert_eq!(patch.targets[0].name, "app-config");
    assert_eq!(patch.request.as_ref().unwrap()["patch_type"], "merge");
    assert!(patch.has_diff && patch.revertible);
    let detail = app.history_audit_get(patch.id).unwrap();
    let object = &detail.objects[0];
    assert!(object
        .before_yaml
        .as_deref()
        .unwrap()
        .contains("LOG_LEVEL: info"));
    assert!(object
        .after_yaml
        .as_deref()
        .unwrap()
        .contains("LOG_LEVEL: debug"));
    assert!(!object
        .after_yaml
        .as_deref()
        .unwrap()
        .contains("managedFields"));
    // The rejected patch keeps the server's message and cannot be reverted.
    let rejected = &all[1];
    assert!(rejected
        .error
        .as_deref()
        .unwrap()
        .contains("admission webhook denied"));
    assert!(!rejected.revertible);

    let scale = find(&all, Scale);
    assert_eq!(scale.request.as_ref().unwrap()["replicas"], 5);
    assert_eq!(scale.request.as_ref().unwrap()["previous"], 2);
    assert!(scale.revertible);
    let set_image = find(&all, SetImage);
    assert!(set_image.revertible);
    let image_diff = app.history_audit_get(set_image.id).unwrap();
    assert!(image_diff.objects[0]
        .after_yaml
        .as_deref()
        .unwrap()
        .contains("nginx:1.28"));
    // Apply resolved the kind through discovery; the object did not exist.
    let apply = find(&all, Apply);
    assert_eq!(apply.targets[0].gvk.as_ref().unwrap().plural, "configmaps");
    assert!(!apply.revertible, "a creation has no before-state");
    let delete = find(&all, Delete);
    assert!(delete.has_diff && !delete.revertible);
    let trigger = find(&all, CronjobTrigger);
    assert_eq!(
        trigger.result.as_deref(),
        Some(format!("Job default/{job}").as_str())
    );
    let manifests = find(&all, ManifestsApply);
    assert_eq!(manifests.error.as_deref(), Some("1 of 2 documents failed"));
    assert!(manifests.targets[0].error.is_none());
    assert!(manifests.targets[1]
        .error
        .as_deref()
        .unwrap()
        .contains("admission webhook denied"));
    let install = find(&all, HelmInstall);
    assert_eq!(install.targets[0].kind, "Release");
    assert_eq!(
        install.request.as_ref().unwrap()["chart_ref"],
        "bitnami/nginx"
    );
    assert!(
        !install
            .request
            .as_ref()
            .unwrap()
            .to_string()
            .contains(HELM_SECRET),
        "Helm values keep their keys only"
    );
    assert!(install.request.as_ref().unwrap()["values"]["auth"]
        .get("password")
        .is_some());

    // Filters, paging and export.
    let errors = app
        .history_audit_list(&AuditFilter {
            outcome: Some(AuditOutcome::Error),
            ..AuditFilter::default()
        })
        .unwrap();
    assert_eq!(errors.total, 10);
    let page = app
        .history_audit_list(&AuditFilter {
            limit: 7,
            ..AuditFilter::default()
        })
        .unwrap();
    assert_eq!(page.entries.len(), 7);
    assert_eq!(page.total, 20);
    let rest = app
        .history_audit_list(&AuditFilter {
            limit: 100,
            cursor: page.next_cursor.clone(),
            ..AuditFilter::default()
        })
        .unwrap();
    assert_eq!(rest.entries.len(), 13);
    let text = app
        .history_audit_list(&AuditFilter {
            text: Some("new-config".into()),
            ..AuditFilter::default()
        })
        .unwrap();
    assert_eq!(text.total, 1);
    let jsonl = app
        .history_audit_export(&AuditFilter {
            actions: vec![Cordon, Uncordon],
            ..AuditFilter::default()
        })
        .unwrap();
    assert_eq!(jsonl.lines().count(), 2);

    // Clearing the audit log.
    let status = app.history_clear(HistoryKind::Audit, None).unwrap();
    assert_eq!(status.audit.rows, 0);
    assert!(status.recording && status.available);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_rejections_are_not_recorded_but_dry_runs_are() {
    let server = start(router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, true);
    enable(&app, dir.path(), HistorySettings::default());
    let err = app
        .resource_patch(
            &id,
            &configmaps(),
            Some("default"),
            "app-config",
            json!({"data": {"LOG_LEVEL": "debug"}}),
            PatchType::Merge,
        )
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("read-only"));
    assert!(
        server.log.lock().is_empty(),
        "refused before any request, the audit GET included"
    );
    app.node_drain(&id, "n1", true).await.unwrap_err();
    // A mutating custom action is refused before anything is recorded.
    let import = app
        .custom_actions_import(
            None,
            Some(
                &json!([{ "id": "mut", "name": "Delete", "mode": "background",
                          "mutating": true, "command": "printf deleted {name}" }])
                .to_string(),
            ),
        )
        .unwrap();
    app.custom_actions_save(import.actions).unwrap();
    let err = app
        .custom_action_run(&id, "mut", &pod_target("web-0"))
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("read-only"), "{err:#}");
    // Dry runs are allowed on read-only clusters and recorded as such.
    app.helm_install(
        &id,
        &HelmInstallRequest {
            release_name: "shop".into(),
            namespace: "default".into(),
            chart_ref: "bitnami/nginx".into(),
            dry_run: true,
            ..HelmInstallRequest::default()
        },
    )
    .await
    .unwrap_err();
    let all = entries(&app);
    assert_eq!(all.len(), 1, "{all:#?}");
    assert_eq!(all[0].action, AuditAction::HelmInstall);
    assert!(all[0].dry_run);

    // The audit log can be turned off.
    app.set_settings(Settings {
        history: HistorySettings {
            audit: false,
            ..app.settings().history
        },
        ..app.settings()
    })
    .unwrap();
    app.helm_install(
        &id,
        &HelmInstallRequest {
            release_name: "shop".into(),
            namespace: "default".into(),
            chart_ref: "bitnami/nginx".into(),
            dry_run: true,
            ..HelmInstallRequest::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(entries(&app).len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_values_never_reach_the_database_file() {
    let server = start(router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, false);
    enable(&app, dir.path(), HistorySettings::default());

    app.resource_patch(
        &id,
        &secrets(),
        Some("default"),
        "db",
        json!({"data": {"PASSWORD": NEW_PASSWORD_B64}, "stringData": {"PLAIN": NEW_PASSWORD}}),
        PatchType::Merge,
    )
    .await
    .unwrap();
    app.resource_patch(
        &id,
        &secrets(),
        Some("default"),
        "db",
        json!([{"op": "replace", "path": "/data/PASSWORD", "value": NEW_PASSWORD_B64}]),
        PatchType::Json,
    )
    .await
    .unwrap();
    app.resource_apply_yaml(
        &id,
        &format!(
            "apiVersion: v1\nkind: Secret\nmetadata:\n  name: api-token\nstringData:\n  TOKEN: {TOKEN}\n"
        ),
        ApplyMode::Apply,
        Some("default"),
    )
    .await
    .unwrap();
    app.manifests_apply(
        &id,
        &[format!(
            "apiVersion: v1\nkind: Secret\nmetadata: {{name: from-manifest}}\ndata: {{PASSWORD: {PASSWORD_B64}}}\n"
        )],
        Some("default"),
    )
    .await
    .unwrap();
    app.resource_delete(
        &id,
        &secrets(),
        Some("default"),
        "db",
        DeleteOptions::default(),
    )
    .await
    .unwrap();
    app.helm_upgrade_values(
        &id,
        "default",
        "shop",
        &format!("password: {HELM_SECRET}\n"),
    )
    .await
    .unwrap_err();

    let all = entries(&app);
    assert_eq!(all.len(), 6);
    // Keys stay visible: the patch changed PASSWORD, without its value.
    let detail = app.history_audit_get(all[0].id).unwrap();
    let after = detail.objects[0].after_yaml.clone().unwrap();
    assert!(after.contains("PASSWORD: '<redacted #"), "{after}");
    assert!(!all[0].revertible, "redacted Secrets cannot be re-applied");
    assert_eq!(
        all[1].request.as_ref().unwrap()["patch"][0]["path"],
        "/data/PASSWORD"
    );

    let mut stored = String::new();
    for entry in &all {
        stored.push_str(&serde_json::to_string(entry).unwrap());
        let detail = app.history_audit_get(entry.id).unwrap();
        stored.push_str(&serde_json::to_string(&detail).unwrap());
    }
    stored.push_str(&app.history_audit_export(&AuditFilter::default()).unwrap());
    // What is on disk: database, write-ahead log and shared memory.
    let home = dir.path().join("home");
    for name in ["history.db", "history.db-wal", "history.db-shm"] {
        if let Ok(bytes) = std::fs::read(home.join(name)) {
            stored.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    for secret in [
        PASSWORD,
        PASSWORD_B64,
        NEW_PASSWORD,
        NEW_PASSWORD_B64,
        TOKEN,
        HELM_SECRET,
    ] {
        assert!(!stored.contains(secret), "{secret} reached the history");
    }
}

/// A custom action target: pod `name` in `default`.
fn pod_target(name: &str) -> CustomActionTarget {
    CustomActionTarget {
        namespace: Some("default".into()),
        name: Some(name.into()),
        kind: Some("Pod".into()),
        group: Some(String::new()),
        version: Some("v1".into()),
        resource: Some("pods".into()),
        ..CustomActionTarget::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutating_custom_actions_are_audited_without_output() {
    if !cfg!(unix) {
        return;
    }
    let server = start(router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, false);
    enable(&app, dir.path(), HistorySettings::default());
    let import = app
        .custom_actions_import(
            None,
            Some(
                &json!([
                    { "id": "mut", "name": "Echo", "mode": "background", "mutating": true,
                      "command": "printf '%s %s' {annotations.kubectl.kubernetes.io/last-applied-configuration} {name}" },
                    { "id": "read", "name": "Read", "mode": "background", "command": "printf ok" },
                    { "id": "fail", "name": "Fail", "mode": "background", "mutating": true,
                      "command": "printf %s {annotations.kubectl.kubernetes.io/last-applied-configuration}; exit 3" },
                    { "id": "sig", "name": "Killed", "mode": "background", "mutating": true,
                      "command": "kill -KILL $$" },
                    { "id": "term", "name": "Shell", "mode": "terminal", "mutating": true,
                      "command": "echo {annotations.kubectl.kubernetes.io/last-applied-configuration} {labels.app}" }
                ])
                .to_string(),
            ),
        )
        .unwrap();
    app.custom_actions_save(import.actions).unwrap();
    let mut target = pod_target("web-0");
    target.kind = Some("Secret".into());
    target.annotations.insert(
        "kubectl.kubernetes.io/last-applied-configuration".into(),
        format!(r#"{{"data":{{"password":"{PASSWORD}"}}}}"#),
    );
    let out = app.custom_action_run(&id, "mut", &target).await.unwrap();
    assert!(out.stdout.contains(PASSWORD));
    app.custom_action_run(&id, "read", &target).await.unwrap();

    let all = entries(&app);
    let entry = find(&all, AuditAction::CustomAction);
    let text = serde_json::to_string(entry).unwrap();
    assert!(!text.contains(PASSWORD), "{text}");
    assert!(text.contains("web-0"));
    assert_eq!(
        all.iter()
            .filter(|e| e.action == AuditAction::CustomAction)
            .count(),
        1,
        "non-mutating runs are not audited"
    );
    let request = entry.request.as_ref().unwrap();
    assert_eq!(request["action"], "Echo");
    assert_eq!(request["id"], "mut");
    assert_eq!(request["mode"], "background");
    assert_eq!(request["targets"], 1);
    let command = request["command"].as_str().unwrap();
    assert!(command.contains("<redacted #"), "{command}");
    assert!(command.ends_with(" web-0"), "{command}");
    assert_eq!(entry.result.as_deref(), Some("exit 0"));
    assert_eq!(entry.outcome, AuditOutcome::Ok);
    assert_eq!(
        (
            entry.targets[0].kind.as_str(),
            entry.targets[0].api_version.as_str()
        ),
        ("Secret", "v1")
    );
    assert_eq!(entry.targets[0].namespace.as_deref(), Some("default"));
    assert!(!entry.revertible && !entry.has_diff);

    // A non-zero exit fails the entry; its output is not kept either.
    let failed = app.custom_action_run(&id, "fail", &target).await.unwrap();
    assert_eq!(failed.exit_code, Some(3));
    // So does a run killed by a signal (no exit code, no timeout).
    let killed = app.custom_action_run(&id, "sig", &target).await.unwrap();
    assert_eq!((killed.exit_code, killed.timed_out), (None, false));
    // Terminal launches are recorded when the terminal starts.
    target.labels.insert("app".into(), "web".into());
    app.prepare_terminal(
        "t1",
        &TerminalSpec::CustomAction {
            cluster_id: id.clone(),
            action_id: "term".into(),
            target: target.clone(),
        },
        &|_| true,
    )
    .await
    .unwrap();
    let all = entries(&app);
    let runs: Vec<&AuditEntry> = all
        .iter()
        .filter(|e| e.action == AuditAction::CustomAction)
        .collect();
    assert_eq!(runs.len(), 4, "{runs:#?}");
    assert_eq!(runs[1].outcome, AuditOutcome::Error);
    assert_eq!(runs[1].result.as_deref(), Some("exit 3"));
    assert_eq!(runs[2].outcome, AuditOutcome::Error);
    assert_eq!(runs[2].error.as_deref(), Some("terminated by a signal"));
    assert_eq!(runs[2].result, None);
    let terminal = runs[3];
    let request = terminal.request.as_ref().unwrap();
    assert_eq!(request["mode"], "terminal");
    // Labels of Secret-like targets are redacted too.
    let command = request["command"].as_str().unwrap();
    assert!(!command.contains("web"), "{command}");
    // A keyword the Activity view translates.
    assert_eq!(terminal.result.as_deref(), Some("terminal-started"));

    let mut stored = serde_json::to_string(&all).unwrap();
    stored.push_str(&app.history_audit_export(&AuditFilter::default()).unwrap());
    assert!(app.history_flush());
    let home = dir.path().join("home");
    for name in ["history.db", "history.db-wal", "history.db-shm"] {
        if let Ok(bytes) = std::fs::read(home.join(name)) {
            stored.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    assert!(
        !stored.contains(PASSWORD),
        "the annotation value reached the history"
    );
}

async fn wait_until(mut done: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    done()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opted_in_clusters_persist_events_and_journal_entries() {
    let server = start(router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, false);
    // Recording on, but the cluster has not opted in yet: no watcher.
    enable(&app, dir.path(), HistorySettings::default());
    app.cluster_connect(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!server
        .log
        .lock()
        .iter()
        .any(|r| r.path.starts_with("/api/v1/events")));
    assert!(app.history_status().persisting.is_empty());

    // Opting in while connected starts persisting right away; the change
    // journal records too.
    app.set_change_journal_recording(true);
    app.set_settings(Settings {
        change_journal: true,
        history: HistorySettings {
            persist_clusters: vec![id.clone()],
            ..app.settings().history
        },
        ..app.settings()
    })
    .unwrap();
    assert_eq!(app.history_status().persisting, vec![id.clone()]);

    let events = |app: &Kubepit| {
        app.history_flush();
        app.history_events_list(&id, &HistoryEventFilter::default())
            .unwrap()
            .events
    };
    assert!(
        wait_until(|| events(&app).len() == 3).await,
        "{:?}",
        events(&app)
    );
    let reasons: Vec<String> = events(&app)
        .iter()
        .map(|e| e["reason"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        reasons,
        vec!["Killing", "Unhealthy", "BackOff"],
        "newest first"
    );
    let for_pod = app
        .history_events_list(
            &id,
            &HistoryEventFilter {
                involved_uid: Some("uid-web-0".into()),
                types: vec!["Warning".into()],
                limit: 2,
                ..HistoryEventFilter::default()
            },
        )
        .unwrap();
    assert_eq!(for_pod.events.len(), 2);
    assert!(for_pod.next_cursor.is_some());

    let changes = |app: &Kubepit| {
        app.history_flush();
        app.history_changes_list(&id, &ChangeFilter::default())
            .unwrap()
            .entries
    };
    assert!(
        wait_until(|| !changes(&app).is_empty()).await,
        "journal entry copied"
    );
    let entry = changes(&app).remove(0);
    assert_eq!(entry.gvk.kind, "ConfigMap");
    assert_eq!(entry.name, "app-config");
    let detail = app.history_changes_get(&id, entry.id).unwrap();
    assert!(detail.before_yaml.unwrap().contains("LOG_LEVEL: info"));
    assert!(detail.after_yaml.unwrap().contains("LOG_LEVEL: trace"));
    let status = app.history_status();
    assert_eq!(status.events.rows, 3);
    assert_eq!(status.changes.rows, 1);

    // Disconnecting stops persisting; the data stays.
    app.cluster_disconnect(&id);
    assert!(app.history_status().persisting.is_empty());
    assert_eq!(events(&app).len(), 3);
    let status = app.history_clear(HistoryKind::Events, Some(&id)).unwrap();
    assert_eq!(status.events.rows, 0);
    assert_eq!(status.changes.rows, 1);
}
