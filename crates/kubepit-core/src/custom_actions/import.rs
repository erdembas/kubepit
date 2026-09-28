//! Importing definitions: Kubepit's own JSON export and k9s `plugins.yaml`.
//!
//! Nothing is saved here; the UI shows what was found (and every note about
//! what could not be mapped exactly) before adding the actions.
//!
//! ## k9s mapping
//!
//! | k9s                         | Kubepit                                        |
//! |-----------------------------|------------------------------------------------|
//! | plugin `description` / key  | `name`                                         |
//! | `scopes` (resource names)   | `scopes` (kinds; `all` → `*`, `containers` → `Pod`) |
//! | `command` + `args`          | `command` (`sh -c` scripts are unwrapped)      |
//! | `$NAMESPACE`, `$NAME`, …    | `{namespace}`, `{name}`, … (quote-aware)       |
//! | `background`                | `mode: background` (else `terminal`)           |
//! | `confirm`                   | `confirm`                                      |
//! | `dangerous`                 | `mutating`                                     |
//! | `shortCut` (`Shift-L`)      | `shortcut` (`shift+l`)                         |
//!
//! `$FILTER`, `$USER`, `$GROUPS` and `$COL-*` have no equivalent: they stay
//! shell variables and are reported. Unknown fields (`pipes`,
//! `overwriteOutput`, …) and scopes (`helm`, `contexts`, …) are reported too.

use anyhow::{bail, Context, Result};
use serde_json::Value as Json;
use serde_yaml::{Mapping, Value as Yaml};

use super::model::{
    normalize_shortcut, validate_action, CustomAction, CustomActionImport, CustomActionImportNote,
    CustomActionMode, SCOPE_ANY,
};
use super::template::shell_quote;

pub const FORMAT_KUBEPIT: &str = "kubepit";
pub const FORMAT_K9S: &str = "k9s";

/// Stable note codes (translated by the UI).
pub mod codes {
    pub const INVALID_ACTION: &str = "invalid-action";
    pub const INVALID_PLUGIN: &str = "invalid-plugin";
    pub const UNSUPPORTED_FIELD: &str = "unsupported-field";
    pub const UNSUPPORTED_SCOPE: &str = "unsupported-scope";
    pub const GUESSED_SCOPE: &str = "guessed-scope";
    pub const NO_SCOPE: &str = "no-scope";
    pub const UNSUPPORTED_VARIABLE: &str = "unsupported-variable";
    pub const INVALID_SHORTCUT: &str = "invalid-shortcut";
    pub const EXTRA_ARGS: &str = "extra-args";
}

/// Largest file `custom_actions_import` reads.
pub const MAX_IMPORT_BYTES: u64 = 1024 * 1024;

/// Parse an export or a k9s plugins file (detected by content).
pub fn parse_import(text: &str) -> Result<CustomActionImport> {
    if let Ok(json) = serde_json::from_str::<Json>(text) {
        return parse_kubepit(json);
    }
    let yaml: Yaml = serde_yaml::from_str(text)
        .context("the file is neither a Kubepit export nor a k9s plugins file")?;
    parse_k9s(&yaml)
}

/// `{ "actions": [...] }` (what Kubepit exports) or a bare array.
pub fn parse_kubepit(json: Json) -> Result<CustomActionImport> {
    let items = match json {
        Json::Array(items) => items,
        Json::Object(mut map) => match map.remove("actions") {
            Some(Json::Array(items)) => items,
            _ => bail!("the file is not a Kubepit custom actions export"),
        },
        _ => bail!("the file is not a Kubepit custom actions export"),
    };
    let mut out = CustomActionImport {
        format: FORMAT_KUBEPIT.to_string(),
        ..Default::default()
    };
    for item in items {
        let label = item
            .get("name")
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_string();
        let parsed = serde_json::from_value::<CustomAction>(item)
            .map_err(anyhow::Error::from)
            .and_then(validate_action);
        match parsed {
            Ok(action) => out.actions.push(action),
            Err(e) => out
                .notes
                .push(note(&label, codes::INVALID_ACTION, &format!("{e:#}"))),
        }
    }
    Ok(out)
}

fn note(action: &str, code: &str, detail: &str) -> CustomActionImportNote {
    CustomActionImportNote {
        action: action.to_string(),
        code: code.to_string(),
        detail: detail.to_string(),
    }
}

/// k9s `plugins.yaml` (`plugins:` map) or a single plugin file (top-level map).
pub fn parse_k9s(yaml: &Yaml) -> Result<CustomActionImport> {
    let Some(root) = yaml.as_mapping() else {
        bail!("the file is not a k9s plugins file");
    };
    let plugins = match root.get("plugins") {
        Some(Yaml::Mapping(map)) => map,
        Some(_) => bail!("`plugins` must be a map of plugin definitions"),
        None if root.values().any(|v| v.get("command").is_some()) => root,
        None => bail!("the file is not a k9s plugins file"),
    };
    let mut out = CustomActionImport {
        format: FORMAT_K9S.to_string(),
        ..Default::default()
    };
    for (key, plugin) in plugins {
        let key = yaml_text(key).unwrap_or_default();
        match plugin.as_mapping() {
            Some(map) => {
                if let Some(action) = convert_plugin(&key, map, &mut out.notes) {
                    out.actions.push(action);
                }
            }
            None => out
                .notes
                .push(note(&key, codes::INVALID_PLUGIN, "not a map")),
        }
    }
    Ok(out)
}

fn yaml_text(value: &Yaml) -> Option<String> {
    match value {
        Yaml::String(s) => Some(s.clone()),
        Yaml::Number(n) => Some(n.to_string()),
        Yaml::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn yaml_bool(map: &Mapping, key: &str) -> bool {
    matches!(map.get(key), Some(Yaml::Bool(true)))
}

const KNOWN_FIELDS: &[&str] = &[
    "shortCut",
    "description",
    "scopes",
    "command",
    "args",
    "background",
    "confirm",
    "dangerous",
];

fn convert_plugin(
    key: &str,
    map: &Mapping,
    notes: &mut Vec<CustomActionImportNote>,
) -> Option<CustomAction> {
    let description = map
        .get("description")
        .and_then(yaml_text)
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    let label = description.clone().unwrap_or_else(|| key.to_string());
    for field in map.keys().filter_map(yaml_text) {
        if !KNOWN_FIELDS.contains(&field.as_str()) {
            notes.push(note(&label, codes::UNSUPPORTED_FIELD, &field));
        }
    }
    let Some(command) = map
        .get("command")
        .and_then(yaml_text)
        .filter(|c| !c.trim().is_empty())
    else {
        notes.push(note(&label, codes::INVALID_PLUGIN, "command is missing"));
        return None;
    };

    let mut scopes: Vec<String> = Vec::new();
    let mut containers_view = false;
    let raw_scopes: Vec<String> = match map.get("scopes") {
        Some(Yaml::Sequence(items)) => items.iter().filter_map(yaml_text).collect(),
        Some(other) => yaml_text(other).into_iter().collect(),
        None => Vec::new(),
    };
    for raw in &raw_scopes {
        match map_scope(raw) {
            ScopeMapping::Exact(scope, containers) => {
                containers_view |= containers;
                if !scopes.contains(&scope) {
                    scopes.push(scope);
                }
            }
            ScopeMapping::Guessed(scope) => {
                notes.push(note(
                    &label,
                    codes::GUESSED_SCOPE,
                    &format!("{raw} → {scope}"),
                ));
                if !scopes.contains(&scope) {
                    scopes.push(scope);
                }
            }
            ScopeMapping::Unsupported => {
                notes.push(note(&label, codes::UNSUPPORTED_SCOPE, raw));
            }
        }
    }
    if scopes.is_empty() {
        notes.push(note(&label, codes::NO_SCOPE, &raw_scopes.join(", ")));
        return None;
    }

    let vars = VarMap { containers_view };
    let args: Vec<String> = match map.get("args") {
        Some(Yaml::Sequence(items)) => items.iter().filter_map(yaml_text).collect(),
        Some(other) => yaml_text(other).into_iter().collect(),
        None => Vec::new(),
    };
    let mut unsupported: Vec<String> = Vec::new();
    let template = build_command(&command, &args, &vars, &mut unsupported, &label, notes);
    for var in unsupported {
        notes.push(note(&label, codes::UNSUPPORTED_VARIABLE, &var));
    }

    let shortcut = map.get("shortCut").and_then(yaml_text).and_then(|raw| {
        match k9s_shortcut(&raw).and_then(|s| normalize_shortcut(&s).ok()) {
            Some(s) => Some(s),
            None => {
                notes.push(note(&label, codes::INVALID_SHORTCUT, &raw));
                None
            }
        }
    });

    let action = CustomAction {
        id: format!("k9s-{}", slug(key)),
        name: label.chars().take(80).collect(),
        description: String::new(),
        scopes,
        command: template,
        mode: if yaml_bool(map, "background") {
            CustomActionMode::Background
        } else {
            CustomActionMode::Terminal
        },
        confirm: yaml_bool(map, "confirm"),
        mutating: yaml_bool(map, "dangerous"),
        shortcut,
        ..Default::default()
    };
    match validate_action(action) {
        Ok(action) => Some(action),
        Err(e) => {
            notes.push(note(&label, codes::INVALID_PLUGIN, &format!("{e:#}")));
            None
        }
    }
}

fn slug(key: &str) -> String {
    let mut out: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    out.truncate(48);
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "plugin".to_string()
    } else {
        trimmed
    }
}

/// `Shift-L` → `shift+l`, `Ctrl-Alt-X` → `ctrl+alt+x`, `L` → `shift+l`.
fn k9s_shortcut(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw.split('-').collect();
    let (key, mods) = parts.split_last()?;
    let mut out: Vec<String> = Vec::new();
    for m in mods {
        out.push(match m.to_ascii_lowercase().as_str() {
            "shift" => "shift".into(),
            "ctrl" | "control" => "ctrl".into(),
            "alt" => "alt".into(),
            _ => return None,
        });
    }
    let mut key = key.to_string();
    if key.chars().count() == 1 {
        let c = key.chars().next()?;
        if c.is_ascii_uppercase() && !out.iter().any(|m| m == "shift") && mods.is_empty() {
            out.push("shift".into());
        }
        key = c.to_ascii_lowercase().to_string();
    }
    out.push(key);
    Some(out.join("+"))
}

// -- Scopes -------------------------------------------------------------------

enum ScopeMapping {
    /// Scope, and whether it is the k9s containers view.
    Exact(String, bool),
    Guessed(String),
    Unsupported,
}

/// k9s resource names (plural, singular, short) → Kubepit scopes.
const SCOPE_TABLE: &[(&[&str], &str)] = &[
    (&["pods", "pod", "po"], "core/Pod"),
    (
        &["deployments", "deployment", "deploy", "dp"],
        "apps/Deployment",
    ),
    (&["statefulsets", "statefulset", "sts"], "apps/StatefulSet"),
    (&["daemonsets", "daemonset", "ds"], "apps/DaemonSet"),
    (&["replicasets", "replicaset", "rs"], "apps/ReplicaSet"),
    (&["jobs", "job"], "batch/Job"),
    (&["cronjobs", "cronjob", "cj"], "batch/CronJob"),
    (&["services", "service", "svc"], "core/Service"),
    (
        &["ingresses", "ingress", "ing"],
        "networking.k8s.io/Ingress",
    ),
    (&["configmaps", "configmap", "cm"], "core/ConfigMap"),
    (&["secrets", "secret", "sec"], "core/Secret"),
    (&["namespaces", "namespace", "ns"], "core/Namespace"),
    (&["nodes", "node", "no"], "core/Node"),
    (
        &["persistentvolumeclaims", "persistentvolumeclaim", "pvc"],
        "core/PersistentVolumeClaim",
    ),
    (
        &["persistentvolumes", "persistentvolume", "pv"],
        "core/PersistentVolume",
    ),
    (
        &["serviceaccounts", "serviceaccount", "sa"],
        "core/ServiceAccount",
    ),
    (&["events", "event", "ev"], "core/Event"),
    (&["endpoints", "ep"], "core/Endpoints"),
    (
        &["horizontalpodautoscalers", "horizontalpodautoscaler", "hpa"],
        "autoscaling/HorizontalPodAutoscaler",
    ),
    (
        &["networkpolicies", "networkpolicy", "netpol", "np"],
        "networking.k8s.io/NetworkPolicy",
    ),
    (
        &["storageclasses", "storageclass", "sc"],
        "storage.k8s.io/StorageClass",
    ),
    (&["roles", "role", "ro"], "rbac.authorization.k8s.io/Role"),
    (
        &["rolebindings", "rolebinding", "rb"],
        "rbac.authorization.k8s.io/RoleBinding",
    ),
    (
        &["clusterroles", "clusterrole", "cr"],
        "rbac.authorization.k8s.io/ClusterRole",
    ),
    (
        &["clusterrolebindings", "clusterrolebinding", "crb"],
        "rbac.authorization.k8s.io/ClusterRoleBinding",
    ),
    (
        &[
            "customresourcedefinitions",
            "customresourcedefinition",
            "crd",
            "crds",
        ],
        "apiextensions.k8s.io/CustomResourceDefinition",
    ),
    (
        &["poddisruptionbudgets", "poddisruptionbudget", "pdb"],
        "policy/PodDisruptionBudget",
    ),
];

/// k9s views without a Kubernetes kind behind them.
const UNSUPPORTED_SCOPES: &[&str] = &[
    "helm",
    "hr",
    "chart",
    "charts",
    "contexts",
    "context",
    "ctx",
    "aliases",
    "alias",
    "a",
    "xray",
    "x",
    "pulses",
    "pulse",
    "pu",
    "popeye",
    "pop",
    "users",
    "user",
    "usr",
    "groups",
    "group",
    "grp",
    "portforwards",
    "portforward",
    "pf",
    "benchmarks",
    "benchmark",
    "be",
    "screendumps",
    "screendump",
    "sd",
    "dir",
    "workloads",
    "wk",
];

fn singular(plural: &str) -> String {
    let p = plural.to_ascii_lowercase();
    if let Some(stem) = p.strip_suffix("ies") {
        return format!("{stem}y");
    }
    if p.ends_with("sses") || p.ends_with("ches") || p.ends_with("shes") || p.ends_with("xes") {
        return p[..p.len() - 2].to_string();
    }
    if let Some(stem) = p.strip_suffix('s') {
        if !stem.ends_with('s') {
            return stem.to_string();
        }
    }
    p
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

fn map_scope(raw: &str) -> ScopeMapping {
    let name = raw.trim().to_ascii_lowercase();
    if name.is_empty() {
        return ScopeMapping::Unsupported;
    }
    if name == "all" {
        return ScopeMapping::Exact(SCOPE_ANY.to_string(), false);
    }
    if matches!(name.as_str(), "containers" | "container" | "co") {
        return ScopeMapping::Exact("core/Pod".to_string(), true);
    }
    if UNSUPPORTED_SCOPES.contains(&name.as_str()) {
        return ScopeMapping::Unsupported;
    }
    // `apps/v1/deployments`, `v1/pods` (group/version/resource).
    let (group, resource) = {
        let parts: Vec<&str> = name.split('/').collect();
        match parts.as_slice() {
            [resource] => match resource.split_once('.') {
                Some((res, group)) => (Some(group.to_string()), res.to_string()),
                None => (None, resource.to_string()),
            },
            [_version, resource] => (Some(String::new()), resource.to_string()),
            [group, _version, resource] => (Some(group.to_string()), resource.to_string()),
            _ => return ScopeMapping::Unsupported,
        }
    };
    if !resource.chars().all(|c| c.is_ascii_alphanumeric()) || resource.is_empty() {
        return ScopeMapping::Unsupported;
    }
    if let Some((_, scope)) = SCOPE_TABLE
        .iter()
        .find(|(names, _)| names.contains(&resource.as_str()))
    {
        let table_group = scope.split_once('/').map(|(g, _)| g).unwrap_or("");
        let matches_group = match group.as_deref() {
            None => true,
            Some("") => table_group == "core",
            Some(g) => g == table_group,
        };
        if matches_group {
            return ScopeMapping::Exact(scope.to_string(), false);
        }
    }
    let kind = capitalize(&singular(&resource));
    let scope = match group.as_deref() {
        None => kind,
        Some("") => format!("core/{kind}"),
        Some(group) => {
            if !group
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
            {
                return ScopeMapping::Unsupported;
            }
            format!("{group}/{kind}")
        }
    };
    ScopeMapping::Guessed(scope)
}

// -- Commands -----------------------------------------------------------------

struct VarMap {
    containers_view: bool,
}

/// Variables k9s substitutes that have no Kubepit placeholder.
const K9S_ONLY: &[&str] = &["FILTER", "USER", "GROUPS"];

impl VarMap {
    /// Placeholder for a k9s variable, `None` for plain shell variables.
    fn placeholder(&self, var: &str) -> Option<&'static str> {
        Some(match var {
            "NAMESPACE" => "{namespace}",
            "NAME" if self.containers_view => "{container}",
            "NAME" => "{name}",
            "POD" => "{name}",
            "CONTAINER" => "{container}",
            "CONTEXT" => "{context}",
            "CLUSTER" => "{cluster}",
            "KUBECONFIG" => "{kubeconfig}",
            "RESOURCE_GROUP" => "{group}",
            "RESOURCE_VERSION" => "{version}",
            "RESOURCE_NAME" => "{resource}",
            _ => return None,
        })
    }

    fn is_k9s_only(var: &str) -> bool {
        K9S_ONLY.contains(&var) || var.starts_with("COL-")
    }
}

/// A `$VAR` / `${VAR}` / `$COL-NAME` reference at the start of `chars[i..]`
/// (`chars[i] == '$'`): the variable name and the length of the reference.
fn variable_at(chars: &[char], i: usize) -> Option<(String, usize)> {
    let first = *chars.get(i + 1)?;
    if first == '{' {
        let end = chars[i + 2..].iter().position(|c| *c == '}')?;
        let name: String = chars[i + 2..i + 2 + end].iter().collect();
        let valid = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        return valid.then(|| (name, end + 3));
    }
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let mut len = 1;
    while let Some(c) = chars.get(i + len) {
        if c.is_ascii_alphanumeric() || *c == '_' {
            len += 1;
        } else {
            break;
        }
    }
    let mut name: String = chars[i + 1..i + len].iter().collect();
    // k9s column variables: `$COL-RESTARTS`.
    if name == "COL" && chars.get(i + len) == Some(&'-') {
        let mut extra = 1;
        while let Some(c) = chars.get(i + len + extra) {
            if c.is_ascii_alphanumeric() || *c == '_' || *c == '-' {
                extra += 1;
            } else {
                break;
            }
        }
        if extra > 1 {
            name = chars[i + 1..i + len + extra].iter().collect();
            len += extra;
        }
    }
    Some((name, len))
}

const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "ash"];

fn build_command(
    command: &str,
    args: &[String],
    vars: &VarMap,
    unsupported: &mut Vec<String>,
    label: &str,
    notes: &mut Vec<CustomActionImportNote>,
) -> String {
    let base = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .trim()
        .to_ascii_lowercase();
    if SHELLS.contains(&base.as_str()) {
        // `bash -c "script"` / `sh -lc "script"`: the script is the command.
        let flag = args.iter().position(|a| {
            a.starts_with('-')
                && !a.starts_with("--")
                && a.len() > 1
                && a[1..].chars().all(|c| c.is_ascii_alphabetic())
                && a.contains('c')
        });
        if let Some(i) = flag {
            if let Some(script) = args.get(i + 1) {
                if args.len() > i + 2 {
                    notes.push(note(label, codes::EXTRA_ARGS, &args[i + 2..].join(" ")));
                }
                return convert_script(script, vars, unsupported);
            }
        }
    }
    let mut words = vec![convert_word(command, vars, unsupported)];
    words.extend(args.iter().map(|a| convert_word(a, vars, unsupported)));
    words.join(" ")
}

fn remember(unsupported: &mut Vec<String>, var: &str) {
    let token = format!("${var}");
    if !unsupported.contains(&token) {
        unsupported.push(token);
    }
}

/// One argv entry → a shell word: literal parts quoted, variables mapped.
fn convert_word(word: &str, vars: &VarMap, unsupported: &mut Vec<String>) -> String {
    let chars: Vec<char> = word.chars().collect();
    let mut out = String::new();
    let mut literal = String::new();
    let flush = |literal: &mut String, out: &mut String| {
        if !literal.is_empty() {
            out.push_str(&shell_quote(literal));
            literal.clear();
        }
    };
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' {
            if let Some((name, len)) = variable_at(&chars, i) {
                if let Some(p) = vars.placeholder(&name) {
                    flush(&mut literal, &mut out);
                    out.push_str(p);
                    i += len;
                    continue;
                }
                // k9s expanded every `$VAR` of an argument; keep it a shell
                // variable (double-quoted so it stays one word).
                if VarMap::is_k9s_only(&name) {
                    remember(unsupported, &name);
                }
                if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    flush(&mut literal, &mut out);
                    out.push_str(&format!("\"${{{name}}}\""));
                    i += len;
                    continue;
                }
            }
        }
        literal.push(chars[i]);
        i += 1;
    }
    flush(&mut literal, &mut out);
    if out.is_empty() {
        "''".to_string()
    } else {
        out
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Quote {
    None,
    Single,
    Double,
}

/// A shell script → a template: `$VAR`s k9s knew become placeholders
/// wherever they sit (k9s substituted them textually, even inside single
/// quotes); quotes around a lone variable are dropped.
fn convert_script(script: &str, vars: &VarMap, unsupported: &mut Vec<String>) -> String {
    let chars: Vec<char> = script.chars().collect();
    let mut out = String::new();
    let mut state = Quote::None;
    // Output length right after the current quote was opened.
    let mut opened_at = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match (state, c) {
            (Quote::None | Quote::Double, '\\') => {
                out.push(c);
                if let Some(next) = chars.get(i + 1) {
                    out.push(*next);
                }
                i += 2;
                continue;
            }
            (Quote::None, '\'') => {
                state = Quote::Single;
                out.push(c);
                opened_at = out.len();
            }
            (Quote::None, '"') => {
                state = Quote::Double;
                out.push(c);
                opened_at = out.len();
            }
            (Quote::Single, '\'') | (Quote::Double, '"') => {
                state = Quote::None;
                out.push(c);
            }
            (_, '$') => {
                if let Some((name, len)) = variable_at(&chars, i) {
                    if VarMap::is_k9s_only(&name) {
                        remember(unsupported, &name);
                    }
                    if let Some(p) = vars.placeholder(&name) {
                        let close = if state == Quote::Single { '\'' } else { '"' };
                        let lone = state != Quote::None
                            && out.len() == opened_at
                            && chars.get(i + len) == Some(&close);
                        if lone {
                            // `"$NAME"` → `{name}`.
                            out.pop();
                            out.push_str(p);
                            state = Quote::None;
                            i += len + 1;
                        } else if state == Quote::None {
                            out.push_str(p);
                            i += len;
                        } else {
                            // Close the quote around the placeholder, reopen after
                            // (an empty `""` before it is dropped instead).
                            if out.len() == opened_at {
                                out.pop();
                            } else {
                                out.push(close);
                            }
                            out.push_str(p);
                            out.push(close);
                            opened_at = out.len();
                            i += len;
                            // An immediately closing quote would leave `""`.
                            if chars.get(i) == Some(&close) {
                                out.pop();
                                state = Quote::None;
                                i += 1;
                            }
                        }
                        continue;
                    }
                }
                out.push(c);
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k9s(yaml: &str) -> CustomActionImport {
        parse_import(yaml).unwrap()
    }

    #[test]
    fn scripts_map_variables_by_quote_context() {
        let vars = VarMap {
            containers_view: false,
        };
        let mut unsupported = Vec::new();
        let convert = |s: &str, u: &mut Vec<String>| convert_script(s, &vars, u);
        assert_eq!(
            convert(
                "kubectl logs $NAME -n $NAMESPACE --context $CONTEXT | less",
                &mut unsupported
            ),
            "kubectl logs {name} -n {namespace} --context {context} | less"
        );
        assert_eq!(
            convert("echo \"$NAME\" '$NAME' ${NAMESPACE}", &mut unsupported),
            "echo {name} {name} {namespace}"
        );
        assert_eq!(
            convert("echo \"pod $NAME in $NAMESPACE\"", &mut unsupported),
            "echo \"pod \"{name}\" in \"{namespace}"
        );
        assert_eq!(
            convert("echo '$NAME/x'", &mut unsupported),
            "echo {name}'/x'"
        );
        assert_eq!(
            convert("echo \"$NAME is $NAMESPACE\"", &mut unsupported),
            "echo {name}\" is \"{namespace}"
        );
        assert_eq!(
            convert("echo \\$NAME $HOME", &mut unsupported),
            "echo \\$NAME $HOME"
        );
        assert!(unsupported.is_empty());
        assert_eq!(
            convert("stern $FILTER $COL-READY", &mut unsupported),
            "stern $FILTER $COL-READY"
        );
        assert_eq!(unsupported, vec!["$FILTER", "$COL-READY"]);
    }

    #[test]
    fn argv_words_are_quoted() {
        let vars = VarMap {
            containers_view: true,
        };
        let mut unsupported = Vec::new();
        assert_eq!(
            convert_word("--container=$NAME", &vars, &mut unsupported),
            "--container={container}"
        );
        assert_eq!(convert_word("$POD", &vars, &mut unsupported), "{name}");
        assert_eq!(convert_word("a b", &vars, &mut unsupported), "'a b'");
        assert_eq!(convert_word("", &vars, &mut unsupported), "''");
        assert_eq!(
            convert_word("$FILTER", &vars, &mut unsupported),
            "\"${FILTER}\""
        );
        assert_eq!(
            convert_word("-o=jsonpath={.status}", &vars, &mut unsupported),
            "'-o=jsonpath={.status}'"
        );
        assert_eq!(unsupported, vec!["$FILTER"]);
    }

    #[test]
    fn k9s_shortcuts() {
        assert_eq!(k9s_shortcut("Shift-L").as_deref(), Some("shift+l"));
        assert_eq!(k9s_shortcut("Ctrl-J").as_deref(), Some("ctrl+j"));
        assert_eq!(
            k9s_shortcut("Ctrl-Shift-K").as_deref(),
            Some("ctrl+shift+k")
        );
        assert_eq!(k9s_shortcut("L").as_deref(), Some("shift+l"));
        assert_eq!(k9s_shortcut("l").as_deref(), Some("l"));
        assert_eq!(k9s_shortcut("Hyper-L"), None);
    }

    #[test]
    fn scopes() {
        let exact = |s: &str| match map_scope(s) {
            ScopeMapping::Exact(scope, _) => scope,
            _ => panic!("{s} is not exact"),
        };
        let guessed = |s: &str| match map_scope(s) {
            ScopeMapping::Guessed(scope) => scope,
            _ => panic!("{s} is not guessed"),
        };
        assert_eq!(exact("pods"), "core/Pod");
        assert_eq!(exact("Deploy"), "apps/Deployment");
        assert_eq!(exact("all"), "*");
        assert_eq!(exact("containers"), "core/Pod");
        assert_eq!(exact("apps/v1/deployments"), "apps/Deployment");
        assert_eq!(exact("v1/pods"), "core/Pod");
        assert_eq!(
            guessed("applications.argoproj.io"),
            "argoproj.io/Application"
        );
        assert_eq!(guessed("certificates"), "Certificate");
        assert_eq!(
            guessed("helmreleases.helm.toolkit.fluxcd.io"),
            "helm.toolkit.fluxcd.io/Helmrelease"
        );
        assert_eq!(guessed("ingressclasses"), "Ingressclass");
        assert_eq!(guessed("policies"), "Policy");
        assert!(matches!(map_scope("helm"), ScopeMapping::Unsupported));
        assert!(matches!(map_scope("a b"), ScopeMapping::Unsupported));
    }

    #[test]
    fn imports_a_k9s_plugins_file() {
        let out = k9s(r#"
plugins:
  stern:
    shortCut: Ctrl-L
    confirm: false
    description: Logs <Stern>
    scopes: [pods, deploy]
    command: stern
    background: false
    args: [--tail, 50, $FILTER, -n, $NAMESPACE, --context, $CONTEXT]
  debug:
    shortCut: Shift-D
    description: Add debug container
    dangerous: true
    confirm: true
    scopes: [containers]
    command: bash
    args:
      - -c
      - "kubectl debug -it --context $CONTEXT -n=$NAMESPACE $POD --target=$NAME --image=nicolaka/netshoot"
  helm-values:
    shortCut: v
    scopes: [helm]
    command: sh
    args: [-c, "helm get values $NAME"]
  watch:
    scopes: [all]
    command: kubectl
    background: true
    pipes: [less]
    args: [get, $RESOURCE_NAME, $NAME, -n, $NAMESPACE, -o, yaml]
"#);
        assert_eq!(out.format, FORMAT_K9S);
        assert_eq!(out.actions.len(), 3, "{:?}", out.notes);
        let stern = &out.actions[0];
        assert_eq!(stern.id, "k9s-stern");
        assert_eq!(stern.name, "Logs <Stern>");
        assert_eq!(stern.scopes, vec!["core/Pod", "apps/Deployment"]);
        assert_eq!(
            stern.command,
            "stern --tail 50 \"${FILTER}\" -n {namespace} --context {context}"
        );
        assert_eq!(stern.shortcut.as_deref(), Some("ctrl+l"));
        assert_eq!(stern.mode, CustomActionMode::Terminal);

        let debug = &out.actions[1];
        assert!(debug.mutating && debug.confirm);
        assert_eq!(
            debug.command,
            "kubectl debug -it --context {context} -n={namespace} {name} --target={container} --image=nicolaka/netshoot"
        );
        assert_eq!(debug.shortcut.as_deref(), Some("shift+d"));

        let watch = &out.actions[2];
        assert_eq!(watch.scopes, vec!["*"]);
        assert_eq!(watch.mode, CustomActionMode::Background);
        assert_eq!(
            watch.command,
            "kubectl get {resource} {name} -n {namespace} -o yaml"
        );

        let codes: Vec<(&str, &str)> = out
            .notes
            .iter()
            .map(|n| (n.code.as_str(), n.detail.as_str()))
            .collect();
        assert!(codes.contains(&(codes::UNSUPPORTED_VARIABLE, "$FILTER")));
        assert!(codes.contains(&(codes::UNSUPPORTED_SCOPE, "helm")));
        assert!(codes.contains(&(codes::NO_SCOPE, "helm")));
        assert!(codes.contains(&(codes::UNSUPPORTED_FIELD, "pipes")));
    }

    #[test]
    fn imports_a_single_plugin_file_and_rejects_garbage() {
        let out = k9s("neat:\n  scopes: [all]\n  command: kubectl\n  args: [neat]\n");
        assert_eq!(out.actions.len(), 1);
        assert!(parse_import("just text").is_err());
        assert!(parse_import("plugins: 3").is_err());
        assert!(parse_import("{\"hello\": 1}").is_err());
        let broken = k9s("plugins:\n  a: 1\n  b:\n    scopes: [pods]\n");
        assert!(broken.actions.is_empty());
        assert_eq!(broken.notes.len(), 2);
    }

    #[test]
    fn imports_kubepit_exports() {
        let json = serde_json::json!({
            "kubepit": "custom-actions",
            "version": 1,
            "actions": [
                { "id": "a", "name": "Describe", "command": "kubectl describe {resource} {name}", "scopes": ["*"] },
                { "id": "b", "name": "", "command": "x" },
                { "name": "No id", "command": "echo", "mode": "background", "shortcut": "Ctrl+X" }
            ]
        });
        let out = parse_import(&json.to_string()).unwrap();
        assert_eq!(out.format, FORMAT_KUBEPIT);
        assert_eq!(out.actions.len(), 2);
        assert_eq!(out.actions[1].shortcut.as_deref(), Some("ctrl+x"));
        assert_eq!(out.notes.len(), 1);
        assert_eq!(out.notes[0].code, codes::INVALID_ACTION);
        let bare = parse_import("[]").unwrap();
        assert!(bare.actions.is_empty());
    }
}
