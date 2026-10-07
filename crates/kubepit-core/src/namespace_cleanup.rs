//! "Empty a namespace": delete every namespaced resource of one namespace.
//!
//! Two phases, like node maintenance: a read-only `namespace_cleanup_preview`
//! builds the inventory (per-kind object names, in the order they will be
//! deleted), and the mutating `namespace_cleanup_run` (audited in
//! `history/audited.rs`) re-enumerates and deletes it. The run is refused for
//! system namespaces and demands the namespace name as a typed confirmation
//! again, server-side, so the UI's gates cannot be bypassed.
//!
//! Deletion order ([`cleanup_stage`]): controllers first (their objects
//! terminate gracefully), then everything ordinary, standalone Pods, and data
//! (PersistentVolumeClaims) last; Events churn and go at the very end.

use anyhow::{bail, Result};
use futures::{stream, StreamExt};
use kube::api::{DeleteParams, ListParams};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app::Kubepit;
use crate::error::{api_code, is_not_found, kube_error};
use crate::objects::{api_resource, dynamic_api, now_millis};
use crate::types::{ApiResourceInfo, Gvk};

/// Namespaces Kubepit refuses to empty: breaking any of these takes the
/// cluster (control plane or default workloads) down with it.
pub const SYSTEM_NAMESPACES: [&str; 4] =
    ["default", "kube-system", "kube-public", "kube-node-lease"];

/// Concurrent kind listings while building the inventory.
const LIST_CONCURRENCY: usize = 12;
/// Concurrent object deletes within one kind.
const DELETE_CONCURRENCY: usize = 8;
/// Object names kept per kind in the preview.
const PREVIEW_NAMES: usize = 25;
/// Delete errors kept per kind result.
const KEPT_ERRORS: usize = 3;

/// One kind of the plan: what would be deleted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamespaceCleanupKind {
    pub gvk: Gvk,
    pub count: u64,
    /// A bounded sample of the object names.
    pub names: Vec<String>,
}

/// `namespace_cleanup_preview`: everything the run would delete, read-only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamespaceCleanupPlan {
    pub namespace: String,
    /// Epoch ms when the inventory was read.
    pub checked_at: i64,
    pub read_only: bool,
    pub terminating: bool,
    /// Kinds in deletion order ([`cleanup_stage`]).
    pub kinds: Vec<NamespaceCleanupKind>,
    pub total_objects: u64,
    /// False when some kinds could not be listed (RBAC or a broken
    /// aggregated API); those kinds are not part of the plan.
    pub inventory_complete: bool,
    /// Fixed codes; never API error prose.
    pub warnings: Vec<String>,
}

/// `namespace_cleanup_run` request. `confirm_name` must equal `namespace`
/// (checked again server-side): the UI asks the user to type it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamespaceCleanupRequest {
    pub namespace: String,
    pub confirm_name: String,
}

/// How one kind fared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamespaceCleanupKindResult {
    pub gvk: Gvk,
    pub planned: u64,
    pub deleted: u64,
    /// Already gone when the delete reached them (churn).
    pub already_gone: u64,
    pub failed: u64,
    /// First errors, bounded ([`KEPT_ERRORS`]).
    pub errors: Vec<String>,
}

/// `namespace_cleanup_run` receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamespaceCleanupResult {
    pub namespace: String,
    /// Epoch ms.
    pub started_at: i64,
    /// Epoch ms.
    pub finished_at: i64,
    pub kinds: Vec<NamespaceCleanupKindResult>,
    pub deleted: u64,
    pub already_gone: u64,
    pub failed: u64,
    pub inventory_complete: bool,
}

/// The enumerated content of a namespace (the run's input).
#[derive(Debug, Clone)]
pub(crate) struct CleanupKindInventory {
    pub gvk: Gvk,
    pub names: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct CleanupInventory {
    /// In deletion order.
    pub kinds: Vec<CleanupKindInventory>,
    pub terminating: bool,
    pub complete: bool,
}

/// Deletion order: controllers (their owned objects terminate with them)
/// first, ordinary kinds next, unmanaged Pods, then data; Events churn last.
pub fn cleanup_stage(kind: &str) -> u8 {
    match kind {
        "Deployment"
        | "StatefulSet"
        | "DaemonSet"
        | "ReplicaSet"
        | "ReplicationController"
        | "Job"
        | "CronJob" => 0,
        "Pod" => 2,
        "PersistentVolumeClaim" => 3,
        "Event" => 4,
        _ => 1,
    }
}

pub(crate) fn is_system_namespace(namespace: &str) -> bool {
    SYSTEM_NAMESPACES.contains(&namespace.trim())
}

/// Refuse the obviously unsafe: blank or system namespaces, and a typed
/// confirmation that does not name the namespace.
pub(crate) fn validate_cleanup(namespace: &str, confirm_name: Option<&str>) -> Result<String> {
    let ns = namespace.trim();
    if ns.is_empty() {
        bail!("namespace-cleanup:invalid-namespace");
    }
    if is_system_namespace(ns) {
        bail!("namespace-cleanup:system-namespace");
    }
    if let Some(confirm) = confirm_name {
        if confirm.trim() != ns {
            bail!("namespace-cleanup:confirm-mismatch");
        }
    }
    Ok(ns.to_string())
}

fn namespace_resource() -> kube::api::ApiResource {
    api_resource(&Gvk {
        group: String::new(),
        version: "v1".into(),
        kind: "Namespace".into(),
        plural: "namespaces".into(),
        namespaced: false,
    })
}

/// Every namespaced kind the credentials may list and delete (discovery),
/// in deletion order.
fn cleanup_targets(resources: &[ApiResourceInfo]) -> Vec<Gvk> {
    let mut targets: Vec<Gvk> = resources
        .iter()
        .filter(|r| {
            r.namespaced
                && r.kind != "Namespace"
                && r.verbs.iter().any(|v| v == "list")
                && r.verbs.iter().any(|v| v == "delete")
        })
        .map(ApiResourceInfo::gvk)
        .collect();
    targets.sort_by(|a, b| {
        cleanup_stage(&a.kind)
            .cmp(&cleanup_stage(&b.kind))
            .then_with(|| a.group.cmp(&b.group))
            .then_with(|| a.kind.cmp(&b.kind))
    });
    targets
}

impl Kubepit {
    /// Enumerate what a run would delete. A missing namespace is an error;
    /// a kind that cannot be listed only marks the inventory partial.
    pub(crate) async fn namespace_cleanup_inventory(
        &self,
        cluster_id: &str,
        namespace: &str,
    ) -> Result<CleanupInventory> {
        let client = self.client(cluster_id).await?;
        let ns_api = dynamic_api(client.clone(), &namespace_resource(), false, None);
        let namespace_obj = match ns_api.get(namespace).await {
            Ok(obj) => obj,
            Err(e) => {
                let err = kube_error(e).context("failed to read the namespace");
                if api_code(&err) == Some(404) {
                    bail!("namespace-cleanup:not-found");
                }
                return Err(err);
            }
        };
        let terminating = namespace_obj
            .data
            .pointer("/status/phase")
            .and_then(Value::as_str)
            == Some("Terminating");

        let resources = self.api_resources_cached(cluster_id).await?;
        let listed = stream::iter(cleanup_targets(&resources))
            .map(|gvk| {
                let client = client.clone();
                let namespace = namespace.to_string();
                async move {
                    let ar = api_resource(&gvk);
                    let api = dynamic_api(client, &ar, true, Some(&namespace));
                    let list = api.list_metadata(&ListParams::default()).await;
                    (gvk, list)
                }
            })
            .buffer_unordered(LIST_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;

        let mut complete = true;
        let mut kinds = Vec::with_capacity(listed.len());
        for (gvk, list) in listed {
            match list {
                Ok(list) => {
                    let mut names: Vec<String> = list
                        .items
                        .into_iter()
                        .filter_map(|o| o.metadata.name)
                        .collect();
                    if names.is_empty() {
                        continue;
                    }
                    names.sort();
                    kinds.push(CleanupKindInventory { gvk, names });
                }
                Err(e) => {
                    tracing::debug!("namespace cleanup: cannot list {}: {e}", gvk.kind);
                    complete = false;
                }
            }
        }
        kinds.sort_by(|a, b| {
            cleanup_stage(&a.gvk.kind)
                .cmp(&cleanup_stage(&b.gvk.kind))
                .then_with(|| a.gvk.group.cmp(&b.gvk.group))
                .then_with(|| a.gvk.kind.cmp(&b.gvk.kind))
        });
        Ok(CleanupInventory {
            kinds,
            terminating,
            complete,
        })
    }

    /// `namespace_cleanup_preview` (read-only; works on read-only clusters).
    pub async fn namespace_cleanup_preview(
        &self,
        cluster_id: &str,
        namespace: &str,
    ) -> Result<NamespaceCleanupPlan> {
        let cluster = self.cluster_def(cluster_id)?;
        let ns = validate_cleanup(namespace, None)?;
        let inventory = self.namespace_cleanup_inventory(cluster_id, &ns).await?;
        let kinds = inventory
            .kinds
            .iter()
            .map(|kind| NamespaceCleanupKind {
                gvk: kind.gvk.clone(),
                count: kind.names.len() as u64,
                names: kind.names.iter().take(PREVIEW_NAMES).cloned().collect(),
            })
            .collect();
        let mut warnings = Vec::new();
        if inventory.terminating {
            warnings.push("terminating".into());
        }
        if !inventory.complete {
            warnings.push("inventory-partial".into());
        }
        Ok(NamespaceCleanupPlan {
            namespace: ns,
            checked_at: now_millis(),
            read_only: cluster.read_only,
            terminating: inventory.terminating,
            total_objects: inventory.kinds.iter().map(|k| k.names.len() as u64).sum(),
            inventory_complete: inventory.complete,
            kinds,
            warnings,
        })
    }

    /// The deletes of `namespace_cleanup_run` (audited in
    /// `history/audited.rs`, which owns validation and the inventory call).
    pub(crate) async fn namespace_cleanup_run_unaudited(
        &self,
        cluster_id: &str,
        namespace: &str,
        inventory: CleanupInventory,
    ) -> Result<NamespaceCleanupResult> {
        self.ensure_writable(cluster_id, "purge a namespace")?;
        let client = self.client(cluster_id).await?;
        let started_at = now_millis();
        let mut kinds = Vec::with_capacity(inventory.kinds.len());
        for kind in &inventory.kinds {
            let ar = api_resource(&kind.gvk);
            let outcomes = stream::iter(kind.names.iter().cloned())
                .map(|name| {
                    let api = dynamic_api(client.clone(), &ar, true, Some(namespace));
                    async move {
                        match api.delete(&name, &DeleteParams::default()).await {
                            Ok(_) => Ok(name),
                            Err(e) => {
                                let err = kube_error(e);
                                if is_not_found(&err) {
                                    Err((name, None))
                                } else {
                                    Err((name, Some(err)))
                                }
                            }
                        }
                    }
                })
                .buffer_unordered(DELETE_CONCURRENCY)
                .collect::<Vec<_>>()
                .await;
            let mut deleted = 0u64;
            let mut already_gone = 0u64;
            let mut errors: Vec<String> = Vec::new();
            for outcome in outcomes {
                match outcome {
                    Ok(_) => deleted += 1,
                    Err((_, None)) => already_gone += 1,
                    Err((name, Some(e))) => {
                        if errors.len() < KEPT_ERRORS {
                            errors.push(format!("{name}: {e:#}"));
                        }
                    }
                }
            }
            let failed = kind.names.len() as u64 - deleted - already_gone;
            kinds.push(NamespaceCleanupKindResult {
                gvk: kind.gvk.clone(),
                planned: kind.names.len() as u64,
                deleted,
                already_gone,
                failed,
                errors,
            });
        }
        let sum = |f: fn(&NamespaceCleanupKindResult) -> u64| kinds.iter().map(f).sum();
        Ok(NamespaceCleanupResult {
            namespace: namespace.to_string(),
            started_at,
            finished_at: now_millis(),
            deleted: sum(|k| k.deleted),
            already_gone: sum(|k| k.already_gone),
            failed: sum(|k| k.failed),
            inventory_complete: inventory.complete,
            kinds,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(
        group: &str,
        kind: &str,
        plural: &str,
        namespaced: bool,
        verbs: &[&str],
    ) -> ApiResourceInfo {
        ApiResourceInfo {
            group: group.into(),
            version: "v1".into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced,
            api_version: if group.is_empty() {
                "v1".into()
            } else {
                format!("{group}/v1")
            },
            verbs: verbs.iter().map(|v| v.to_string()).collect(),
            short_names: Vec::new(),
            categories: Vec::new(),
        }
    }

    #[test]
    fn controllers_first_data_last_events_at_the_end() {
        let order = |kind: &str| cleanup_stage(kind);
        assert_eq!(order("Deployment"), 0);
        assert_eq!(order("CronJob"), 0);
        assert!(order("Service") > order("StatefulSet"));
        assert!(order("Pod") > order("Service"));
        assert!(order("PersistentVolumeClaim") > order("Pod"));
        assert!(order("Event") > order("PersistentVolumeClaim"));
        assert_eq!(order("Widget"), order("Service"));
    }

    #[test]
    fn only_deletable_namespaced_kinds_are_targets() {
        let resources = vec![
            info("", "Namespace", "namespaces", false, &["list", "delete"]),
            info("", "Node", "nodes", false, &["list", "delete"]),
            info("", "Pod", "pods", true, &["list", "delete"]),
            // No delete verb: cannot be part of the plan.
            info("", "Binding", "bindings", true, &["list", "create"]),
            info(
                "apps",
                "Deployment",
                "deployments",
                true,
                &["list", "delete"],
            ),
        ];
        let targets = cleanup_targets(&resources);
        let kinds: Vec<&str> = targets.iter().map(|t| t.kind.as_str()).collect();
        assert_eq!(kinds, vec!["Deployment", "Pod"]);
    }

    #[test]
    fn requests_are_validated_server_side() {
        assert!(validate_cleanup("  ", None).is_err());
        for system in SYSTEM_NAMESPACES {
            let err = validate_cleanup(system, None).unwrap_err();
            assert!(err.to_string().contains("system-namespace"));
        }
        let ns = validate_cleanup("shop", Some("shop")).unwrap();
        assert_eq!(ns, "shop");
        assert_eq!(
            validate_cleanup(" shop ", Some("shop")).unwrap(),
            "shop",
            "surrounding spaces are trimmed on both sides"
        );
        let err = validate_cleanup("shop", Some("other")).unwrap_err();
        assert!(err.to_string().contains("confirm-mismatch"));
    }

    #[test]
    fn plan_and_result_shape_is_the_ts_contract() {
        let plan: NamespaceCleanupPlan = serde_json::from_value(json!({
            "namespace": "shop",
            "checked_at": 1,
            "read_only": false,
            "terminating": false,
            "kinds": [{"gvk": {"group": "", "version": "v1", "kind": "Pod",
                               "plural": "pods", "namespaced": true},
                       "count": 2, "names": ["a", "b"]}],
            "total_objects": 2,
            "inventory_complete": true,
            "warnings": []
        }))
        .unwrap();
        assert_eq!(plan.kinds[0].count, 2);
        let result: NamespaceCleanupResult = serde_json::from_value(json!({
            "namespace": "shop", "started_at": 1, "finished_at": 2,
            "kinds": [{"gvk": {"group": "", "version": "v1", "kind": "Pod",
                               "plural": "pods", "namespaced": true},
                       "planned": 2, "deleted": 1, "already_gone": 1, "failed": 0,
                       "errors": []}],
            "deleted": 1, "already_gone": 1, "failed": 0, "inventory_complete": true
        }))
        .unwrap();
        assert_eq!(result.kinds[0].planned, 2);
        let request: NamespaceCleanupRequest =
            serde_json::from_value(json!({"namespace": "shop", "confirm_name": "shop"})).unwrap();
        assert_eq!(request.confirm_name, "shop");
    }
}
