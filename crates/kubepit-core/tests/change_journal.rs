//! End-to-end test of the change journal against the fake API server in
//! `support/`: watch-driven recording, noise filtering, Secret redaction,
//! namespace fallback for forbidden kinds and the settings lifecycle. No
//! real cluster is involved.

mod support;

use std::sync::Arc;
use std::time::Duration;

use kubepit_core::change_journal::{ChangeFilter, ChangeKindState, ChangeOp, ChangePage};
use kubepit_core::types::{ConnState, Settings};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const PASSWORD_OLD: &str = "hunter2";
const PASSWORD_OLD_B64: &str = "aHVudGVyMg==";
const PASSWORD_NEW: &str = "correct-horse";
const PASSWORD_NEW_B64: &str = "Y29ycmVjdC1ob3JzZQ==";

fn managed(manager: &str, time: &str) -> Value {
    json!([{"manager": manager, "operation": "Update", "apiVersion": "apps/v1",
            "time": time, "fieldsType": "FieldsV1", "fieldsV1": {}}])
}

fn deployment(name: &str, rv: &str, image: &str, manager: &str, ready: u32) -> Value {
    json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": name, "namespace": "shop", "uid": format!("uid-{name}"),
                     "resourceVersion": rv, "generation": 2,
                     "managedFields": managed(manager, "2024-05-01T10:00:00Z"),
                     "annotations": {"deployment.kubernetes.io/revision": rv}},
        "spec": {"replicas": 2, "template": {"spec": {"containers": [
            {"name": "api", "image": image}]}}},
        "status": {"readyReplicas": ready}
    })
}

fn secret(password_b64: &str, rv: &str) -> Value {
    json!({
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": {"name": "db", "namespace": "shop", "uid": "uid-db", "resourceVersion": rv,
                     "managedFields": managed("external-secrets", "2024-05-01T11:00:00Z"),
                     "annotations": {"kubectl.kubernetes.io/last-applied-configuration":
                        format!("{{\"data\":{{\"PASSWORD\":\"{password_b64}\"}}}}")}},
        "data": {"PASSWORD": password_b64, "USER": "YWRtaW4="}
    })
}

fn node(heartbeat: &str, rv: &str) -> Value {
    json!({
        "apiVersion": "v1", "kind": "Node",
        "metadata": {"name": "n1", "uid": "uid-n1", "resourceVersion": rv,
                     "labels": {"zone": "a"}},
        "spec": {"podCIDR": "10.0.0.0/24"},
        "status": {"conditions": [{"type": "Ready", "status": "True",
                                   "lastHeartbeatTime": heartbeat}]}
    })
}

fn list(kind: &str, items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": format!("{kind}List"), "apiVersion": "v1",
               "metadata": {"resourceVersion": "100"}, "items": items}),
    )
}

fn forbidden(what: &str) -> Reply {
    Reply::Json(
        403,
        status(
            403,
            "Forbidden",
            &format!("{what} is forbidden: User \"dev\" cannot list resource"),
        ),
    )
}

fn earlier_watches(log: &Log, path: &str) -> usize {
    log.lock()
        .iter()
        .filter(|r| r.path.starts_with(path) && r.path.contains("watch=true"))
        .count()
}

/// A cluster where Deployments, Secrets, Nodes and (namespaced) ConfigMaps
/// can be watched; ConfigMaps and Namespaces are forbidden cluster-wide and
/// every other journaled kind is not served.
fn router() -> Router {
    Arc::new(|req: &Request, log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        let watch = query.contains("watch=true");
        match (req.method.as_str(), path) {
            ("GET", "/version") => Reply::Json(
                200,
                json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
                       "gitCommit": "abc", "gitTreeState": "clean",
                       "buildDate": "2024-01-01T00:00:00Z", "goVersion": "go1.22",
                       "compiler": "gc", "platform": "linux/amd64"}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/apis/apps/v1/deployments") if watch => {
                if earlier_watches(log, path) > 0 {
                    return Reply::Stream(vec![]);
                }
                Reply::Stream(vec![
                    // Status, resourceVersion and revision annotation only: noise.
                    json!({"type": "MODIFIED",
                           "object": deployment("web", "101", "api:1.0", "argocd-controller", 2)}),
                    // A real change by `kubectl set image`.
                    json!({"type": "MODIFIED",
                           "object": deployment("web", "102", "api:1.1", "kubectl-set", 1)}),
                    json!({"type": "ADDED",
                           "object": deployment("cache", "103", "redis:7", "helm", 0)}),
                ])
            }
            ("GET", "/apis/apps/v1/deployments") => list(
                "Deployment",
                vec![deployment("web", "90", "api:1.0", "argocd-controller", 1)],
            ),
            ("GET", "/api/v1/secrets") if watch => {
                if earlier_watches(log, path) > 0 {
                    return Reply::Stream(vec![]);
                }
                Reply::Stream(vec![
                    json!({"type": "MODIFIED", "object": secret(PASSWORD_NEW_B64, "104")}),
                    json!({"type": "ADDED", "object": {
                        "apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1",
                        "metadata": {"name": "sh.helm.release.v1.cache.v1", "namespace": "shop",
                                     "uid": "uid-helm", "resourceVersion": "105"},
                        "data": {"release": "H4sIAAAA"}}}),
                ])
            }
            ("GET", "/api/v1/secrets") => list("Secret", vec![secret(PASSWORD_OLD_B64, "91")]),
            ("GET", "/api/v1/nodes") if watch => {
                if earlier_watches(log, path) > 0 {
                    return Reply::Stream(vec![]);
                }
                Reply::Stream(vec![json!({"type": "MODIFIED",
                                          "object": node("2024-05-01T10:00:40Z", "106")})])
            }
            ("GET", "/api/v1/nodes") => list("Node", vec![node("2024-05-01T10:00:00Z", "92")]),
            ("GET", "/api/v1/configmaps") => forbidden("configmaps"),
            ("GET", "/api/v1/namespaces/team-a/configmaps") if watch => {
                if earlier_watches(log, path) > 0 {
                    return Reply::Stream(vec![]);
                }
                Reply::Stream(vec![json!({"type": "DELETED", "object": {
                    "apiVersion": "v1", "kind": "ConfigMap",
                    "metadata": {"name": "cfg", "namespace": "team-a", "uid": "uid-cfg",
                                 "resourceVersion": "107"},
                    "data": {"LOG_LEVEL": "debug"}}})])
            }
            ("GET", "/api/v1/namespaces/team-a/configmaps") => list(
                "ConfigMap",
                vec![json!({"apiVersion": "v1", "kind": "ConfigMap",
                            "metadata": {"name": "cfg", "namespace": "team-a", "uid": "uid-cfg",
                                         "resourceVersion": "93"},
                            "data": {"LOG_LEVEL": "info"}})],
            ),
            ("GET", "/api/v1/namespaces/team-b/configmaps") => forbidden("configmaps"),
            ("GET", "/api/v1/namespaces") => forbidden("namespaces"),
            _ => Reply::Json(404, status(404, "NotFound", "the server could not find it")),
        }
    })
}

fn page(app: &kubepit_core::Kubepit, id: &str) -> ChangePage {
    app.changes_list(id, &ChangeFilter::default()).unwrap()
}

async fn wait_for(
    app: &kubepit_core::Kubepit,
    id: &str,
    done: impl Fn(&ChangePage) -> bool,
) -> ChangePage {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let current = page(app, id);
        if done(&current) || tokio::time::Instant::now() > deadline {
            return current;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn kind_state(page: &ChangePage, kind: &str) -> ChangeKindState {
    page.status
        .kinds
        .iter()
        .find(|k| k.kind == kind)
        .unwrap_or_else(|| panic!("{kind} missing from {:?}", page.status.kinds))
        .state
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journal_records_watched_changes_without_noise_or_secret_values() {
    let server = start(router()).await;
    // Read-only: the journal only reads, so it records all the same.
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    assert!(!page(&app, &id).status.enabled, "the harness keeps it off");
    app.set_change_journal_recording(true);
    app.set_settings(Settings {
        change_journal: true,
        ..app.settings()
    })
    .unwrap();
    let before = page(&app, &id);
    assert!(before.status.enabled && !before.status.recording);

    let status = app.cluster_connect(&id).await.unwrap();
    assert_eq!(status.state, ConnState::Connected, "{status:?}");

    let result = wait_for(&app, &id, |p| p.entries.len() >= 4 && p.status.synced).await;
    let summary: Vec<(ChangeOp, &str, &str)> = result
        .entries
        .iter()
        .map(|e| (e.op, e.gvk.kind.as_str(), e.name.as_str()))
        .collect();
    let mut sorted = summary.clone();
    sorted.sort_by(|a, b| (a.1, a.2).cmp(&(b.1, b.2)));
    assert_eq!(
        sorted,
        vec![
            (ChangeOp::Deleted, "ConfigMap", "cfg"),
            (ChangeOp::Added, "Deployment", "cache"),
            (ChangeOp::Modified, "Deployment", "web"),
            (ChangeOp::Modified, "Secret", "db"),
        ],
        "status-only updates, node heartbeats and Helm release secrets are not journaled"
    );
    assert!(result.status.recording && result.status.synced);
    assert!(result.entries.windows(2).all(|w| w[0].id > w[1].id));

    // The image bump: one path, attributed to kubectl set image.
    let web = result.entries.iter().find(|e| e.name == "web").unwrap();
    assert_eq!(web.paths.len(), 1, "{:?}", web.paths);
    assert_eq!(
        web.paths[0].path,
        "spec.template.spec.containers[api].image"
    );
    assert_eq!(web.paths[0].before.as_deref(), Some("api:1.0"));
    assert_eq!(web.paths[0].after.as_deref(), Some("api:1.1"));
    assert_eq!(web.actor.as_ref().unwrap().manager, "kubectl-set");
    assert_eq!(web.namespace.as_deref(), Some("shop"));
    let detail = app.changes_get(&id, web.id).unwrap();
    let (old, new) = (detail.before_yaml.unwrap(), detail.after_yaml.unwrap());
    assert!(old.contains("image: api:1.0") && new.contains("image: api:1.1"));
    for noise in [
        "managedFields",
        "resourceVersion",
        "readyReplicas",
        "revision",
        "uid",
    ] {
        assert!(!new.contains(noise), "{noise} in normalized YAML:\n{new}");
    }

    // The rotated password: visible as a change, never as a value.
    let db = result.entries.iter().find(|e| e.name == "db").unwrap();
    assert_eq!(db.paths.len(), 1, "{:?}", db.paths);
    assert_eq!(db.paths[0].path, "data.PASSWORD");
    assert!(db.paths[0].redacted);
    assert_eq!(db.actor.as_ref().unwrap().manager, "external-secrets");
    let db_detail = app.changes_get(&id, db.id).unwrap();
    let everything = format!(
        "{}{}",
        serde_json::to_string(&result).unwrap(),
        serde_json::to_string(&db_detail).unwrap()
    );
    for value in [
        PASSWORD_OLD,
        PASSWORD_OLD_B64,
        PASSWORD_NEW,
        PASSWORD_NEW_B64,
        "YWRtaW4=",
    ] {
        assert!(!everything.contains(value), "{value} reached the journal");
    }
    let after = db_detail.after_yaml.unwrap();
    assert!(
        after
            .lines()
            .any(|l| l.contains("USER:") && l.contains("<redacted #")),
        "{after}"
    );

    // Deleted ConfigMap came from the namespace fallback (team-a); team-b is
    // forbidden too, which must not stop the kind.
    let cfg = result.entries.iter().find(|e| e.name == "cfg").unwrap();
    assert!(app
        .changes_get(&id, cfg.id)
        .unwrap()
        .before_yaml
        .unwrap()
        .contains("LOG_LEVEL: info"));
    assert_eq!(kind_state(&result, "ConfigMap"), ChangeKindState::Watching);
    assert_eq!(kind_state(&result, "Deployment"), ChangeKindState::Watching);
    assert_eq!(kind_state(&result, "Namespace"), ChangeKindState::Forbidden);
    assert_eq!(kind_state(&result, "Role"), ChangeKindState::NotServed);

    // Filters reach the journal.
    let secrets = app
        .changes_list(
            &id,
            &ChangeFilter {
                kinds: vec!["Secret".into()],
                ..ChangeFilter::default()
            },
        )
        .unwrap();
    assert_eq!(secrets.entries.len(), 1);
    let in_team_a = app
        .changes_list(
            &id,
            &ChangeFilter {
                namespaces: vec!["team-a".into()],
                ..ChangeFilter::default()
            },
        )
        .unwrap();
    assert_eq!(in_team_a.entries.len(), 1);

    // Forbidden / unserved kinds are not retried; the journal never writes.
    let requests = server.log.lock().clone();
    let namespace_lists = requests
        .iter()
        .filter(|r| r.path.starts_with("/api/v1/namespaces?"))
        .count();
    assert_eq!(namespace_lists, 1, "forbidden kinds are not retried");
    assert!(requests.iter().all(|r| r.method == "GET"));

    // Per-cluster opt-out drops the journal; opting back in starts afresh.
    app.set_settings(Settings {
        change_journal_disabled: vec![id.clone()],
        ..app.settings()
    })
    .unwrap();
    let off = page(&app, &id);
    assert!(!off.status.enabled && !off.status.recording && off.entries.is_empty());
    assert!(app.changes_get(&id, web.id).is_err());
    app.set_settings(Settings {
        change_journal_disabled: Vec::new(),
        ..app.settings()
    })
    .unwrap();
    let on = wait_for(&app, &id, |p| p.status.synced).await;
    assert!(on.status.recording && on.status.synced);
    assert!(
        on.entries.is_empty(),
        "a new journal starts from a baseline"
    );

    // Disconnecting stops recording.
    app.cluster_disconnect(&id);
    let gone = page(&app, &id);
    assert!(gone.status.enabled && !gone.status.recording);
    assert!(app.changes_list("nope", &ChangeFilter::default()).is_err());
}
