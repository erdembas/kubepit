//! Diff and apply of rendered documents against one cluster.
//!
//! Both take the documents one object per entry (the UI keeps them apart so
//! every result maps back to its source file) and go through exactly the
//! requests `resource_dry_run_yaml` / `resource_apply_yaml` send: server-side
//! apply as field manager `kubepit`, namespaced objects without a namespace
//! get the chosen default namespace.
//!
//! - The dry run (`dryRun=All`) never mutates, runs documents concurrently
//!   and is allowed on read-only clusters.
//! - Apply refuses read-only clusters up front, then applies in dependency
//!   order (namespaces, CRDs, RBAC and config before workloads, see
//!   [`kind_rank`]) and keeps going after a failure, like `kubectl apply`, so
//!   one bad document never hides the others' results. Custom resources
//!   whose CRD was just applied in the same batch are retried briefly while
//!   the API server starts serving the new kind.

use std::time::Duration;

use anyhow::{bail, Result};
use futures::{stream, StreamExt};
use serde_json::Value;

use crate::app::Kubepit;
use crate::resources::parse_documents;
use crate::types::{ApplyMode, DryRunOperation, DryRunResult, ManifestApplyResult};

/// Documents dry-run in parallel against one cluster.
const DRY_RUN_CONCURRENCY: usize = 8;
/// Retries for custom resources while their new CRD becomes served.
const CRD_RETRIES: usize = 5;
const CRD_RETRY_DELAY: Duration = Duration::from_millis(1500);

/// Install order (Helm's, which `kubectl apply` users rely on implicitly by
/// file naming): what others depend on first; unknown kinds (custom
/// resources) last.
const KIND_ORDER: &[&str] = &[
    "Namespace",
    "NetworkPolicy",
    "ResourceQuota",
    "LimitRange",
    "PodSecurityPolicy",
    "PodDisruptionBudget",
    "ServiceAccount",
    "Secret",
    "SecretList",
    "ConfigMap",
    "StorageClass",
    "PersistentVolume",
    "PersistentVolumeClaim",
    "CustomResourceDefinition",
    "ClusterRole",
    "ClusterRoleList",
    "ClusterRoleBinding",
    "ClusterRoleBindingList",
    "Role",
    "RoleList",
    "RoleBinding",
    "RoleBindingList",
    "Service",
    "DaemonSet",
    "Pod",
    "ReplicationController",
    "ReplicaSet",
    "Deployment",
    "HorizontalPodAutoscaler",
    "StatefulSet",
    "Job",
    "CronJob",
    "IngressClass",
    "Ingress",
    "APIService",
    "MutatingWebhookConfiguration",
    "ValidatingWebhookConfiguration",
];

/// Position of `kind` in the install order.
pub fn kind_rank(kind: &str) -> usize {
    KIND_ORDER
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(KIND_ORDER.len())
}

/// Indices of `kinds` in apply order (stable within a rank).
pub fn apply_order(kinds: &[String]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..kinds.len()).collect();
    order.sort_by_key(|&i| kind_rank(&kinds[i]));
    order
}

/// Exactly one object per entry.
pub fn parse_single(yaml: &str) -> Result<Value> {
    let mut docs = parse_documents(yaml)?;
    match docs.len() {
        1 => Ok(docs.remove(0)),
        0 => bail!("the document contains no object"),
        n => bail!("expected one object per document, found {n}"),
    }
}

fn kind_of(yaml: &str) -> String {
    parse_single(yaml)
        .ok()
        .and_then(|v| v.get("kind").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

fn is_not_served(message: &str) -> bool {
    message.contains("is not served by this cluster")
}

fn failed_document(error: String) -> DryRunResult {
    DryRunResult {
        api_version: String::new(),
        kind: String::new(),
        name: String::new(),
        namespace: None,
        operation: DryRunOperation::Create,
        live: None,
        result: None,
        error: Some(error),
    }
}

impl Kubepit {
    /// `manifests_dry_run`: one [`DryRunResult`] per document, in order.
    pub async fn manifests_dry_run(
        &self,
        cluster_id: &str,
        documents: &[String],
        namespace: Option<&str>,
    ) -> Result<Vec<DryRunResult>> {
        if documents.is_empty() {
            bail!("there is nothing to diff");
        }
        let client = self.client(cluster_id).await?;
        let namespace = namespace.filter(|n| !n.trim().is_empty());
        let results = stream::iter(documents.iter().cloned())
            .map(|yaml| self.dry_run_manifest_document(client.clone(), cluster_id, yaml, namespace))
            .buffered(DRY_RUN_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        Ok(results)
    }

    /// `manifests_apply`: server-side apply of every document (see module
    /// docs); one result per document, in input order.
    pub(crate) async fn manifests_apply_unaudited(
        &self,
        cluster_id: &str,
        documents: &[String],
        namespace: Option<&str>,
    ) -> Result<Vec<ManifestApplyResult>> {
        self.ensure_writable(cluster_id, "apply")?;
        if documents.is_empty() {
            bail!("there is nothing to apply");
        }
        let client = self.client(cluster_id).await?;
        let namespace = namespace.filter(|n| !n.trim().is_empty());
        let kinds: Vec<String> = documents.iter().map(|d| kind_of(d)).collect();
        let has_crds = kinds.iter().any(|k| k == "CustomResourceDefinition");
        let mut results: Vec<Option<ManifestApplyResult>> = vec![None; documents.len()];
        for index in apply_order(&kinds) {
            let mut attempt = 0;
            let outcome = loop {
                let outcome = self
                    .apply_manifest_document(&client, cluster_id, &documents[index], namespace)
                    .await;
                match outcome {
                    Err(e) if has_crds && attempt < CRD_RETRIES && is_not_served(&e) => {
                        attempt += 1;
                        tokio::time::sleep(CRD_RETRY_DELAY).await;
                    }
                    other => break other,
                }
            };
            results[index] = Some(match outcome {
                Ok(object) => ManifestApplyResult {
                    object: Some(object),
                    error: None,
                },
                Err(error) => ManifestApplyResult {
                    object: None,
                    error: Some(error),
                },
            });
        }
        Ok(results.into_iter().flatten().collect())
    }

    async fn dry_run_manifest_document(
        &self,
        client: kube::Client,
        cluster_id: &str,
        yaml: String,
        namespace: Option<&str>,
    ) -> DryRunResult {
        match parse_single(&yaml) {
            Ok(mut doc) => {
                self.dry_run_document(&client, cluster_id, &mut doc, ApplyMode::Apply, namespace)
                    .await
            }
            Err(e) => failed_document(format!("{e:#}")),
        }
    }

    async fn apply_manifest_document(
        &self,
        client: &kube::Client,
        cluster_id: &str,
        yaml: &str,
        namespace: Option<&str>,
    ) -> std::result::Result<Value, String> {
        let mut doc = parse_single(yaml).map_err(|e| format!("{e:#}"))?;
        let target = self
            .document_target(client, cluster_id, &mut doc, namespace)
            .await
            .map_err(|e| format!("{e:#}"))?;
        self.apply_document(&target, &mut doc, ApplyMode::Apply, false)
            .await
            .map_err(|e| format!("{e:#}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_order_puts_dependencies_first() {
        let kinds: Vec<String> = [
            "Deployment",
            "Widget",
            "Service",
            "Namespace",
            "ConfigMap",
            "CustomResourceDefinition",
            "Deployment",
            "ValidatingWebhookConfiguration",
        ]
        .iter()
        .map(|k| k.to_string())
        .collect();
        let order: Vec<&str> = apply_order(&kinds)
            .into_iter()
            .map(|i| kinds[i].as_str())
            .collect();
        assert_eq!(
            order,
            vec![
                "Namespace",
                "ConfigMap",
                "CustomResourceDefinition",
                "Service",
                "Deployment",
                "Deployment",
                "ValidatingWebhookConfiguration",
                "Widget",
            ]
        );
        // Stable: equal kinds keep their input order.
        assert_eq!(apply_order(&kinds)[4..6], [0, 6]);
    }

    #[test]
    fn documents_hold_exactly_one_object() {
        assert_eq!(
            parse_single("apiVersion: v1\nkind: ConfigMap\n").unwrap()["kind"],
            "ConfigMap"
        );
        assert!(parse_single("")
            .unwrap_err()
            .to_string()
            .contains("no object"));
        assert!(parse_single("kind: A\n---\nkind: B\n")
            .unwrap_err()
            .to_string()
            .contains("found 2"));
        assert_eq!(kind_of("kind: [broken"), "");
        assert!(is_not_served(
            "example.com/v1 Widget is not served by this cluster: 404"
        ));
    }
}
