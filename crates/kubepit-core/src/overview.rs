//! Cluster overview dashboard.
//!
//! All inputs are listed concurrently (`tokio::join!`). Users often have
//! partial RBAC — e.g. namespace-scoped developers cannot list nodes — so a
//! 403 on any single part yields zeros for that part instead of failing the
//! whole page. Other failures (network, auth) are real errors.

use anyhow::Result;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Node, Pod};
use kube::api::{Api, ApiResource, DynamicObject, ListParams};
use kube::Client;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::app::Kubepit;
use crate::error::{is_forbidden, kube_error};
use crate::objects::{sort_events_newest_first, to_kube_object};
use crate::quantity::{cpu_or_zero, memory_or_zero, parse_quantity};
use crate::types::{Capacity, ClusterOverview, DeploymentCounts, NodeCounts, PodCounts, Quantity};

/// How many warning events the overview shows.
pub const MAX_WARNINGS: usize = 50;

/// Node counts plus summed capacity / allocatable.
pub fn summarize_nodes(nodes: &[Node]) -> (NodeCounts, Capacity, Capacity) {
    let mut counts = NodeCounts::default();
    let mut capacity = Capacity::default();
    let mut allocatable = Capacity::default();
    for node in nodes {
        counts.total += 1;
        let status = node.status.as_ref();
        let ready = status
            .and_then(|s| s.conditions.as_ref())
            .is_some_and(|conds| {
                conds
                    .iter()
                    .any(|c| c.type_ == "Ready" && c.status == "True")
            });
        if ready {
            counts.ready += 1;
        }
        let add = |target: &mut Capacity,
                   map: Option<
            &std::collections::BTreeMap<
                String,
                k8s_openapi::apimachinery::pkg::api::resource::Quantity,
            >,
        >| {
            if let Some(map) = map {
                target.cpu_millicores += cpu_or_zero(map.get("cpu").map(|q| q.0.as_str()));
                target.memory_bytes += memory_or_zero(map.get("memory").map(|q| q.0.as_str()));
                target.pods += map
                    .get("pods")
                    .and_then(|q| parse_quantity(&q.0))
                    .map(|p| p.max(0.0) as u64)
                    .unwrap_or(0);
            }
        };
        add(&mut capacity, status.and_then(|s| s.capacity.as_ref()));
        add(
            &mut allocatable,
            status.and_then(|s| s.allocatable.as_ref()),
        );
    }
    (counts, capacity, allocatable)
}

/// Pod phase counts plus summed container requests / limits of pods that
/// still hold resources (not Succeeded / Failed).
pub fn summarize_pods(pods: &[Pod]) -> (PodCounts, Quantity, Quantity) {
    let mut counts = PodCounts::default();
    let mut requests = Quantity::default();
    let mut limits = Quantity::default();
    for pod in pods {
        counts.total += 1;
        let phase = pod
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .unwrap_or("Unknown");
        match phase {
            "Running" => counts.running += 1,
            "Pending" => counts.pending += 1,
            "Failed" => counts.failed += 1,
            "Succeeded" => counts.succeeded += 1,
            _ => counts.unknown += 1,
        }
        if matches!(phase, "Succeeded" | "Failed") {
            continue;
        }
        let Some(spec) = pod.spec.as_ref() else {
            continue;
        };
        for container in &spec.containers {
            let Some(resources) = container.resources.as_ref() else {
                continue;
            };
            if let Some(req) = resources.requests.as_ref() {
                requests.cpu_millicores += cpu_or_zero(req.get("cpu").map(|q| q.0.as_str()));
                requests.memory_bytes += memory_or_zero(req.get("memory").map(|q| q.0.as_str()));
            }
            if let Some(lim) = resources.limits.as_ref() {
                limits.cpu_millicores += cpu_or_zero(lim.get("cpu").map(|q| q.0.as_str()));
                limits.memory_bytes += memory_or_zero(lim.get("memory").map(|q| q.0.as_str()));
            }
        }
    }
    (counts, requests, limits)
}

/// Deployments whose available replicas reached the desired count.
pub fn summarize_deployments(deployments: &[Deployment]) -> DeploymentCounts {
    let mut counts = DeploymentCounts::default();
    for d in deployments {
        counts.total += 1;
        let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let available = d
            .status
            .as_ref()
            .and_then(|s| s.available_replicas)
            .unwrap_or(0);
        if available >= desired {
            counts.available += 1;
        }
    }
    counts
}

/// Newest `limit` events, managedFields stripped.
pub fn latest_events(mut events: Vec<Value>, limit: usize) -> Vec<Value> {
    sort_events_newest_first(&mut events);
    events.truncate(limit);
    events
}

/// List `K` cluster-wide; a 403 becomes an empty list.
async fn list_or_empty<K>(client: Client, lp: ListParams) -> Result<Vec<K>>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + DeserializeOwned
        + std::fmt::Debug,
    K::DynamicType: Default,
{
    let api: Api<K> = Api::all(client);
    tolerate_forbidden(api.list(&lp).await.map(|l| l.items))
}

fn tolerate_forbidden<T: Default>(result: Result<T, kube::Error>) -> Result<T> {
    match result {
        Ok(v) => Ok(v),
        Err(e) => {
            let err = kube_error(e);
            if is_forbidden(&err) {
                Ok(T::default())
            } else {
                Err(err)
            }
        }
    }
}

fn events_resource() -> ApiResource {
    ApiResource {
        group: String::new(),
        version: "v1".into(),
        api_version: "v1".into(),
        kind: "Event".into(),
        plural: "events".into(),
    }
}

impl Kubepit {
    /// `cluster_overview`.
    pub async fn cluster_overview(&self, cluster_id: &str) -> Result<ClusterOverview> {
        let client = self.client(cluster_id).await?;
        let status = self.cluster_status(cluster_id);

        let nodes_api: Api<Node> = Api::all(client.clone());
        let namespaces_api: Api<Namespace> = Api::all(client.clone());
        let ar = events_resource();
        let events_api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        let warnings_lp = ListParams::default().fields("type=Warning");

        let (nodes, pods, deployments, namespaces, events, metrics) = tokio::join!(
            async {
                tolerate_forbidden(
                    nodes_api
                        .list(&ListParams::default())
                        .await
                        .map(|l| l.items),
                )
            },
            list_or_empty::<Pod>(client.clone(), ListParams::default()),
            list_or_empty::<Deployment>(client.clone(), ListParams::default()),
            async {
                tolerate_forbidden(
                    namespaces_api
                        .list_metadata(&ListParams::default())
                        .await
                        .map(|l| l.items.len() as u64),
                )
            },
            async { tolerate_forbidden(events_api.list(&warnings_lp).await.map(|l| l.items)) },
            async {
                match self.gated_node_metrics(cluster_id, client.clone()).await {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::debug!("overview: node metrics unavailable: {e:#}");
                        None
                    }
                }
            },
        );

        let (node_counts, capacity, allocatable) = summarize_nodes(&nodes?);
        let (pod_counts, requests, limits) = summarize_pods(&pods?);
        let deployment_counts = summarize_deployments(&deployments?);
        let warnings = latest_events(
            events?
                .into_iter()
                .map(|e| to_kube_object(e, &ar))
                .collect(),
            MAX_WARNINGS,
        );
        let usage = metrics.map(|items| {
            let mut total = Quantity::default();
            for m in items {
                total.add(Quantity {
                    cpu_millicores: m.cpu_millicores,
                    memory_bytes: m.memory_bytes,
                });
            }
            total
        });

        Ok(ClusterOverview {
            version: status.version,
            platform: status.platform,
            nodes: node_counts,
            pods: pod_counts,
            namespaces: namespaces?,
            deployments: deployment_counts,
            capacity,
            allocatable,
            requests,
            limits,
            usage,
            warnings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(ready: &str, cpu: &str, mem: &str, pods: &str) -> Node {
        serde_json::from_value(json!({
            "metadata": {"name": "n"},
            "status": {
                "conditions": [{"type": "Ready", "status": ready}],
                "capacity": {"cpu": cpu, "memory": mem, "pods": pods},
                "allocatable": {"cpu": "1900m", "memory": "3Gi", "pods": pods}
            }
        }))
        .unwrap()
    }

    fn pod(phase: &str, req_cpu: &str, lim_mem: &str) -> Pod {
        serde_json::from_value(json!({
            "metadata": {"name": "p"},
            "spec": {"containers": [
                {"name": "a", "resources": {"requests": {"cpu": req_cpu, "memory": "64Mi"},
                                            "limits": {"memory": lim_mem}}},
                {"name": "b"}
            ]},
            "status": {"phase": phase}
        }))
        .unwrap()
    }

    #[test]
    fn nodes_are_counted_and_summed() {
        let (counts, capacity, allocatable) = summarize_nodes(&[
            node("True", "2", "4Gi", "110"),
            node("False", "4", "8Gi", "110"),
        ]);
        assert_eq!(counts, NodeCounts { total: 2, ready: 1 });
        assert_eq!(capacity.cpu_millicores, 6000.0);
        assert_eq!(capacity.memory_bytes, 12.0 * 1024f64.powi(3));
        assert_eq!(capacity.pods, 220);
        assert_eq!(allocatable.cpu_millicores, 3800.0);
    }

    #[test]
    fn pods_counted_by_phase_and_terminated_pods_hold_no_resources() {
        let pods = [
            pod("Running", "250m", "128Mi"),
            pod("Pending", "500m", "256Mi"),
            pod("Succeeded", "1", "1Gi"),
            pod("Failed", "1", "1Gi"),
        ];
        let (counts, requests, limits) = summarize_pods(&pods);
        assert_eq!(
            counts,
            PodCounts {
                total: 4,
                running: 1,
                pending: 1,
                failed: 1,
                succeeded: 1,
                unknown: 0
            }
        );
        assert_eq!(requests.cpu_millicores, 750.0);
        assert_eq!(requests.memory_bytes, 128.0 * 1024.0 * 1024.0);
        assert_eq!(limits.memory_bytes, 384.0 * 1024.0 * 1024.0);
        assert_eq!(limits.cpu_millicores, 0.0);
    }

    #[test]
    fn deployments_available_when_ready_replicas_reach_spec() {
        let deps: Vec<Deployment> = vec![
            serde_json::from_value(json!({"metadata": {"name": "a"}, "spec": {"replicas": 3, "selector": {}, "template": {}}, "status": {"availableReplicas": 3}})).unwrap(),
            serde_json::from_value(json!({"metadata": {"name": "b"}, "spec": {"replicas": 3, "selector": {}, "template": {}}, "status": {"availableReplicas": 1}})).unwrap(),
            serde_json::from_value(json!({"metadata": {"name": "c"}, "spec": {"replicas": 0, "selector": {}, "template": {}}, "status": {}})).unwrap(),
        ];
        assert_eq!(
            summarize_deployments(&deps),
            DeploymentCounts {
                total: 3,
                available: 2
            }
        );
    }

    #[test]
    fn warnings_are_newest_first_and_capped() {
        let events: Vec<Value> = (0..60)
            .map(|i| {
                json!({"metadata": {"name": format!("e{i}")},
                       "lastTimestamp": format!("2024-01-01T00:{:02}:00Z", i)})
            })
            .collect();
        let latest = latest_events(events, MAX_WARNINGS);
        assert_eq!(latest.len(), 50);
        assert_eq!(latest[0]["metadata"]["name"], "e59");
        assert_eq!(latest[49]["metadata"]["name"], "e10");
    }
}
