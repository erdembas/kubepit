//! The journal of one cluster: pure bookkeeping, no I/O.
//!
//! Watch events come in per *source* (one watcher: a kind, cluster-wide or
//! in one namespace) as already-normalized [`Prepared`] objects. The journal
//! keeps the last normalized version of every object (the baseline) and
//! records an entry whenever a new version differs from it.
//!
//! - The first list of a source only fills the baseline.
//! - A re-list (watch desync, 410 Gone) is compared against the baseline:
//!   changed objects become modifications, new ones additions and objects
//!   missing from the fresh list deletions, so nothing is lost while the
//!   watch was down.
//! - Entries are bounded by age, count and total bytes; each entry's
//!   before/after bodies are capped at [`JournalLimits::max_entry_bytes`]
//!   (long values shortened, or the bodies dropped with only the changed
//!   paths kept).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use serde_json::Value;

use super::diff::{changed_paths, MAX_PATHS};
use super::normalize::same_intent;
use super::types::{
    ChangeActor, ChangeDetail, ChangeFilter, ChangeJournalStatus, ChangeKindState,
    ChangeKindStatus, ChangeOp, ChangeSummary,
};
use crate::types::Gvk;

/// Largest page `query` returns.
pub const MAX_PAGE: usize = 1000;

#[derive(Debug, Clone, Copy)]
pub struct JournalLimits {
    pub max_entries: usize,
    pub max_age_ms: i64,
    /// Budget for all entries of the cluster (summaries + bodies).
    pub max_bytes: usize,
    /// Budget for the before + after bodies of one entry.
    pub max_entry_bytes: usize,
}

impl Default for JournalLimits {
    fn default() -> Self {
        Self {
            max_entries: 5_000,
            max_age_ms: 24 * 60 * 60 * 1000,
            max_bytes: 32 * 1024 * 1024,
            max_entry_bytes: 64 * 1024,
        }
    }
}

/// A normalized object from a watch event.
#[derive(Debug, Clone)]
pub struct Prepared {
    /// uid (or `namespace/name` when the object has none).
    pub key: String,
    pub gvk: Arc<Gvk>,
    pub namespace: Option<String>,
    pub name: String,
    pub uid: String,
    pub object: Value,
    pub actor: Option<ChangeActor>,
}

/// Last known version of an object.
struct Base {
    source: Arc<str>,
    gvk: Arc<Gvk>,
    namespace: Option<String>,
    name: String,
    uid: String,
    /// Normalized object as compact JSON (a fraction of a `Value`'s size).
    json: Box<str>,
}

impl Base {
    fn object(&self) -> Value {
        serde_json::from_str(&self.json).unwrap_or(Value::Null)
    }
}

struct Stored {
    summary: ChangeSummary,
    before: Option<Box<str>>,
    after: Option<Box<str>>,
    omitted: bool,
    bytes: usize,
}

#[derive(Default)]
struct Source {
    kind: String,
    synced_once: bool,
    /// Keys seen during a re-list.
    relist: Option<HashSet<String>>,
}

pub struct ClusterJournal {
    cluster_id: String,
    started_at: i64,
    limits: JournalLimits,
    next_id: u64,
    entries: VecDeque<Stored>,
    bytes: usize,
    evicted: u64,
    baseline: HashMap<String, Base>,
    sources: HashMap<Arc<str>, Source>,
    kinds: Vec<ChangeKindStatus>,
}

impl ClusterJournal {
    pub fn new(cluster_id: impl Into<String>, started_at: i64, limits: JournalLimits) -> Self {
        Self {
            cluster_id: cluster_id.into(),
            started_at,
            limits,
            next_id: 1,
            entries: VecDeque::new(),
            bytes: 0,
            evicted: 0,
            baseline: HashMap::new(),
            sources: HashMap::new(),
            kinds: Vec::new(),
        }
    }

    // -- Kinds and sources ----------------------------------------------------

    fn kind_mut(&mut self, kind: &str) -> &mut ChangeKindStatus {
        if let Some(i) = self.kinds.iter().position(|k| k.kind == kind) {
            return &mut self.kinds[i];
        }
        self.kinds.push(ChangeKindStatus {
            kind: kind.to_string(),
            state: ChangeKindState::Syncing,
            message: None,
        });
        self.kinds.last_mut().expect("just pushed")
    }

    /// Announce a kind (in display order) before its sources start.
    pub fn register_kind(&mut self, kind: &str) {
        self.kind_mut(kind);
    }

    /// A watcher for `kind` is about to start under `source`.
    pub fn register_source(&mut self, source: &str, kind: &str) {
        self.sources
            .entry(Arc::from(source))
            .or_insert_with(|| Source {
                kind: kind.to_string(),
                ..Source::default()
            });
        let status = self.kind_mut(kind);
        if status.state != ChangeKindState::Watching {
            status.state = ChangeKindState::Syncing;
        }
    }

    /// The watcher of `source` gave up (forbidden, not served). Objects it
    /// contributed stay in the baseline; they simply stop being updated.
    /// The kind's other sources may all be synced already.
    pub fn remove_source(&mut self, source: &str) {
        if let Some(removed) = self.sources.remove(source) {
            self.refresh_kind_named(&removed.kind);
        }
    }

    pub fn set_kind_state(&mut self, kind: &str, state: ChangeKindState, message: Option<String>) {
        let status = self.kind_mut(kind);
        status.state = state;
        status.message = message;
    }

    /// Transient watch failure; the watcher retries.
    pub fn source_error(&mut self, source: &str, message: String) {
        if let Some(kind) = self.sources.get(source).map(|s| s.kind.clone()) {
            self.set_kind_state(&kind, ChangeKindState::Error, Some(message));
        }
    }

    /// Recompute a kind's state after one of its sources made progress.
    fn refresh_kind(&mut self, source: &str) {
        if let Some(kind) = self.sources.get(source).map(|s| s.kind.clone()) {
            self.refresh_kind_named(&kind);
        }
    }

    /// Watching once every remaining source of `kind` listed; a kind
    /// without sources keeps its state (the recorder decides).
    fn refresh_kind_named(&mut self, kind: &str) {
        let mut sources = self.sources.values().filter(|s| s.kind == kind).peekable();
        if kind.is_empty() || sources.peek().is_none() {
            return;
        }
        let all_synced = sources.all(|s| s.synced_once);
        let status = self.kind_mut(kind);
        if all_synced {
            status.state = ChangeKindState::Watching;
            status.message = None;
        } else if status.state == ChangeKindState::Error {
            status.state = ChangeKindState::Syncing;
            status.message = None;
        }
    }

    fn source_key(&self, source: &str) -> Arc<str> {
        self.sources
            .get_key_value(source)
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| Arc::from(source))
    }

    // -- Watch events ---------------------------------------------------------

    /// A watcher (re)started listing.
    pub fn begin_list(&mut self, source: &str) {
        let source = self.sources.entry(Arc::from(source)).or_default();
        source.relist = source.synced_once.then(HashSet::new);
    }

    /// Object received while listing.
    pub fn list_item(&mut self, source: &str, item: Prepared, ts: i64) {
        let relisting = match self.sources.get_mut(source) {
            Some(Source {
                relist: Some(seen), ..
            }) => {
                seen.insert(item.key.clone());
                true
            }
            _ => false,
        };
        if relisting {
            self.apply(source, item, ts);
        } else {
            let json = serialize(&item.object);
            self.set_base(source, item, json);
        }
    }

    /// Listing finished: objects of this source missing from a re-list were
    /// deleted while the watch was down.
    pub fn end_list(&mut self, source: &str, ts: i64) {
        let seen = match self.sources.get_mut(source) {
            Some(state) => {
                state.synced_once = true;
                state.relist.take()
            }
            None => None,
        };
        if let Some(seen) = seen {
            let gone: Vec<String> = self
                .baseline
                .iter()
                .filter(|(key, base)| &*base.source == source && !seen.contains(*key))
                .map(|(key, _)| key.clone())
                .collect();
            for key in gone {
                if let Some(base) = self.baseline.remove(&key) {
                    let before = base.object();
                    self.record(
                        ts,
                        EntryMeta::from(&base),
                        ChangeOp::Deleted,
                        Some(before),
                        None,
                        None,
                    );
                }
            }
        }
        self.refresh_kind(source);
    }

    /// Object added or modified.
    pub fn apply(&mut self, source: &str, item: Prepared, ts: i64) {
        let json = serialize(&item.object);
        let previous = self.baseline.get(&item.key).map(Base::object);
        match previous {
            Some(before) if same_intent(&before, &item.object) => {
                // Noise only (status, resourceVersion, heartbeats, timestamps, …).
                self.set_base(source, item, json);
            }
            Some(before) => {
                let meta = EntryMeta::from(&item);
                let after = item.object.clone();
                let actor = item.actor.clone();
                self.set_base(source, item, json);
                self.record(
                    ts,
                    meta,
                    ChangeOp::Modified,
                    Some(before),
                    Some(after),
                    actor,
                );
            }
            None => {
                let meta = EntryMeta::from(&item);
                let after = item.object.clone();
                let actor = item.actor.clone();
                self.set_base(source, item, json);
                self.record(ts, meta, ChangeOp::Added, None, Some(after), actor);
            }
        }
        self.refresh_kind(source);
    }

    /// Object deleted.
    pub fn delete(&mut self, source: &str, item: Prepared, ts: i64) {
        let before = self
            .baseline
            .remove(&item.key)
            .map(|b| b.object())
            .unwrap_or_else(|| item.object.clone());
        let meta = EntryMeta::from(&item);
        self.record(ts, meta, ChangeOp::Deleted, Some(before), None, None);
        self.refresh_kind(source);
    }

    fn set_base(&mut self, source: &str, item: Prepared, json: String) {
        let source = self.source_key(source);
        self.baseline.insert(
            item.key,
            Base {
                source,
                gvk: item.gvk,
                namespace: item.namespace,
                name: item.name,
                uid: item.uid,
                json: json.into_boxed_str(),
            },
        );
    }

    fn record(
        &mut self,
        ts: i64,
        meta: EntryMeta,
        op: ChangeOp,
        before: Option<Value>,
        after: Option<Value>,
        actor: Option<ChangeActor>,
    ) {
        let secret = meta.gvk.kind == "Secret" && meta.gvk.group.is_empty();
        let mut paths = match (&before, &after) {
            (Some(b), Some(a)) => changed_paths(b, a, secret),
            _ => Vec::new(),
        };
        if op == ChangeOp::Modified && paths.is_empty() {
            return;
        }
        let path_count = paths.len() as u32;
        paths.truncate(MAX_PATHS);
        let bodies = fit_bodies(before.as_ref(), after.as_ref(), self.limits.max_entry_bytes);
        let summary = ChangeSummary {
            id: self.next_id,
            ts,
            cluster_id: self.cluster_id.clone(),
            gvk: (*meta.gvk).clone(),
            namespace: meta.namespace,
            name: meta.name,
            uid: meta.uid,
            op,
            actor,
            paths,
            path_count,
            truncated: bodies.truncated,
        };
        self.next_id += 1;
        let bytes = summary_bytes(&summary)
            + bodies.before.as_ref().map_or(0, |s| s.len())
            + bodies.after.as_ref().map_or(0, |s| s.len());
        self.bytes += bytes;
        self.entries.push_back(Stored {
            summary,
            before: bodies.before.map(String::into_boxed_str),
            after: bodies.after.map(String::into_boxed_str),
            omitted: bodies.omitted,
            bytes,
        });
        self.evict(ts);
    }

    // -- Bounds ---------------------------------------------------------------

    /// Drop entries beyond the age, count or byte budget (oldest first).
    pub fn evict(&mut self, now: i64) {
        while let Some(front) = self.entries.front() {
            let too_old = now - front.summary.ts > self.limits.max_age_ms;
            let too_many = self.entries.len() > self.limits.max_entries;
            let too_big = self.bytes > self.limits.max_bytes;
            if !(too_old || too_many || too_big) {
                break;
            }
            let dropped = self.entries.pop_front().expect("front exists");
            self.bytes -= dropped.bytes;
            self.evicted += 1;
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Bytes currently held by entries (not the baseline).
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn tracked_objects(&self) -> usize {
        self.baseline.len()
    }

    // -- Queries --------------------------------------------------------------

    /// Entries matching `filter`, newest first, plus the cursor of the next
    /// page when more match.
    pub fn query(&mut self, filter: &ChangeFilter, now: i64) -> (Vec<ChangeSummary>, Option<u64>) {
        self.evict(now);
        let limit = (filter.limit as usize).clamp(1, MAX_PAGE);
        let text = filter
            .text
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_lowercase);
        let mut matching = self
            .entries
            .iter()
            .rev()
            .map(|s| &s.summary)
            .filter(|s| filter.cursor.is_none_or(|c| s.id < c))
            .filter(|s| matches(s, filter, text.as_deref()));
        let page: Vec<ChangeSummary> = matching.by_ref().take(limit).cloned().collect();
        let next = match matching.next() {
            Some(_) => page.last().map(|s| s.id),
            None => None,
        };
        (page, next)
    }

    /// Epoch ms when this journal started recording.
    pub fn started_at(&self) -> i64 {
        self.started_at
    }

    /// Up to `limit` entries newer than `after`, oldest first, with their
    /// bodies (history persistence copies them to disk).
    pub fn details_after(&self, after: u64, limit: usize) -> Vec<ChangeDetail> {
        let start = self.entries.partition_point(|s| s.summary.id <= after);
        self.entries
            .range(start..)
            .take(limit)
            .map(|stored| ChangeDetail {
                summary: stored.summary.clone(),
                before_yaml: stored.before.as_deref().map(to_yaml),
                after_yaml: stored.after.as_deref().map(to_yaml),
                omitted: stored.omitted,
            })
            .collect()
    }

    pub fn detail(&self, id: u64) -> Option<ChangeDetail> {
        let stored = self.entries.iter().find(|s| s.summary.id == id)?;
        Some(ChangeDetail {
            summary: stored.summary.clone(),
            before_yaml: stored.before.as_deref().map(to_yaml),
            after_yaml: stored.after.as_deref().map(to_yaml),
            omitted: stored.omitted,
        })
    }

    /// Status without `enabled` (a settings matter).
    pub fn status(&self) -> ChangeJournalStatus {
        ChangeJournalStatus {
            enabled: true,
            recording: true,
            started_at: Some(self.started_at),
            synced: !self.kinds.is_empty()
                && self.kinds.iter().all(|k| {
                    matches!(
                        k.state,
                        ChangeKindState::Watching
                            | ChangeKindState::Forbidden
                            | ChangeKindState::NotServed
                    )
                }),
            kinds: self.kinds.clone(),
            entries: self.entries.len() as u32,
            evicted: self.evicted,
            oldest_ts: self.entries.front().map(|s| s.summary.ts),
        }
    }
}

struct EntryMeta {
    gvk: Arc<Gvk>,
    namespace: Option<String>,
    name: String,
    uid: String,
}

impl From<&Prepared> for EntryMeta {
    fn from(p: &Prepared) -> Self {
        Self {
            gvk: p.gvk.clone(),
            namespace: p.namespace.clone(),
            name: p.name.clone(),
            uid: p.uid.clone(),
        }
    }
}

impl From<&Base> for EntryMeta {
    fn from(b: &Base) -> Self {
        Self {
            gvk: b.gvk.clone(),
            namespace: b.namespace.clone(),
            name: b.name.clone(),
            uid: b.uid.clone(),
        }
    }
}

fn serialize(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn to_yaml(json: &str) -> String {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|v| serde_yaml::to_string(&v).ok())
        .unwrap_or_default()
}

fn summary_bytes(s: &ChangeSummary) -> usize {
    let paths: usize = s
        .paths
        .iter()
        .map(|p| {
            p.path.len()
                + p.before.as_ref().map_or(0, String::len)
                + p.after.as_ref().map_or(0, String::len)
                + 64
        })
        .sum();
    256 + s.name.len() + s.namespace.as_ref().map_or(0, String::len) + s.uid.len() + paths
}

fn matches(s: &ChangeSummary, f: &ChangeFilter, text: Option<&str>) -> bool {
    if f.since.is_some_and(|since| s.ts < since) || f.until.is_some_and(|until| s.ts > until) {
        return false;
    }
    if !f.kinds.is_empty() && !f.kinds.contains(&s.gvk.kind) {
        return false;
    }
    if !f.namespaces.is_empty() {
        let included = match &s.namespace {
            Some(ns) => f.namespaces.contains(ns),
            None => s.gvk.kind == "Namespace" && f.namespaces.contains(&s.name),
        };
        if !included {
            return false;
        }
    }
    if let Some(name) = f.name.as_deref().filter(|n| !n.is_empty()) {
        if s.name != name {
            return false;
        }
    }
    let Some(text) = text else {
        return true;
    };
    let mut haystack = format!(
        "{} {}/{} {}",
        s.gvk.kind,
        s.namespace.as_deref().unwrap_or(""),
        s.name,
        s.actor.as_ref().map_or("", |a| a.manager.as_str())
    );
    for p in &s.paths {
        haystack.push(' ');
        haystack.push_str(&p.path);
        if !p.redacted {
            for v in [&p.before, &p.after].into_iter().flatten() {
                haystack.push(' ');
                haystack.push_str(v);
            }
        }
    }
    haystack.to_lowercase().contains(text)
}

struct Bodies {
    before: Option<String>,
    after: Option<String>,
    truncated: bool,
    omitted: bool,
}

/// Serialize both sides within `cap` bytes: as is, then with long strings
/// shortened, else not at all.
fn fit_bodies(before: Option<&Value>, after: Option<&Value>, cap: usize) -> Bodies {
    let size = |b: &Option<String>, a: &Option<String>| {
        b.as_ref().map_or(0, String::len) + a.as_ref().map_or(0, String::len)
    };
    let before_s = before.map(serialize);
    let after_s = after.map(serialize);
    if size(&before_s, &after_s) <= cap {
        return Bodies {
            before: before_s,
            after: after_s,
            truncated: false,
            omitted: false,
        };
    }
    for limit in [2048, 256, 64] {
        let shorten = |v: &Value| {
            let mut v = v.clone();
            shorten_strings(&mut v, limit);
            serialize(&v)
        };
        let b = before.map(shorten);
        let a = after.map(shorten);
        if size(&b, &a) <= cap {
            return Bodies {
                before: b,
                after: a,
                truncated: true,
                omitted: false,
            };
        }
    }
    Bodies {
        before: None,
        after: None,
        truncated: true,
        omitted: true,
    }
}

fn shorten_strings(value: &mut Value, limit: usize) {
    match value {
        Value::String(s) if s.len() > limit => {
            let len = s.len();
            let mut end = limit.min(len);
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
            s.push_str(&format!("… <truncated: {len} bytes>"));
        }
        Value::Array(items) => items.iter_mut().for_each(|v| shorten_strings(v, limit)),
        Value::Object(map) => map.values_mut().for_each(|v| shorten_strings(v, limit)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: i64 = 1_700_000_000_000;
    const DEPLOY: &str = "deployments.apps@*";

    fn gvk(kind: &str) -> Arc<Gvk> {
        let group = match kind {
            "Deployment" => "apps",
            _ => "",
        };
        Arc::new(Gvk {
            group: group.into(),
            version: "v1".into(),
            kind: kind.into(),
            plural: format!("{}s", kind.to_lowercase()),
            namespaced: kind != "Namespace",
        })
    }

    fn item(kind: &str, ns: &str, name: &str, object: Value) -> Prepared {
        Prepared {
            key: format!("uid-{ns}-{name}"),
            gvk: gvk(kind),
            namespace: (!ns.is_empty()).then(|| ns.to_string()),
            name: name.into(),
            uid: format!("uid-{ns}-{name}"),
            object,
            actor: None,
        }
    }

    fn dep(name: &str, replicas: u32) -> Prepared {
        item(
            "Deployment",
            "shop",
            name,
            json!({"metadata": {"name": name, "namespace": "shop"}, "spec": {"replicas": replicas}}),
        )
    }

    fn synced() -> ClusterJournal {
        let mut j = ClusterJournal::new("c1", T0, JournalLimits::default());
        j.register_source(DEPLOY, "Deployment");
        j.begin_list(DEPLOY);
        j.list_item(DEPLOY, dep("web", 3), T0);
        j.list_item(DEPLOY, dep("api", 1), T0);
        j.end_list(DEPLOY, T0);
        j
    }

    fn all(j: &mut ClusterJournal) -> Vec<ChangeSummary> {
        j.query(
            &ChangeFilter {
                limit: 1000,
                ..ChangeFilter::default()
            },
            T0 + 1000,
        )
        .0
    }

    #[test]
    fn initial_list_is_only_a_baseline() {
        let j = synced();
        assert!(j.is_empty());
        assert_eq!(j.tracked_objects(), 2);
        let status = j.status();
        assert!(status.synced);
        assert_eq!(status.kinds[0].state, ChangeKindState::Watching);
    }

    #[test]
    fn modifications_additions_and_deletions_are_recorded() {
        let mut j = synced();
        // Same normalized object (e.g. a status update): nothing recorded.
        j.apply(DEPLOY, dep("web", 3), T0 + 1);
        assert!(j.is_empty());

        let mut scaled = dep("web", 5);
        scaled.actor = Some(ChangeActor {
            manager: "kubectl-scale".into(),
            operation: Some("Update".into()),
            subresource: Some("scale".into()),
        });
        j.apply(DEPLOY, scaled, T0 + 2);
        j.apply(DEPLOY, dep("cache", 1), T0 + 3);
        j.delete(DEPLOY, dep("api", 1), T0 + 4);

        let entries = all(&mut j);
        let ops: Vec<(ChangeOp, &str)> = entries.iter().map(|e| (e.op, e.name.as_str())).collect();
        assert_eq!(
            ops,
            vec![
                (ChangeOp::Deleted, "api"),
                (ChangeOp::Added, "cache"),
                (ChangeOp::Modified, "web"),
            ]
        );
        let web = &entries[2];
        assert_eq!(web.paths.len(), 1);
        assert_eq!(web.paths[0].path, "spec.replicas");
        assert_eq!(web.paths[0].before.as_deref(), Some("3"));
        assert_eq!(web.paths[0].after.as_deref(), Some("5"));
        assert_eq!(web.actor.as_ref().unwrap().manager, "kubectl-scale");
        assert_eq!(web.gvk.kind, "Deployment");
        assert_eq!(web.cluster_id, "c1");

        let detail = j.detail(web.id).unwrap();
        assert!(detail.before_yaml.unwrap().contains("replicas: 3"));
        assert!(detail.after_yaml.unwrap().contains("replicas: 5"));
        let added = j.detail(entries[1].id).unwrap();
        assert!(added.before_yaml.is_none() && added.after_yaml.is_some());
        let deleted = j.detail(entries[0].id).unwrap();
        assert!(deleted.before_yaml.unwrap().contains("replicas: 1"));
        assert!(deleted.after_yaml.is_none());
        assert!(j.detail(9999).is_none());
    }

    #[test]
    fn timestamp_only_updates_are_not_recorded() {
        const CM: &str = "configmaps@*";
        let heartbeat = |time: &str| {
            item(
                "ConfigMap",
                "kube-system",
                "keepalived-heartbeat",
                json!({"metadata": {"name": "keepalived-heartbeat"},
                       "data": {"node-a": format!(r#"{{"Status":"MASTER","HeartbeatTime":"{time}"}}"#)}}),
            )
        };
        let mut j = ClusterJournal::new("c1", T0, JournalLimits::default());
        j.register_source(CM, "ConfigMap");
        j.begin_list(CM);
        j.list_item(CM, heartbeat("2026-09-27T19:58:39.44Z"), T0);
        j.end_list(CM, T0);
        j.apply(CM, heartbeat("2026-09-27T19:58:41.45Z"), T0 + 1);
        j.apply(CM, heartbeat("2026-09-27T19:58:43.46Z"), T0 + 2);
        assert!(j.is_empty());
    }

    #[test]
    fn relist_reports_changes_missed_while_the_watch_was_down() {
        let mut j = synced();
        j.begin_list(DEPLOY);
        j.list_item(DEPLOY, dep("web", 4), T0 + 10);
        j.list_item(DEPLOY, dep("new", 1), T0 + 10);
        // `api` disappeared during the outage.
        j.end_list(DEPLOY, T0 + 11);
        let entries = all(&mut j);
        let mut ops: Vec<(ChangeOp, String)> =
            entries.iter().map(|e| (e.op, e.name.clone())).collect();
        ops.sort_by(|a, b| a.1.cmp(&b.1));
        assert_eq!(
            ops,
            vec![
                (ChangeOp::Deleted, "api".into()),
                (ChangeOp::Added, "new".into()),
                (ChangeOp::Modified, "web".into()),
            ]
        );
        assert_eq!(j.tracked_objects(), 2);
    }

    #[test]
    fn relist_of_one_source_leaves_other_sources_alone() {
        let mut j = synced();
        let cm = "configmaps@team-a";
        j.register_source(cm, "ConfigMap");
        j.begin_list(cm);
        j.list_item(
            cm,
            item("ConfigMap", "team-a", "cfg", json!({"data": {"a": "1"}})),
            T0,
        );
        j.end_list(cm, T0);
        j.begin_list(cm);
        j.end_list(cm, T0 + 5);
        let entries = all(&mut j);
        assert_eq!(entries.len(), 1, "only the configmap was deleted");
        assert_eq!(entries[0].name, "cfg");
        assert_eq!(entries[0].op, ChangeOp::Deleted);
    }

    #[test]
    fn filters_and_pagination() {
        let mut j = synced();
        for i in 0..10u32 {
            j.apply(DEPLOY, dep("web", 10 + i), T0 + 100 + i as i64);
        }
        j.apply(
            "namespaces@*",
            item(
                "Namespace",
                "",
                "shop",
                json!({"metadata": {"labels": {"a": "1"}}}),
            ),
            T0 + 200,
        );
        j.apply(
            "namespaces@*",
            item(
                "Namespace",
                "",
                "shop",
                json!({"metadata": {"labels": {"a": "2"}}}),
            ),
            T0 + 201,
        );
        j.apply(
            "namespaces@*",
            item("Namespace", "", "other", json!({})),
            T0 + 202,
        );

        let mut page = |f: ChangeFilter| j.query(&f, T0 + 1000);
        let (first, cursor) = page(ChangeFilter {
            kinds: vec!["Deployment".into()],
            limit: 4,
            ..ChangeFilter::default()
        });
        assert_eq!(first.len(), 4);
        assert!(first.windows(2).all(|w| w[0].id > w[1].id), "newest first");
        assert_eq!(first[0].paths[0].after.as_deref(), Some("19"));
        let (second, cursor2) = page(ChangeFilter {
            kinds: vec!["Deployment".into()],
            limit: 4,
            cursor,
            ..ChangeFilter::default()
        });
        assert_eq!(second.len(), 4);
        assert!(second[0].id < first[3].id);
        let (third, cursor3) = page(ChangeFilter {
            kinds: vec!["Deployment".into()],
            limit: 4,
            cursor: cursor2,
            ..ChangeFilter::default()
        });
        assert_eq!(third.len(), 2);
        assert_eq!(cursor3, None);

        // Namespace filter keeps the Namespace object itself, not other cluster-scoped ones.
        let (in_shop, _) = page(ChangeFilter {
            namespaces: vec!["shop".into()],
            limit: 100,
            ..ChangeFilter::default()
        });
        assert!(in_shop
            .iter()
            .any(|e| e.gvk.kind == "Namespace" && e.name == "shop"));
        assert!(!in_shop.iter().any(|e| e.name == "other"));

        // Time window, exact name, text over paths and values.
        let (window, _) = page(ChangeFilter {
            since: Some(T0 + 105),
            until: Some(T0 + 106),
            ..ChangeFilter::default()
        });
        assert_eq!(window.len(), 2);
        let (named, _) = page(ChangeFilter {
            name: Some("other".into()),
            ..ChangeFilter::default()
        });
        assert_eq!(named.len(), 1);
        let (text, _) = page(ChangeFilter {
            text: Some("  SPEC.REPLICAS  ".into()),
            ..ChangeFilter::default()
        });
        assert_eq!(text.len(), 10);
        let (value, _) = page(ChangeFilter {
            text: Some("labels".into()),
            ..ChangeFilter::default()
        });
        assert_eq!(value.len(), 1);
    }

    #[test]
    fn count_age_and_byte_bounds_evict_oldest_first() {
        let limits = JournalLimits {
            max_entries: 5,
            ..JournalLimits::default()
        };
        let mut j = ClusterJournal::new("c1", T0, limits);
        j.begin_list(DEPLOY);
        j.list_item(DEPLOY, dep("web", 0), T0);
        j.end_list(DEPLOY, T0);
        for i in 1..=8u32 {
            j.apply(DEPLOY, dep("web", i), T0 + i as i64);
        }
        assert_eq!(j.len(), 5);
        assert_eq!(j.status().evicted, 3);
        let newest = all(&mut j);
        assert_eq!(newest.last().unwrap().paths[0].after.as_deref(), Some("4"));

        // Age: a query a day later sees nothing.
        let (none, _) = j.query(&ChangeFilter::default(), T0 + 25 * 60 * 60 * 1000);
        assert!(none.is_empty());
        assert_eq!(j.len(), 0);
        assert_eq!(j.status().evicted, 8);

        // Bytes: a small budget keeps only what fits.
        let limits = JournalLimits {
            max_bytes: 4_000,
            ..JournalLimits::default()
        };
        let mut j = ClusterJournal::new("c1", T0, limits);
        for i in 0..50u32 {
            j.apply(DEPLOY, dep(&format!("d{i}"), 1), T0 + i as i64);
        }
        assert!(j.bytes() <= 4_000, "{}", j.bytes());
        assert!(j.len() < 50 && !j.is_empty());
        assert_eq!(j.status().evicted as usize + j.len(), 50);
    }

    #[test]
    fn oversized_entries_are_shortened_then_omitted() {
        let limits = JournalLimits {
            max_entry_bytes: 3_000,
            ..JournalLimits::default()
        };
        let mut j = ClusterJournal::new("c1", T0, limits);
        let cm = |v: &str| {
            item(
                "ConfigMap",
                "shop",
                "cfg",
                json!({"data": {"big": v, "small": "x"}}),
            )
        };
        j.begin_list("cm");
        j.list_item("cm", cm(&"a".repeat(5_000)), T0);
        j.end_list("cm", T0);
        j.apply("cm", cm(&"b".repeat(5_000)), T0 + 1);
        let entry = all(&mut j).remove(0);
        assert!(entry.truncated);
        let detail = j.detail(entry.id).unwrap();
        assert!(!detail.omitted);
        let after = detail.after_yaml.unwrap();
        assert!(after.contains("<truncated: 5000 bytes>"), "{after}");
        assert!(after.len() < 3_000);

        // Many keys that cannot be shortened enough: bodies dropped, paths kept.
        let wide = |v: &str| {
            let data: serde_json::Map<String, Value> = (0..400)
                .map(|i| (format!("key-{i:04}"), json!(v)))
                .collect();
            item("ConfigMap", "shop", "wide", json!({"data": data}))
        };
        j.list_item("cm", wide("1"), T0);
        j.apply("cm", wide("2"), T0 + 2);
        let entry = all(&mut j).remove(0);
        assert_eq!(entry.name, "wide");
        assert_eq!(entry.path_count, 400);
        assert_eq!(entry.paths.len(), MAX_PATHS);
        let detail = j.detail(entry.id).unwrap();
        assert!(detail.omitted && detail.before_yaml.is_none() && detail.after_yaml.is_none());
    }

    #[test]
    fn a_failing_fallback_source_does_not_block_its_synced_siblings() {
        let mut j = ClusterJournal::new("c1", T0, JournalLimits::default());
        j.register_kind("ConfigMap");
        j.register_source("configmaps@team-a", "ConfigMap");
        j.register_source("configmaps@team-b", "ConfigMap");
        j.begin_list("configmaps@team-a");
        j.end_list("configmaps@team-a", T0);
        assert_eq!(j.status().kinds[0].state, ChangeKindState::Syncing);
        // team-b turns out to be forbidden after team-a already listed.
        j.remove_source("configmaps@team-b");
        assert_eq!(j.status().kinds[0].state, ChangeKindState::Watching);
        assert!(j.status().synced);
    }

    #[test]
    fn source_failures_and_errors_drive_kind_states() {
        let mut j = ClusterJournal::new("c1", T0, JournalLimits::default());
        j.register_kind("Deployment");
        j.register_kind("Secret");
        j.register_source(DEPLOY, "Deployment");
        assert!(!j.status().synced);
        j.set_kind_state(
            "Secret",
            ChangeKindState::Forbidden,
            Some("secrets is forbidden".into()),
        );
        j.source_error(DEPLOY, "connection reset".into());
        assert_eq!(j.status().kinds[0].state, ChangeKindState::Error);
        j.begin_list(DEPLOY);
        j.end_list(DEPLOY, T0);
        let status = j.status();
        assert_eq!(status.kinds[0].state, ChangeKindState::Watching);
        assert_eq!(status.kinds[0].message, None);
        assert!(status.synced, "forbidden kinds count as settled");
        assert_eq!(status.started_at, Some(T0));
    }
}
