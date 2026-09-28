//! End-to-end tests of the recommendation engine: the collection pipeline
//! behind `rightsizing_report` (`Kubepit::compute_rightsizing`) against the
//! fake API server and a fake Prometheus behind its service proxy. No real
//! cluster or Prometheus is involved.

mod support;

use std::sync::Arc;

use kubepit_core::prometheus::access::PrometheusAccess;
use kubepit_core::prometheus::usage_history::PodFilter;
use kubepit_core::recommendations::RecommendationSettings;
use kubepit_core::rightsizing::collect::{ScanProgress, SourceAbortKind};
use kubepit_core::rightsizing::{
    Confidence, EvidenceIdentity, RightsizingNoteKind, RightsizingReport, RightsizingRequest,
    RightsizingSettings, RightsizingSource, WorkloadRef,
};
use kubepit_core::types::{PromScheme, PrometheusConfig};
use parking_lot::Mutex;
use serde_json::{json, Value};
use support::stats::{
    duplicated, named_namespaces, param, prom_error, scalar_one, stat_query, vector,
};
use support::{setup, start, status, Log, Reply, Request, Router};

const OPERATED: &str = "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy";
const MIB: f64 = 1024.0 * 1024.0;
const DAY: i64 = 86_400;
/// KubeFit's rollout: the old ReplicaSet's pod ran the first half of the
/// day, the new one's the second half.
const OLD: &str = "api-5d8f7c9b6-q7x2m";
const NEW: &str = "api-7f9c8d6e5-k4p8z";
const OLD_RS: &str = "api-5d8f7c9b6";
const NEW_RS: &str = "api-7f9c8d6e5";

/// What the fake cluster and its Prometheus hold. Every namespace has the
/// Deployment `api` (2 replicas, container `api`) and its two pods.
#[derive(Clone)]
struct Fixture {
    namespaces: Vec<&'static str>,
    /// kube-state-metrics series exist (Q8–Q14).
    ksm: bool,
    /// The CPU average (Q3) fails: the batch is partial.
    partial: bool,
    /// CPU samples cover two thirds of the running samples.
    gaps: bool,
    /// An HPA scales the Deployment on 70 % CPU.
    hpa: bool,
    /// The new pod was OOM-killed.
    oom: bool,
    /// Throttled CFS periods, in % of the periods (1,000 per pod).
    throttled_percent: f64,
    /// The old pod's name is also owned by the StatefulSet `api-old-set`.
    ambiguous: bool,
    /// A bare pod whose owner is `<none>`.
    none_owners: bool,
    /// The new pod's CPU p95 (millicores); the old pod's is 80 % of it.
    cpu_p95: f64,
    cpu_request: &'static str,
    cpu_limit: Option<&'static str>,
    /// Q1 fails whenever its selector names this namespace (or none).
    fail_q1_for: Option<&'static str>,
    /// Cluster-wide lists are forbidden.
    restricted: bool,
}

fn base() -> Fixture {
    Fixture {
        namespaces: vec!["apps"],
        ksm: true,
        partial: false,
        gaps: false,
        hpa: false,
        oom: false,
        throttled_percent: 0.0,
        ambiguous: false,
        none_owners: false,
        cpu_p95: 100.0,
        cpu_request: "500m",
        cpu_limit: None,
        fail_q1_for: None,
        restricted: false,
    }
}

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

fn prometheus_service() -> Value {
    json!({"metadata": {"name": "prometheus-operated", "namespace": "monitoring",
                        "labels": {"operated-prometheus": "true"}},
           "spec": {"ports": [{"name": "web", "port": 9090}]}})
}

fn deployment(ns: &str, f: &Fixture) -> Value {
    let mut resources = json!({"requests": {"cpu": f.cpu_request, "memory": "512Mi"},
                               "limits": {"memory": "512Mi"}});
    if let Some(limit) = f.cpu_limit {
        resources["limits"]["cpu"] = json!(limit);
    }
    json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": "api", "namespace": ns, "uid": format!("uid-api-{ns}"), "resourceVersion": "7"},
        "spec": {"replicas": 2, "selector": {"matchLabels": {"app": "api"}},
                 "template": {"metadata": {"labels": {"app": "api"}}, "spec": {"containers": [
                     {"name": "api", "image": "api:2", "resources": resources}
                 ]}}}
    })
}

fn statefulset(ns: &str, name: &str) -> Value {
    json!({
        "apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": {"name": name, "namespace": ns, "uid": format!("uid-{name}")},
        "spec": {"replicas": 1, "serviceName": name, "selector": {"matchLabels": {"app": name}},
                 "template": {"metadata": {"labels": {"app": name}}, "spec": {"containers": [
                     {"name": "db", "image": "db:1",
                      "resources": {"requests": {"cpu": "1", "memory": "1Gi"}}}
                 ]}}}
    })
}

fn hpa(ns: &str) -> Value {
    json!({
        "apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler",
        "metadata": {"name": "api", "namespace": ns},
        "spec": {"scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": "api"},
                 "minReplicas": 2, "maxReplicas": 6,
                 "metrics": [{"type": "Resource", "resource": {"name": "cpu",
                              "target": {"type": "Utilization", "averageUtilization": 70}}}]}
    })
}

/// The objects of one list endpoint (`resource` = the plural) in `ns`.
fn objects(f: &Fixture, resource: &str, ns: &str) -> Vec<Value> {
    if !f.namespaces.contains(&ns) {
        return Vec::new();
    }
    match resource {
        "deployments" => vec![deployment(ns, f)],
        "statefulsets" if f.ambiguous => vec![statefulset(ns, "api-old-set")],
        "horizontalpodautoscalers" if f.hpa => vec![hpa(ns)],
        _ => Vec::new(),
    }
}

/// The series of statistics query `n` for the pods of `ns` (`None` = the
/// query fails), evaluated at `end`.
fn answer(n: u8, ns: &str, f: &Fixture, end: i64) -> Option<Vec<(Value, f64)>> {
    let c = |pod: &str| json!({"namespace": ns, "pod": pod, "container": "api"});
    let p = |pod: &str| json!({"namespace": ns, "pod": pod});
    let owner = |pod: &str, kind: &str, name: &str| json!({"namespace": ns, "pod": pod, "owner_kind": kind, "owner_name": name});
    let both = |old: f64, new: f64| vec![(c(OLD), old), (c(NEW), new)];
    let cpu_samples = if f.gaps { 96.0 } else { 144.0 };
    Some(match n {
        1 => both(f.cpu_p95 * 0.8, f.cpu_p95),
        2 => both(f.cpu_p95, f.cpu_p95 * 1.5),
        3 if f.partial => return None,
        3 => both(40.0, 50.0),
        4 => both(cpu_samples, cpu_samples),
        5 => both(90.0 * MIB, 100.0 * MIB),
        6 => both(70.0 * MIB, 80.0 * MIB),
        7 => both(144.0, 144.0),
        8..=14 if !f.ksm => Vec::new(),
        8 => both(144.0, 144.0),
        9 => vec![
            (p(OLD), (end - DAY) as f64),
            (p(NEW), (end - DAY / 2) as f64),
        ],
        10 => vec![
            (p(OLD), (end - DAY / 2 - 300) as f64),
            (p(NEW), (end - 300) as f64),
        ],
        11 => {
            let mut owners = vec![
                (owner(OLD, "ReplicaSet", OLD_RS), 1.0),
                (owner(NEW, "ReplicaSet", NEW_RS), 1.0),
            ];
            if f.ambiguous {
                owners.push((owner(OLD, "StatefulSet", "api-old-set"), 1.0));
            }
            if f.none_owners {
                owners.push((owner("debug", "<none>", "<none>"), 1.0));
            }
            owners
        }
        12 => [OLD_RS, NEW_RS]
            .iter()
            .map(|rs| {
                (
                    json!({"namespace": ns, "replicaset": rs, "owner_kind": "Deployment",
                           "owner_name": "api"}),
                    1.0,
                )
            })
            .collect(),
        14 if f.oom => vec![(c(NEW), 1.0)],
        15 => both(f.throttled_percent * 10.0, f.throttled_percent * 10.0),
        16 => both(1000.0, 1000.0),
        _ => Vec::new(),
    })
}

fn prometheus(f: &Fixture, req: &Request) -> Reply {
    let q = param(&req.path, "query").unwrap_or_default();
    if q == "1" {
        return scalar_one();
    }
    let Some(n) = stat_query(&q) else {
        return vector(Vec::new());
    };
    let scope = named_namespaces(&q);
    let named = |ns: &str| scope.as_ref().is_none_or(|s| s.iter().any(|x| x == ns));
    if let (1, Some(bad)) = (n, f.fail_q1_for) {
        if named(bad) {
            return prom_error("query processing would load too many samples into memory");
        }
    }
    let end: i64 = param(&req.path, "time")
        .and_then(|t| t.parse().ok())
        .unwrap_or(0);
    let mut series = Vec::new();
    for ns in f.namespaces.iter().filter(|ns| named(ns)) {
        match answer(n, ns, f, end) {
            Some(list) => series.extend(list),
            None => return prom_error("query timed out"),
        }
    }
    vector(duplicated(series))
}

/// One aggregated series over the requested range: a sample every step,
/// with a gap in the middle (a missing step stays missing).
fn usage_range(req: &Request) -> Reply {
    let number = |key: &str| {
        param(&req.path, key)
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
    };
    let (start, end, step) = (number("start"), number("end"), number("step").max(1));
    let values: Vec<Value> = (0..)
        .map(|i| start + i * step)
        .take_while(|t| *t <= end)
        .enumerate()
        .filter(|(i, _)| *i != 3)
        .map(|(i, t)| json!([t, format!("{}", 100 + i)]))
        .collect();
    Reply::Json(
        200,
        json!({"status": "success", "data": {"resultType": "matrix",
               "result": [{"metric": {}, "values": values}]}}),
    )
}

/// The fake API server of `f`, with kube-prometheus-stack's Prometheus.
fn kubefit_router(f: Fixture) -> Router {
    Arc::new(move |req: &Request, _log: &Log| {
        let path = req.path_only();
        if path == "/version" {
            return version();
        }
        if path == format!("{OPERATED}/api/v1/query") {
            return prometheus(&f, req);
        }
        if path == format!("{OPERATED}/api/v1/query_range") {
            return usage_range(req);
        }
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        // `/api/v1/<resource>` or `/apis/<group>/<version>/<resource>`.
        let cluster_wide = match segments.as_slice() {
            ["api", "v1", resource] | ["apis", _, _, resource] => Some(*resource),
            _ => None,
        };
        if let Some(resource) = cluster_wide {
            if f.restricted {
                return Reply::Json(
                    403,
                    status(403, "Forbidden", "cluster-wide lists are forbidden"),
                );
            }
            let items: Vec<Value> = match resource {
                "services" => vec![prometheus_service()],
                _ => f
                    .namespaces
                    .iter()
                    .flat_map(|ns| objects(&f, resource, ns))
                    .collect(),
            };
            return list("List", items);
        }
        match segments.as_slice() {
            ["api", "v1", "namespaces", ns, resource]
            | ["apis", _, _, "namespaces", ns, resource] => list("List", objects(&f, resource, ns)),
            ["apis", "apps", "v1", "namespaces", ns, "deployments", "api"]
                if f.namespaces.contains(ns) =>
            {
                Reply::Json(200, deployment(ns, &f))
            }
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

/// One day of history, with workload-history's 20 % headroom.
fn one_day() -> RightsizingRequest {
    RightsizingRequest {
        settings: Some(RightsizingSettings {
            days: 1,
            cpu_headroom_percent: 20.0,
            memory_headroom_percent: 20.0,
            ..RightsizingSettings::default()
        }),
        ..Default::default()
    }
}

struct Scan {
    report: RightsizingReport,
    abort: Option<kubepit_core::rightsizing::collect::SourceAbort>,
    progress: Vec<ScanProgress>,
    log: Log,
}

async fn scan_with(f: Fixture, request: RightsizingRequest) -> anyhow::Result<Scan> {
    let server = start(kubefit_router(f.clone())).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    if f.restricted {
        // Services cannot be listed cluster-wide: the service is configured.
        let mut def = app.cluster_def(&id).unwrap();
        def.prometheus = PrometheusConfig::Service {
            namespace: "monitoring".into(),
            service: "prometheus-operated".into(),
            port: 9090,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        app.cluster_update(def).unwrap();
    }
    let progress = Mutex::new(Vec::new());
    let record_progress = |p: ScanProgress| progress.lock().push(p);
    let outcome = app
        .compute_rightsizing(&id, &request, &record_progress)
        .await?;
    Ok(Scan {
        report: outcome.report,
        abort: outcome.source_abort,
        progress: progress.into_inner(),
        log: server.log,
    })
}

async fn scan(f: Fixture) -> RightsizingReport {
    let scan = scan_with(f, one_day()).await.unwrap();
    assert_eq!(scan.abort, None, "{:?}", scan.report.notes);
    scan.report
}

/// Completed never goes back, the total only grows, and the last report
/// has every planned query answered.
fn progress_is_monotonic_and_complete(progress: &[ScanProgress]) -> bool {
    let last = progress.last().copied().unwrap_or_default();
    progress
        .windows(2)
        .all(|w| w[1].completed >= w[0].completed && w[1].total >= w[0].total)
        && last.total > 0
        && last.completed == last.total
}

/// The decoded queries sent to Prometheus, without the probe.
fn queries(log: &Log) -> Vec<String> {
    log.lock()
        .iter()
        .filter(|r| r.path.starts_with(OPERATED))
        .filter_map(|r| param(&r.path, "query"))
        .filter(|q| q != "1")
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kubefit_rollout_fixture_becomes_one_deployment_row() {
    let Scan {
        report, progress, ..
    } = scan_with(base(), one_day()).await.unwrap();
    assert_eq!(
        (report.strategy.as_str(), report.strategy_auto),
        ("workload-history", true)
    );
    assert_eq!(
        report.source,
        RightsizingSource::Prometheus,
        "{:?}",
        report.notes
    );
    assert_eq!(report.window_secs, 86_400);
    assert_eq!(report.window_end % 300_000, 0, "aligned to 5 minutes");
    let api = &report.workloads[0];
    assert_eq!(
        (api.kind.as_str(), api.name.as_str(), report.workloads.len()),
        ("Deployment", "api", 1)
    );
    let c = &api.containers[0];
    assert_eq!(
        (c.recommended.cpu_request, c.recommended.memory_request),
        (Some(120.0), Some(120.0 * MIB))
    );
    // The folded evidence reached the row: both pods, the whole day.
    let e = c.evidence.as_ref().unwrap();
    assert_eq!(e.cpu_coverage, Some(1.0));
    assert_eq!((e.observed_hours, e.pods, e.duty), (24.0, 2, Some(1.0)));
    assert_eq!(e.identity, EvidenceIdentity::OwnerMetrics);
    assert_eq!(api.pods, vec![OLD, NEW]);
    assert_eq!(api.cost_replicas, 2.0);
    assert!(report.notes.is_empty(), "{:?}", report.notes);
    assert!(
        progress_is_monotonic_and_complete(&progress),
        "{progress:?}"
    );
    let last = progress.last().unwrap();
    assert_eq!((last.total, last.workloads), (16, 1));

    // One workload: its pods only.
    let one = RightsizingRequest {
        workload: Some(WorkloadRef {
            kind: "Deployment".into(),
            namespace: "apps".into(),
            name: "api".into(),
        }),
        ..one_day()
    };
    let Scan { report, log, .. } = scan_with(base(), one).await.unwrap();
    assert_eq!(report.workloads.len(), 1);
    let sent = queries(&log);
    assert_eq!(sent.len(), 16);
    let pods = r#"pod=~"api-[a-z0-9]+-[a-z0-9]+""#;
    assert!(
        sent.iter()
            .filter(|q| !q.contains("kube_replicaset_owner") && !q.contains("kube_job_owner"))
            .all(|q| q.contains(pods)),
        "{sent:#?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flags_lower_confidence_but_never_block() {
    for (fixture, code, cap) in [
        (
            Fixture {
                partial: true,
                ..base()
            },
            "partial-data",
            Confidence::Medium,
        ),
        (
            Fixture {
                gaps: true,
                ..base()
            },
            "low-coverage",
            Confidence::Low,
        ),
        (
            Fixture {
                hpa: true,
                ..base()
            },
            "hpa-target",
            Confidence::Medium,
        ),
        (
            Fixture {
                oom: true,
                ..base()
            },
            "oom-killed",
            Confidence::Medium,
        ),
        (
            Fixture {
                throttled_percent: 10.0,
                ..base()
            },
            "cpu-throttled",
            Confidence::Medium,
        ),
        // Ambiguous: the name of the old pod is also owned by the
        // StatefulSet api-old-set; the new pod is clean.
        (
            Fixture {
                ambiguous: true,
                ..base()
            },
            "identity-unclear",
            Confidence::Low,
        ),
    ] {
        let report = scan(fixture).await;
        let api = report.workloads.iter().find(|w| w.name == "api").unwrap();
        let c = &api.containers[0];
        assert!(
            c.usage.is_some() && c.recommended.cpu_request != c.current.cpu_request,
            "{code}: computed, never blocked"
        );
        assert!(
            c.warnings.iter().any(|w| w.code == code) && c.confidence <= cap,
            "{code}: {:?} {:?}",
            c.warnings,
            c.confidence
        );
        match code {
            "partial-data" => assert!(report.notes.iter().any(|n| {
                n.kind == RightsizingNoteKind::PartialData && n.detail.as_deref() == Some("cpu_avg")
            })),
            "hpa-target" => assert_eq!(api.hpa.as_ref().unwrap().name, "api"),
            "oom-killed" => assert_eq!(api.verdict, kubepit_core::rightsizing::Verdict::Under),
            "identity-unclear" => {
                // Every live candidate is flagged, even without usage.
                let set = report
                    .workloads
                    .iter()
                    .find(|w| w.name == "api-old-set")
                    .unwrap();
                assert!(set.containers[0]
                    .warnings
                    .iter()
                    .any(|w| w.code == "identity-unclear"));
            }
            _ => {}
        }
    }
    let report = scan(Fixture {
        none_owners: true,
        ..base()
    })
    .await;
    assert!(report.workloads.iter().all(|w| w.name != "<none>"));
    assert_eq!(report.workloads.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_above_the_limit_raises_it_proportionally() {
    // CPU p95 2 cores against a 1-core request and a 1-core limit:
    // + 20 % → 2400m, and the limit keeps the 1:1 ratio.
    let report = scan(Fixture {
        cpu_p95: 2000.0,
        cpu_request: "1",
        cpu_limit: Some("1"),
        ..base()
    })
    .await;
    let c = &report.workloads[0].containers[0];
    assert_eq!(
        (
            c.recommended.cpu_request,
            c.recommended.cpu_limit,
            c.cpu_limit_raised
        ),
        (Some(2400.0), Some(2400.0), true)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_kube_state_metrics_pods_match_by_name() {
    let report = scan(Fixture {
        ksm: false,
        ..base()
    })
    .await;
    assert_eq!(
        (report.strategy.as_str(), report.strategy_auto),
        ("percentile-headroom", true)
    );
    assert!(report
        .notes
        .iter()
        .any(|n| n.kind == RightsizingNoteKind::OwnershipUnavailable));
    let c = &report.workloads[0].containers[0];
    assert_eq!(c.usage.unwrap().cpu_p95, 100.0, "matched by name");
    assert!(c.warnings.iter().any(|w| w.code == "identity-by-name"));
    assert_eq!(
        c.evidence.as_ref().unwrap().identity,
        EvidenceIdentity::NameMatch
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_batches_split_down_to_namespaces() {
    // Q1 fails whenever the selector names "b" (alone or together); "a"
    // answers: rows for a, a NamespaceFailed note for b.
    let Scan {
        report,
        progress,
        log,
        ..
    } = scan_with(
        Fixture {
            namespaces: vec!["a", "b"],
            fail_q1_for: Some("b"),
            ..base()
        },
        one_day(),
    )
    .await
    .unwrap();
    assert!(
        report.notes.iter().any(|n| {
            n.kind == RightsizingNoteKind::NamespaceFailed && n.detail.as_deref() == Some("b")
        }),
        "{:?}",
        report.notes
    );
    let row = |ns: &str| report.workloads.iter().find(|w| w.namespace == ns).unwrap();
    assert!(row("a").containers[0].usage.is_some());
    assert!(row("b").containers[0].usage.is_none());
    assert_eq!(progress.last().unwrap().total, 3 * 16, "a|b, then a and b");
    assert!(progress_is_monotonic_and_complete(&progress));
    let p95: Vec<String> = queries(&log)
        .into_iter()
        .filter(|q| q.starts_with("quantile_over_time"))
        .collect();
    assert_eq!(p95.len(), 3);
    assert!(p95[0].contains(r#"namespace=~"a|b""#), "{p95:#?}");

    // When no batch succeeds the collection is abandoned, typed: the live
    // report falls back with the note, a scan would fail.
    let failed = scan_with(
        Fixture {
            namespaces: vec!["b"],
            fail_q1_for: Some("b"),
            ..base()
        },
        one_day(),
    )
    .await
    .unwrap();
    let abort = failed.abort.expect("no batch succeeded");
    assert_eq!(abort.kind, SourceAbortKind::AllBatchesFailed);
    assert!(
        abort.detail.contains("too many samples"),
        "{}",
        abort.detail
    );
    assert_ne!(failed.report.source, RightsizingSource::Prometheus);
    assert!(failed.report.notes.iter().any(|n| {
        n.kind == RightsizingNoteKind::PrometheusFailed
            && n.detail.as_deref() == Some(&abort.detail)
    }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_clusters_scan_their_accessible_namespaces() {
    // 403 on cluster-wide lists; setup's accessible namespaces team-a and
    // team-b each hold a Deployment.
    let Scan { report, log, .. } = scan_with(
        Fixture {
            namespaces: vec!["team-a", "team-b"],
            restricted: true,
            ..base()
        },
        one_day(),
    )
    .await
    .unwrap();
    let sent = queries(&log);
    assert_eq!(sent.len(), 16);
    assert!(
        sent.iter()
            .all(|q| q.contains(r#"namespace=~"team-a|team-b""#)),
        "{sent:#?}"
    );
    assert_eq!(report.workloads.len(), 2);
    assert!(report
        .workloads
        .iter()
        .all(|w| w.containers[0].usage.is_some()));
    assert_eq!(report.source, RightsizingSource::Prometheus);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_per_strategy_window_is_collected_again() {
    // No kube-state-metrics, so percentile-headroom is chosen after the
    // collection; its saved override keeps 3 days while workload-history
    // (the choice with owner metrics, collected first) keeps its 7.
    let server = start(kubefit_router(Fixture {
        ksm: false,
        ..base()
    }))
    .await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    let mut settings = app.settings();
    settings.recommendations = RecommendationSettings {
        overrides: [(
            "percentile-headroom".into(),
            RightsizingSettings {
                days: 3,
                ..RightsizingSettings::default()
            },
        )]
        .into(),
        ..RecommendationSettings::default()
    };
    app.set_settings(settings).unwrap();

    let progress = Mutex::new(Vec::new());
    let record_progress = |p: ScanProgress| progress.lock().push(p);
    let report = app
        .compute_rightsizing(&id, &RightsizingRequest::default(), &record_progress)
        .await
        .unwrap()
        .report;
    assert_eq!(
        (report.strategy.as_str(), report.strategy_auto),
        ("percentile-headroom", true)
    );
    assert_eq!((report.settings.days, report.window_secs), (3, 3 * 86_400));
    let p95: Vec<String> = queries(&server.log)
        .into_iter()
        .filter(|q| q.starts_with("quantile_over_time"))
        .collect();
    assert_eq!(p95.len(), 2, "{p95:#?}");
    assert!(p95[0].contains("[7d:5m]") && p95[1].contains("[3d:5m]"));
    let progress = progress.into_inner();
    assert!(progress_is_monotonic_and_complete(&progress));
    assert_eq!(progress.last().unwrap().total, 2 * 16);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_history_reads_four_range_queries() {
    let server = start(kubefit_router(base())).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);
    // A shared, multi-tenant Prometheus: the one transport adds both.
    let mut def = app.cluster_def(&id).unwrap();
    def.prometheus_access = PrometheusAccess {
        tenant: "team-a".into(),
        cluster_labels: [("cluster".to_string(), "prod".to_string())].into(),
        ..Default::default()
    };
    app.cluster_update(def).unwrap();
    let api = WorkloadRef {
        kind: "Deployment".into(),
        namespace: "apps".into(),
        name: "api".into(),
    };

    let h = app
        .recommendations_usage_history(&id, &api, "api", &[OLD.into(), NEW.into()], None)
        .await
        .unwrap();
    let ranges: Vec<Request> = server
        .log
        .lock()
        .iter()
        .filter(|r| r.path_only().ends_with("/api/v1/query_range"))
        .cloned()
        .collect();
    assert_eq!(
        (h.step_secs, !h.cpu_peak.is_empty(), ranges.len()),
        (3600, true, 4)
    );
    assert_eq!(h.pod_filter, PodFilter::Names);
    // Seven days up to the aligned window end; the start is aligned to the step.
    assert_eq!(h.end % 300_000, 0);
    let span = h.end - h.start;
    assert!(
        (7 * DAY * 1000..7 * DAY * 1000 + 3_600_000).contains(&span),
        "{span}"
    );
    for series in [&h.cpu_peak, &h.cpu_avg, &h.memory_peak, &h.memory_avg] {
        // One point per step, and the gap stays a gap.
        assert!(series.windows(2).any(|w| w[1].0 - w[0].0 == 7_200_000));
        assert!(series.iter().all(|(t, _)| *t >= h.start && *t <= h.end));
    }
    for request in &ranges {
        let q = param(&request.path, "query").unwrap();
        assert!(q.contains(r#"cluster="prod""#), "{q}");
        assert!(q.contains(&format!(r#"pod=~"{OLD}|{NEW}""#)), "{q}");
        assert_eq!(request.header("x-scope-orgid"), Some("team-a"));
        assert_eq!(param(&request.path, "step").as_deref(), Some("3600"));
    }

    // Without pod names the workload's pattern selects its pods; the window
    // is clamped to 30 days.
    let h = app
        .recommendations_usage_history(&id, &api, "api", &[], Some(90))
        .await
        .unwrap();
    assert_eq!(h.pod_filter, PodFilter::Pattern);
    assert_eq!(h.step_secs, 10_800);
    let last = server.log.lock().last().cloned().unwrap();
    assert!(param(&last.path, "query")
        .unwrap()
        .contains(r#"pod=~"api-[a-z0-9]+-[a-z0-9]+""#));
    // Pod names are validated before anything is sent.
    let sent = server.log.lock().len();
    assert!(app
        .recommendations_usage_history(&id, &api, "api", &["a|b".into()], None)
        .await
        .is_err());
    assert_eq!(server.log.lock().len(), sent);
}
