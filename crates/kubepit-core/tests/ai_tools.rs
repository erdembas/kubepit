//! End-to-end tests of the assistant's read-only tools against the fake API
//! server in `support/` (with a router of its own). No real cluster is
//! involved.

mod support;

use std::sync::Arc;

use kubepit_core::ai::tools::{
    parse_input, tool_specs, PromToolRange, ReadOnlyCluster, ToolInput, DEFAULT_TAIL_LINES,
    MAX_EVENTS, MAX_PROM_QUERY_BYTES, MAX_PROM_SERIES, MAX_TOOL_RESULT_BYTES,
};
use kubepit_core::ai::AiSectionFormat;
use kubepit_core::types::{PromScheme, PrometheusConfig};
use kubepit_core::Kubepit;
use serde_json::{json, Value};
use support::{setup, start, status, FakeServer, Log, Reply, Request, Router};

const PASSWORD_B64: &str = "aHVudGVyMg==";
const PASSWORD: &str = "hunter2";
const SEALED: &str = "AgBy3i4OJSWK+PiTySYZZA==";
const PROM: &str = "/api/v1/namespaces/monitoring/services/http:prometheus:9090/proxy";

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0", "gitCommit": "abc",
               "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn resource(name: &str, kind: &str, namespaced: bool, short: &[&str]) -> Value {
    json!({"name": name, "singularName": "", "namespaced": namespaced, "kind": kind,
           "verbs": ["get", "list", "watch"], "shortNames": short})
}

fn resource_list(group_version: &str, resources: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": "APIResourceList", "groupVersion": group_version, "resources": resources}),
    )
}

fn list(kind: &str, items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": format!("{kind}List"), "apiVersion": "v1",
               "metadata": {"resourceVersion": "100"}, "items": items}),
    )
}

fn pod() -> Value {
    json!({"apiVersion": "v1", "kind": "Pod",
           "metadata": {"name": "web-1", "namespace": "shop", "uid": "uid-web-1",
                        "creationTimestamp": "2024-05-01T10:00:00Z",
                        "managedFields": [{"manager": "kubectl", "operation": "Apply"}],
                        "annotations": {
                            "kubectl.kubernetes.io/last-applied-configuration": "{\"kind\":\"Pod\"}",
                            "team": "checkout"}},
           "spec": {"containers": [{"name": "app", "image": "shop/web:1.4"}]},
           "status": {"phase": "Running", "containerStatuses": [
               {"name": "app", "ready": false, "restartCount": 7,
                "state": {"waiting": {"reason": "CrashLoopBackOff"}}}]}})
}

fn secret() -> Value {
    json!({"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
           "metadata": {"name": "db", "namespace": "shop", "uid": "uid-db",
                        "creationTimestamp": "2024-05-01T10:00:00Z",
                        "labels": {"app": "shop"},
                        "managedFields": [{"manager": "kubectl"}],
                        "annotations": {"kubectl.kubernetes.io/last-applied-configuration":
                            format!("{{\"data\":{{\"PASSWORD\":\"{PASSWORD_B64}\"}}}}")}},
           "data": {"PASSWORD": PASSWORD_B64}, "stringData": {"USER": PASSWORD}})
}

fn sealed_secret() -> Value {
    json!({"apiVersion": "bitnami.com/v1alpha1", "kind": "SealedSecret",
           "metadata": {"name": "db", "namespace": "shop"},
           "spec": {"encryptedData": {"PASSWORD": SEALED}}})
}

fn configmap(name: &str, data: Value) -> Value {
    json!({"apiVersion": "v1", "kind": "ConfigMap",
           "metadata": {"name": name, "namespace": "shop", "uid": format!("uid-{name}"),
                        "creationTimestamp": "2024-05-01T10:00:00Z"},
           "data": data})
}

fn event(uid: &str, kind: &str, reason: &str, last: &str, message: &str) -> Value {
    json!({"apiVersion": "v1", "kind": "Event",
           "metadata": {"name": format!("web-1.{uid}"), "namespace": "shop", "uid": uid},
           "involvedObject": {"kind": "Pod", "name": "web-1", "namespace": "shop"},
           "type": kind, "reason": reason, "message": message, "count": 3,
           "lastTimestamp": last})
}

/// Letters only, so every word gets its own line key.
fn word(mut i: usize) -> String {
    let mut out = String::new();
    loop {
        out.push((b'a' + (i % 26) as u8) as char);
        i /= 26;
        if i == 0 {
            return out;
        }
    }
}

/// 500 timestamped lines: an early error, then groups of three repeated
/// health checks and two distinct lines.
fn pod_log() -> String {
    let mut lines = Vec::new();
    for i in 0..500 {
        let ts = format!("2024-05-01T10:{:02}:{:02}.000000000Z", i / 60 % 60, i % 60);
        let text = match i {
            3 => "level=error msg=\"connection refused\" addr=10.0.0.7:5432".to_string(),
            i if i % 5 < 3 => format!("GET /healthz 200 in {i}ms"),
            i => format!("job {} finished", word(i)),
        };
        lines.push(format!("{ts} {text}"));
    }
    lines.join("\n") + "\n"
}

fn prom_success(result_type: &str, result: Value) -> Reply {
    Reply::Json(
        200,
        json!({"status": "success", "data": {"resultType": result_type, "result": result}}),
    )
}

/// A small cluster with pods, events, Secrets, ConfigMaps, logs, metrics
/// and (behind the service proxy) Prometheus.
fn cluster_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let path = req.path_only();
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/api/v1") => resource_list(
                "v1",
                vec![
                    resource("pods", "Pod", true, &["po"]),
                    resource("pods/log", "Pod", true, &[]),
                    resource("events", "Event", true, &["ev"]),
                    resource("secrets", "Secret", true, &[]),
                    resource("configmaps", "ConfigMap", true, &["cm"]),
                    resource("namespaces", "Namespace", false, &["ns"]),
                    resource("nodes", "Node", false, &["no"]),
                ],
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": [
                    {"name": "apps", "versions": [{"groupVersion": "apps/v1", "version": "v1"}],
                     "preferredVersion": {"groupVersion": "apps/v1", "version": "v1"}},
                    {"name": "bitnami.com", "versions": [{"groupVersion": "bitnami.com/v1alpha1", "version": "v1alpha1"}],
                     "preferredVersion": {"groupVersion": "bitnami.com/v1alpha1", "version": "v1alpha1"}},
                    {"name": "events.k8s.io", "versions": [{"groupVersion": "events.k8s.io/v1", "version": "v1"}],
                     "preferredVersion": {"groupVersion": "events.k8s.io/v1", "version": "v1"}}
                ]}),
            ),
            ("GET", "/apis/apps/v1") => resource_list(
                "apps/v1",
                vec![resource("deployments", "Deployment", true, &["deploy"])],
            ),
            ("GET", "/apis/bitnami.com/v1alpha1") => resource_list(
                "bitnami.com/v1alpha1",
                vec![resource("sealedsecrets", "SealedSecret", true, &[])],
            ),
            ("GET", "/apis/events.k8s.io/v1") => {
                resource_list("events.k8s.io/v1", vec![resource("events", "Event", true, &[])])
            }
            ("GET", "/api/v1/pods") => Reply::Json(
                403,
                status(
                    403,
                    "Forbidden",
                    "pods is forbidden: User \"dev\" cannot list resource \"pods\" in API group \"\" at the cluster scope",
                ),
            ),
            ("GET", "/api/v1/namespaces/shop/pods") => list("Pod", vec![pod()]),
            ("GET", "/api/v1/namespaces/shop/pods/web-1") => Reply::Json(200, pod()),
            ("GET", "/api/v1/namespaces/shop/pods/web-1/log") => Reply::Text(pod_log()),
            ("GET", "/api/v1/namespaces/shop/secrets") => list("Secret", vec![secret()]),
            ("GET", "/api/v1/namespaces/shop/secrets/db") => Reply::Json(200, secret()),
            ("GET", "/apis/bitnami.com/v1alpha1/namespaces/shop/sealedsecrets/db") => {
                Reply::Json(200, sealed_secret())
            }
            ("GET", "/api/v1/namespaces/shop/configmaps") => list(
                "ConfigMap",
                (0..1000)
                    .map(|i| configmap(&format!("cfg-{i:04}"), json!({"k": "v"})))
                    .collect(),
            ),
            ("GET", "/api/v1/namespaces/shop/configmaps/big") => Reply::Json(
                200,
                configmap("big", json!({"notes": "ğüşiöç €".repeat(8_000)})),
            ),
            ("GET", "/api/v1/namespaces/shop/events") | ("GET", "/api/v1/events") => list(
                "Event",
                vec![
                    event("e1", "Normal", "Pulled", "2024-05-01T10:09:00Z", "Pulled image shop/web:1.4"),
                    event("e2", "Warning", "BackOff", "2024-05-01T10:05:00Z",
                          "Back-off restarting failed container app\nin pod web-1"),
                    event("e3", "Warning", "Unhealthy", "2024-05-01T10:07:00Z",
                          "Readiness probe failed: HTTP probe failed with statuscode: 503"),
                ],
            ),
            ("GET", "/apis/apps/v1/namespaces/shop/deployments") => list(
                "Deployment",
                vec![json!({"apiVersion": "apps/v1", "kind": "Deployment",
                            "metadata": {"name": "web", "namespace": "shop"},
                            "spec": {"replicas": 3}, "status": {"readyReplicas": 2}})],
            ),
            ("GET", "/apis/metrics.k8s.io/v1beta1/namespaces/shop/pods")
            | ("GET", "/apis/metrics.k8s.io/v1beta1/pods") => Reply::Json(
                200,
                json!({"kind": "PodMetricsList", "apiVersion": "metrics.k8s.io/v1beta1",
                       "metadata": {}, "items": [
                    {"metadata": {"name": "web-1", "namespace": "shop"},
                     "timestamp": "2024-05-01T10:00:00Z", "window": "30s",
                     "containers": [{"name": "app", "usage": {"cpu": "250m", "memory": "128Mi"}}]},
                    {"metadata": {"name": "web-2", "namespace": "shop"},
                     "timestamp": "2024-05-01T10:00:00Z", "window": "30s",
                     "containers": [{"name": "app", "usage": {"cpu": "5m", "memory": "64Mi"}}]}
                ]}),
            ),
            ("GET", "/apis/metrics.k8s.io/v1beta1/nodes") => Reply::Json(
                200,
                json!({"kind": "NodeMetricsList", "apiVersion": "metrics.k8s.io/v1beta1",
                       "metadata": {}, "items": [
                    {"metadata": {"name": "node-1"}, "timestamp": "2024-05-01T10:00:00Z",
                     "window": "30s", "usage": {"cpu": "1500m", "memory": "4Gi"}}
                ]}),
            ),
            ("GET", p) if p == format!("{PROM}/api/v1/query") => {
                prom_success("scalar", json!([1_700_000_000, "1"]))
            }
            ("GET", p) if p == format!("{PROM}/api/v1/query_range") => prom_success(
                "matrix",
                json!((0..25)
                    .map(|i| json!({"metric": {"pod": format!("web-{i}"), "namespace": "shop"},
                                    "values": [[1_700_000_000, "1"], [1_700_000_015, format!("{i}.5")]]}))
                    .collect::<Vec<_>>()),
            ),
            _ => Reply::Json(404, status(404, "NotFound", "the server could not find the requested resource")),
        }
    })
}

async fn tools_for_fake_cluster() -> (FakeServer, tempfile::TempDir, Arc<Kubepit>, ReadOnlyCluster)
{
    let server = start(cluster_router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, false);
    let tools = ReadOnlyCluster::new(app.clone(), id);
    (server, dir, app, tools)
}

/// Point the cluster at the fake Prometheus behind the service proxy.
fn configure_prometheus(app: &Kubepit, cluster_id: &str) {
    let mut def = app.cluster_def(cluster_id).unwrap();
    def.prometheus = PrometheusConfig::Service {
        namespace: "monitoring".into(),
        service: "prometheus".into(),
        port: 9090,
        scheme: PromScheme::Http,
        path_prefix: String::new(),
    };
    app.cluster_update(def).unwrap();
}

fn list_of(kind: &str) -> ToolInput {
    ToolInput::List {
        kind: kind.into(),
        namespace: Some("shop".into()),
        label_selector: None,
        field_selector: None,
    }
}

fn list_configmaps() -> ToolInput {
    list_of("ConfigMap")
}

fn every_tool_input() -> Vec<ToolInput> {
    vec![
        ToolInput::Events {
            namespace: Some("shop".into()),
            kind: Some("Pod".into()),
            name: Some("web-1".into()),
        },
        ToolInput::Metrics {
            namespace: None,
            pod: None,
        },
        ToolInput::PodLogs {
            namespace: "shop".into(),
            pod: "web-1".into(),
            container: None,
            previous: false,
            tail_lines: 100,
        },
        ToolInput::Get {
            kind: "Secret".into(),
            namespace: Some("shop".into()),
            name: "db".into(),
        },
        list_of("pods"),
        ToolInput::Prometheus {
            query: "up".into(),
            range: PromToolRange::M15,
        },
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tools_only_issue_get_requests() {
    let (server, _dir, app, tools) = tools_for_fake_cluster().await;
    configure_prometheus(&app, tools.cluster_id());
    for input in every_tool_input() {
        let out = tools.execute(&input).await;
        assert!(!out.is_error, "{}: {}", input.name(), out.text);
    }
    let log = server.log.lock();
    assert!(log.len() > 6);
    assert!(log.iter().all(|r| r.method == "GET"), "{log:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_values_never_appear_in_tool_results() {
    let (_server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let get = tools
        .execute(&ToolInput::Get {
            kind: "Secret".into(),
            namespace: Some("shop".into()),
            name: "db".into(),
        })
        .await;
    let by_plural = tools
        .execute(&ToolInput::Get {
            kind: "secrets".into(),
            namespace: Some("shop".into()),
            name: "db".into(),
        })
        .await;
    let list = tools.execute(&list_of("Secret")).await;
    let sealed = tools
        .execute(&ToolInput::Get {
            kind: "SealedSecret".into(),
            namespace: Some("shop".into()),
            name: "db".into(),
        })
        .await;
    for out in [&get, &by_plural, &list, &sealed] {
        assert!(!out.is_error, "{}", out.text);
        for leak in [PASSWORD_B64, PASSWORD, SEALED, "last-applied"] {
            assert!(!out.text.contains(leak), "{leak} in {}", out.text);
        }
    }
    assert!(get.text.contains("PASSWORD"), "key names stay");
    assert!(get.text.contains("USER"), "stringData key names stay");
    assert!(get.text.contains("app: shop"), "labels stay");
    assert_eq!(get.format, AiSectionFormat::Yaml);
    assert!(sealed.text.contains("PASSWORD"));
    assert!(list.text.contains("db") && list.text.contains("Opaque"));
    assert_eq!(list.format, AiSectionFormat::Text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_resource_drops_managed_fields_and_last_applied() {
    let (_server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let out = tools
        .execute(&ToolInput::Get {
            kind: "po".into(),
            namespace: Some("shop".into()),
            name: "web-1".into(),
        })
        .await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(out.format, AiSectionFormat::Yaml);
    assert!(out.text.contains("name: web-1"));
    assert!(out.text.contains("CrashLoopBackOff"), "status is kept");
    assert!(
        out.text.contains("team: checkout"),
        "other annotations stay"
    );
    assert!(!out.text.contains("managedFields"), "{}", out.text);
    assert!(!out.text.contains("last-applied-configuration"));
    let doc: Value = serde_yaml::from_str(&out.text).unwrap();
    assert_eq!(doc["kind"], "Pod");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forbidden_reads_become_tool_errors() {
    let (_server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let out = tools
        .execute(&ToolInput::List {
            kind: "Pod".into(),
            namespace: None,
            label_selector: None,
            field_selector: None,
        })
        .await;
    assert!(out.is_error && out.text.contains("forbidden"), "{out:?}");
    assert_eq!(out.format, AiSectionFormat::Text);
    let missing = tools
        .execute(&ToolInput::Get {
            kind: "ConfigMap".into(),
            namespace: Some("shop".into()),
            name: "nope".into(),
        })
        .await;
    assert!(missing.is_error, "{missing:?}");
    let unknown = tools.execute(&list_of("Widget")).await;
    assert!(
        unknown.is_error && unknown.text.contains("Widget"),
        "{unknown:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pod_logs_are_tailed_and_condensed() {
    let (server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let out = tools
        .execute(&ToolInput::PodLogs {
            namespace: "shop".into(),
            pod: "web-1".into(),
            container: None,
            previous: true,
            tail_lines: 500,
        })
        .await;
    assert!(!out.is_error, "{}", out.text);
    let log = server.log.lock();
    let q = &log.iter().find(|r| r.path.contains("/log")).unwrap().path;
    assert!(
        q.contains("tailLines=500") && q.contains("timestamps=true") && q.contains("previous=true"),
        "{q}"
    );
    assert!(q.contains("limitBytes=1048576"), "{q}");
    assert!(!q.contains("follow=true"), "{q}");
    assert!(
        out.text.lines().count() <= 200,
        "{}",
        out.text.lines().count()
    );
    assert!(out.text.contains("(×"), "{}", out.text);
    assert!(
        out.text.contains("connection refused"),
        "error lines are kept"
    );
    assert!(out.text.contains("job"), "the tail is kept");
    assert!(out
        .text
        .starts_with("Logs of pod shop/web-1, previous instance"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn results_are_capped() {
    let (_server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let out = tools.execute(&list_configmaps()).await; // 1 000 items
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.len() <= MAX_TOOL_RESULT_BYTES && out.text.contains("800 more"));
    assert!(out.text.contains("cfg-0199") && !out.text.contains("cfg-0200"));

    // A huge object of multi-byte text: cut on a character boundary.
    let big = tools
        .execute(&ToolInput::Get {
            kind: "cm".into(),
            namespace: Some("shop".into()),
            name: "big".into(),
        })
        .await;
    assert!(!big.is_error, "{}", big.text);
    assert!(
        big.text.len() <= MAX_TOOL_RESULT_BYTES,
        "{}",
        big.text.len()
    );
    assert!(big.text.ends_with("… truncated"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selectors_travel_as_query_parameters() {
    let (server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let out = tools
        .execute(&ToolInput::List {
            kind: "Pod".into(),
            namespace: Some("shop".into()),
            label_selector: Some("app=web,tier in (a,b)/../../secrets".into()),
            field_selector: Some("status.phase=Running".into()),
        })
        .await;
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.contains("web-1") && out.text.contains("Running 0/1 CrashLoopBackOff"));
    let log = server.log.lock();
    let request = log
        .iter()
        .find(|r| r.path.contains("labelSelector"))
        .expect("the list carries the selector");
    assert_eq!(request.path_only(), "/api/v1/namespaces/shop/pods");
    assert!(
        request
            .path
            .contains("fieldSelector=status.phase%3DRunning"),
        "{}",
        request.path
    );
    assert!(!request.path_only().contains("secrets"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn events_are_warnings_first_and_filtered_by_object() {
    let (server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let out = tools
        .execute(&ToolInput::Events {
            namespace: Some("shop".into()),
            kind: Some("pods".into()),
            name: Some("web-1".into()),
        })
        .await;
    assert!(!out.is_error, "{}", out.text);
    let lines: Vec<&str> = out.text.lines().collect();
    assert!(lines[0].contains("3 (2 Warning)"), "{}", lines[0]);
    assert!(lines[1].starts_with("LAST SEEN"));
    assert!(
        lines[2].contains("Unhealthy"),
        "newest Warning first: {}",
        out.text
    );
    assert!(lines[3].contains("BackOff"));
    assert!(lines[4].contains("Pulled"));
    assert!(
        lines[3].contains("container app in pod web-1"),
        "one line per event"
    );
    assert!(lines.len() <= MAX_EVENTS + 2);
    let log = server.log.lock();
    let request = log
        .iter()
        .find(|r| r.path_only() == "/api/v1/namespaces/shop/events")
        .expect("core events, not events.k8s.io");
    assert!(
        request
            .path
            .contains("fieldSelector=involvedObject.kind%3DPod%2CinvolvedObject.name%3Dweb-1"),
        "{}",
        request.path
    );
    assert!(!log
        .iter()
        .any(|r| r.path.starts_with("/apis/events.k8s.io/v1/")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kinds_resolve_through_discovery() {
    let (server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let out = tools.execute(&list_of("deploy")).await;
    assert!(!out.is_error, "{}", out.text);
    assert!(out
        .text
        .starts_with("Deployment (apps/v1) in namespace shop: 1 objects"));
    assert!(out.text.contains("2/3 ready"));
    let events = tools.execute(&list_of("ev")).await;
    assert!(
        events.text.starts_with("Event (v1)"),
        "core group first: {}",
        events.text
    );
    assert!(server
        .log
        .lock()
        .iter()
        .any(|r| r.path_only() == "/apis/apps/v1/namespaces/shop/deployments"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metrics_cover_nodes_namespaces_and_pods() {
    let (_server, _dir, _app, tools) = tools_for_fake_cluster().await;
    let cluster = tools
        .execute(&ToolInput::Metrics {
            namespace: None,
            pod: None,
        })
        .await;
    assert!(cluster.text.contains("node-1") && cluster.text.contains("1500m"));
    assert!(cluster.text.contains("4096Mi"));
    let busiest = cluster.text.find("web-1").unwrap();
    assert!(
        busiest < cluster.text.find("web-2").unwrap(),
        "sorted by CPU"
    );
    let namespace = tools
        .execute(&ToolInput::Metrics {
            namespace: Some("shop".into()),
            pod: None,
        })
        .await;
    assert!(
        namespace.text.contains("2 pods, CPU 255m"),
        "{}",
        namespace.text
    );
    let pod = tools
        .execute(&ToolInput::Metrics {
            namespace: Some("shop".into()),
            pod: Some("web-1".into()),
        })
        .await;
    assert!(
        pod.text.contains("app") && pod.text.contains("128Mi"),
        "{}",
        pod.text
    );
    let missing = tools
        .execute(&ToolInput::Metrics {
            namespace: Some("shop".into()),
            pod: Some("web-9".into()),
        })
        .await;
    assert!(missing.is_error);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prometheus_queries_need_a_configured_prometheus() {
    let (server, _dir, app, tools) = tools_for_fake_cluster().await;
    let query = ToolInput::Prometheus {
        query: "sum by (pod) (rate(container_cpu_usage_seconds_total[5m]))".into(),
        range: PromToolRange::H1,
    };
    // Turned off: refused without a single proxy request.
    let mut def = app.cluster_def(tools.cluster_id()).unwrap();
    def.prometheus = PrometheusConfig::Off;
    app.cluster_update(def).unwrap();
    assert!(!tools.prometheus_available().await);
    let off = tools.execute(&query).await;
    assert!(off.is_error && off.text.contains("Prometheus"), "{off:?}");
    assert!(!server.log.lock().iter().any(|r| r.path.contains("/proxy")));

    configure_prometheus(&app, tools.cluster_id());
    assert!(tools.prometheus_available().await);
    let out = tools.execute(&query).await;
    assert!(!out.is_error, "{}", out.text);
    assert!(
        out.text.starts_with("PromQL over the last 1h"),
        "{}",
        out.text
    );
    assert!(out.text.contains("25 series"));
    assert!(out.text.contains("5 more series"));
    let summaries = out.text.lines().filter(|l| l.starts_with('{')).count();
    assert_eq!(summaries, MAX_PROM_SERIES);
    assert!(
        out.text.contains("last 1.5, min 1, max 1.5"),
        "{}",
        out.text
    );
    let range = server
        .log
        .lock()
        .iter()
        .find(|r| r.path_only() == format!("{PROM}/api/v1/query_range"))
        .cloned()
        .expect("a range query");
    assert!(range.path.contains("query=sum"), "{}", range.path);
}

#[test]
fn inputs_are_validated_strictly() {
    assert!(parse_input(
        "get_pod_logs",
        &json!({"namespace":"a","pod":"b","tail_lines":501})
    )
    .is_err());
    assert!(parse_input(
        "get_pod_logs",
        &json!({"namespace":"a","pod":"b","tail_lines":0})
    )
    .is_err());
    assert!(parse_input(
        "get_pod_logs",
        &json!({"namespace":"a","pod":"b","tail_lines":-1})
    )
    .is_err());
    assert!(parse_input(
        "get_pod_logs",
        &json!({"namespace":"a","pod":"b","tail_lines":"9"})
    )
    .is_err());
    assert!(parse_input(
        "get_pod_logs",
        &json!({"namespace":"a","pod":"b","previous":"yes"})
    )
    .is_err());
    assert!(parse_input("get_resource", &json!({"kind":"Pod","name":"x","extra":1})).is_err());
    assert!(parse_input("get_pod_logs", &json!({"namespace":"a"})).is_err());
    assert!(parse_input("delete_pod", &json!({})).is_err());
    assert!(parse_input("list_resources", &json!("Pod")).is_err());
    assert!(parse_input("list_resources", &json!({"kind": 3})).is_err());
    assert!(parse_input("query_prometheus", &json!({"query":"up","range":"2h"})).is_err());
    assert!(parse_input("query_prometheus", &json!({"query":"up"})).is_err());
    assert!(parse_input("query_prometheus", &json!({"query":"  ","range":"1h"})).is_err());
    let long = "x".repeat(MAX_PROM_QUERY_BYTES + 1);
    assert!(parse_input("query_prometheus", &json!({"query": long, "range":"1h"})).is_err());

    // Names end up in URL paths: nothing that could address another resource.
    for name in [
        "../secrets/db",
        "a/b",
        "%2e%2e",
        ".",
        "..",
        "a b",
        "x?watch=1",
        "a#b",
    ] {
        let input = json!({"kind": "ConfigMap", "namespace": "shop", "name": name});
        assert!(parse_input("get_resource", &input).is_err(), "{name}");
    }
    for namespace in ["shop/secrets", "Shop", "-a", "a_b", ".."] {
        let input = json!({"namespace": namespace, "pod": "web-1"});
        assert!(parse_input("get_pod_logs", &input).is_err(), "{namespace}");
    }
    assert!(parse_input(
        "get_pod_logs",
        &json!({"namespace":"a","pod":"b","container":"x/y"})
    )
    .is_err());
    assert!(parse_input("list_resources", &json!({"kind": "pods/log"})).is_err());
    let control = json!({"kind": "Pod", "label_selector": "app=web\nrole=db"});
    assert!(parse_input("list_resources", &control).is_err());
    let huge = json!({"kind": "Pod", "label_selector": "a".repeat(2000)});
    assert!(parse_input("list_resources", &huge).is_err());

    // Defaults and normalization.
    assert_eq!(
        parse_input("get_pod_logs", &json!({"namespace":" shop ","pod":"web-1"})).unwrap(),
        ToolInput::PodLogs {
            namespace: "shop".into(),
            pod: "web-1".into(),
            container: None,
            previous: false,
            tail_lines: DEFAULT_TAIL_LINES,
        }
    );
    assert_eq!(
        parse_input(
            "list_resources",
            &json!({"kind":"Pod","namespace":"","label_selector":null})
        )
        .unwrap(),
        ToolInput::List {
            kind: "Pod".into(),
            namespace: None,
            label_selector: None,
            field_selector: None,
        }
    );
    assert_eq!(
        parse_input("query_prometheus", &json!({"query":"up","range":"6h"})).unwrap(),
        ToolInput::Prometheus {
            query: "up".into(),
            range: PromToolRange::H6,
        }
    );
    let rbac = json!({"kind": "clusterroles.rbac.authorization.k8s.io", "name": "system:aggregate-to-admin"});
    assert!(
        parse_input("get_resource", &rbac).is_ok(),
        "colons and groups are fine"
    );
    assert!(parse_input("get_events", &json!({})).is_ok());
    assert!(parse_input("get_metrics", &json!({"pod": "web-1"})).is_ok());
}

#[test]
fn tool_specs_are_sorted_and_closed() {
    let specs = tool_specs(true);
    assert!(specs.windows(2).all(|w| w[0].name < w[1].name));
    assert!(specs
        .iter()
        .all(|s| s.schema["additionalProperties"] == json!(false)));
    assert!(!tool_specs(false)
        .iter()
        .any(|s| s.name == "query_prometheus"));
    let names: Vec<&str> = specs.iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        [
            "get_events",
            "get_metrics",
            "get_pod_logs",
            "get_resource",
            "list_resources",
            "query_prometheus"
        ]
    );
    // Every schema property is accepted by the parser and nothing else is.
    for spec in &specs {
        let props = spec.schema["properties"].as_object().unwrap();
        let required: Vec<&str> = spec.schema["required"]
            .as_array()
            .map(|r| r.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        for field in &required {
            assert!(props.contains_key(*field), "{}: {field}", spec.name);
        }
        assert!(parse_input(spec.name, &json!({"not_a_field": 1})).is_err());
    }
    assert_eq!(specs[2].schema["properties"]["tail_lines"]["maximum"], 500);
    assert_eq!(
        specs[5].schema["properties"]["query"]["maxLength"],
        MAX_PROM_QUERY_BYTES
    );
}
