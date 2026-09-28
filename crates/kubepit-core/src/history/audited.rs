//! The public entry points of every mutating command: each records an audit
//! entry around the unaudited implementation next to its domain code
//! (`resources.rs`, `nodes.rs`, `helm.rs`, …). Keeping the wrappers here
//! means every caller — IPC commands, internal flows, future custom
//! actions — is covered, and the domain modules only gained a name suffix.
//!
//! Each wrapper follows the same shape: [`Kubepit::audit`] (which returns
//! `None` when nothing is recorded, including read-only rejections), the
//! cheaply available before-state, the call, the after-state from its
//! response, [`Audit::finish`].

use anyhow::Result;
use serde_json::{json, Value};

use super::audit::{Audit, MAX_CAPTURED_OBJECTS};
use super::redact;
use super::types::{AuditAction, AuditTarget};
use crate::app::Kubepit;
use crate::manifests::apply::parse_single;
use crate::node_shell::NodeShellPod;
use crate::objects::to_kube_object;
use crate::resources::parse_documents;
use crate::types::{
    ApplyMode, ContainerImage, DeleteOptions, Gvk, HelmInstallRequest, HelmInstallResult,
    HelmUpgradeRequest, KubeObject, ManifestApplyResult, PatchType, PodDebugRequest, PodFsTransfer,
};

fn str_at<'a>(doc: &'a Value, pointer: &str) -> Option<&'a str> {
    doc.pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// Target of a manifest document before discovery resolved it.
fn doc_audit_target(doc: &Value, namespace: Option<&str>) -> AuditTarget {
    AuditTarget::document(
        str_at(doc, "/apiVersion").unwrap_or(""),
        str_at(doc, "/kind").unwrap_or("object"),
        str_at(doc, "/metadata/namespace").or(namespace),
        str_at(doc, "/metadata/name")
            .or_else(|| str_at(doc, "/metadata/generateName"))
            .unwrap_or("?"),
    )
}

fn helm_result(result: &Result<HelmInstallResult>) -> Option<String> {
    let release = result.as_ref().ok()?.release.as_ref()?;
    Some(format!(
        "revision {} ({})",
        release.revision, release.status
    ))
}

impl Kubepit {
    /// Resolve each document like the apply does (kind through discovery,
    /// namespace settled) and read its live version. Bounded: at most
    /// [`MAX_CAPTURED_OBJECTS`] documents, sequential, each GET time-boxed.
    async fn capture_documents(
        &self,
        cluster_id: &str,
        docs: &[Value],
        namespace: Option<&str>,
        audit: &mut Audit,
    ) -> Vec<Option<Value>> {
        let mut before = vec![None; docs.len()];
        if docs.len() > MAX_CAPTURED_OBJECTS {
            return before;
        }
        let Ok(client) = self.client(cluster_id).await else {
            return before;
        };
        for (index, doc) in docs.iter().enumerate() {
            let mut doc = doc.clone();
            let captured = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                let target = self
                    .document_target(&client, cluster_id, &mut doc, namespace)
                    .await
                    .ok()?;
                let name = target.name.clone()?;
                let gvk = Gvk {
                    group: target.ar.group.clone(),
                    version: target.ar.version.clone(),
                    kind: target.ar.kind.clone(),
                    plural: target.ar.plural.clone(),
                    namespaced: target.namespace.is_some(),
                };
                let resolved = AuditTarget::object(&gvk, target.namespace.as_deref(), &name);
                let live = target
                    .api
                    .get(&name)
                    .await
                    .ok()
                    .map(|o| to_kube_object(o, &target.ar));
                Some((resolved, live))
            })
            .await
            .ok()
            .flatten();
            if let Some((resolved, live)) = captured {
                audit.set_target(index, resolved);
                before[index] = live;
            }
        }
        before
    }

    /// `resource_apply_yaml` (apply / replace / create), audited.
    pub async fn resource_apply_yaml(
        &self,
        cluster_id: &str,
        yaml: &str,
        mode: ApplyMode,
        namespace: Option<&str>,
    ) -> Result<Vec<KubeObject>> {
        let action = match mode {
            ApplyMode::Apply => AuditAction::Apply,
            ApplyMode::Replace => AuditAction::Replace,
            ApplyMode::Create => AuditAction::Create,
        };
        let docs = parse_documents(yaml).unwrap_or_default();
        let targets = docs
            .iter()
            .map(|d| doc_audit_target(d, namespace))
            .collect();
        let Some(mut audit) = self.audit(cluster_id, action, false, targets) else {
            return self
                .resource_apply_yaml_unaudited(cluster_id, yaml, mode, namespace)
                .await;
        };
        audit.request(json!({"namespace": namespace, "documents": docs.len()}));
        let before = self
            .capture_documents(cluster_id, &docs, namespace, &mut audit)
            .await;
        let result = self
            .resource_apply_yaml_unaudited(cluster_id, yaml, mode, namespace)
            .await;
        if let Ok(objects) = &result {
            for (index, after) in objects.iter().enumerate() {
                let live = before.get(index).and_then(Option::as_ref);
                audit.object(index, live, Some(after), &self.history.redactor);
            }
        }
        audit.finish(self, &result);
        result
    }

    /// `resource_delete`, audited (the deleted object is kept as "before").
    pub async fn resource_delete(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
        options: DeleteOptions,
    ) -> Result<()> {
        let target = AuditTarget::object(gvk, namespace, name);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::Delete, false, vec![target])
        else {
            return self
                .resource_delete_unaudited(cluster_id, gvk, namespace, name, options)
                .await;
        };
        audit.request(serde_json::to_value(&options).unwrap_or(Value::Null));
        let before = self.audit_fetch(cluster_id, gvk, namespace, name).await;
        let result = self
            .resource_delete_unaudited(cluster_id, gvk, namespace, name, options)
            .await;
        audit.object(0, before.as_ref(), None, &self.history.redactor);
        audit.finish(self, &result);
        result
    }

    /// `resource_patch`, audited (patch bodies to Secrets are redacted).
    pub async fn resource_patch(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
        patch: Value,
        patch_type: PatchType,
    ) -> Result<KubeObject> {
        let target = AuditTarget::object(gvk, namespace, name);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::Patch, false, vec![target])
        else {
            return self
                .resource_patch_unaudited(cluster_id, gvk, namespace, name, patch, patch_type)
                .await;
        };
        audit.request(json!({
            "patch_type": patch_type,
            "patch": redact::redact_patch(&gvk.kind, &patch, &self.history.redactor),
        }));
        let before = self.audit_fetch(cluster_id, gvk, namespace, name).await;
        let result = self
            .resource_patch_unaudited(cluster_id, gvk, namespace, name, patch, patch_type)
            .await;
        if let Ok(after) = &result {
            audit.object(0, before.as_ref(), Some(after), &self.history.redactor);
        }
        audit.finish(self, &result);
        result
    }

    /// `resource_scale`, audited (after = before with the new replicas).
    pub async fn resource_scale(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: &str,
        name: &str,
        replicas: i64,
    ) -> Result<()> {
        let target = AuditTarget::object(gvk, Some(namespace), name);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::Scale, false, vec![target])
        else {
            return self
                .resource_scale_unaudited(cluster_id, gvk, namespace, name, replicas)
                .await;
        };
        let before = self
            .audit_fetch(cluster_id, gvk, Some(namespace), name)
            .await;
        let previous = before
            .as_ref()
            .and_then(|b| b.pointer("/spec/replicas"))
            .cloned();
        audit.request(json!({"replicas": replicas, "previous": previous}));
        let result = self
            .resource_scale_unaudited(cluster_id, gvk, namespace, name, replicas)
            .await;
        if result.is_ok() {
            if let Some(before) = &before {
                let mut after = before.clone();
                if let Some(spec) = after.get_mut("spec").and_then(Value::as_object_mut) {
                    spec.insert("replicas".into(), json!(replicas));
                }
                audit.object(0, Some(before), Some(&after), &self.history.redactor);
            }
        }
        audit.finish(self, &result);
        result
    }

    /// `resource_restart`, audited.
    pub async fn resource_restart(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: &str,
        name: &str,
    ) -> Result<()> {
        let target = AuditTarget::object(gvk, Some(namespace), name);
        let Some(audit) = self.audit(cluster_id, AuditAction::Restart, false, vec![target]) else {
            return self
                .resource_restart_unaudited(cluster_id, gvk, namespace, name)
                .await;
        };
        let result = self
            .resource_restart_unaudited(cluster_id, gvk, namespace, name)
            .await;
        audit.finish(self, &result);
        result
    }

    /// `cronjob_trigger`, audited (the created Job is the result).
    pub async fn cronjob_trigger(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
    ) -> Result<String> {
        let target = AuditTarget {
            api_version: "batch/v1".into(),
            kind: "CronJob".into(),
            gvk: Some(Gvk {
                group: "batch".into(),
                version: "v1".into(),
                kind: "CronJob".into(),
                plural: "cronjobs".into(),
                namespaced: true,
            }),
            namespace: Some(namespace.to_string()),
            name: name.to_string(),
            error: None,
        };
        let Some(mut audit) =
            self.audit(cluster_id, AuditAction::CronjobTrigger, false, vec![target])
        else {
            return self
                .cronjob_trigger_unaudited(cluster_id, namespace, name)
                .await;
        };
        let result = self
            .cronjob_trigger_unaudited(cluster_id, namespace, name)
            .await;
        if let Ok(job) = &result {
            audit.result(format!("Job {namespace}/{job}"));
        }
        audit.finish(self, &result);
        result
    }

    /// `node_cordon` (cordon / uncordon), audited.
    pub async fn node_cordon(
        &self,
        cluster_id: &str,
        name: &str,
        unschedulable: bool,
    ) -> Result<()> {
        let action = if unschedulable {
            AuditAction::Cordon
        } else {
            AuditAction::Uncordon
        };
        let target = AuditTarget::core("Node", None, name);
        let Some(audit) = self.audit(cluster_id, action, false, vec![target]) else {
            return self
                .node_cordon_unaudited(cluster_id, name, unschedulable)
                .await;
        };
        let result = self
            .node_cordon_unaudited(cluster_id, name, unschedulable)
            .await;
        audit.finish(self, &result);
        result
    }

    /// `node_drain`, audited (one entry; the cordon inside is not separate).
    pub async fn node_drain(&self, cluster_id: &str, name: &str, force: bool) -> Result<()> {
        let target = AuditTarget::core("Node", None, name);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::Drain, false, vec![target])
        else {
            return self.node_drain_unaudited(cluster_id, name, force).await;
        };
        audit.request(json!({"force": force}));
        let result = self.node_drain_unaudited(cluster_id, name, force).await;
        audit.finish(self, &result);
        result
    }

    /// `rollout_undo`, audited.
    pub async fn rollout_undo(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: &str,
        name: &str,
        revision: i64,
    ) -> Result<()> {
        let target = AuditTarget::object(gvk, Some(namespace), name);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::RolloutUndo, false, vec![target])
        else {
            return self
                .rollout_undo_unaudited(cluster_id, gvk, namespace, name, revision)
                .await;
        };
        audit.request(json!({"revision": revision}));
        let result = self
            .rollout_undo_unaudited(cluster_id, gvk, namespace, name, revision)
            .await;
        audit.finish(self, &result);
        result
    }

    /// `resource_set_image`, audited.
    pub async fn resource_set_image(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
        images: Vec<ContainerImage>,
    ) -> Result<KubeObject> {
        let target = AuditTarget::object(gvk, namespace, name);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::SetImage, false, vec![target])
        else {
            return self
                .resource_set_image_unaudited(cluster_id, gvk, namespace, name, images)
                .await;
        };
        audit.request(json!({"images": images}));
        let before = self.audit_fetch(cluster_id, gvk, namespace, name).await;
        let result = self
            .resource_set_image_unaudited(cluster_id, gvk, namespace, name, images)
            .await;
        if let Ok(after) = &result {
            audit.object(0, before.as_ref(), Some(after), &self.history.redactor);
        }
        audit.finish(self, &result);
        result
    }

    /// `helm_rollback`, audited.
    pub async fn helm_rollback(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
        revision: i64,
    ) -> Result<()> {
        let target = AuditTarget::helm_release(namespace, name);
        let Some(mut audit) =
            self.audit(cluster_id, AuditAction::HelmRollback, false, vec![target])
        else {
            return self
                .helm_rollback_unaudited(cluster_id, namespace, name, revision)
                .await;
        };
        audit.request(json!({"revision": revision}));
        let result = self
            .helm_rollback_unaudited(cluster_id, namespace, name, revision)
            .await;
        audit.finish(self, &result);
        result
    }

    /// `helm_uninstall`, audited.
    pub async fn helm_uninstall(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
    ) -> Result<()> {
        let target = AuditTarget::helm_release(namespace, name);
        let Some(audit) = self.audit(cluster_id, AuditAction::HelmUninstall, false, vec![target])
        else {
            return self
                .helm_uninstall_unaudited(cluster_id, namespace, name)
                .await;
        };
        let result = self
            .helm_uninstall_unaudited(cluster_id, namespace, name)
            .await;
        audit.finish(self, &result);
        result
    }

    /// `helm_upgrade_values`, audited (values keep their keys only).
    pub async fn helm_upgrade_values(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
        values: &str,
    ) -> Result<()> {
        let target = AuditTarget::helm_release(namespace, name);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::HelmUpgrade, false, vec![target])
        else {
            return self
                .helm_upgrade_values_unaudited(cluster_id, namespace, name, values)
                .await;
        };
        audit.request(json!({
            "values": redact::redact_values_yaml(values, &self.history.redactor),
        }));
        let result = self
            .helm_upgrade_values_unaudited(cluster_id, namespace, name, values)
            .await;
        audit.finish(self, &result);
        result
    }

    /// `helm_install`, audited (dry runs too, flagged).
    pub async fn helm_install(
        &self,
        cluster_id: &str,
        request: &HelmInstallRequest,
    ) -> Result<HelmInstallResult> {
        let target = AuditTarget::helm_release(&request.namespace, &request.release_name);
        let Some(mut audit) = self.audit(
            cluster_id,
            AuditAction::HelmInstall,
            request.dry_run,
            vec![target],
        ) else {
            return self.helm_install_unaudited(cluster_id, request).await;
        };
        audit.request(json!({
            "chart_ref": request.chart_ref,
            "version": request.version,
            "create_namespace": request.create_namespace,
            "wait": request.wait,
            "atomic": request.atomic,
            "timeout_secs": request.timeout_secs,
            "description": request.description,
            "values": redact::redact_values_yaml(&request.values_yaml, &self.history.redactor),
        }));
        let result = self.helm_install_unaudited(cluster_id, request).await;
        if let Some(text) = helm_result(&result) {
            audit.result(text);
        }
        audit.finish(self, &result);
        result
    }

    /// `helm_upgrade`, audited (dry runs too, flagged).
    pub async fn helm_upgrade(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
        request: &HelmUpgradeRequest,
    ) -> Result<HelmInstallResult> {
        let target = AuditTarget::helm_release(namespace, name);
        let Some(mut audit) = self.audit(
            cluster_id,
            AuditAction::HelmUpgrade,
            request.dry_run,
            vec![target],
        ) else {
            return self
                .helm_upgrade_unaudited(cluster_id, namespace, name, request)
                .await;
        };
        audit.request(json!({
            "chart_ref": request.chart_ref,
            "version": request.version,
            "reuse_values": request.reuse_values,
            "reset_values": request.reset_values,
            "wait": request.wait,
            "atomic": request.atomic,
            "timeout_secs": request.timeout_secs,
            "values": redact::redact_values_yaml(&request.values_yaml, &self.history.redactor),
        }));
        let result = self
            .helm_upgrade_unaudited(cluster_id, namespace, name, request)
            .await;
        if let Some(text) = helm_result(&result) {
            audit.result(text);
        }
        audit.finish(self, &result);
        result
    }

    /// `manifests_apply`, audited: one entry, one target per document; the
    /// entry fails when any document failed.
    pub async fn manifests_apply(
        &self,
        cluster_id: &str,
        documents: &[String],
        namespace: Option<&str>,
    ) -> Result<Vec<ManifestApplyResult>> {
        let namespace_param = namespace.filter(|n| !n.trim().is_empty());
        let docs: Vec<Value> = documents
            .iter()
            .map(|d| parse_single(d).unwrap_or(Value::Null))
            .collect();
        let targets = docs
            .iter()
            .map(|d| doc_audit_target(d, namespace_param))
            .collect();
        let Some(mut audit) = self.audit(cluster_id, AuditAction::ManifestsApply, false, targets)
        else {
            return self
                .manifests_apply_unaudited(cluster_id, documents, namespace)
                .await;
        };
        audit.request(json!({"namespace": namespace_param, "documents": documents.len()}));
        let before = self
            .capture_documents(cluster_id, &docs, namespace_param, &mut audit)
            .await;
        let result = self
            .manifests_apply_unaudited(cluster_id, documents, namespace)
            .await;
        if let Ok(results) = &result {
            let mut failed = 0;
            for (index, outcome) in results.iter().enumerate() {
                if let Some(error) = &outcome.error {
                    failed += 1;
                    audit.target_error(index, error.clone());
                }
                let live = before.get(index).and_then(Option::as_ref);
                audit.object(index, live, outcome.object.as_ref(), &self.history.redactor);
            }
            if failed > 0 {
                audit.fail(format!("{failed} of {} documents failed", results.len()));
            }
        }
        audit.finish(self, &result);
        result
    }

    /// `pod_debug`, audited (the debug container is the result).
    pub async fn pod_debug(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        request: PodDebugRequest,
    ) -> Result<String> {
        let target = AuditTarget::core("Pod", Some(namespace), pod);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::PodDebug, false, vec![target])
        else {
            return self
                .pod_debug_unaudited(cluster_id, namespace, pod, request)
                .await;
        };
        audit.request(json!({
            "image": request.image,
            "target_container": request.target_container,
            "name": request.name,
            "profile": request.profile,
        }));
        let result = self
            .pod_debug_unaudited(cluster_id, namespace, pod, request)
            .await;
        if let Ok(container) = &result {
            audit.result(format!("container {container}"));
        }
        audit.finish(self, &result);
        result
    }

    /// `pod_fs_upload`, audited (file name and destination; never contents).
    pub async fn pod_fs_upload(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        container: Option<&str>,
        local_path: &str,
        remote_dir: &str,
    ) -> Result<PodFsTransfer> {
        let target = AuditTarget::core("Pod", Some(namespace), pod);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::FileUpload, false, vec![target])
        else {
            return self
                .pod_fs_upload_unaudited(
                    cluster_id, namespace, pod, container, local_path, remote_dir,
                )
                .await;
        };
        let file = std::path::Path::new(local_path.trim())
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        audit.request(json!({"container": container, "file": file, "remote_dir": remote_dir}));
        let result = self
            .pod_fs_upload_unaudited(
                cluster_id, namespace, pod, container, local_path, remote_dir,
            )
            .await;
        if let Ok(transfer) = &result {
            audit.result(format!("{} ({} bytes)", transfer.path, transfer.bytes));
        }
        audit.finish(self, &result);
        result
    }

    /// Node shell helper pod creation, audited (the pod is the result).
    pub(crate) async fn start_node_shell(
        &self,
        terminal_id: &str,
        cluster_id: &str,
        node: &str,
        progress: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> Result<NodeShellPod> {
        let target = AuditTarget::core("Node", None, node);
        let Some(mut audit) = self.audit(cluster_id, AuditAction::NodeShell, false, vec![target])
        else {
            return self
                .start_node_shell_unaudited(terminal_id, cluster_id, node, progress)
                .await;
        };
        audit.request(json!({"image": self.settings().node_shell_image}));
        let result = self
            .start_node_shell_unaudited(terminal_id, cluster_id, node, progress)
            .await;
        if let Ok(pod) = &result {
            audit.result(format!("Pod {}/{}", pod.namespace, pod.name));
        }
        audit.finish(self, &result);
        result
    }
}
