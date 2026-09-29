//! Usage history of one container of one workload, for the recommendation
//! charts (spec §6.11): four range queries over `[end − D·86400, end]`
//! with the automatic step ([`range::auto_step`], 1 h for 7 days), each
//! aggregated to one series:
//!
//! | Series | PromQL (`SEL` = the container's matchers) |
//! |---|---|
//! | CPU peak | `max(max_over_time((rate(container_cpu_usage_seconds_total{SEL}[5m]))[{step}s:5m])) * 1000` |
//! | CPU average | `avg(avg_over_time((max by (pod) (rate(container_cpu_usage_seconds_total{SEL}[5m])))[{step}s:5m])) * 1000` |
//! | Memory peak | `max(max_over_time(container_memory_working_set_bytes{SEL}[{step}s]))` |
//! | Memory average | `avg(max by (pod) (avg_over_time(container_memory_working_set_bytes{SEL}[{step}s])))` |
//!
//! `SEL` = real containers, the namespace and the container, plus the
//! row's pod names (`pod=~"a|b"`, validated, at most [`MAX_POD_NAMES`]) or
//! else the pod names the workload's kind generates. Gaps stay gaps: a step
//! without samples has no point. Every query goes through the one transport
//! as a preset (tenant, tunnel, cluster-label selector). Read-only.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::promql::{quote, regex_escape, workload_pod_regex};
use super::range::{self, Window};
use super::usage::USAGE_TIMEOUT;
use super::workload_stats::window_end;
use super::{range_params, Origin};
use crate::app::Kubepit;
use crate::objects::now_millis;
use crate::rightsizing::evidence::MAX_POD_NAMES;
use crate::rightsizing::WorkloadRef;
use crate::types::{PromPoint, PrometheusRange};

/// Days of history by default, and the range accepted.
pub const DEFAULT_DAYS: u32 = 7;
pub const MAX_DAYS: u32 = 30;

/// How the queries select the workload's pods.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PodFilter {
    /// The pod names the row lists.
    Names,
    /// The names the workload's kind generates.
    Pattern,
}

/// `recommendations_usage_history`: CPU in millicores, memory in bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkloadUsageHistory {
    /// The range, epoch ms.
    pub start: i64,
    pub end: i64,
    pub step_secs: u64,
    pub pod_filter: PodFilter,
    pub cpu_avg: Vec<PromPoint>,
    pub cpu_peak: Vec<PromPoint>,
    pub memory_avg: Vec<PromPoint>,
    pub memory_peak: Vec<PromPoint>,
    /// Prometheus warnings, and series that could not be read.
    pub warnings: Vec<String>,
}

/// A DNS-1123 label: 1–63 lowercase letters, digits and `-`, starting and
/// ending with a letter or digit.
fn dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

/// A DNS-1123 subdomain (a pod name): dot-separated labels, ≤ 253 characters.
fn dns_subdomain(value: &str) -> bool {
    value.len() <= 253 && value.split('.').all(dns_label)
}

/// The four queries (CPU peak, CPU average, memory peak, memory average)
/// of `container` in `workload` at `step_secs`, and how they select pods:
/// by `pods` (validated) or, when empty, by the workload's pattern.
pub fn history_queries(
    workload: &WorkloadRef,
    container: &str,
    pods: &[String],
    step_secs: u64,
) -> Result<([String; 4], PodFilter)> {
    if !dns_label(&workload.namespace) {
        bail!("invalid namespace \"{}\"", workload.namespace);
    }
    if !dns_label(container) {
        bail!("invalid container name \"{container}\"");
    }
    if pods.len() > MAX_POD_NAMES {
        bail!("at most {MAX_POD_NAMES} pod names can be charted");
    }
    if let Some(bad) = pods.iter().find(|p| !dns_subdomain(p)) {
        bail!("invalid pod name \"{bad}\"");
    }
    let (regex, filter) = if pods.is_empty() {
        (
            workload_pod_regex(&workload.kind, &workload.name),
            PodFilter::Pattern,
        )
    } else {
        let names: Vec<String> = pods.iter().map(|p| regex_escape(p)).collect();
        (names.join("|"), PodFilter::Names)
    };
    let sel = format!(
        r#"container!="",container!="POD",namespace={},container={},pod=~{}"#,
        quote(&workload.namespace),
        quote(container),
        quote(&regex)
    );
    let cpu = format!("rate(container_cpu_usage_seconds_total{{{sel}}}[5m])");
    let memory = format!("container_memory_working_set_bytes{{{sel}}}");
    let s = step_secs;
    Ok((
        [
            format!("max(max_over_time(({cpu})[{s}s:5m])) * 1000"),
            format!("avg(avg_over_time((max by (pod) ({cpu}))[{s}s:5m])) * 1000"),
            format!("max(max_over_time({memory}[{s}s]))"),
            format!("avg(max by (pod) (avg_over_time({memory}[{s}s])))"),
        ],
        filter,
    ))
}

/// Names of the four series, for warnings.
const SERIES: [&str; 4] = ["cpu_peak", "cpu_avg", "memory_peak", "memory_avg"];

impl Kubepit {
    /// `recommendations_usage_history`: the usage of `container` in
    /// `workload` over the last `days` (default 7, clamped 1–30), ending at
    /// the aligned window end of the scans. Series fail individually; only
    /// when all four fail is the call an error.
    pub async fn recommendations_usage_history(
        &self,
        cluster_id: &str,
        workload: &WorkloadRef,
        container: &str,
        pods: &[String],
        days: Option<u32>,
    ) -> Result<WorkloadUsageHistory> {
        let days = days.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS);
        let end_secs = window_end(now_millis());
        let span = i64::from(days) * 86_400;
        let window = Window::new(&PrometheusRange {
            start: (end_secs - span) * 1000,
            end: end_secs * 1000,
            step: Some(range::auto_step(span as u64)),
        })?;
        let (queries, pod_filter) = history_queries(workload, container, pods, window.step_secs)?;
        let source = self.prometheus_source(cluster_id).await?;
        let answers = futures::future::join_all(queries.iter().map(|q| {
            self.prometheus_send(
                &source,
                "/api/v1/query_range",
                range_params(q, &window),
                Origin::Preset,
                USAGE_TIMEOUT,
            )
        }))
        .await;

        let mut warnings: Vec<String> = Vec::new();
        let mut series: Vec<Vec<PromPoint>> = Vec::with_capacity(4);
        let (mut failures, mut first_error) = (0, None);
        for (name, answer) in SERIES.iter().zip(answers) {
            match answer {
                Ok(data) => {
                    for warning in data.warnings {
                        if !warnings.contains(&warning) {
                            warnings.push(warning);
                        }
                    }
                    // Aggregated to one series (none without samples).
                    series.push(
                        data.series
                            .into_iter()
                            .next()
                            .map(|s| s.points)
                            .unwrap_or_default(),
                    );
                }
                Err(e) => {
                    warnings.push(format!("{name}: {e:#}"));
                    failures += 1;
                    first_error.get_or_insert(e);
                    series.push(Vec::new());
                }
            }
        }
        if let Some(e) = first_error.filter(|_| failures == SERIES.len()) {
            return Err(e);
        }
        let [cpu_peak, cpu_avg, memory_peak, memory_avg]: [Vec<PromPoint>; 4] =
            series
                .try_into()
                .map_err(|_| anyhow::anyhow!("unexpected number of Prometheus answers"))?;
        Ok(WorkloadUsageHistory {
            start: window.start_ms(),
            end: window.end_ms(),
            step_secs: window.step_secs,
            pod_filter,
            cpu_avg,
            cpu_peak,
            memory_avg,
            memory_peak,
            warnings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web() -> WorkloadRef {
        WorkloadRef {
            kind: "Deployment".into(),
            namespace: "shop".into(),
            name: "web".into(),
        }
    }

    #[test]
    fn history_queries_use_names_or_the_pattern() {
        let (q, filter) =
            history_queries(&web(), "app", &["web-1".into(), "web-2".into()], 3600).unwrap();
        assert_eq!(filter, PodFilter::Names);
        assert_eq!(
            q[0],
            r#"max(max_over_time((rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace="shop",container="app",pod=~"web-1|web-2"}[5m]))[3600s:5m])) * 1000"#
        );
        assert_eq!(
            q[1],
            r#"avg(avg_over_time((max by (pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace="shop",container="app",pod=~"web-1|web-2"}[5m])))[3600s:5m])) * 1000"#
        );
        assert_eq!(
            q[2],
            r#"max(max_over_time(container_memory_working_set_bytes{container!="",container!="POD",namespace="shop",container="app",pod=~"web-1|web-2"}[3600s]))"#
        );
        assert_eq!(
            q[3],
            r#"avg(max by (pod) (avg_over_time(container_memory_working_set_bytes{container!="",container!="POD",namespace="shop",container="app",pod=~"web-1|web-2"}[3600s])))"#
        );
        let (q, filter) = history_queries(&web(), "app", &[], 3600).unwrap();
        assert_eq!(filter, PodFilter::Pattern);
        assert!(
            q[2].contains(r#"pod=~"web-[a-z0-9]+-[a-z0-9]+""#),
            "{}",
            q[2]
        );
        // Dots in pod names are literal in the regex.
        let (q, _) = history_queries(&web(), "app", &["web.1".into()], 3600).unwrap();
        assert!(q[0].contains(r#"pod=~"web\\.1""#), "{}", q[0]);
    }

    #[test]
    fn invalid_pod_names_are_refused() {
        assert!(history_queries(&web(), "app", &["a|b".into()], 3600).is_err());
        assert!(history_queries(&web(), "app", &["Web-1".into()], 3600).is_err());
        assert!(history_queries(&web(), "app", &["-web".into()], 3600).is_err());
        assert!(history_queries(&web(), "app", &["x".repeat(254)], 3600).is_err());
        assert!(history_queries(&web(), "app", &vec!["p".into(); 51], 3600).is_err());
        assert!(history_queries(&web(), "app", &vec!["p".into(); 50], 3600).is_ok());
        assert!(history_queries(&web(), "app\"}", &[], 3600).is_err());
        let odd = WorkloadRef {
            namespace: "a\"b".into(),
            ..web()
        };
        assert!(history_queries(&odd, "app", &[], 3600).is_err());
    }

    #[test]
    fn the_filter_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_value(PodFilter::Pattern).unwrap(),
            serde_json::json!("pattern")
        );
    }
}
