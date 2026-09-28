//! Custom action definitions, validation and scope matching.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::template::{placeholders, segments, Placeholder, Segment};
use crate::types::ClusterDef;

/// How an action runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CustomActionMode {
    /// A dock terminal tab running the command through the login shell.
    #[default]
    Terminal,
    /// Run without a terminal; stdout / stderr are captured.
    Background,
    /// Open the resolved URL in the browser.
    OpenUrl,
}

/// Icons a definition may use (lucide names, drawn by the UI).
pub const ICONS: &[&str] = &[
    "terminal",
    "play",
    "file-text",
    "search",
    "external-link",
    "bug",
    "zap",
    "wrench",
    "eye",
    "list",
    "activity",
    "git-branch",
    "cloud",
    "database",
    "shield",
    "trash",
    "refresh",
    "tag",
    "gauge",
    "rocket",
];

pub const DEFAULT_ICON: &str = "terminal";
pub const DEFAULT_TIMEOUT_SECS: u32 = 30;
pub const MAX_TIMEOUT_SECS: u32 = 600;
const MAX_NAME: usize = 80;
const MAX_DESCRIPTION: usize = 500;
const MAX_COMMAND: usize = 8192;
const MAX_ACTIONS: usize = 500;

/// Scope entry for actions without an object (cluster level).
pub const SCOPE_CLUSTER: &str = "cluster";
/// Scope entry matching every object.
pub const SCOPE_ANY: &str = "*";

/// One user-defined action (`~/.kubepit/actions.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomAction {
    pub id: String,
    pub name: String,
    pub description: String,
    /// One of [`ICONS`].
    pub icon: String,
    pub enabled: bool,
    /// `Kind` (any group), `group/Kind`, `group/*`, `core/Kind` (core
    /// group), `*` (every object) or `cluster` (no object).
    pub scopes: Vec<String>,
    /// Namespace globs (`*`, `?`); empty = every namespace. Cluster-scoped
    /// objects and cluster-level runs are not filtered.
    pub namespaces: Vec<String>,
    /// Cluster tags, any of which must be set on the cluster; empty = all.
    pub cluster_tags: Vec<String>,
    /// Command line (`sh` syntax) or URL template.
    pub command: String,
    pub mode: CustomActionMode,
    /// Show the resolved command and ask before running.
    pub confirm: bool,
    /// Changes the cluster: refused on read-only clusters, typed
    /// confirmation on production clusters.
    pub mutating: bool,
    /// Keyboard shortcut (`ctrl+shift+l`, `x`), see [`normalize_shortcut`].
    pub shortcut: Option<String>,
    /// Background runs are killed after this many seconds.
    pub timeout_secs: u32,
}

impl Default for CustomAction {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            icon: DEFAULT_ICON.to_string(),
            enabled: true,
            scopes: vec![SCOPE_ANY.to_string()],
            namespaces: Vec::new(),
            cluster_tags: Vec::new(),
            command: String::new(),
            mode: CustomActionMode::Terminal,
            confirm: false,
            mutating: false,
            shortcut: None,
            timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }
}

impl CustomAction {
    /// Whether the command uses `{selection.names}` (offered for multi-select).
    pub fn is_multi(&self) -> bool {
        placeholders(&self.command).contains(&Placeholder::SelectionNames)
    }
}

/// The object (or cluster-level context) an action runs on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomActionTarget {
    /// Object namespace; for cluster-level runs the namespace in scope.
    pub namespace: Option<String>,
    /// `None` for cluster-level runs.
    pub name: Option<String>,
    pub kind: Option<String>,
    pub group: Option<String>,
    pub version: Option<String>,
    /// Plural resource name (`deployments`).
    pub resource: Option<String>,
    pub container: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    /// Names of every selected object (multi-select); empty = just `name`.
    pub selection: Vec<String>,
}

/// `custom_action_resolve`: the command (or URL) an action would run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ResolvedCustomAction {
    pub command: String,
    /// Placeholders without a value (substituted as empty).
    pub missing: Vec<String>,
    /// `{…}` tokens that look like misspelled placeholders (kept literal).
    pub unknown: Vec<String>,
}

/// `custom_action_run` (background and open-url modes).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CustomActionResult {
    pub mode: CustomActionMode,
    /// The resolved command, or the URL to open.
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// Output beyond the capture limit was dropped.
    pub truncated: bool,
    pub duration_ms: u64,
}

/// Shape of `actions.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomActionsFile {
    pub version: u32,
    pub actions: Vec<CustomAction>,
}

/// `custom_actions_list`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CustomActionsState {
    pub actions: Vec<CustomAction>,
    /// False until `actions.json` was first written (the UI then seeds the
    /// built-in examples, disabled, in the user's language).
    pub initialized: bool,
}

/// `custom_actions_import`: definitions read from a file, not saved yet.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CustomActionImport {
    /// `kubepit` (exported JSON) or `k9s` (`plugins.yaml`).
    pub format: String,
    pub actions: Vec<CustomAction>,
    pub notes: Vec<CustomActionImportNote>,
}

/// Something an import could not map exactly. `code` is stable (the UI
/// translates it); `detail` is the offending value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomActionImportNote {
    /// Name of the plugin / action it concerns.
    pub action: String,
    pub code: String,
    pub detail: String,
}

// -- Shortcuts ---------------------------------------------------------------

const NAMED_KEYS: &[&str] = &[
    "enter",
    "space",
    "tab",
    "backspace",
    "delete",
    "insert",
    "home",
    "end",
    "pageup",
    "pagedown",
    "up",
    "down",
    "left",
    "right",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
];
const MODIFIERS: [&str; 4] = ["ctrl", "alt", "shift", "meta"];

/// Canonical form of a shortcut: lowercase, modifiers in `ctrl+alt+shift+meta`
/// order, then one key — a letter, digit or punctuation character (typed
/// characters such as `?` already include Shift, so `shift` only combines
/// with letters and named keys) or a named key. Escape is reserved.
pub fn normalize_shortcut(raw: &str) -> Result<String> {
    let text = raw.trim().to_ascii_lowercase();
    if text.is_empty() {
        bail!("the shortcut is empty");
    }
    // A trailing `+` is the plus key itself (`ctrl++`).
    let (mods_text, key) = match text.strip_suffix("++") {
        Some(head) => (head.to_string(), "+".to_string()),
        None if text == "+" => (String::new(), "+".to_string()),
        None => match text.rsplit_once('+') {
            Some((head, key)) => (head.to_string(), key.to_string()),
            None => (String::new(), text.clone()),
        },
    };
    let mut mods: Vec<&str> = Vec::new();
    if !mods_text.is_empty() {
        for part in mods_text.split('+') {
            let name = match part {
                "control" => "ctrl",
                "option" | "opt" => "alt",
                "cmd" | "command" | "win" | "super" => "meta",
                other => other,
            };
            let Some(canonical) = MODIFIERS.iter().find(|m| **m == name) else {
                bail!("unknown modifier {part:?} in shortcut {raw:?}");
            };
            if mods.contains(canonical) {
                bail!("modifier {part:?} repeats in shortcut {raw:?}");
            }
            mods.push(canonical);
        }
    }
    let key = match key.as_str() {
        "esc" | "escape" => bail!("Escape cannot be used in a shortcut"),
        "return" => "enter".to_string(),
        "arrowup" => "up".to_string(),
        "arrowdown" => "down".to_string(),
        "arrowleft" => "left".to_string(),
        "arrowright" => "right".to_string(),
        "del" => "delete".to_string(),
        other => other.to_string(),
    };
    let single = key.chars().count() == 1;
    if single {
        let c = key.chars().next().unwrap_or(' ');
        if c.is_whitespace() || c.is_control() {
            bail!("invalid key in shortcut {raw:?}");
        }
        if mods.contains(&"shift") && !c.is_ascii_alphabetic() {
            bail!("shift can only be combined with letters or named keys (write the typed character instead, e.g. ?)");
        }
    } else if !NAMED_KEYS.contains(&key.as_str()) {
        bail!("unknown key {key:?} in shortcut {raw:?}");
    }
    let mut ordered: Vec<&str> = MODIFIERS
        .iter()
        .copied()
        .filter(|m| mods.contains(m))
        .collect();
    ordered.push(&key);
    Ok(ordered.join("+"))
}

// -- Scopes ------------------------------------------------------------------

/// Validate and canonicalise one scope entry.
pub fn normalize_scope(raw: &str) -> Result<String> {
    let text = raw.trim();
    if text.is_empty() {
        bail!("empty scope");
    }
    if text == SCOPE_ANY || text.eq_ignore_ascii_case(SCOPE_CLUSTER) {
        return Ok(text.to_ascii_lowercase());
    }
    let (group, kind) = match text.rsplit_once('/') {
        Some((group, kind)) => (Some(group.trim()), kind.trim()),
        None => (None, text),
    };
    let valid_kind =
        kind == "*" || (!kind.is_empty() && kind.chars().all(|c| c.is_ascii_alphanumeric()));
    if !valid_kind {
        bail!("invalid kind in scope {raw:?}");
    }
    match group {
        None if kind == "*" => Ok(SCOPE_ANY.to_string()),
        None => Ok(kind.to_string()),
        Some(group) => {
            let valid_group = !group.is_empty()
                && group
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
            if !valid_group {
                bail!("invalid API group in scope {raw:?}");
            }
            Ok(format!("{}/{kind}", group.to_ascii_lowercase()))
        }
    }
}

/// Simple glob: `*` any run, `?` one character; case-sensitive.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn scope_matches_kind(scope: &str, group: &str, kind: &str) -> bool {
    if scope == SCOPE_ANY {
        return true;
    }
    if scope == SCOPE_CLUSTER {
        return false;
    }
    match scope.rsplit_once('/') {
        None => scope.eq_ignore_ascii_case(kind),
        Some((scope_group, scope_kind)) => {
            let group_ok = if scope_group == "core" {
                group.is_empty()
            } else {
                scope_group.eq_ignore_ascii_case(group)
            };
            group_ok && (scope_kind == "*" || scope_kind.eq_ignore_ascii_case(kind))
        }
    }
}

/// Whether `action` is offered for `target` on `cluster`.
pub fn applies_to(
    action: &CustomAction,
    cluster: &ClusterDef,
    target: &CustomActionTarget,
) -> bool {
    if !action.cluster_tags.is_empty()
        && !action.cluster_tags.iter().any(|want| {
            cluster
                .tags
                .iter()
                .any(|have| have.eq_ignore_ascii_case(want))
        })
    {
        return false;
    }
    let Some(kind) = target.kind.as_deref().filter(|k| !k.is_empty()) else {
        return action.scopes.iter().any(|s| s == SCOPE_CLUSTER);
    };
    let group = target.group.as_deref().unwrap_or("");
    if !action
        .scopes
        .iter()
        .any(|s| scope_matches_kind(s, group, kind))
    {
        return false;
    }
    match target.namespace.as_deref().filter(|ns| !ns.is_empty()) {
        Some(ns) if !action.namespaces.is_empty() => {
            action.namespaces.iter().any(|glob| glob_match(glob, ns))
        }
        _ => true,
    }
}

// -- Validation ----------------------------------------------------------------

fn clean_list(items: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim();
        if !item.is_empty() && !out.iter().any(|o| o == item) {
            out.push(item.to_string());
        }
    }
    out
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Normalise one definition or explain what is wrong with it.
pub fn validate_action(mut action: CustomAction) -> Result<CustomAction> {
    action.id = action.id.trim().to_string();
    if action.id.is_empty() {
        action.id = uuid::Uuid::new_v4().to_string();
    } else if !valid_id(&action.id) {
        bail!("invalid id {:?}", action.id);
    }
    action.name = action.name.trim().to_string();
    if action.name.is_empty() {
        bail!("the name is empty");
    }
    if action.name.chars().count() > MAX_NAME {
        bail!("the name is longer than {MAX_NAME} characters");
    }
    action.description = action.description.trim().to_string();
    if action.description.chars().count() > MAX_DESCRIPTION {
        bail!("the description is longer than {MAX_DESCRIPTION} characters");
    }
    if !ICONS.contains(&action.icon.as_str()) {
        action.icon = DEFAULT_ICON.to_string();
    }
    action.command = action.command.trim().to_string();
    if action.command.is_empty() {
        bail!("the command is empty");
    }
    if action.command.len() > MAX_COMMAND {
        bail!("the command is longer than {MAX_COMMAND} bytes");
    }
    if action.command.contains('\0') {
        bail!("the command contains a NUL character");
    }
    if action.mode == CustomActionMode::OpenUrl {
        let starts_with_scheme = matches!(
            segments(&action.command).first(),
            Some(Segment::Literal(text))
                if text.to_ascii_lowercase().starts_with("http://")
                    || text.to_ascii_lowercase().starts_with("https://")
        );
        if !starts_with_scheme {
            bail!("the URL must start with http:// or https://");
        }
    }
    let mut scopes = Vec::new();
    for scope in clean_list(&action.scopes) {
        let scope = normalize_scope(&scope)?;
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    if scopes.is_empty() {
        bail!("choose at least one scope");
    }
    action.scopes = scopes;
    action.namespaces = clean_list(&action.namespaces);
    for glob in &action.namespaces {
        if !glob
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '*' | '?'))
        {
            bail!("invalid namespace pattern {glob:?}");
        }
    }
    action.cluster_tags = clean_list(&action.cluster_tags);
    action.shortcut = match action.shortcut.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => Some(normalize_shortcut(raw)?),
    };
    if action.timeout_secs == 0 {
        action.timeout_secs = DEFAULT_TIMEOUT_SECS;
    }
    action.timeout_secs = action.timeout_secs.min(MAX_TIMEOUT_SECS);
    Ok(action)
}

/// Validate a whole list: every entry, unique ids, a sane size.
pub fn validate_list(actions: Vec<CustomAction>) -> Result<Vec<CustomAction>> {
    if actions.len() > MAX_ACTIONS {
        bail!("at most {MAX_ACTIONS} custom actions are supported");
    }
    let mut out: Vec<CustomAction> = Vec::with_capacity(actions.len());
    for action in actions {
        let label = if action.name.trim().is_empty() {
            action.id.clone()
        } else {
            action.name.trim().to_string()
        };
        let action = validate_action(action).map_err(|e| anyhow::anyhow!("{label}: {e}"))?;
        if out.iter().any(|o| o.id == action.id) {
            bail!("{label}: another action has the id {:?}", action.id);
        }
        out.push(action);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cluster(tags: &[&str]) -> ClusterDef {
        serde_json::from_value(serde_json::json!({
            "id": "c1",
            "name": "Prod",
            "context": "prod",
            "kubeconfig_path": "/tmp/kubeconfig",
            "tags": tags,
        }))
        .unwrap()
    }

    fn action(scopes: &[&str]) -> CustomAction {
        CustomAction {
            name: "x".into(),
            command: "echo {name}".into(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn target(group: &str, kind: &str, ns: Option<&str>) -> CustomActionTarget {
        CustomActionTarget {
            kind: Some(kind.into()),
            group: Some(group.into()),
            namespace: ns.map(String::from),
            name: Some("n".into()),
            ..Default::default()
        }
    }

    #[test]
    fn shortcuts_are_normalized() {
        assert_eq!(normalize_shortcut("Shift+Ctrl+L").unwrap(), "ctrl+shift+l");
        assert_eq!(normalize_shortcut("cmd+option+k").unwrap(), "alt+meta+k");
        assert_eq!(normalize_shortcut("x").unwrap(), "x");
        assert_eq!(normalize_shortcut("?").unwrap(), "?");
        assert_eq!(normalize_shortcut("ctrl++").unwrap(), "ctrl++");
        assert_eq!(normalize_shortcut("ctrl+F5").unwrap(), "ctrl+f5");
        assert_eq!(normalize_shortcut("ArrowUp").unwrap(), "up");
        for bad in [
            "",
            "esc",
            "ctrl+escape",
            "hyper+x",
            "ctrl+ctrl+x",
            "shift+1",
            "shift+?",
            "ctrl+foo",
        ] {
            assert!(normalize_shortcut(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn scopes_are_normalized() {
        assert_eq!(normalize_scope(" Pod ").unwrap(), "Pod");
        assert_eq!(
            normalize_scope("Apps/Deployment").unwrap(),
            "apps/Deployment"
        );
        assert_eq!(normalize_scope("argoproj.io/*").unwrap(), "argoproj.io/*");
        assert_eq!(normalize_scope("CLUSTER").unwrap(), "cluster");
        assert_eq!(normalize_scope("*").unwrap(), "*");
        for bad in ["", "a b", "apps/", "/Pod", "apps/De-ploy", "x_y/Pod"] {
            assert!(normalize_scope(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn scope_matching() {
        let c = cluster(&["prod"]);
        assert!(applies_to(
            &action(&["Pod"]),
            &c,
            &target("", "Pod", Some("a"))
        ));
        assert!(applies_to(&action(&["pod"]), &c, &target("", "Pod", None)));
        assert!(applies_to(
            &action(&["core/Pod"]),
            &c,
            &target("", "Pod", None)
        ));
        assert!(!applies_to(
            &action(&["core/Pod"]),
            &c,
            &target("x.io", "Pod", None)
        ));
        assert!(applies_to(
            &action(&["apps/Deployment"]),
            &c,
            &target("apps", "Deployment", None)
        ));
        assert!(!applies_to(
            &action(&["apps/Deployment"]),
            &c,
            &target("extensions", "Deployment", None)
        ));
        assert!(applies_to(
            &action(&["argoproj.io/*"]),
            &c,
            &target("argoproj.io", "Application", None)
        ));
        assert!(applies_to(&action(&["*"]), &c, &target("", "Node", None)));
        assert!(!applies_to(
            &action(&["*"]),
            &c,
            &CustomActionTarget::default()
        ));
        assert!(applies_to(
            &action(&["cluster"]),
            &c,
            &CustomActionTarget::default()
        ));
        assert!(!applies_to(
            &action(&["cluster"]),
            &c,
            &target("", "Pod", None)
        ));

        let mut ns = action(&["Pod"]);
        ns.namespaces = vec!["team-*".into(), "kube-system".into()];
        assert!(applies_to(&ns, &c, &target("", "Pod", Some("team-a"))));
        assert!(applies_to(&ns, &c, &target("", "Pod", Some("kube-system"))));
        assert!(!applies_to(&ns, &c, &target("", "Pod", Some("default"))));

        let mut tagged = action(&["*"]);
        tagged.cluster_tags = vec!["PROD".into()];
        assert!(applies_to(&tagged, &c, &target("", "Pod", None)));
        assert!(!applies_to(
            &tagged,
            &cluster(&["dev"]),
            &target("", "Pod", None)
        ));
    }

    #[test]
    fn globs() {
        assert!(glob_match("*", ""));
        assert!(glob_match("team-*", "team-a"));
        assert!(glob_match("t?am", "team"));
        assert!(glob_match("*-prod-*", "eu-prod-1"));
        assert!(!glob_match("team-*", "teams"));
        assert!(!glob_match("a", "ab"));
    }

    #[test]
    fn validation_normalizes_and_rejects() {
        let ok = validate_action(CustomAction {
            id: String::new(),
            name: "  Describe ".into(),
            icon: "no-such-icon".into(),
            command: " kubectl describe {resource} {name} ".into(),
            scopes: vec![" Pod ".into(), "Pod".into(), "".into()],
            namespaces: vec![" ".into(), "team-*".into()],
            shortcut: Some("Shift+D".into()),
            timeout_secs: 100_000,
            ..Default::default()
        })
        .unwrap();
        assert!(!ok.id.is_empty());
        assert_eq!(ok.name, "Describe");
        assert_eq!(ok.icon, DEFAULT_ICON);
        assert_eq!(ok.command, "kubectl describe {resource} {name}");
        assert_eq!(ok.scopes, vec!["Pod"]);
        assert_eq!(ok.namespaces, vec!["team-*"]);
        assert_eq!(ok.shortcut.as_deref(), Some("shift+d"));
        assert_eq!(ok.timeout_secs, MAX_TIMEOUT_SECS);

        let base = action(&["Pod"]);
        let bad = [
            CustomAction {
                name: " ".into(),
                ..base.clone()
            },
            CustomAction {
                command: " ".into(),
                ..base.clone()
            },
            CustomAction {
                scopes: vec![],
                ..base.clone()
            },
            CustomAction {
                id: "../x".into(),
                ..base.clone()
            },
            CustomAction {
                shortcut: Some("ctrl+nope".into()),
                ..base.clone()
            },
            CustomAction {
                namespaces: vec!["a b".into()],
                ..base.clone()
            },
            CustomAction {
                mode: CustomActionMode::OpenUrl,
                command: "{name}".into(),
                ..base.clone()
            },
            CustomAction {
                mode: CustomActionMode::OpenUrl,
                command: "javascript:alert(1)".into(),
                ..base.clone()
            },
        ];
        for action in bad {
            assert!(validate_action(action.clone()).is_err(), "{action:?}");
        }
        let dup = vec![
            CustomAction {
                id: "a".into(),
                ..base.clone()
            },
            CustomAction {
                id: "a".into(),
                ..base.clone()
            },
        ];
        assert!(validate_list(dup).is_err());
    }

    #[test]
    fn multi_select_is_derived_from_the_template() {
        let mut a = action(&["Pod"]);
        assert!(!a.is_multi());
        a.command = "kubectl delete pod {selection.names}".into();
        assert!(a.is_multi());
    }
}
