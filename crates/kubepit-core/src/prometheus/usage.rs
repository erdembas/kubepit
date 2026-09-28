//! Usage statistics for cost estimates: instant queries grouped by pod, so
//! one request covers the whole cluster — the average CPU (`rate` over the
//! whole window, in cores) and the average working set of every pod over
//! the report window. Same series as the chart presets (cAdvisor, real
//! containers only). Right-sizing's per-container statistics are the 16
//! queries of [`super::workload_stats`]. Read-only like the rest.
//!
//! On a shared Prometheus every query gets the cluster-label selector
//! (through the one transport, [`Kubepit::prometheus_send`]).

use std::time::Duration;

use anyhow::Result;

use super::parse::PromData;
use super::{Origin, Source};
use crate::app::Kubepit;
use crate::cost::estimate::{PodUsage, UsageMap};

/// cAdvisor series of real containers (not the pod cgroup nor the pause container).
const CONTAINERS: &str = r#"container!="",container!="POD""#;
/// Upper bound for one statistics query (7-day subqueries are heavy).
pub const USAGE_TIMEOUT: Duration = Duration::from_secs(60);
/// Above this many namespaces a statistics query covers the whole cluster
/// instead ([`super::workload_stats`]).
pub const MAX_NAMESPACE_MATCHERS: usize = 40;

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

fn label<'a>(labels: &'a std::collections::BTreeMap<String, String>, key: &str) -> &'a str {
    labels.get(key).map(String::as_str).unwrap_or_default()
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

/// Parameters of an instant query, evaluated at `time` (epoch seconds) when
/// set, else at the server's "now".
pub(super) fn instant_params(query: &str, time: Option<i64>) -> Vec<(&'static str, String)> {
    let mut params = vec![("query", query.to_string())];
    if let Some(time) = time {
        params.push(("time", time.to_string()));
    }
    params
}

impl Kubepit {
    /// One instant preset query against `source`, evaluated at `time`
    /// (epoch seconds; `None` = now), through the one transport (tenant,
    /// tunnel, cluster-label selector, re-detection after proxy failures).
    async fn prometheus_instant(
        &self,
        source: &Source<'_>,
        query: &str,
        time: Option<i64>,
    ) -> Result<PromData> {
        self.prometheus_send(
            source,
            "/api/v1/query",
            instant_params(query, time),
            Origin::Preset,
            USAGE_TIMEOUT,
        )
        .await
    }

    /// Average usage of every pod over `window_secs`.
    pub async fn prometheus_pod_usage(
        &self,
        cluster_id: &str,
        window_secs: u64,
    ) -> Result<UsageMap> {
        let source = self.prometheus_source(cluster_id).await?;
        let (cpu, memory) = futures::future::join(
            self.prometheus_instant(&source, &pod_cpu_avg(window_secs), None),
            self.prometheus_instant(&source, &pod_memory_avg(window_secs), None),
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
    fn estimate_presets_group_by_pod() {
        assert_eq!(
            pod_cpu_avg(604_800),
            r#"sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[604800s]))"#
        );
        assert!(pod_memory_avg(3600).contains("avg_over_time(container_memory_working_set_bytes"));
    }

    #[test]
    fn instant_queries_send_the_evaluation_time_when_set() {
        assert_eq!(
            instant_params("up", None),
            vec![("query", "up".to_string())]
        );
        assert_eq!(
            instant_params("up", Some(1_700_000_100)),
            vec![
                ("query", "up".to_string()),
                ("time", "1700000100".to_string())
            ]
        );
    }

    #[test]
    fn pod_usage_merges_per_pod() {
        let usage = merge_pod_usage(
            &data(vec![
                series(&[("namespace", "shop"), ("pod", "web-1")], 0.2),
                series(&[("namespace", "x")], 1.0),
            ]),
            &data(vec![series(
                &[("namespace", "shop"), ("pod", "web-1")],
                1e8,
            )]),
        );
        assert_eq!(usage.len(), 1, "series without a pod are ignored");
        let u = usage[&("shop".into(), "web-1".into())];
        assert_eq!(u.cpu_cores, 0.2);
        assert_eq!(u.memory_bytes, 1e8);
    }
}
