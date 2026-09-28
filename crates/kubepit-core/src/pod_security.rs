//! Pod Security Standards: "what would break if I enforce this level?"
//!
//! The PodSecurity admission plugin evaluates every existing pod of a
//! namespace when its `pod-security.kubernetes.io/enforce` level (or
//! `enforce-version`) changes, and answers with HTTP `Warning` headers that
//! list the violating pods:
//!
//! ```text
//! existing pods in namespace "web" violate the new PodSecurity enforce level "restricted:latest"
//! web-7c9d (and 2 other pods): allowPrivilegeEscalation != false (container "web" must set …), …
//! ```
//!
//! [`Kubepit::pod_security_dry_run`] sends exactly that label change as a
//! merge patch with `dryRun=All`, so nothing is persisted, and parses the
//! warnings into [`PodSecurityViolation`]s. A dry run never mutates the
//! cluster, so it is allowed on clusters marked `read_only` (the user still
//! needs `patch` on the namespace; the API server enforces RBAC).
//!
//! The API server only evaluates pods when the enforce policy actually
//! changes: asking for the level and version a namespace already enforces
//! returns [`PodSecurityDryRun::unchanged`] without a request.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use kube::api::{Patch, PatchParams};
use kube::client::Body;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app::Kubepit;
use crate::error::{kube_error, ApiError};

/// `pod-security.kubernetes.io/enforce`.
pub const ENFORCE_LABEL: &str = "pod-security.kubernetes.io/enforce";
/// `pod-security.kubernetes.io/enforce-version`.
pub const ENFORCE_VERSION_LABEL: &str = "pod-security.kubernetes.io/enforce-version";

const LEVELS: &[&str] = &["privileged", "baseline", "restricted"];

/// Result of a server-side dry run of a namespace's enforce level.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodSecurityDryRun {
    pub namespace: String,
    /// `privileged`, `baseline` or `restricted`.
    pub level: String,
    /// `latest` or `v1.<minor>`.
    pub version: String,
    /// The namespace already enforces this level and version: the API
    /// server evaluates nothing, so no request was sent.
    pub unchanged: bool,
    /// Every warning the API server returned, verbatim.
    pub warnings: Vec<String>,
    /// Violating pods, grouped the way the API server groups them.
    pub violations: Vec<PodSecurityViolation>,
    /// Warnings that are not violations (pods not checked in time, pods
    /// that could not be listed).
    pub notes: Vec<String>,
}

/// Pods that fail the same checks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodSecurityViolation {
    /// First pod (alphabetically) with exactly these failures.
    pub pod: String,
    /// How many other pods fail the same way.
    pub others: u32,
    /// One entry per failed check, verbatim, e.g.
    /// `allowPrivilegeEscalation != false (container "web" must set securityContext.allowPrivilegeEscalation=false)`.
    pub checks: Vec<String>,
}

/// Validate `level` and `version` the way the admission plugin parses them.
pub fn validate_policy(level: &str, version: &str) -> Result<()> {
    if !LEVELS.contains(&level) {
        bail!(
            "unknown Pod Security level \"{level}\" (expected privileged, baseline or restricted)"
        );
    }
    let valid_version = version == "latest"
        || version
            .strip_prefix("v1.")
            .is_some_and(|minor| !minor.is_empty() && minor.chars().all(|c| c.is_ascii_digit()));
    if !valid_version {
        bail!("unknown Pod Security version \"{version}\" (expected latest or v1.<minor>)");
    }
    Ok(())
}

/// Decode one HTTP `Warning` header value (`299 - "text"`, RFC 7234) into
/// its text. Values that do not follow the format are returned trimmed.
pub fn parse_warning_header(value: &str) -> String {
    let value = value.trim();
    let mut parts = value.splitn(3, ' ');
    let (Some(code), Some(_agent), Some(rest)) = (parts.next(), parts.next(), parts.next()) else {
        return value.to_string();
    };
    if code.len() != 3 || !code.chars().all(|c| c.is_ascii_digit()) {
        return value.to_string();
    }
    let rest = rest.trim();
    let Some(quoted) = rest.strip_prefix('"') else {
        return rest.to_string();
    };
    let mut text = String::with_capacity(quoted.len());
    let mut chars = quoted.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    text.push(next);
                }
            }
            // End of the quoted string; an optional warn-date may follow.
            '"' => break,
            other => text.push(other),
        }
    }
    text
}

/// Split `a (x, y), b, c (z)` on the commas that are not inside
/// parentheses or double quotes.
pub fn split_checks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut quoted = false;
    let mut current = String::new();
    for c in text.chars() {
        match c {
            '"' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth = depth.saturating_sub(1),
            ',' if !quoted && depth == 0 => {
                let piece = current.trim();
                if !piece.is_empty() {
                    out.push(piece.to_string());
                }
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    let piece = current.trim();
    if !piece.is_empty() {
        out.push(piece.to_string());
    }
    out
}

fn is_pod_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

/// Parse one PodSecurity warning: `pod: checks`, `pod (and 1 other pod): checks`
/// or `pod (and N other pods): checks`. `None` for every other warning.
pub fn parse_violation(warning: &str) -> Option<PodSecurityViolation> {
    let (head, checks) = warning.split_once(": ")?;
    let (pod, others) = match head.split_once(" (and ") {
        Some((pod, rest)) => {
            let count = rest
                .strip_suffix(" other pods)")
                .or_else(|| rest.strip_suffix(" other pod)"))?;
            (pod, count.parse::<u32>().ok()?)
        }
        None => (head, 0),
    };
    if !is_pod_name(pod) {
        return None;
    }
    let checks = split_checks(checks);
    if checks.is_empty() {
        return None;
    }
    Some(PodSecurityViolation {
        pod: pod.to_string(),
        others,
        checks,
    })
}

/// Sort the warnings of a dry run into violations and notes. The summary
/// line ("existing pods in namespace … violate …") is implied by the
/// violations and dropped from the notes.
pub fn classify_warnings(warnings: &[String]) -> (Vec<PodSecurityViolation>, Vec<String>) {
    let mut violations = Vec::new();
    let mut notes = Vec::new();
    for warning in warnings {
        if warning.starts_with("existing pods in namespace ") {
            continue;
        }
        match parse_violation(warning) {
            Some(v) => violations.push(v),
            None => notes.push(warning.clone()),
        }
    }
    (violations, notes)
}

fn label<'a>(labels: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    labels.get(key).map(String::as_str)
}

/// True when the namespace labels already enforce `level` at `version`
/// (a missing version label means `latest`).
pub fn enforces(labels: &BTreeMap<String, String>, level: &str, version: &str) -> bool {
    label(labels, ENFORCE_LABEL) == Some(level)
        && label(labels, ENFORCE_VERSION_LABEL).unwrap_or("latest") == version
}

/// The merge patch sent (with `dryRun=All`) for the new enforce policy.
pub fn enforce_patch(level: &str, version: &str) -> Value {
    json!({ "metadata": { "labels": {
        ENFORCE_LABEL: level,
        ENFORCE_VERSION_LABEL: version,
    } } })
}

fn namespace_labels(namespace: &Value) -> BTreeMap<String, String> {
    namespace
        .pointer("/metadata/labels")
        .and_then(Value::as_object)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// The error of a non-2xx answer: the `Status` message when there is one.
fn status_error(code: u16, body: &[u8]) -> anyhow::Error {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| v.get("message"))
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("request failed with HTTP {code}"));
    let reason = parsed
        .as_ref()
        .and_then(|v| v.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    ApiError {
        code,
        reason,
        message,
    }
    .into()
}

impl Kubepit {
    /// `pod_security_dry_run`: what enforcing `level` at `version` on
    /// `namespace` would report about its existing pods.
    ///
    /// Always a dry run (`dryRun=All`), so read-only clusters allow it.
    pub async fn pod_security_dry_run(
        &self,
        cluster_id: &str,
        namespace: &str,
        level: &str,
        version: &str,
    ) -> Result<PodSecurityDryRun> {
        validate_policy(level, version)?;
        let namespace = namespace.trim();
        if namespace.is_empty() {
            bail!("a namespace is required");
        }
        let client = self.client(cluster_id).await?;
        let base = kube::core::Request::new("/api/v1/namespaces");

        let get = base
            .get(namespace, &Default::default())
            .map_err(|e| anyhow!("failed to build the namespace request: {e}"))?;
        let live: Value = client
            .request(get)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to read namespace \"{namespace}\""))?;
        let mut out = PodSecurityDryRun {
            namespace: namespace.to_string(),
            level: level.to_string(),
            version: version.to_string(),
            ..PodSecurityDryRun::default()
        };
        if enforces(&namespace_labels(&live), level, version) {
            out.unchanged = true;
            return Ok(out);
        }

        let params = PatchParams {
            dry_run: true,
            ..PatchParams::default()
        };
        let request = base
            .patch(
                namespace,
                &params,
                &Patch::Merge(enforce_patch(level, version)),
            )
            .map_err(|e| anyhow!("failed to build the dry-run request: {e}"))?;
        // The dry-run flag is what makes this safe on read-only clusters.
        debug_assert!(request
            .uri()
            .query()
            .unwrap_or_default()
            .contains("dryRun=All"));
        let response = client
            .send(request.map(Body::from))
            .await
            .map_err(kube_error)
            .context("the dry run failed")?;
        let status = response.status();
        let warnings: Vec<String> = response
            .headers()
            .get_all(http::header::WARNING)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(parse_warning_header)
            .filter(|w| !w.is_empty())
            .collect();
        let body = response
            .into_body()
            .collect_bytes()
            .await
            .map_err(kube_error)?;
        if !status.is_success() {
            return Err(status_error(status.as_u16(), &body)).context("the dry run failed");
        }
        let (violations, notes) = classify_warnings(&warnings);
        out.warnings = warnings;
        out.violations = violations;
        out.notes = notes;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policies_are_validated() {
        assert!(validate_policy("restricted", "latest").is_ok());
        assert!(validate_policy("baseline", "v1.31").is_ok());
        assert!(validate_policy("privileged", "v1.0").is_ok());
        assert!(validate_policy("strict", "latest").is_err());
        assert!(validate_policy("baseline", "1.31").is_err());
        assert!(validate_policy("baseline", "v1.").is_err());
        assert!(validate_policy("baseline", "v2.1").is_err());
        assert!(validate_policy("baseline", "v1.3x").is_err());
    }

    #[test]
    fn warning_headers_are_unquoted() {
        assert_eq!(
            parse_warning_header(r#"299 - "existing pods in namespace \"web\" violate""#),
            r#"existing pods in namespace "web" violate"#
        );
        assert_eq!(
            parse_warning_header(r#"299 - "text" "Sat, 01 Jan 2000 00:00:00 GMT""#),
            "text"
        );
        assert_eq!(parse_warning_header("  plain text  "), "plain text");
        assert_eq!(
            parse_warning_header("299 - unquoted words"),
            "unquoted words"
        );
    }

    #[test]
    fn checks_split_outside_parentheses_and_quotes() {
        let text = r#"host namespaces (hostNetwork=true), privileged (containers "a", "b" must not set securityContext.privileged=true), hostPath volumes (volume "root")"#;
        assert_eq!(
            split_checks(text),
            vec![
                "host namespaces (hostNetwork=true)".to_string(),
                r#"privileged (containers "a", "b" must not set securityContext.privileged=true)"#
                    .to_string(),
                r#"hostPath volumes (volume "root")"#.to_string(),
            ]
        );
        assert_eq!(split_checks("seccompProfile"), vec!["seccompProfile"]);
        assert!(split_checks("  ").is_empty());
    }

    #[test]
    fn violations_are_parsed_with_their_pod_counts() {
        let one = parse_violation(
            r#"debug: privileged (container "box" must not set securityContext.privileged=true)"#,
        )
        .unwrap();
        assert_eq!(one.pod, "debug");
        assert_eq!(one.others, 0);
        assert_eq!(one.checks.len(), 1);

        let two = parse_violation(
            "web-7c9d-abcde (and 1 other pod): allowPrivilegeEscalation != false, seccompProfile",
        )
        .unwrap();
        assert_eq!(two.pod, "web-7c9d-abcde");
        assert_eq!(two.others, 1);
        assert_eq!(
            two.checks,
            vec!["allowPrivilegeEscalation != false", "seccompProfile"]
        );

        let many = parse_violation("api-0 (and 12 other pods): runAsNonRoot != true").unwrap();
        assert_eq!(many.others, 12);

        assert!(parse_violation(
            "new PodSecurity enforce level only checked against the first 3000 of 4000 existing pods"
        )
        .is_none());
        assert!(parse_violation("Some Title: not a pod").is_none());
        assert!(parse_violation("pod (and many other pods): x").is_none());
    }

    #[test]
    fn warnings_are_classified() {
        let warnings = vec![
            r#"existing pods in namespace "web" violate the new PodSecurity enforce level "restricted:latest""#.to_string(),
            "new PodSecurity enforce level only checked against the first 2 of 3 existing pods".to_string(),
            "web-1 (and 1 other pod): seccompProfile".to_string(),
        ];
        let (violations, notes) = classify_warnings(&warnings);
        assert_eq!(violations.len(), 1);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].starts_with("new PodSecurity enforce level only checked"));
    }

    #[test]
    fn enforce_labels_are_compared_with_latest_as_default() {
        let mut labels = BTreeMap::new();
        assert!(!enforces(&labels, "baseline", "latest"));
        labels.insert(ENFORCE_LABEL.to_string(), "baseline".to_string());
        assert!(enforces(&labels, "baseline", "latest"));
        assert!(!enforces(&labels, "baseline", "v1.30"));
        assert!(!enforces(&labels, "restricted", "latest"));
        labels.insert(ENFORCE_VERSION_LABEL.to_string(), "v1.30".to_string());
        assert!(enforces(&labels, "baseline", "v1.30"));
        assert!(!enforces(&labels, "baseline", "latest"));
    }

    #[test]
    fn the_patch_sets_level_and_version() {
        assert_eq!(
            enforce_patch("restricted", "v1.31"),
            json!({"metadata": {"labels": {
                "pod-security.kubernetes.io/enforce": "restricted",
                "pod-security.kubernetes.io/enforce-version": "v1.31"
            }}})
        );
    }
}
