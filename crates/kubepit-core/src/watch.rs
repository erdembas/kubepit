//! Batched resource watches.
//!
//! A watch is one `kube::runtime::watcher` per source — a single
//! cluster-wide source, or one per selected namespace — merged into one
//! stream and folded into a [`WatchAggregator`]. The aggregator keeps a local
//! store (keyed by uid) and turns watcher events into [`WatchBatch`]es,
//! flushed every ~150 ms or as soon as 500 objects are pending, so a busy
//! namespace cannot flood the webview.
//!
//! Reset semantics (the part that is easy to get wrong with several
//! namespaces): the first batch of every watch has `reset: true`. When a
//! source *re*-initialises (watch desync / 410 Gone), its fresh list is
//! buffered until `InitDone`, swapped into the store, and the next batch is
//! a full snapshot of the merged store with `reset: true`. That way one
//! namespace re-listing can never wipe another namespace's rows in the UI.
//!
//! `synced` becomes true once every source finished its initial list (or
//! failed it — a 403 on one namespace must not leave the table spinning).
//! Watch errors are reported in the batch's `error` and the watcher keeps
//! retrying with kube's default backoff. kube rarely re-lists after an
//! error (only on 410 Gone): a failed watch keeps watching or resumes from
//! its resourceVersion, and a namespace whose first list failed streams its
//! later list without a reset. So a source that reported an error counts as
//! failing until it delivers an event again (`InitDone`, `Apply` or
//! `Delete`); once no source is failing, the next batch has `recovered` set
//! and the UI clears the error it shows. The task stops as soon as the
//! channel to the webview is gone.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures::StreamExt;
use kube::api::{ApiResource, DynamicObject};
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use serde_json::Value;

use crate::app::Kubepit;
use crate::error::watcher_error_message;
use crate::objects::{api_resource, dynamic_api, object_key, to_kube_object};
use crate::types::{Gvk, SharedKubeObject, WatchBatch};

/// Flush cadence for pending watch changes.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(150);
/// Flush early once this many changes are pending.
pub const FLUSH_MAX_OBJECTS: usize = 500;

#[derive(Default)]
struct SourceState {
    /// Fresh list being collected during a re-init.
    buffer: Option<HashMap<String, SharedKubeObject>>,
    synced_once: bool,
    failed_initial: bool,
    /// Last error of a source that has not delivered an event since (failing).
    error: Option<String>,
}

impl SourceState {
    fn settled(&self) -> bool {
        self.synced_once || self.failed_initial
    }
}

/// Pure watch bookkeeping: events in, batches out. No I/O, fully testable.
///
/// Objects are shared (`Arc`) between the store and the batches, so staging
/// an object or sending a full reset snapshot never copies one.
pub struct WatchAggregator {
    watch_id: String,
    sources: Vec<SourceState>,
    /// uid → (source index, object)
    store: HashMap<String, (usize, SharedKubeObject)>,
    upserts: HashMap<String, SharedKubeObject>,
    upsert_order: Vec<String>,
    deletes: HashSet<String>,
    reset: bool,
    error: Option<String>,
    /// Every failing source delivered an event again since the last batch.
    recovered: bool,
    pending: usize,
    last_synced: bool,
}

impl WatchAggregator {
    pub fn new(watch_id: impl Into<String>, sources: usize) -> Self {
        Self {
            watch_id: watch_id.into(),
            sources: (0..sources.max(1))
                .map(|_| SourceState::default())
                .collect(),
            store: HashMap::new(),
            upserts: HashMap::new(),
            upsert_order: Vec::new(),
            deletes: HashSet::new(),
            // The first batch always tells the UI to start from a clean slate.
            reset: true,
            error: None,
            recovered: false,
            pending: 0,
            last_synced: false,
        }
    }

    /// Number of changes accumulated since the last batch.
    pub fn pending(&self) -> usize {
        self.pending
    }

    pub fn synced(&self) -> bool {
        self.sources.iter().all(SourceState::settled)
    }

    fn source(&mut self, index: usize) -> &mut SourceState {
        let last = self.sources.len() - 1;
        &mut self.sources[index.min(last)]
    }

    fn stage_upsert(&mut self, key: String, value: SharedKubeObject) {
        if !self.deletes.is_empty() {
            self.deletes.remove(&key);
        }
        if self.upserts.insert(key.clone(), value).is_none() {
            self.upsert_order.push(key);
        }
        self.pending += 1;
    }

    fn stage_delete(&mut self, key: String) {
        if self.upserts.remove(&key).is_some() {
            self.upsert_order.retain(|k| k != &key);
        }
        self.deletes.insert(key);
        self.pending += 1;
    }

    /// A watcher (re)started listing for `source`.
    pub fn on_init(&mut self, source: usize) {
        let has_objects = self.store.values().any(|(s, _)| *s == source);
        let state = self.source(source);
        if state.synced_once || has_objects {
            // Re-list: collect the fresh state and swap it in atomically.
            state.buffer = Some(HashMap::new());
        } else {
            // First list: stream objects straight through.
            state.buffer = None;
        }
    }

    /// Object received while listing.
    pub fn on_init_apply(&mut self, source: usize, key: String, value: Value) {
        let value = Arc::new(value);
        if let Some(buffer) = self.source(source).buffer.as_mut() {
            buffer.insert(key, value);
            return;
        }
        self.store.insert(key.clone(), (source, Arc::clone(&value)));
        self.stage_upsert(key, value);
    }

    /// `source` delivered an event: if it was failing and no other source
    /// still is, the next batch reports the recovery (and drops an error
    /// that is older than it). While others still fail, a pending error
    /// names one of them instead of the source that just recovered.
    fn on_healthy(&mut self, source: usize) {
        if self.source(source).error.take().is_none() {
            return;
        }
        match self.sources.iter().find_map(|s| s.error.clone()) {
            None => {
                self.error = None;
                self.recovered = true;
                self.pending += 1;
            }
            Some(still_failing) => {
                if self.error.is_some() {
                    self.error = Some(still_failing);
                }
            }
        }
    }

    /// Listing finished for `source`.
    pub fn on_init_done(&mut self, source: usize) {
        self.on_healthy(source);
        let buffer = {
            let state = self.source(source);
            state.synced_once = true;
            state.failed_initial = false;
            state.buffer.take()
        };
        if let Some(buffer) = buffer {
            self.store.retain(|_, (s, _)| *s != source);
            for (key, value) in buffer {
                self.store.insert(key, (source, value));
            }
            self.reset = true;
            self.pending += 1;
        }
    }

    /// Object added or modified.
    pub fn on_apply(&mut self, source: usize, key: String, value: Value) {
        self.on_healthy(source);
        let value = Arc::new(value);
        self.store.insert(key.clone(), (source, Arc::clone(&value)));
        self.stage_upsert(key, value);
    }

    /// Object deleted.
    pub fn on_delete(&mut self, source: usize, key: String) {
        self.on_healthy(source);
        self.store.remove(&key);
        self.stage_delete(key);
    }

    /// Watcher failure for `source` (it keeps retrying).
    pub fn on_error(&mut self, source: usize, message: String) {
        let state = self.source(source);
        if !state.synced_once {
            state.failed_initial = true;
        }
        state.error = Some(message.clone());
        self.error = Some(message);
        // The error is newer than any recovery still pending.
        self.recovered = false;
        self.pending += 1;
    }

    /// Fold one raw watcher event.
    pub fn on_event(&mut self, source: usize, event: Event<DynamicObject>, ar: &ApiResource) {
        match event {
            Event::Init => self.on_init(source),
            Event::InitApply(obj) => {
                let key = object_key(&obj);
                self.on_init_apply(source, key, to_kube_object(obj, ar));
            }
            Event::InitDone => self.on_init_done(source),
            Event::Apply(obj) => {
                let key = object_key(&obj);
                self.on_apply(source, key, to_kube_object(obj, ar));
            }
            Event::Delete(obj) => {
                let key = object_key(&obj);
                self.on_delete(source, key);
            }
        }
    }

    /// The next batch to send, or `None` when nothing changed.
    pub fn take_batch(&mut self) -> Option<WatchBatch> {
        let synced = self.synced();
        let has_changes = !self.upserts.is_empty() || !self.deletes.is_empty();
        if !self.reset
            && !has_changes
            && self.error.is_none()
            && !self.recovered
            && synced == self.last_synced
        {
            return None;
        }
        self.last_synced = synced;
        self.pending = 0;
        let error = self.error.take();
        let recovered = std::mem::take(&mut self.recovered);
        if self.reset {
            self.reset = false;
            self.upserts.clear();
            self.upsert_order.clear();
            self.deletes.clear();
            let mut upserts: Vec<(&String, &SharedKubeObject)> =
                self.store.iter().map(|(k, (_, v))| (k, v)).collect();
            upserts.sort_unstable_by(|a, b| a.0.cmp(b.0));
            return Some(WatchBatch {
                watch_id: self.watch_id.clone(),
                reset: true,
                upserts: upserts.into_iter().map(|(_, v)| Arc::clone(v)).collect(),
                deletes: Vec::new(),
                synced,
                error,
                recovered,
            });
        }
        let order = std::mem::take(&mut self.upsert_order);
        let mut upserts_map = std::mem::take(&mut self.upserts);
        let upserts = order
            .into_iter()
            .filter_map(|k| upserts_map.remove(&k))
            .collect();
        let mut deletes: Vec<String> = self.deletes.drain().collect();
        deletes.sort();
        Some(WatchBatch {
            watch_id: self.watch_id.clone(),
            reset: false,
            upserts,
            deletes,
            synced,
            error,
            recovered,
        })
    }
}

/// Drive the merged watcher streams until the sink rejects a batch.
async fn run_watch<F>(
    watch_id: String,
    ar: ApiResource,
    apis: Vec<kube::Api<DynamicObject>>,
    sink: F,
) where
    F: Fn(WatchBatch) -> bool + Send + Sync + 'static,
{
    let sources = apis.len();
    let streams = apis.into_iter().enumerate().map(|(index, api)| {
        watcher::watcher(api, watcher::Config::default().any_semantic())
            .default_backoff()
            .map(move |event| (index, event))
            .boxed()
    });
    let mut merged = futures::stream::select_all(streams);
    let mut agg = WatchAggregator::new(watch_id, sources);
    // First flush one interval in, so the initial batch already carries the
    // first page of objects instead of an empty reset.
    let mut ticker =
        tokio::time::interval_at(tokio::time::Instant::now() + FLUSH_INTERVAL, FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let flush = |agg: &mut WatchAggregator| -> bool {
        match agg.take_batch() {
            Some(batch) => sink(batch),
            None => true,
        }
    };

    loop {
        tokio::select! {
            item = merged.next() => {
                match item {
                    Some((index, Ok(event))) => agg.on_event(index, event, &ar),
                    Some((index, Err(err))) => {
                        let message = watcher_error_message(&err);
                        tracing::debug!("watch {} source {index}: {message}", ar.plural);
                        agg.on_error(index, message);
                    }
                    None => {
                        flush(&mut agg);
                        return;
                    }
                }
                if agg.pending() >= FLUSH_MAX_OBJECTS && !flush(&mut agg) {
                    return;
                }
            }
            _ = ticker.tick() => {
                if !flush(&mut agg) {
                    return;
                }
            }
        }
    }
}

impl Kubepit {
    /// `resource_watch`: start a batched watch and return its id. Empty
    /// `namespaces` (or a cluster-scoped kind) watches cluster-wide.
    pub async fn resource_watch<F>(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespaces: Vec<String>,
        sink: F,
    ) -> Result<String>
    where
        F: Fn(WatchBatch) -> bool + Send + Sync + 'static,
    {
        let client = self.client(cluster_id).await?;
        let ar = api_resource(gvk);
        let mut unique: Vec<String> = Vec::new();
        for ns in namespaces {
            let ns = ns.trim().to_string();
            if !ns.is_empty() && !unique.contains(&ns) {
                unique.push(ns);
            }
        }
        let apis = if unique.is_empty() || !gvk.namespaced {
            vec![dynamic_api(client, &ar, gvk.namespaced, None)]
        } else {
            unique
                .iter()
                .map(|ns| dynamic_api(client.clone(), &ar, true, Some(ns)))
                .collect()
        };
        let watch_id = uuid::Uuid::new_v4().to_string();
        self.watches.spawn(
            &watch_id,
            cluster_id,
            run_watch(watch_id.clone(), ar, apis, sink),
        );
        Ok(watch_id)
    }

    /// `resource_unwatch`. Unknown ids are ignored (the watch may already
    /// have ended because its webview went away).
    pub fn resource_unwatch(&self, watch_id: &str) {
        self.watches.stop(watch_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(uid: &str, rv: u32) -> Value {
        json!({"metadata": {"uid": uid, "name": uid, "resourceVersion": rv.to_string()}})
    }

    fn uids(batch: &WatchBatch) -> Vec<String> {
        let mut v: Vec<String> = batch
            .upserts
            .iter()
            .map(|o| o["metadata"]["uid"].as_str().unwrap().to_string())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn first_batch_resets_and_streams_initial_list() {
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        agg.on_init_apply(0, "a".into(), obj("a", 1));
        let first = agg.take_batch().unwrap();
        assert!(first.reset);
        assert!(!first.synced);
        assert_eq!(uids(&first), vec!["a"]);

        agg.on_init_apply(0, "b".into(), obj("b", 1));
        agg.on_init_done(0);
        let second = agg.take_batch().unwrap();
        assert!(!second.reset);
        assert!(second.synced);
        assert_eq!(uids(&second), vec!["b"]);
        assert!(agg.take_batch().is_none(), "idle watch sends nothing");
    }

    #[test]
    fn empty_list_still_reports_synced() {
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        let first = agg.take_batch().unwrap();
        assert!(first.reset && !first.synced);
        agg.on_init_done(0);
        let second = agg.take_batch().unwrap();
        assert!(second.synced);
        assert!(second.upserts.is_empty());
    }

    #[test]
    fn incremental_upserts_and_deletes_are_coalesced() {
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        agg.on_init_done(0);
        agg.take_batch();

        agg.on_apply(0, "a".into(), obj("a", 1));
        agg.on_apply(0, "a".into(), obj("a", 2));
        agg.on_apply(0, "b".into(), obj("b", 1));
        agg.on_delete(0, "b".into());
        agg.on_delete(0, "gone".into());
        assert_eq!(agg.pending(), 5);
        let batch = agg.take_batch().unwrap();
        assert!(!batch.reset);
        assert_eq!(batch.upserts.len(), 1);
        assert_eq!(batch.upserts[0]["metadata"]["resourceVersion"], "2");
        assert_eq!(batch.deletes, vec!["b", "gone"]);
        assert_eq!(agg.pending(), 0);
    }

    #[test]
    fn relist_of_one_namespace_sends_full_merged_snapshot() {
        let mut agg = WatchAggregator::new("w", 2);
        for source in 0..2 {
            agg.on_init(source);
        }
        agg.on_init_apply(0, "a1".into(), obj("a1", 1));
        agg.on_init_apply(0, "a2".into(), obj("a2", 1));
        agg.on_init_apply(1, "b1".into(), obj("b1", 1));
        agg.on_init_done(0);
        let first = agg.take_batch().unwrap();
        assert!(first.reset);
        assert!(!first.synced, "source 1 still listing");
        agg.on_init_done(1);
        assert!(agg.take_batch().unwrap().synced);

        // Source 0 desyncs and re-lists; a2 disappeared meanwhile.
        agg.on_init(0);
        agg.on_init_apply(0, "a1".into(), obj("a1", 2));
        // Nothing is sent while the fresh list is being buffered.
        assert!(agg.take_batch().is_none());
        agg.on_init_done(0);
        let snapshot = agg.take_batch().unwrap();
        assert!(snapshot.reset);
        assert!(snapshot.synced);
        assert_eq!(
            uids(&snapshot),
            vec!["a1", "b1"],
            "b1 from namespace 1 survives"
        );
        let a1 = snapshot
            .upserts
            .iter()
            .find(|o| o["metadata"]["uid"] == "a1")
            .unwrap();
        assert_eq!(a1["metadata"]["resourceVersion"], "2");
    }

    #[test]
    fn errors_are_reported_once_and_settle_initial_sync() {
        let mut agg = WatchAggregator::new("w", 2);
        agg.on_init(0);
        agg.on_init_done(0);
        agg.on_error(1, "pods is forbidden".into());
        let batch = agg.take_batch().unwrap();
        assert_eq!(batch.error.as_deref(), Some("pods is forbidden"));
        assert!(batch.synced, "a forbidden namespace must not block synced");
        assert!(agg.take_batch().is_none());
        // Recovery clears the failure flag once listing succeeds.
        agg.on_init(1);
        agg.on_init_apply(1, "x".into(), obj("x", 1));
        agg.on_init_done(1);
        let next = agg.take_batch().unwrap();
        assert!(next.error.is_none());
        assert!(next.recovered);
        assert_eq!(uids(&next), vec!["x"]);
    }

    #[test]
    fn failed_initial_list_that_later_succeeds_reports_recovery() {
        let mut agg = WatchAggregator::new("w", 2);
        agg.on_init(0);
        agg.on_init_apply(0, "a".into(), obj("a", 1));
        agg.on_init_done(0);
        agg.on_error(1, "pods is forbidden".into());
        let failed = agg.take_batch().unwrap();
        assert_eq!(failed.error.as_deref(), Some("pods is forbidden"));
        assert!(!failed.recovered);

        // kube retries the list; it streams without a reset.
        agg.on_init(1);
        agg.on_init_apply(1, "b".into(), obj("b", 1));
        assert!(
            !agg.take_batch().unwrap().recovered,
            "not recovered mid-list"
        );
        agg.on_init_done(1);
        let recovered = agg.take_batch().unwrap();
        assert!(recovered.recovered);
        assert!(!recovered.reset);
        assert!(recovered.error.is_none());
        assert!(agg.take_batch().is_none(), "recovery is reported once");
    }

    #[test]
    fn error_then_clean_apply_reports_recovery() {
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        agg.on_init_done(0);
        agg.take_batch();
        // A dropped watch keeps its state and resumes from its resourceVersion.
        agg.on_error(0, "connection reset".into());
        assert!(agg.take_batch().unwrap().error.is_some());
        agg.on_apply(0, "a".into(), obj("a", 2));
        let batch = agg.take_batch().unwrap();
        assert!(batch.recovered && !batch.reset && batch.error.is_none());
        assert_eq!(uids(&batch), vec!["a"]);
        // Later events of a healthy source report nothing more.
        agg.on_apply(0, "a".into(), obj("a", 3));
        assert!(!agg.take_batch().unwrap().recovered);
    }

    #[test]
    fn error_then_clean_delete_reports_recovery() {
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        agg.on_init_apply(0, "a".into(), obj("a", 1));
        agg.on_init_done(0);
        agg.take_batch();
        agg.on_error(0, "watch stream closed".into());
        agg.take_batch();
        agg.on_delete(0, "a".into());
        let batch = agg.take_batch().unwrap();
        assert!(batch.recovered && batch.error.is_none());
        assert_eq!(batch.deletes, vec!["a"]);
    }

    #[test]
    fn recovery_waits_for_every_failing_source() {
        let mut agg = WatchAggregator::new("w", 3);
        for source in 0..3 {
            agg.on_init(source);
            agg.on_init_done(source);
        }
        agg.take_batch();
        agg.on_error(0, "a failed".into());
        agg.on_error(1, "b failed".into());
        agg.take_batch();
        // Events of a source that never failed prove nothing.
        agg.on_apply(2, "c".into(), obj("c", 1));
        assert!(!agg.take_batch().unwrap().recovered);
        agg.on_apply(0, "a".into(), obj("a", 1));
        assert!(
            !agg.take_batch().unwrap().recovered,
            "source 1 still failing"
        );
        agg.on_apply(1, "b".into(), obj("b", 1));
        assert!(agg.take_batch().unwrap().recovered);
    }

    #[test]
    fn a_recovered_source_does_not_leave_its_message_behind() {
        let mut agg = WatchAggregator::new("w", 2);
        for source in 0..2 {
            agg.on_init(source);
            agg.on_init_done(source);
        }
        agg.take_batch();
        agg.on_error(1, "b is forbidden".into());
        agg.take_batch();
        // Source 0 fails and recovers within one flush; source 1 still fails.
        agg.on_error(0, "a: connection reset".into());
        agg.on_apply(0, "a".into(), obj("a", 1));
        let batch = agg.take_batch().unwrap();
        assert!(!batch.recovered);
        assert_eq!(batch.error.as_deref(), Some("b is forbidden"));
    }

    #[test]
    fn a_batch_never_carries_both_an_error_and_a_recovery() {
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        agg.on_init_done(0);
        agg.take_batch();
        // Error and recovery within one flush interval: the recovery wins.
        agg.on_error(0, "blip".into());
        agg.on_apply(0, "a".into(), obj("a", 1));
        let batch = agg.take_batch().unwrap();
        assert!(batch.recovered && batch.error.is_none());
        // Recovery then a new error: the error wins.
        agg.on_error(0, "blip".into());
        agg.on_apply(0, "a".into(), obj("a", 2));
        agg.on_error(0, "again".into());
        let batch = agg.take_batch().unwrap();
        assert!(!batch.recovered);
        assert_eq!(batch.error.as_deref(), Some("again"));
    }

    #[test]
    fn event_folding_uses_uid_and_strips_managed_fields() {
        let ar = api_resource(&Gvk {
            group: "apps".into(),
            version: "v1".into(),
            kind: "Deployment".into(),
            plural: "deployments".into(),
            namespaced: true,
        });
        let dynamic: DynamicObject = serde_json::from_value(json!({
            "metadata": {"name": "web", "namespace": "ns", "uid": "u-1",
                         "managedFields": [{"manager": "x"}]},
            "spec": {"replicas": 2}
        }))
        .unwrap();
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_event(0, Event::Init, &ar);
        agg.on_event(0, Event::InitApply(dynamic.clone()), &ar);
        agg.on_event(0, Event::InitDone, &ar);
        let batch = agg.take_batch().unwrap();
        assert_eq!(batch.upserts[0]["kind"], "Deployment");
        assert_eq!(batch.upserts[0]["apiVersion"], "apps/v1");
        assert!(batch.upserts[0]["metadata"].get("managedFields").is_none());
        agg.on_event(0, Event::Delete(dynamic), &ar);
        assert_eq!(agg.take_batch().unwrap().deletes, vec!["u-1"]);
    }
}
