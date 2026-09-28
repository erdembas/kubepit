//! The cluster-label selector of a shared Prometheus
//! ([`PrometheusAccess::cluster_labels`](super::access::PrometheusAccess)),
//! injected into every query Kubepit builds.
//!
//! [`with_matchers`] is a small PromQL lexer that adds `,k="v"` to every
//! vector selector — a bare metric name, a `{…}` block (also
//! `{__name__=~…}`) — and leaves the rest alone: string literals, function
//! and aggregation names (an identifier followed by `(`, or by `by` /
//! `without`), keywords, label lists after `by (` / `without (` / `on (` /
//! `ignoring (` / `group_left (` / `group_right (`, `[…]` ranges and
//! subqueries, numbers and durations, comments.
//!
//! It is applied to presets only ([`super::Origin::Preset`]): never to the
//! detection probe (`query=1`) nor to PromQL the user typed in the PromQL
//! tab, which shows the selector as a hint instead.

use std::collections::BTreeMap;

use crate::types::PromQuerySeries;

/// Error of an answer whose series lack a configured cluster label: the
/// source ignored or rewrote the selector, so its data cannot be trusted to
/// belong to this cluster (fail closed).
pub const CLUSTER_LABEL_MISMATCH: &str = "cluster-label-mismatch";

/// Binary operators, modifiers and keywords (case-insensitive in PromQL).
const KEYWORDS: [&str; 12] = [
    "by",
    "without",
    "on",
    "ignoring",
    "group_left",
    "group_right",
    "bool",
    "offset",
    "and",
    "or",
    "unless",
    "atan2",
];
/// Keywords whose `( … )` holds label names, not expressions.
const LABEL_LISTS: [&str; 6] = [
    "by",
    "without",
    "on",
    "ignoring",
    "group_left",
    "group_right",
];
/// Number literals spelled as words.
const NUMBER_WORDS: [&str; 2] = ["inf", "nan"];

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == ':'
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == ':'
}

/// Index after the string literal opening at `start` (`"…"`, `'…'` with
/// backslash escapes, or a raw `` `…` ``); the end of input if unterminated.
fn string_end(chars: &[char], start: usize) -> usize {
    let open = chars[start];
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            '\\' if open != '`' => i += 2,
            c if c == open => return i + 1,
            _ => i += 1,
        }
    }
    chars.len()
}

/// Index after the `close` matching the opener at `start`, skipping string
/// literals; `None` when it is never closed.
fn group_end(chars: &[char], start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = start;
    while i < chars.len() {
        match chars[i] {
            '"' | '\'' | '`' => {
                i = string_end(chars, i);
                continue;
            }
            c if c == open => depth += 1,
            c if c == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn skip_space(chars: &[char], mut i: usize) -> usize {
    while chars.get(i).is_some_and(|c| c.is_whitespace()) {
        i += 1;
    }
    i
}

/// The identifier starting at `i` (lower-cased), if any.
fn word_at(chars: &[char], i: usize) -> Option<String> {
    if !chars.get(i).copied().is_some_and(is_ident_start) {
        return None;
    }
    let end = (i..chars.len())
        .find(|&j| !is_ident_char(chars[j]))
        .unwrap_or(chars.len());
    Some(
        chars[i..end]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase(),
    )
}

/// Index after the number or duration starting at `start` (`0.95`, `1e-3`,
/// `0x1f`, `5m`, `1h30m`).
fn number_end(chars: &[char], start: usize) -> usize {
    let hex = chars.get(start) == Some(&'0') && matches!(chars.get(start + 1), Some('x' | 'X'));
    let mut i = start;
    while let Some(&c) = chars.get(i) {
        let exponent_sign =
            matches!(c, '+' | '-') && !hex && i > start && matches!(chars[i - 1], 'e' | 'E');
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || exponent_sign {
            i += 1;
        } else {
            break;
        }
    }
    i
}

/// `query` with `matchers` (`k="v",…`, see
/// [`PrometheusAccess::matchers`](super::access::PrometheusAccess::matchers))
/// added to every vector selector. Empty `matchers` return `query` as is.
pub fn with_matchers(query: &str, matchers: &str) -> String {
    let matchers = matchers.trim();
    if matchers.is_empty() {
        return query.to_string();
    }
    let chars: Vec<char> = query.chars().collect();
    let mut out = String::with_capacity(query.len() + 8 * matchers.len());
    let push = |out: &mut String, part: &[char]| out.extend(part.iter());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' | '\'' | '`' => {
                let end = string_end(&chars, i);
                push(&mut out, &chars[i..end]);
                i = end;
            }
            '#' => {
                // A comment runs to the end of the line.
                let end = (i..chars.len())
                    .find(|&j| chars[j] == '\n')
                    .unwrap_or(chars.len());
                push(&mut out, &chars[i..end]);
                i = end;
            }
            // Ranges and subqueries: `[5m]`, `[7d:5m]`.
            '[' => {
                let end = group_end(&chars, i, '[', ']').unwrap_or(chars.len());
                push(&mut out, &chars[i..end]);
                i = end;
            }
            // A selector block, after a metric name or on its own.
            '{' => {
                let Some(end) = group_end(&chars, i, '{', '}') else {
                    push(&mut out, &chars[i..]);
                    break;
                };
                let inner: String = chars[i + 1..end - 1].iter().collect();
                out.push('{');
                out.push_str(&inner);
                let trimmed = inner.trim_end();
                if !trimmed.is_empty() && !trimmed.ends_with(',') {
                    out.push(',');
                }
                out.push_str(matchers);
                out.push('}');
                i = end;
            }
            c if c.is_ascii_digit()
                || (c == '.' && chars.get(i + 1).is_some_and(char::is_ascii_digit)) =>
            {
                let end = number_end(&chars, i);
                push(&mut out, &chars[i..end]);
                i = end;
            }
            c if is_ident_start(c) => {
                let end = (i..chars.len())
                    .find(|&j| !is_ident_char(chars[j]))
                    .unwrap_or(chars.len());
                push(&mut out, &chars[i..end]);
                let word = chars[i..end]
                    .iter()
                    .collect::<String>()
                    .to_ascii_lowercase();
                i = end;
                let next = skip_space(&chars, i);
                if LABEL_LISTS.contains(&word.as_str()) && chars.get(next) == Some(&'(') {
                    // `by (namespace, pod)`: label names, copied as they are.
                    let close = group_end(&chars, next, '(', ')').unwrap_or(chars.len());
                    push(&mut out, &chars[i..close]);
                    i = close;
                    continue;
                }
                let aggregation =
                    matches!(word_at(&chars, next).as_deref(), Some("by" | "without"));
                let not_a_selector = KEYWORDS.contains(&word.as_str())
                    || NUMBER_WORDS.contains(&word.as_str())
                    || chars.get(next) == Some(&'(')
                    || aggregation;
                // A metric name: its own `{…}` follows, or it gets one.
                if !not_a_selector && chars.get(next) != Some(&'{') {
                    out.push('{');
                    out.push_str(matchers);
                    out.push('}');
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// `, k1, k2` for a `by (…)` list, so an aggregated answer keeps the
/// cluster labels [`series_carry_labels`] checks (`""` without labels).
pub fn by_labels(labels: &BTreeMap<String, String>) -> String {
    labels.keys().map(|name| format!(", {name}")).collect()
}

/// Does every series carry each configured label with its value?
pub fn series_carry_labels(series: &[PromQuerySeries], labels: &BTreeMap<String, String>) -> bool {
    series.iter().all(|s| {
        labels
            .iter()
            .all(|(name, value)| s.labels.get(name) == Some(value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prometheus::promql::{default_metrics, preset};
    use crate::prometheus::usage;
    use crate::types::{PrometheusMetric, PrometheusTarget};

    fn all_targets() -> Vec<PrometheusTarget> {
        vec![
            PrometheusTarget::Cluster,
            PrometheusTarget::Node {
                name: "ip-10-0-1-2.ec2.internal".into(),
            },
            PrometheusTarget::Namespace {
                namespace: "shop".into(),
            },
            PrometheusTarget::Workload {
                namespace: "shop".into(),
                workload_kind: "Deployment".into(),
                name: "web".into(),
            },
            PrometheusTarget::Workload {
                namespace: "db".into(),
                workload_kind: "StatefulSet".into(),
                name: "pg".into(),
            },
            PrometheusTarget::Pod {
                namespace: "shop".into(),
                name: "web-7d9f8-abcde".into(),
            },
            PrometheusTarget::Container {
                namespace: "shop".into(),
                pod: "web-1".into(),
                container: "app".into(),
            },
            PrometheusTarget::Pvc {
                namespace: "db".into(),
                name: "data-pg-0".into(),
            },
        ]
    }

    fn all_metrics() -> Vec<PrometheusMetric> {
        default_metrics(&PrometheusTarget::Cluster)
            .into_iter()
            .chain(default_metrics(&PrometheusTarget::Pvc {
                namespace: "a".into(),
                name: "b".into(),
            }))
            .collect()
    }

    /// Every other query Kubepit builds: cost usage, the 16 statistics
    /// queries of right-sizing (cluster-wide, namespace and single-workload
    /// scopes, with the kept cluster labels too) and upgrade readiness.
    fn other_presets() -> Vec<String> {
        use crate::prometheus::workload_stats::{query, StatQuery, StatScope};
        let scope = vec!["shop".to_string(), "a.b".to_string()];
        let mut out = vec![
            usage::pod_cpu_avg(604_800),
            usage::pod_memory_avg(3_600),
            crate::upgrade::METRIC_QUERY.to_string(),
        ];
        let cluster_wide = StatScope {
            days: 7,
            end_secs: 1_700_000_100,
            ..Default::default()
        };
        let namespaces = StatScope {
            namespaces: scope.clone(),
            cluster_labels: vec!["cluster".into()],
            ..cluster_wide.clone()
        };
        let workload = StatScope {
            namespaces: vec!["shop".into()],
            pod_regex: Some("web-[a-z0-9]+-[a-z0-9]+".into()),
            ..cluster_wide.clone()
        };
        for scope in [&cluster_wide, &namespaces, &workload] {
            out.extend(StatQuery::ALL.iter().map(|q| query(*q, scope)));
        }
        assert_eq!(out.len(), 3 + 3 * 16);
        out
    }

    /// `q` outside string literals, with the strings blanked out.
    fn blank_strings(q: &str) -> String {
        let mut out = String::with_capacity(q.len());
        let mut quote: Option<char> = None;
        let mut escaped = false;
        for ch in q.chars() {
            match quote {
                Some(open) => {
                    if escaped {
                        escaped = false;
                    } else if ch == '\\' {
                        escaped = true;
                    } else if ch == open {
                        quote = None;
                        out.push(ch);
                        continue;
                    }
                    out.push(' ');
                }
                None => {
                    if ch == '"' || ch == '\'' {
                        quote = Some(ch);
                    }
                    out.push(ch);
                }
            }
        }
        out
    }

    /// Brackets balance, every `{…}` block holds `matcher`, and every
    /// metric name (the series the presets use) opens such a block.
    fn balanced_and_every_selector_has(q: &str, matcher: &str) -> bool {
        let blank = blank_strings(q);
        let mut depth = 0i32;
        for ch in blank.chars() {
            match ch {
                '(' | '{' | '[' => depth += 1,
                ')' | '}' | ']' => depth -= 1,
                _ => {}
            }
            if depth < 0 {
                return false;
            }
        }
        if depth != 0 {
            return false;
        }
        let blocks = blank.matches('{').count();
        if blocks == 0 || q.matches(matcher).count() != blocks {
            return false;
        }
        let metric = regex::Regex::new(
            r"(^|[^a-zA-Z0-9_:])((node|container|kube|kubelet|apiserver)_[a-zA-Z0-9_:]*)",
        )
        .unwrap();
        let every_metric_opens_a_block = metric
            .captures_iter(&blank)
            .all(|c| blank[c.get(2).unwrap().end()..].starts_with('{'));
        every_metric_opens_a_block
    }

    #[test]
    fn matchers_reach_every_vector_selector() {
        assert_eq!(
            with_matchers(
                "sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)",
                r#"cluster="p""#
            ),
            r#"sum(node_memory_MemTotal_bytes{cluster="p"} - node_memory_MemAvailable_bytes{cluster="p"})"#
        );
        assert_eq!(
            with_matchers(r#"max by (pod) (rate(x{a="b"}[5m]))"#, r#"cluster="p""#),
            r#"max by (pod) (rate(x{a="b",cluster="p"}[5m]))"#
        );
        assert_eq!(
            with_matchers(
                r#"x{} * on(instance, job) group_left(nodename) y{n="a,b"}"#,
                r#"c="p""#
            ),
            r#"x{c="p"} * on(instance, job) group_left(nodename) y{n="a,b",c="p"}"#
        );
        for target in all_targets() {
            for metric in all_metrics() {
                if let Some(q) = preset(&target, metric, 60) {
                    assert!(
                        balanced_and_every_selector_has(
                            &with_matchers(&q, r#"cluster="p""#),
                            r#"cluster="p""#
                        ),
                        "{q}"
                    );
                }
            }
        }
        for q in other_presets() {
            assert!(
                balanced_and_every_selector_has(
                    &with_matchers(&q, r#"cluster="p""#),
                    r#"cluster="p""#
                ),
                "{q}"
            );
        }
    }

    #[test]
    fn the_lexer_skips_what_is_not_a_selector() {
        let m = r#"c="p""#;
        // Strings, subqueries, numbers, durations and keywords stay as they are.
        assert_eq!(
            with_matchers(
                r#"quantile_over_time(0.95, (sum by (namespace) (rate(a[5m])))[7d:5m]) * 1e3"#,
                m
            ),
            r#"quantile_over_time(0.95, (sum by (namespace) (rate(a{c="p"}[5m])))[7d:5m]) * 1e3"#
        );
        assert_eq!(
            with_matchers(
                r#"label_replace(up, "dst", "$1 x{y}", "src", "(.*)") > bool 0"#,
                m
            ),
            r#"label_replace(up{c="p"}, "dst", "$1 x{y}", "src", "(.*)") > bool 0"#
        );
        assert_eq!(
            with_matchers(
                r#"sum(a) without (pod) or vector(0) unless b offset -5m"#,
                m
            ),
            r#"sum(a{c="p"}) without (pod) or vector(0) unless b{c="p"} offset -5m"#
        );
        assert_eq!(
            with_matchers(r#"{__name__=~"up|x"} and ignoring(job) c {d='e}'}"#, m),
            r#"{__name__=~"up|x",c="p"} and ignoring(job) c {d='e}',c="p"}"#
        );
        assert_eq!(
            with_matchers(r#"SUM BY (le) (x{a="b",}) + Inf - NaN @ start()"#, m),
            r#"SUM BY (le) (x{a="b",c="p"}) + Inf - NaN @ start()"#
        );
        assert_eq!(
            with_matchers(
                "topk by (pod) (5, a:recorded:rate5m) * on() group_right b # b{x}",
                m
            ),
            r#"topk by (pod) (5, a:recorded:rate5m{c="p"}) * on() group_right b{c="p"} # b{x}"#
        );
        assert_eq!(
            with_matchers("rate (x [1h:])", m),
            r#"rate (x{c="p"} [1h:])"#
        );
        // Nothing to add, nothing changes.
        assert_eq!(with_matchers("sum(x)", ""), "sum(x)");
        assert_eq!(with_matchers("1 + 2", m), "1 + 2");
    }

    #[test]
    fn answers_must_carry_the_cluster_labels() {
        let labels: BTreeMap<String, String> = [("cluster".to_string(), "prod".to_string())]
            .into_iter()
            .collect();
        assert_eq!(by_labels(&labels), ", cluster");
        assert_eq!(by_labels(&BTreeMap::new()), "");
        let series = |pairs: &[(&str, &str)]| PromQuerySeries {
            labels: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            points: vec![(1, 1.0)],
        };
        let good = series(&[("pod", "a"), ("cluster", "prod")]);
        assert!(series_carry_labels(std::slice::from_ref(&good), &labels));
        assert!(
            series_carry_labels(&[], &labels),
            "no answer, nothing mixed"
        );
        assert!(!series_carry_labels(
            &[good.clone(), series(&[("pod", "b")])],
            &labels
        ));
        assert!(!series_carry_labels(
            &[series(&[("pod", "a"), ("cluster", "staging")])],
            &labels
        ));
        assert!(series_carry_labels(&[series(&[])], &BTreeMap::new()));
    }
}
