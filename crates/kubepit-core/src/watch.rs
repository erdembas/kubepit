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
//!
//! Batches are acknowledged ([`AckWindow`]): each carries a `seq`, and the
//! webview acks it once applied (`resource_watch_ack`). With
//! [`MAX_UNACKED`] batches in flight the watch keeps folding events (the
//! pending upserts are latest-wins) and sends nothing, so a slow webview
//! gets fewer, larger batches instead of a growing queue. A watch whose
//! batches get no ack for [`ACK_TIMEOUT`] stops, which ends the watches of
//! a closed window even when the channel still accepts sends (Tauri's
//! larger payloads do). Its last batch has `stopped` set, so a webview that
//! was only frozen restarts the watch when it runs again.

use std::collections::hash_map::Entry;
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
    /// uid → (its entry in `upsert_order`, object)
    upserts: HashMap<String, (usize, SharedKubeObject)>,
    /// Staging order. A delete leaves its entry behind (a key re-added
    /// later gets a new one), so an entry counts only while its key's
    /// upsert points at it; stale entries are compacted away.
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

    /// An update keeps the key's place in the order; a (re)added key goes
    /// last.
    fn stage_upsert(&mut self, key: String, value: SharedKubeObject) {
        if !self.deletes.is_empty() {
            self.deletes.remove(&key);
        }
        match self.upserts.entry(key) {
            Entry::Occupied(mut staged) => staged.get_mut().1 = value,
            Entry::Vacant(slot) => {
                self.upsert_order.push(slot.key().clone());
                slot.insert((self.upsert_order.len() - 1, value));
            }
        }
        self.pending += 1;
    }

    /// O(1) amortised: the key's order entry goes stale instead of being
    /// searched for (a watch blocked on acks may stage a whole store).
    fn stage_delete(&mut self, key: String) {
        if self.upserts.remove(&key).is_some() {
            self.compact_order();
        }
        self.deletes.insert(key);
        self.pending += 1;
    }

    /// Drops stale order entries once they are the majority, so repeated
    /// delete and re-add cycles cannot grow the order without bound.
    fn compact_order(&mut self) {
        if self.upsert_order.len() <= 2 * self.upserts.len() {
            return;
        }
        let order = std::mem::take(&mut self.upsert_order);
        for (index, key) in order.into_iter().enumerate() {
            if let Some(staged) = self.upserts.get_mut(&key) {
                if staged.0 == index {
                    staged.0 = self.upsert_order.len();
                    self.upsert_order.push(key);
                }
            }
        }
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
    ///
    /// An object that does not serialise to a JSON object (`to_kube_object`
    /// yields `null`) is skipped and logged: the UI could not apply it, and
    /// one bad object must not fail every batch it lands in. An update of
    /// an object already listed keeps its previous version.
    pub fn on_event(&mut self, source: usize, event: Event<DynamicObject>, ar: &ApiResource) {
        match event {
            Event::Init => self.on_init(source),
            Event::InitApply(obj) => {
                let key = object_key(&obj);
                if let Some(value) = serialisable(to_kube_object(obj, ar), &key, ar) {
                    self.on_init_apply(source, key, value);
                }
            }
            Event::InitDone => self.on_init_done(source),
            Event::Apply(obj) => {
                let key = object_key(&obj);
                match serialisable(to_kube_object(obj, ar), &key, ar) {
                    Some(value) => self.on_apply(source, key, value),
                    // The source still delivered an event.
                    None => self.on_healthy(source),
                }
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
                seq: 0,
                stopped: false,
            });
        }
        let order = std::mem::take(&mut self.upsert_order);
        let mut upserts_map = std::mem::take(&mut self.upserts);
        let upserts = order
            .into_iter()
            .enumerate()
            .filter_map(|(index, key)| match upserts_map.entry(key) {
                Entry::Occupied(staged) if staged.get().0 == index => Some(staged.remove().1),
                _ => None,
            })
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
            seq: 0,
            stopped: false,
        })
    }
}

/// `value` when it is a JSON object (every object the UI can apply); else
/// logs and drops it.
fn serialisable(value: Value, key: &str, ar: &ApiResource) -> Option<Value> {
    if value.is_object() {
        return Some(value);
    }
    tracing::warn!(
        "watch {}: skipping {key}, which does not serialise to an object",
        ar.plural
    );
    None
}

/// Batches a watch may have sent and not had acknowledged yet. While the
/// window is full, the watch keeps folding events (latest wins) and sends
/// nothing, so a slow or dead webview bounds its IPC queue.
pub const MAX_UNACKED: u64 = 4;
/// A watch whose sent batches get no acknowledgement for this long stops:
/// its webview is gone (or frozen; the final `stopped` batch tells it to
/// start over once it runs again).
pub const ACK_TIMEOUT: Duration = Duration::from_secs(60);

/// Flow control of one watch: batches are numbered from 1 (`WatchBatch.seq`)
/// and an acknowledgement of `seq` covers every batch up to it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AckWindow {
    sent: u64,
    acked: u64,
}

impl AckWindow {
    pub fn can_send(&self) -> bool {
        self.unacked() < MAX_UNACKED
    }

    /// Records a sent batch; returns its `seq`.
    pub fn on_sent(&mut self) -> u64 {
        self.sent += 1;
        self.sent
    }

    /// Acknowledges every batch up to `seq`. Stale or duplicate acks change
    /// nothing, and an ack beyond the last sent batch counts up to it only.
    pub fn on_ack(&mut self, seq: u64) {
        self.acked = self.acked.max(seq.min(self.sent));
    }

    pub fn unacked(&self) -> u64 {
        self.sent - self.acked
    }
}

type AckSenders = Arc<parking_lot::Mutex<HashMap<String, tokio::sync::watch::Sender<u64>>>>;

/// Acknowledgement channels of the running watches, by watch id
/// ([`Kubepit::resource_watch_ack`] → the watch's task).
#[derive(Clone, Default)]
pub(crate) struct WatchAcks(AckSenders);

impl WatchAcks {
    /// Registers `watch_id`; dropping the registration unregisters it.
    fn register(&self, watch_id: &str) -> AckRegistration {
        let (tx, rx) = tokio::sync::watch::channel(0);
        self.0.lock().insert(watch_id.to_string(), tx);
        AckRegistration {
            rx,
            _unregister: Unregister {
                senders: self.0.clone(),
                watch_id: watch_id.to_string(),
            },
        }
    }

    /// Forwards an acknowledgement of `seq`; unknown ids are ignored.
    fn ack(&self, watch_id: &str, seq: u64) {
        if let Some(tx) = self.0.lock().get(watch_id) {
            tx.send_if_modified(|acked| {
                let newer = seq > *acked;
                if newer {
                    *acked = seq;
                }
                newer
            });
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.lock().len()
    }
}

struct AckRegistration {
    rx: tokio::sync::watch::Receiver<u64>,
    _unregister: Unregister,
}

struct Unregister {
    senders: AckSenders,
    watch_id: String,
}

impl Drop for Unregister {
    fn drop(&mut self) {
        self.senders.lock().remove(&self.watch_id);
    }
}

/// Watcher events of every source, tagged with the source index.
type SourceEvent = (
    usize,
    std::result::Result<Event<DynamicObject>, watcher::Error>,
);

/// Drive the merged watcher streams until the sink rejects a batch or the
/// webview stops acknowledging them.
async fn run_watch<F>(
    watch_id: String,
    ar: ApiResource,
    apis: Vec<kube::Api<DynamicObject>>,
    sink: F,
    acks: AckRegistration,
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
    let merged = futures::stream::select_all(streams);
    // `acks` stays registered until this future ends or is dropped (abort).
    let AckRegistration {
        rx,
        _unregister: _registered,
    } = acks;
    drive(watch_id, sources, merged, &ar, sink, rx).await;
}

/// What [`flush`] did.
#[derive(Debug, PartialEq, Eq)]
enum Flush {
    /// Sent a batch, or there was nothing to send.
    Done,
    /// The ack window is full: nothing was taken.
    Blocked,
    /// The sink refused the batch: the webview is gone.
    Refused,
}

/// Send the pending batch when the ack window allows it.
fn flush<F: Fn(WatchBatch) -> bool>(
    agg: &mut WatchAggregator,
    window: &mut AckWindow,
    ack_deadline: std::pin::Pin<&mut tokio::time::Sleep>,
    sink: &F,
) -> Flush {
    if !window.can_send() {
        return Flush::Blocked;
    }
    let Some(mut batch) = agg.take_batch() else {
        return Flush::Done;
    };
    if window.unacked() == 0 {
        ack_deadline.reset(tokio::time::Instant::now() + ACK_TIMEOUT);
    }
    batch.seq = window.on_sent();
    if sink(batch) {
        Flush::Done
    } else {
        Flush::Refused
    }
}

/// The watch loop: fold `events`, flush every [`FLUSH_INTERVAL`] or at
/// [`FLUSH_MAX_OBJECTS`] pending changes while the ack window allows it
/// (a flush that fell due while it was full goes out with the ack that
/// frees it), and stop once sent batches get no ack for [`ACK_TIMEOUT`].
async fn drive<S, F>(
    watch_id: String,
    sources: usize,
    mut events: S,
    ar: &ApiResource,
    sink: F,
    mut acks: tokio::sync::watch::Receiver<u64>,
) where
    S: futures::Stream<Item = SourceEvent> + Unpin,
    F: Fn(WatchBatch) -> bool,
{
    let mut agg = WatchAggregator::new(watch_id.clone(), sources);
    let mut window = AckWindow::default();
    // First flush one interval in, so the initial batch already carries the
    // first page of objects instead of an empty reset.
    let mut ticker =
        tokio::time::interval_at(tokio::time::Instant::now() + FLUSH_INTERVAL, FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Armed (reset) by the first unacknowledged batch and by every ack that
    // makes progress; only polled while something is unacknowledged.
    let ack_deadline = tokio::time::sleep(ACK_TIMEOUT);
    tokio::pin!(ack_deadline);
    let mut acks_open = true;
    let mut flush_due = false;

    loop {
        tokio::select! {
            item = events.next() => {
                match item {
                    Some((index, Ok(event))) => agg.on_event(index, event, ar),
                    Some((index, Err(err))) => {
                        let message = watcher_error_message(&err);
                        tracing::debug!("watch {} source {index}: {message}", ar.plural);
                        agg.on_error(index, message);
                    }
                    None => {
                        flush(&mut agg, &mut window, ack_deadline.as_mut(), &sink);
                        return;
                    }
                }
                if agg.pending() >= FLUSH_MAX_OBJECTS {
                    match flush(&mut agg, &mut window, ack_deadline.as_mut(), &sink) {
                        Flush::Done => {}
                        Flush::Blocked => flush_due = true,
                        Flush::Refused => return,
                    }
                }
            }
            _ = ticker.tick() => {
                match flush(&mut agg, &mut window, ack_deadline.as_mut(), &sink) {
                    Flush::Done => {}
                    Flush::Blocked => flush_due = true,
                    Flush::Refused => return,
                }
            }
            changed = acks.changed(), if acks_open => {
                if changed.is_err() {
                    acks_open = false;
                    continue;
                }
                let unacked = window.unacked();
                window.on_ack(*acks.borrow_and_update());
                if window.unacked() < unacked {
                    ack_deadline.as_mut().reset(tokio::time::Instant::now() + ACK_TIMEOUT);
                }
                if flush_due && window.can_send() {
                    flush_due = false;
                    if flush(&mut agg, &mut window, ack_deadline.as_mut(), &sink) == Flush::Refused {
                        return;
                    }
                }
            }
            () = &mut ack_deadline, if window.unacked() > 0 => {
                tracing::debug!(
                    "watch {} ({}): no acknowledgement for {}s, stopping",
                    ar.plural,
                    watch_id,
                    ACK_TIMEOUT.as_secs()
                );
                sink(WatchBatch {
                    watch_id,
                    reset: false,
                    upserts: Vec::new(),
                    deletes: Vec::new(),
                    synced: agg.synced(),
                    error: None,
                    recovered: false,
                    seq: window.on_sent(),
                    stopped: true,
                });
                return;
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
        // Registered before the task starts, so no ack can arrive too early.
        let acks = self.watch_acks.register(&watch_id);
        self.watches.spawn(
            &watch_id,
            cluster_id,
            run_watch(watch_id.clone(), ar, apis, sink, acks),
        );
        Ok(watch_id)
    }

    /// `resource_unwatch`. Unknown ids are ignored (the watch may already
    /// have ended because its webview went away).
    pub fn resource_unwatch(&self, watch_id: &str) {
        self.watches.stop(watch_id);
    }

    /// Whether watch `watch_id` still runs. A watch also ends on its own:
    /// its sink refused a batch, it went [`ACK_TIMEOUT`] without an ack, or
    /// its cluster disconnected.
    pub fn resource_watch_running(&self, watch_id: &str) -> bool {
        self.watches.contains(watch_id)
    }

    /// `resource_watch_ack`: the webview applied every batch of `watch_id`
    /// up to `seq`. At most [`MAX_UNACKED`] batches are ever in flight; a
    /// watch that gets no ack for [`ACK_TIMEOUT`] stops. Unknown ids (an
    /// ended watch) are ignored.
    pub fn resource_watch_ack(&self, watch_id: &str, seq: u64) {
        self.watch_acks.ack(watch_id, seq);
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

    fn upsert_uids(batch: &WatchBatch) -> Vec<String> {
        batch
            .upserts
            .iter()
            .map(|o| o["metadata"]["uid"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn updates_keep_their_place_and_re_added_keys_go_last() {
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        agg.on_init_done(0);
        agg.take_batch();
        for uid in ["a", "b", "c"] {
            agg.on_apply(0, uid.into(), obj(uid, 1));
        }
        agg.on_apply(0, "a".into(), obj("a", 2));
        agg.on_delete(0, "b".into());
        agg.on_apply(0, "b".into(), obj("b", 2));
        let batch = agg.take_batch().unwrap();
        assert_eq!(upsert_uids(&batch), ["a", "c", "b"]);
        assert!(batch.deletes.is_empty(), "the re-add cancels the delete");
        assert_eq!(batch.upserts[0]["metadata"]["resourceVersion"], "2");
    }

    /// A watch blocked on acks stages everything: deleting every staged
    /// object must stay linear (it used to search the order per delete).
    #[test]
    fn deleting_a_whole_staged_store_stays_linear() {
        const N: usize = 20_000;
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        agg.on_init_done(0);
        agg.take_batch();
        let bounded = |agg: &WatchAggregator| agg.upsert_order.len() <= 2 * agg.upserts.len() + 1;
        for i in 0..N {
            agg.on_apply(0, format!("u{i}"), obj("x", 1));
        }
        let started = std::time::Instant::now();
        for i in 0..N {
            agg.on_delete(0, format!("u{i}"));
            assert!(bounded(&agg), "stale entries are compacted");
        }
        let elapsed = started.elapsed();
        let batch = agg.take_batch().unwrap();
        assert!(batch.upserts.is_empty());
        assert_eq!(batch.deletes.len(), N);
        // Quadratic took ~0.3 s optimised; linear takes a few ms, even
        // unoptimised this stays far below the bound.
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");

        // Delete and re-add cycles cannot grow the order either.
        for i in 0..100 {
            agg.on_apply(0, format!("k{i}"), obj("x", 1));
        }
        for round in 0..10_000 {
            let key = format!("k{}", round % 100);
            agg.on_delete(0, key.clone());
            agg.on_apply(0, key, obj("x", 2));
            assert!(bounded(&agg));
        }
        let batch = agg.take_batch().unwrap();
        assert_eq!(batch.upserts.len(), 100);
        assert!(batch.deletes.is_empty());
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

    #[test]
    fn objects_that_do_not_serialise_are_skipped() {
        let ar = pods_ar();
        let broken = |uid: &str| {
            let mut obj = pod(0, 1);
            obj.metadata.uid = Some(uid.into());
            // Flattened non-object data cannot serialise: `null` for the UI.
            obj.data = json!("not an object");
            assert_eq!(to_kube_object(obj.clone(), &ar), Value::Null);
            obj
        };
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_event(0, Event::Init, &ar);
        agg.on_event(0, Event::InitApply(pod(1, 1)), &ar);
        agg.on_event(0, Event::InitApply(broken("bad")), &ar);
        agg.on_event(0, Event::InitDone, &ar);
        let batch = agg.take_batch().unwrap();
        assert_eq!(upsert_uids(&batch), ["u00001"]);
        assert!(batch.upserts.iter().all(|o| o.is_object()));

        // A broken update keeps the listed version, and still proves the
        // source healthy.
        agg.on_error(0, "connection reset".into());
        agg.take_batch();
        agg.on_event(0, Event::Apply(broken("u00001")), &ar);
        let batch = agg.take_batch().unwrap();
        assert!(batch.recovered && batch.upserts.is_empty());
        assert_eq!(agg.store["u00001"].1["metadata"]["resourceVersion"], "1");
        assert!(!agg.store.contains_key("bad"));
    }

    #[test]
    fn ack_window_blocks_after_four_unacked() {
        let mut window = AckWindow::default();
        assert!(window.can_send());
        let seqs: Vec<u64> = (0..4).map(|_| window.on_sent()).collect();
        assert_eq!(seqs, [1, 2, 3, 4]);
        assert!(!window.can_send());
        window.on_ack(2);
        assert!(window.can_send());
        assert_eq!(window.unacked(), 2);
        // Stale, duplicate and future acks.
        window.on_ack(1);
        assert_eq!(window.unacked(), 2);
        window.on_ack(99);
        assert_eq!(window.unacked(), 0);
        assert_eq!(window.on_sent(), 5);
    }

    #[test]
    fn ack_registry_forwards_the_newest_seq_while_the_watch_runs() {
        let acks = WatchAcks::default();
        let mut registration = acks.register("w");
        assert_eq!(acks.len(), 1);
        acks.ack("w", 3);
        acks.ack("w", 2);
        acks.ack("unknown", 9);
        assert!(registration.rx.has_changed().unwrap());
        assert_eq!(*registration.rx.borrow_and_update(), 3);
        drop(registration);
        assert_eq!(acks.len(), 0, "an ended watch unregisters");
        acks.ack("w", 4);
    }

    fn pods_ar() -> ApiResource {
        api_resource(&Gvk {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            plural: "pods".into(),
            namespaced: true,
        })
    }

    fn pod(i: usize, rv: u32) -> DynamicObject {
        serde_json::from_value(json!({
            "metadata": {"name": format!("p{i}"), "namespace": "ns",
                         "uid": format!("u{i:05}"), "resourceVersion": rv.to_string()}
        }))
        .unwrap()
    }

    /// An initial list of `pods` pods, then `rounds` MODIFIED events for
    /// each of the first `modified`, then an open stream with no events.
    fn burst(
        pods: usize,
        modified: usize,
        rounds: u32,
    ) -> impl futures::Stream<Item = SourceEvent> {
        let mut events = vec![Event::Init];
        events.extend((0..pods).map(|i| Event::InitApply(pod(i, 1))));
        events.push(Event::InitDone);
        for round in 0..rounds {
            events.extend((0..modified).map(|i| Event::Apply(pod(i, 2 + round))));
        }
        futures::stream::iter(events.into_iter().map(|e| (0, Ok(e))))
            .chain(futures::stream::pending())
    }

    type Received = Arc<parking_lot::Mutex<Vec<(tokio::time::Instant, WatchBatch)>>>;

    /// `drive` on its own task with a sink that records every batch.
    fn spawn_drive(
        events: impl futures::Stream<Item = SourceEvent> + Send + Unpin + 'static,
        acks: tokio::sync::watch::Receiver<u64>,
    ) -> (tokio::task::JoinHandle<()>, Received) {
        let received = Received::default();
        let sink = {
            let received = received.clone();
            move |batch: WatchBatch| {
                received.lock().push((tokio::time::Instant::now(), batch));
                true
            }
        };
        let task = tokio::spawn(async move {
            drive("w".into(), 1, events, &pods_ar(), sink, acks).await;
        });
        (task, received)
    }

    #[tokio::test(start_paused = true)]
    async fn unacked_watch_coalesces_and_stops_after_timeout() {
        let (_ack_tx, ack_rx) = tokio::sync::watch::channel(0);
        let started = tokio::time::Instant::now();
        // 2 000 pods listed, then 2 000 more events: 2 000 Apply of 1 000 pods.
        let (task, received) = spawn_drive(Box::pin(burst(2_000, 1_000, 2)), ack_rx);
        tokio::time::sleep(ACK_TIMEOUT - Duration::from_secs(1)).await;
        {
            let batches = received.lock();
            let seqs: Vec<u64> = batches.iter().map(|(_, b)| b.seq).collect();
            assert_eq!(seqs, [1, 2, 3, 4], "no batch beyond the window");
            assert!(batches[0].1.reset);
            assert_eq!(
                batches.iter().map(|(_, b)| b.upserts.len()).sum::<usize>(),
                2_000
            );
            assert!(batches.iter().all(|(_, b)| !b.stopped));
        }
        assert!(!task.is_finished(), "still waiting for an ack");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(
            task.is_finished(),
            "stopped after ACK_TIMEOUT without an ack"
        );
        let batches = received.lock();
        assert_eq!(batches.len(), 5);
        let (at, last) = &batches[4];
        assert!(last.stopped && last.upserts.is_empty() && last.deletes.is_empty());
        assert_eq!(last.seq, 5);
        assert_about(*at - started, ACK_TIMEOUT);
    }

    /// Equal up to the timer's millisecond resolution.
    fn assert_about(actual: Duration, expected: Duration) {
        assert!(
            actual >= expected && actual <= expected + Duration::from_millis(2),
            "{actual:?}, expected {expected:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_ack_releases_one_coalesced_latest_wins_batch() {
        let (ack_tx, ack_rx) = tokio::sync::watch::channel(0);
        let (task, received) = spawn_drive(Box::pin(burst(2_000, 1_000, 2)), ack_rx);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(received.lock().len(), 4);
        ack_tx.send(4).unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
        {
            let batches = received.lock();
            assert_eq!(batches.len(), 5, "the due flush goes out with the ack");
            let batch = &batches[4].1;
            assert_eq!(batch.seq, 5);
            assert!(batch.synced && !batch.reset);
            // 2 000 events for 1 000 pods fold into one upsert each, the last.
            assert_eq!(batch.upserts.len(), 1_000);
            assert!(batch
                .upserts
                .iter()
                .all(|o| o["metadata"]["resourceVersion"] == "3"));
        }
        // Acked in time, the watch keeps running past the first timeout.
        ack_tx.send(5).unwrap();
        tokio::time::sleep(ACK_TIMEOUT * 2).await;
        assert!(!task.is_finished());
        assert_eq!(received.lock().len(), 5, "an idle watch sends nothing");
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn every_ack_that_makes_progress_restarts_the_timeout() {
        let (ack_tx, ack_rx) = tokio::sync::watch::channel(0);
        let started = tokio::time::Instant::now();
        let (task, received) = spawn_drive(Box::pin(burst(2_000, 1_000, 2)), ack_rx);
        tokio::time::sleep(Duration::from_secs(50)).await;
        // One ack: the due batch goes out and the window is full again.
        ack_tx.send(1).unwrap();
        tokio::time::sleep(Duration::from_secs(55)).await;
        assert!(!task.is_finished(), "105 s in, 55 s after the last ack");
        assert_eq!(received.lock().len(), 5);
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert!(task.is_finished());
        let batches = received.lock();
        let (at, last) = batches.last().unwrap();
        assert!(last.stopped);
        assert_about(*at - started, Duration::from_secs(50) + ACK_TIMEOUT);
    }
}
