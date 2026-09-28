//! End-to-end tests of cost detection, reports and right-sizing through the
//! fake API server in `support/` (service proxy included). No real cluster
//! is involved.

mod support;

use std::sync::Arc;

use kubepit_core::cost::{
    CostAggregate, CostApiKind, CostConfig, CostNoteKind, CostPricing, CostQuery, CostSourceConfig,
    CostSourceKind, CostSpecial, CostTrendBasis, CostUsageSource, CostWindow,
};
use kubepit_core::rightsizing::{
    Change, Confidence, ContainerResourceChange, RightsizingNoteKind, RightsizingRequest,
    RightsizingSource, Verdict, WorkloadRef,
};
use kubepit_core::types::{DryRunOperation, PromScheme};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const OPENCOST: &str = "/api/v1/namespaces/opencost/services/http:opencost:9003/proxy";
const KUBECOST: &str =
    "/api/v1/namespaces/kubecost/services/http:kubecost-cost-analyzer:9090/proxy";
const OPERATED: &str = "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy";
const MIB: f64 = 1024.0 * 1024.0;

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn list(kind: &str, items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": kind, "apiVersion": "v1", "metadata": {"resourceVersion": "1"}, "items": items}),
    )
}

fn service(namespace: &str, name: &str, labels: Value, ports: Value) -> Value {
    json!({"metadata": {"name": name, "namespace": namespace, "labels": labels},
           "spec": {"ports": ports}})
}

fn not_found() -> Reply {
    Reply::Json(404, status(404, "NotFound", "not found"))
}

fn param(path: &str, key: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    let raw = query
        .split('&')
        .find_map(|p| p.strip_prefix(&format!("{key}=")))?;
    let bytes = raw.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(&raw[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(String::from_utf8(out).unwrap())
}

fn count(log: &Log, prefix: &str) -> usize {
    log.lock()
        .iter()
        .filter(|r| r.path.starts_with(prefix))
        .count()
}

fn bare(path: &str) -> &str {
    path.split_once('?').map_or(path, |(p, _)| p)
}

/// One allocation over a full week (costs per week).
fn allocation(name: &str, namespace: &str, cpu: f64, ram: f64) -> Value {
    json!({
        "name": name,
        "properties": {"cluster": "default-cluster", "namespace": namespace},
        "start": "2026-09-20T00:00:00Z", "end": "2026-09-27T00:00:00Z",
        "minutes": 10080.0,
        "cpuCoreRequestAverage": 2.0, "cpuCoreUsageAverage": 0.5,
        "ramByteRequestAverage": 4294967296.0, "ramByteUsageAverage": 1073741824.0,
        "cpuCost": cpu, "ramCost": ram, "pvCost": 0.0, "totalCost": cpu + ram,
        "totalEfficiency": 0.3
    })
}

fn allocation_reply(path: &str) -> Reply {
    let aggregate = param(path, "aggregate").unwrap_or_default();
    if param(path, "window").as_deref() == Some("1h") {
        return Reply::Json(200, json!({"code": 200, "data": [{}]}));
    }
    if param(path, "step").as_deref() == Some("1d") {
        let day = |start: &str, cost: f64| {
            json!({"default-cluster": {"name": "default-cluster", "start": start,
                                       "minutes": 1440.0, "totalCost": cost}})
        };
        return Reply::Json(
            200,
            json!({"code": 200, "data": [day("2026-09-25T00:00:00Z", 20.0), day("2026-09-26T00:00:00Z", 22.0)]}),
        );
    }
    let data = if aggregate.starts_with("label:") {
        json!({"app_kubernetes_io_part_of=checkout": allocation("app_kubernetes_io_part_of=checkout", "", 50.0, 20.0),
               "__unallocated__": allocation("__unallocated__", "", 5.0, 5.0)})
    } else {
        json!({"shop": allocation("shop", "shop", 70.0, 28.0),
               "kube-system": allocation("kube-system", "kube-system", 7.0, 7.0),
               "__idle__": allocation("__idle__", "", 35.0, 14.0)})
    };
    Reply::Json(
        200,
        json!({"code": 200, "status": "success", "data": [data]}),
    )
}

fn opencost_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| match bare(&req.path) {
        "/version" => version(),
        "/api/v1/services" => list(
            "ServiceList",
            vec![
                service(
                    "kube-system",
                    "kube-dns",
                    json!({}),
                    json!([{"name": "dns", "port": 53}]),
                ),
                service(
                    "opencost",
                    "opencost",
                    json!({"app.kubernetes.io/name": "opencost"}),
                    json!([{"name": "http", "port": 9003}, {"name": "http-ui", "port": 9090}]),
                ),
            ],
        ),
        p if p == format!("{OPENCOST}/allocation/compute") => allocation_reply(&req.path),
        _ => not_found(),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opencost_is_detected_and_queried_through_the_proxy() {
    let server = start(opencost_router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);

    let st = app.cost_status(&id, false).await.unwrap();
    assert_eq!(st.source, CostSourceKind::Opencost, "{st:?}");
    let svc = st.service.clone().unwrap();
    assert_eq!((svc.namespace.as_str(), svc.port), ("opencost", 9003));
    assert_eq!(svc.kind, CostApiKind::Opencost);
    assert!(!st.configured);
    assert!(!st.prometheus);
    assert_eq!(st.candidates.len(), 1);

    let report = app.cost_report(&id, &CostQuery::default()).await.unwrap();
    assert_eq!(report.status.source, CostSourceKind::Opencost);
    assert_eq!(report.usage, CostUsageSource::CostApi);
    assert_eq!(report.items[0].key, "shop");
    let factor = 730.0 / 168.0;
    assert!((report.items[0].total_cost - 98.0 * factor).abs() < 1e-6);
    assert!((report.totals.idle.unwrap() - 49.0 * factor).abs() < 1e-6);
    assert!(report
        .items
        .iter()
        .any(|i| i.special == Some(CostSpecial::Idle)));
    assert_eq!(report.trend_basis, CostTrendBasis::Total);
    assert_eq!(report.trend.len(), 2);
    assert_eq!(report.trend[1].total, 22.0);
    assert!(report.notes.is_empty(), "{:?}", report.notes);

    // Cached: the same report again does not query OpenCost.
    let queries = count(&server.log, &format!("{OPENCOST}/allocation/compute"));
    app.cost_report(&id, &CostQuery::default()).await.unwrap();
    assert_eq!(
        count(&server.log, &format!("{OPENCOST}/allocation/compute")),
        queries
    );
    let summary = app.cost_summary(&id).await.unwrap();
    assert_eq!(summary.source, CostSourceKind::Opencost);
    assert_eq!(summary.currency, "USD");

    // Label breakdowns use Prometheus-style label names.
    let by_label = app
        .cost_report(
            &id,
            &CostQuery {
                window: CostWindow::Month,
                aggregate: CostAggregate::Label,
                label: Some("app.kubernetes.io/part-of".into()),
                refresh: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(by_label.items[0].name, "checkout");
    let log = server.log.lock().clone();
    assert!(log.iter().any(|r| {
        param(&r.path, "aggregate").as_deref() == Some("label:app_kubernetes_io_part_of")
            && param(&r.path, "window").as_deref() == Some("30d")
    }));
    assert!(
        log.iter().all(|r| r.method == "GET"),
        "read-only cluster: only GETs"
    );
    assert!(app
        .cost_report(
            &id,
            &CostQuery {
                aggregate: CostAggregate::Label,
                ..Default::default()
            }
        )
        .await
        .is_err());
}

fn estimate_router(kubecost: bool) -> Router {
    Arc::new(move |req: &Request, _log: &Log| match bare(&req.path) {
        "/version" => version(),
        "/api/v1/services" => list(
            "ServiceList",
            if kubecost {
                vec![service(
                    "kubecost",
                    "kubecost-cost-analyzer",
                    json!({"app": "cost-analyzer"}),
                    json!([{"name": "tcp-model", "port": 9003}, {"name": "tcp-frontend", "port": 9090}]),
                )]
            } else {
                vec![]
            },
        ),
        p if p == format!("{KUBECOST}/model/allocation") => allocation_reply(&req.path),
        p if p.starts_with(OPENCOST) => Reply::Json(
            503,
            status(
                503,
                "ServiceUnavailable",
                "no endpoints available for service \"opencost\"",
            ),
        ),
        "/api/v1/pods" => list(
            "PodList",
            vec![
                json!({"metadata": {"name": "web-1", "namespace": "shop"},
                       "spec": {"containers": [{"name": "app", "resources": {"requests": {"cpu": "500m", "memory": "1Gi"}}}],
                                "volumes": [{"name": "d", "persistentVolumeClaim": {"claimName": "data"}}]},
                       "status": {"phase": "Running"}}),
                json!({"metadata": {"name": "old", "namespace": "shop"},
                       "spec": {"containers": [{"name": "app", "resources": {"requests": {"cpu": "4"}}}]},
                       "status": {"phase": "Succeeded"}}),
            ],
        ),
        "/api/v1/nodes" => Reply::Json(403, status(403, "Forbidden", "nodes is forbidden")),
        "/api/v1/persistentvolumeclaims" => list(
            "PersistentVolumeClaimList",
            vec![json!({"metadata": {"name": "data", "namespace": "shop"},
                        "spec": {"resources": {"requests": {"storage": "20Gi"}}},
                        "status": {"capacity": {"storage": "20Gi"}}})],
        ),
        _ => not_found(),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn estimates_use_requests_and_the_price_model() {
    let server = start(estimate_router(false)).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let report = app.cost_report(&id, &CostQuery::default()).await.unwrap();
    assert_eq!(report.status.source, CostSourceKind::Estimate);
    assert!(!report.status.pricing_custom);
    assert_eq!(report.currency, "USD");
    assert_eq!(report.usage, CostUsageSource::None);
    assert_eq!(report.trend_basis, CostTrendBasis::None);
    assert!(report.totals.idle.is_none(), "nodes are forbidden");
    assert!(report
        .notes
        .iter()
        .any(|n| n.kind == CostNoteKind::NodesUnavailable));
    let p = report.status.pricing.clone();
    let shop = &report.items[0];
    assert_eq!(shop.pods, 1, "finished pods hold nothing");
    let expected =
        0.5 * p.cpu_hour * 730.0 + p.memory_gib_hour * 730.0 + 20.0 * p.storage_gib_month.unwrap();
    assert!((shop.total_cost - expected).abs() < 1e-9);

    // A custom price model in EUR with a discount.
    let mut def = app.cluster_def(&id).unwrap();
    def.cost = CostConfig {
        source: CostSourceConfig::Estimate,
        pricing: Some(CostPricing {
            currency: "eur".into(),
            cpu_hour: 0.05,
            memory_gib_hour: 0.01,
            gpu_hour: None,
            storage_gib_month: None,
            discount_percent: 50.0,
        }),
    };
    let saved = app.cluster_update(def).unwrap();
    assert_eq!(saved.cost.pricing.as_ref().unwrap().currency, "EUR");
    let report = app.cost_report(&id, &CostQuery::default()).await.unwrap();
    assert!(report.status.configured && report.status.pricing_custom);
    assert_eq!(report.currency, "EUR");
    let expected = (0.5 * 0.05 * 730.0 + 0.01 * 730.0) * 0.5;
    assert!((report.totals.total - expected).abs() < 1e-9);
    assert_eq!(
        count(&server.log, "/api/v1/namespaces/opencost"),
        0,
        "estimate only"
    );

    // Invalid settings are refused.
    let mut def = app.cluster_def(&id).unwrap();
    def.cost.pricing.as_mut().unwrap().discount_percent = 150.0;
    assert!(app.cluster_update(def).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kubecost_is_found_and_an_unreachable_service_falls_back_to_an_estimate() {
    let server = start(estimate_router(true)).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let st = app.cost_status(&id, false).await.unwrap();
    assert_eq!(st.source, CostSourceKind::Kubecost, "{st:?}");
    assert_eq!(st.service.as_ref().unwrap().port, 9090);
    let report = app.cost_report(&id, &CostQuery::default()).await.unwrap();
    assert_eq!(report.items[0].key, "shop");
    assert!(server
        .log
        .lock()
        .iter()
        .any(|r| r.path.starts_with(&format!("{KUBECOST}/model/allocation?"))));

    // A configured OpenCost without endpoints: estimate, with the reason.
    let mut def = app.cluster_def(&id).unwrap();
    def.cost.source = CostSourceConfig::Opencost {
        namespace: "opencost".into(),
        service: "opencost".into(),
        port: 9003,
        scheme: PromScheme::Http,
        path_prefix: String::new(),
    };
    app.cluster_update(def).unwrap();
    let st = app.cost_status(&id, false).await.unwrap();
    assert_eq!(st.source, CostSourceKind::Estimate);
    assert!(st.configured);
    assert!(st.error.unwrap().contains("no endpoints available"));
    let report = app.cost_report(&id, &CostQuery::default()).await.unwrap();
    assert_eq!(report.status.source, CostSourceKind::Estimate);
    assert!(report.totals.total > 0.0);
}

fn deployment(replicas: u64, cpu: &str, memory: &str) -> Value {
    json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": "web", "namespace": "shop", "uid": "uid-web", "resourceVersion": "7"},
        "spec": {"replicas": replicas, "selector": {"matchLabels": {"app": "web"}},
                 "template": {"metadata": {"labels": {"app": "web"}}, "spec": {"containers": [
                     {"name": "app", "image": "web:1",
                      "resources": {"requests": {"cpu": cpu, "memory": memory}, "limits": {"memory": memory}}}
                 ]}}}
    })
}

fn vector(labels: Value, value: &str) -> Reply {
    Reply::Json(
        200,
        json!({"status": "success", "data": {"resultType": "vector", "result": [
            {"metric": labels, "value": [1_790_000_000, value]}
        ]}}),
    )
}

fn rightsizing_router(prometheus: bool) -> Router {
    Arc::new(move |req: &Request, _log: &Log| {
        let key = json!({"namespace": "shop", "pod": "web-6d4b75cb6d-x2x9z", "container": "app"});
        match (req.method.as_str(), bare(&req.path)) {
            (_, "/version") => version(),
            (_, "/api/v1/services") => list(
                "ServiceList",
                if prometheus {
                    vec![service(
                        "monitoring",
                        "prometheus-operated",
                        json!({"operated-prometheus": "true"}),
                        json!([{"name": "web", "port": 9090}]),
                    )]
                } else {
                    vec![]
                },
            ),
            (_, p) if p == format!("{OPERATED}/api/v1/query") => {
                let q = param(&req.path, "query").unwrap_or_default();
                if q == "1" {
                    Reply::Json(
                        200,
                        json!({"status": "success", "data": {"resultType": "scalar", "result": [1, "1"]}}),
                    )
                } else if q.starts_with("quantile_over_time(0.95") {
                    vector(key, "120")
                } else if q.starts_with("max_over_time((sum") {
                    vector(key, "300")
                } else if q.contains("max_over_time(container_memory_working_set_bytes") {
                    vector(key, "314572800")
                } else if q.starts_with("count_over_time") {
                    vector(key, "168")
                } else {
                    vector(json!({}), "0")
                }
            }
            (_, "/apis/apps/v1/deployments") => {
                list("DeploymentList", vec![deployment(2, "1", "1Gi")])
            }
            (_, "/apis/apps/v1/statefulsets") => list("StatefulSetList", vec![]),
            (_, "/apis/apps/v1/daemonsets") => list("DaemonSetList", vec![]),
            (_, "/api/v1/pods") => list("PodList", vec![]),
            ("GET", "/apis/apps/v1/namespaces/shop/deployments/web") => {
                Reply::Json(200, deployment(2, "1", "1Gi"))
            }
            ("PATCH", "/apis/apps/v1/namespaces/shop/deployments/web") => {
                let mut obj = deployment(2, "140m", "368Mi");
                obj["metadata"]["resourceVersion"] = json!("8");
                Reply::Json(200, obj)
            }
            _ => not_found(),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn right_sizing_recommends_from_prometheus_history() {
    let server = start(rightsizing_router(true)).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);

    let report = app
        .rightsizing_report(&id, &RightsizingRequest::default())
        .await
        .unwrap();
    assert_eq!(
        report.source,
        RightsizingSource::Prometheus,
        "{:?}",
        report.notes
    );
    assert_eq!(report.window_secs, 7 * 86_400);
    assert_eq!(report.strategy, "percentile-headroom");
    assert_eq!(report.strategies[0].id, report.strategy);
    assert_eq!(report.workloads.len(), 1);
    let web = &report.workloads[0];
    assert_eq!(
        (web.kind.as_str(), web.name.as_str()),
        ("Deployment", "web")
    );
    assert_eq!(web.confidence, Confidence::High);
    assert_eq!(web.verdict, Verdict::Over);
    assert!(web.changed && web.monthly_delta < 0.0);
    let app_rec = &web.containers[0];
    assert_eq!(app_rec.cpu, Change::Decrease);
    assert_eq!(app_rec.recommended.cpu_request, Some(140.0));
    assert_eq!(app_rec.recommended.memory_request, Some(368.0 * MIB));
    let usage = app_rec.usage.unwrap();
    assert_eq!((usage.cpu_p95, usage.cpu_max), (120.0, 300.0));
    assert_eq!(usage.hours, 84.0, "168 hours of one pod over two replicas");

    assert_eq!(app_rec.confidence, Confidence::High);
    assert!(!app_rec.memory_limit_raised, "368 MiB fits the 1 GiB limit");
    let unknown = RightsizingRequest {
        strategy: Some("nope".into()),
        ..Default::default()
    };
    assert!(app.rightsizing_report(&id, &unknown).await.is_err());

    // The whole cluster was covered: no namespace matcher in the presets.
    let log = server.log.lock().clone();
    let p95 = log
        .iter()
        .filter_map(|r| param(&r.path, "query"))
        .find(|q| q.starts_with("quantile_over_time"))
        .unwrap();
    assert!(!p95.contains("namespace=~"), "{p95}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn applying_a_recommendation_dry_runs_and_honours_read_only() {
    let changes = vec![ContainerResourceChange {
        container: "app".into(),
        cpu_request: Some(140.0),
        cpu_limit: None,
        memory_request: Some(368.0 * MIB),
        memory_limit: Some(432.0 * MIB),
    }];
    let target = WorkloadRef {
        kind: "Deployment".into(),
        namespace: "shop".into(),
        name: "web".into(),
    };

    let server = start(rightsizing_router(false)).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    // Read-only: the review (dry run) works…
    let review = app
        .rightsizing_apply(&id, &target, &changes, true)
        .await
        .unwrap();
    assert_eq!(review.operation, DryRunOperation::Update);
    assert!(review.live.is_some() && review.result.is_some());
    let patch = server
        .log
        .lock()
        .iter()
        .find(|r| r.method == "PATCH")
        .cloned()
        .expect("dry-run patch sent");
    assert_eq!(param(&patch.path, "dryRun").as_deref(), Some("All"));
    let body: Value = serde_json::from_str(&patch.body).unwrap();
    assert_eq!(
        body["spec"]["template"]["spec"]["containers"][0],
        json!({"name": "app", "resources": {"requests": {"cpu": "140m", "memory": "368Mi"},
                                             "limits": {"memory": "432Mi"}}})
    );
    assert_eq!(
        body["metadata"]["annotations"]["kubernetes.io/change-cause"],
        "kubepit right-size deployment/web"
    );
    // …the apply does not, and sends nothing.
    let err = app
        .rightsizing_apply(&id, &target, &changes, false)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("read-only"), "{err}");
    let patches = server
        .log
        .lock()
        .iter()
        .filter(|r| r.method == "PATCH")
        .count();
    assert_eq!(patches, 1);

    // Unknown containers and unsupported kinds are refused before any request.
    let mut unknown = changes.clone();
    unknown[0].container = "nope".into();
    assert!(app
        .rightsizing_apply(&id, &target, &unknown, true)
        .await
        .is_err());
    let cron = WorkloadRef {
        kind: "CronJob".into(),
        ..target.clone()
    };
    assert!(app
        .rightsizing_apply(&id, &cron, &changes, true)
        .await
        .is_err());

    // Writable cluster: a real patch (no dryRun).
    let server = start(rightsizing_router(false)).await;
    let (_dir2, app, _recorder, id) = setup(&server.url, false);
    let applied = app
        .rightsizing_apply(&id, &target, &changes, false)
        .await
        .unwrap();
    assert_eq!(applied.operation, DryRunOperation::Update);
    let patch = server
        .log
        .lock()
        .iter()
        .find(|r| r.method == "PATCH")
        .cloned()
        .unwrap();
    assert!(param(&patch.path, "dryRun").is_none());

    // Without Prometheus or metrics-server history there is nothing to recommend.
    let report = app
        .rightsizing_report(&id, &RightsizingRequest::default())
        .await
        .unwrap();
    assert_eq!(report.source, RightsizingSource::None);
    assert!(report
        .notes
        .iter()
        .any(|n| n.kind == RightsizingNoteKind::NoUsage));
    assert_eq!(report.workloads[0].verdict, Verdict::NoData);
    assert!(!report.workloads[0].changed);
}
