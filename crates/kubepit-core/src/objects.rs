//! Helpers for the generic (`DynamicObject`) resource path.
//!
//! Everything the UI receives goes through [`to_kube_object`], which:
//! - strips `metadata.managedFields` (large, noisy, never shown), and
//! - fills `apiVersion`/`kind` when the server omitted them. List responses
//!   leave them off each item, but the UI's `KubeObject` requires both.

use kube::api::{Api, ApiResource, DynamicObject};
use kube::Client;
use serde_json::Value;

use crate::types::{ApiResourceInfo, Gvk};

/// Type-erased resource descriptor for `gvk`.
pub fn api_resource(gvk: &Gvk) -> ApiResource {
    ApiResource {
        group: gvk.group.clone(),
        version: gvk.version.clone(),
        api_version: gvk.api_version(),
        kind: gvk.kind.clone(),
        plural: gvk.plural.clone(),
    }
}

pub fn api_resource_from_info(info: &ApiResourceInfo) -> ApiResource {
    api_resource(&info.gvk())
}

/// `Api<DynamicObject>` scoped to `namespace` for namespaced kinds, or
/// cluster-wide (all namespaces) when `namespace` is `None` or the kind is
/// cluster-scoped.
pub fn dynamic_api(
    client: Client,
    ar: &ApiResource,
    namespaced: bool,
    namespace: Option<&str>,
) -> Api<DynamicObject> {
    match namespace.filter(|ns| namespaced && !ns.is_empty()) {
        Some(ns) => Api::namespaced_with(client, ns, ar),
        None => Api::all_with(client, ar),
    }
}

/// Serialise an object for the UI (see module docs).
pub fn to_kube_object(mut obj: DynamicObject, ar: &ApiResource) -> Value {
    obj.metadata.managed_fields = None;
    let mut value = serde_json::to_value(&obj).unwrap_or(Value::Null);
    fill_type_meta(&mut value, ar);
    value
}

/// Set `apiVersion` / `kind` when missing or empty.
pub fn fill_type_meta(value: &mut Value, ar: &ApiResource) {
    if let Some(map) = value.as_object_mut() {
        let missing = |v: Option<&Value>| v.and_then(Value::as_str).is_none_or(str::is_empty);
        if missing(map.get("apiVersion")) {
            map.insert("apiVersion".into(), Value::String(ar.api_version.clone()));
        }
        if missing(map.get("kind")) {
            map.insert("kind".into(), Value::String(ar.kind.clone()));
        }
    }
}

/// Remove `metadata.managedFields` from a raw JSON object.
pub fn strip_managed_fields(value: &mut Value) {
    if let Some(meta) = value.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
    }
}

/// Stable identity of an object for watch bookkeeping: its uid, or
/// `namespace/name` for the rare object without one.
pub fn object_key(obj: &DynamicObject) -> String {
    match obj.metadata.uid.as_deref() {
        Some(uid) if !uid.is_empty() => uid.to_string(),
        _ => format!(
            "{}/{}",
            obj.metadata.namespace.as_deref().unwrap_or(""),
            obj.metadata.name.as_deref().unwrap_or("")
        ),
    }
}

/// Parse an RFC 3339 timestamp at `pointer` into unix millis.
pub fn timestamp_millis(value: &Value, pointer: &str) -> Option<i64> {
    let text = value.pointer(pointer)?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// When an Event last happened: `lastTimestamp`, then `eventTime`, then
/// `series.lastObservedTime`, then `metadata.creationTimestamp`.
pub fn event_time_millis(event: &Value) -> i64 {
    [
        "/lastTimestamp",
        "/eventTime",
        "/series/lastObservedTime",
        "/metadata/creationTimestamp",
    ]
    .iter()
    .find_map(|p| timestamp_millis(event, p))
    .unwrap_or(0)
}

/// Sort Events newest first.
pub fn sort_events_newest_first(events: &mut [Value]) {
    events.sort_by_key(|e| std::cmp::Reverse(event_time_millis(e)));
}

pub fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pods() -> ApiResource {
        api_resource(&Gvk {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            plural: "pods".into(),
            namespaced: true,
        })
    }

    #[test]
    fn list_items_get_type_meta_and_lose_managed_fields() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "metadata": {
                "name": "web",
                "namespace": "default",
                "uid": "u1",
                "resourceVersion": "42",
                "managedFields": [{"manager": "kubectl"}]
            },
            "spec": {"containers": []}
        }))
        .unwrap();
        assert_eq!(object_key(&obj), "u1");
        let value = to_kube_object(obj, &pods());
        assert_eq!(value["apiVersion"], "v1");
        assert_eq!(value["kind"], "Pod");
        assert_eq!(value["metadata"]["resourceVersion"], "42");
        assert!(value["metadata"].get("managedFields").is_none());
        assert!(value["spec"]["containers"].is_array());
    }

    #[test]
    fn existing_type_meta_is_kept() {
        let mut v = json!({"apiVersion": "apps/v1", "kind": "Deployment"});
        fill_type_meta(&mut v, &pods());
        assert_eq!(v["kind"], "Deployment");
        assert_eq!(v["apiVersion"], "apps/v1");
    }

    #[test]
    fn events_sort_newest_first_across_time_fields() {
        let mut events = vec![
            json!({"metadata": {"name": "a", "creationTimestamp": "2024-01-01T00:00:00Z"}}),
            json!({"metadata": {"name": "b"}, "lastTimestamp": "2024-03-01T00:00:00Z"}),
            json!({"metadata": {"name": "c"}, "eventTime": "2024-02-01T00:00:00.123456Z"}),
            json!({"metadata": {"name": "d"}}),
        ];
        sort_events_newest_first(&mut events);
        let names: Vec<_> = events
            .iter()
            .map(|e| e["metadata"]["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["b", "c", "a", "d"]);
    }
}
