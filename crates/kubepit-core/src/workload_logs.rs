//! Merged workload logs: every selected container of every pod matching a
//! label selector, in one stream (stern-style).
//!
//! A label-selected pod watcher (`kube::runtime::watcher`) drives a pure
//! [`WorkloadLogPlanner`]: pod snapshots in, stream commands out. The
//! driver starts one follow stream per pod × container instance — capped at
//! [`MAX_SOURCES`], extra sources are reported as `source-skipped` and start
//! as soon as a slot frees up — and feeds their bytes back into the planner,
//! which cuts them into complete lines per source and batches everything
//! into [`WorkloadLogBatch`]es: flushed [`WORKLOAD_FLUSH_INTERVAL`] after the
//! first pending line, or as soon as [`LOG_FLUSH_BYTES`] are pending.
//!
//! Sources follow the pods: new pods (rollout, scale-up) join, deleted pods
//! leave, and a container that restarts (new `containerID`) is re-attached
//! with the whole log of its new instance. Source streams are child tasks of
//! the stream's own task (a `JoinSet`), so `workload_logs_stop` — or a
//! cluster disconnect through the task registry — ends all of them.
//!
//! Ordering guarantees (what the UI relies on):
//! - batches arrive in order and the last one has `done: true`;
//! - per source, `source-added` precedes its lines, its lines keep log
//!   order, and `source-ended` / `source-removed` follow its last line;
//! - within one batch, lines of different sources are ordered by their
//!   kubelet timestamp (always requested, stripped unless
//!   `options.timestamps`), so the backlogs of several pods interleave by
//!   time; across batches, arrival order wins.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use futures::{AsyncReadExt, StreamExt};
use k8s_openapi::api::core::v1::{Container, ContainerStatus, Pod};
use kube::api::{Api, LogParams};
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use tokio::sync::mpsc;
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::Instant;

use crate::app::Kubepit;
use crate::error::{describe_kube_error, watcher_error_code, watcher_error_message};
use crate::logs::{log_params, Utf8Accumulator, LOG_FLUSH_BYTES};
use crate::types::{
    LogOptions, WorkloadLogBatch, WorkloadLogEvent, WorkloadLogEventKind, WorkloadLogOptions,
};

/// Flush pending lines this long after the first one arrived.
pub const WORKLOAD_FLUSH_INTERVAL: Duration = Duration::from_millis(100);
/// Concurrent container log streams per workload stream.
pub const MAX_SOURCES: usize = 64;
/// A "line" without a newline is cut after this many bytes.
const MAX_LINE_BYTES: usize = 64 * 1024;
const READ_BUF: usize = 16 * 1024;
/// Chunks in flight from source tasks to the planner (backpressure).
const SOURCE_CHANNEL: usize = 256;

/// One container of one pod.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SourceKey {
    pub pod: String,
    pub container: String,
}

/// A selected container of a pod, as the planner sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerView {
    pub name: String,
    /// Identity of the current (or last) container instance; `None` while
    /// the container never ran (pulling, creating), so there are no logs.
    pub instance: Option<String>,
}

fn instance_of(status: &ContainerStatus) -> Option<String> {
    if let Some(id) = status.container_id.as_deref().filter(|id| !id.is_empty()) {
        return Some(id.to_string());
    }
    let state = status.state.as_ref()?;
    // Some runtimes report state before the ID; the restart count still
    // tells instances apart.
    (state.running.is_some() || state.terminated.is_some())
        .then(|| format!("#{}", status.restart_count))
}

/// The containers of `pod` selected by `options`, init containers first.
pub fn container_views(pod: &Pod, options: &WorkloadLogOptions) -> Vec<ContainerView> {
    let (Some(spec), status) = (pod.spec.as_ref(), pod.status.as_ref()) else {
        return Vec::new();
    };
    let views = |containers: &[Container], statuses: Option<&Vec<ContainerStatus>>| {
        containers
            .iter()
            .map(|c| ContainerView {
                name: c.name.clone(),
                instance: statuses
                    .and_then(|all| all.iter().find(|s| s.name == c.name))
                    .and_then(instance_of),
            })
            .collect::<Vec<_>>()
    };
    let mut out = Vec::new();
    if options.init_containers {
        if let Some(init) = spec.init_containers.as_deref() {
            out.extend(views(
                init,
                status.and_then(|s| s.init_container_statuses.as_ref()),
            ));
        }
    }
    out.extend(views(
        &spec.containers,
        status.and_then(|s| s.container_statuses.as_ref()),
    ));
    if !options.containers.is_empty() {
        out.retain(|v| options.containers.contains(&v.name));
    }
    out
}

/// Which part of a container's log a new stream starts with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backlog {
    /// First attach: the user's tail / since options.
    Requested,
    /// A new instance after a restart: its whole (short) log.
    Full,
}

/// What the driver must do after a planner update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceCommand {
    Start {
        pod: String,
        container: String,
        generation: u64,
        backlog: Backlog,
    },
    Stop {
        generation: u64,
    },
}

/// Log parameters for one source stream. Timestamps are always requested:
/// the planner orders lines by them and strips them when not wanted.
pub fn source_log_params(
    container: &str,
    options: &WorkloadLogOptions,
    backlog: Backlog,
) -> LogParams {
    let requested = backlog == Backlog::Requested;
    log_params(
        Some(container.to_string()),
        &LogOptions {
            follow: true,
            tail_lines: options.tail_lines.filter(|_| requested),
            since_seconds: options.since_seconds.filter(|_| requested),
            timestamps: true,
            previous: false,
        },
    )
}

fn parse_timestamp(text: &str) -> Option<i64> {
    if text.len() < 20 || !text.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()?
        .timestamp_nanos_opt()
}

/// `2024-05-01T10:00:00.123456789Z message` → (nanoseconds, `message`).
/// Lines without a leading RFC 3339 timestamp come back unchanged.
pub fn split_timestamp(line: &str) -> (Option<i64>, &str) {
    let (head, rest) = line.split_once(' ').unwrap_or((line, ""));
    match parse_timestamp(head) {
        Some(ts) => (Some(ts), rest),
        None => (None, line),
    }
}

struct Source {
    key: Arc<SourceKey>,
    /// Instance of the running or last stream.
    instance: Option<String>,
    /// Generation of the running stream.
    running: Option<u64>,
    announced: bool,
    skipped: bool,
    acc: Utf8Accumulator,
    carry: String,
    /// Timestamp of the last line, used for lines that carry none.
    last_ts: i64,
}

impl Source {
    fn new(key: SourceKey) -> Self {
        Self {
            key: Arc::new(key),
            instance: None,
            running: None,
            announced: false,
            skipped: false,
            acc: Utf8Accumulator::default(),
            carry: String::new(),
            last_ts: 0,
        }
    }
}

enum Pending {
    Line {
        ts: i64,
        key: Arc<SourceKey>,
        text: String,
    },
    Event(WorkloadLogEvent),
}

/// Pending output shared by the planner's helpers (split borrows).
#[derive(Default)]
struct Outbox {
    items: Vec<Pending>,
    bytes: usize,
}

impl Outbox {
    fn event(&mut self, kind: WorkloadLogEventKind, key: &SourceKey, message: Option<String>) {
        self.items.push(Pending::Event(WorkloadLogEvent {
            kind,
            pod: key.pod.clone(),
            container: key.container.clone(),
            lines: Vec::new(),
            message,
        }));
    }

    fn line(&mut self, source: &mut Source, raw: &str, keep_timestamps: bool) {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let (ts, body) = split_timestamp(raw);
        let ts = match ts {
            Some(ts) => {
                source.last_ts = ts;
                ts
            }
            None => source.last_ts,
        };
        let text = if keep_timestamps { raw } else { body }.to_string();
        self.bytes += text.len() + 1;
        self.items.push(Pending::Line {
            ts,
            key: source.key.clone(),
            text,
        });
    }

    /// Split newly decoded text into complete lines; the tail waits.
    fn text(&mut self, source: &mut Source, text: &str, keep_timestamps: bool) {
        if text.is_empty() {
            return;
        }
        let mut carry = std::mem::take(&mut source.carry);
        carry.push_str(text);
        let mut rest = carry.as_str();
        while let Some(pos) = rest.find('\n') {
            self.line(source, &rest[..pos], keep_timestamps);
            rest = &rest[pos + 1..];
        }
        let mut rest = rest.to_string();
        while rest.len() > MAX_LINE_BYTES {
            let mut cut = MAX_LINE_BYTES;
            while !rest.is_char_boundary(cut) {
                cut -= 1;
            }
            let tail = rest.split_off(cut);
            self.line(source, &rest, keep_timestamps);
            rest = tail;
        }
        source.carry = rest;
    }

    /// End of a stream: emit whatever partial line is left.
    fn flush_source(&mut self, source: &mut Source, keep_timestamps: bool) {
        let tail = source.acc.take_all();
        self.text(source, &tail, keep_timestamps);
        let carry = std::mem::take(&mut source.carry);
        if !carry.is_empty() {
            self.line(source, &carry, keep_timestamps);
        }
    }
}

/// Pure bookkeeping of a workload log stream: pod events and source bytes
/// in, stream commands and batches out. No I/O, fully testable.
pub struct WorkloadLogPlanner {
    stream_id: String,
    options: WorkloadLogOptions,
    max_sources: usize,
    /// Pod name → its selected containers.
    pods: BTreeMap<String, Vec<ContainerView>>,
    sources: BTreeMap<SourceKey, Source>,
    /// Running generation → source.
    running: HashMap<u64, SourceKey>,
    next_generation: u64,
    /// Pod names seen during a (re-)list.
    relist: Option<HashSet<String>>,
    synced: bool,
    out: Outbox,
    last_warning: Option<String>,
}

impl WorkloadLogPlanner {
    pub fn new(
        stream_id: impl Into<String>,
        options: WorkloadLogOptions,
        max_sources: usize,
    ) -> Self {
        Self {
            stream_id: stream_id.into(),
            options,
            max_sources: max_sources.max(1),
            pods: BTreeMap::new(),
            sources: BTreeMap::new(),
            running: HashMap::new(),
            next_generation: 0,
            relist: None,
            synced: false,
            out: Outbox::default(),
            last_warning: None,
        }
    }

    /// The initial pod list has been delivered.
    pub fn synced(&self) -> bool {
        self.synced
    }

    pub fn pending_bytes(&self) -> usize {
        self.out.bytes
    }

    pub fn has_pending(&self) -> bool {
        !self.out.items.is_empty()
    }

    /// Streams currently running.
    pub fn active(&self) -> usize {
        self.running.len()
    }

    /// Fold one watcher event.
    pub fn on_event(&mut self, event: Event<Pod>) -> Vec<SourceCommand> {
        match event {
            Event::Init => {
                self.relist = Some(HashSet::new());
                Vec::new()
            }
            Event::InitApply(pod) => {
                if let (Some(seen), Some(name)) = (self.relist.as_mut(), &pod.metadata.name) {
                    seen.insert(name.clone());
                }
                self.apply_pod(&pod)
            }
            Event::InitDone => {
                self.synced = true;
                let seen = self.relist.take().unwrap_or_default();
                let gone: Vec<String> = self
                    .pods
                    .keys()
                    .filter(|name| !seen.contains(*name))
                    .cloned()
                    .collect();
                let mut commands = Vec::new();
                for name in gone {
                    commands.extend(self.delete_pod(&name));
                }
                commands
            }
            Event::Apply(pod) => self.apply_pod(&pod),
            Event::Delete(pod) => match pod.metadata.name.as_deref() {
                Some(name) => self.delete_pod(name),
                None => Vec::new(),
            },
        }
    }

    /// A pod was added or changed.
    pub fn apply_pod(&mut self, pod: &Pod) -> Vec<SourceCommand> {
        let Some(name) = pod.metadata.name.clone() else {
            return Vec::new();
        };
        self.pods.insert(name, container_views(pod, &self.options));
        self.reconcile()
    }

    /// A pod is gone: stop its streams and report its sources removed.
    pub fn delete_pod(&mut self, name: &str) -> Vec<SourceCommand> {
        self.pods.remove(name);
        let keys: Vec<SourceKey> = self
            .sources
            .keys()
            .filter(|k| k.pod == name)
            .cloned()
            .collect();
        let keep = self.options.timestamps;
        let mut commands = Vec::new();
        for key in keys {
            let Some(mut source) = self.sources.remove(&key) else {
                continue;
            };
            if let Some(generation) = source.running.take() {
                self.running.remove(&generation);
                commands.push(SourceCommand::Stop { generation });
                self.out.flush_source(&mut source, keep);
            }
            if source.announced || source.skipped {
                self.out
                    .event(WorkloadLogEventKind::SourceRemoved, &key, None);
            }
        }
        commands.extend(self.reconcile());
        commands
    }

    /// Start streams for container instances that have none yet.
    fn reconcile(&mut self) -> Vec<SourceCommand> {
        let Self {
            pods,
            sources,
            running,
            next_generation,
            max_sources,
            out,
            ..
        } = self;
        let mut commands = Vec::new();
        for (pod, views) in pods.iter() {
            for view in views {
                let Some(instance) = view.instance.as_ref() else {
                    continue;
                };
                let key = SourceKey {
                    pod: pod.clone(),
                    container: view.name.clone(),
                };
                let source = sources
                    .entry(key.clone())
                    .or_insert_with(|| Source::new(key.clone()));
                // Streaming already, or this instance was streamed to its end.
                if source.running.is_some() || source.instance.as_ref() == Some(instance) {
                    continue;
                }
                if running.len() >= *max_sources {
                    if !source.skipped {
                        source.skipped = true;
                        out.event(WorkloadLogEventKind::SourceSkipped, &key, None);
                    }
                    continue;
                }
                let backlog = if source.instance.is_some() {
                    Backlog::Full
                } else {
                    Backlog::Requested
                };
                *next_generation += 1;
                let generation = *next_generation;
                source.instance = Some(instance.clone());
                source.running = Some(generation);
                source.skipped = false;
                source.announced = true;
                running.insert(generation, key.clone());
                out.event(WorkloadLogEventKind::SourceAdded, &key, None);
                commands.push(SourceCommand::Start {
                    pod: key.pod,
                    container: key.container,
                    generation,
                    backlog,
                });
            }
        }
        commands
    }

    /// Bytes from the stream `generation` (ignored once it was stopped).
    pub fn on_data(&mut self, generation: u64, bytes: &[u8]) {
        let Some(key) = self.running.get(&generation) else {
            return;
        };
        let Some(source) = self.sources.get_mut(key) else {
            return;
        };
        source.acc.push(bytes);
        let text = source.acc.take_complete();
        self.out.text(source, &text, self.options.timestamps);
    }

    /// The stream `generation` finished (`error` when it failed).
    pub fn on_end(&mut self, generation: u64, error: Option<String>) -> Vec<SourceCommand> {
        let Some(key) = self.running.remove(&generation) else {
            return Vec::new();
        };
        if let Some(source) = self.sources.get_mut(&key) {
            source.running = None;
            self.out.flush_source(source, self.options.timestamps);
            self.out
                .event(WorkloadLogEventKind::SourceEnded, &key, error);
        }
        self.reconcile()
    }

    /// Non-fatal stream problem; repeats of the same text are dropped.
    pub fn warn(&mut self, message: String) {
        if self.last_warning.as_deref() == Some(message.as_str()) {
            return;
        }
        self.last_warning = Some(message.clone());
        let key = SourceKey {
            pod: String::new(),
            container: String::new(),
        };
        self.out
            .event(WorkloadLogEventKind::Warning, &key, Some(message));
    }

    /// The next batch, or `None` when nothing is pending.
    pub fn take_batch(&mut self) -> Option<WorkloadLogBatch> {
        if self.out.items.is_empty() {
            return None;
        }
        Some(self.build_batch(false, None))
    }

    /// The final batch (`done: true`), flushing every partial line.
    pub fn finish(&mut self, error: Option<String>) -> WorkloadLogBatch {
        let keep = self.options.timestamps;
        for source in self.sources.values_mut() {
            if source.running.is_some() {
                self.out.flush_source(source, keep);
            }
        }
        self.build_batch(true, error)
    }

    fn build_batch(&mut self, done: bool, error: Option<String>) -> WorkloadLogBatch {
        let items = std::mem::take(&mut self.out.items);
        self.out.bytes = 0;
        let mut events = Vec::new();
        let mut run: Vec<(i64, Arc<SourceKey>, String)> = Vec::new();
        for item in items {
            match item {
                Pending::Line { ts, key, text } => run.push((ts, key, text)),
                Pending::Event(event) => {
                    push_lines(&mut run, &mut events);
                    events.push(event);
                }
            }
        }
        push_lines(&mut run, &mut events);
        WorkloadLogBatch {
            stream_id: self.stream_id.clone(),
            events,
            done,
            error,
        }
    }
}

/// Order a run of lines by time (stable, so each source keeps its order)
/// and group consecutive lines of one source into a `lines` event.
fn push_lines(run: &mut Vec<(i64, Arc<SourceKey>, String)>, events: &mut Vec<WorkloadLogEvent>) {
    run.sort_by_key(|(ts, _, _)| *ts);
    for (_, key, text) in run.drain(..) {
        match events.last_mut() {
            Some(last)
                if last.kind == WorkloadLogEventKind::Lines
                    && last.pod == key.pod
                    && last.container == key.container =>
            {
                last.lines.push(text);
            }
            _ => events.push(WorkloadLogEvent {
                kind: WorkloadLogEventKind::Lines,
                pod: key.pod.clone(),
                container: key.container.clone(),
                lines: vec![text],
                message: None,
            }),
        }
    }
}

/// Watch failures that retrying cannot fix before the first list arrived
/// (bad selector, no permission, namespace gone).
fn is_fatal_watch_error(code: Option<u16>) -> bool {
    matches!(code, Some(400 | 401 | 403 | 404))
}

enum SourceMsg {
    Data {
        generation: u64,
        bytes: Vec<u8>,
    },
    End {
        generation: u64,
        error: Option<String>,
    },
}

async fn follow_source(
    api: Api<Pod>,
    pod: String,
    params: LogParams,
    generation: u64,
    tx: mpsc::Sender<SourceMsg>,
) {
    let reader = match api.log_stream(&pod, &params).await {
        Ok(reader) => reader,
        Err(e) => {
            let error = Some(describe_kube_error(&e));
            let _ = tx.send(SourceMsg::End { generation, error }).await;
            return;
        }
    };
    let mut reader = Box::pin(reader);
    let mut buf = vec![0u8; READ_BUF];
    loop {
        let msg = match reader.read(&mut buf).await {
            Ok(0) => SourceMsg::End {
                generation,
                error: None,
            },
            Ok(n) => SourceMsg::Data {
                generation,
                bytes: buf[..n].to_vec(),
            },
            Err(e) => SourceMsg::End {
                generation,
                error: Some(format!("log stream failed: {e}")),
            },
        };
        let last = matches!(msg, SourceMsg::End { .. });
        if tx.send(msg).await.is_err() || last {
            return;
        }
    }
}

async fn run_workload_logs<F>(
    stream_id: String,
    api: Api<Pod>,
    selector: String,
    options: WorkloadLogOptions,
    sink: F,
) where
    F: Fn(WorkloadLogBatch) -> bool + Send + Sync + 'static,
{
    let config = watcher::Config::default().labels(&selector).any_semantic();
    let mut pods = watcher::watcher(api.clone(), config)
        .default_backoff()
        .boxed();
    let (tx, mut rx) = mpsc::channel::<SourceMsg>(SOURCE_CHANNEL);
    let mut tasks: JoinSet<()> = JoinSet::new();
    let mut handles: HashMap<u64, AbortHandle> = HashMap::new();
    let mut planner = WorkloadLogPlanner::new(stream_id, options.clone(), MAX_SOURCES);
    let mut deadline: Option<Instant> = None;

    loop {
        let wait = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => futures::future::pending::<()>().await,
            }
        };
        let commands = tokio::select! {
            event = pods.next() => match event {
                Some(Ok(event)) => planner.on_event(event),
                Some(Err(err)) => {
                    let message = watcher_error_message(&err);
                    if !planner.synced() && is_fatal_watch_error(watcher_error_code(&err)) {
                        sink(planner.finish(Some(message)));
                        return;
                    }
                    tracing::debug!("workload logs watch ({selector}): {message}");
                    planner.warn(message);
                    Vec::new()
                }
                None => {
                    sink(planner.finish(None));
                    return;
                }
            },
            Some(msg) = rx.recv() => match msg {
                SourceMsg::Data { generation, bytes } => {
                    planner.on_data(generation, &bytes);
                    Vec::new()
                }
                SourceMsg::End { generation, error } => {
                    handles.remove(&generation);
                    planner.on_end(generation, error)
                }
            },
            Some(_) = tasks.join_next(), if !tasks.is_empty() => Vec::new(),
            _ = wait => {
                deadline = None;
                if let Some(batch) = planner.take_batch() {
                    if !sink(batch) {
                        return;
                    }
                }
                Vec::new()
            }
        };
        for command in commands {
            match command {
                SourceCommand::Start {
                    pod,
                    container,
                    generation,
                    backlog,
                } => {
                    let params = source_log_params(&container, &options, backlog);
                    let task = follow_source(api.clone(), pod, params, generation, tx.clone());
                    handles.insert(generation, tasks.spawn(task));
                }
                SourceCommand::Stop { generation } => {
                    if let Some(handle) = handles.remove(&generation) {
                        handle.abort();
                    }
                }
            }
        }
        if planner.pending_bytes() >= LOG_FLUSH_BYTES {
            deadline = None;
            if let Some(batch) = planner.take_batch() {
                if !sink(batch) {
                    return;
                }
            }
        } else if deadline.is_none() && planner.has_pending() {
            deadline = Some(Instant::now() + WORKLOAD_FLUSH_INTERVAL);
        }
    }
}

impl Kubepit {
    /// `workload_logs_stream`: follow every pod matching `selector` in
    /// `namespace` and return the stream id. Stream failures arrive in the
    /// final batch's `error`.
    pub async fn workload_logs_stream<F>(
        &self,
        cluster_id: &str,
        namespace: &str,
        selector: &str,
        options: WorkloadLogOptions,
        sink: F,
    ) -> Result<String>
    where
        F: Fn(WorkloadLogBatch) -> bool + Send + Sync + 'static,
    {
        let selector = selector.trim();
        if selector.is_empty() {
            bail!("a label selector is required to follow workload logs");
        }
        let client = self.client(cluster_id).await?;
        let api: Api<Pod> = Api::namespaced(client, namespace);
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.log_streams.spawn(
            &stream_id,
            cluster_id,
            run_workload_logs(stream_id.clone(), api, selector.to_string(), options, sink),
        );
        Ok(stream_id)
    }

    /// `workload_logs_stop`. Unknown ids are ignored.
    pub fn workload_logs_stop(&self, stream_id: &str) {
        self.log_streams.stop(stream_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const T0: &str = "2024-05-01T10:00:00.000000001Z";
    const T1: &str = "2024-05-01T10:00:00.5Z";
    const T2: &str = "2024-05-01T10:00:01Z";

    fn pod(name: &str, containers: &[(&str, Option<&str>)]) -> Pod {
        let spec: Vec<Value> = containers
            .iter()
            .map(|(c, _)| json!({"name": c, "image": "x"}))
            .collect();
        let statuses: Vec<Value> = containers
            .iter()
            .map(|(c, id)| {
                let state = if id.is_some() {
                    json!({"running": {"startedAt": "2024-05-01T09:00:00Z"}})
                } else {
                    json!({"waiting": {"reason": "ContainerCreating"}})
                };
                json!({"name": c, "image": "x", "imageID": "", "ready": id.is_some(),
                       "restartCount": 0, "containerID": id.unwrap_or(""), "state": state})
            })
            .collect();
        serde_json::from_value(json!({
            "metadata": {"name": name, "namespace": "shop"},
            "spec": {"containers": spec},
            "status": {"phase": "Running", "containerStatuses": statuses}
        }))
        .unwrap()
    }

    fn planner(max: usize) -> WorkloadLogPlanner {
        WorkloadLogPlanner::new("s", WorkloadLogOptions::default(), max)
    }

    fn starts(commands: &[SourceCommand]) -> Vec<(String, String, u64, Backlog)> {
        commands
            .iter()
            .filter_map(|c| match c {
                SourceCommand::Start {
                    pod,
                    container,
                    generation,
                    backlog,
                } => Some((pod.clone(), container.clone(), *generation, *backlog)),
                SourceCommand::Stop { .. } => None,
            })
            .collect()
    }

    fn kinds(batch: &WorkloadLogBatch) -> Vec<(WorkloadLogEventKind, String)> {
        batch
            .events
            .iter()
            .map(|e| (e.kind, format!("{}/{}", e.pod, e.container)))
            .collect()
    }

    use WorkloadLogEventKind as K;

    #[test]
    fn lines_of_several_pods_interleave_by_timestamp() {
        let mut p = planner(64);
        let mut cmds = p.apply_pod(&pod("web-1", &[("app", Some("c://1"))]));
        cmds.extend(p.apply_pod(&pod("web-2", &[("app", Some("c://2"))])));
        let s = starts(&cmds);
        assert_eq!(s.len(), 2);
        assert!(s.iter().all(|(_, _, _, b)| *b == Backlog::Requested));
        let (g1, g2) = (s[0].2, s[1].2);
        p.on_data(g1, format!("{T0} a1\n{T2} a2\n").as_bytes());
        p.on_data(g2, format!("{T1} b1\n").as_bytes());
        let batch = p.take_batch().unwrap();
        assert_eq!(
            kinds(&batch),
            vec![
                (K::SourceAdded, "web-1/app".into()),
                (K::SourceAdded, "web-2/app".into()),
                (K::Lines, "web-1/app".into()),
                (K::Lines, "web-2/app".into()),
                (K::Lines, "web-1/app".into()),
            ]
        );
        // Timestamps are stripped unless asked for.
        assert_eq!(batch.events[2].lines, vec!["a1"]);
        assert_eq!(batch.events[3].lines, vec!["b1"]);
        assert_eq!(batch.events[4].lines, vec!["a2"]);
        assert!(!batch.done);
        assert!(p.take_batch().is_none(), "idle stream sends nothing");
    }

    #[test]
    fn partial_lines_wait_and_stream_end_flushes_them() {
        let mut p = WorkloadLogPlanner::new(
            "s",
            WorkloadLogOptions {
                timestamps: true,
                ..Default::default()
            },
            64,
        );
        let g = starts(&p.apply_pod(&pod("web-1", &[("app", Some("c://1"))])))[0].2;
        p.take_batch();
        p.on_data(g, format!("{T0} hel").as_bytes());
        assert!(p.take_batch().is_none(), "no complete line yet");
        // A multi-byte character split across reads survives.
        let euro = "€".as_bytes();
        p.on_data(g, b"lo \xE2");
        p.on_data(g, &euro[1..]);
        p.on_data(g, b"\r\nno newline");
        assert!(p.on_end(g, None).is_empty(), "same instance: no restart");
        let batch = p.take_batch().unwrap();
        assert_eq!(
            kinds(&batch),
            vec![
                (K::Lines, "web-1/app".into()),
                (K::SourceEnded, "web-1/app".into())
            ]
        );
        assert_eq!(
            batch.events[0].lines,
            vec![format!("{T0} hello €"), "no newline".to_string()]
        );
    }

    #[test]
    fn stale_generations_are_ignored() {
        let mut p = planner(64);
        let g = starts(&p.apply_pod(&pod("web-1", &[("app", Some("c://1"))])))[0].2;
        p.on_end(g, Some("boom".into()));
        p.take_batch();
        p.on_data(g, b"late\n");
        assert!(p.on_end(g, None).is_empty());
        assert!(p.take_batch().is_none());
    }

    #[test]
    fn deleted_pods_stop_and_leave_after_their_last_line() {
        let mut p = planner(64);
        let g = starts(&p.apply_pod(&pod("web-1", &[("app", Some("c://1"))])))[0].2;
        p.take_batch();
        p.on_data(g, b"last words");
        let cmds = p.delete_pod("web-1");
        assert_eq!(cmds, vec![SourceCommand::Stop { generation: g }]);
        let batch = p.take_batch().unwrap();
        assert_eq!(
            kinds(&batch),
            vec![
                (K::Lines, "web-1/app".into()),
                (K::SourceRemoved, "web-1/app".into())
            ]
        );
        assert_eq!(p.active(), 0);
    }

    #[test]
    fn restarted_containers_are_reattached_with_their_whole_log() {
        let mut p = planner(64);
        let g1 = starts(&p.apply_pod(&pod("web-1", &[("app", Some("c://1"))])))[0].2;
        assert!(p.on_end(g1, None).is_empty());
        // Still the same (dead) instance while in back-off.
        assert!(p
            .apply_pod(&pod("web-1", &[("app", Some("c://1"))]))
            .is_empty());
        let s = starts(&p.apply_pod(&pod("web-1", &[("app", Some("c://2"))])));
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].3, Backlog::Full);
        assert_ne!(s[0].2, g1);
        let batch = p.take_batch().unwrap();
        assert_eq!(
            kinds(&batch),
            vec![
                (K::SourceAdded, "web-1/app".into()),
                (K::SourceEnded, "web-1/app".into()),
                (K::SourceAdded, "web-1/app".into())
            ]
        );
    }

    #[test]
    fn containers_without_an_instance_wait() {
        let mut p = planner(64);
        let first =
            starts(&p.apply_pod(&pod("web-1", &[("app", None), ("sidecar", Some("c://s"))])));
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].1, "sidecar");
        let running = [("app", Some("c://a")), ("sidecar", Some("c://s"))];
        let s = starts(&p.apply_pod(&pod("web-1", &running)));
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].1.as_str(), s[0].3), ("app", Backlog::Requested));
    }

    #[test]
    fn stream_cap_skips_sources_until_a_slot_frees() {
        let mut p = planner(2);
        let mut cmds = Vec::new();
        for name in ["a", "b", "c"] {
            cmds.extend(p.apply_pod(&pod(name, &[("app", Some(name))])));
        }
        let s = starts(&cmds);
        assert_eq!(s.len(), 2);
        let batch = p.take_batch().unwrap();
        assert_eq!(
            kinds(&batch),
            vec![
                (K::SourceAdded, "a/app".into()),
                (K::SourceAdded, "b/app".into()),
                (K::SourceSkipped, "c/app".into())
            ]
        );
        // Skipped once, not on every pod update.
        assert!(p.apply_pod(&pod("c", &[("app", Some("c"))])).is_empty());
        assert!(p.take_batch().is_none());
        let next = starts(&p.on_end(s[0].2, None));
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].0, "c");
        assert_eq!(next[0].3, Backlog::Requested);
    }

    #[test]
    fn container_filter_and_init_opt_in() {
        let with_init: Pod = serde_json::from_value(json!({
            "metadata": {"name": "p"},
            "spec": {"initContainers": [{"name": "migrate"}],
                     "containers": [{"name": "app"}, {"name": "envoy"}]},
            "status": {"initContainerStatuses": [{"name": "migrate", "image": "", "imageID": "",
                        "ready": false, "restartCount": 0,
                        "state": {"terminated": {"exitCode": 0}}}]}
        }))
        .unwrap();
        let names = |options: WorkloadLogOptions| -> Vec<(String, Option<String>)> {
            container_views(&with_init, &options)
                .into_iter()
                .map(|v| (v.name, v.instance))
                .collect()
        };
        assert_eq!(
            names(WorkloadLogOptions::default()),
            vec![("app".into(), None), ("envoy".into(), None)]
        );
        assert_eq!(
            names(WorkloadLogOptions {
                init_containers: true,
                containers: vec!["migrate".into(), "app".into()],
                ..Default::default()
            }),
            vec![("migrate".into(), Some("#0".into())), ("app".into(), None)]
        );
    }

    #[test]
    fn relist_removes_pods_that_disappeared() {
        let mut p = planner(64);
        p.on_event(Event::Init);
        p.on_event(Event::InitApply(pod("a", &[("app", Some("1"))])));
        p.on_event(Event::InitApply(pod("b", &[("app", Some("2"))])));
        p.on_event(Event::InitDone);
        assert!(p.synced());
        p.take_batch();
        p.on_event(Event::Init);
        p.on_event(Event::InitApply(pod("a", &[("app", Some("1"))])));
        let cmds = p.on_event(Event::InitDone);
        assert_eq!(cmds.len(), 1, "b's stream is stopped");
        assert_eq!(
            kinds(&p.take_batch().unwrap()),
            vec![(K::SourceRemoved, "b/app".into())]
        );
    }

    #[test]
    fn warnings_are_deduplicated_and_finish_flushes() {
        let mut p = planner(64);
        let g = starts(&p.apply_pod(&pod("a", &[("app", Some("1"))])))[0].2;
        p.warn("watch failed".into());
        p.warn("watch failed".into());
        p.on_data(g, b"tail");
        let batch = p.finish(Some("gone".into()));
        assert!(batch.done);
        assert_eq!(batch.error.as_deref(), Some("gone"));
        assert_eq!(
            kinds(&batch),
            vec![
                (K::SourceAdded, "a/app".into()),
                (K::Warning, "/".into()),
                (K::Lines, "a/app".into())
            ]
        );
    }

    #[test]
    fn overlong_lines_are_cut() {
        let mut p = planner(64);
        let g = starts(&p.apply_pod(&pod("a", &[("app", Some("1"))])))[0].2;
        p.take_batch();
        p.on_data(g, &vec![b'x'; MAX_LINE_BYTES + 10]);
        let batch = p.take_batch().unwrap();
        assert_eq!(batch.events[0].lines[0].len(), MAX_LINE_BYTES);
    }

    #[test]
    fn timestamps_and_params() {
        assert_eq!(
            split_timestamp("2024-05-01T10:00:00Z hi there"),
            (Some(1_714_557_600_000_000_000), "hi there")
        );
        assert_eq!(split_timestamp("2024-05-01T10:00:00Z").1, "");
        assert_eq!(split_timestamp("plain line"), (None, "plain line"));
        assert_eq!(split_timestamp("2024 is a year"), (None, "2024 is a year"));
        let options = WorkloadLogOptions {
            tail_lines: Some(50),
            since_seconds: Some(300),
            ..Default::default()
        };
        let first = source_log_params("app", &options, Backlog::Requested);
        assert!(first.follow && first.timestamps);
        assert_eq!(first.container.as_deref(), Some("app"));
        assert_eq!(first.tail_lines, Some(50));
        assert_eq!(first.since_seconds, Some(300));
        let again = source_log_params("app", &options, Backlog::Full);
        assert_eq!((again.tail_lines, again.since_seconds), (None, None));
        assert!(is_fatal_watch_error(Some(403)));
        assert!(!is_fatal_watch_error(Some(500)));
        assert!(!is_fatal_watch_error(None));
    }
}
