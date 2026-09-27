//! Node maintenance: cordon and drain.
//!
//! Drain mirrors `kubectl drain`: cordon, then evict every pod on the node
//! through the Eviction API (so PodDisruptionBudgets are honoured), except
//! DaemonSet-managed pods (they would be recreated immediately) and mirror
//! pods (static pods owned by the kubelet). Pods without a controller would
//! be lost for good, so they block the drain unless `force` is set, in which
//! case they are deleted. PDB rejections are collected and reported
//! together, naming every pod that could not be evicted.

use anyhow::{bail, Context, Result};
use futures::{stream, StreamExt};
use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, DeleteParams, EvictParams, ListParams, Patch, PatchParams};
use serde_json::json;

use crate::app::Kubepit;
use crate::error::{api_code, kube_error};

const EVICTION_CONCURRENCY: usize = 8;
const MIRROR_ANNOTATION: &str = "kubernetes.io/config.mirror";

/// How drain treats each pod on the node.
#[derive(Debug, Default, PartialEq)]
pub struct DrainPlan {
    /// `(namespace, name)` to evict.
    pub evict: Vec<(String, String)>,
    /// Pods with no controller — deleted with `force`, otherwise blocking.
    pub unmanaged: Vec<(String, String)>,
    /// DaemonSet / mirror pods left alone.
    pub skipped: Vec<(String, String)>,
}

fn pod_key(pod: &Pod) -> (String, String) {
    (
        pod.metadata.namespace.clone().unwrap_or_default(),
        pod.metadata.name.clone().unwrap_or_default(),
    )
}

/// Classify the pods of a node for draining.
pub fn plan_drain(pods: &[Pod]) -> DrainPlan {
    let mut plan = DrainPlan::default();
    for pod in pods {
        let key = pod_key(pod);
        let finished = matches!(
            pod.status.as_ref().and_then(|s| s.phase.as_deref()),
            Some("Succeeded" | "Failed")
        );
        let mirror = pod
            .metadata
            .annotations
            .as_ref()
            .is_some_and(|a| a.contains_key(MIRROR_ANNOTATION));
        let controller = pod
            .metadata
            .owner_references
            .as_ref()
            .and_then(|refs| refs.iter().find(|r| r.controller == Some(true)));
        if mirror || controller.is_some_and(|c| c.kind == "DaemonSet") {
            plan.skipped.push(key);
        } else if controller.is_none() && !finished {
            plan.unmanaged.push(key);
        } else {
            plan.evict.push(key);
        }
    }
    plan
}

fn format_pods(pods: &[(String, String)]) -> String {
    pods.iter()
        .map(|(ns, name)| format!("{ns}/{name}"))
        .collect::<Vec<_>>()
        .join(", ")
}

impl Kubepit {
    /// `node_cordon`: set `spec.unschedulable`.
    pub(crate) async fn node_cordon_unaudited(
        &self,
        cluster_id: &str,
        name: &str,
        unschedulable: bool,
    ) -> Result<()> {
        self.ensure_writable(
            cluster_id,
            if unschedulable { "cordon" } else { "uncordon" },
        )?;
        let client = self.client(cluster_id).await?;
        let nodes: Api<Node> = Api::all(client);
        nodes
            .patch(
                name,
                &PatchParams::default(),
                &Patch::Merge(json!({ "spec": { "unschedulable": unschedulable } })),
            )
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to update node {name}"))?;
        Ok(())
    }

    /// `node_drain`.
    pub(crate) async fn node_drain_unaudited(
        &self,
        cluster_id: &str,
        name: &str,
        force: bool,
    ) -> Result<()> {
        self.ensure_writable(cluster_id, "drain")?;
        self.node_cordon_unaudited(cluster_id, name, true).await?;
        let client = self.client(cluster_id).await?;
        let all_pods: Api<Pod> = Api::all(client.clone());
        let pods = all_pods
            .list(&ListParams::default().fields(&format!("spec.nodeName={name}")))
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to list pods on node {name}"))?;
        let plan = plan_drain(&pods.items);

        if !plan.unmanaged.is_empty() && !force {
            bail!(
                "node {name} is cordoned but not drained: {} pod(s) are not managed by a controller \
                 and would be lost ({}). Drain with force to delete them.",
                plan.unmanaged.len(),
                format_pods(&plan.unmanaged)
            );
        }

        let unmanaged = if force {
            plan.unmanaged.clone()
        } else {
            Vec::new()
        };
        let deletions = stream::iter(unmanaged)
            .map(|(ns, pod)| {
                let api: Api<Pod> = Api::namespaced(client.clone(), &ns);
                async move {
                    let result = api.delete(&pod, &DeleteParams::default()).await.map(|_| ());
                    (ns, pod, result.map_err(kube_error))
                }
            })
            .buffer_unordered(EVICTION_CONCURRENCY)
            .collect::<Vec<_>>();
        let evictions = stream::iter(plan.evict.clone())
            .map(|(ns, pod)| {
                let api: Api<Pod> = Api::namespaced(client.clone(), &ns);
                async move {
                    let result = api.evict(&pod, &EvictParams::default()).await.map(|_| ());
                    (ns, pod, result.map_err(kube_error))
                }
            })
            .buffer_unordered(EVICTION_CONCURRENCY)
            .collect::<Vec<_>>();
        let (deleted, evicted) = tokio::join!(deletions, evictions);

        let mut blocked = Vec::new();
        let mut failed = Vec::new();
        for (ns, pod, result) in deleted.into_iter().chain(evicted) {
            match result {
                Ok(()) => {}
                Err(e) if api_code(&e) == Some(404) => {} // already gone
                Err(e) if api_code(&e) == Some(429) => blocked.push(format!("{ns}/{pod}")),
                Err(e) => failed.push(format!("{ns}/{pod}: {e:#}")),
            }
        }
        if blocked.is_empty() && failed.is_empty() {
            return Ok(());
        }
        let mut message = format!("node {name} is cordoned but the drain did not finish.");
        if !blocked.is_empty() {
            message.push_str(&format!(
                "\nBlocked by a PodDisruptionBudget ({}): {}. Retry once replacement pods are ready.",
                blocked.len(),
                blocked.join(", ")
            ));
        }
        if !failed.is_empty() {
            message.push_str(&format!(
                "\nFailed ({}): {}",
                failed.len(),
                failed.join("; ")
            ));
        }
        bail!(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(name: &str, owner: Option<(&str, bool)>, mirror: bool, phase: &str) -> Pod {
        let mut meta = json!({"name": name, "namespace": "ns"});
        if let Some((kind, controller)) = owner {
            meta["ownerReferences"] = json!([{
                "apiVersion": "apps/v1", "kind": kind, "name": "o", "uid": "u",
                "controller": controller
            }]);
        }
        if mirror {
            meta["annotations"] = json!({ MIRROR_ANNOTATION: "hash" });
        }
        serde_json::from_value(json!({"metadata": meta, "status": {"phase": phase}})).unwrap()
    }

    #[test]
    fn drain_plan_classifies_pods() {
        let pods = vec![
            pod("rs-pod", Some(("ReplicaSet", true)), false, "Running"),
            pod("ds-pod", Some(("DaemonSet", true)), false, "Running"),
            pod("static", None, true, "Running"),
            pod("naked", None, false, "Running"),
            pod("done", None, false, "Succeeded"),
            pod("weird-owner", Some(("ReplicaSet", false)), false, "Running"),
        ];
        let plan = plan_drain(&pods);
        let names =
            |v: &Vec<(String, String)>| v.iter().map(|(_, n)| n.clone()).collect::<Vec<_>>();
        assert_eq!(names(&plan.evict), vec!["rs-pod", "done"]);
        assert_eq!(names(&plan.skipped), vec!["ds-pod", "static"]);
        assert_eq!(names(&plan.unmanaged), vec!["naked", "weird-owner"]);
        assert_eq!(format_pods(&plan.unmanaged), "ns/naked, ns/weird-owner");
    }
}
