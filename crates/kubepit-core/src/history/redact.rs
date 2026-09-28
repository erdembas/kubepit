//! What the audit log may keep of objects and requests.
//!
//! Secret values never reach the database: objects go through the change
//! journal's [`normalize`] (Secret `data` / `stringData` values become keyed
//! hash markers, bookkeeping and `status` are dropped, long strings are
//! shortened), and anything else that can carry Secret data — patch bodies
//! addressed to a Secret, Helm values typed by the user, custom `*Secret`
//! kinds — keeps its keys while every value becomes a marker. The markers
//! use one random key per process, so "this value changed" stays visible
//! inside an entry but a marker cannot be matched against guessed values.

use serde_json::{Map, Value};

use crate::change_journal::normalize::{normalize, Redactor};
use crate::types::Gvk;

/// Largest request body kept (serialized); larger ones keep only a note.
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
/// Largest before + after pair kept per target (serialized).
pub const MAX_OBJECT_BYTES: usize = 128 * 1024;

/// Kinds that may carry secret material: core `Secret` and custom kinds
/// named like one (`SealedSecret`, `ExternalSecret`, `VaultSecret`, …).
pub fn secret_like(kind: &str) -> bool {
    kind.to_ascii_lowercase().ends_with("secret")
}

fn group_of(api_version: &str) -> &str {
    api_version
        .rsplit_once('/')
        .map(|(group, _)| group)
        .unwrap_or("")
}

/// Normalized, redacted copy of an object for the audit log.
pub fn redact_object(value: &Value, redactor: &Redactor) -> Value {
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
    let api_version = value
        .get("apiVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    let gvk = Gvk {
        group: group_of(api_version).to_string(),
        version: String::new(),
        kind: kind.to_string(),
        plural: String::new(),
        namespaced: true,
    };
    let mut out = normalize(&gvk, value, redactor);
    if secret_like(kind) {
        if let Some(map) = out.as_object_mut() {
            for field in ["spec", "data", "stringData", "encryptedData"] {
                if let Some(v) = map.get_mut(field) {
                    *v = redact_leaves(v, field, redactor);
                }
            }
        }
    }
    out
}

/// Every scalar leaf of `value` becomes a marker; keys and structure stay.
pub fn redact_leaves(value: &Value, path: &str, redactor: &Redactor) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        redact_leaves(v, &format!("{path}.{k}"), redactor),
                    )
                })
                .collect::<Map<String, Value>>(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, v)| redact_leaves(v, &format!("{path}[{i}]"), redactor))
                .collect(),
        ),
        Value::Null => Value::Null,
        leaf => redactor.secret_marker(path, leaf),
    }
}

/// A patch body as the audit log keeps it: verbatim, unless it targets a
/// secret-like kind (then RFC 6902 operations keep `op` / `path` / `from`
/// and merge patches keep their keys; every value becomes a marker).
pub fn redact_patch(kind: &str, patch: &Value, redactor: &Redactor) -> Value {
    if !secret_like(kind) {
        return patch.clone();
    }
    match patch {
        Value::Array(ops) => Value::Array(
            ops.iter()
                .enumerate()
                .map(|(i, op)| match op.as_object() {
                    Some(map) => Value::Object(
                        map.iter()
                            .map(|(k, v)| {
                                let kept = matches!(k.as_str(), "op" | "path" | "from");
                                let v = if kept {
                                    v.clone()
                                } else {
                                    redact_leaves(v, &format!("[{i}].{k}"), redactor)
                                };
                                (k.clone(), v)
                            })
                            .collect(),
                    ),
                    None => redact_leaves(op, &format!("[{i}]"), redactor),
                })
                .collect(),
        ),
        other => redact_leaves(other, "", redactor),
    }
}

/// Helm values typed by the user: key names only, values as markers.
pub fn redact_values_yaml(values: &str, redactor: &Redactor) -> Value {
    if values.trim().is_empty() {
        return Value::Object(Map::new());
    }
    match serde_yaml::from_str::<Value>(values) {
        Ok(parsed) => redact_leaves(&parsed, "values", redactor),
        Err(_) => Value::String(format!("<unparsed values: {} bytes>", values.len())),
    }
}

/// `value` unless its JSON exceeds [`MAX_REQUEST_BYTES`].
pub fn cap_request(value: Value) -> Value {
    let size = serde_json::to_string(&value).map_or(0, |s| s.len());
    if size <= MAX_REQUEST_BYTES {
        value
    } else {
        serde_json::json!({ "truncated": true, "bytes": size })
    }
}

/// Whether any marker produced by redaction is present (such a before-state
/// cannot be re-applied).
pub fn has_markers(value: &Value) -> bool {
    match value {
        Value::String(s) => s.starts_with("<redacted #") || s.starts_with("<truncated: "),
        Value::Array(items) => items.iter().any(has_markers),
        Value::Object(map) => map.values().any(has_markers),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LEAKS: &[&str] = &["aHVudGVyMg==", "hunter2", "s3cr3t", "vault-token-123"];

    fn assert_clean(value: &Value) {
        let text = value.to_string();
        for leak in LEAKS {
            assert!(!text.contains(leak), "{leak} leaked: {text}");
        }
    }

    #[test]
    fn secrets_keep_keys_but_no_values() {
        let r = Redactor::new();
        let secret = json!({
            "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": {"name": "db", "namespace": "shop", "resourceVersion": "7",
                "managedFields": [{"manager": "kubectl"}],
                "annotations": {"kubectl.kubernetes.io/last-applied-configuration":
                    "{\"data\":{\"PASSWORD\":\"aHVudGVyMg==\"}}"}},
            "data": {"PASSWORD": "aHVudGVyMg=="},
            "stringData": {"TOKEN": "s3cr3t"}
        });
        let out = redact_object(&secret, &r);
        assert_clean(&out);
        assert!(out["data"]["PASSWORD"]
            .as_str()
            .unwrap()
            .starts_with("<redacted #"));
        assert!(out["metadata"].get("managedFields").is_none());
        assert!(has_markers(&out));

        let sealed = json!({"apiVersion": "secrets.example.io/v1", "kind": "VaultSecret",
            "metadata": {"name": "x"}, "spec": {"token": "vault-token-123", "path": "kv/app"}});
        let out = redact_object(&sealed, &r);
        assert_clean(&out);
        assert!(out["spec"].get("path").is_some(), "keys stay");
    }

    #[test]
    fn patches_to_secrets_are_redacted_and_others_kept() {
        let r = Redactor::new();
        let merge =
            json!({"data": {"PASSWORD": "aHVudGVyMg=="}, "metadata": {"labels": {"a": "b"}}});
        let out = redact_patch("Secret", &merge, &r);
        assert_clean(&out);
        assert!(out["metadata"]["labels"].get("a").is_some());
        let json_patch = json!([{"op": "replace", "path": "/data/PASSWORD", "value": "s3cr3t"}]);
        let out = redact_patch("Secret", &json_patch, &r);
        assert_clean(&out);
        assert_eq!(out[0]["op"], "replace");
        assert_eq!(out[0]["path"], "/data/PASSWORD");
        let deploy = json!({"spec": {"replicas": 3}});
        assert_eq!(redact_patch("Deployment", &deploy, &r), deploy);
    }

    #[test]
    fn helm_values_keep_structure_only() {
        let r = Redactor::new();
        let out = redact_values_yaml("auth:\n  password: hunter2\nreplicas: 3\n", &r);
        assert_clean(&out);
        assert!(out["auth"].get("password").is_some());
        assert!(out["replicas"].as_str().unwrap().starts_with("<redacted #"));
        assert_eq!(redact_values_yaml("  ", &r), json!({}));
        assert!(redact_values_yaml("a: [", &r)
            .as_str()
            .unwrap()
            .starts_with("<unparsed"));
    }

    #[test]
    fn oversized_requests_keep_a_note() {
        let big = json!({"patch": "x".repeat(MAX_REQUEST_BYTES)});
        let capped = cap_request(big);
        assert_eq!(capped["truncated"], true);
        let small = json!({"replicas": 3});
        assert_eq!(cap_request(small.clone()), small);
    }
}
