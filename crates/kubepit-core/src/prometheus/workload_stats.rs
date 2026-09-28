//! Server-side workload statistics for right-sizing.
//!
//! One batch = 16 instant queries ([`StatQuery`]) over a namespace scope,
//! all evaluated at the same aligned window end ([`window_end`]). Each
//! answers one series per pod-container (or pod, or owner) seen in the
//! window, so the client-side join is over pod names only:
//!
//! - Q1–Q8: CPU p95 / max / average / sample count, memory max / average /
//!   sample count and running samples, from 5-minute subqueries;
//! - Q9–Q10: first and last running timestamp per pod;
//! - Q11–Q13: kube-state-metrics owners of pods, ReplicaSets and Jobs
//!   ([`crate::rightsizing::ownership`]);
//! - Q14–Q16: OOM kills and CFS throttled / total periods.
//!
//! Every aggregation is `max by (…)`, which collapses duplicate scrapes.
//! Q1 and Q5 are required: when either fails (or answers more than
//! [`MAX_SCAN_SERIES`] series) the batch is [`BatchFailure::Splittable`]
//! and the caller retries smaller scopes. The others only refine: their
//! failures are recorded in [`StatsBatch::failed`]. A proxy or tunnel
//! failure means Prometheus is gone ([`BatchFailure::Proxy`]). Read-only
//! like the rest.

use std::collections::{BTreeMap, HashMap};

use futures::stream::{self, StreamExt};

use super::parse::PromData;
use super::promql::{quote, regex_escape};
use super::tunnel::is_tunnel_failure;
use super::usage::{instant_params, MAX_NAMESPACE_MATCHERS, USAGE_TIMEOUT};
use super::Origin;
use crate::app::Kubepit;
use crate::rightsizing::ownership::OwnerIndex;
use crate::service_proxy::is_proxy_failure;

/// Series one statistics answer may hold before the batch is split.
pub const MAX_SCAN_SERIES: usize = 50_000;
/// Statistics queries in flight per batch.
pub const QUERIES_IN_FLIGHT: usize = 4;
/// Subquery resolution and window-end alignment, in seconds.
pub const STEP_SECS: i64 = 300;

/// cAdvisor series of real containers (not the pod cgroup nor the pause container).
const CONTAINERS: &str = r#"container!="",container!="POD""#;

/// The queries of one batch, in the order of the spec's table (Q1–Q16).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StatQuery {
    CpuP95,
    CpuMax,
    CpuAvg,
    CpuSamples,
    MemoryMax,
    MemoryAvg,
    MemorySamples,
    Running,
    FirstSeen,
    LastSeen,
    PodOwners,
    ReplicasetOwners,
    JobOwners,
    Oom,
    Throttled,
    Periods,
}

impl StatQuery {
    pub const ALL: [StatQuery; 16] = [
        StatQuery::CpuP95,
        StatQuery::CpuMax,
        StatQuery::CpuAvg,
        StatQuery::CpuSamples,
        StatQuery::MemoryMax,
        StatQuery::MemoryAvg,
        StatQuery::MemorySamples,
        StatQuery::Running,
        StatQuery::FirstSeen,
        StatQuery::LastSeen,
        StatQuery::PodOwners,
        StatQuery::ReplicasetOwners,
        StatQuery::JobOwners,
        StatQuery::Oom,
        StatQuery::Throttled,
        StatQuery::Periods,
    ];

    /// Stable snake_case name (scan notes name failed queries with it).
    pub fn name(self) -> &'static str {
        match self {
            StatQuery::CpuP95 => "cpu_p95",
            StatQuery::CpuMax => "cpu_max",
            StatQuery::CpuAvg => "cpu_avg",
            StatQuery::CpuSamples => "cpu_samples",
            StatQuery::MemoryMax => "memory_max",
            StatQuery::MemoryAvg => "memory_avg",
            StatQuery::MemorySamples => "memory_samples",
            StatQuery::Running => "running",
            StatQuery::FirstSeen => "first_seen",
            StatQuery::LastSeen => "last_seen",
            StatQuery::PodOwners => "pod_owners",
            StatQuery::ReplicasetOwners => "replicaset_owners",
            StatQuery::JobOwners => "job_owners",
            StatQuery::Oom => "oom",
            StatQuery::Throttled => "throttled",
            StatQuery::Periods => "periods",
        }
    }

    /// Without CPU p95 and memory max a batch has nothing to recommend from.
    pub fn is_required(self) -> bool {
        matches!(self, StatQuery::CpuP95 | StatQuery::MemoryMax)
    }
}

/// What one batch covers.
#[derive(Debug, Clone, PartialEq)]
pub struct StatScope {
    /// Namespaces of the batch; empty = the whole cluster.
    pub namespaces: Vec<String>,
    /// Pod-name regex of a single-workload request.
    pub pod_regex: Option<String>,
    /// History window in days.
    pub days: u32,
    /// Evaluation time of every query (epoch seconds, see [`window_end`]).
    pub end_secs: i64,
}

/// The window end for `now_ms`: epoch seconds, floored to 5 minutes, so
/// every query of a scan sees the same subquery steps.
pub fn window_end(now_ms: i64) -> i64 {
    now_ms.div_euclid(1000).div_euclid(STEP_SECS) * STEP_SECS
}

/// `namespace=~"a|b"` for the scope, or nothing for the whole cluster
/// (no namespaces, or more than [`MAX_NAMESPACE_MATCHERS`]).
fn namespace_matcher(scope: &StatScope) -> Option<String> {
    if scope.namespaces.is_empty() || scope.namespaces.len() > MAX_NAMESPACE_MATCHERS {
        return None;
    }
    let mut names: Vec<String> = scope.namespaces.iter().map(|n| regex_escape(n)).collect();
    names.sort();
    names.dedup();
    Some(format!("namespace=~{}", quote(&names.join("|"))))
}

fn pod_matcher(scope: &StatScope) -> Option<String> {
    scope
        .pod_regex
        .as_ref()
        .map(|regex| format!("pod=~{}", quote(regex)))
}

fn matchers<'a>(parts: impl IntoIterator<Item = Option<&'a str>>) -> String {
    parts.into_iter().flatten().collect::<Vec<_>>().join(",")
}

/// `metric{matchers}`, or the bare metric without matchers.
fn selector(metric: &str, matchers: &str) -> String {
    if matchers.is_empty() {
        metric.to_string()
    } else {
        format!("{metric}{{{matchers}}}")
    }
}

/// The PromQL of `q` for `scope`.
pub fn query(q: StatQuery, scope: &StatScope) -> String {
    let d = scope.days;
    let ns = namespace_matcher(scope);
    let pod = pod_matcher(scope);
    let sel = matchers([Some(CONTAINERS), ns.as_deref(), pod.as_deref()]);
    let ksm = matchers([ns.as_deref(), pod.as_deref()]);
    let ns_only = matchers([ns.as_deref()]);
    let cpu_rate = format!(
        "max by (namespace, pod, container) (rate({}[5m]))",
        selector("container_cpu_usage_seconds_total", &sel)
    );
    let memory = selector("container_memory_working_set_bytes", &sel);
    let running = selector("kube_pod_container_status_running", &ksm);
    let with = |extra: &str| matchers([Some(ksm.as_str()).filter(|m| !m.is_empty()), Some(extra)]);
    match q {
        StatQuery::CpuP95 => format!("quantile_over_time(0.95, ({cpu_rate})[{d}d:5m]) * 1000"),
        StatQuery::CpuMax => format!("max_over_time(({cpu_rate})[{d}d:5m]) * 1000"),
        StatQuery::CpuAvg => format!("avg_over_time(({cpu_rate})[{d}d:5m]) * 1000"),
        StatQuery::CpuSamples => format!("count_over_time(({cpu_rate})[{d}d:5m])"),
        StatQuery::MemoryMax => {
            format!("max by (namespace, pod, container) (max_over_time({memory}[{d}d]))")
        }
        StatQuery::MemoryAvg => {
            format!("max by (namespace, pod, container) (avg_over_time({memory}[{d}d]))")
        }
        StatQuery::MemorySamples => {
            format!("count_over_time((max by (namespace, pod, container) ({memory}))[{d}d:5m])")
        }
        StatQuery::Running => format!(
            "count_over_time((max by (namespace, pod, container) ({running} == 1))[{d}d:5m])"
        ),
        StatQuery::FirstSeen => {
            format!("min_over_time(timestamp(max by (namespace, pod) ({running} == 1))[{d}d:5m])")
        }
        StatQuery::LastSeen => {
            format!("max_over_time(timestamp(max by (namespace, pod) ({running} == 1))[{d}d:5m])")
        }
        StatQuery::PodOwners => format!(
            "max by (namespace, pod, owner_kind, owner_name) (max_over_time({}[{d}d]))",
            selector("kube_pod_owner", &with(r#"owner_is_controller!="false""#))
        ),
        StatQuery::ReplicasetOwners => format!(
            "max by (namespace, replicaset, owner_kind, owner_name) (max_over_time({}[{d}d]))",
            selector("kube_replicaset_owner", &ns_only)
        ),
        StatQuery::JobOwners => format!(
            "max by (namespace, job_name, owner_kind, owner_name) (max_over_time({}[{d}d]))",
            selector("kube_job_owner", &ns_only)
        ),
        StatQuery::Oom => format!(
            "max by (namespace, pod, container) (max_over_time({}[{d}d]))",
            selector(
                "kube_pod_container_status_last_terminated_reason",
                &with(r#"reason="OOMKilled""#)
            )
        ),
        StatQuery::Throttled => format!(
            "max by (namespace, pod, container) (increase({}[{d}d]))",
            selector("container_cpu_cfs_throttled_periods_total", &sel)
        ),
        StatQuery::Periods => format!(
            "max by (namespace, pod, container) (increase({}[{d}d]))",
            selector("container_cpu_cfs_periods_total", &sel)
        ),
    }
}

/// Statistics of one container of one pod name over the window. CPU in
/// millicores, memory in bytes, counts in 5-minute samples or CFS periods.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PodContainerStats {
    pub cpu_p95: Option<f64>,
    pub cpu_max: Option<f64>,
    pub cpu_avg: Option<f64>,
    pub cpu_samples: f64,
    pub memory_max: Option<f64>,
    pub memory_avg: Option<f64>,
    pub memory_samples: f64,
    /// 5-minute steps the container was running.
    pub running: f64,
    /// Its last termination within the window was an OOM kill.
    pub oom: bool,
    pub throttled: f64,
    pub periods: f64,
}

/// First and last running step of a pod name (epoch seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PodSpan {
    pub first_secs: i64,
    pub last_secs: i64,
}

/// The merged answers of one batch.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StatsBatch {
    /// `(namespace, pod, container)` → statistics.
    pub containers: HashMap<(String, String, String), PodContainerStats>,
    /// `(namespace, pod)` → running span.
    pub spans: HashMap<(String, String), PodSpan>,
    pub owners: OwnerIndex,
    /// Prometheus warnings of any answer (the batch is partial).
    pub warnings: Vec<String>,
    /// Refining queries that failed (the batch is partial).
    pub failed: Vec<StatQuery>,
}

/// Why a batch produced nothing.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum BatchFailure {
    /// Prometheus is gone (service proxy 404 / 502 / 503, a tunnel failure)
    /// or not available:
    /// smaller batches would fail the same way.
    #[error("{0}")]
    Proxy(String),
    /// A required query failed or answered too many series: retry with
    /// fewer namespaces.
    #[error("{query}: {message}")]
    Splittable {
        query: &'static str,
        message: String,
    },
}

fn label<'a>(labels: &'a BTreeMap<String, String>, key: &str) -> &'a str {
    labels.get(key).map(String::as_str).unwrap_or_default()
}

fn keep_max(slot: &mut Option<f64>, value: f64) {
    *slot = Some(slot.map_or(value, |v| v.max(value)));
}

fn keep_count(slot: &mut f64, value: f64) {
    *slot = slot.max(value.max(0.0));
}

/// Fold one per-container answer into `containers`: a repeated key (a
/// duplicate scrape) keeps the maximum, negative counts clamp to 0.
fn apply_containers(
    containers: &mut HashMap<(String, String, String), PodContainerStats>,
    q: StatQuery,
    data: &PromData,
) {
    for series in &data.series {
        let (ns, pod, container) = (
            label(&series.labels, "namespace"),
            label(&series.labels, "pod"),
            label(&series.labels, "container"),
        );
        let Some(&(_, value)) = series.points.last() else {
            continue;
        };
        if ns.is_empty() || pod.is_empty() || container.is_empty() {
            continue;
        }
        let s = containers
            .entry((ns.to_string(), pod.to_string(), container.to_string()))
            .or_default();
        match q {
            StatQuery::CpuP95 => keep_max(&mut s.cpu_p95, value),
            StatQuery::CpuMax => keep_max(&mut s.cpu_max, value),
            StatQuery::CpuAvg => keep_max(&mut s.cpu_avg, value),
            StatQuery::CpuSamples => keep_count(&mut s.cpu_samples, value),
            StatQuery::MemoryMax => keep_max(&mut s.memory_max, value),
            StatQuery::MemoryAvg => keep_max(&mut s.memory_avg, value),
            StatQuery::MemorySamples => keep_count(&mut s.memory_samples, value),
            StatQuery::Running => keep_count(&mut s.running, value),
            StatQuery::Oom => s.oom |= value > 0.0,
            StatQuery::Throttled => keep_count(&mut s.throttled, value),
            StatQuery::Periods => keep_count(&mut s.periods, value),
            _ => {}
        }
    }
}

/// `(namespace, pod)` → timestamp of a first / last seen answer; `earliest`
/// picks which duplicate wins.
fn timestamps(data: Option<&PromData>, earliest: bool) -> HashMap<(String, String), i64> {
    let mut out: HashMap<(String, String), i64> = HashMap::new();
    for series in data.map(|d| d.series.as_slice()).unwrap_or_default() {
        let (ns, pod) = (
            label(&series.labels, "namespace"),
            label(&series.labels, "pod"),
        );
        let Some(&(_, value)) = series.points.last() else {
            continue;
        };
        if ns.is_empty() || pod.is_empty() {
            continue;
        }
        let secs = value.floor() as i64;
        out.entry((ns.to_string(), pod.to_string()))
            .and_modify(|t| {
                *t = if earliest {
                    (*t).min(secs)
                } else {
                    (*t).max(secs)
                }
            })
            .or_insert(secs);
    }
    out
}

/// Merge the answers of one batch. A proxy or tunnel failure aborts; a
/// failed or oversized required answer makes the batch splittable; other
/// failures are recorded in `failed`.
pub fn merge(
    mut answers: Vec<(StatQuery, anyhow::Result<PromData>)>,
) -> Result<StatsBatch, BatchFailure> {
    if let Some(e) = answers
        .iter()
        .filter_map(|(_, answer)| answer.as_ref().err())
        .find(|e| is_proxy_failure(e) || is_tunnel_failure(e))
    {
        return Err(BatchFailure::Proxy(format!("{e:#}")));
    }
    answers.sort_by_key(|(q, _)| *q);
    let mut ok: BTreeMap<StatQuery, PromData> = BTreeMap::new();
    let mut failed = Vec::new();
    for (q, answer) in answers {
        let problem = match answer {
            Ok(data) if data.series.len() > MAX_SCAN_SERIES => {
                format!("more than {MAX_SCAN_SERIES} series")
            }
            Ok(data) => {
                ok.insert(q, data);
                continue;
            }
            Err(e) => format!("{e:#}"),
        };
        if q.is_required() {
            return Err(BatchFailure::Splittable {
                query: q.name(),
                message: problem,
            });
        }
        if !failed.contains(&q) {
            failed.push(q);
        }
    }

    let mut batch = StatsBatch {
        failed,
        ..Default::default()
    };
    for (q, data) in &ok {
        for warning in &data.warnings {
            if !batch.warnings.contains(warning) {
                batch.warnings.push(warning.clone());
            }
        }
        apply_containers(&mut batch.containers, *q, data);
    }
    let firsts = timestamps(ok.get(&StatQuery::FirstSeen), true);
    let lasts = timestamps(ok.get(&StatQuery::LastSeen), false);
    batch.spans = firsts
        .into_iter()
        .filter_map(|(key, first_secs)| {
            let last_secs = *lasts.get(&key)?;
            Some((
                key,
                PodSpan {
                    first_secs,
                    last_secs,
                },
            ))
        })
        .collect();
    let empty = PromData {
        result_type: "vector".into(),
        series: Vec::new(),
        warnings: Vec::new(),
    };
    batch.owners = OwnerIndex::from_data(
        ok.get(&StatQuery::PodOwners).unwrap_or(&empty),
        ok.get(&StatQuery::ReplicasetOwners).unwrap_or(&empty),
        ok.get(&StatQuery::JobOwners).unwrap_or(&empty),
    );
    Ok(batch)
}

impl Kubepit {
    /// Run the 16 queries of one batch ([`QUERIES_IN_FLIGHT`] at a time,
    /// all at `scope.end_secs`) and merge them. `on_answer` fires once per
    /// answer (progress). A proxy failure re-detects Prometheus next time.
    // Consumed by the collection pipeline (`rightsizing/collect.rs`).
    #[allow(dead_code)]
    pub(crate) async fn prometheus_stats_batch(
        &self,
        cluster_id: &str,
        scope: &StatScope,
        on_answer: &(dyn Fn() + Send + Sync),
    ) -> Result<StatsBatch, BatchFailure> {
        let source = self
            .prometheus_source(cluster_id)
            .await
            .map_err(|e| BatchFailure::Proxy(format!("{e:#}")))?;
        let source = &source;
        let answers: Vec<(StatQuery, anyhow::Result<PromData>)> = stream::iter(StatQuery::ALL)
            .map(|q| {
                let text = query(q, scope);
                async move {
                    // The one transport: tenant, tunnel and cluster-label selector.
                    let answer = self
                        .prometheus_send(
                            source,
                            "/api/v1/query",
                            instant_params(&text, Some(scope.end_secs)),
                            Origin::Preset,
                            USAGE_TIMEOUT,
                        )
                        .await;
                    on_answer();
                    (q, answer)
                }
            })
            .buffer_unordered(QUERIES_IN_FLIGHT)
            .collect()
            .await;
        let result = merge(answers);
        if matches!(result, Err(BatchFailure::Proxy(_))) {
            self.prometheus.invalidate(cluster_id);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rightsizing::ownership::Owner;
    use crate::types::PromQuerySeries;
    use anyhow::anyhow;

    fn series(labels: &[(&str, &str)], value: f64) -> PromQuerySeries {
        PromQuerySeries {
            labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            points: vec![(1_700_000_100_000, value)],
        }
    }

    fn data(series: Vec<PromQuerySeries>) -> PromData {
        PromData {
            result_type: "vector".into(),
            series,
            warnings: Vec::new(),
        }
    }

    fn data_with(count: usize) -> PromData {
        data(
            (0..count)
                .map(|i| {
                    series(
                        &[
                            ("namespace", "shop"),
                            ("pod", &format!("web-{i}")),
                            ("container", "app"),
                        ],
                        1.0,
                    )
                })
                .collect(),
        )
    }

    fn key(ns: &str, pod: &str, container: &str) -> (String, String, String) {
        (ns.into(), pod.into(), container.into())
    }

    const WEB: [(&str, &str); 3] = [
        ("namespace", "shop"),
        ("pod", "web-1"),
        ("container", "app"),
    ];
    const WEB_POD: [(&str, &str); 2] = [("namespace", "shop"), ("pod", "web-1")];

    fn duplicate(labels: &[(&str, &str)], value: f64) -> PromQuerySeries {
        let mut s = series(labels, value);
        s.labels.insert("instance".into(), "duplicate".into());
        s
    }

    #[test]
    fn stat_queries_follow_the_spec() {
        let scope = StatScope {
            namespaces: vec!["shop".into(), "a.b".into()],
            pod_regex: None,
            days: 7,
            end_secs: 1_700_000_100,
        };
        assert_eq!(
            query(StatQuery::CpuP95, &scope),
            r#"quantile_over_time(0.95, (max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace=~"a\\.b|shop"}[5m])))[7d:5m]) * 1000"#
        );
        assert_eq!(
            query(StatQuery::Running, &scope),
            r#"count_over_time((max by (namespace, pod, container) (kube_pod_container_status_running{namespace=~"a\\.b|shop"} == 1))[7d:5m])"#
        );
        assert_eq!(
            query(StatQuery::PodOwners, &scope),
            r#"max by (namespace, pod, owner_kind, owner_name) (max_over_time(kube_pod_owner{namespace=~"a\\.b|shop",owner_is_controller!="false"}[7d]))"#
        );
        let one = StatScope {
            pod_regex: Some("web-[a-z0-9]+-[a-z0-9]+".into()),
            namespaces: vec!["shop".into()],
            ..scope.clone()
        };
        assert!(query(StatQuery::CpuMax, &one).contains(r#"pod=~"web-[a-z0-9]+-[a-z0-9]+""#));
        assert!(!query(StatQuery::ReplicasetOwners, &one).contains("pod=~"));
        let all = StatScope {
            namespaces: vec![],
            ..scope
        };
        assert!(StatQuery::ALL
            .iter()
            .all(|q| !query(*q, &all).contains("namespace=~")));
        assert!(query(StatQuery::FirstSeen, &all)
            .starts_with("min_over_time(timestamp(max by (namespace, pod)"));
    }

    #[test]
    fn every_query_of_the_spec_table() {
        let scope = StatScope {
            namespaces: vec![],
            pod_regex: None,
            days: 2,
            end_secs: 0,
        };
        let expected = [
            (
                StatQuery::CpuP95,
                "cpu_p95",
                r#"quantile_over_time(0.95, (max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))[2d:5m]) * 1000"#,
            ),
            (
                StatQuery::CpuMax,
                "cpu_max",
                r#"max_over_time((max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))[2d:5m]) * 1000"#,
            ),
            (
                StatQuery::CpuAvg,
                "cpu_avg",
                r#"avg_over_time((max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))[2d:5m]) * 1000"#,
            ),
            (
                StatQuery::CpuSamples,
                "cpu_samples",
                r#"count_over_time((max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))[2d:5m])"#,
            ),
            (
                StatQuery::MemoryMax,
                "memory_max",
                r#"max by (namespace, pod, container) (max_over_time(container_memory_working_set_bytes{container!="",container!="POD"}[2d]))"#,
            ),
            (
                StatQuery::MemoryAvg,
                "memory_avg",
                r#"max by (namespace, pod, container) (avg_over_time(container_memory_working_set_bytes{container!="",container!="POD"}[2d]))"#,
            ),
            (
                StatQuery::MemorySamples,
                "memory_samples",
                r#"count_over_time((max by (namespace, pod, container) (container_memory_working_set_bytes{container!="",container!="POD"}))[2d:5m])"#,
            ),
            (
                StatQuery::Running,
                "running",
                r#"count_over_time((max by (namespace, pod, container) (kube_pod_container_status_running == 1))[2d:5m])"#,
            ),
            (
                StatQuery::FirstSeen,
                "first_seen",
                r#"min_over_time(timestamp(max by (namespace, pod) (kube_pod_container_status_running == 1))[2d:5m])"#,
            ),
            (
                StatQuery::LastSeen,
                "last_seen",
                r#"max_over_time(timestamp(max by (namespace, pod) (kube_pod_container_status_running == 1))[2d:5m])"#,
            ),
            (
                StatQuery::PodOwners,
                "pod_owners",
                r#"max by (namespace, pod, owner_kind, owner_name) (max_over_time(kube_pod_owner{owner_is_controller!="false"}[2d]))"#,
            ),
            (
                StatQuery::ReplicasetOwners,
                "replicaset_owners",
                r#"max by (namespace, replicaset, owner_kind, owner_name) (max_over_time(kube_replicaset_owner[2d]))"#,
            ),
            (
                StatQuery::JobOwners,
                "job_owners",
                r#"max by (namespace, job_name, owner_kind, owner_name) (max_over_time(kube_job_owner[2d]))"#,
            ),
            (
                StatQuery::Oom,
                "oom",
                r#"max by (namespace, pod, container) (max_over_time(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[2d]))"#,
            ),
            (
                StatQuery::Throttled,
                "throttled",
                r#"max by (namespace, pod, container) (increase(container_cpu_cfs_throttled_periods_total{container!="",container!="POD"}[2d]))"#,
            ),
            (
                StatQuery::Periods,
                "periods",
                r#"max by (namespace, pod, container) (increase(container_cpu_cfs_periods_total{container!="",container!="POD"}[2d]))"#,
            ),
        ];
        assert_eq!(StatQuery::ALL.len(), expected.len());
        for ((q, name, promql), listed) in expected.iter().zip(StatQuery::ALL) {
            assert_eq!(*q, listed, "ALL follows the spec order");
            assert_eq!(q.name(), *name);
            assert_eq!(query(*q, &scope), *promql, "{name}");
            assert_eq!(
                q.is_required(),
                matches!(q, StatQuery::CpuP95 | StatQuery::MemoryMax)
            );
        }
        // Namespace and pod matchers go into KSM selectors too.
        let one = StatScope {
            namespaces: vec!["shop".into()],
            pod_regex: Some("db-[0-9]+".into()),
            ..scope.clone()
        };
        assert_eq!(
            query(StatQuery::Oom, &one),
            r#"max by (namespace, pod, container) (max_over_time(kube_pod_container_status_last_terminated_reason{namespace=~"shop",pod=~"db-[0-9]+",reason="OOMKilled"}[2d]))"#
        );
        assert_eq!(
            query(StatQuery::JobOwners, &one),
            r#"max by (namespace, job_name, owner_kind, owner_name) (max_over_time(kube_job_owner{namespace=~"shop"}[2d]))"#
        );
        let many = StatScope {
            namespaces: (0..=MAX_NAMESPACE_MATCHERS)
                .map(|i| format!("ns{i}"))
                .collect(),
            ..scope
        };
        assert!(
            !query(StatQuery::CpuP95, &many).contains("namespace=~"),
            "too many namespaces: the whole cluster"
        );
    }

    #[test]
    fn window_end_aligns_to_five_minutes() {
        assert_eq!(window_end(1_700_000_123_456), 1_700_000_100);
        assert_eq!(window_end(1_700_000_100_000), 1_700_000_100);
    }

    #[test]
    fn batches_merge_per_pod_and_container() {
        let mut partial = data(vec![series(&WEB, 1e8)]);
        partial.warnings = vec!["partial".into()];
        let mut again = data(vec![series(&WEB, 9e7)]);
        again.warnings = vec!["partial".into()];
        let batch = merge(vec![
            (
                StatQuery::CpuP95,
                Ok(data(vec![
                    series(&WEB, 100.0),
                    duplicate(&WEB, 120.0),
                    series(&[("namespace", "x")], 1.0),
                    series(&[("namespace", "shop"), ("pod", "web-1")], 1.0),
                ])),
            ),
            (StatQuery::CpuMax, Ok(data(vec![series(&WEB, 300.0)]))),
            (StatQuery::CpuAvg, Ok(data(vec![series(&WEB, 50.0)]))),
            (StatQuery::CpuSamples, Ok(data(vec![series(&WEB, 288.0)]))),
            (StatQuery::MemoryMax, Ok(data(vec![series(&WEB, 2e8)]))),
            (StatQuery::MemoryAvg, Ok(partial)),
            (StatQuery::MemorySamples, Ok(again)),
            (StatQuery::Running, Ok(data(vec![series(&WEB, -3.0)]))),
            (
                StatQuery::FirstSeen,
                Ok(data(vec![
                    series(&WEB_POD, 2000.0),
                    duplicate(&WEB_POD, 1000.0),
                ])),
            ),
            (
                StatQuery::LastSeen,
                Ok(data(vec![
                    series(&WEB_POD, 9000.0),
                    duplicate(&WEB_POD, 8000.0),
                ])),
            ),
            (
                StatQuery::PodOwners,
                Ok(data(vec![series(
                    &[
                        ("namespace", "shop"),
                        ("pod", "web-1"),
                        ("owner_kind", "ReplicaSet"),
                        ("owner_name", "web-5d8f7"),
                    ],
                    1.0,
                )])),
            ),
            (
                StatQuery::ReplicasetOwners,
                Ok(data(vec![series(
                    &[
                        ("namespace", "shop"),
                        ("replicaset", "web-5d8f7"),
                        ("owner_kind", "Deployment"),
                        ("owner_name", "web"),
                    ],
                    1.0,
                )])),
            ),
            (StatQuery::JobOwners, Ok(data(vec![]))),
            (StatQuery::Oom, Err(anyhow!("timeout"))),
            (StatQuery::Throttled, Ok(data(vec![series(&WEB, 50.0)]))),
            (StatQuery::Periods, Ok(data(vec![series(&WEB, 1000.0)]))),
        ])
        .unwrap();
        assert_eq!(
            batch.containers.len(),
            1,
            "series without labels are ignored"
        );
        let web = &batch.containers[&key("shop", "web-1", "app")];
        assert_eq!(web.cpu_p95, Some(120.0), "a repeated key keeps the max");
        assert_eq!(web.running, 0.0, "negative counts clamp to 0");
        assert_eq!(
            (web.cpu_max, web.cpu_avg, web.cpu_samples),
            (Some(300.0), Some(50.0), 288.0)
        );
        assert_eq!(
            (web.memory_max, web.memory_avg, web.memory_samples),
            (Some(2e8), Some(1e8), 9e7)
        );
        assert_eq!((web.throttled, web.periods, web.oom), (50.0, 1000.0, false));
        assert_eq!(
            batch.spans[&("shop".into(), "web-1".into())],
            PodSpan {
                first_secs: 1000,
                last_secs: 9000
            }
        );
        assert_eq!(batch.failed, vec![StatQuery::Oom]); // optional failure recorded
        assert_eq!(batch.warnings, vec!["partial".to_string()]);
        assert_eq!(
            batch.owners.resolve("shop", "web-1"),
            Owner::Workload {
                kind: "Deployment".into(),
                name: "web".into()
            }
        );

        assert!(matches!(
            merge(vec![(StatQuery::CpuP95, Err(anyhow!("timeout")))]),
            Err(BatchFailure::Splittable { .. })
        ));
        assert!(matches!(
            merge(vec![(
                StatQuery::MemoryMax,
                Ok(data_with(MAX_SCAN_SERIES + 1))
            )]),
            Err(BatchFailure::Splittable { .. })
        ));
    }

    #[test]
    fn failures_split_abort_or_only_refine() {
        let required = merge(vec![
            (StatQuery::CpuP95, Ok(data(vec![series(&WEB, 1.0)]))),
            (StatQuery::MemoryMax, Err(anyhow!("too many samples"))),
        ]);
        assert_eq!(
            required,
            Err(BatchFailure::Splittable {
                query: "memory_max",
                message: "too many samples".into()
            })
        );
        let oversized = merge(vec![
            (StatQuery::CpuP95, Ok(data(vec![series(&WEB, 1.0)]))),
            (StatQuery::MemoryMax, Ok(data(vec![series(&WEB, 1.0)]))),
            (StatQuery::Running, Ok(data_with(MAX_SCAN_SERIES + 1))),
            (StatQuery::Oom, Ok(data(vec![series(&WEB, 1.0)]))),
        ])
        .unwrap();
        assert_eq!(oversized.failed, vec![StatQuery::Running]);
        assert!(oversized.containers[&key("shop", "web-1", "app")].oom);
        assert!(oversized.owners.is_empty());

        // The service proxy lost Prometheus: nothing to split, the scan aborts.
        let gone: anyhow::Error = super::super::proxy::http_error(
            503,
            r#"{"kind":"Status","message":"no endpoints available for service \"p\"","code":503}"#,
        )
        .into();
        assert!(matches!(
            merge(vec![
                (StatQuery::CpuP95, Ok(data(vec![series(&WEB, 1.0)]))),
                (StatQuery::Throttled, Err(gone)),
            ]),
            Err(BatchFailure::Proxy(_))
        ));
        // So did the tunnel (no ready pod, unreadable credentials): smaller
        // batches would fail the same way.
        let tunnel = super::super::tunnel::tunnel_failure(anyhow!(
            "no running and ready pod backs service prometheus-operated"
        ));
        assert_eq!(
            merge(vec![
                (StatQuery::CpuP95, Err(tunnel)),
                (StatQuery::MemoryMax, Ok(data(vec![series(&WEB, 1.0)]))),
            ]),
            Err(BatchFailure::Proxy(
                "no running and ready pod backs service prometheus-operated".into()
            ))
        );
    }
}
