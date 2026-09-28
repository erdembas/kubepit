//! The recorder every mutating command goes through (see `audited.rs`).
//!
//! [`Kubepit::audit`] starts an entry when this process records history
//! and the audit log is on; the command then adds what it cheaply knows
//! (request parameters, before/after objects, a result) and calls
//! [`Audit::finish`] with its own result. Recording is best effort: it never
//! changes the command's result, and a full writer queue drops the entry.
//!
//! Read-only clusters: a mutation refused by the `read_only` guard never
//! reached the cluster and is not recorded (the wrapper does not even start
//! an entry). Dry runs, which read-only clusters allow, are recorded with
//! `dry_run: true`.

use std::time::{Duration, Instant};

use serde_json::Value;

use super::db::{AuditObjectRecord, AuditRecord};
use super::redact::{self, MAX_OBJECT_BYTES};
use super::types::{AuditAction, AuditOutcome, AuditTarget};
use super::writer::WriteOp;
use crate::app::Kubepit;
use crate::change_journal::normalize::Redactor;
use crate::error::kube_error;
use crate::objects::now_millis;
use crate::resources::object_api;
use crate::types::Gvk;

/// Upper bound of a before/after GET: recording must not stall an action.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// Documents of one apply whose before-state is captured.
pub const MAX_CAPTURED_OBJECTS: usize = 20;

/// One action being recorded.
pub struct Audit {
    started: Instant,
    ts: i64,
    cluster_id: String,
    cluster_name: String,
    context: String,
    identity: Option<String>,
    action: AuditAction,
    dry_run: bool,
    targets: Vec<AuditTarget>,
    request: Option<Value>,
    result: Option<String>,
    objects: Vec<AuditObjectRecord>,
    /// Overrides the outcome derived from the command's result.
    failure: Option<String>,
}

impl Audit {
    pub fn action(&self) -> AuditAction {
        self.action
    }

    pub fn targets(&self) -> &[AuditTarget] {
        &self.targets
    }

    pub fn set_target(&mut self, index: usize, target: AuditTarget) {
        if let Some(slot) = self.targets.get_mut(index) {
            *slot = target;
        }
    }

    /// Parameters of the action; callers redact anything secret first.
    pub fn request(&mut self, request: Value) {
        self.request = Some(redact::cap_request(request));
    }

    pub fn result(&mut self, result: impl Into<String>) {
        self.result = Some(result.into());
    }

    /// Mark one target as failed (the command itself may have succeeded).
    pub fn target_error(&mut self, index: usize, message: impl Into<String>) {
        if let Some(target) = self.targets.get_mut(index) {
            target.error = Some(message.into());
        }
    }

    /// Record the command as failed although it returned `Ok` (some
    /// documents of a manifests apply failed).
    pub fn fail(&mut self, message: impl Into<String>) {
        self.failure = Some(message.into());
    }

    /// Keep the before/after of target `index` (raw objects; redacted here).
    pub fn object(
        &mut self,
        index: usize,
        before: Option<&Value>,
        after: Option<&Value>,
        redactor: &Redactor,
    ) {
        if before.is_none() && after.is_none() {
            return;
        }
        let before = before.map(|v| redact::redact_object(v, redactor));
        let after = after.map(|v| redact::redact_object(v, redactor));
        let kind = self
            .targets
            .get(index)
            .map(|t| t.kind.clone())
            .unwrap_or_default();
        let revertible = self.action.revertible()
            && !self.dry_run
            && !redact::secret_like(&kind)
            && matches!((&before, &after), (Some(b), Some(a)) if b != a && !redact::has_markers(b));
        let before_s = before.as_ref().and_then(|v| serde_json::to_string(v).ok());
        let after_s = after.as_ref().and_then(|v| serde_json::to_string(v).ok());
        let size =
            before_s.as_ref().map_or(0, String::len) + after_s.as_ref().map_or(0, String::len);
        let omitted = size > MAX_OBJECT_BYTES;
        self.objects.retain(|o| o.target != index as u32);
        self.objects.push(AuditObjectRecord {
            target: index as u32,
            before: if omitted { None } else { before_s },
            after: if omitted { None } else { after_s },
            omitted,
            revertible: revertible && !omitted,
        });
    }

    /// Queue the entry with the outcome of `result`.
    pub fn finish<T>(self, app: &Kubepit, result: &anyhow::Result<T>) {
        let error = match result {
            Ok(_) => self.failure.clone(),
            Err(e) => Some(format!("{e:#}")),
        };
        self.submit(app, error);
    }

    fn submit(mut self, app: &Kubepit, error: Option<String>) {
        let outcome = if error.is_some() {
            AuditOutcome::Error
        } else {
            AuditOutcome::Ok
        };
        if outcome == AuditOutcome::Error {
            // Nothing changed (or not as reviewed): nothing to revert.
            for object in &mut self.objects {
                object.revertible = false;
            }
        }
        self.objects.sort_by_key(|o| o.target);
        let record = AuditRecord {
            ts: self.ts,
            cluster_id: self.cluster_id,
            cluster_name: self.cluster_name,
            context: self.context,
            identity: self.identity,
            action: self.action,
            dry_run: self.dry_run,
            outcome,
            error,
            duration_ms: self.started.elapsed().as_millis() as i64,
            targets: self.targets,
            request: self.request,
            result: self.result,
            objects: self.objects,
        };
        if !app.history.submit(WriteOp::Audit(Box::new(record))) {
            tracing::debug!("audit entry dropped (history writer busy or unavailable)");
        }
    }
}

impl Kubepit {
    /// Start recording `action` on `cluster_id`, or `None` when nothing is
    /// recorded: history is off for this process, the audit log is turned
    /// off, the cluster is unknown, or the cluster is read-only and this is
    /// not a dry run (the command is refused before reaching the cluster).
    pub(crate) fn audit(
        &self,
        cluster_id: &str,
        action: AuditAction,
        dry_run: bool,
        targets: Vec<AuditTarget>,
    ) -> Option<Audit> {
        if !self.history.is_active() || !self.settings().history.audit {
            return None;
        }
        let cluster = self.store.cluster(cluster_id)?;
        if cluster.read_only && !dry_run {
            return None;
        }
        Some(Audit {
            started: Instant::now(),
            ts: now_millis(),
            cluster_id: cluster.id,
            cluster_name: cluster.name,
            context: cluster.context,
            identity: self.history.identity(cluster_id),
            action,
            dry_run,
            targets,
            request: None,
            result: None,
            objects: Vec::new(),
            failure: None,
        })
    }

    /// The live object for a before/after capture; `None` when it does not
    /// exist or cannot be read quickly (never an error).
    pub(crate) async fn audit_fetch(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
    ) -> Option<Value> {
        let fetch = async {
            let client = self.client(cluster_id).await.ok()?;
            let (api, ar) = object_api(client, gvk, namespace).ok()?;
            let obj = api.get(name).await.map_err(kube_error).ok()?;
            Some(crate::objects::to_kube_object(obj, &ar))
        };
        tokio::time::timeout(CAPTURE_TIMEOUT, fetch)
            .await
            .ok()
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn audit(action: AuditAction, kind: &str) -> Audit {
        Audit {
            started: Instant::now(),
            ts: 1,
            cluster_id: "c".into(),
            cluster_name: "c".into(),
            context: "c".into(),
            identity: None,
            action,
            dry_run: false,
            targets: vec![AuditTarget::document("v1", kind, Some("shop"), "x")],
            request: None,
            result: None,
            objects: Vec::new(),
            failure: None,
        }
    }

    fn cm(value: &str) -> Value {
        json!({"apiVersion": "v1", "kind": "ConfigMap",
               "metadata": {"name": "x", "namespace": "shop", "resourceVersion": value},
               "data": {"k": value}})
    }

    #[test]
    fn revertible_needs_a_changed_plain_before_state() {
        let r = Redactor::new();
        let mut a = audit(AuditAction::Patch, "ConfigMap");
        a.object(0, Some(&cm("1")), Some(&cm("2")), &r);
        assert!(a.objects[0].revertible);
        // Only noise changed: nothing to revert.
        let mut same = audit(AuditAction::Patch, "ConfigMap");
        let mut b = cm("1");
        b["metadata"]["resourceVersion"] = json!("99");
        same.object(0, Some(&cm("1")), Some(&b), &r);
        assert!(!same.objects[0].revertible);
        // Deletes and restarts are never reverted this way.
        let mut delete = audit(AuditAction::Delete, "ConfigMap");
        delete.object(0, Some(&cm("1")), Some(&cm("2")), &r);
        assert!(!delete.objects[0].revertible);
        // Secrets are redacted, so their before-state cannot be re-applied.
        let secret = |v: &str| {
            json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "x"},
                   "data": {"k": v}})
        };
        let mut s = audit(AuditAction::Patch, "Secret");
        s.object(0, Some(&secret("YQ==")), Some(&secret("Yg==")), &r);
        assert!(!s.objects[0].revertible);
        let stored = format!("{:?}", s.objects[0]);
        assert!(
            !stored.contains("YQ==") && !stored.contains("Yg=="),
            "{stored}"
        );
    }

    #[test]
    fn oversized_objects_are_omitted() {
        let r = Redactor::new();
        let mut a = audit(AuditAction::Patch, "ConfigMap");
        let mut big = cm("1");
        // Many medium values (each below the long-string cut) add up.
        let data: serde_json::Map<String, Value> = (0..200)
            .map(|i| (format!("k{i}"), json!("v".repeat(1000))))
            .collect();
        big["data"] = Value::Object(data);
        a.object(0, Some(&big), Some(&cm("2")), &r);
        assert!(a.objects[0].omitted);
        assert!(a.objects[0].before.is_none() && !a.objects[0].revertible);
    }
}
