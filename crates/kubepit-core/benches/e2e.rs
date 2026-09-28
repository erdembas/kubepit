//! End-to-end benches against the `l` scale fixture served by the
//! in-process fake API server on 127.0.0.1 (never a real cluster; every
//! `Kubepit` lives in a temp dir, so `KUBEPIT_HOME` and `~/.kube` are never
//! read):
//!
//! - `e2e/watch_pods_synced_l`: a cluster-wide pods `resource_watch` until
//!   its first `synced` batch, one freshly connected app per iteration.
//! - `e2e/fleet_search_l`: `fleet_search` for `api` over pods, Deployments,
//!   Services and ConfigMaps until the cluster's final event. Discovery is
//!   cached first (`api_resources`, as the UI does after connecting), so a
//!   search is exactly its 80 list requests. The per-kind limit (20 000) is
//!   above every kind's match count, so every page is read: the spec's risk
//!   is the many-page path, which the UI's 200 would cut after about two
//!   pages per kind.
//! - `e2e/prometheus_query`: `prometheus_query_range` through the service
//!   proxy of a detected `prometheus-operated` answering 100 series.
//!
//! Before the benches, under `cargo bench` only, it writes
//! `target/perf/backend-e2e.json`:
//!
//! - `e2e/max_rss_l_all_watchers` (unix only; missing elsewhere, so the
//!   compare fails rather than passes): peak RSS in bytes of a child
//!   process (this binary again, so the fixture's own memory is not
//!   counted) that connects to `l` with every opt-in background watcher on,
//!   syncs one pods watch and settles for 5 s;
//! - `structural/list_requests_without_limit`: the list-shaped paths that
//!   child requested without `limit=` (`support::perf::unpaged_lists`).

#[path = "../tests/support/mod.rs"]
mod support;

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use criterion::{Criterion, SamplingMode};
use kubepit_core::types::{
    FleetSearchEvent, FleetSearchEventKind, FleetSearchQuery, PrometheusRange,
};
use kubepit_core::Kubepit;
use serde_json::{json, Value};
use support::perf::{gvk, persist_history, pods, scale_setup, unpaged_lists, wait_synced};
use support::scale::{preset, ScaleCluster, ScaleServe};
use support::{start, FakeServer, Reply, Request, Router};
use tokio::runtime::Runtime;

/// Set in the child that measures the backend's peak RSS: the fixture URL.
const RSS_CHILD: &str = "KUBEPIT_PERF_RSS_CHILD_URL";
const OPERATED: &str = "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy";

fn runtime() -> Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A connected app on `url` with no background watcher.
async fn connected(url: &str) -> (tempfile::TempDir, Arc<Kubepit>, String) {
    let (dir, app, id) = scale_setup(url);
    app.cluster_connect(&id).await.unwrap();
    (dir, app, id)
}

// ---------------------------------------------------------------------------
// Peak RSS (child process) and the structural count
// ---------------------------------------------------------------------------

/// `getrusage(RUSAGE_SELF).ru_maxrss` in bytes (it is KiB on Linux).
#[cfg(unix)]
fn max_rss_bytes() -> Option<u64> {
    // SAFETY: getrusage only writes the zero-initialised struct we pass.
    let usage = unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        assert_eq!(libc::getrusage(libc::RUSAGE_SELF, &mut usage), 0);
        usage
    };
    let raw = u64::try_from(usage.ru_maxrss).ok()?;
    Some(if cfg!(any(target_os = "macos", target_os = "ios")) {
        raw
    } else {
        raw * 1024
    })
}

#[cfg(not(unix))]
fn max_rss_bytes() -> Option<u64> {
    None
}

/// The measured child: connect with every opt-in switch on, one pods
/// watch, a 5 s settle; print `rss=<bytes>` (`rss=none` off unix). Only
/// ever the parent's fake server on the loopback interface.
fn rss_child(url: &str) -> ! {
    assert!(
        url.starts_with("http://127.0.0.1:"),
        "{RSS_CHILD} must be the loopback fake server, not {url:?}"
    );
    runtime().block_on(async {
        let (_dir, app, id) = scale_setup(url);
        app.set_alert_monitoring(true);
        app.set_change_journal_recording(true);
        app.set_history_recording(true);
        app.set_metrics_sampling(true);
        persist_history(&app, &id);
        app.cluster_connect(&id).await.unwrap();
        wait_synced(&app, &id, &pods()).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        match max_rss_bytes() {
            Some(bytes) => println!("rss={bytes}"),
            None => println!("rss=none"),
        }
    });
    std::process::exit(0)
}

/// Where Cargo puts build output: `CARGO_TARGET_DIR`, else the directory
/// above `<target>/<profile>/deps/<this binary>`.
fn target_dir() -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            let exe = std::env::current_exe().ok()?;
            exe.ancestors().nth(3).map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("target"))
}

fn backend_report(rt: &Runtime, cluster: &Arc<ScaleCluster>) {
    let server = rt.block_on(start(cluster.clone().router(ScaleServe::default())));
    let output = Command::new(std::env::current_exe().unwrap())
        .env(RSS_CHILD, &server.url)
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()
        .expect("the RSS child runs");
    assert!(output.status.success(), "the RSS child failed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let rss = stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("rss="))
        .unwrap_or_else(|| panic!("the RSS child printed no rss= line: {stdout:?}"));
    let mut report = serde_json::Map::new();
    if rss != "none" {
        let bytes: u64 = rss.parse().expect("rss= carries a byte count");
        report.insert("e2e/max_rss_l_all_watchers".into(), json!(bytes));
    }
    let unpaged = unpaged_lists(&server.log);
    report.insert(
        "structural/list_requests_without_limit".into(),
        json!(unpaged.len()),
    );
    let dir = target_dir().join("perf");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("backend-e2e.json");
    let text = serde_json::to_string_pretty(&Value::Object(report)).unwrap();
    std::fs::write(&path, format!("{text}\n")).unwrap();
    println!(
        "wrote {}: {text}\nunpaged lists: {unpaged:?}",
        path.display()
    );
}

// ---------------------------------------------------------------------------
// Criterion benches
// ---------------------------------------------------------------------------

fn watch_pods_synced(c: &mut Criterion, rt: &Runtime, server: &FakeServer) {
    let url = server.url.clone();
    c.benchmark_group("e2e")
        .sample_size(10)
        .sampling_mode(SamplingMode::Flat)
        .bench_function("watch_pods_synced_l", |b| {
            b.to_async(rt).iter_custom(|iters| {
                let url = url.clone();
                async move {
                    let mut total = Duration::ZERO;
                    for _ in 0..iters {
                        let (_dir, app, id) = connected(&url).await;
                        let start = Instant::now();
                        let watch = wait_synced(&app, &id, &pods()).await;
                        total += start.elapsed();
                        app.resource_unwatch(&watch);
                        app.shutdown().await;
                    }
                    total
                }
            })
        });
}

/// Run one search to the cluster's final event (timed), then to `done`.
async fn search_once(app: &Kubepit, query: FleetSearchQuery) -> (Duration, usize) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<FleetSearchEvent>();
    let start = Instant::now();
    app.fleet_search(query, move |event| tx.send(event).is_ok())
        .unwrap();
    let (mut elapsed, mut hits) = (None, 0);
    loop {
        let event = tokio::time::timeout(Duration::from_secs(30), rx.recv())
            .await
            .expect("the search finishes")
            .expect("the search is running");
        match event.kind {
            FleetSearchEventKind::Results => hits += event.items.len(),
            FleetSearchEventKind::ClusterDone => elapsed = Some(start.elapsed()),
            FleetSearchEventKind::Done => break,
            other => panic!("unexpected {other:?}: {:?}", event.error),
        }
    }
    (elapsed.expect("the cluster finished"), hits)
}

fn fleet_search(c: &mut Criterion, rt: &Runtime, server: &FakeServer, cluster: &ScaleCluster) {
    let (_dir, app, id) = rt.block_on(connected(&server.url));
    // Cache discovery like the UI does after connecting; otherwise every
    // search re-discovers 200 CRD groups.
    rt.block_on(app.api_resources(&id)).unwrap();
    let query = FleetSearchQuery {
        text: "api".into(),
        kinds: vec![
            pods(),
            gvk("apps", "v1", "Deployment", "deployments", true),
            gvk("", "v1", "Service", "services", true),
            gvk("", "v1", "ConfigMap", "configmaps", true),
        ],
        cluster_ids: vec![id],
        namespace: None,
        label_selector: None,
        // Every page is read (a deliberate choice, see the module docs).
        limit_per_kind: cluster.count("/api/v1/pods").unwrap() as u32,
    };
    let before = server.log.lock().len();
    let (_, hits) = rt.block_on(search_once(&app, query.clone()));
    assert_eq!(hits, 4_000 + 1_000 + 1_000 + 2_000, "every api object");
    let requests = server.log.lock().len() - before;
    assert_eq!(
        requests,
        40 + 10 + 10 + 20,
        "only the list pages, no discovery"
    );
    c.benchmark_group("e2e")
        .sample_size(10)
        .sampling_mode(SamplingMode::Flat)
        .bench_function("fleet_search_l", |b| {
            b.to_async(rt).iter_custom(|iters| {
                let (app, query) = (app.clone(), query.clone());
                async move {
                    let mut total = Duration::ZERO;
                    for _ in 0..iters {
                        total += search_once(&app, query.clone()).await.0;
                    }
                    total
                }
            })
        });
}

/// The scale fixture plus a kube-prometheus-stack `prometheus-operated`
/// service (listed on the last services page) whose proxy answers
/// `query_range` with `matrix`.
fn prometheus_router(cluster: Arc<ScaleCluster>, matrix: Value) -> Router {
    let fixture = cluster.router(ScaleServe::default());
    Arc::new(move |req: &Request, log| {
        let path = req.path_only();
        if let Some(api) = path.strip_prefix(OPERATED) {
            return match api {
                "/api/v1/query" => Reply::Json(
                    200,
                    json!({"status": "success",
                           "data": {"resultType": "scalar", "result": [1_700_000_000, "1"]}}),
                ),
                "/api/v1/query_range" => Reply::Json(200, matrix.clone()),
                _ => Reply::Json(404, support::status(404, "NotFound", "not found")),
            };
        }
        match fixture(req, log) {
            Reply::Json(200, mut list)
                if path == "/api/v1/services" && list["metadata"].get("continue").is_none() =>
            {
                list["items"].as_array_mut().unwrap().push(json!({
                    "apiVersion": "v1", "kind": "Service",
                    "metadata": {"name": "prometheus-operated", "namespace": "monitoring",
                                 "uid": "prometheus-operated",
                                 "labels": {"operated-prometheus": "true"}},
                    "spec": {"type": "ClusterIP", "clusterIP": "None",
                             "ports": [{"name": "web", "port": 9090, "targetPort": 9090}]}
                }));
                Reply::Json(200, list)
            }
            reply => reply,
        }
    })
}

/// A `query_range` matrix of 100 pod series × 240 points.
fn matrix_100() -> Value {
    let result: Vec<Value> = (0..100)
        .map(|s| {
            let values: Vec<Value> = (0..240)
                .map(|p| {
                    json!([
                        1_790_000_000 + p * 15,
                        format!("{:.4}", 0.1 + (s * p % 97) as f64 / 100.0)
                    ])
                })
                .collect();
            json!({"metric": {"namespace": "ns-0001", "pod": format!("app-{:04}-api", s + 1)},
                   "values": values})
        })
        .collect();
    json!({"status": "success", "data": {"resultType": "matrix", "result": result}})
}

fn prometheus_query(c: &mut Criterion, rt: &Runtime, cluster: &Arc<ScaleCluster>) {
    let server = rt.block_on(start(prometheus_router(cluster.clone(), matrix_100())));
    let (_dir, app, id) = rt.block_on(connected(&server.url));
    let range = PrometheusRange {
        start: 1_790_000_000_000,
        end: 1_790_003_600_000,
        step: None,
    };
    let query = "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total[5m]))";
    // Detection (listing 5 000 Services, probing) happens once, untimed.
    let first = rt
        .block_on(app.prometheus_query_range(&id, query, &range))
        .unwrap();
    assert_eq!(first.series.len(), 100);
    assert_eq!(first.service.service, "prometheus-operated");
    c.benchmark_group("e2e")
        .sample_size(10)
        .bench_function("prometheus_query", |b| {
            b.to_async(rt).iter(|| async {
                app.prometheus_query_range(&id, query, &range)
                    .await
                    .unwrap()
            })
        });
}

fn main() {
    if let Ok(url) = std::env::var(RSS_CHILD) {
        rss_child(&url);
    }
    let mut criterion = Criterion::default().configure_from_args();
    let rt = runtime();
    let cluster = Arc::new(ScaleCluster::generate(&preset("l")));
    // `cargo bench` passes `--bench`; `cargo test --benches` does not.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--bench") && !args.iter().any(|a| a == "--list") {
        backend_report(&rt, &cluster);
    }
    let server = rt.block_on(start(cluster.clone().router(ScaleServe::default())));
    watch_pods_synced(&mut criterion, &rt, &server);
    fleet_search(&mut criterion, &rt, &server, &cluster);
    prometheus_query(&mut criterion, &rt, &cluster);
    criterion.final_summary();
}
