//! The assistant's read-only tools (spec §7.3): the catalog offered to the
//! model, strict input parsing, and [`ReadOnlyCluster`], which runs a tool
//! against the one cluster a session is bound to.
//!
//! - **Read-only by construction.** Every tool goes through an existing
//!   `Kubepit` read (`resource_list`, `resource_get`, `api_resources`,
//!   `metrics_*`, `pod_logs_tail`, `prometheus_*`), so only GETs reach the
//!   API server; there is no cluster argument, so a tool cannot leave the
//!   session's cluster.
//! - **Strict inputs** ([`parse_input`]): unknown tools, unknown fields,
//!   wrong types, out-of-range `tail_lines` and malformed names are errors
//!   the model sees. Names, namespaces and containers are validated because
//!   the Kubernetes client puts them into URL paths as they are (a name
//!   like `../secrets/x` would address another resource); selectors travel
//!   only as query parameters.
//! - **No secret values.** Secret-like kinds (`history::redact::secret_like`)
//!   come back as metadata plus key names, their annotation values replaced
//!   by `__SECRET__` (tools such as kapp copy the whole object into an
//!   annotation); they are listed metadata-only. On other kinds annotation
//!   values that embed `data` / `stringData` are replaced too.
//!   `managedFields` and the last-applied annotation are dropped. The
//!   session still redacts every result before it is shown or sent.
//! - **Bounded.** Lists fetch one chunk of [`MAX_LIST_ROWS`] + 1 objects
//!   (never the whole collection); events one chunk of Warnings, then one
//!   of the rest; logs are condensed to ≤ [`MAX_LOG_OUTPUT_LINES`] lines
//!   within the byte cap; PromQL ≤ [`MAX_PROM_SERIES`] summarized series;
//!   every result ≤ [`MAX_TOOL_RESULT_BYTES`], cut on a character boundary;
//!   every call ≤ [`TOOL_TIMEOUT`].
//! - `query_prometheus` is offered only when the caller says Prometheus is
//!   available ([`tool_specs`]) and refused unless the cluster's Prometheus
//!   status is `available` ([`ReadOnlyCluster::prometheus_available`]).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use kube::api::ListParams;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::logs::condense_log;
use super::provider::ToolSpec;
use super::types::AiSectionFormat;
use crate::app::Kubepit;
use crate::change_journal::normalize::embeds_secret_data;
use crate::error::kube_error;
use crate::history::redact::secret_like;
use crate::logs::LOG_CUT_NOTE;
use crate::objects::{
    api_resource, dynamic_api, event_time_millis, now_millis, timestamp_millis, to_kube_object,
};
use crate::types::{ApiResourceInfo, Gvk, PrometheusRange, PrometheusState};

/// Largest tool result (bytes) handed back to the session.
pub const MAX_TOOL_RESULT_BYTES: usize = 32 * 1024;
/// Rows `list_resources` shows at most.
pub const MAX_LIST_ROWS: usize = 200;
/// Events `get_events` shows at most.
pub const MAX_EVENTS: usize = 100;
/// Largest `tail_lines` `get_pod_logs` accepts.
pub const MAX_TAIL_LINES: u32 = 500;
/// `tail_lines` when the model leaves it out.
pub const DEFAULT_TAIL_LINES: u32 = 200;
/// Lines a `get_pod_logs` result has at most (after condensation).
pub const MAX_LOG_OUTPUT_LINES: usize = 200;
/// Series a `query_prometheus` result summarizes at most.
pub const MAX_PROM_SERIES: usize = 20;
/// Longest PromQL expression `query_prometheus` accepts (bytes).
pub const MAX_PROM_QUERY_BYTES: usize = 4 * 1024;
/// Longest label or field selector (bytes).
pub const MAX_SELECTOR_BYTES: usize = 1024;
/// Longest object name or kind (bytes).
pub const MAX_NAME_BYTES: usize = 253;
/// Longest namespace or container name (a DNS label).
const MAX_LABEL_BYTES: usize = 63;
/// Pods (by usage) `get_metrics` shows cluster-wide.
const TOP_PODS: usize = 20;
/// Longest event message kept per row (characters).
const MAX_MESSAGE_CHARS: usize = 300;
/// Appended when a result is cut at [`MAX_TOOL_RESULT_BYTES`].
const TRUNCATED: &str = "\n… truncated";
/// Longest a tool call may take (connect, discovery and reads).
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
/// Events of one type (Warning, the rest) fetched at most per call.
const EVENT_FETCH_LIMIT: u32 = 500;
/// What replaces an annotation value that may hold secret material.
const SECRET_MARKER: &str = "__SECRET__";

pub const GET_EVENTS: &str = "get_events";
pub const GET_METRICS: &str = "get_metrics";
pub const GET_POD_LOGS: &str = "get_pod_logs";
pub const GET_RESOURCE: &str = "get_resource";
pub const LIST_RESOURCES: &str = "list_resources";
pub const QUERY_PROMETHEUS: &str = "query_prometheus";

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

fn string_prop(description: &str, max: usize) -> Value {
    json!({"type": "string", "description": description, "maxLength": max})
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false,
    });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

/// The tools offered to the model, sorted by name (a stable, cacheable
/// prompt prefix). `query_prometheus` only when `prometheus` is true.
pub fn tool_specs(prometheus: bool) -> Vec<ToolSpec> {
    let kind = "A kind, plural or short name (Pod, deployments, cm), optionally with its API group (deployments.apps).";
    let mut specs = vec![
        ToolSpec {
            name: GET_EVENTS,
            description: "Kubernetes Events of the current cluster as a table (last seen, type, reason, object, count, message): Warnings first, then newest, at most 100. Filter by namespace and by the involved object's kind and name.",
            schema: object_schema(
                json!({
                    "namespace": string_prop("Namespace; omit for every namespace you may list.", MAX_LABEL_BYTES),
                    "kind": string_prop("Kind of the involved object (Pod, Deployment).", MAX_NAME_BYTES),
                    "name": string_prop("Name of the involved object.", MAX_NAME_BYTES),
                }),
                &[],
            ),
        },
        ToolSpec {
            name: GET_METRICS,
            description: "Current CPU (millicores) and memory usage from metrics-server: nodes and the busiest pods cluster-wide, the pods of a namespace, or the containers of one pod.",
            schema: object_schema(
                json!({
                    "namespace": string_prop("Namespace of the pods.", MAX_LABEL_BYTES),
                    "pod": string_prop("One pod: shows its containers.", MAX_NAME_BYTES),
                }),
                &[],
            ),
        },
        ToolSpec {
            name: GET_POD_LOGS,
            description: "The last lines of a pod container's log, condensed to at most 200 lines (repeats collapsed as (×N), error lines and the tail kept). Set previous to read the previous (crashed) container instance.",
            schema: object_schema(
                json!({
                    "namespace": string_prop("Namespace of the pod.", MAX_LABEL_BYTES),
                    "pod": string_prop("Pod name.", MAX_NAME_BYTES),
                    "container": string_prop("Container name; required when the pod has several.", MAX_LABEL_BYTES),
                    "previous": {"type": "boolean", "description": "Read the previous container instance.", "default": false},
                    "tail_lines": {"type": "integer", "description": "Lines to read from the end.", "minimum": 1, "maximum": MAX_TAIL_LINES, "default": DEFAULT_TAIL_LINES},
                }),
                &["namespace", "pod"],
            ),
        },
        ToolSpec {
            name: GET_RESOURCE,
            description: "One object as YAML without managedFields and the last-applied annotation. Secret-like kinds show metadata and key names only, never values.",
            schema: object_schema(
                json!({
                    "kind": string_prop(kind, MAX_NAME_BYTES),
                    "namespace": string_prop("Namespace; omit for cluster-scoped kinds.", MAX_LABEL_BYTES),
                    "name": string_prop("Object name.", MAX_NAME_BYTES),
                }),
                &["kind", "name"],
            ),
        },
        ToolSpec {
            name: LIST_RESOURCES,
            description: "Objects of a kind as a table (name, namespace, status, age), at most 200 rows. Narrow large lists with a namespace or selectors.",
            schema: object_schema(
                json!({
                    "kind": string_prop(kind, MAX_NAME_BYTES),
                    "namespace": string_prop("Namespace; omit for every namespace you may list.", MAX_LABEL_BYTES),
                    "label_selector": string_prop("Label selector (app=web,tier!=cache).", MAX_SELECTOR_BYTES),
                    "field_selector": string_prop("Field selector (status.phase=Running).", MAX_SELECTOR_BYTES),
                }),
                &["kind"],
            ),
        },
    ];
    if prometheus {
        specs.push(ToolSpec {
            name: QUERY_PROMETHEUS,
            description: "A PromQL range query over the last 15m, 1h or 6h against the cluster's Prometheus; at most 20 series, each summarized (last, min, max, avg).",
            schema: object_schema(
                json!({
                    "query": {"type": "string", "description": "PromQL expression.", "minLength": 1, "maxLength": MAX_PROM_QUERY_BYTES},
                    "range": {"type": "string", "enum": ["15m", "1h", "6h"], "description": "Time range ending now."},
                }),
                &["query", "range"],
            ),
        });
    }
    specs.sort_by(|a, b| a.name.cmp(b.name));
    specs
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// Range of a `query_prometheus` call, ending now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PromToolRange {
    #[serde(rename = "15m")]
    M15,
    #[serde(rename = "1h")]
    H1,
    #[serde(rename = "6h")]
    H6,
}

impl PromToolRange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::M15 => "15m",
            Self::H1 => "1h",
            Self::H6 => "6h",
        }
    }

    pub fn duration_ms(self) -> i64 {
        const MINUTE: i64 = 60_000;
        match self {
            Self::M15 => 15 * MINUTE,
            Self::H1 => 60 * MINUTE,
            Self::H6 => 6 * 60 * MINUTE,
        }
    }

    /// The [`PrometheusRange`] ending at `end_ms` (the step is picked by
    /// the Prometheus module).
    pub fn to_range(self, end_ms: i64) -> PrometheusRange {
        PrometheusRange {
            start: end_ms - self.duration_ms(),
            end: end_ms,
            step: None,
        }
    }
}

/// A validated tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolInput {
    Events {
        namespace: Option<String>,
        kind: Option<String>,
        name: Option<String>,
    },
    Metrics {
        namespace: Option<String>,
        pod: Option<String>,
    },
    PodLogs {
        namespace: String,
        pod: String,
        container: Option<String>,
        previous: bool,
        tail_lines: u32,
    },
    Get {
        kind: String,
        namespace: Option<String>,
        name: String,
    },
    List {
        kind: String,
        namespace: Option<String>,
        label_selector: Option<String>,
        field_selector: Option<String>,
    },
    Prometheus {
        query: String,
        range: PromToolRange,
    },
}

impl ToolInput {
    /// The tool's name in the catalog.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Events { .. } => GET_EVENTS,
            Self::Metrics { .. } => GET_METRICS,
            Self::PodLogs { .. } => GET_POD_LOGS,
            Self::Get { .. } => GET_RESOURCE,
            Self::List { .. } => LIST_RESOURCES,
            Self::Prometheus { .. } => QUERY_PROMETHEUS,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EventsArgs {
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetricsArgs {
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    pod: Option<String>,
}

fn default_tail_lines() -> u32 {
    DEFAULT_TAIL_LINES
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PodLogsArgs {
    namespace: String,
    pod: String,
    #[serde(default)]
    container: Option<String>,
    #[serde(default)]
    previous: bool,
    #[serde(default = "default_tail_lines")]
    tail_lines: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GetArgs {
    kind: String,
    #[serde(default)]
    namespace: Option<String>,
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    kind: String,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    field_selector: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrometheusArgs {
    query: String,
    range: PromToolRange,
}

fn args<T: DeserializeOwned>(input: &Value) -> Result<T, String> {
    if !input.is_object() {
        return Err("the tool input must be a JSON object".into());
    }
    T::deserialize(input).map_err(|e| format!("invalid tool input: {e}"))
}

/// Trimmed; empty means "not given".
fn optional(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn no_control(value: &str, field: &str) -> Result<(), String> {
    if value.chars().any(char::is_control) {
        return Err(format!("{field} must not contain control characters"));
    }
    Ok(())
}

/// A DNS label (namespaces, container names).
fn dns_label(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.len() <= MAX_LABEL_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-');
    if !valid {
        return Err(format!(
            "{field} {value:?} is not valid: use lowercase letters, digits and '-' (at most {MAX_LABEL_BYTES})"
        ));
    }
    Ok(value.to_string())
}

/// An object name as it may appear in a URL path segment: no `/`, `%`,
/// `?`, `#`, `\`, whitespace or control characters, and not `.` / `..`.
fn object_name(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.len() <= MAX_NAME_BYTES
        && value != "."
        && value != ".."
        && !value.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, '/' | '%' | '?' | '#' | '\\')
        });
    if !valid {
        return Err(format!("{field} {value:?} is not a valid object name"));
    }
    Ok(value.to_string())
}

/// An involved object's name for the Events field selector: an object name
/// without `,`, `=` or `!`, which would add selector clauses.
fn event_object_name(value: &str) -> Result<String, String> {
    let name = object_name(value, "name")?;
    if name.contains([',', '=', '!']) {
        return Err(format!("name {name:?} is not a valid object name"));
    }
    Ok(name)
}

/// A kind, plural or short name, optionally `name.group`.
fn kind_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.len() <= MAX_NAME_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !value.starts_with('.');
    if !valid {
        return Err(format!("kind {value:?} is not a valid kind"));
    }
    Ok(value.to_string())
}

fn selector(value: Option<String>, field: &str) -> Result<Option<String>, String> {
    let Some(value) = optional(value) else {
        return Ok(None);
    };
    if value.len() > MAX_SELECTOR_BYTES {
        return Err(format!(
            "{field} is too long (at most {MAX_SELECTOR_BYTES} bytes)"
        ));
    }
    no_control(&value, field)?;
    Ok(Some(value))
}

/// Parse and validate the input of tool `name` (the model's JSON). Errors
/// go back to the model as a failed tool result.
pub fn parse_input(name: &str, input: &Value) -> Result<ToolInput, String> {
    match name {
        GET_EVENTS => {
            let a: EventsArgs = args(input)?;
            Ok(ToolInput::Events {
                namespace: optional(a.namespace)
                    .map(|v| dns_label(&v, "namespace"))
                    .transpose()?,
                kind: optional(a.kind).map(|v| kind_name(&v)).transpose()?,
                name: optional(a.name)
                    .map(|v| event_object_name(&v))
                    .transpose()?,
            })
        }
        GET_METRICS => {
            let a: MetricsArgs = args(input)?;
            Ok(ToolInput::Metrics {
                namespace: optional(a.namespace)
                    .map(|v| dns_label(&v, "namespace"))
                    .transpose()?,
                pod: optional(a.pod)
                    .map(|v| object_name(&v, "pod"))
                    .transpose()?,
            })
        }
        GET_POD_LOGS => {
            let a: PodLogsArgs = args(input)?;
            if !(1..=MAX_TAIL_LINES).contains(&a.tail_lines) {
                return Err(format!("tail_lines must be between 1 and {MAX_TAIL_LINES}"));
            }
            Ok(ToolInput::PodLogs {
                namespace: dns_label(&a.namespace, "namespace")?,
                pod: object_name(&a.pod, "pod")?,
                container: optional(a.container)
                    .map(|v| dns_label(&v, "container"))
                    .transpose()?,
                previous: a.previous,
                tail_lines: a.tail_lines,
            })
        }
        GET_RESOURCE => {
            let a: GetArgs = args(input)?;
            Ok(ToolInput::Get {
                kind: kind_name(&a.kind)?,
                namespace: optional(a.namespace)
                    .map(|v| dns_label(&v, "namespace"))
                    .transpose()?,
                name: object_name(&a.name, "name")?,
            })
        }
        LIST_RESOURCES => {
            let a: ListArgs = args(input)?;
            Ok(ToolInput::List {
                kind: kind_name(&a.kind)?,
                namespace: optional(a.namespace)
                    .map(|v| dns_label(&v, "namespace"))
                    .transpose()?,
                label_selector: selector(a.label_selector, "label_selector")?,
                field_selector: selector(a.field_selector, "field_selector")?,
            })
        }
        QUERY_PROMETHEUS => {
            let a: PrometheusArgs = args(input)?;
            let query = a.query.trim().to_string();
            if query.is_empty() {
                return Err("query must not be empty".into());
            }
            if query.len() > MAX_PROM_QUERY_BYTES {
                return Err(format!(
                    "query is too long (at most {MAX_PROM_QUERY_BYTES} bytes)"
                ));
            }
            Ok(ToolInput::Prometheus {
                query,
                range: a.range,
            })
        }
        other => Err(format!("there is no tool named {other:?}")),
    }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// What a tool produced. `format` tells the session which redaction to
/// run: `Yaml` (`get_resource`) goes through manifest redaction, the rest
/// through text redaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
    pub format: AiSectionFormat,
}

impl ToolOutput {
    fn ok(text: String, format: AiSectionFormat) -> Self {
        Self {
            text: cap_text(text, MAX_TOOL_RESULT_BYTES),
            is_error: false,
            format,
        }
    }

    fn error(message: String) -> Self {
        Self {
            text: cap_text(message, MAX_TOOL_RESULT_BYTES),
            is_error: true,
            format: AiSectionFormat::Text,
        }
    }
}

/// `text` cut to at most `max` bytes on a character boundary, ending with
/// `… truncated` when anything was cut.
pub fn cap_text(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut cut = max.saturating_sub(TRUNCATED.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    if TRUNCATED.len() <= max {
        text.push_str(TRUNCATED);
    }
    text
}

/// `5d`, `3h`, `12m`, `40s` from epoch ms.
fn age(since_ms: Option<i64>, now_ms: i64) -> String {
    let Some(since) = since_ms.filter(|t| *t > 0) else {
        return "-".into();
    };
    let secs = ((now_ms - since) / 1000).max(0);
    match secs {
        s if s < 120 => format!("{s}s"),
        s if s < 2 * 3600 => format!("{}m", s / 60),
        s if s < 2 * 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

/// Columns padded to the widest cell, two spaces apart.
fn table(header: &[&str], rows: &[Vec<String>]) -> String {
    let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    let line = |cells: Vec<&str>| {
        let last = cells.len() - 1;
        let mut out = String::new();
        for (i, cell) in cells.into_iter().enumerate() {
            out.push_str(cell);
            if i < last {
                let pad = widths[i] - cell.chars().count() + 2;
                out.extend(std::iter::repeat_n(' ', pad));
            }
        }
        out.trim_end().to_string()
    };
    let mut out = vec![line(header.to_vec())];
    out.extend(
        rows.iter()
            .map(|row| line(row.iter().map(String::as_str).collect())),
    );
    out.join("\n")
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Metadata without `managedFields` and the last-applied annotation.
/// Annotation values become `__SECRET__` when they may hold secret
/// material: every value of a Secret-like object (`secretish`), and on
/// other kinds values that embed `data` / `stringData` (object copies).
fn clean_metadata(object: &mut Value, secretish: bool) {
    let Some(meta) = object.get_mut("metadata").and_then(Value::as_object_mut) else {
        return;
    };
    meta.remove("managedFields");
    let empty = match meta.get_mut("annotations").and_then(Value::as_object_mut) {
        Some(annotations) => {
            annotations.remove(LAST_APPLIED);
            for value in annotations.values_mut() {
                if secretish || embeds_secret_data(value) {
                    *value = json!(SECRET_MARKER);
                }
            }
            annotations.is_empty()
        }
        None => false,
    };
    if empty {
        meta.remove("annotations");
    }
}

fn object_keys(value: Option<&Value>, into: &mut Vec<String>) {
    if let Some(map) = value.and_then(Value::as_object) {
        into.extend(map.keys().cloned());
    }
}

/// A Secret-like object reduced to its metadata, `type` and key names.
pub fn secret_summary(object: &Value) -> Value {
    let mut keys = Vec::new();
    object_keys(object.get("data"), &mut keys);
    object_keys(object.get("stringData"), &mut keys);
    object_keys(object.pointer("/spec/encryptedData"), &mut keys);
    object_keys(object.pointer("/spec/data"), &mut keys);
    keys.sort();
    keys.dedup();
    let mut metadata = json!({"metadata": object.get("metadata").cloned().unwrap_or(json!({}))});
    clean_metadata(&mut metadata, true);
    let mut out = Map::new();
    for key in ["apiVersion", "kind"] {
        if let Some(v) = object.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    out.insert("metadata".into(), metadata["metadata"].take());
    if let Some(t) = object.get("type").filter(|t| t.is_string()) {
        out.insert("type".into(), t.clone());
    }
    out.insert("data_keys".into(), json!(keys));
    out.insert(
        "note".into(),
        json!("values of Secret-like objects are never shown"),
    );
    Value::Object(out)
}

fn is_secret_like(info: &ApiResourceInfo, object: &Value) -> bool {
    secret_like(&info.kind)
        || object
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(secret_like)
}

/// The status column of a list row (Secret-like kinds are listed
/// metadata-only and show `-`).
fn row_status(object: &Value) -> String {
    let status = object.get("status").unwrap_or(&Value::Null);
    if object.get("kind").and_then(Value::as_str) == Some("Pod") {
        let phase = str_at(object, "/status/phase").unwrap_or("Unknown");
        let containers = status
            .get("containerStatuses")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let ready = containers
            .iter()
            .filter(|c| c.get("ready").and_then(Value::as_bool) == Some(true))
            .count();
        let waiting = containers
            .iter()
            .find_map(|c| str_at(c, "/state/waiting/reason"))
            .or_else(|| str_at(object, "/status/reason"));
        let restarts: i64 = containers
            .iter()
            .filter_map(|c| c.get("restartCount").and_then(Value::as_i64))
            .sum();
        let mut text = format!("{phase} {ready}/{}", containers.len());
        if let Some(reason) = waiting {
            text.push(' ');
            text.push_str(reason);
        }
        if restarts > 0 {
            text.push_str(&format!(" restarts={restarts}"));
        }
        return text;
    }
    if let Some(conditions) = status.get("conditions").and_then(Value::as_array) {
        let find = |t: &str| {
            conditions
                .iter()
                .find(|c| c.get("type").and_then(Value::as_str) == Some(t))
        };
        if let Some(ready) = find("Ready") {
            let state = ready.get("status").and_then(Value::as_str).unwrap_or("");
            return match (state, str_at(ready, "/reason")) {
                ("True", _) => "Ready".into(),
                (_, Some(reason)) => format!("NotReady ({reason})"),
                _ => "NotReady".into(),
            };
        }
    }
    if let Some(replicas) = object.pointer("/spec/replicas").and_then(Value::as_i64) {
        let ready = status
            .get("readyReplicas")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        return format!("{ready}/{replicas} ready");
    }
    if let Some(phase) = str_at(object, "/status/phase") {
        return phase.to_string();
    }
    "-".into()
}

/// One line, at most [`MAX_MESSAGE_CHARS`] characters.
fn one_line(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > MAX_MESSAGE_CHARS {
        let cut: String = flat.chars().take(MAX_MESSAGE_CHARS).collect();
        format!("{cut}…")
    } else {
        flat
    }
}

fn millicores(value: f64) -> String {
    format!("{}m", value.round() as i64)
}

fn mebibytes(value: f64) -> String {
    format!("{}Mi", (value / (1024.0 * 1024.0)).round() as i64)
}

/// A number with at most four significant digits (`0.0123`, `1234`, `1.5e9`).
fn number(value: f64) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    let abs = value.abs();
    if abs != 0.0 && !(1e-3..1e6).contains(&abs) {
        return format!("{value:.3e}");
    }
    let text = format!("{value:.4}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-" {
        "0".into()
    } else {
        text.to_string()
    }
}

/// Resolve a kind, plural or short name (optionally `name.group`) through
/// discovery: core group first, then an exact kind before a plural before
/// a short name.
pub fn resolve_kind<'a>(
    resources: &'a [ApiResourceInfo],
    kind: &str,
) -> Option<&'a ApiResourceInfo> {
    let (name, group) = match kind.split_once('.') {
        Some((name, group)) => (name, Some(group)),
        None => (kind, None),
    };
    let tier = |r: &ApiResourceInfo| -> Option<u8> {
        if group.is_some_and(|g| !r.group.eq_ignore_ascii_case(g)) {
            return None;
        }
        if r.kind.eq_ignore_ascii_case(name) {
            Some(0)
        } else if r.plural.eq_ignore_ascii_case(name) {
            Some(1)
        } else if r.short_names.iter().any(|s| s.eq_ignore_ascii_case(name)) {
            Some(2)
        } else {
            None
        }
    };
    resources
        .iter()
        .filter_map(|r| tier(r).map(|t| (r, t)))
        .min_by_key(|(r, t)| (!r.group.is_empty(), *t))
        .map(|(r, _)| r)
}

/// How many objects a limited list left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum More {
    None,
    Exact(usize),
    /// The server has more but does not say how many (selectors).
    Unknown,
}

/// One chunk of a list: at most `limit` objects fetched.
struct Chunk {
    items: Vec<Value>,
    /// Objects beyond `items` (the server's `remainingItemCount`).
    more: More,
}

impl Chunk {
    /// Objects matching, when known.
    fn total(&self) -> Option<usize> {
        match self.more {
            More::None => Some(self.items.len()),
            More::Exact(n) => Some(self.items.len() + n),
            More::Unknown => None,
        }
    }

    fn total_text(&self) -> String {
        self.total()
            .map_or(format!("more than {}", self.items.len()), |n| n.to_string())
    }
}

fn more_of(remaining: Option<i64>, continue_token: Option<&str>) -> More {
    match (remaining, continue_token.filter(|t| !t.is_empty())) {
        (Some(n), _) if n > 0 => More::Exact(n as usize),
        (_, Some(_)) => More::Unknown,
        _ => More::None,
    }
}

fn events_gvk() -> Gvk {
    Gvk {
        group: String::new(),
        version: "v1".into(),
        kind: "Event".into(),
        plural: "events".into(),
        namespaced: true,
    }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/// Runs tools against one cluster (the session's). Every call is a read.
pub struct ReadOnlyCluster {
    app: Arc<Kubepit>,
    cluster_id: String,
    timeout: Duration,
}

impl ReadOnlyCluster {
    pub fn new(app: Arc<Kubepit>, cluster_id: impl Into<String>) -> Self {
        Self {
            app,
            cluster_id: cluster_id.into(),
            timeout: TOOL_TIMEOUT,
        }
    }

    /// Another limit per call than [`TOOL_TIMEOUT`] (tests).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn cluster_id(&self) -> &str {
        &self.cluster_id
    }

    /// Whether the cluster's Prometheus is configured and answering, i.e.
    /// whether `query_prometheus` may be offered (the cached detection of
    /// this connection; no requests when Prometheus is turned off).
    pub async fn prometheus_available(&self) -> bool {
        matches!(
            self.app.prometheus_status(&self.cluster_id, false).await,
            Ok(status) if status.state == PrometheusState::Available
        )
    }

    /// Run one tool. Failures (RBAC, missing objects, bad kinds, a call
    /// slower than the timeout) come back as an error result for the model,
    /// never as a panic or a mutation.
    pub async fn execute(&self, input: &ToolInput) -> ToolOutput {
        match tokio::time::timeout(self.timeout, self.run(input)).await {
            Ok(output) => output,
            Err(_) => ToolOutput::error(format!(
                "{} timed out after {:?}",
                input.name(),
                self.timeout
            )),
        }
    }

    async fn run(&self, input: &ToolInput) -> ToolOutput {
        let result = match input {
            ToolInput::Events {
                namespace,
                kind,
                name,
            } => self
                .events(namespace.as_deref(), kind.as_deref(), name.as_deref())
                .await
                .map(|t| (t, AiSectionFormat::Text)),
            ToolInput::Metrics { namespace, pod } => self
                .metrics(namespace.as_deref(), pod.as_deref())
                .await
                .map(|t| (t, AiSectionFormat::Text)),
            ToolInput::PodLogs {
                namespace,
                pod,
                container,
                previous,
                tail_lines,
            } => self
                .pod_logs(namespace, pod, container.as_deref(), *previous, *tail_lines)
                .await
                .map(|t| (t, AiSectionFormat::Text)),
            ToolInput::Get {
                kind,
                namespace,
                name,
            } => self
                .get(kind, namespace.as_deref(), name)
                .await
                .map(|t| (t, AiSectionFormat::Yaml)),
            ToolInput::List {
                kind,
                namespace,
                label_selector,
                field_selector,
            } => self
                .list(
                    kind,
                    namespace.as_deref(),
                    label_selector.as_deref(),
                    field_selector.as_deref(),
                )
                .await
                .map(|t| (t, AiSectionFormat::Text)),
            ToolInput::Prometheus { query, range } => self
                .prometheus(query, *range)
                .await
                .map(|t| (t, AiSectionFormat::Text)),
        };
        match result {
            Ok((text, format)) => ToolOutput::ok(text, format),
            Err(e) => ToolOutput::error(format!("{e:#}")),
        }
    }

    async fn resolve(&self, kind: &str) -> Result<ApiResourceInfo> {
        let resources = self.app.api_resources(&self.cluster_id).await?;
        resolve_kind(&resources, kind)
            .cloned()
            .ok_or_else(|| anyhow!("this cluster serves no kind named {kind:?}"))
    }

    async fn list(
        &self,
        kind: &str,
        namespace: Option<&str>,
        label_selector: Option<&str>,
        field_selector: Option<&str>,
    ) -> Result<String> {
        let info = self.resolve(kind).await?;
        let gvk = info.gvk();
        let namespace = namespace.filter(|_| gvk.namespaced);
        let secretish = secret_like(&info.kind);
        let mut params = ListParams::default().limit(MAX_LIST_ROWS as u32 + 1);
        if let Some(labels) = label_selector {
            params = params.labels(labels);
        }
        if let Some(fields) = field_selector {
            params = params.fields(fields);
        }
        let chunk = self.list_chunk(&gvk, namespace, &params, secretish).await?;
        let now = now_millis();
        let rows: Vec<Vec<String>> = chunk
            .items
            .iter()
            .take(MAX_LIST_ROWS)
            .map(|item| {
                vec![
                    str_at(item, "/metadata/name").unwrap_or("-").to_string(),
                    str_at(item, "/metadata/namespace")
                        .unwrap_or("-")
                        .to_string(),
                    if secretish || is_secret_like(&info, item) {
                        "-".to_string()
                    } else {
                        row_status(item)
                    },
                    age(timestamp_millis(item, "/metadata/creationTimestamp"), now),
                ]
            })
            .collect();
        let scope = match namespace {
            Some(ns) => format!("in namespace {ns}"),
            None if gvk.namespaced => "in every namespace".to_string(),
            None => "(cluster-scoped)".to_string(),
        };
        let mut header = format!("{} ({}) {scope}", info.kind, info.api_version);
        for (label, value) in [("labels", label_selector), ("fields", field_selector)] {
            if let Some(value) = value {
                header.push_str(&format!(", {label} {value}"));
            }
        }
        header.push_str(&format!(": {} objects", chunk.total_text()));
        let hidden = match chunk.total() {
            Some(total) if total > rows.len() => Some(format!("{} more", total - rows.len())),
            Some(_) => None,
            None => Some("more exist".to_string()),
        };
        if let Some(hidden) = hidden {
            header.push_str(&format!(
                " (showing {}; {hidden} — narrow with a namespace, label_selector or field_selector)",
                rows.len()
            ));
        }
        if secretish {
            header.push_str(" (metadata only: types, keys and values are not listed)");
        }
        if rows.is_empty() {
            return Ok(header);
        }
        Ok(format!(
            "{header}\n{}",
            table(&["NAME", "NAMESPACE", "STATUS", "AGE"], &rows)
        ))
    }

    /// One chunk of a list (`params` carries the limit and selectors, which
    /// travel as query parameters). `metadata_only` lists partial objects,
    /// so Secret-like bodies (Helm releases can be large) never load.
    async fn list_chunk(
        &self,
        gvk: &Gvk,
        namespace: Option<&str>,
        params: &ListParams,
        metadata_only: bool,
    ) -> Result<Chunk> {
        let client = self.app.client(&self.cluster_id).await?;
        let ar = api_resource(gvk);
        let api = dynamic_api(client, &ar, gvk.namespaced, namespace);
        let what = || format!("failed to list {}", gvk.plural);
        if metadata_only {
            let list = api
                .list_metadata(params)
                .await
                .map_err(kube_error)
                .with_context(what)?;
            let more = more_of(
                list.metadata.remaining_item_count,
                list.metadata.continue_.as_deref(),
            );
            let items = list
                .items
                .into_iter()
                .map(|o| json!({"metadata": serde_json::to_value(&o.metadata).unwrap_or_default()}))
                .collect();
            return Ok(Chunk { items, more });
        }
        let list = api
            .list(params)
            .await
            .map_err(kube_error)
            .with_context(what)?;
        let more = more_of(
            list.metadata.remaining_item_count,
            list.metadata.continue_.as_deref(),
        );
        let items = list
            .items
            .into_iter()
            .map(|o| to_kube_object(o, &ar))
            .collect();
        Ok(Chunk { items, more })
    }

    /// Events matching `fields`, one chunk, newest first.
    async fn event_chunk(&self, namespace: Option<&str>, fields: &str) -> Result<Chunk> {
        let params = ListParams::default()
            .fields(fields)
            .limit(EVENT_FETCH_LIMIT);
        let mut chunk = self
            .list_chunk(&events_gvk(), namespace, &params, false)
            .await?;
        chunk
            .items
            .sort_by_key(|e| std::cmp::Reverse(event_time_millis(e)));
        Ok(chunk)
    }

    async fn get(&self, kind: &str, namespace: Option<&str>, name: &str) -> Result<String> {
        let info = self.resolve(kind).await?;
        let gvk = info.gvk();
        let namespace = namespace.filter(|_| gvk.namespaced);
        let mut object = self
            .app
            .resource_get(&self.cluster_id, &gvk, namespace, name)
            .await?;
        let doc = if is_secret_like(&info, &object) {
            secret_summary(&object)
        } else {
            clean_metadata(&mut object, false);
            object
        };
        serde_yaml::to_string(&doc).context("failed to render YAML")
    }

    async fn events(
        &self,
        namespace: Option<&str>,
        kind: Option<&str>,
        name: Option<&str>,
    ) -> Result<String> {
        let mut fields = Vec::new();
        if let Some(kind) = kind {
            // Events name the kind itself (`Pod`); fall back to the text
            // when discovery does not know it.
            let resolved = match self.resolve(kind).await {
                Ok(info) => info.kind,
                Err(_) => kind.to_string(),
            };
            fields.push(format!("involvedObject.kind={resolved}"));
        }
        if let Some(name) = name {
            fields.push(format!("involvedObject.name={name}"));
        }
        let field_selector = (!fields.is_empty()).then(|| fields.join(","));
        let with_type = |clause: &str| match &field_selector {
            Some(fields) => format!("{fields},{clause}"),
            None => clause.to_string(),
        };
        // Warnings first; the rest only while there is room. Each is one
        // limited chunk, never the whole collection.
        let warnings = self
            .event_chunk(namespace, &with_type("type=Warning"))
            .await?;
        let others = if warnings.items.len() < MAX_EVENTS {
            self.event_chunk(namespace, &with_type("type!=Warning"))
                .await?
        } else {
            Chunk {
                items: Vec::new(),
                more: More::Unknown,
            }
        };
        let total = match (warnings.total(), others.total()) {
            (Some(w), Some(o)) => (w + o).to_string(),
            _ => format!("more than {}", warnings.items.len() + others.items.len()),
        };
        let warning_total = warnings.total_text();
        let events: Vec<Value> = warnings.items.into_iter().chain(others.items).collect();
        let now = now_millis();
        let all_namespaces = namespace.is_none();
        let rows: Vec<Vec<String>> = events
            .iter()
            .take(MAX_EVENTS)
            .map(|e| {
                let object = format!(
                    "{}/{}",
                    str_at(e, "/involvedObject/kind").unwrap_or("?"),
                    str_at(e, "/involvedObject/name").unwrap_or("?")
                );
                let count = e
                    .get("count")
                    .and_then(Value::as_i64)
                    .or_else(|| e.pointer("/series/count").and_then(Value::as_i64))
                    .unwrap_or(1);
                let mut row = vec![
                    age(Some(event_time_millis(e)), now),
                    str_at(e, "/type").unwrap_or("-").to_string(),
                    str_at(e, "/reason").unwrap_or("-").to_string(),
                ];
                if all_namespaces {
                    row.push(str_at(e, "/metadata/namespace").unwrap_or("-").to_string());
                }
                row.extend([
                    object,
                    count.to_string(),
                    one_line(str_at(e, "/message").unwrap_or("")),
                ]);
                row
            })
            .collect();
        let scope = namespace.map_or("in every namespace".to_string(), |ns| {
            format!("in namespace {ns}")
        });
        let mut header = format!("Events {scope}");
        if let Some(fields) = &field_selector {
            header.push_str(&format!(" ({fields})"));
        }
        header.push_str(&format!(": {total} ({warning_total} Warning)"));
        if rows.len() < events.len() || total.starts_with("more") {
            header.push_str(&format!(
                ", showing the newest {} — narrow with a namespace, kind or name",
                rows.len()
            ));
        }
        if rows.is_empty() {
            return Ok(header);
        }
        let columns: &[&str] = if all_namespaces {
            &[
                "LAST SEEN",
                "TYPE",
                "REASON",
                "NAMESPACE",
                "OBJECT",
                "COUNT",
                "MESSAGE",
            ]
        } else {
            &["LAST SEEN", "TYPE", "REASON", "OBJECT", "COUNT", "MESSAGE"]
        };
        Ok(format!("{header}\n{}", table(columns, &rows)))
    }

    async fn metrics(&self, namespace: Option<&str>, pod: Option<&str>) -> Result<String> {
        const UNAVAILABLE: &str =
            "metrics-server is not available on this cluster (metrics.k8s.io is not served)";
        let pods = self.app.metrics_pods(&self.cluster_id, namespace).await?;
        if !pods.available {
            return Ok(UNAVAILABLE.into());
        }
        if let Some(pod) = pod {
            let found: Vec<_> = pods.items.iter().filter(|p| p.name == pod).collect();
            if found.is_empty() {
                bail!("no metrics for pod {pod} (not running, or too new to have usage)");
            }
            let mut out = Vec::new();
            for p in found {
                let rows: Vec<Vec<String>> = p
                    .containers
                    .iter()
                    .map(|c| {
                        vec![
                            c.name.clone(),
                            millicores(c.cpu_millicores),
                            mebibytes(c.memory_bytes),
                        ]
                    })
                    .collect();
                out.push(format!(
                    "Pod {}/{}: CPU {}, memory {}\n{}",
                    p.namespace,
                    p.name,
                    millicores(p.cpu_millicores),
                    mebibytes(p.memory_bytes),
                    table(&["CONTAINER", "CPU", "MEMORY"], &rows)
                ));
            }
            return Ok(out.join("\n\n"));
        }
        let mut items = pods.items;
        items.sort_by(|a, b| b.cpu_millicores.total_cmp(&a.cpu_millicores));
        let limit = if namespace.is_some() {
            MAX_LIST_ROWS
        } else {
            TOP_PODS
        };
        let pod_rows: Vec<Vec<String>> = items
            .iter()
            .take(limit)
            .map(|p| {
                let mut row = vec![p.name.clone()];
                if namespace.is_none() {
                    row.push(p.namespace.clone());
                }
                row.extend([millicores(p.cpu_millicores), mebibytes(p.memory_bytes)]);
                row
            })
            .collect();
        if let Some(ns) = namespace {
            let cpu: f64 = items.iter().map(|p| p.cpu_millicores).sum();
            let memory: f64 = items.iter().map(|p| p.memory_bytes).sum();
            let mut header = format!(
                "Pod usage in namespace {ns}: {} pods, CPU {}, memory {}",
                items.len(),
                millicores(cpu),
                mebibytes(memory)
            );
            if items.len() > limit {
                header.push_str(&format!(" (busiest {limit} shown)"));
            }
            if pod_rows.is_empty() {
                return Ok(header);
            }
            return Ok(format!(
                "{header}\n{}",
                table(&["POD", "CPU", "MEMORY"], &pod_rows)
            ));
        }
        let nodes = self.app.metrics_nodes(&self.cluster_id).await?;
        let node_rows: Vec<Vec<String>> = nodes
            .items
            .iter()
            .map(|n| {
                vec![
                    n.name.clone(),
                    millicores(n.cpu_millicores),
                    mebibytes(n.memory_bytes),
                ]
            })
            .collect();
        let mut out = Vec::new();
        if !node_rows.is_empty() {
            out.push(format!(
                "Node usage:\n{}",
                table(&["NODE", "CPU", "MEMORY"], &node_rows)
            ));
        }
        out.push(format!(
            "Busiest pods by CPU ({} of {}):\n{}",
            pod_rows.len(),
            items.len(),
            table(&["POD", "NAMESPACE", "CPU", "MEMORY"], &pod_rows)
        ));
        Ok(out.join("\n\n"))
    }

    async fn pod_logs(
        &self,
        namespace: &str,
        pod: &str,
        container: Option<&str>,
        previous: bool,
        tail_lines: u32,
    ) -> Result<String> {
        let text = self
            .app
            .pod_logs_tail(
                &self.cluster_id,
                namespace,
                pod,
                container,
                i64::from(tail_lines),
                previous,
            )
            .await?;
        let (cut, text) = match text.strip_prefix(LOG_CUT_NOTE) {
            Some(rest) => (true, rest.trim_start_matches('\n')),
            None => (false, text.as_str()),
        };
        let received = text.lines().count();
        let mut header = format!("Logs of pod {namespace}/{pod}");
        if let Some(container) = container {
            header.push_str(&format!(", container {container}"));
        }
        if previous {
            header.push_str(", previous instance");
        }
        header.push_str(&format!(
            ": {received} lines (tail_lines {tail_lines}), each with its timestamp"
        ));
        if cut {
            header.push(' ');
            header.push_str(LOG_CUT_NOTE);
        }
        if received == 0 {
            return Ok(format!("{header}\n(no log lines)"));
        }
        let room = MAX_TOOL_RESULT_BYTES.saturating_sub(header.len() + 1);
        let condensed = condense_log(text, MAX_LOG_OUTPUT_LINES - 1, room);
        Ok(format!("{header}\n{condensed}"))
    }

    async fn prometheus(&self, query: &str, range: PromToolRange) -> Result<String> {
        if query.len() > MAX_PROM_QUERY_BYTES {
            bail!("the query is too long (at most {MAX_PROM_QUERY_BYTES} bytes)");
        }
        if !self.prometheus_available().await {
            bail!("Prometheus is not available for this cluster");
        }
        let result = self
            .app
            .prometheus_query_range(&self.cluster_id, query, &range.to_range(now_millis()))
            .await?;
        let total = result.series.len();
        let mut out = vec![format!(
            "PromQL over the last {} (step {}s): {total} series{}",
            range.as_str(),
            result.step_secs,
            if result.truncated {
                " (the server returned more)"
            } else {
                ""
            }
        )];
        for series in result.series.iter().take(MAX_PROM_SERIES) {
            let labels = series
                .labels
                .iter()
                .map(|(k, v)| format!("{k}={v:?}"))
                .collect::<Vec<_>>()
                .join(", ");
            let values: Vec<f64> = series.points.iter().map(|(_, v)| *v).collect();
            let summary = if values.is_empty() {
                "no samples".to_string()
            } else {
                let min = values.iter().copied().fold(f64::INFINITY, f64::min);
                let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let avg = values.iter().sum::<f64>() / values.len() as f64;
                format!(
                    "last {}, min {}, max {}, avg {} ({} samples)",
                    number(*values.last().expect("not empty")),
                    number(min),
                    number(max),
                    number(avg),
                    values.len()
                )
            };
            out.push(format!("{{{labels}}}: {summary}"));
        }
        if total > MAX_PROM_SERIES {
            out.push(format!(
                "… {} more series (aggregate with sum/topk to see them)",
                total - MAX_PROM_SERIES
            ));
        }
        for warning in &result.warnings {
            out.push(format!("warning: {}", one_line(warning)));
        }
        Ok(out.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(group: &str, kind: &str, plural: &str, short: &[&str]) -> ApiResourceInfo {
        ApiResourceInfo {
            group: group.into(),
            version: "v1".into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced: true,
            api_version: if group.is_empty() {
                "v1".into()
            } else {
                format!("{group}/v1")
            },
            verbs: vec!["get".into(), "list".into()],
            short_names: short.iter().map(|s| s.to_string()).collect(),
            categories: Vec::new(),
        }
    }

    #[test]
    fn kinds_resolve_core_first_then_kind_plural_short_name() {
        let resources = vec![
            info("", "ConfigMap", "configmaps", &["cm"]),
            info("", "Event", "events", &["ev"]),
            info("apps", "Deployment", "deployments", &["deploy"]),
            info("events.k8s.io", "Event", "events", &[]),
        ];
        let find =
            |k: &str| resolve_kind(&resources, k).map(|r| (r.group.as_str(), r.kind.as_str()));
        assert_eq!(find("event"), Some(("", "Event")));
        assert_eq!(find("EVENTS"), Some(("", "Event")));
        assert_eq!(
            find("events.events.k8s.io"),
            Some(("events.k8s.io", "Event"))
        );
        assert_eq!(find("cm"), Some(("", "ConfigMap")));
        assert_eq!(find("deploy"), Some(("apps", "Deployment")));
        assert_eq!(find("deployments.apps"), Some(("apps", "Deployment")));
        assert_eq!(find("deployments.batch"), None);
        assert_eq!(find("widgets"), None);
    }

    #[test]
    fn caps_cut_on_character_boundaries() {
        let text = "ğ".repeat(40_000); // 2 bytes each
        let capped = cap_text(text, MAX_TOOL_RESULT_BYTES);
        assert!(capped.len() <= MAX_TOOL_RESULT_BYTES);
        assert!(capped.ends_with("… truncated"));
        let odd = cap_text(format!("a{}", "€".repeat(20_000)), 1001);
        assert!(odd.len() <= 1001 && odd.ends_with("truncated"));
        assert_eq!(cap_text("short".into(), 10), "short");
        assert!(cap_text("abcdef".into(), 3).len() <= 3);
    }

    #[test]
    fn secret_summaries_keep_key_names_only() {
        let secret = json!({
            "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": {"name": "db", "namespace": "shop", "labels": {"app": "shop"},
                         "managedFields": [{"manager": "kubectl"}],
                         "annotations": {LAST_APPLIED: "{\"data\":{\"PASSWORD\":\"aHVudGVyMg==\"}}"}},
            "data": {"PASSWORD": "aHVudGVyMg=="}, "stringData": {"USER": "hunter2"}
        });
        let summary = secret_summary(&secret);
        let text = summary.to_string();
        assert!(
            !text.contains("aHVudGVyMg==") && !text.contains("hunter2"),
            "{text}"
        );
        assert_eq!(summary["data_keys"], json!(["PASSWORD", "USER"]));
        assert_eq!(summary["metadata"]["labels"]["app"], "shop");
        assert!(summary["metadata"].get("annotations").is_none());
        assert!(summary["metadata"].get("managedFields").is_none());
        let annotated = secret_summary(&json!({"kind": "Secret", "metadata": {"annotations": {
            "kapp.k14s.io/original": "{\"data\":{\"PASSWORD\":\"aHVudGVyMg==\"}}",
            "owner": "team-a"}}}));
        assert_eq!(
            annotated["metadata"]["annotations"]["kapp.k14s.io/original"],
            SECRET_MARKER
        );
        assert_eq!(annotated["metadata"]["annotations"]["owner"], SECRET_MARKER);
        let mut copied = json!({"kind": "ConfigMap", "metadata": {"annotations": {
            "ci/snapshot": "{\"stringData\":{\"PASSWORD\":\"hunter2\"}}", "team": "a"}}});
        clean_metadata(&mut copied, false);
        assert_eq!(
            copied["metadata"]["annotations"]["ci/snapshot"],
            SECRET_MARKER
        );
        assert_eq!(copied["metadata"]["annotations"]["team"], "a");
    }

    #[test]
    fn list_status_summarizes_pods_conditions_and_replicas() {
        let pod = json!({"kind": "Pod", "status": {"phase": "Running", "containerStatuses": [
            {"ready": false, "restartCount": 4, "state": {"waiting": {"reason": "CrashLoopBackOff"}}},
            {"ready": true, "restartCount": 0, "state": {"running": {}}}]}});
        assert_eq!(row_status(&pod), "Running 1/2 CrashLoopBackOff restarts=4");
        let node = json!({"kind": "Node", "status": {"conditions": [
            {"type": "Ready", "status": "False", "reason": "KubeletNotReady"}]}});
        assert_eq!(row_status(&node), "NotReady (KubeletNotReady)");
        let deploy =
            json!({"kind": "Deployment", "spec": {"replicas": 3}, "status": {"readyReplicas": 2}});
        assert_eq!(row_status(&deploy), "2/3 ready");
        assert_eq!(row_status(&json!({"kind": "ConfigMap"})), "-");
    }

    #[test]
    fn tables_align_and_numbers_stay_short() {
        let out = table(
            &["NAME", "AGE"],
            &[
                vec!["a".into(), "1d".into()],
                vec!["longer".into(), "5m".into()],
            ],
        );
        assert_eq!(out, "NAME    AGE\na       1d\nlonger  5m");
        assert_eq!(number(0.0), "0");
        assert_eq!(number(1.23456), "1.2346");
        assert_eq!(number(250.0), "250");
        assert_eq!(number(3.5e9), "3.500e9");
        assert_eq!(age(Some(0), 10), "-");
        assert_eq!(age(Some(1_000), 3 * 86_400_000), "2d");
        assert_eq!(age(Some(1_000), 61_000), "60s");
    }

    #[test]
    fn prometheus_ranges_end_now() {
        let range = PromToolRange::H6.to_range(100_000_000);
        assert_eq!(range.end - range.start, 6 * 3_600_000);
        assert_eq!(serde_json::to_value(PromToolRange::M15).unwrap(), "15m");
        assert_eq!(
            serde_json::from_value::<PromToolRange>(json!("1h")).unwrap(),
            PromToolRange::H1
        );
    }
}
