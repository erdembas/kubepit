//! Multi-document parsing with source positions.
//!
//! Files (and the output of `kubectl kustomize` / `helm template`) are split
//! on `---` lines first, so every document keeps the line it starts on, then
//! each piece is parsed on its own: one broken document is reported and the
//! rest of the file still loads. `kind: List` documents are expanded, and
//! documents that are not Kubernetes objects (Chart.yaml, CI files,
//! kustomize configuration) are reported as skipped instead of being sent
//! to a cluster.

use std::collections::HashMap;

use serde_json::Value;

use crate::types::{ManifestDocument, ManifestProblem};

/// Most documents one render may produce.
pub const MAX_DOCUMENTS: usize = 5000;

/// API groups whose objects configure tools, never the cluster.
const TOOL_GROUPS: &[&str] = &["kustomize.config.k8s.io", "config.kubernetes.io"];

/// How a piece of text is interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Yaml,
    Json,
    /// Tool output: YAML whose `# Source: <path>` comments name the template
    /// each document came from (helm); `source` is the fallback.
    Rendered,
}

/// One YAML document of a text: its first line (1-based) and its content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub line: usize,
    pub text: String,
}

fn is_blank_or_comment(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with('#')
}

/// Split multi-document YAML on `---` (and `...`) marker lines. Content after
/// `--- ` on the marker line belongs to the new document. Pieces without any
/// content (only blank lines and comments) are dropped.
pub fn split_documents(text: &str) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut start: Option<usize> = None;
    let mut flush = |current: &mut String, start: &mut Option<usize>| {
        if current.lines().any(|l| !is_blank_or_comment(l)) {
            chunks.push(Chunk {
                line: start.unwrap_or(1),
                text: std::mem::take(current),
            });
        }
        current.clear();
        *start = None;
    };
    for (i, raw) in text.lines().enumerate() {
        let line_no = i + 1;
        let is_start = raw == "---" || raw.starts_with("--- ") || raw.starts_with("---\t");
        if is_start || raw == "..." {
            flush(&mut current, &mut start);
            let rest = if is_start { raw[3..].trim() } else { "" };
            if !rest.is_empty() {
                start = Some(line_no);
                current.push_str(rest);
                current.push('\n');
            }
            continue;
        }
        if start.is_none() {
            if raw.trim().is_empty() {
                continue;
            }
            start = Some(line_no);
        }
        current.push_str(raw);
        current.push('\n');
    }
    flush(&mut current, &mut start);
    chunks
}

/// The template path helm writes above every rendered document.
pub fn helm_source(chunk: &str) -> Option<String> {
    chunk
        .lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("# Source:"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn text_at(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn group_of(api_version: &str) -> &str {
    api_version
        .split_once('/')
        .map(|(group, _)| group)
        .unwrap_or("")
}

/// Documents and problems collected over one render.
#[derive(Debug, Default)]
pub struct Parsed {
    pub documents: Vec<ManifestDocument>,
    pub problems: Vec<ManifestProblem>,
    ids: HashMap<String, usize>,
    per_source: HashMap<String, usize>,
    truncated: bool,
}

impl Parsed {
    pub fn problem(&mut self, source: &str, line: usize, message: impl Into<String>) {
        self.problems.push(ManifestProblem {
            source: source.to_string(),
            line,
            message: message.into(),
        });
    }

    /// Parse `text` read from (or rendered for) `source`.
    pub fn add_text(&mut self, text: &str, source: &str, format: Format) {
        if format == Format::Json {
            match serde_json::from_str::<Value>(text) {
                Ok(value) => self.add_value(value, source, 1),
                Err(e) => self.problem(source, e.line(), format!("invalid JSON: {e}")),
            }
            return;
        }
        for chunk in split_documents(text) {
            let source = match format {
                Format::Rendered => helm_source(&chunk.text).unwrap_or_else(|| source.to_string()),
                _ => source.to_string(),
            };
            match serde_yaml::from_str::<Value>(&chunk.text) {
                Ok(value) => self.add_value(value, &source, chunk.line),
                Err(e) => {
                    // End-of-input errors point past the last line; keep them
                    // inside the document.
                    let last = chunk.line + chunk.text.lines().count().saturating_sub(1);
                    let line = e
                        .location()
                        .map(|l| chunk.line + l.line().saturating_sub(1))
                        .unwrap_or(chunk.line)
                        .min(last);
                    let message = e.to_string();
                    // serde_yaml appends " at line N column M" relative to the
                    // piece; the absolute line is reported separately.
                    let message = message
                        .split(" at line ")
                        .next()
                        .unwrap_or(&message)
                        .to_string();
                    self.problem(&source, line, format!("invalid YAML: {message}"));
                }
            }
        }
    }

    fn add_value(&mut self, value: Value, source: &str, line: usize) {
        if self.truncated {
            return;
        }
        let map = match value {
            Value::Null => return,
            Value::Object(ref map) if map.is_empty() => return,
            Value::Object(ref map) => map,
            _ => {
                self.problem(source, line, "skipped: not a Kubernetes object");
                return;
            }
        };
        if map.get("kind").and_then(Value::as_str) == Some("List") {
            if let Some(items) = map.get("items").and_then(Value::as_array) {
                for item in items.clone() {
                    self.add_value(item, source, line);
                }
                return;
            }
        }
        let api_version = text_at(&value, "/apiVersion");
        let kind = text_at(&value, "/kind");
        if api_version.is_empty() || kind.is_empty() {
            self.problem(
                source,
                line,
                "skipped: not a Kubernetes object (no apiVersion or kind)",
            );
            return;
        }
        let group = group_of(&api_version).to_string();
        if TOOL_GROUPS.contains(&group.as_str()) {
            self.problem(
                source,
                line,
                format!("skipped: {kind} configures kustomize and is not applied to clusters"),
            );
            return;
        }
        if self.documents.len() >= MAX_DOCUMENTS {
            self.truncated = true;
            self.problem(
                source,
                line,
                format!("stopped after {MAX_DOCUMENTS} documents; the rest was not loaded"),
            );
            return;
        }
        let name = match text_at(&value, "/metadata/name") {
            name if name.is_empty() => text_at(&value, "/metadata/generateName"),
            name => name,
        };
        let namespace =
            Some(text_at(&value, "/metadata/namespace")).filter(|namespace| !namespace.is_empty());
        let identity = format!(
            "{group}/{kind}/{}/{name}",
            namespace.as_deref().unwrap_or("")
        );
        let seen = self.ids.entry(identity.clone()).or_insert(0);
        *seen += 1;
        let id = if *seen == 1 {
            identity
        } else {
            format!("{identity} #{seen}")
        };
        let index = self.per_source.entry(source.to_string()).or_insert(0);
        let position = *index;
        *index += 1;
        let yaml = serde_yaml::to_string(&value).unwrap_or_default();
        self.documents.push(ManifestDocument {
            id,
            source: source.to_string(),
            index: position,
            line,
            api_version,
            kind,
            name,
            namespace,
            yaml,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_keep_their_first_line() {
        let text = "# leading comment\n\napiVersion: v1\nkind: A\n---\n\n# only a comment\n---\n\
                    apiVersion: v1\nkind: B\n...\n--- {apiVersion: v1, kind: C}\n";
        let chunks = split_documents(text);
        let lines: Vec<usize> = chunks.iter().map(|c| c.line).collect();
        assert_eq!(lines, vec![1, 9, 12]);
        assert!(chunks[0].text.starts_with("# leading comment\n"));
        assert_eq!(chunks[2].text, "{apiVersion: v1, kind: C}\n");
        assert!(split_documents("").is_empty());
        assert!(split_documents("---\n---\n# nothing\n").is_empty());
        // A literal block may contain "---" only indented, so it never splits.
        let block = "apiVersion: v1\nkind: ConfigMap\ndata:\n  x: |\n    ---\n    y\n";
        assert_eq!(split_documents(block).len(), 1);
    }

    #[test]
    fn multi_document_files_carry_sources_lines_and_unique_ids() {
        let mut parsed = Parsed::default();
        parsed.add_text(
            "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a, namespace: x}\n---\n\
             apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web}\n---\n\
             apiVersion: v1\nkind: List\nitems:\n- {apiVersion: v1, kind: Service, metadata: {name: s}}\n\
             - {apiVersion: v1, kind: Service, metadata: {name: s}}\n",
            "app/all.yaml",
            Format::Yaml,
        );
        parsed.add_text(
            r#"{"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "k"}}"#,
            "app/secret.json",
            Format::Json,
        );
        let summary: Vec<(String, String, usize, usize)> = parsed
            .documents
            .iter()
            .map(|d| (d.id.clone(), d.source.clone(), d.index, d.line))
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "/ConfigMap/x/a".to_string(),
                    "app/all.yaml".to_string(),
                    0,
                    1
                ),
                (
                    "apps/Deployment//web".to_string(),
                    "app/all.yaml".to_string(),
                    1,
                    5
                ),
                ("/Service//s".to_string(), "app/all.yaml".to_string(), 2, 9),
                (
                    "/Service//s #2".to_string(),
                    "app/all.yaml".to_string(),
                    3,
                    9
                ),
                (
                    "/Secret//k".to_string(),
                    "app/secret.json".to_string(),
                    0,
                    1
                ),
            ]
        );
        let first = &parsed.documents[0];
        assert_eq!(first.namespace.as_deref(), Some("x"));
        assert_eq!(first.api_version, "v1");
        let value: Value = serde_yaml::from_str(&first.yaml).unwrap();
        assert_eq!(value["metadata"]["name"], "a");
        assert!(parsed.problems.is_empty(), "{:?}", parsed.problems);
    }

    #[test]
    fn broken_and_foreign_documents_become_problems() {
        let mut parsed = Parsed::default();
        parsed.add_text(
            "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: ok}\n---\n\
             apiVersion: v1\nkind: [unclosed\n---\n\
             name: my-chart\nversion: 1.0.0\n---\n\
             apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n---\n\
             - just\n- a list\n",
            "mixed.yaml",
            Format::Yaml,
        );
        parsed.add_text("{broken", "bad.json", Format::Json);
        assert_eq!(parsed.documents.len(), 1);
        let problems: Vec<(String, usize)> = parsed
            .problems
            .iter()
            .map(|p| (p.source.clone(), p.line))
            .collect();
        assert_eq!(
            problems,
            vec![
                ("mixed.yaml".to_string(), 6),
                ("mixed.yaml".to_string(), 8),
                ("mixed.yaml".to_string(), 11),
                ("mixed.yaml".to_string(), 14),
                ("bad.json".to_string(), 1),
            ]
        );
        assert!(parsed.problems[0].message.starts_with("invalid YAML"));
        assert!(!parsed.problems[0].message.contains(" at line "));
        assert!(parsed.problems[1].message.contains("no apiVersion or kind"));
        assert!(parsed.problems[2].message.contains("Kustomization"));
        assert!(parsed.problems[4].message.starts_with("invalid JSON"));
    }

    #[test]
    fn rendered_output_takes_helm_template_sources() {
        let out = "---\n# Source: shop/templates/service.yaml\napiVersion: v1\nkind: Service\n\
                   metadata:\n  name: shop\n---\n# Source: shop/templates/deployment.yaml\n\
                   apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: shop\n---\n\
                   apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: plain\n";
        let mut parsed = Parsed::default();
        parsed.add_text(out, "shop", Format::Rendered);
        let sources: Vec<&str> = parsed.documents.iter().map(|d| d.source.as_str()).collect();
        assert_eq!(
            sources,
            vec![
                "shop/templates/service.yaml",
                "shop/templates/deployment.yaml",
                "shop"
            ]
        );
        assert_eq!(parsed.documents[1].line, 8);
        assert_eq!(
            helm_source("# Source: a/b.yaml\nkind: X\n").as_deref(),
            Some("a/b.yaml")
        );
        assert_eq!(helm_source("kind: X\n"), None);
    }
}
