//! The one writer of `history.db`: a dedicated thread fed by a bounded
//! channel, so UI commands never wait for the disk.
//!
//! - Producers only `try_send` ([`Writer::submit`]): when the queue is full
//!   the write is dropped and counted (`dropped`), never blocking the caller
//!   — recording must not slow down or fail the user's action.
//! - Operations are applied strictly in queue order. Consecutive data writes
//!   share one transaction; control operations (clear, prune, flush) act as
//!   barriers after everything queued before them.
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
use super::types::HistoryKind;

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
    /// Open the database at `path` (migrating it) and start the thread.
    pub fn start(path: PathBuf, capacity: usize) -> Result<Self> {
        let conn = db::open(&path)?;
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
            control(&conn, op);
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

fn control(conn: &Connection, op: WriteOp) {
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
    use crate::history::types::{AuditAction, AuditFilter, AuditOutcome, AuditTarget};
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
}
