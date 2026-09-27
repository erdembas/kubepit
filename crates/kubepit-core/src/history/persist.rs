//! Persistent events and changes of one cluster (opt-in per cluster, and
//! per process like the change journal): while the cluster is connected,
//!
//! - a `kube::runtime` watcher on core/v1 Events (cluster-wide, falling back
//!   to the cluster's `accessible_namespaces` when that is forbidden) upserts
//!   every Event by uid, batched once a second, so they outlive Kubernetes'
//!   one-hour event TTL — deletions are ignored on purpose;
//! - a poller copies new change-journal entries (already normalized and
//!   redacted by the journal) every few seconds. A journal restart (new
//!   connection) is detected by its start time.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use kube::api::{ApiResource, DynamicObject};
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use kube::Client;
use parking_lot::Mutex;
use tokio::task::JoinSet;

use super::db::{ChangeRow, EventRow};
use super::writer::{WriteOp, Writer};
use crate::change_journal::JournalReader;
use crate::error::{watcher_error_code, watcher_error_message};
use crate::objects::{dynamic_api, to_kube_object};

/// How often buffered Events are written.
const EVENT_FLUSH: Duration = Duration::from_secs(1);
/// Buffered Events beyond this are dropped until the next flush.
const EVENT_BUFFER: usize = 20_000;
/// How often the change journal is polled for new entries.
pub const JOURNAL_POLL: Duration = Duration::from_secs(3);
/// Entries copied per poll.
const JOURNAL_BATCH: usize = 500;

pub struct Persist {
    pub cluster_id: String,
    pub client: Client,
    pub writer: Arc<Writer>,
    pub journal: JournalReader,
    pub fallback_namespaces: Vec<String>,
}

fn events_resource() -> ApiResource {
    ApiResource {
        group: String::new(),
        version: "v1".into(),
        api_version: "v1".into(),
        kind: "Event".into(),
        plural: "events".into(),
    }
}

/// Both halves until the task is aborted (disconnect, opt-out, shutdown).
pub async fn run(persist: Arc<Persist>) {
    tokio::join!(run_events(persist.clone()), run_journal(persist));
}

type Buffer = Arc<Mutex<Vec<EventRow>>>;

/// One Events watcher; returns the HTTP status when its first list was
/// forbidden or not served (never retried), else runs until aborted.
async fn watch_events(
    persist: Arc<Persist>,
    namespace: Option<String>,
    buffer: Buffer,
) -> (Option<String>, Option<u16>) {
    let ar = events_resource();
    let api = dynamic_api(persist.client.clone(), &ar, true, namespace.as_deref());
    let mut stream = watcher::watcher(api, watcher::Config::default().any_semantic())
        .default_backoff()
        .boxed();
    let mut synced = false;
    while let Some(item) = stream.next().await {
        match item {
            Ok(Event::InitApply(obj)) | Ok(Event::Apply(obj)) => {
                if let Some(row) = event_row(&persist.cluster_id, obj, &ar) {
                    let mut buffer = buffer.lock();
                    if buffer.len() < EVENT_BUFFER {
                        buffer.push(row);
                    }
                }
            }
            Ok(Event::InitDone) => synced = true,
            Ok(Event::Init) | Ok(Event::Delete(_)) => {}
            Err(err) => {
                let code = watcher_error_code(&err);
                if !synced && matches!(code, Some(403..=405)) {
                    return (namespace, code);
                }
                tracing::debug!(
                    cluster = %persist.cluster_id,
                    "history events watch: {}",
                    watcher_error_message(&err)
                );
            }
        }
    }
    (namespace, None)
}

fn event_row(cluster_id: &str, obj: DynamicObject, ar: &ApiResource) -> Option<EventRow> {
    let value = to_kube_object(obj, ar);
    EventRow::from_event(cluster_id, &value)
}

fn flush_events(persist: &Persist, buffer: &Buffer) {
    let rows = std::mem::take(&mut *buffer.lock());
    if !rows.is_empty() {
        persist.writer.submit(WriteOp::Events(rows));
    }
}

async fn run_events(persist: Arc<Persist>) {
    let buffer: Buffer = Arc::default();
    let mut watchers = JoinSet::new();
    watchers.spawn(watch_events(persist.clone(), None, buffer.clone()));
    let mut tick = tokio::time::interval(EVENT_FLUSH);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => flush_events(&persist, &buffer),
            joined = watchers.join_next(), if !watchers.is_empty() => {
                if let Some(Ok((None, Some(403)))) = joined {
                    for ns in &persist.fallback_namespaces {
                        watchers.spawn(watch_events(persist.clone(), Some(ns.clone()), buffer.clone()));
                    }
                }
            }
        }
    }
}

async fn run_journal(persist: Arc<Persist>) {
    let mut journal_started: Option<i64> = None;
    let mut last_id = 0u64;
    let mut tick = tokio::time::interval(JOURNAL_POLL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        while let Some((started, details)) =
            persist
                .journal
                .details_after(&persist.cluster_id, last_id, JOURNAL_BATCH)
        {
            if journal_started != Some(started) {
                // A new journal (reconnect): its ids start over.
                journal_started = Some(started);
                last_id = 0;
                continue;
            }
            let Some(newest) = details.last().map(|d| d.summary.id) else {
                break;
            };
            let full = details.len() == JOURNAL_BATCH;
            let rows = details
                .into_iter()
                .map(|d| ChangeRow {
                    cluster_id: persist.cluster_id.clone(),
                    journal_started: started,
                    journal_id: d.summary.id as i64,
                    summary: d.summary,
                    before_yaml: d.before_yaml,
                    after_yaml: d.after_yaml,
                    omitted: d.omitted,
                })
                .collect();
            if !persist.writer.submit(WriteOp::Changes(rows)) {
                // Queue full: retry the same entries next time.
                break;
            }
            last_id = newest;
            if !full {
                break;
            }
        }
    }
}
