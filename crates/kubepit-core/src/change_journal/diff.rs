//! Changed-path summaries of two normalized objects.
//!
//! [`changed_paths`] walks both documents in parallel and reports one
//! [`ChangedPath`] per changed leaf, e.g.
//!
//! - `spec.replicas: 3 → 5`
//! - `spec.template.spec.containers[api].image: api:1.4.2 → api:1.5.0`
//! - `metadata.labels["app.kubernetes.io/version"]: 1.4 → 1.5`
//! - `data.LOG_LEVEL: info → debug`
//!
//! Lists whose items all carry a unique `name` (containers, env, ports,
//! volumes) — or `mountPath` (volume mounts) — are matched by that key
//! instead of by position, so inserting a container does not report every
//! later container as changed. Other lists are compared item by item. A
//! subtree that exists on one side only is reported once, rendered as
//! compact JSON.
//!
//! [`dropped_paths`] walks the same way to find what a Helm upgrade removes
//! from a live object: nodes the old render has, the new render lacks and
//! the live object still carries.

use serde_json::Value;

use super::types::ChangedPath;

/// Paths kept per entry (the total is still counted).
pub const MAX_PATHS: usize = 50;
/// Rendered values are cut to this many characters.
pub const MAX_VALUE_CHARS: usize = 120;

/// Keys that identify list items, in order of preference.
const ITEM_KEYS: &[&str] = &["name", "mountPath"];

#[derive(Debug, Clone)]
enum Segment {
    Key(String),
    /// A keyed list item: the key field (`name`, `mountPath`) and its value.
    Item(&'static str, String),
    Index(usize),
}

fn plain_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn format_path(segments: &[Segment]) -> String {
    let mut out = String::new();
    for (i, segment) in segments.iter().enumerate() {
        match segment {
            Segment::Key(key) if plain_key(key) => {
                if i > 0 {
                    out.push('.');
                }
                out.push_str(key);
            }
            Segment::Key(key) => {
                out.push('[');
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(']');
            }
            Segment::Item(_, name) => {
                out.push('[');
                out.push_str(name);
                out.push(']');
            }
            Segment::Index(index) => {
                out.push('[');
                out.push_str(&index.to_string());
                out.push(']');
            }
        }
    }
    out
}

/// Short rendering of a value for summaries.
/// Multi-line strings show their first line.
pub fn render(value: &Value) -> String {
    match value {
        Value::String(s) if s.contains('\n') => {
            let first = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            cut(&format!("{} …", first.trim_end()))
        }
        Value::String(s) => cut(s),
        other => cut(&other.to_string()),
    }
}

fn cut(text: &str) -> String {
    if text.chars().count() <= MAX_VALUE_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_VALUE_CHARS - 1).collect();
    out.push('…');
    out
}

/// Two multi-line strings (config files in ConfigMaps): only the lines
/// between the common head and tail, joined with ` ⏎ `.
fn changed_lines(a: &str, b: &str) -> Option<(String, String)> {
    if !a.contains('\n') && !b.contains('\n') {
        return None;
    }
    let la: Vec<&str> = a.lines().collect();
    let lb: Vec<&str> = b.lines().collect();
    let head = la.iter().zip(&lb).take_while(|(x, y)| x == y).count();
    let room = la.len().min(lb.len()) - head;
    let tail = la
        .iter()
        .rev()
        .zip(lb.iter().rev())
        .take(room)
        .take_while(|(x, y)| x == y)
        .count();
    let middle = |lines: &[&str]| {
        cut(&lines
            .iter()
            .map(|l| l.trim())
            .collect::<Vec<_>>()
            .join(" ⏎ "))
    };
    let (ma, mb) = (
        middle(&la[head..la.len() - tail]),
        middle(&lb[head..lb.len() - tail]),
    );
    (!(ma.is_empty() && mb.is_empty())).then_some((ma, mb))
}

fn scalar_key(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The item key both lists can be matched by, if any.
fn item_key(a: &[Value], b: &[Value]) -> Option<&'static str> {
    if a.is_empty() && b.is_empty() {
        return None;
    }
    ITEM_KEYS.iter().copied().find(|field| {
        [a, b].iter().all(|items| {
            let mut seen = std::collections::HashSet::new();
            items.iter().all(|item| {
                item.get(*field)
                    .and_then(scalar_key)
                    .is_some_and(|k| seen.insert(k))
            })
        })
    })
}

struct Walker {
    segments: Vec<Segment>,
    out: Vec<ChangedPath>,
    /// Paths below these top-level keys are Secret values.
    redacted_roots: &'static [&'static str],
    /// When set, only nodes `before` has and `after` lacks are recorded
    /// here (as segments), and `out` stays empty.
    removals: Option<Vec<Vec<Segment>>>,
}

impl Walker {
    fn new(redacted_roots: &'static [&'static str]) -> Self {
        Self {
            segments: Vec::new(),
            out: Vec::new(),
            redacted_roots,
            removals: None,
        }
    }

    fn leaf(&mut self, before: Option<&Value>, after: Option<&Value>) {
        if let Some(removals) = &mut self.removals {
            if before.is_some() && after.is_none() {
                removals.push(self.segments.clone());
            }
            return;
        }
        let redacted = matches!(self.segments.first(), Some(Segment::Key(root))
            if self.redacted_roots.contains(&root.as_str()));
        let (before, after) = match (before, after) {
            (Some(Value::String(a)), Some(Value::String(b))) => match changed_lines(a, b) {
                Some((a, b)) => (Some(a), Some(b)),
                None => (
                    Some(render(&Value::String(a.clone()))),
                    Some(render(&Value::String(b.clone()))),
                ),
            },
            (a, b) => (a.map(render), b.map(render)),
        };
        self.out.push(ChangedPath {
            path: format_path(&self.segments),
            before,
            after,
            redacted,
        });
    }

    fn descend(&mut self, segment: Segment, before: Option<&Value>, after: Option<&Value>) {
        self.segments.push(segment);
        self.walk(before, after);
        self.segments.pop();
    }

    fn walk(&mut self, before: Option<&Value>, after: Option<&Value>) {
        match (before, after) {
            (Some(a), Some(b)) if a == b => {}
            (Some(Value::Object(a)), Some(Value::Object(b))) => {
                let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
                keys.sort();
                keys.dedup();
                for key in keys {
                    self.descend(Segment::Key(key.clone()), a.get(key), b.get(key));
                }
            }
            (Some(Value::Array(a)), Some(Value::Array(b))) => match item_key(a, b) {
                Some(field) => {
                    let key_of = |v: &Value| v.get(field).and_then(scalar_key);
                    for vb in b {
                        let key = key_of(vb).unwrap_or_default();
                        let va = a.iter().find(|va| key_of(va).as_deref() == Some(&key));
                        self.descend(Segment::Item(field, key), va, Some(vb));
                    }
                    for va in a {
                        let key = key_of(va).unwrap_or_default();
                        if !b.iter().any(|vb| key_of(vb).as_deref() == Some(&key)) {
                            self.descend(Segment::Item(field, key), Some(va), None);
                        }
                    }
                }
                None => {
                    for i in 0..a.len().max(b.len()) {
                        self.descend(Segment::Index(i), a.get(i), b.get(i));
                    }
                }
            },
            (None, None) => {}
            (before, after) => self.leaf(before, after),
        }
    }
}

/// Every changed leaf between `before` and `after`: map keys in
/// alphabetical order, keyed list items in the order of `after`.
/// With `secret`, paths under `data` / `stringData` are marked redacted.
pub fn changed_paths(before: &Value, after: &Value, secret: bool) -> Vec<ChangedPath> {
    let mut walker = Walker::new(if secret { &["data", "stringData"] } else { &[] });
    walker.walk(Some(before), Some(after));
    walker.out
}

/// The node at `segments` in `value`: keyed items are found by their key
/// field, wherever they sit in the list.
fn lookup<'a>(value: &'a Value, segments: &[Segment]) -> Option<&'a Value> {
    segments
        .iter()
        .try_fold(value, |node, segment| match segment {
            Segment::Key(key) => node.as_object()?.get(key),
            Segment::Item(field, key) => node.as_array()?.iter().find(|item| {
                item.get(*field).and_then(scalar_key).as_deref() == Some(key.as_str())
            }),
            Segment::Index(index) => node.as_array()?.get(*index),
        })
}

/// What a Helm upgrade removes from a live object: the paths (leaves or
/// whole subtrees) present in `before` (the old render), absent from
/// `after` (the new render) and still present in `live`. Helm's three-way
/// merge deletes exactly those; a server-side apply dry run never does.
/// Paths use [`changed_paths`]'s syntax and order.
pub fn dropped_paths(before: &Value, after: &Value, live: &Value) -> Vec<String> {
    let mut walker = Walker::new(&[]);
    walker.removals = Some(Vec::new());
    walker.walk(Some(before), Some(after));
    walker
        .removals
        .unwrap_or_default()
        .into_iter()
        .filter(|segments| lookup(live, segments).is_some_and(|node| !node.is_null()))
        .map(|segments| format_path(&segments))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary(paths: &[ChangedPath]) -> Vec<String> {
        paths
            .iter()
            .map(|p| {
                format!(
                    "{}: {} → {}",
                    p.path,
                    p.before.as_deref().unwrap_or("∅"),
                    p.after.as_deref().unwrap_or("∅")
                )
            })
            .collect()
    }

    fn deployment(image: &str, replicas: u32) -> Value {
        json!({
            "metadata": {"name": "api", "labels": {"app.kubernetes.io/version": "1.4"}},
            "spec": {"replicas": replicas, "template": {"spec": {"containers": [
                {"name": "api", "image": image, "env": [
                    {"name": "LOG_LEVEL", "value": "info"},
                    {"name": "REGION", "value": "eu"}
                ]},
                {"name": "envoy", "image": "envoy:1.32"}
            ]}}}
        })
    }

    #[test]
    fn scalar_and_keyed_list_changes() {
        let a = deployment("api:v1.4.2", 3);
        let mut b = deployment("api:v1.5.0", 5);
        b["metadata"]["labels"]["app.kubernetes.io/version"] = json!("1.5");
        b["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = json!("debug");
        assert_eq!(
            summary(&changed_paths(&a, &b, false)),
            vec![
                r#"metadata.labels["app.kubernetes.io/version"]: 1.4 → 1.5"#,
                "spec.replicas: 3 → 5",
                "spec.template.spec.containers[api].env[LOG_LEVEL].value: info → debug",
                "spec.template.spec.containers[api].image: api:v1.4.2 → api:v1.5.0",
            ]
        );
    }

    #[test]
    fn keyed_items_survive_reordering_insertion_and_removal() {
        let a = deployment("api:1", 1);
        let mut b = a.clone();
        let containers = b["spec"]["template"]["spec"]["containers"]
            .as_array_mut()
            .unwrap();
        containers.insert(0, json!({"name": "sidecar", "image": "proxy:2"}));
        containers.retain(|c| c["name"] != "envoy");
        assert_eq!(
            summary(&changed_paths(&a, &b, false)),
            vec![
                r#"spec.template.spec.containers[sidecar]: ∅ → {"image":"proxy:2","name":"sidecar"}"#,
                r#"spec.template.spec.containers[envoy]: {"image":"envoy:1.32","name":"envoy"} → ∅"#,
            ]
        );
    }

    #[test]
    fn volume_mounts_are_keyed_by_mount_path() {
        let a = json!({"volumeMounts": [
            {"name": "config", "mountPath": "/etc/a"},
            {"name": "config", "mountPath": "/etc/b", "readOnly": true}
        ]});
        let mut b = a.clone();
        b["volumeMounts"][1]["readOnly"] = json!(false);
        assert_eq!(
            summary(&changed_paths(&a, &b, false)),
            vec!["volumeMounts[/etc/b].readOnly: true → false"]
        );
    }

    #[test]
    fn unkeyed_lists_compare_by_position() {
        let a = json!({"rules": [{"verbs": ["get", "list"], "resources": ["pods"]}]});
        let b = json!({"rules": [
            {"verbs": ["get", "list", "watch"], "resources": ["pods"]},
            {"verbs": ["get"], "resources": ["secrets"]}
        ]});
        assert_eq!(
            summary(&changed_paths(&a, &b, false)),
            vec![
                "rules[0].verbs[2]: ∅ → watch",
                r#"rules[1]: ∅ → {"resources":["secrets"],"verbs":["get"]}"#,
            ]
        );
    }

    #[test]
    fn added_and_removed_fields_and_maps() {
        let a = json!({"spec": {"suspend": false}, "data": {"A": "1", "B": "2"}});
        let b = json!({"spec": {"suspend": true, "paused": true}, "data": {"A": "1", "C": "3"}});
        assert_eq!(
            summary(&changed_paths(&a, &b, false)),
            vec![
                "data.B: 2 → ∅",
                "data.C: ∅ → 3",
                "spec.paused: ∅ → true",
                "spec.suspend: false → true",
            ]
        );
    }

    #[test]
    fn secret_paths_are_marked_redacted() {
        let a = json!({"metadata": {"labels": {"a": "1"}}, "data": {"KEY": "<redacted #1>"}});
        let b = json!({"metadata": {"labels": {"a": "2"}}, "data": {"KEY": "<redacted #2>", "NEW": "<redacted #3>"}});
        let paths = changed_paths(&a, &b, true);
        assert_eq!(paths.len(), 3);
        assert!(paths[0].redacted && paths[1].redacted);
        assert_eq!(paths[0].path, "data.KEY");
        assert_eq!(paths[1].path, "data.NEW");
        assert_eq!(paths[1].before, None);
        assert!(!paths[2].redacted, "labels are not secret");
        // The same shape outside a Secret is not redacted.
        assert!(changed_paths(&a, &b, false).iter().all(|p| !p.redacted));
    }

    #[test]
    fn multi_line_values_show_only_the_changed_lines() {
        let corefile = |ttl: u32| json!({"data": {"Corefile": format!(".:53 {{\n    errors\n    cache {ttl}\n    loop\n}}\n")}});
        assert_eq!(
            summary(&changed_paths(&corefile(10), &corefile(30), false)),
            vec!["data.Corefile: cache 10 → cache 30"]
        );
        let added = changed_paths(
            &json!({"data": {}}),
            &json!({"data": {"app.yaml": "server:\n  port: 8080\n"}}),
            false,
        );
        assert_eq!(added[0].path, r#"data["app.yaml"]"#);
        assert_eq!(added[0].after.as_deref(), Some("server: …"));
        // A line appended at the end: nothing on the left, the new line on the right.
        let appended = changed_paths(&json!({"v": "a\nb\n"}), &json!({"v": "a\nb\nc\n"}), false);
        assert_eq!(appended[0].before.as_deref(), Some(""));
        assert_eq!(appended[0].after.as_deref(), Some("c"));
    }

    #[test]
    fn dropped_paths_are_old_render_minus_new_render_still_live() {
        let before = json!({"metadata": {"annotations": {"a": "1", "keep": "x"}},
            "spec": {"template": {"spec": {"containers": [{"name": "api", "env": [{"name": "DEBUG", "value": "1"}, {"name": "LOG", "value": "i"}]}]}}}});
        let after = json!({"metadata": {"annotations": {"keep": "x"}},
            "spec": {"template": {"spec": {"containers": [{"name": "api", "env": [{"name": "LOG", "value": "i"}]}]}}}});
        let live = json!({"metadata": {"annotations": {"a": "1", "keep": "x", "server": "y"}},
            "spec": {"replicas": 2, "template": {"spec": {"containers": [{"name": "api", "env": [{"name": "DEBUG", "value": "1"}, {"name": "LOG", "value": "i"}]}]}}}});
        assert_eq!(
            dropped_paths(&before, &after, &live),
            // `changed_paths` syntax: plain keys join with dots, others are quoted.
            vec![
                "metadata.annotations.a".to_string(),
                "spec.template.spec.containers[api].env[DEBUG]".to_string(),
            ]
        );
    }

    #[test]
    fn dropped_paths_skip_fields_already_gone_live() {
        let before = json!({"spec": {"paused": true}});
        assert!(dropped_paths(&before, &json!({"spec": {}}), &json!({"spec": {}})).is_empty());
    }

    #[test]
    fn dropped_paths_find_live_items_by_key_and_whole_subtrees() {
        let mounts = |paths: &[&str]| {
            json!(paths
                .iter()
                .map(|p| json!({"name": "config", "mountPath": p}))
                .collect::<Vec<_>>())
        };
        let before =
            json!({"volumeMounts": mounts(&["/etc/a", "/etc/b"]), "nodeSelector": {"disk": "ssd"}});
        let after = json!({"volumeMounts": mounts(&["/etc/a"])});
        // Live lists the items in another order, next to a server-added one.
        let live = json!({"volumeMounts": mounts(&["/var/run", "/etc/b", "/etc/a"]), "nodeSelector": {"disk": "ssd"}});
        assert_eq!(
            dropped_paths(&before, &after, &live),
            vec!["nodeSelector", "volumeMounts[/etc/b]"]
        );
        // Changed values are not drops, and neither is a null left live.
        let changed = dropped_paths(
            &json!({"spec": {"replicas": 2, "paused": true}}),
            &json!({"spec": {"replicas": 3}}),
            &json!({"spec": {"replicas": 2, "paused": null}}),
        );
        assert!(changed.is_empty(), "{changed:?}");
    }

    #[test]
    fn identical_documents_have_no_paths_and_values_are_cut() {
        let a = deployment("api:1", 2);
        assert!(changed_paths(&a, &a, false).is_empty());
        let long = "y".repeat(500);
        let paths = changed_paths(&json!({"v": "x"}), &json!({"v": long}), false);
        let after = paths[0].after.as_deref().unwrap();
        assert_eq!(after.chars().count(), MAX_VALUE_CHARS);
        assert!(after.ends_with('…'));
    }
}
