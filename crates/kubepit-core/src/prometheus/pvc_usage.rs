//! Overview's five fullest measured PVCs. One instant preset returns at
//! most two series per claim; it never lists PVC objects or requests their
//! configured storage size as a substitute for observed capacity.

use std::collections::BTreeMap;

use anyhow::Result;

use super::{proxy, Origin};
use crate::app::Kubepit;
use crate::objects::now_millis;
use crate::types::{PromQuerySeries, PrometheusPvcUsage, PrometheusPvcUsageResult};

const USED: &str = "kubelet_volume_stats_used_bytes";
const CAPACITY: &str = "kubelet_volume_stats_capacity_bytes";
const LIMIT: usize = 5;

/// Keep the metric name on the left to return both observed byte values.
/// The right side ranks one ratio per claim. `max`, rather than `sum`,
/// deduplicates scrapes and volumes mounted on several nodes. Filtering
/// before `topk` keeps missing, zero-capacity and non-finite measurements
/// from displacing usable claims. Preset transport scopes all selectors.
const QUERY: &str = concat!(
    "max by (namespace, persistentvolumeclaim, __name__) ",
    "(({__name__=~\"kubelet_volume_stats_(used|capacity)_bytes\",namespace!=\"\",persistentvolumeclaim!=\"\"} >= 0) < +Inf) ",
    "and on (namespace, persistentvolumeclaim) topk(5, (",
    "max by (namespace, persistentvolumeclaim) ",
    "((kubelet_volume_stats_used_bytes{namespace!=\"\",persistentvolumeclaim!=\"\"} >= 0) < +Inf) / ",
    "max by (namespace, persistentvolumeclaim) ",
    "((kubelet_volume_stats_capacity_bytes{namespace!=\"\",persistentvolumeclaim!=\"\"} > 0) < +Inf)",
    ") < +Inf)"
);

impl Kubepit {
    /// Read-only and cluster-scoped, including on shared Prometheus sources.
    pub async fn prometheus_pvc_usage(&self, cluster_id: &str) -> Result<PrometheusPvcUsageResult> {
        let source = self.prometheus_source(cluster_id).await?;
        let checked_at = now_millis();
        let data = self
            .prometheus_send(
                &source,
                "/api/v1/query",
                vec![
                    ("query", QUERY.to_string()),
                    ("time", (checked_at as f64 / 1000.0).to_string()),
                ],
                Origin::Preset,
                proxy::QUERY_TIMEOUT,
            )
            .await?;
        Ok(PrometheusPvcUsageResult {
            service: source.service,
            checked_at,
            rows: rows(&data.series),
            warnings: data.warnings,
        })
    }
}

#[derive(Default)]
struct Measurement {
    used: Option<f64>,
    capacity: Option<f64>,
}

fn rows(series: &[PromQuerySeries]) -> Vec<PrometheusPvcUsage> {
    let mut measurements: BTreeMap<(&str, &str), Measurement> = BTreeMap::new();
    for series in series {
        let (Some(namespace), Some(name), Some(metric)) = (
            series.labels.get("namespace").filter(|s| !s.is_empty()),
            series
                .labels
                .get("persistentvolumeclaim")
                .filter(|s| !s.is_empty()),
            series.labels.get("__name__"),
        ) else {
            continue;
        };
        let Some(&(_, value)) = series.points.last() else {
            continue;
        };
        if !value.is_finite() || value < 0.0 {
            continue;
        }
        let measurement = measurements.entry((namespace, name)).or_default();
        let field = match metric.as_str() {
            USED => &mut measurement.used,
            CAPACITY if value > 0.0 => &mut measurement.capacity,
            _ => continue,
        };
        *field = Some(field.unwrap_or(value).max(value));
    }
    let mut rows: Vec<_> = measurements
        .into_iter()
        .filter_map(|((namespace, name), measurement)| {
            let used_bytes = measurement.used?;
            let capacity_bytes = measurement.capacity?;
            let used_percent = (used_bytes / capacity_bytes) * 100.0;
            used_percent.is_finite().then(|| PrometheusPvcUsage {
                namespace: namespace.to_string(),
                name: name.to_string(),
                used_bytes,
                capacity_bytes,
                used_percent,
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        b.used_percent
            .total_cmp(&a.used_percent)
            .then_with(|| a.namespace.cmp(&b.namespace))
            .then_with(|| a.name.cmp(&b.name))
    });
    rows.truncate(LIMIT);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prometheus::matchers;

    fn sample(namespace: &str, name: &str, metric: &str, value: f64) -> PromQuerySeries {
        PromQuerySeries {
            labels: BTreeMap::from([
                ("namespace".into(), namespace.into()),
                ("persistentvolumeclaim".into(), name.into()),
                ("__name__".into(), metric.into()),
            ]),
            points: vec![(1_700_000_000_000, value)],
        }
    }

    fn pair(namespace: &str, name: &str, used: f64, capacity: f64) -> [PromQuerySeries; 2] {
        [
            sample(namespace, name, USED, used),
            sample(namespace, name, CAPACITY, capacity),
        ]
    }

    #[test]
    fn ranks_percent_not_bytes_and_returns_only_five() {
        let mut series = Vec::new();
        for i in 1..=7 {
            series.extend(pair("data", &format!("disk-{i}"), i as f64, 10.0));
        }
        series.extend(pair("data", "large-but-empty", 1000.0, 10000.0));
        let result = rows(&series);
        assert_eq!(result.len(), LIMIT);
        assert_eq!(result[0].name, "disk-7");
        assert_eq!(result[0].used_percent, 70.0);
        assert_eq!(result[4].name, "disk-3");
    }

    #[test]
    fn duplicate_scrapes_are_maxed_and_namespace_is_part_of_identity() {
        let mut series = Vec::new();
        series.extend(pair("a", "data", 40.0, 100.0));
        series.extend(pair("a", "data", 45.0, 100.0));
        series.extend(pair("b", "data", 90.0, 100.0));
        let result = rows(&series);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].namespace, "b");
        assert_eq!(result[1].used_bytes, 45.0);
        assert_eq!(result[1].capacity_bytes, 100.0);
        assert_eq!(result[1].used_percent, 45.0);
    }

    #[test]
    fn incomplete_or_invalid_observations_never_become_zero_usage() {
        let mut series = vec![
            sample("data", "missing-capacity", USED, 12.0),
            sample("data", "missing-used", CAPACITY, 100.0),
        ];
        for (name, used, capacity) in [
            ("zero-capacity", 1.0, 0.0),
            ("negative", -1.0, 100.0),
            ("nan-used", f64::NAN, 100.0),
            ("infinite-used", f64::INFINITY, 100.0),
            ("nan-capacity", 1.0, f64::NAN),
            ("infinite-capacity", 1.0, f64::INFINITY),
            ("overflow", f64::MAX, f64::MIN_POSITIVE),
        ] {
            series.extend(pair("data", name, used, capacity));
        }
        series.extend(pair("", "no-namespace", 50.0, 100.0));
        series.extend(pair("data", "", 50.0, 100.0));
        series.extend(pair("data", "actually-empty", 0.0, 100.0));
        let result = rows(&series);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "actually-empty");
        assert_eq!(result[0].used_percent, 0.0);
    }

    #[test]
    fn equal_percentages_sort_by_namespace_and_name_and_overfull_is_preserved() {
        let mut series = Vec::new();
        for (namespace, name) in [("b", "data"), ("a", "z"), ("a", "a")] {
            series.extend(pair(namespace, name, 90.0, 100.0));
        }
        series.extend(pair("data", "overfull", 105.0, 100.0));
        let result = rows(&series);
        assert_eq!(result[0].used_percent, 105.0);
        assert_eq!(result[1].name, "a");
        assert_eq!(result[2].name, "z");
        assert_eq!(result[3].namespace, "b");
    }

    #[test]
    fn shared_cluster_selector_scopes_all_three_vectors() {
        let query = matchers::with_matchers(QUERY, "cluster=\"prod-eu\"");
        assert_eq!(query.matches("cluster=\"prod-eu\"").count(), 3, "{query}");
        assert!(query.contains("and on (namespace, persistentvolumeclaim) topk(5"));
        assert!(!query.contains("sum("));
        assert!(query.contains(" > 0) < +Inf"));
    }
}
