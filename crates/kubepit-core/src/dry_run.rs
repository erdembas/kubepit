//! Server-side dry run: "review before apply".
//!
//! Each document goes through exactly the request `resource_apply_yaml`
//! would send (same kind resolution, namespace defaulting, field manager and
//! mode), with `dryRun=All`: admission webhooks, validation and defaulting
//! all run, nothing is persisted. Next to the server's answer the live
//! object is fetched, so the UI can diff "live → what apply would produce".
//!
//! Documents are independent: a rejected document is reported and the rest
//! are still tried, so one review shows every problem at once.

use anyhow::{bail, Result};
use serde_json::Value;

use crate::app::Kubepit;
use crate::error::{is_not_found, kube_error};
use crate::objects::to_kube_object;
use crate::resources::parse_documents;
use crate::types::{ApplyMode, DryRunOperation, DryRunResult};

/// Metadata the server bumps on any write; ignored when deciding whether a
/// dry run changed anything.
const VOLATILE_METADATA: &[&str] = &["resourceVersion", "generation", "managedFields"];

fn comparable(obj: &Value) -> Value {
    let mut copy = obj.clone();
    if let Some(meta) = copy.get_mut("metadata").and_then(Value::as_object_mut) {
        for key in VOLATILE_METADATA {
            meta.remove(*key);
        }
    }
    copy
}

/// What a successful dry run means: `create` without a live object,
/// `unchanged` when the server's result equals the live object (ignoring
/// write bookkeeping), `update` otherwise.
pub fn dry_run_operation(live: Option<&Value>, result: &Value) -> DryRunOperation {
    match live {
        None => DryRunOperation::Create,
        Some(live) if comparable(live) == comparable(result) => DryRunOperation::Unchanged,
        Some(_) => DryRunOperation::Update,
    }
}

fn text(doc: &Value, pointer: &str) -> String {
    doc.pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

impl Kubepit {
    /// `resource_dry_run_yaml`: one [`DryRunResult`] per document, in order.
    ///
    /// A dry run never mutates the cluster, so unlike `resource_apply_yaml`
    /// it is allowed on read-only clusters (reviewing a change is useful
    /// there too); applying the reviewed change still is not.
    pub async fn resource_dry_run_yaml(
        &self,
        cluster_id: &str,
        yaml: &str,
        mode: ApplyMode,
        namespace: Option<&str>,
    ) -> Result<Vec<DryRunResult>> {
        let docs = parse_documents(yaml)?;
        if docs.is_empty() {
            bail!("the YAML contains no objects");
        }
        let client = self.client(cluster_id).await?;
        let mut results = Vec::with_capacity(docs.len());
        for mut doc in docs {
            results.push(
                self.dry_run_document(&client, cluster_id, &mut doc, mode, namespace)
                    .await,
            );
        }
        Ok(results)
    }

    async fn dry_run_document(
        &self,
        client: &kube::Client,
        cluster_id: &str,
        doc: &mut Value,
        mode: ApplyMode,
        namespace: Option<&str>,
    ) -> DryRunResult {
        let mut out = DryRunResult {
            api_version: text(doc, "/apiVersion"),
            kind: text(doc, "/kind"),
            name: match text(doc, "/metadata/name") {
                name if name.is_empty() => text(doc, "/metadata/generateName"),
                name => name,
            },
            namespace: None,
            operation: DryRunOperation::Create,
            live: None,
            result: None,
            error: None,
        };
        let target = match self
            .document_target(client, cluster_id, doc, namespace)
            .await
        {
            Ok(target) => target,
            Err(e) => {
                out.error = Some(format!("{e:#}"));
                return out;
            }
        };
        out.namespace = target.namespace.clone();
        if let Some(name) = &target.name {
            match target.api.get(name).await {
                Ok(obj) => out.live = Some(to_kube_object(obj, &target.ar)),
                Err(e) => {
                    let err = kube_error(e);
                    if !is_not_found(&err) {
                        out.error = Some(format!("failed to read the live object: {err:#}"));
                        return out;
                    }
                }
            }
        }
        let expected = if out.live.is_some() && mode != ApplyMode::Create {
            DryRunOperation::Update
        } else {
            DryRunOperation::Create
        };
        match self.apply_document(&target, doc, mode, true).await {
            Ok(result) => {
                out.operation = match mode {
                    ApplyMode::Create => DryRunOperation::Create,
                    _ => dry_run_operation(out.live.as_ref(), &result),
                };
                if let Some(name) = result.pointer("/metadata/name").and_then(Value::as_str) {
                    out.name = name.to_string();
                }
                out.result = Some(result);
            }
            Err(e) => {
                out.operation = expected;
                out.error = Some(format!("{e:#}"));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn operations_ignore_write_bookkeeping() {
        let live = json!({"metadata": {"name": "a", "resourceVersion": "5", "generation": 2},
                          "spec": {"replicas": 2}});
        let same = json!({"metadata": {"name": "a", "resourceVersion": "5", "generation": 2,
                                       "managedFields": [{"manager": "kubepit"}]},
                          "spec": {"replicas": 2}});
        let bumped = json!({"metadata": {"name": "a", "resourceVersion": "6", "generation": 3},
                            "spec": {"replicas": 3}});
        assert_eq!(dry_run_operation(None, &same), DryRunOperation::Create);
        assert_eq!(
            dry_run_operation(Some(&live), &same),
            DryRunOperation::Unchanged
        );
        assert_eq!(
            dry_run_operation(Some(&live), &bumped),
            DryRunOperation::Update
        );
        assert_eq!(
            serde_json::to_value(DryRunOperation::Unchanged).unwrap(),
            "unchanged"
        );
    }
}
