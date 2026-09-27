//! Usage statistics for cost estimates and right-sizing: instant queries
//! grouped by pod or container, so one request covers a whole scope.
//!
//! - Right-sizing (per container, over `days`): p95 and max of the CPU rate
//!   (5-minute resolution), max of the memory working set, and the number of
//!   hours with samples (how much history backs a recommendation).
//! - Estimates (per pod, over the report window): average CPU (`rate` over
//!   the whole window) and average working set.
//!
//! Same series as the chart presets (cAdvisor, real containers only), CPU in
//! millicores for containers and cores for pods. Read-only like the rest.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::Result;

use super::parse::PromData;
use super::promql::{quote, regex_escape};
use super::proxy;
use crate::app::Kubepit;
use crate::cost::estimate::{PodUsage, UsageMap};

/// cAdvisor series of real containers (not the pod cgroup nor the pause container).
const CONTAINERS: &str = r#"container!="",container!="POD""#;
/// Upper bound for one statistics query (7-day subqueries are heavy).
pub const USAGE_TIMEOUT: Duration = Duration::from_secs(60);
/// Above this many namespaces a query covers the whole cluster instead.
pub const MAX_NAMESPACE_MATCHERS: usize = 40;

/// cAdvisor matchers for `namespaces` (every namespace when empty).
pub fn container_selector(namespaces: &[String]) -> String {
    if namespaces.is_empty() || namespaces.len() > MAX_NAMESPACE_MATCHERS {
        return CONTAINERS.to_string();
    }
    let mut names: Vec<String> = namespaces.iter().map(|n| regex_escape(n)).collect();
    names.sort();
    names.dedup();
    format!("{CONTAINERS},namespace=~{}", quote(&names.join("|")))
}

/// p95 of each container's CPU (millicores) over `days`.
pub fn container_cpu_p95(namespaces: &[String], days: u32) -> String {
    format!(
        "quantile_over_time(0.95, (sum by (namespace, pod, container) \
         (rate(container_cpu_usage_seconds_total{{{}}}[5m])))[{days}d:5m]) * 1000",
        container_selector(namespaces)
    )
}

/// Highest 5-minute CPU rate (millicores) of each container over `days`.
pub fn container_cpu_max(namespaces: &[String], days: u32) -> String {
    format!(
        "max_over_time((sum by (namespace, pod, container) \
         (rate(container_cpu_usage_seconds_total{{{}}}[5m])))[{days}d:5m]) * 1000",
        container_selector(namespaces)
    )
}

/// Highest working set (bytes) of each container over `days`.
pub fn container_memory_max(namespaces: &[String], days: u32) -> String {
    format!(
        "max by (namespace, pod, container) \
         (max_over_time(container_memory_working_set_bytes{{{}}}[{days}d]))",
        container_selector(namespaces)
    )
}

/// Hours with samples of each container over `days` (at most `24 × days`).
pub fn container_hours(namespaces: &[String], days: u32) -> String {
    format!(
        "count_over_time((max by (namespace, pod, container) \
         (container_memory_working_set_bytes{{{}}}))[{days}d:1h])",
        container_selector(namespaces)
    )
}

/// Average CPU (cores) of each pod over `window_secs`.
pub fn pod_cpu_avg(window_secs: u64) -> String {
    format!(
        "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{{{CONTAINERS}}}[{window_secs}s]))"
    )
}

/// Average working set (bytes) of each pod over `window_secs`.
pub fn pod_memory_avg(window_secs: u64) -> String {
    format!(
        "sum by (namespace, pod) (avg_over_time(container_memory_working_set_bytes{{{CONTAINERS}}}[{window_secs}s]))"
    )
}

/// Usage history of one container.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ContainerStats {
    pub cpu_p95_millicores: Option<f64>,
    pub cpu_max_millicores: Option<f64>,
    pub memory_max_bytes: Option<f64>,
    pub hours: f64,
}

/// `(namespace, pod, container)` → statistics.
pub type ContainerStatsMap = HashMap<(String, String, String), ContainerStats>;

fn label<'a>(labels: &'a std::collections::BTreeMap<String, String>, key: &str) -> &'a str {
    labels.get(key).map(String::as_str).unwrap_or_default()
}

/// Merge the four vectors of the right-sizing presets.
pub fn merge_container_stats(
    cpu_p95: &PromData,
    cpu_max: &PromData,
    memory_max: &PromData,
    hours: &PromData,
) -> ContainerStatsMap {
    let mut out = ContainerStatsMap::new();
    let mut apply = |data: &PromData, set: &dyn Fn(&mut ContainerStats, f64)| {
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
            let entry = out
                .entry((ns.to_string(), pod.to_string(), container.to_string()))
                .or_default();
            set(entry, value);
        }
    };
    apply(cpu_p95, &|s, v| s.cpu_p95_millicores = Some(v));
    apply(cpu_max, &|s, v| s.cpu_max_millicores = Some(v));
    apply(memory_max, &|s, v| s.memory_max_bytes = Some(v));
    apply(hours, &|s, v| s.hours = v);
    out
}

/// Merge the two vectors of the estimate presets.
pub fn merge_pod_usage(cpu: &PromData, memory: &PromData) -> UsageMap {
    let mut out = UsageMap::new();
    for (data, is_cpu) in [(cpu, true), (memory, false)] {
        for series in &data.series {
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
            let entry: &mut PodUsage = out.entry((ns.to_string(), pod.to_string())).or_default();
            if is_cpu {
                entry.cpu_cores = value;
            } else {
                entry.memory_bytes = value;
            }
        }
    }
    out
}

impl Kubepit {
    /// One instant query against the cluster's Prometheus.
    async fn prometheus_instant(&self, cluster_id: &str, query: &str) -> Result<PromData> {
        let (service, client) = self.prometheus_service(cluster_id).await?;
        let path = proxy::proxy_path(&service, "/api/v1/query", &[("query", query.to_string())]);
        proxy::get(&client, &path, USAGE_TIMEOUT)
            .await
            .inspect_err(|e| {
                if super::is_proxy_failure(e) {
                    self.prometheus.invalidate(cluster_id);
                }
            })
    }

    /// Right-sizing history of every container in `namespaces` (all when
    /// empty) over `days`. Fails when Prometheus is not available.
    pub async fn prometheus_container_stats(
        &self,
        cluster_id: &str,
        namespaces: &[String],
        days: u32,
    ) -> Result<ContainerStatsMap> {
        let queries = [
            container_cpu_p95(namespaces, days),
            container_cpu_max(namespaces, days),
            container_memory_max(namespaces, days),
            container_hours(namespaces, days),
        ];
        let [p95, max, mem, hours] = futures::future::join_all(
            queries
                .iter()
                .map(|q| self.prometheus_instant(cluster_id, q)),
        )
        .await
        .try_into()
        .map_err(|_| anyhow::anyhow!("unexpected number of Prometheus answers"))?;
        // Memory and CPU p95 are required; the rest only refine.
        let (p95, mem) = (p95?, mem?);
        let empty = || PromData {
            result_type: "vector".into(),
            series: Vec::new(),
            warnings: Vec::new(),
        };
        Ok(merge_container_stats(
            &p95,
            &max.unwrap_or_else(|_| empty()),
            &mem,
            &hours.unwrap_or_else(|_| empty()),
        ))
    }

    /// Average usage of every pod over `window_secs`.
    pub async fn prometheus_pod_usage(
        &self,
        cluster_id: &str,
        window_secs: u64,
    ) -> Result<UsageMap> {
        let (cpu, memory) = futures::future::join(
            self.prometheus_instant(cluster_id, &pod_cpu_avg(window_secs)),
            self.prometheus_instant(cluster_id, &pod_memory_avg(window_secs)),
        )
        .await;
        Ok(merge_pod_usage(&cpu?, &memory?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PromQuerySeries;
    use std::collections::BTreeMap;

    fn series(labels: &[(&str, &str)], value: f64) -> PromQuerySeries {
        PromQuerySeries {
            labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>(),
            points: vec![(1_700_000_000_000, value)],
        }
    }

    fn data(series: Vec<PromQuerySeries>) -> PromData {
        PromData {
            result_type: "vector".into(),
            series,
            warnings: Vec::new(),
        }
    }

    #[test]
    fn right_sizing_presets_group_by_container() {
        let q = container_cpu_p95(&["shop".into(), "a.b".into()], 7);
        assert_eq!(
            q,
            r#"quantile_over_time(0.95, (sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace=~"a\\.b|shop"}[5m])))[7d:5m]) * 1000"#
        );
        assert!(container_cpu_max(&[], 7)
            .starts_with("max_over_time((sum by (namespace, pod, container)"));
        assert!(container_cpu_max(&[], 7).contains(r#"{container!="",container!="POD"}"#));
        assert_eq!(
            container_memory_max(&["db".into()], 7),
            r#"max by (namespace, pod, container) (max_over_time(container_memory_working_set_bytes{container!="",container!="POD",namespace=~"db"}[7d]))"#
        );
        assert!(container_hours(&[], 7).ends_with("[7d:1h])"));
        let many: Vec<String> = (0..=MAX_NAMESPACE_MATCHERS)
            .map(|i| format!("ns{i}"))
            .collect();
        assert!(
            !container_selector(&many).contains("namespace"),
            "too many: whole cluster"
        );
        assert_eq!(
            pod_cpu_avg(604_800),
            r#"sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[604800s]))"#
        );
        assert!(pod_memory_avg(3600).contains("avg_over_time(container_memory_working_set_bytes"));
    }

    #[test]
    fn statistics_merge_per_container_and_pod() {
        let key = [
            ("namespace", "shop"),
            ("pod", "web-1"),
            ("container", "app"),
        ];
        let stats = merge_container_stats(
            &data(vec![
                series(&key, 120.0),
                series(&[("namespace", "x")], 1.0),
            ]),
            &data(vec![series(&key, 300.0)]),
            &data(vec![series(&key, 2e8)]),
            &data(vec![series(&key, 150.0)]),
        );
        assert_eq!(stats.len(), 1, "series without pod/container are ignored");
        let s = &stats[&("shop".into(), "web-1".into(), "app".into())];
        assert_eq!(s.cpu_p95_millicores, Some(120.0));
        assert_eq!(s.cpu_max_millicores, Some(300.0));
        assert_eq!(s.memory_max_bytes, Some(2e8));
        assert_eq!(s.hours, 150.0);

        let usage = merge_pod_usage(
            &data(vec![series(
                &[("namespace", "shop"), ("pod", "web-1")],
                0.2,
            )]),
            &data(vec![series(
                &[("namespace", "shop"), ("pod", "web-1")],
                1e8,
            )]),
        );
        let u = usage[&("shop".into(), "web-1".into())];
        assert_eq!(u.cpu_cores, 0.2);
        assert_eq!(u.memory_bytes, 1e8);
    }
}
