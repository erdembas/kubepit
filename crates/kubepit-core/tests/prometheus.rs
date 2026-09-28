//! End-to-end tests of Prometheus detection and queries through the service
//! proxy of the fake API server in `support/`. No real cluster is involved.

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use kubepit_core::types::{
    PromScheme, PrometheusConfig, PrometheusKind, PrometheusMetric, PrometheusRange,
    PrometheusSource, PrometheusState, PrometheusTarget,
};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const OPERATED: &str = "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy";

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn service(namespace: &str, name: &str, labels: Value, ports: Value) -> Value {
    json!({"metadata": {"name": name, "namespace": namespace, "labels": labels},
           "spec": {"ports": ports}})
}

fn service_list(items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": "ServiceList", "apiVersion": "v1", "metadata": {"resourceVersion": "1"},
               "items": items}),
    )
}

fn success(result_type: &str, result: Value) -> Reply {
    Reply::Json(
        200,
        json!({"status": "success", "data": {"resultType": result_type, "result": result}}),
    )
}

fn scalar_one() -> Reply {
    success("scalar", json!([1_700_000_000, "1"]))
}

fn no_endpoints(name: &str) -> Reply {
    Reply::Json(
        503,
        status(
            503,
            "ServiceUnavailable",
            &format!("no endpoints available for service \"{name}\""),
        ),
    )
}

/// Minimal percent-decoding of a query parameter.
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

fn last_hour() -> PrometheusRange {
    let end = 1_700_003_600_000;
    PrometheusRange {
        start: end - 3_600_000,
        end,
        step: None,
    }
}

/// kube-prometheus-stack in `monitoring`; `gone` makes the service vanish.
fn stack_router(gone: Arc<AtomicBool>) -> Router {
    Arc::new(move |req: &Request, _log: &Log| {
        let path = req
            .path
            .split_once('?')
            .map_or(req.path.as_str(), |(p, _)| p);
        if path.starts_with(OPERATED) && gone.load(Ordering::SeqCst) {
            return no_endpoints("prometheus-operated");
        }
        match path {
            "/version" => version(),
            "/api/v1/services" => service_list(vec![
                service(
                    "kube-system",
                    "kube-dns",
                    json!({}),
                    json!([{"name": "dns-tcp", "port": 53}]),
                ),
                service(
                    "monitoring",
                    "kps-kube-prometheus-prometheus",
                    json!({"app": "kube-prometheus-stack-prometheus"}),
                    json!([{"name": "http-web", "port": 9090}]),
                ),
                service(
                    "monitoring",
                    "prometheus-operated",
                    json!({"operated-prometheus": "true"}),
                    json!([{"name": "web", "port": 9090}]),
                ),
                service(
                    "monitoring",
                    "kps-alertmanager",
                    json!({}),
                    json!([{"name": "http-web", "port": 9093}]),
                ),
            ]),
            p if p == format!("{OPERATED}/api/v1/query") => scalar_one(),
            p if p == format!("{OPERATED}/api/v1/query_range") => {
                let query = param(&req.path, "query").unwrap_or_default();
                if query.contains("kube_pod_container_resource_requests") {
                    Reply::Json(
                        422,
                        json!({"status": "error", "errorType": "execution",
                               "error": "many-to-many matching not allowed"}),
                    )
                } else if query.contains("container_cpu_usage_seconds_total") {
                    success(
                        "matrix",
                        json!([{"metric": {}, "values": [
                            [1_700_000_010, "250"], [1_700_000_025, "NaN"], [1_700_000_040, "300"]
                        ]}]),
                    )
                } else if query == "up" {
                    success(
                        "matrix",
                        json!([
                            {"metric": {"__name__": "up", "job": "kubelet"}, "values": [[1_700_000_010, "1"]]},
                            {"metric": {"__name__": "up", "job": "node-exporter"}, "values": [[1_700_000_010, "0"]]}
                        ]),
                    )
                } else {
                    success("matrix", json!([]))
                }
            }
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detects_kube_prometheus_stack_and_queries_through_the_proxy() {
    let gone = Arc::new(AtomicBool::new(false));
    let server = start(stack_router(gone.clone())).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);

    let st = app.prometheus_status(&id, false).await.unwrap();
    assert_eq!(st.state, PrometheusState::Available, "{st:?}");
    let svc = st.service.clone().unwrap();
    assert_eq!(
        (svc.namespace.as_str(), svc.service.as_str(), svc.port),
        ("monitoring", "prometheus-operated", 9090)
    );
    assert_eq!(svc.kind, PrometheusKind::PrometheusOperator);
    assert_eq!(st.source, Some(PrometheusSource::Detected));
    assert_eq!(
        st.candidates.len(),
        2,
        "alertmanager and kube-dns are not candidates"
    );

    // Cached for the connection.
    app.prometheus_status(&id, false).await.unwrap();
    assert_eq!(count(&server.log, "/api/v1/services"), 1);
    // `refresh` detects again.
    app.prometheus_status(&id, true).await.unwrap();
    assert_eq!(count(&server.log, "/api/v1/services"), 2);

    let pod = PrometheusTarget::Pod {
        namespace: "shop".into(),
        name: "web-1".into(),
    };
    let result = app
        .prometheus_metrics(
            &id,
            &pod,
            &[
                PrometheusMetric::CpuUsage,
                PrometheusMetric::MemoryUsage,
                PrometheusMetric::CpuRequests,
                PrometheusMetric::CpuUsage,
            ],
            &last_hour(),
        )
        .await
        .unwrap();
    assert_eq!(result.step_secs, 15);
    assert_eq!(result.rate_window_secs, 120);
    assert_eq!(result.start % 15_000, 0, "start aligned to the step");
    assert_eq!(result.series.len(), 3, "duplicates are dropped");
    let cpu = &result.series[0];
    assert_eq!(cpu.metric, PrometheusMetric::CpuUsage);
    assert_eq!(
        cpu.points,
        vec![(1_700_000_010_000, 250.0), (1_700_000_040_000, 300.0)],
        "NaN is a gap"
    );
    assert!(cpu.error.is_none());
    assert!(result.series[1].points.is_empty() && result.series[1].error.is_none());
    let requests = &result.series[2];
    assert!(
        requests
            .error
            .as_deref()
            .unwrap()
            .contains("many-to-many matching not allowed"),
        "{requests:?}"
    );

    // The request went through the service proxy with the preset query.
    let log = server.log.lock().clone();
    let sent = log
        .iter()
        .find(|r| {
            r.path
                .starts_with(&format!("{OPERATED}/api/v1/query_range?"))
                && param(&r.path, "query").is_some_and(|q| q.contains("container_cpu_usage"))
        })
        .expect("cpu query sent");
    assert_eq!(param(&sent.path, "query").unwrap(), cpu.query);
    assert_eq!(param(&sent.path, "step").as_deref(), Some("15"));
    assert_eq!(
        param(&sent.path, "start").unwrap().parse::<i64>().unwrap() % 15,
        0
    );
    assert!(
        log.iter().all(|r| r.method == "GET"),
        "read-only cluster: only GETs"
    );

    // Ad-hoc PromQL.
    let raw = app
        .prometheus_query_range(&id, "  up ", &last_hour())
        .await
        .unwrap();
    assert_eq!(raw.result_type, "matrix");
    assert_eq!(raw.series.len(), 2);
    assert_eq!(raw.series[1].labels["job"], "node-exporter");
    assert!(!raw.truncated);
    assert!(app
        .prometheus_query_range(&id, "   ", &last_hour())
        .await
        .is_err());

    // The service disappears: queries fail, and the next status re-detects.
    gone.store(true, Ordering::SeqCst);
    let err = app
        .prometheus_metrics(&id, &pod, &[PrometheusMetric::CpuUsage], &last_hour())
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("no endpoints available"), "{err}");
    let st = app.prometheus_status(&id, false).await.unwrap();
    assert_eq!(count(&server.log, "/api/v1/services"), 3);
    assert_eq!(st.state, PrometheusState::Unreachable);
    assert!(st.error.unwrap().contains("no endpoints available"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forbidden_listing_falls_back_to_namespaces_and_skips_dead_services() {
    const SERVER: &str = "/api/v1/namespaces/monitoring/services/http:prometheus-server:80/proxy";
    const THANOS: &str = "/api/v1/namespaces/thanos/services/http:thanos-query:10902/proxy";
    let router: Router = Arc::new(|req: &Request, _log: &Log| {
        let path = req
            .path
            .split_once('?')
            .map_or(req.path.as_str(), |(p, _)| p);
        match path {
            "/version" => version(),
            "/api/v1/services" => {
                Reply::Json(403, status(403, "Forbidden", "services is forbidden"))
            }
            "/api/v1/namespaces/monitoring/services" => service_list(vec![service(
                "monitoring",
                "prometheus-server",
                json!({}),
                json!([{"name": "http", "port": 80}]),
            )]),
            "/api/v1/namespaces/thanos/services" => service_list(vec![service(
                "thanos",
                "thanos-query",
                json!({}),
                json!([{"name": "grpc", "port": 10901}, {"name": "http", "port": 10902}]),
            )]),
            "/api/v1/namespaces/team-a/services" => {
                Reply::Json(403, status(403, "Forbidden", "forbidden"))
            }
            p if p.starts_with(SERVER) => no_endpoints("prometheus-server"),
            p if p == format!("{THANOS}/api/v1/query") => scalar_one(),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    });
    let server = start(router).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let st = app.prometheus_status(&id, false).await.unwrap();
    assert_eq!(st.state, PrometheusState::Available, "{st:?}");
    let svc = st.service.unwrap();
    assert_eq!(svc.service, "thanos-query");
    assert_eq!(svc.port, 10902);
    assert_eq!(
        st.candidates[0].service, "prometheus-server",
        "ranked first, but dead"
    );
    // The accessible namespaces of the cluster were tried too.
    assert_eq!(count(&server.log, "/api/v1/namespaces/team-a/services"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_service_off_and_not_found() {
    const VM: &str = "/api/v1/namespaces/obs/services/http:vm:8428/proxy/prom";
    let router: Router = Arc::new(|req: &Request, _log: &Log| {
        let path = req
            .path
            .split_once('?')
            .map_or(req.path.as_str(), |(p, _)| p);
        match path {
            "/version" => version(),
            "/api/v1/services" => service_list(vec![service(
                "default",
                "kubernetes",
                json!({}),
                json!([{"name": "https", "port": 443}]),
            )]),
            p if p == format!("{VM}/api/v1/query") => scalar_one(),
            p if p == format!("{VM}/api/v1/query_range") => success("matrix", json!([])),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    });
    let server = start(router).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let st = app.prometheus_status(&id, false).await.unwrap();
    assert_eq!(st.state, PrometheusState::NotFound);
    let err = app
        .prometheus_metrics(&id, &PrometheusTarget::Cluster, &[], &last_hour())
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("no Prometheus"), "{err}");

    // A configured service replaces detection (the change invalidates the cache).
    let mut def = app.cluster_def(&id).unwrap();
    def.prometheus = PrometheusConfig::Service {
        namespace: " obs ".into(),
        service: "vm".into(),
        port: 8428,
        scheme: PromScheme::Http,
        path_prefix: "prom/".into(),
    };
    let saved = app.cluster_update(def).unwrap();
    assert!(
        matches!(&saved.prometheus, PrometheusConfig::Service { namespace, path_prefix, .. }
        if namespace == "obs" && path_prefix == "/prom")
    );
    let listed = count(&server.log, "/api/v1/services");
    let st = app.prometheus_status(&id, false).await.unwrap();
    assert_eq!(st.state, PrometheusState::Available, "{st:?}");
    assert_eq!(st.source, Some(PrometheusSource::Configured));
    assert_eq!(st.service.unwrap().kind, PrometheusKind::Custom);
    assert_eq!(
        count(&server.log, "/api/v1/services"),
        listed,
        "no detection"
    );
    let result = app
        .prometheus_metrics(&id, &PrometheusTarget::Cluster, &[], &last_hour())
        .await
        .unwrap();
    assert!(result.series.len() >= 6);
    assert!(result
        .series
        .iter()
        .all(|s| s.points.is_empty() && s.error.is_none()));

    // Off: no requests at all.
    let mut def = app.cluster_def(&id).unwrap();
    def.prometheus = PrometheusConfig::Off;
    app.cluster_update(def).unwrap();
    // (Counted under `/api/`, where the service proxy lives.)
    let before = count(&server.log, "/api/");
    assert_eq!(
        app.prometheus_status(&id, false).await.unwrap().state,
        PrometheusState::Off
    );
    let err = app
        .prometheus_query_range(&id, "up", &last_hour())
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("turned off"), "{err}");
    assert_eq!(count(&server.log, "/api/"), before);

    // Invalid settings are rejected.
    let mut def = app.cluster_def(&id).unwrap();
    def.prometheus = PrometheusConfig::Service {
        namespace: "obs".into(),
        service: "vm".into(),
        port: 8428,
        scheme: PromScheme::Http,
        path_prefix: "/../../api".into(),
    };
    assert!(app.cluster_update(def).is_err());
}
