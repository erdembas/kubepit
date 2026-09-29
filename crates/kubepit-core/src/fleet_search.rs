//! Fleet search: find objects by name on every connected cluster at once.
//!
//! One search fans out to all target clusters concurrently; within a
//! cluster, kinds are listed concurrently as *metadata only* (no specs, no
//! Secret data cross the wire), paginated, with the query's label selector
//! applied by the API server. Names are matched locally by [`NameMatcher`]:
//! case-insensitive substring by default, glob (`web-*`, `api-?`) or
//! `/regex/`; space-separated terms must all match.
//!
//! Results stream as [`FleetSearchEvent`]s: `results` per (cluster, kind),
//! then `cluster-done` or `cluster-error` per cluster, `cluster-skipped` for
//! clusters that are not connected, and a final `done`. Kinds a cluster
//! does not serve are skipped quietly (the served version is taken from
//! discovery, so `batch/v1beta1` clusters still answer); kinds RBAC forbids
//! are reported in `forbidden_kinds`. Every cluster is bounded by
//! [`CLUSTER_TIMEOUT`], so one unreachable API server cannot stall the rest.
//! Only already-connected clusters are searched: a search never connects.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use futures::{stream, StreamExt};
use kube::api::ListParams;
use kube::Client;
use regex::{Regex, RegexBuilder};

use crate::app::Kubepit;
use crate::discovery::discover;
use crate::error::{is_forbidden, is_not_found, kube_error};
use crate::objects::{api_resource, dynamic_api};
use crate::types::{
    ApiResourceInfo, FleetSearchEvent, FleetSearchEventKind, FleetSearchItem, FleetSearchQuery, Gvk,
};

/// Upper bound per cluster (discovery plus every kind).
pub const CLUSTER_TIMEOUT: Duration = Duration::from_secs(10);
/// Concurrent list requests per cluster.
const KIND_CONCURRENCY: usize = 4;
/// Page size of the metadata lists.
const PAGE_SIZE: u32 = 500;
/// Regex compile budget (the `regex` crate matches in linear time).
const REGEX_SIZE_LIMIT: usize = 1 << 20;

/// One term of a plain-text query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Term {
    /// Case-insensitive substring.
    Contains(String),
    /// Whole-name glob with `*` and `?`, lowercased.
    Glob(Vec<char>),
}

/// How object names are matched.
#[derive(Debug, Clone)]
pub enum NameMatcher {
    All,
    Terms(Vec<Term>),
    Regex(Regex),
}

impl NameMatcher {
    /// `""` → everything; `/…/` → regex; otherwise whitespace-separated
    /// terms, each a glob when it contains `*` or `?`, else a substring.
    pub fn parse(text: &str) -> Result<Self> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(Self::All);
        }
        if text.len() >= 2 && text.starts_with('/') && text.ends_with('/') {
            let pattern = &text[1..text.len() - 1];
            let regex = RegexBuilder::new(pattern)
                .case_insensitive(true)
                .size_limit(REGEX_SIZE_LIMIT)
                .build()
                .map_err(|e| anyhow!("invalid regular expression: {e}"))?;
            return Ok(Self::Regex(regex));
        }
        Ok(Self::Terms(
            text.split_whitespace()
                .map(|word| {
                    let lower = word.to_lowercase();
                    if lower.contains(['*', '?']) {
                        Term::Glob(lower.chars().collect())
                    } else {
                        Term::Contains(lower)
                    }
                })
                .collect(),
        ))
    }

    /// Whether `name` matches. Terms compare against `name.to_lowercase()`
    /// (the pattern was lowercased by [`parse`](Self::parse)). An ASCII
    /// name, which is every Kubernetes name, lowercases byte by byte, so it
    /// is compared in place without allocating; any other name takes
    /// `str::to_lowercase` (full Unicode lowercasing, context included).
    pub fn matches(&self, name: &str) -> bool {
        match self {
            Self::All => true,
            Self::Regex(regex) => regex.is_match(name),
            Self::Terms(terms) if name.is_ascii() => {
                let bytes = name.as_bytes();
                terms.iter().all(|term| match term {
                    Term::Contains(needle) => contains_ascii_lowered(bytes, needle.as_bytes()),
                    Term::Glob(pattern) => glob_match_at(pattern, bytes.len(), |i| {
                        char::from(bytes[i].to_ascii_lowercase())
                    }),
                })
            }
            Self::Terms(terms) => {
                let lower = name.to_lowercase();
                let chars: Vec<char> = if terms.iter().any(|t| matches!(t, Term::Glob(_))) {
                    lower.chars().collect()
                } else {
                    Vec::new()
                };
                terms.iter().all(|term| match term {
                    Term::Contains(needle) => lower.contains(needle.as_str()),
                    Term::Glob(pattern) => glob_match(pattern, &chars),
                })
            }
        }
    }
}

/// Whether the ASCII-lowercased `haystack` contains `needle` (already
/// lowercase). A non-ASCII byte in `needle` never matches, as it could not
/// in a lowercased ASCII name.
fn contains_ascii_lowered(haystack: &[u8], needle: &[u8]) -> bool {
    let Some((&first, rest)) = needle.split_first() else {
        return true;
    };
    if needle.len() > haystack.len() {
        return false;
    }
    (0..=haystack.len() - needle.len()).any(|start| {
        haystack[start].to_ascii_lowercase() == first
            && haystack[start + 1..start + needle.len()]
                .iter()
                .zip(rest)
                .all(|(h, n)| h.to_ascii_lowercase() == *n)
    })
}

/// Whole-string glob match (`*` = any run, `?` = one character) with the
/// classic single-backtrack algorithm: linear for one star, never
/// exponential.
pub fn glob_match(pattern: &[char], text: &[char]) -> bool {
    glob_match_at(pattern, text.len(), |i| text[i])
}

/// [`glob_match`] over a text of `len` characters read through `at`.
fn glob_match_at(pattern: &[char], len: usize, at: impl Fn(usize) -> char) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<usize> = None;
    let mut resume = 0;
    while t < len {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == at(t)) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            resume = t;
            p += 1;
        } else if let Some(s) = star {
            p = s + 1;
            resume += 1;
            t = resume;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

/// The served variant of `wanted` on a cluster: same group and plural, the
/// version discovery reports. `None` when discovery knows the cluster does
/// not serve it; `wanted` itself when discovery is unknown.
pub fn served_gvk(wanted: &Gvk, resources: Option<&[ApiResourceInfo]>) -> Option<Gvk> {
    match resources {
        None => Some(wanted.clone()),
        Some(list) => list
            .iter()
            .find(|r| r.group == wanted.group && r.plural == wanted.plural)
            .map(ApiResourceInfo::gvk),
    }
}

/// Everything a running search needs, shared by its cluster tasks.
struct Plan {
    search_id: String,
    matcher: NameMatcher,
    kinds: Vec<Gvk>,
    namespace: Option<String>,
    label_selector: Option<String>,
    limit: usize,
}

struct Target {
    id: String,
    /// `None` when the cluster is not connected (or not registered).
    client: Option<Client>,
    /// Cached discovery of the current connection, if any.
    resources: Option<Arc<Vec<ApiResourceInfo>>>,
    skip_reason: &'static str,
}

/// What one cluster's kinds produced besides results.
#[derive(Default)]
struct ClusterOutcome {
    forbidden: Vec<String>,
    errors: Vec<String>,
}

struct Emitter<F> {
    sink: F,
    closed: AtomicBool,
}

impl<F: Fn(FleetSearchEvent) -> bool> Emitter<F> {
    fn send(&self, event: FleetSearchEvent) {
        if !self.closed.load(Ordering::Relaxed) && !(self.sink)(event) {
            self.closed.store(true, Ordering::Relaxed);
        }
    }

    fn closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }
}

fn event(plan: &Plan, cluster_id: Option<&str>, kind: FleetSearchEventKind) -> FleetSearchEvent {
    FleetSearchEvent {
        search_id: plan.search_id.clone(),
        cluster_id: cluster_id.map(str::to_string),
        kind,
        items: Vec::new(),
        truncated: false,
        forbidden_kinds: Vec::new(),
        error: None,
    }
}

/// Matching objects of one kind, sorted by namespace and name, plus whether
/// more matched than `plan.limit`.
async fn list_matches(
    client: &Client,
    gvk: &Gvk,
    plan: &Plan,
) -> Result<(Vec<FleetSearchItem>, bool)> {
    let ar = api_resource(gvk);
    let api = dynamic_api(
        client.clone(),
        &ar,
        gvk.namespaced,
        plan.namespace.as_deref(),
    );
    let mut items = Vec::new();
    let mut truncated = false;
    let mut token: Option<String> = None;
    'pages: loop {
        let mut lp = ListParams::default().limit(PAGE_SIZE);
        if let Some(selector) = plan.label_selector.as_deref() {
            lp = lp.labels(selector);
        }
        if let Some(token) = token.as_deref() {
            lp = lp.continue_token(token);
        }
        let page = api.list_metadata(&lp).await.map_err(kube_error)?;
        for object in page.items {
            let meta = object.metadata;
            let name = meta.name.unwrap_or_default();
            if !plan.matcher.matches(&name) {
                continue;
            }
            if items.len() >= plan.limit {
                truncated = true;
                break 'pages;
            }
            items.push(FleetSearchItem {
                gvk: gvk.clone(),
                namespace: meta.namespace.filter(|ns| !ns.is_empty()),
                name,
                uid: meta.uid.unwrap_or_default(),
                created: meta
                    .creation_timestamp
                    .and_then(|t| serde_json::to_value(t).ok())
                    .and_then(|v| v.as_str().map(str::to_string)),
                labels: meta.labels.unwrap_or_default(),
            });
        }
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            break;
        }
    }
    items.sort_by(|a, b| {
        a.namespace
            .cmp(&b.namespace)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok((items, truncated))
}

async fn search_kinds<F: Fn(FleetSearchEvent) -> bool>(
    plan: &Plan,
    cluster_id: &str,
    client: Client,
    resources: Option<Arc<Vec<ApiResourceInfo>>>,
    emit: &Emitter<F>,
) -> ClusterOutcome {
    let resources = match resources {
        Some(cached) => Some(cached),
        // Not cached for this connection yet: ask, but never let a broken
        // aggregated API block the search (lists then decide what exists).
        None => discover(&client).await.ok().map(Arc::new),
    };
    let kinds: Vec<Gvk> = plan
        .kinds
        .iter()
        .filter_map(|k| served_gvk(k, resources.as_deref().map(Vec::as_slice)))
        .filter(|gvk| plan.namespace.is_none() || gvk.namespaced)
        .collect();

    let client = &client;
    let mut lists = stream::iter(kinds)
        .map(|gvk| async move {
            let result = list_matches(client, &gvk, plan).await;
            (gvk, result)
        })
        .buffer_unordered(KIND_CONCURRENCY);
    let mut outcome = ClusterOutcome::default();
    while let Some((gvk, result)) = lists.next().await {
        if emit.closed() {
            break;
        }
        match result {
            Ok((items, truncated)) if !items.is_empty() => {
                let mut results = event(plan, Some(cluster_id), FleetSearchEventKind::Results);
                results.items = items;
                results.truncated = truncated;
                emit.send(results);
            }
            Ok(_) => {}
            Err(e) if is_forbidden(&e) => outcome.forbidden.push(gvk.kind),
            // Not served after all (discovery was unavailable or stale).
            Err(e) if is_not_found(&e) => {}
            Err(e) => outcome.errors.push(format!("{}: {e:#}", gvk.kind)),
        }
    }
    outcome.forbidden.sort();
    outcome
}

async fn search_cluster<F: Fn(FleetSearchEvent) -> bool>(
    plan: &Plan,
    target: Target,
    emit: &Emitter<F>,
) {
    let Some(client) = target.client else {
        let mut skipped = event(plan, Some(&target.id), FleetSearchEventKind::ClusterSkipped);
        skipped.error = Some(target.skip_reason.to_string());
        emit.send(skipped);
        return;
    };
    let work = search_kinds(plan, &target.id, client, target.resources, emit);
    let (kind, forbidden, error) = match tokio::time::timeout(CLUSTER_TIMEOUT, work).await {
        Ok(outcome) if outcome.errors.is_empty() => {
            (FleetSearchEventKind::ClusterDone, outcome.forbidden, None)
        }
        Ok(outcome) => (
            FleetSearchEventKind::ClusterError,
            outcome.forbidden,
            Some(outcome.errors.join("; ")),
        ),
        Err(_) => (
            FleetSearchEventKind::ClusterError,
            Vec::new(),
            Some(format!("timed out after {}s", CLUSTER_TIMEOUT.as_secs())),
        ),
    };
    let mut finished = event(plan, Some(&target.id), kind);
    finished.forbidden_kinds = forbidden;
    finished.error = error;
    emit.send(finished);
}

async fn run_search<F>(plan: Plan, targets: Vec<Target>, sink: F)
where
    F: Fn(FleetSearchEvent) -> bool,
{
    let emit = Emitter {
        sink,
        closed: AtomicBool::new(false),
    };
    futures::future::join_all(
        targets
            .into_iter()
            .map(|target| search_cluster(&plan, target, &emit)),
    )
    .await;
    emit.send(event(&plan, None, FleetSearchEventKind::Done));
}

impl Kubepit {
    /// `fleet_search`: start a search and return its id; results arrive on
    /// `on_event` (return `false` to stop). Fails up front only for an
    /// invalid query (bad regex, no kinds).
    pub fn fleet_search<F>(&self, query: FleetSearchQuery, on_event: F) -> Result<String>
    where
        F: Fn(FleetSearchEvent) -> bool + Send + Sync + 'static,
    {
        let matcher = NameMatcher::parse(&query.text)?;
        if query.kinds.is_empty() {
            bail!("choose at least one kind to search");
        }
        let registered: Vec<String> = self.store.clusters().into_iter().map(|c| c.id).collect();
        let ids = if query.cluster_ids.is_empty() {
            registered.clone()
        } else {
            let mut ids: Vec<String> = Vec::new();
            for id in &query.cluster_ids {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
            ids
        };
        let targets = ids
            .into_iter()
            .map(|id| {
                let known = registered.contains(&id);
                let client = known.then(|| self.pool.connected_client(&id)).flatten();
                Target {
                    resources: client.as_ref().and_then(|_| self.pool.resources(&id)),
                    client,
                    skip_reason: if known {
                        "not connected"
                    } else {
                        "not registered"
                    },
                    id,
                }
            })
            .collect();
        let normalized =
            |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let search_id = uuid::Uuid::new_v4().to_string();
        let plan = Plan {
            search_id: search_id.clone(),
            matcher,
            kinds: query.kinds,
            namespace: normalized(query.namespace),
            label_selector: normalized(query.label_selector),
            limit: query.limit_per_kind.max(1) as usize,
        };
        // Fleet-wide, so not tagged with a cluster: disconnecting one
        // cluster must not cancel the others' results.
        self.fleet_searches
            .spawn(&search_id, "", run_search(plan, targets, on_event));
        Ok(search_id)
    }

    /// `fleet_search_cancel`. Unknown or finished ids are ignored.
    pub fn fleet_search_cancel(&self, search_id: &str) {
        self.fleet_searches.stop(search_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(text: &str) -> NameMatcher {
        NameMatcher::parse(text).unwrap()
    }

    #[test]
    fn empty_query_matches_everything() {
        assert!(m("").matches("anything"));
        assert!(m("   ").matches(""));
    }

    #[test]
    fn substring_is_case_insensitive_and_terms_are_anded() {
        assert!(m("Web").matches("checkout-web-7f9c"));
        assert!(!m("api").matches("checkout-web-7f9c"));
        assert!(m("web 7f9").matches("checkout-web-7f9c"));
        assert!(!m("web zzz").matches("checkout-web-7f9c"));
        assert!(m("ÇAY").matches("çay-ocağı"), "unicode case folding");
    }

    #[test]
    fn globs_match_whole_names() {
        assert!(m("web-*").matches("web-7f9c"));
        assert!(!m("web-*").matches("checkout-web-7f9c"));
        assert!(m("*web*").matches("checkout-web-7f9c"));
        assert!(m("api-?").matches("API-1"));
        assert!(!m("api-?").matches("api-12"));
        assert!(m("*-db-*-0").matches("orders-db-primary-0"));
        assert!(m("a*b*c").matches("aXXbYYc"));
        assert!(!m("a*b*c").matches("aXXbYY"));
        assert!(m("**").matches(""));
        let pattern: Vec<char> = "*a*a*a*a*b".chars().collect();
        let text: Vec<char> = "a".repeat(200).chars().collect();
        assert!(!glob_match(&pattern, &text), "no catastrophic backtracking");
    }

    /// The matcher before its ASCII fast path: lowercase every name.
    fn reference_matches(matcher: &NameMatcher, name: &str) -> bool {
        match matcher {
            NameMatcher::All => true,
            NameMatcher::Regex(regex) => regex.is_match(name),
            NameMatcher::Terms(terms) => {
                let lower = name.to_lowercase();
                let chars: Vec<char> = lower.chars().collect();
                terms.iter().all(|term| match term {
                    Term::Contains(needle) => lower.contains(needle.as_str()),
                    Term::Glob(pattern) => glob_match(pattern, &chars),
                })
            }
        }
    }

    #[test]
    fn ascii_fast_path_keeps_the_lowercasing_semantics() {
        let names = [
            "",
            "a",
            "API",
            "checkout-web-7f9c",
            "Checkout-WEB-7F9C",
            "app-0001-api-kbf2jnh5rf-6gdhk",
            "orders-db-primary-0",
            "aaaaaaaaab",
            "k",
            "i",
            // Non-ASCII names take the lowercasing path.
            "çay-ocağı",
            "ÇAY-OCAĞI",
            "İstanbul",
            "ΟΔΟΣ",
            "straße",
            "\u{212A}elvin",
            "日本-api",
        ];
        let patterns = [
            "api",
            "API",
            "Web 7f9",
            "web zzz",
            "a",
            "ab",
            "k",
            "i",
            "i\u{307}",
            "İ",
            "\u{212A}",
            "çay",
            "ÇAY",
            "οδος",
            "ς",
            "ss",
            "ß",
            "web-*",
            "*web*",
            "app-*-api",
            "api-?",
            "*-db-*-0",
            "a*b",
            "?",
            "??",
            "*",
            "**",
            "?stanbul",
            "??stanbul",
            "*ağı",
            "*\u{212A}*",
            "日本-*",
            "?本-api",
            "/^app-0[0-9]+-api$/",
            "/web|worker/",
        ];
        for pattern in patterns {
            let matcher = m(pattern);
            for name in names {
                assert_eq!(
                    matcher.matches(name),
                    reference_matches(&matcher, name),
                    "pattern {pattern:?}, name {name:?}"
                );
            }
        }
        // Lowercasing the name, not folding it: `İ` lowers to `i̇`, so a
        // plain `i` finds it, and the Kelvin sign lowers to ASCII `k`.
        assert!(m("i").matches("İstanbul"));
        assert!(m("k").matches("\u{212A}elvin"));
        assert!(m("\u{212A}").matches("kelvin"));
        assert!(!m("ss").matches("straße"));
    }

    #[test]
    fn slashes_make_a_case_insensitive_regex() {
        assert!(m(r"/^api-\d+$/").matches("API-42"));
        assert!(!m(r"/^api-\d+$/").matches("api-x"));
        assert!(m("/web|worker/").matches("queue-worker"));
        let err = NameMatcher::parse("/(unclosed/").unwrap_err();
        assert!(
            err.to_string().contains("invalid regular expression"),
            "{err}"
        );
        // A lone slash is just text.
        assert!(m("/").matches("a/b"));
    }

    fn info(group: &str, version: &str, kind: &str, plural: &str) -> ApiResourceInfo {
        ApiResourceInfo {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced: true,
            api_version: if group.is_empty() {
                version.into()
            } else {
                format!("{group}/{version}")
            },
            verbs: vec!["list".into()],
            short_names: Vec::new(),
            categories: Vec::new(),
        }
    }

    #[test]
    fn served_versions_come_from_discovery() {
        let cronjobs = Gvk {
            group: "batch".into(),
            version: "v1".into(),
            kind: "CronJob".into(),
            plural: "cronjobs".into(),
            namespaced: true,
        };
        let old = [info("batch", "v1beta1", "CronJob", "cronjobs")];
        assert_eq!(
            served_gvk(&cronjobs, Some(&old)).unwrap().version,
            "v1beta1"
        );
        assert_eq!(served_gvk(&cronjobs, Some(&[])), None);
        assert_eq!(served_gvk(&cronjobs, None), Some(cronjobs.clone()));
    }

    #[test]
    fn query_and_events_match_the_contract() {
        let q: FleetSearchQuery = serde_json::from_value(json!({
            "text": "web",
            "kinds": [{"group": "", "version": "v1", "kind": "Pod", "plural": "pods", "namespaced": true}]
        }))
        .unwrap();
        assert_eq!(q.limit_per_kind, crate::types::DEFAULT_FLEET_SEARCH_LIMIT);
        assert!(q.cluster_ids.is_empty() && q.namespace.is_none());
        let plan = Plan {
            search_id: "s".into(),
            matcher: NameMatcher::All,
            kinds: Vec::new(),
            namespace: None,
            label_selector: None,
            limit: 1,
        };
        let e = serde_json::to_value(event(
            &plan,
            Some("c"),
            FleetSearchEventKind::ClusterSkipped,
        ))
        .unwrap();
        assert_eq!(e["kind"], "cluster-skipped");
        assert_eq!(e["cluster_id"], "c");
        assert_eq!(e["forbidden_kinds"], json!([]));
        let done = serde_json::to_value(event(&plan, None, FleetSearchEventKind::Done)).unwrap();
        assert_eq!(done["kind"], "done");
        assert!(done["cluster_id"].is_null());
    }
}
