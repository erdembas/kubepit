//! End-to-end tests of Loki detection and queries through the service proxy
//! of the fake API server in `support/`. No real cluster is involved.

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use kubepit_core::types::{
    LokiConfig, LokiDirection, LokiKind, LokiQuery, LokiSource, LokiState, PromScheme,
};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const GATEWAY: &str = "/api/v1/namespaces/loki/services/http:loki-gateway:80/proxy";
const READ: &str = "/api/v1/namespaces/loki/services/http:loki-read:3100/proxy";
const HOUR_NS: i64 = 3_600_000_000_000;
const END_NS: i64 = 1_700_003_600_000_000_000;

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn service(namespace: &str, name: &str, ports: Value) -> Value {
    json!({"metadata": {"name": name, "namespace": namespace}, "spec": {"ports": ports}})
}

fn service_list(items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": "ServiceList", "apiVersion": "v1", "metadata": {"resourceVersion": "1"},
               "items": items}),
    )
}

fn labels(values: &[&str]) -> Reply {
    Reply::Json(200, json!({"status": "success", "data": values}))
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

fn last_hour(query: &str) -> LokiQuery {
    LokiQuery {
        query: query.into(),
        start: (END_NS - HOUR_NS).to_string(),
        end: END_NS.to_string(),
        limit: Some(3),
        direction: LokiDirection::Backward,
        step: None,
    }
}

/// A Loki API behind `base`: labels, values and query_range.
fn loki_api(base: &str, req: &Request) -> Option<Reply> {
    let path = req
        .path
        .split_once('?')
        .map_or(req.path.as_str(), |(p, _)| p);
    let rest = path.strip_prefix(base)?;
    Some(match rest {
        "/loki/api/v1/labels" => labels(&["container", "namespace", "pod"]),
        "/loki/api/v1/label/pod/values" => {
            if param(&req.path, "query").as_deref() == Some(r#"{namespace="shop"}"#) {
                labels(&["web-7c9d8b6f5-x2kqp", "web-7c9d8b6f5-abcde"])
            } else {
                labels(&["other"])
            }
        }
        "/loki/api/v1/query_range" => {
            let query = param(&req.path, "query").unwrap_or_default();
            if query.contains("syntax") {
                Reply::Json(
                    400,
                    json!({"status": "error", "errorType": "bad_data",
                           "error": "parse error at line 1, col 1: syntax error: unexpected IDENTIFIER"}),
                )
            } else if query.starts_with("sum(count_over_time(") {
                Reply::Json(
                    200,
                    json!({"status": "success", "data": {"resultType": "matrix", "result": [
                        {"metric": {}, "values": [[1_700_000_000, "4"], [1_700_000_060, "1"]]}
                    ]}}),
                )
            } else {
                Reply::Json(
                    200,
                    json!({"status": "success", "data": {"resultType": "streams", "result": [
                        {"stream": {"namespace": "shop", "pod": "web-1", "container": "nginx"},
                         "values": [["1700000000900000000", "GET /b 200"],
                                    ["1700000000100000000", "GET /a 200"]]},
                        {"stream": {"namespace": "shop", "pod": "web-2", "container": "nginx"},
                         "values": [["1700000000500000000", "{\"level\":\"error\",\"msg\":\"boom\"}"],
                                    ["1700000000000000001", "oldest"]]}
                    ], "stats": {}}}),
                )
            }
        }
        _ => Reply::Json(404, status(404, "NotFound", "not found")),
    })
}

/// The grafana/loki chart (simple scalable) in `loki`; `gateway_down`
/// takes the gateway's endpoints away, `read_gone` the read path's.
fn chart_router(gateway_down: Arc<AtomicBool>, read_gone: Arc<AtomicBool>) -> Router {
    Arc::new(move |req: &Request, _log: &Log| {
        let path = req
            .path
            .split_once('?')
            .map_or(req.path.as_str(), |(p, _)| p);
        if path.starts_with(GATEWAY) && gateway_down.load(Ordering::SeqCst) {
            return no_endpoints("loki-gateway");
        }
        if path.starts_with(READ) && read_gone.load(Ordering::SeqCst) {
            return no_endpoints("loki-read");
        }
        if let Some(reply) = loki_api(GATEWAY, req).or_else(|| loki_api(READ, req)) {
            return reply;
        }
        match path {
            "/version" => version(),
            "/api/v1/services" => service_list(vec![
                service(
                    "default",
                    "kubernetes",
                    json!([{"name": "https", "port": 443}]),
                ),
                service(
                    "loki",
                    "loki-gateway",
                    json!([{"name": "http-metrics", "port": 80}]),
                ),
                service(
                    "loki",
                    "loki-read",
                    json!([{"name": "http-metrics", "port": 3100}, {"name": "grpc", "port": 9095}]),
                ),
                service(
                    "loki",
                    "loki-write",
                    json!([{"name": "http-metrics", "port": 3100}]),
                ),
                service(
                    "loki",
                    "loki-read-headless",
                    json!([{"name": "http-metrics", "port": 3100}]),
                ),
                service(
                    "monitoring",
                    "promtail-metrics",
                    json!([{"name": "http-metrics", "port": 3101}]),
                ),
            ]),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detects_the_gateway_and_queries_through_the_proxy() {
    let server = start(chart_router(Arc::default(), Arc::default())).await;
    // Read-only: Loki only reads, so everything stays available.
    let (_dir, app, _recorder, id) = setup(&server.url, true);

    let st = app.loki_status(&id, false).await.unwrap();
    assert_eq!(st.state, LokiState::Available, "{st:?}");
    let svc = st.service.clone().unwrap();
    assert_eq!(
        (svc.namespace.as_str(), svc.service.as_str(), svc.port),
        ("loki", "loki-gateway", 80)
    );
    assert_eq!(svc.kind, LokiKind::Gateway);
    assert_eq!(st.source, Some(LokiSource::Detected));
    assert_eq!(
        st.candidates.len(),
        2,
        "write path, headless and promtail are not candidates"
    );

    // Cached for the connection; `refresh` detects again.
    app.loki_status(&id, false).await.unwrap();
    assert_eq!(count(&server.log, "/api/v1/services"), 1);
    app.loki_status(&id, true).await.unwrap();
    assert_eq!(count(&server.log, "/api/v1/services"), 2);

    // Log query: lines of both streams merged newest first, cut to the limit.
    let result = app
        .loki_query_range(&id, &last_hour(r#" {namespace="shop"} |= "GET" "#))
        .await
        .unwrap();
    assert_eq!(result.result_type, "streams");
    assert_eq!(result.service.service, "loki-gateway");
    assert_eq!(result.limit, 3);
    assert!(result.limit_reached);
    let lines: Vec<(&str, &str)> = result
        .lines
        .iter()
        .map(|l| {
            (
                result.streams[l.stream as usize]["pod"].as_str(),
                l.ts.as_str(),
            )
        })
        .collect();
    assert_eq!(
        lines,
        vec![
            ("web-1", "1700000000900000000"),
            ("web-2", "1700000000500000000"),
            ("web-1", "1700000000100000000"),
        ]
    );

    // The request carried the LogQL and the nanosecond bounds verbatim.
    let log = server.log.lock().clone();
    let sent = log
        .iter()
        .find(|r| {
            r.path
                .starts_with(&format!("{GATEWAY}/loki/api/v1/query_range?"))
        })
        .expect("query sent");
    assert_eq!(
        param(&sent.path, "query").as_deref(),
        Some(r#"{namespace="shop"} |= "GET""#)
    );
    assert_eq!(
        param(&sent.path, "start").unwrap(),
        (END_NS - HOUR_NS).to_string()
    );
    assert_eq!(param(&sent.path, "end").unwrap(), END_NS.to_string());
    assert_eq!(param(&sent.path, "limit").as_deref(), Some("3"));
    assert_eq!(param(&sent.path, "direction").as_deref(), Some("backward"));

    // Metric query (log volume): series in epoch ms.
    let volume = app
        .loki_query_range(
            &id,
            &LokiQuery {
                step: Some(60),
                ..last_hour(r#"sum(count_over_time({namespace="shop"}[1m]))"#)
            },
        )
        .await
        .unwrap();
    assert_eq!(volume.result_type, "matrix");
    assert!(volume.lines.is_empty() && !volume.limit_reached);
    assert_eq!(
        volume.series[0].points,
        vec![(1_700_000_000_000, 4.0), (1_700_000_060_000, 1.0)]
    );

    // Labels and values for the query builder.
    let start = (END_NS - HOUR_NS).to_string();
    let end = END_NS.to_string();
    assert_eq!(
        app.loki_labels(&id, &start, &end, None).await.unwrap(),
        vec!["container", "namespace", "pod"]
    );
    assert_eq!(
        app.loki_label_values(&id, "pod", &start, &end, Some(r#"{namespace="shop"}"#))
            .await
            .unwrap(),
        vec!["web-7c9d8b6f5-abcde", "web-7c9d8b6f5-x2kqp"]
    );
    assert!(app
        .loki_label_values(&id, "../../api", &start, &end, None)
        .await
        .is_err());

    // Loki's own errors come back verbatim.
    let err = app
        .loki_query_range(&id, &last_hour("syntax error please"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("parse error at line 1"), "{err}");
    assert!(app.loki_query_range(&id, &last_hour("  ")).await.is_err());

    assert!(
        server.log.lock().iter().all(|r| r.method == "GET"),
        "only GETs"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dead_gateway_falls_back_and_vanished_services_are_redetected() {
    let gateway_down = Arc::new(AtomicBool::new(true));
    let read_gone = Arc::new(AtomicBool::new(false));
    let server = start(chart_router(gateway_down.clone(), read_gone.clone())).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let st = app.loki_status(&id, false).await.unwrap();
    assert_eq!(st.state, LokiState::Available, "{st:?}");
    assert_eq!(st.service.unwrap().service, "loki-read");
    assert_eq!(
        st.candidates[0].service, "loki-gateway",
        "ranked first, but dead"
    );

    // The read path disappears too: the query fails and the next status
    // detects again instead of trusting the cached answer.
    read_gone.store(true, Ordering::SeqCst);
    let err = app
        .loki_query_range(&id, &last_hour(r#"{namespace="shop"}"#))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("no endpoints available"), "{err}");
    let st = app.loki_status(&id, false).await.unwrap();
    assert_eq!(count(&server.log, "/api/v1/services"), 2);
    assert_eq!(st.state, LokiState::Unreachable);
    assert!(st.error.unwrap().contains("no endpoints available"));
    let err = app
        .loki_labels(&id, "1", "2", None)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("not reachable"), "{err}");
}

/// Configures the chart's gateway explicitly, with `tenant`.
fn configure_gateway(app: &kubepit_core::Kubepit, id: &str, tenant: Option<&str>) {
    let mut def = app.cluster_def(id).unwrap();
    def.loki = LokiConfig::Service {
        namespace: "loki".into(),
        service: "loki-gateway".into(),
        port: 80,
        scheme: PromScheme::Http,
        path_prefix: String::new(),
        tenant: tenant.unwrap_or_default().into(),
    };
    app.cluster_update(def).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_tenant_reaches_every_loki_request() {
    let server = start(chart_router(Arc::default(), Arc::default())).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);
    configure_gateway(&app, &id, Some(" team-a "));
    app.cluster_connect(&id).await.unwrap();
    let (start_ns, end_ns) = ((END_NS - HOUR_NS).to_string(), END_NS.to_string());
    app.loki_labels(&id, &start_ns, &end_ns, None)
        .await
        .unwrap();
    app.loki_query_range(&id, &last_hour(r#"{namespace="shop"}"#))
        .await
        .unwrap();
    let log = server.log.lock();
    let proxied: Vec<_> = log.iter().filter(|r| r.path.contains("/proxy/")).collect();
    assert!(!proxied.is_empty());
    assert!(
        proxied
            .iter()
            .all(|r| r.header("x-scope-orgid") == Some("team-a")),
        "{proxied:#?}"
    );
    assert!(log
        .iter()
        .filter(|r| !r.path.contains("/proxy/"))
        .all(|r| r.header("x-scope-orgid").is_none()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detected_loki_sends_no_tenant() {
    let server = start(chart_router(Arc::default(), Arc::default())).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let st = app.loki_status(&id, false).await.unwrap();
    assert_eq!(st.state, LokiState::Available, "{st:?}");
    let log = server.log.lock();
    assert!(log.iter().any(|r| r.path.contains("/proxy/")));
    assert!(log.iter().all(|r| r.header("x-scope-orgid").is_none()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_service_off_and_not_found() {
    const CUSTOM: &str = "/api/v1/namespaces/obs/services/https:logs:8443/proxy/loki-api";
    let router: Router = Arc::new(|req: &Request, _log: &Log| {
        let path = req
            .path
            .split_once('?')
            .map_or(req.path.as_str(), |(p, _)| p);
        if let Some(reply) = loki_api(CUSTOM, req) {
            return reply;
        }
        match path {
            "/version" => version(),
            "/api/v1/services" => service_list(vec![service(
                "default",
                "kubernetes",
                json!([{"name": "https", "port": 443}]),
            )]),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    });
    let server = start(router).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);

    let st = app.loki_status(&id, false).await.unwrap();
    assert_eq!(st.state, LokiState::NotFound);
    let err = app
        .loki_query_range(&id, &last_hour("{a=\"b\"}"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("no Loki"), "{err}");

    // A configured service replaces detection (the change invalidates the cache).
    let mut def = app.cluster_def(&id).unwrap();
    def.loki = LokiConfig::Service {
        namespace: " obs ".into(),
        service: "logs".into(),
        port: 8443,
        scheme: PromScheme::Https,
        path_prefix: "loki-api/".into(),
        tenant: " team-a ".into(),
    };
    let saved = app.cluster_update(def).unwrap();
    assert!(
        matches!(&saved.loki, LokiConfig::Service { namespace, path_prefix, tenant, .. }
        if namespace == "obs" && path_prefix == "/loki-api" && tenant == "team-a")
    );
    let listed = count(&server.log, "/api/v1/services");
    let st = app.loki_status(&id, false).await.unwrap();
    assert_eq!(st.state, LokiState::Available, "{st:?}");
    assert_eq!(st.source, Some(LokiSource::Configured));
    assert_eq!(st.service.unwrap().kind, LokiKind::Custom);
    assert_eq!(
        count(&server.log, "/api/v1/services"),
        listed,
        "no detection"
    );
    let result = app
        .loki_query_range(&id, &last_hour(r#"{namespace="shop"}"#))
        .await
        .unwrap();
    assert_eq!(result.lines.len(), 3);

    // Off: no requests at all.
    let mut def = app.cluster_def(&id).unwrap();
    def.loki = LokiConfig::Off;
    app.cluster_update(def).unwrap();
    let before = count(&server.log, "/api/v1/namespaces/obs/");
    assert_eq!(
        app.loki_status(&id, false).await.unwrap().state,
        LokiState::Off
    );
    let err = app
        .loki_query_range(&id, &last_hour("{a=\"b\"}"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("turned off"), "{err}");
    assert_eq!(count(&server.log, "/api/v1/namespaces/obs/"), before);

    // Invalid settings are rejected.
    let mut def = app.cluster_def(&id).unwrap();
    def.loki = LokiConfig::Service {
        namespace: "obs".into(),
        service: "logs".into(),
        port: 8443,
        scheme: PromScheme::Https,
        path_prefix: String::new(),
        tenant: "a|b".into(),
    };
    assert!(app.cluster_update(def).is_err());
}
