//! What the journal compares and keeps of an object.
//!
//! [`normalize`] reduces a raw object to its *intent*, so that two versions
//! compare equal unless someone actually changed something:
//!
//! - `status` is dropped for every kind (status-only updates are noise),
//! - `metadata.resourceVersion`, `generation`, `managedFields`, `uid` and
//!   `selfLink` are dropped,
//! - bookkeeping annotations (`kubectl.kubernetes.io/last-applied-configuration`,
//!   `deployment.kubernetes.io/revision`, leader-election and heartbeat
//!   style keys) are dropped,
//! - Nodes keep only name, labels and `spec` (taints, unschedulable, …),
//! - Secrets never keep a value: every `data` / `stringData` entry becomes a
//!   salted hash marker, so "the value of key X changed" stays visible,
//! - string values longer than [`MAX_STRING_BYTES`] become a hash marker.
//!
//! [`same_intent`] then treats two normalized versions that differ only in
//! timestamps outside `spec` (heartbeats written into ConfigMap data, "last
//! synced" annotations, …) as the same.
//!
//! [`actor`] reads who made a change from `managedFields`, which
//! normalization then throws away.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use super::types::ChangeActor;
use crate::objects::timestamp_millis;
use crate::types::Gvk;

/// Longer string values are replaced by a length + hash marker.
pub const MAX_STRING_BYTES: usize = 16 * 1024;

/// Metadata fields that change without anyone changing the object.
const NOISE_METADATA: &[&str] = &[
    "resourceVersion",
    "generation",
    "managedFields",
    "uid",
    "selfLink",
];

/// Annotations maintained by clients and controllers as bookkeeping.
const NOISE_ANNOTATIONS: &[&str] = &[
    "kubectl.kubernetes.io/last-applied-configuration",
    "deployment.kubernetes.io/revision",
    "deployment.kubernetes.io/desired-replicas",
    "deployment.kubernetes.io/max-replicas",
    "control-plane.alpha.kubernetes.io/leader",
    "cluster-autoscaler.kubernetes.io/last-updated",
    "autoscaling.alpha.kubernetes.io/conditions",
    "autoscaling.alpha.kubernetes.io/current-metrics",
    "endpoints.kubernetes.io/last-change-trigger-time",
    "argocd.argoproj.io/refresh",
];

/// Lease / heartbeat style annotation names (the part after the prefix).
const NOISE_NAME_PARTS: &[&str] = &[
    "heartbeat",
    "renew-time",
    "renewtime",
    "last-updated",
    "lastupdated",
    "last-seen",
    "lastseen",
    "leader-election",
    "leaderelection",
];

/// Whether annotation `key` is bookkeeping rather than intent.
pub fn is_noise_annotation(key: &str) -> bool {
    if NOISE_ANNOTATIONS.contains(&key) {
        return true;
    }
    let name = key.rsplit('/').next().unwrap_or(key).to_ascii_lowercase();
    name == "leader" || NOISE_NAME_PARTS.iter().any(|part| name.contains(part))
}

/// Keyed hash for Secret values and oversized strings. The key is random
/// per journal and never leaves the process, so markers cannot be matched
/// against guessed values.
pub struct Redactor {
    key: RandomState,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new()
    }
}

impl Redactor {
    pub fn new() -> Self {
        Self {
            key: RandomState::new(),
        }
    }

    fn digest(&self, field: &str, value: &str) -> String {
        let mut hasher = self.key.build_hasher();
        hasher.write(field.as_bytes());
        hasher.write_u8(0xff);
        hasher.write(value.as_bytes());
        format!("{:012x}", hasher.finish() >> 16)
    }

    /// Marker kept instead of a Secret value.
    pub fn secret_marker(&self, key: &str, value: &Value) -> Value {
        let text = match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        Value::String(format!("<redacted #{}>", self.digest(key, &text)))
    }

    /// Marker kept instead of a string longer than [`MAX_STRING_BYTES`].
    fn long_marker(&self, value: &str) -> Value {
        Value::String(format!(
            "<truncated: {} bytes #{}>",
            value.len(),
            self.digest("", value)
        ))
    }
}

/// Objects that are pure churn and never journaled.
pub fn is_ignored(gvk: &Gvk, raw: &Value) -> bool {
    let namespace = raw.pointer("/metadata/namespace").and_then(Value::as_str);
    let name = raw.pointer("/metadata/name").and_then(Value::as_str);
    match gvk.kind.as_str() {
        // One huge encoded payload per revision; Helm revisions are shown
        // from the releases themselves.
        "Secret" => raw.get("type").and_then(Value::as_str) == Some("helm.sh/release.v1"),
        // Rewritten by cluster-autoscaler every few seconds.
        "ConfigMap" => {
            namespace == Some("kube-system") && name == Some("cluster-autoscaler-status")
        }
        _ => false,
    }
}

/// The most recent `managedFields` entry, ignoring status writers unless
/// nothing else is recorded.
pub fn actor(raw: &Value) -> Option<ChangeActor> {
    let entries = raw.pointer("/metadata/managedFields")?.as_array()?;
    let subresource = |e: &Value| {
        e.get("subresource")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let pick = |skip_status: bool| {
        entries
            .iter()
            .enumerate()
            .filter(|(_, e)| !(skip_status && subresource(e).as_deref() == Some("status")))
            .filter(|(_, e)| e.get("manager").and_then(Value::as_str).is_some())
            .max_by_key(|(i, e)| (timestamp_millis(e, "/time").unwrap_or(i64::MIN), *i))
            .map(|(_, e)| e)
    };
    let entry = pick(true).or_else(|| pick(false))?;
    Some(ChangeActor {
        manager: entry.get("manager")?.as_str()?.to_string(),
        operation: entry
            .get("operation")
            .and_then(Value::as_str)
            .map(str::to_string),
        subresource: subresource(entry),
    })
}

/// The normalized form of `raw` (see module docs).
pub fn normalize(gvk: &Gvk, raw: &Value, redactor: &Redactor) -> Value {
    let Some(source) = raw.as_object() else {
        return raw.clone();
    };
    let mut out = if gvk.kind == "Node" {
        node_view(source)
    } else {
        let mut map = source.clone();
        map.remove("status");
        map
    };
    if let Some(meta) = out.get_mut("metadata").and_then(Value::as_object_mut) {
        for key in NOISE_METADATA {
            meta.remove(*key);
        }
        let empty = match meta.get_mut("annotations").and_then(Value::as_object_mut) {
            Some(annotations) => {
                let secret = gvk.kind == "Secret";
                annotations
                    .retain(|k, v| !(is_noise_annotation(k) || secret && embeds_secret_data(v)));
                annotations.is_empty()
            }
            None => false,
        };
        if empty {
            meta.remove("annotations");
        }
    }
    if gvk.kind == "Secret" {
        for field in ["data", "stringData"] {
            if let Some(Value::Object(values)) = out.get_mut(field) {
                for (key, value) in values.iter_mut() {
                    *value = redactor.secret_marker(key, value);
                }
            }
        }
    }
    let mut value = Value::Object(out);
    shorten_long_strings(&mut value, redactor);
    value
}

/// ISO 8601 / RFC 3339 date-times, also inside larger strings (JSON or
/// YAML payloads in ConfigMap data).
static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?")
        .unwrap()
});

/// Whether two normalized versions carry the same intent: equal, or
/// different only in timestamps outside `spec`. `spec` is compared exactly:
/// `kubectl rollout restart` only moves the pod template's `restartedAt`
/// timestamp and is a real change.
pub fn same_intent(before: &Value, after: &Value) -> bool {
    if before == after {
        return true;
    }
    let (Some(a), Some(b)) = (before.as_object(), after.as_object()) else {
        return false;
    };
    a.len() == b.len()
        && a.iter().all(|(key, x)| {
            b.get(key)
                .is_some_and(|y| x == y || (key != "spec" && same_but_timestamps(x, y)))
        })
}

fn same_but_timestamps(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(a), Value::String(b)) => {
            a == b || TIMESTAMP.replace_all(a, "") == TIMESTAMP.replace_all(b, "")
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_but_timestamps(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, x)| b.get(k).is_some_and(|y| same_but_timestamps(x, y)))
        }
        _ => a == b,
    }
}

/// Nodes: name, labels and spec; status and annotations churn constantly.
fn node_view(source: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in ["apiVersion", "kind"] {
        if let Some(v) = source.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if let Some(meta) = source.get("metadata").and_then(Value::as_object) {
        let mut kept = Map::new();
        for key in ["name", "labels", "creationTimestamp", "deletionTimestamp"] {
            if let Some(v) = meta.get(key) {
                kept.insert(key.to_string(), v.clone());
            }
        }
        out.insert("metadata".into(), Value::Object(kept));
    }
    if let Some(spec) = source.get("spec") {
        out.insert("spec".into(), spec.clone());
    }
    out
}

/// Safety net for Secret annotations that copy the object (tools similar
/// to `last-applied-configuration`).
fn embeds_secret_data(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.contains("\"data\"") || s.contains("\"stringData\""))
}

fn shorten_long_strings(value: &mut Value, redactor: &Redactor) {
    match value {
        Value::String(s) if s.len() > MAX_STRING_BYTES => *value = redactor.long_marker(s),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|v| shorten_long_strings(v, redactor)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|v| shorten_long_strings(v, redactor)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gvk(kind: &str) -> Gvk {
        Gvk {
            group: String::new(),
            version: "v1".into(),
            kind: kind.into(),
            plural: format!("{}s", kind.to_lowercase()),
            namespaced: kind != "Node",
        }
    }

    #[test]
    fn noise_is_dropped_and_intent_kept() {
        let r = Redactor::new();
        let a = json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": "web", "namespace": "shop", "uid": "u1",
                "resourceVersion": "10", "generation": 4,
                "managedFields": [{"manager": "kubectl"}],
                "labels": {"app": "web"},
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration": "{}",
                    "deployment.kubernetes.io/revision": "7",
                    "example.com/last-heartbeat": "2024-01-01T00:00:00Z",
                    "kubernetes.io/change-cause": "bump"
                }},
            "spec": {"replicas": 3},
            "status": {"readyReplicas": 3, "observedGeneration": 4}
        });
        let mut b = a.clone();
        b["metadata"]["resourceVersion"] = json!("11");
        b["metadata"]["generation"] = json!(5);
        b["metadata"]["annotations"]["deployment.kubernetes.io/revision"] = json!("8");
        b["metadata"]["annotations"]["example.com/last-heartbeat"] = json!("2024-01-01T00:01:00Z");
        b["status"]["readyReplicas"] = json!(1);
        b["metadata"]["managedFields"] = json!([{"manager": "kube-controller-manager"}]);
        let g = Gvk {
            group: "apps".into(),
            ..gvk("Deployment")
        };
        let na = normalize(&g, &a, &r);
        assert_eq!(na, normalize(&g, &b, &r), "only noise changed");
        assert!(na.get("status").is_none());
        let meta = &na["metadata"];
        for gone in ["uid", "resourceVersion", "generation", "managedFields"] {
            assert!(meta.get(gone).is_none(), "{gone} kept");
        }
        assert_eq!(
            meta["annotations"],
            json!({"kubernetes.io/change-cause": "bump"})
        );
        assert_eq!(na["spec"]["replicas"], 3);

        b["spec"]["replicas"] = json!(5);
        assert_ne!(na, normalize(&g, &b, &r), "a spec change is kept");
    }

    #[test]
    fn empty_annotation_maps_disappear() {
        let r = Redactor::new();
        let obj = json!({"metadata": {"name": "a", "annotations": {
            "control-plane.alpha.kubernetes.io/leader": "{\"holderIdentity\":\"x\"}"}}});
        let n = normalize(&gvk("ConfigMap"), &obj, &r);
        assert!(n["metadata"].get("annotations").is_none());
    }

    #[test]
    fn heartbeat_style_annotations_are_noise() {
        for key in [
            "kubectl.kubernetes.io/last-applied-configuration",
            "control-plane.alpha.kubernetes.io/leader",
            "example.io/renew-time",
            "node.example.io/lastHeartbeatTime",
            "cluster-autoscaler.kubernetes.io/last-updated",
        ] {
            assert!(is_noise_annotation(key), "{key}");
        }
        for key in [
            "kubernetes.io/change-cause",
            "prometheus.io/scrape",
            "kubectl.kubernetes.io/restartedAt",
            "team-leader",
        ] {
            assert!(!is_noise_annotation(key), "{key}");
        }
    }

    #[test]
    fn timestamp_only_updates_outside_spec_are_noise() {
        let heartbeat = |status: &str, time: &str| {
            json!({"kind": "ConfigMap", "metadata": {"name": "keepalived-heartbeat",
                "annotations": {"example.io/synced-at": time}},
                "data": {"keepalived-ttl-172.17.1.45": format!(
                    r#"{{"Status":"{status}","IP":"172.17.1.45","HeartbeatTime":"{time}"}}"#)}})
        };
        let a = heartbeat("MASTER", "2026-09-27T19:58:39.0715374Z");
        let b = heartbeat("MASTER", "2026-09-27T19:58:41.0762211Z");
        assert!(same_intent(&a, &b));
        assert!(!same_intent(
            &a,
            &heartbeat("BACKUP", "2026-09-27T19:58:41Z")
        ));
        let mut added = b.clone();
        added["data"]["other"] = json!("2026-09-27 19:58:41");
        assert!(!same_intent(&a, &added));

        let restart = |at: &str| {
            json!({"kind": "Deployment", "metadata": {"name": "web"}, "spec": {"template": {
                "metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": at}}}}})
        };
        assert!(!same_intent(
            &restart("2026-09-27T19:00:00+03:00"),
            &restart("2026-09-27T20:00:00+03:00")
        ));
    }

    #[test]
    fn nodes_keep_labels_taints_unschedulable_and_spec_only() {
        let r = Redactor::new();
        let node = json!({
            "apiVersion": "v1", "kind": "Node",
            "metadata": {"name": "n1", "labels": {"zone": "a"},
                "annotations": {"node.alpha.kubernetes.io/ttl": "0"},
                "resourceVersion": "5"},
            "spec": {"taints": [{"key": "k", "effect": "NoSchedule"}], "unschedulable": true,
                     "podCIDR": "10.0.0.0/24"},
            "status": {"conditions": [{"type": "Ready", "lastHeartbeatTime": "2024-01-01T00:00:00Z"}]}
        });
        let n = normalize(&gvk("Node"), &node, &r);
        assert_eq!(
            n,
            json!({"apiVersion": "v1", "kind": "Node",
                   "metadata": {"name": "n1", "labels": {"zone": "a"}},
                   "spec": {"taints": [{"key": "k", "effect": "NoSchedule"}],
                            "unschedulable": true, "podCIDR": "10.0.0.0/24"}})
        );
    }

    #[test]
    fn secrets_never_keep_values() {
        let r = Redactor::new();
        let secret = json!({
            "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": {"name": "db", "namespace": "shop", "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration":
                    "{\"data\":{\"PASSWORD\":\"aHVudGVyMg==\"}}",
                "tool.example.io/snapshot": "{\"stringData\":{\"PASSWORD\":\"hunter2\"}}",
                "owner": "team-a"
            }},
            "data": {"PASSWORD": "aHVudGVyMg==", "USER": "YWRtaW4="},
            "stringData": {"TOKEN": "s3cr3t-token"}
        });
        let n = normalize(&gvk("Secret"), &secret, &r);
        let text = n.to_string();
        for leaked in ["aHVudGVyMg==", "hunter2", "YWRtaW4=", "s3cr3t-token"] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
        assert_eq!(n["metadata"]["annotations"], json!({"owner": "team-a"}));
        let marker = n["data"]["PASSWORD"].as_str().unwrap();
        assert!(marker.starts_with("<redacted #"), "{marker}");
        // Keys stay visible; the same value hashes the same, a new one differently.
        assert_eq!(normalize(&gvk("Secret"), &secret, &r), n);
        let mut rotated = secret.clone();
        rotated["data"]["PASSWORD"] = json!("bmV3LXBhc3M=");
        let m = normalize(&gvk("Secret"), &rotated, &r);
        assert_ne!(m["data"]["PASSWORD"], n["data"]["PASSWORD"]);
        assert_eq!(m["data"]["USER"], n["data"]["USER"]);
        // The same value under another key does not share a marker.
        let mut swapped = secret.clone();
        swapped["data"]["USER"] = json!("aHVudGVyMg==");
        let s = normalize(&gvk("Secret"), &swapped, &r);
        assert_ne!(s["data"]["USER"], s["data"]["PASSWORD"]);
        // Another journal (another key) produces other markers.
        let other = normalize(&gvk("Secret"), &secret, &Redactor::new());
        assert_ne!(other["data"]["PASSWORD"], n["data"]["PASSWORD"]);
    }

    #[test]
    fn long_strings_become_markers_that_still_change() {
        let r = Redactor::new();
        let big = "x".repeat(MAX_STRING_BYTES + 1);
        let a = json!({"metadata": {"name": "c"}, "data": {"blob": big, "small": "ok"}});
        let mut b = a.clone();
        b["data"]["blob"] = json!(format!("{}y", "x".repeat(MAX_STRING_BYTES)));
        let na = normalize(&gvk("ConfigMap"), &a, &r);
        let marker = na["data"]["blob"].as_str().unwrap();
        assert!(marker.starts_with("<truncated: 16385 bytes #"), "{marker}");
        assert_eq!(na["data"]["small"], "ok");
        assert_ne!(na, normalize(&gvk("ConfigMap"), &b, &r));
    }

    #[test]
    fn helm_release_secrets_and_autoscaler_status_are_ignored() {
        let helm = json!({"type": "helm.sh/release.v1", "metadata": {"name": "sh.helm.release.v1.web.v3"}});
        assert!(is_ignored(&gvk("Secret"), &helm));
        let opaque = json!({"type": "Opaque", "metadata": {"name": "x"}});
        assert!(!is_ignored(&gvk("Secret"), &opaque));
        let status =
            json!({"metadata": {"name": "cluster-autoscaler-status", "namespace": "kube-system"}});
        assert!(is_ignored(&gvk("ConfigMap"), &status));
    }

    #[test]
    fn actor_is_the_most_recent_non_status_manager() {
        let obj = json!({"metadata": {"managedFields": [
            {"manager": "kubectl-client-side-apply", "operation": "Update",
             "time": "2024-05-01T10:00:00Z"},
            {"manager": "kube-controller-manager", "operation": "Update",
             "subresource": "status", "time": "2024-05-01T12:00:00Z"},
            {"manager": "helm", "operation": "Update", "time": "2024-05-01T11:00:00Z"},
        ]}});
        assert_eq!(
            actor(&obj),
            Some(ChangeActor {
                manager: "helm".into(),
                operation: Some("Update".into()),
                subresource: None,
            })
        );

        // HPA scaling goes through the scale subresource.
        let scaled = json!({"metadata": {"managedFields": [
            {"manager": "argocd-controller", "operation": "Apply", "time": "2024-05-01T10:00:00Z"},
            {"manager": "kube-controller-manager", "operation": "Update",
             "subresource": "scale", "time": "2024-05-01T10:05:00Z"},
        ]}});
        let a = actor(&scaled).unwrap();
        assert_eq!(a.manager, "kube-controller-manager");
        assert_eq!(a.subresource.as_deref(), Some("scale"));

        // Ties keep the later entry; status-only histories still name someone.
        let tie = json!({"metadata": {"managedFields": [
            {"manager": "a", "time": "2024-05-01T10:00:00Z"},
            {"manager": "b", "time": "2024-05-01T10:00:00Z"},
        ]}});
        assert_eq!(actor(&tie).unwrap().manager, "b");
        let status_only = json!({"metadata": {"managedFields": [
            {"manager": "kubelet", "subresource": "status", "time": "2024-05-01T10:00:00Z"}]}});
        assert_eq!(actor(&status_only).unwrap().manager, "kubelet");
        assert!(actor(&json!({"metadata": {}})).is_none());
    }
}
