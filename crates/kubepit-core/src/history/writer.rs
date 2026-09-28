//! The one writer of `history.db`: a dedicated thread fed by a bounded
//! channel, so UI commands never wait for the disk.
//!
//! - Producers only `try_send` ([`Writer::submit`]): when the queue is full
//!   the write is dropped and counted (`dropped`), never blocking the caller
//!   — recording must not slow down or fail the user's action.
//! - Operations are applied strictly in queue order. Consecutive data writes
//!   share one transaction; control operations (clear, prune, flush and the
//!   recommendation scan writes) act as barriers after everything queued
//!   before them.
//! - Scan writes are never dropped: [`Writer::scan_begin`] and
//!   [`Writer::scan_finish`] wait for room (blocking pool only), and
//!   [`Writer::send_detached`] hands a full queue's operation to a
//!   short-lived thread instead of dropping it (drop guards).
//! - [`Writer::start`] marks runs a previous process left `running` as
//!   interrupted (`app-restarted`) before the thread takes any operation.
//! - Dropping the last handle closes the channel; the thread drains what is
//!   queued and exits.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use rusqlite::Connection;

use super::db::{self, AuditRecord, ChangeRow, EventRow, PrunePolicy, PruneReport};
use super::recommendations::{self as rec, ScanBegin, ScanOutcome};
use super::types::HistoryKind;
use crate::objects::now_millis;

/// Queued operations before producers start dropping writes.
pub const QUEUE_CAPACITY: usize = 1024;
/// Data operations committed together.
const BATCH: usize = 256;

pub enum WriteOp {
    Audit(Box<AuditRecord>),
    Events(Vec<EventRow>),
    Changes(Vec<ChangeRow>),
    Prune(PrunePolicy, Option<mpsc::Sender<Result<PruneReport>>>),
    Clear(HistoryKind, Option<String>, mpsc::Sender<Result<()>>),
    /// Barrier: answered once everything queued before it is written.
    Flush(mpsc::Sender<()>),
    /// Insert a `running` recommendation run; answers its id.
    ScanBegin(ScanBegin, mpsc::Sender<Result<i64>>),
    /// Record how run `.0` ended at `.1` (epoch ms); answered when a
    /// sender is given (drop guards pass none).
    ScanFinish(i64, i64, Box<ScanOutcome>, Option<mpsc::Sender<Result<()>>>),
    /// Tests: park the thread until the sender side is dropped or signals.
    #[cfg(test)]
    Block(Receiver<()>),
}

impl WriteOp {
    fn is_data(&self) -> bool {
        matches!(self, Self::Audit(_) | Self::Events(_) | Self::Changes(_))
    }
}

/// Counters shared with the thread.
#[derive(Default)]
pub struct WriterStats {
    pub dropped: AtomicU64,
    pub failed: AtomicU64,
    pub written: AtomicU64,
}

pub struct Writer {
    tx: SyncSender<WriteOp>,
    stats: Arc<WriterStats>,
}

impl Writer {
    /// Open the database at `path` (migrating it), mark recommendation runs
    /// a previous process left `running` as interrupted, and start the
    /// thread. The sweep runs here, on the caller's thread, so no scan can
    /// be begun through this writer before it.
    pub fn start(path: PathBuf, capacity: usize) -> Result<Self> {
        let conn = db::open(&path)?;
        match rec::sweep_interrupted(&conn, now_millis()) {
            Ok(0) => {}
            Ok(n) => tracing::info!("{n} recommendation scan(s) interrupted by a restart"),
            Err(e) => tracing::warn!("failed to sweep interrupted recommendation scans: {e:#}"),
        }
        let (tx, rx) = mpsc::sync_channel(capacity.max(1));
        let stats = Arc::new(WriterStats::default());
        let thread_stats = stats.clone();
        std::thread::Builder::new()
            .name("kubepit-history".into())
            .spawn(move || run(conn, rx, thread_stats))
            .map_err(|e| anyhow!("failed to start the history writer: {e}"))?;
        Ok(Self { tx, stats })
    }

    /// Queue `op` without waiting. Returns false (and counts a drop) when
    /// the queue is full or the writer is gone.
    pub fn submit(&self, op: WriteOp) -> bool {
        match self.tx.try_send(op) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.stats.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// Queue `op` waiting for room (user-initiated control operations, on
    /// the blocking pool only).
    pub fn send_blocking(&self, op: WriteOp) -> Result<()> {
        self.tx
            .send(op)
            .map_err(|_| anyhow!("the history writer stopped"))
    }

    /// Queue `op` without blocking and without dropping it: when the queue
    /// is full, a short-lived thread waits for room. False only when the
    /// writer is gone.
    pub fn send_detached(&self, op: WriteOp) -> bool {
        match self.tx.try_send(op) {
            Ok(()) => true,
            Err(TrySendError::Full(op)) => {
                let tx = self.tx.clone();
                std::thread::Builder::new()
                    .name("kubepit-history-send".into())
                    .spawn(move || {
                        let _ = tx.send(op);
                    })
                    .is_ok()
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    /// Insert a `running` recommendation run after everything queued
    /// before; waits for room and for the id (blocking pool only).
    pub fn scan_begin(&self, scan: ScanBegin) -> Result<i64> {
        let (done, wait) = mpsc::channel();
        self.send_blocking(WriteOp::ScanBegin(scan, done))?;
        wait.recv_timeout(Duration::from_secs(30))
            .map_err(|_| anyhow!("timed out starting a recommendation scan"))?
    }

    /// Record how run `run_id` ended at `finished` (epoch ms), after
    /// everything queued before; waits (blocking pool only).
    pub fn scan_finish(&self, run_id: i64, finished: i64, outcome: ScanOutcome) -> Result<()> {
        let (done, wait) = mpsc::channel();
        self.send_blocking(WriteOp::ScanFinish(
            run_id,
            finished,
            Box::new(outcome),
            Some(done),
        ))?;
        wait.recv_timeout(Duration::from_secs(60))
            .map_err(|_| anyhow!("timed out storing a recommendation scan"))?
    }

    /// Wait until everything queued so far is written (bounded).
    pub fn flush(&self, timeout: Duration) -> bool {
        let (done, wait) = mpsc::channel();
        if self.send_blocking(WriteOp::Flush(done)).is_err() {
            return false;
        }
        wait.recv_timeout(timeout).is_ok()
    }

    /// Delete data of `kind`, after everything queued before.
    pub fn clear(&self, kind: HistoryKind, cluster_id: Option<String>) -> Result<()> {
        let (done, wait) = mpsc::channel();
        self.send_blocking(WriteOp::Clear(kind, cluster_id, done))?;
        wait.recv_timeout(Duration::from_secs(60))
            .map_err(|_| anyhow!("timed out clearing history"))?
    }

    /// Run retention now and wait for the report.
    pub fn prune(&self, policy: PrunePolicy) -> Result<PruneReport> {
        let (done, wait) = mpsc::channel();
        self.send_blocking(WriteOp::Prune(policy, Some(done)))?;
        wait.recv_timeout(Duration::from_secs(120))
            .map_err(|_| anyhow!("timed out pruning history"))?
    }

    pub fn stats(&self) -> &WriterStats {
        &self.stats
    }
}

fn run(mut conn: Connection, rx: Receiver<WriteOp>, stats: Arc<WriterStats>) {
    while let Ok(first) = rx.recv() {
        let mut ops = vec![first];
        while ops.len() < BATCH {
            match rx.try_recv() {
                Ok(op) => ops.push(op),
                Err(_) => break,
            }
        }
        let mut pending: Vec<WriteOp> = Vec::new();
        for op in ops {
            if op.is_data() {
                pending.push(op);
                continue;
            }
            commit(&mut conn, std::mem::take(&mut pending), &stats);
            control(&mut conn, op);
        }
        commit(&mut conn, pending, &stats);
    }
}

fn commit(conn: &mut Connection, ops: Vec<WriteOp>, stats: &WriterStats) {
    if ops.is_empty() {
        return;
    }
    let count = ops.len() as u64;
    let result = (|| -> Result<()> {
        let tx = conn.transaction()?;
        for op in &ops {
            match op {
                WriteOp::Audit(record) => {
                    db::insert_audit(&tx, record)?;
                }
                WriteOp::Events(rows) => db::upsert_events(&tx, rows)?,
                WriteOp::Changes(rows) => db::insert_changes(&tx, rows)?,
                _ => {}
            }
        }
        tx.commit()?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            stats.written.fetch_add(count, Ordering::Relaxed);
        }
        Err(e) => {
            stats.failed.fetch_add(count, Ordering::Relaxed);
            tracing::warn!("history write failed: {e:#}");
        }
    }
}

fn control(conn: &mut Connection, op: WriteOp) {
    match op {
        WriteOp::Prune(policy, reply) => {
            let report = db::prune(conn, &policy);
            if let Err(e) = &report {
                tracing::warn!("history prune failed: {e:#}");
            }
            if let Some(reply) = reply {
                let _ = reply.send(report);
            }
        }
        WriteOp::Clear(kind, cluster_id, reply) => {
            let result =
                db::clear(conn, kind, cluster_id.as_deref()).and_then(|()| db::vacuum(conn));
            let _ = reply.send(result);
        }
        WriteOp::Flush(reply) => {
            let _ = reply.send(());
        }
        WriteOp::ScanBegin(scan, reply) => {
            let _ = reply.send(rec::begin(conn, &scan));
        }
        WriteOp::ScanFinish(run_id, finished, outcome, reply) => {
            let result = rec::finish(conn, run_id, finished, &outcome);
            if let Err(e) = &result {
                tracing::warn!("failed to store recommendation run {run_id}: {e:#}");
            }
            if let Some(reply) = reply {
                let _ = reply.send(result);
            }
        }
        #[cfg(test)]
        WriteOp::Block(gate) => {
            let _ = gate.recv();
        }
        WriteOp::Audit(_) | WriteOp::Events(_) | WriteOp::Changes(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::recommendations::{self as rec, ScanBegin, ScanOutcome};
    use crate::history::types::{AuditAction, AuditFilter, AuditOutcome, AuditTarget};
    use crate::recommendations::{RunStatus, ScanTrigger};
    use std::time::Instant;

    fn record(ts: i64) -> AuditRecord {
        AuditRecord {
            ts,
            cluster_id: "c1".into(),
            cluster_name: "one".into(),
            context: "ctx".into(),
            identity: Some("dev".into()),
            action: AuditAction::Scale,
            dry_run: false,
            outcome: AuditOutcome::Ok,
            error: None,
            duration_ms: 1,
            targets: vec![AuditTarget::core("Pod", Some("shop"), "web")],
            request: None,
            result: None,
            objects: Vec::new(),
        }
    }

    #[test]
    fn writes_land_in_queue_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.db");
        let writer = Writer::start(path.clone(), 64).unwrap();
        // Same timestamp for all: only insertion order can order them.
        for i in 0..50 {
            let mut r = record(1_000);
            r.result = Some(format!("#{i}"));
            assert!(writer.submit(WriteOp::Audit(Box::new(r))));
        }
        assert!(writer.flush(Duration::from_secs(10)));
        let conn = db::open(&path).unwrap();
        let page = db::list_audit(
            &conn,
            &AuditFilter {
                limit: 100,
                ..AuditFilter::default()
            },
        )
        .unwrap();
        let order: Vec<String> = page
            .entries
            .iter()
            .rev()
            .map(|e| e.result.clone().unwrap())
            .collect();
        let expected: Vec<String> = (0..50).map(|i| format!("#{i}")).collect();
        assert_eq!(order, expected);
        assert_eq!(writer.stats().written.load(Ordering::Relaxed), 50);

        // A clear queued after writes runs after them.
        assert!(writer.submit(WriteOp::Audit(Box::new(record(2_000)))));
        writer.clear(HistoryKind::Audit, None).unwrap();
        let rows = db::table_status(&conn, "audit", "ts").unwrap().rows;
        assert_eq!(rows, 0);
    }

    #[test]
    fn a_full_queue_drops_instead_of_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.db");
        let writer = Writer::start(path.clone(), 2).unwrap();
        let (release, gate) = mpsc::channel();
        writer.send_blocking(WriteOp::Block(gate)).unwrap();
        // Let the thread pick up the gate so the queue is empty again.
        std::thread::sleep(Duration::from_millis(50));
        assert!(writer.submit(WriteOp::Audit(Box::new(record(1)))));
        assert!(writer.submit(WriteOp::Audit(Box::new(record(2)))));
        let started = Instant::now();
        for ts in 3..10 {
            assert!(!writer.submit(WriteOp::Audit(Box::new(record(ts)))));
        }
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "submit must not wait"
        );
        assert_eq!(writer.stats().dropped.load(Ordering::Relaxed), 7);
        release.send(()).unwrap();
        assert!(writer.flush(Duration::from_secs(10)));
        let conn = db::open(&path).unwrap();
        let page = db::list_audit(&conn, &AuditFilter::default()).unwrap();
        let ts: Vec<i64> = page.entries.iter().map(|e| e.ts).collect();
        assert_eq!(ts, vec![2, 1]);
    }

    fn scan(started: i64) -> ScanBegin {
        ScanBegin {
            cluster_id: "c1".into(),
            started,
            trigger: ScanTrigger::Manual,
            source_config: "{}".into(),
        }
    }

    fn data_op() -> WriteOp {
        WriteOp::Audit(Box::new(record(1)))
    }

    fn audit_rows(path: &std::path::Path) -> u64 {
        let conn = db::open(path).unwrap();
        db::table_status(&conn, "audit", "ts").unwrap().rows
    }

    #[test]
    fn scan_ops_are_barriers_and_never_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.db");
        let writer = Arc::new(Writer::start(path.clone(), 2).unwrap());
        let (release, gate) = mpsc::channel();
        writer.send_blocking(WriteOp::Block(gate)).unwrap();
        // Let the thread pick up the gate so the queue is empty again.
        std::thread::sleep(Duration::from_millis(50));
        while writer.submit(data_op()) {}
        assert!(!writer.submit(data_op()), "data writes are dropped");
        let dropped = writer.stats().dropped.load(Ordering::Relaxed);

        let w = writer.clone();
        let handle = std::thread::spawn(move || w.scan_begin(scan(1_000)));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!handle.is_finished(), "waits for room instead of dropping");
        release.send(()).unwrap();
        let run_id = handle.join().unwrap().unwrap();
        assert_eq!(audit_rows(&path), 2, "writes queued before it land first");
        assert_eq!(writer.stats().dropped.load(Ordering::Relaxed), dropped);

        assert!(writer.submit(data_op()));
        writer
            .scan_finish(run_id, 2_000, ScanOutcome::Failed("boom".into()))
            .unwrap();
        assert_eq!(audit_rows(&path), 3);
        let conn = db::open(&path).unwrap();
        let run = &rec::runs(&conn, "c1", 5).unwrap()[0];
        assert_eq!((run.id, run.status), (run_id, RunStatus::Failed));
        assert_eq!(run.error.as_deref(), Some("boom"));
    }

    #[test]
    fn detached_finishes_wait_for_room() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.db");
        let writer = Writer::start(path.clone(), 2).unwrap();
        let run_id = writer.scan_begin(scan(1_000)).unwrap();
        let (release, gate) = mpsc::channel();
        writer.send_blocking(WriteOp::Block(gate)).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        while writer.submit(data_op()) {}
        let dropped = writer.stats().dropped.load(Ordering::Relaxed);
        let started = Instant::now();
        assert!(writer.send_detached(WriteOp::ScanFinish(
            run_id,
            2_000,
            Box::new(ScanOutcome::Interrupted("stopped".into())),
            None,
        )));
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "never blocks"
        );
        assert_eq!(writer.stats().dropped.load(Ordering::Relaxed), dropped);
        release.send(()).unwrap();
        let conn = db::open(&path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(writer.flush(Duration::from_secs(10)));
            let run = &rec::runs(&conn, "c1", 1).unwrap()[0];
            if run.status == RunStatus::Interrupted {
                assert_eq!(run.error.as_deref(), Some("stopped"));
                break;
            }
            assert!(Instant::now() < deadline, "the finish never landed");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn writer_start_sweeps_running_runs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.db");
        let conn = db::open(&path).unwrap();
        let running = rec::begin(&conn, &scan(1_000)).unwrap();
        drop(conn);
        let writer = Writer::start(path.clone(), 8).unwrap();
        let reader = db::open(&path).unwrap();
        let run = &rec::runs(&reader, "c1", 5).unwrap()[0];
        assert_eq!((run.id, run.status), (running, RunStatus::Interrupted));
        assert_eq!(run.error.as_deref(), Some(rec::ERROR_APP_RESTARTED));
        assert!(run.finished_at.is_some());
        // Runs begun through this writer are its own: not swept again.
        let next = writer.scan_begin(scan(2_000)).unwrap();
        assert_eq!(rec::runs(&reader, "c1", 5).unwrap()[0].id, next);
        assert_eq!(
            rec::runs(&reader, "c1", 5).unwrap()[0].status,
            RunStatus::Running
        );
    }
}
