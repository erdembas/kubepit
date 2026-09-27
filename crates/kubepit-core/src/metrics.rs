//! `metrics.k8s.io/v1beta1` (metrics-server) usage.
//!
//! Many clusters do not run metrics-server. When the API group is not
//! served (404) or registered but unavailable (503), the result is
//! `available: false` instead of an error, so the UI can hide usage columns
//! quietly. Other failures (e.g. 403) are real errors.
//!
//! The UI polls metrics every few seconds. A cluster without metrics-server
//! would answer every poll with a 404, so [`MetricsGate`] remembers that
//! answer per cluster and only asks again after [`RECHECK_AFTER`] (or on
//! reconnect), which keeps both the API server and the logs quiet.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::Result;
use kube::api::{Api, ApiResource, DynamicObject, ListParams};
use kube::Client;
use parking_lot::Mutex;
use serde_json::Value;

use crate::app::Kubepit;
use crate::error::{api_code, kube_error};
use crate::quantity::{cpu_or_zero, memory_or_zero};
use crate::types::{ContainerMetric, MetricsResult, NodeMetric, PodMetric, Quantity};

fn metrics_resource(kind: &str, plural: &str) -> ApiResource {
    ApiResource {
        group: "metrics.k8s.io".into(),
        version: "v1beta1".into(),
        api_version: "metrics.k8s.io/v1beta1".into(),
        kind: kind.into(),
        plural: plural.into(),
    }
}

/// How long an "unavailable" answer is trusted before metrics are tried again,
/// so a metrics-server installed while Kubepit runs is picked up.
pub const RECHECK_AFTER: Duration = Duration::from_secs(5 * 60);

/// Per-cluster memory of "metrics.k8s.io is not served here".
#[derive(Default)]
pub struct MetricsGate {
    unavailable_since: Mutex<HashMap<String, Instant>>,
}

impl MetricsGate {
    /// True while a recent unavailable answer is still trusted.
    pub fn blocked(&self, cluster_id: &str) -> bool {
        self.blocked_at(cluster_id, Instant::now())
    }

    fn blocked_at(&self, cluster_id: &str, now: Instant) -> bool {
        let mut map = self.unavailable_since.lock();
        match map.get(cluster_id) {
            Some(since) if now.duration_since(*since) < RECHECK_AFTER => true,
            Some(_) => {
                map.remove(cluster_id);
                false
            }
            None => false,
        }
    }

    pub fn mark_unavailable(&self, cluster_id: &str) {
        self.unavailable_since
            .lock()
            .insert(cluster_id.to_string(), Instant::now());
    }

    /// Forget the answer (reconnect, removal).
    pub fn forget(&self, cluster_id: &str) {
        self.unavailable_since.lock().remove(cluster_id);
    }
}

/// Status codes that mean "metrics-server is not there".
fn is_unavailable(err: &anyhow::Error) -> bool {
    matches!(api_code(err), Some(404 | 503))
}

fn usage(value: &Value) -> Quantity {
    Quantity {
        cpu_millicores: cpu_or_zero(value.pointer("/usage/cpu").and_then(Value::as_str)),
        memory_bytes: memory_or_zero(value.pointer("/usage/memory").and_then(Value::as_str)),
    }
}

/// Parse one `NodeMetrics` object.
pub fn parse_node_metric(value: &Value) -> Option<NodeMetric> {
    let name = value.pointer("/metadata/name")?.as_str()?.to_string();
    let q = usage(value);
    Some(NodeMetric {
        name,
        cpu_millicores: q.cpu_millicores,
        memory_bytes: q.memory_bytes,
    })
}

/// Parse one `PodMetrics` object; the pod total is the sum of its containers.
pub fn parse_pod_metric(value: &Value) -> Option<PodMetric> {
    let name = value.pointer("/metadata/name")?.as_str()?.to_string();
    let namespace = value
        .pointer("/metadata/namespace")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let containers: Vec<ContainerMetric> = value
        .get("containers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|c| {
                    let q = usage(c);
                    ContainerMetric {
                        name: c
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        cpu_millicores: q.cpu_millicores,
                        memory_bytes: q.memory_bytes,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let mut total = Quantity::default();
    for c in &containers {
        total.add(Quantity {
            cpu_millicores: c.cpu_millicores,
            memory_bytes: c.memory_bytes,
        });
    }
    Some(PodMetric {
        namespace,
        name,
        cpu_millicores: total.cpu_millicores,
        memory_bytes: total.memory_bytes,
        containers,
    })
}

async fn list_metrics(
    client: Client,
    kind: &str,
    plural: &str,
    namespace: Option<&str>,
) -> Result<Option<Vec<Value>>> {
    let ar = metrics_resource(kind, plural);
    let api: Api<DynamicObject> = match namespace.filter(|ns| !ns.is_empty()) {
        Some(ns) => Api::namespaced_with(client, ns, &ar),
        None => Api::all_with(client, &ar),
    };
    match api.list(&ListParams::default()).await {
        Ok(list) => Ok(Some(
            list.items
                .into_iter()
                .filter_map(|o| serde_json::to_value(o).ok())
                .collect(),
        )),
        Err(e) => {
            let err = kube_error(e);
            if is_unavailable(&err) {
                Ok(None)
            } else {
                Err(err.context("failed to read metrics"))
            }
        }
    }
}

/// Node usage for the overview; `None` when metrics-server is unavailable.
pub(crate) async fn node_metrics(client: Client) -> Result<Option<Vec<NodeMetric>>> {
    Ok(list_metrics(client, "NodeMetrics", "nodes", None)
        .await?
        .map(|items| items.iter().filter_map(parse_node_metric).collect()))
}

impl Kubepit {
    /// Node usage honouring the [`MetricsGate`]; `None` = unavailable.
    pub(crate) async fn gated_node_metrics(
        &self,
        cluster_id: &str,
        client: Client,
    ) -> Result<Option<Vec<NodeMetric>>> {
        if self.metrics_gate.blocked(cluster_id) {
            return Ok(None);
        }
        let result = node_metrics(client).await?;
        if result.is_none() {
            self.metrics_gate.mark_unavailable(cluster_id);
        }
        Ok(result)
    }

    /// `metrics_nodes`.
    pub async fn metrics_nodes(&self, cluster_id: &str) -> Result<MetricsResult<NodeMetric>> {
        let client = self.client(cluster_id).await?;
        Ok(match self.gated_node_metrics(cluster_id, client).await? {
            Some(items) => MetricsResult {
                available: true,
                items,
            },
            None => MetricsResult::unavailable(),
        })
    }

    /// `metrics_pods` (`namespace: None` = all namespaces).
    pub async fn metrics_pods(
        &self,
        cluster_id: &str,
        namespace: Option<&str>,
    ) -> Result<MetricsResult<PodMetric>> {
        if self.metrics_gate.blocked(cluster_id) {
            return Ok(MetricsResult::unavailable());
        }
        let client = self.client(cluster_id).await?;
        Ok(
            match list_metrics(client, "PodMetrics", "pods", namespace).await? {
                Some(items) => MetricsResult {
                    available: true,
                    items: items.iter().filter_map(parse_pod_metric).collect(),
                },
                None => {
                    self.metrics_gate.mark_unavailable(cluster_id);
                    MetricsResult::unavailable()
                }
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gate_blocks_until_recheck_or_forget() {
        let gate = MetricsGate::default();
        assert!(!gate.blocked("a"));
        gate.mark_unavailable("a");
        assert!(gate.blocked("a"));
        assert!(!gate.blocked("b"), "other clusters are unaffected");
        let later = Instant::now() + RECHECK_AFTER + Duration::from_secs(1);
        assert!(!gate.blocked_at("a", later), "stale answers expire");
        assert!(!gate.blocked("a"), "expired entries are dropped");
        gate.mark_unavailable("a");
        gate.forget("a");
        assert!(!gate.blocked("a"));
    }

    #[test]
    fn node_metric_parsing() {
        let m = parse_node_metric(&json!({
            "metadata": {"name": "node-1"},
            "timestamp": "2024-01-01T00:00:00Z",
            "window": "10.5s",
            "usage": {"cpu": "123456789n", "memory": "2048Ki"}
        }))
        .unwrap();
        assert_eq!(m.name, "node-1");
        assert!((m.cpu_millicores - 123.456789).abs() < 1e-9);
        assert_eq!(m.memory_bytes, 2048.0 * 1024.0);
        assert!(parse_node_metric(&json!({"usage": {}})).is_none());
    }

    #[test]
    fn pod_metric_sums_containers() {
        let m = parse_pod_metric(&json!({
            "metadata": {"name": "web-0", "namespace": "shop"},
            "containers": [
                {"name": "app", "usage": {"cpu": "250m", "memory": "100Mi"}},
                {"name": "sidecar", "usage": {"cpu": "5000000n", "memory": "10Mi"}}
            ]
        }))
        .unwrap();
        assert_eq!(m.namespace, "shop");
        assert_eq!(m.containers.len(), 2);
        assert_eq!(m.containers[1].name, "sidecar");
        assert_eq!(m.cpu_millicores, 255.0);
        assert_eq!(m.memory_bytes, 110.0 * 1024.0 * 1024.0);
    }

    #[test]
    fn unavailable_codes() {
        let not_found: anyhow::Error = crate::error::ApiError {
            code: 404,
            reason: "NotFound".into(),
            message: "the server could not find the requested resource".into(),
        }
        .into();
        assert!(is_unavailable(&not_found));
        let forbidden: anyhow::Error = crate::error::ApiError {
            code: 403,
            reason: "Forbidden".into(),
            message: "nope".into(),
        }
        .into();
        assert!(!is_unavailable(&forbidden));
    }
}
