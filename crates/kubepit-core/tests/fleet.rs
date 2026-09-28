//! End-to-end tests of the fleet features (metrics history, fleet search)
//! against the fake API server in `support/`. No real cluster is involved.

mod support;

use std::sync::Arc;
use std::time::Duration;

use kubepit_core::types::{
    ClusterInput, ConnState, FleetSearchEvent, FleetSearchEventKind, FleetSearchQuery, Gvk,
    MetricsHistoryQuery,
};
use serde_json::{json, Value};
use support::{kubeconfig_for, setup, start, status, Log, Reply, Request, Router};

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn resource(name: &str, kind: &str, namespaced: bool) -> Value {
    json!({"name": name, "singularName": "", "namespaced": namespaced, "kind": kind,
           "verbs": ["get", "list", "watch"]})
}

fn meta(name: &str, namespace: &str, labels: Value) -> Value {
    json!({"kind": "PartialObjectMetadata", "apiVersion": "meta.k8s.io/v1",
           "metadata": {"name": name, "namespace": namespace, "uid": format!("uid-{name}"),
                        "creationTimestamp": "2024-05-01T10:00:00Z", "labels": labels}})
}

fn meta_list(items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1",
               "metadata": {"resourceVersion": "1"}, "items": items}),
    )
}

/// Filters by the `labelSelector=app%3D<value>` the search sends, like the
/// API server would.
fn select(query: &str, items: Vec<(Value, &str)>) -> Vec<Value> {
    let wanted = query
        .split('&')
        .find_map(|p| p.strip_prefix("labelSelector=app%3D"))
        .map(str::to_string);
    items
        .into_iter()
        .filter(|(_, app)| wanted.as_deref().is_none_or(|w| w == *app))
        .map(|(v, _)| v)
        .collect()
}

/// "Alpha": pods, configmaps, deployments (apps group) and metrics-server.
fn alpha_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/api/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    resource("pods", "Pod", true),
                    resource("configmaps", "ConfigMap", true),
                    resource("nodes", "Node", false),
                ]}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": [
                    {"name": "apps", "versions": [{"groupVersion": "apps/v1", "version": "v1"}],
                     "preferredVersion": {"groupVersion": "apps/v1", "version": "v1"}}
                ]}),
            ),
            ("GET", "/apis/apps/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "apps/v1", "resources": [
                    resource("deployments", "Deployment", true),
                ]}),
            ),
            ("GET", "/api/v1/pods") => meta_list(select(
                query,
                vec![
                    (meta("web-1", "shop", json!({"app": "web"})), "web"),
                    (meta("web-2", "shop", json!({"app": "web"})), "web"),
                    (meta("api-1", "shop", json!({"app": "api"})), "api"),
                    (meta("worker", "jobs", json!({})), ""),
                ],
            )),
            ("GET", "/api/v1/namespaces/shop/pods") => meta_list(vec![
                meta("web-1", "shop", json!({})),
                meta("web-2", "shop", json!({})),
            ]),
            ("GET", "/api/v1/configmaps") => meta_list(select(
                query,
                vec![(meta("web-config", "shop", json!({})), "")],
            )),
            ("GET", "/apis/apps/v1/deployments") => meta_list(select(
                query,
                vec![(meta("web", "shop", json!({"app": "web"})), "web")],
            )),
            ("GET", "/apis/metrics.k8s.io/v1beta1/nodes") => Reply::Json(
                200,
                json!({"kind": "NodeMetricsList", "apiVersion": "metrics.k8s.io/v1beta1",
                       "metadata": {}, "items": [
                    {"metadata": {"name": "n1"}, "timestamp": "2024-01-01T00:00:00Z", "window": "15s",
                     "usage": {"cpu": "500m", "memory": "1Gi"}},
                    {"metadata": {"name": "n2"}, "timestamp": "2024-01-01T00:00:00Z", "window": "15s",
                     "usage": {"cpu": "250m", "memory": "512Mi"}}
                ]}),
            ),
            ("GET", "/apis/metrics.k8s.io/v1beta1/pods") => Reply::Json(
                200,
                json!({"kind": "PodMetricsList", "apiVersion": "metrics.k8s.io/v1beta1",
                       "metadata": {}, "items": [
                    {"metadata": {"name": "web-1", "namespace": "shop"}, "timestamp": "2024-01-01T00:00:00Z",
                     "window": "15s", "containers": [{"name": "app", "usage": {"cpu": "100m", "memory": "100Mi"}}]},
                    {"metadata": {"name": "web-2", "namespace": "shop"}, "timestamp": "2024-01-01T00:00:00Z",
                     "window": "15s", "containers": [{"name": "app", "usage": {"cpu": "50m", "memory": "50Mi"}}]}
                ]}),
            ),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

/// "Beta": no apps group, ConfigMaps forbidden, no metrics-server.
fn beta_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let path = req
            .path
            .split_once('?')
            .map_or(req.path.as_str(), |(p, _)| p);
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/api/v1") => Reply::Json(
                200,
                json!({"kind": "APIResourceList", "groupVersion": "v1", "resources": [
                    resource("pods", "Pod", true),
                    resource("configmaps", "ConfigMap", true),
                ]}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/api/v1/pods") => meta_list(vec![meta("web-9", "shop", json!({}))]),
            ("GET", "/api/v1/configmaps") => {
                Reply::Json(403, status(403, "Forbidden", "configmaps is forbidden"))
            }
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

fn gvk(group: &str, kind: &str, plural: &str, namespaced: bool) -> Gvk {
    Gvk {
        group: group.into(),
        version: "v1".into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced,
    }
}

fn all_kinds() -> Vec<Gvk> {
    vec![
        gvk("", "Pod", "pods", true),
        gvk("", "ConfigMap", "configmaps", true),
        gvk("apps", "Deployment", "deployments", true),
        gvk("", "Node", "nodes", false),
    ]
}

fn query(text: &str) -> FleetSearchQuery {
    FleetSearchQuery {
        text: text.into(),
        kinds: all_kinds(),
        cluster_ids: Vec::new(),
        namespace: None,
        label_selector: None,
        limit_per_kind: 50,
    }
}

/// Run a search to completion and return its events in arrival order.
async fn run(app: &kubepit_core::Kubepit, query: FleetSearchQuery) -> Vec<FleetSearchEvent> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let id = app
        .fleet_search(query, move |e| tx.send(e).is_ok())
        .unwrap();
    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("search finishes")
            .expect("channel open");
        assert_eq!(event.search_id, id);
        let done = event.kind == FleetSearchEventKind::Done;
        events.push(event);
        if done {
            return events;
        }
    }
}

/// `(cluster, kind, namespace/name)` of every result, sorted.
fn hits(events: &[FleetSearchEvent]) -> Vec<(String, String, String)> {
    let mut out: Vec<_> = events
        .iter()
        .filter(|e| e.kind == FleetSearchEventKind::Results)
        .flat_map(|e| {
            e.items.iter().map(|i| {
                (
                    e.cluster_id.clone().unwrap(),
                    i.gvk.kind.clone(),
                    format!("{}/{}", i.namespace.clone().unwrap_or_default(), i.name),
                )
            })
        })
        .collect();
    out.sort();
    out
}

fn add_cluster(app: &kubepit_core::Kubepit, name: &str, server: &str) -> String {
    app.cluster_add(vec![ClusterInput {
        name: name.into(),
        context: "fake".into(),
        kubeconfig_text: Some(kubeconfig_for(server)),
        ..Default::default()
    }])
    .unwrap()
    .remove(0)
    .id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fleet_search_across_clusters() {
    let alpha = start(alpha_router()).await;
    let beta = start(beta_router()).await;
    let (_dir, app, _recorder, alpha_id) = setup(&alpha.url, false);
    let beta_id = add_cluster(&app, "Beta", &beta.url);
    // Registered but never connected: must be skipped, not connected.
    let gamma_id = add_cluster(&app, "Gamma", "http://127.0.0.1:9");
    for id in [&alpha_id, &beta_id] {
        assert_eq!(
            app.cluster_connect(id).await.unwrap().state,
            ConnState::Connected
        );
    }

    let events = run(&app, query("web")).await;
    let a = alpha_id.clone();
    let b = beta_id.clone();
    let hit = |c: &str, k: &str, n: &str| (c.to_string(), k.to_string(), n.to_string());
    assert_eq!(hits(&events), {
        let mut v = vec![
            hit(&a, "ConfigMap", "shop/web-config"),
            hit(&a, "Deployment", "shop/web"),
            hit(&a, "Pod", "shop/web-1"),
            hit(&a, "Pod", "shop/web-2"),
            hit(&b, "Pod", "shop/web-9"),
        ];
        v.sort();
        v
    });
    let item = events
        .iter()
        .flat_map(|e| &e.items)
        .find(|i| i.name == "web-1")
        .unwrap();
    assert_eq!(item.uid, "uid-web-1");
    assert_eq!(item.labels["app"], "web");
    assert!(item
        .created
        .as_deref()
        .unwrap()
        .starts_with("2024-05-01T10:00:00"));

    let last_for = |id: &str| {
        events
            .iter()
            .rfind(|e| e.cluster_id.as_deref() == Some(id))
            .unwrap()
            .clone()
    };
    let alpha_done = last_for(&alpha_id);
    assert_eq!(alpha_done.kind, FleetSearchEventKind::ClusterDone);
    assert!(alpha_done.error.is_none() && alpha_done.forbidden_kinds.is_empty());
    // Beta: ConfigMaps forbidden, Deployments and Nodes not served (quietly).
    let beta_done = last_for(&beta_id);
    assert_eq!(
        beta_done.kind,
        FleetSearchEventKind::ClusterDone,
        "{beta_done:?}"
    );
    assert_eq!(beta_done.forbidden_kinds, vec!["ConfigMap"]);
    let gamma = last_for(&gamma_id);
    assert_eq!(gamma.kind, FleetSearchEventKind::ClusterSkipped);
    assert_eq!(gamma.error.as_deref(), Some("not connected"));
    assert_eq!(
        app.cluster_status(&gamma_id).state,
        ConnState::Disconnected,
        "searching never connects"
    );
    assert_eq!(events.last().unwrap().kind, FleetSearchEventKind::Done);
    assert!(events.last().unwrap().cluster_id.is_none());

    // Globs are anchored, regexes are case-insensitive, nodes have no namespace.
    let events = run(&app, query("web-?")).await;
    let mut names: Vec<String> = hits(&events).into_iter().map(|h| h.2).collect();
    names.sort();
    assert_eq!(names, vec!["shop/web-1", "shop/web-2", "shop/web-9"]);
    let events = run(&app, query(r"/^API-\d$/")).await;
    assert_eq!(hits(&events), vec![hit(&a, "Pod", "shop/api-1")]);

    // Label selectors go to the API server; the namespace scopes the lists
    // and drops cluster-scoped kinds.
    let mut q = query("");
    q.label_selector = Some("app=web".into());
    q.cluster_ids = vec![alpha_id.clone()];
    let events = run(&app, q).await;
    assert_eq!(
        hits(&events),
        vec![
            hit(&a, "Deployment", "shop/web"),
            hit(&a, "Pod", "shop/web-1"),
            hit(&a, "Pod", "shop/web-2"),
        ]
    );
    assert!(
        alpha
            .log
            .lock()
            .iter()
            .any(|r| r.path.starts_with("/api/v1/pods?")
                && r.path.contains("labelSelector=app%3Dweb"))
    );
    let mut q = query("");
    q.namespace = Some("shop".into());
    q.kinds = vec![
        gvk("", "Pod", "pods", true),
        gvk("", "Node", "nodes", false),
    ];
    q.cluster_ids = vec![alpha_id.clone()];
    let seen = alpha.log.lock().len();
    let events = run(&app, q).await;
    assert_eq!(hits(&events).len(), 2);
    assert!(!alpha.log.lock()[seen..]
        .iter()
        .any(|r| r.path.starts_with("/api/v1/nodes")));

    // The per-kind cap reports truncation.
    let mut q = query("");
    q.limit_per_kind = 1;
    q.kinds = vec![gvk("", "Pod", "pods", true)];
    q.cluster_ids = vec![alpha_id.clone()];
    let events = run(&app, q).await;
    let results: Vec<_> = events
        .iter()
        .filter(|e| e.kind == FleetSearchEventKind::Results)
        .collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].items.len(), 1);
    assert!(results[0].truncated);

    // Invalid queries fail up front; cancelling an unknown id is harmless.
    assert!(app.fleet_search(query("/(/"), |_| true).is_err());
    let mut q = query("x");
    q.kinds.clear();
    assert!(app.fleet_search(q, |_| true).is_err());
    app.fleet_search_cancel("nope");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metrics_history_is_sampled_while_connected() {
    let alpha = start(alpha_router()).await;
    let beta = start(beta_router()).await;
    let (_dir, app, _recorder, alpha_id) = setup(&alpha.url, false);
    let beta_id = add_cluster(&app, "Beta", &beta.url);
    // Sampling is opt-in per process (the desktop shell turns it on).
    app.set_metrics_sampling(true);

    // Nothing is sampled before connecting.
    let before = app
        .metrics_history(&alpha_id, &MetricsHistoryQuery::Cluster)
        .unwrap();
    assert!(before.points.is_empty());
    assert!(app.metrics_history_fleet().is_empty());
    assert!(app
        .metrics_history("unknown", &MetricsHistoryQuery::Cluster)
        .is_err());

    app.cluster_connect(&alpha_id).await.unwrap();
    app.cluster_connect(&beta_id).await.unwrap();

    // The first sample is taken right after connecting.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let total = loop {
        let series = app
            .metrics_history(&alpha_id, &MetricsHistoryQuery::Cluster)
            .unwrap();
        if !series.points.is_empty() || tokio::time::Instant::now() > deadline {
            break series;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(total.available);
    assert_eq!(total.interval_secs, 15);
    assert_eq!(total.points.len(), 1);
    assert_eq!(total.points[0].cpu_millicores, 750.0);
    assert_eq!(total.points[0].memory_bytes, 1.5 * 1024f64.powi(3));

    let n1 = app
        .metrics_history(
            &alpha_id,
            &MetricsHistoryQuery::Nodes {
                names: vec!["n1".into()],
            },
        )
        .unwrap();
    assert_eq!(n1.points[0].cpu_millicores, 500.0);
    let workload = app
        .metrics_history(
            &alpha_id,
            &MetricsHistoryQuery::Pods {
                namespace: "shop".into(),
                names: vec!["web-1".into(), "web-2".into(), "web-gone".into()],
            },
        )
        .unwrap();
    assert_eq!(workload.points[0].cpu_millicores, 150.0);
    assert_eq!(workload.points[0].memory_bytes, 150.0 * 1024.0 * 1024.0);

    // Beta has no metrics-server: unavailable, and the shared gate now
    // spares the overview the same 404.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let series = app
            .metrics_history(&beta_id, &MetricsHistoryQuery::Cluster)
            .unwrap();
        if !series.available {
            assert!(series.points.is_empty());
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "beta never marked unavailable"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!app.metrics_nodes(&beta_id).await.unwrap().available);

    let fleet = app.metrics_history_fleet();
    assert_eq!(fleet.len(), 2);
    assert_eq!(fleet[&alpha_id].interval_secs, 60);
    assert_eq!(fleet[&alpha_id].points.len(), 1);
    assert!(!fleet[&beta_id].available);

    // Disconnecting stops the sampler and frees the history.
    app.cluster_disconnect(&alpha_id);
    assert!(app
        .metrics_history(&alpha_id, &MetricsHistoryQuery::Cluster)
        .unwrap()
        .points
        .is_empty());
    assert_eq!(app.metrics_history_fleet().len(), 1);
    app.shutdown().await;
    assert!(app.metrics_history_fleet().is_empty());
}
