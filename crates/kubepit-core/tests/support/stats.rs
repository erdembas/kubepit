//! A fake Prometheus for right-sizing: which of the 16 statistics queries
//! (`prometheus::workload_stats`, Q1–Q16) a request is, the namespaces its
//! selector names, and instant-vector answers.

use serde_json::{json, Value};

use super::Reply;

/// Markers of Q1–Q16, checked in this order (the first match wins).
const MARKERS: [&str; 16] = [
    "quantile_over_time(0.95",
    "max_over_time((max by (namespace, pod, container) (rate(container_cpu",
    "avg_over_time((max by (namespace, pod, container) (rate(",
    "count_over_time((max by (namespace, pod, container) (rate(",
    "max_over_time(container_memory_working_set_bytes",
    "avg_over_time(container_memory_working_set_bytes",
    "count_over_time((max by (namespace, pod, container) (container_memory",
    "count_over_time((max by (namespace, pod, container) (kube_pod_container_status_running",
    "min_over_time(timestamp(",
    "max_over_time(timestamp(",
    "kube_pod_owner",
    "kube_replicaset_owner",
    "kube_job_owner",
    "last_terminated_reason",
    "cfs_throttled_periods",
    "cfs_periods_total",
];

/// The number (1–16) of the statistics query `query`, or `None`.
pub fn stat_query(query: &str) -> Option<u8> {
    MARKERS
        .iter()
        .position(|marker| query.contains(marker))
        .map(|i| i as u8 + 1)
}

/// The namespaces of the query's `namespace=~"a|b"`; `None` for a
/// cluster-wide query.
pub fn named_namespaces(query: &str) -> Option<Vec<String>> {
    let rest = query.split_once(r#"namespace=~""#)?.1;
    let end = rest.find('"')?;
    Some(rest[..end].split('|').map(str::to_string).collect())
}

/// The URL-decoded value of query parameter `key` in `path`.
pub fn param(path: &str, key: &str) -> Option<String> {
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

/// An instant vector of `(labels, value)` series.
pub fn vector(series: Vec<(Value, f64)>) -> Reply {
    let result: Vec<Value> = series
        .into_iter()
        .map(|(labels, value)| json!({"metric": labels, "value": [1_790_000_000, value.to_string()]}))
        .collect();
    Reply::Json(
        200,
        json!({"status": "success", "data": {"resultType": "vector", "result": result}}),
    )
}

/// `series`, each followed by a copy from another scrape instance.
pub fn duplicated(series: Vec<(Value, f64)>) -> Vec<(Value, f64)> {
    series
        .into_iter()
        .flat_map(|(labels, value)| {
            let mut copy = labels.clone();
            copy["instance"] = json!("duplicate");
            [(labels, value), (copy, value)]
        })
        .collect()
}

/// The `/api/v1/query` probe answer (`query=1`).
pub fn scalar_one() -> Reply {
    Reply::Json(
        200,
        json!({"status": "success", "data": {"resultType": "scalar", "result": [1, "1"]}}),
    )
}

/// A Prometheus query error (e.g. a timeout or the sample limit).
pub fn prom_error(message: &str) -> Reply {
    Reply::Json(
        422,
        json!({"status": "error", "errorType": "execution", "error": message}),
    )
}
