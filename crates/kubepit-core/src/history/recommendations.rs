//! Stored recommendation scans (spec §11): migration 2, the writes the
//! history writer applies, the reads behind the `recommendations_*`
//! commands, retention and clear.
//!
//! - **Runs** (`rec_runs`): one row per scan attempt. [`begin`] inserts it
//!   `running`; [`finish`] records the outcome in one transaction. Only a
//!   success writes the workload rows and moves the cluster's latest
//!   pointer (`rec_latest`), so a failed or interrupted scan keeps the last
//!   good result. The first finish wins: a run that is no longer `running`
//!   (finished, swept, or deleted by a clear mid-scan) is left alone.
//! - **Rows** (`rec_rows`): one `WorkloadRecommendation` (JSON) per
//!   workload of a successful run, keyed `kind/namespace/name`; the run's
//!   `report` column holds the rest of the `RightsizingReport`.
//! - **Latest**: the pointer remembers the Prometheus configuration the run
//!   used (`source_config`); [`latest`] hides a scan whose configuration no
//!   longer matches (`source_changed`).
//! - Rows and runs of older builds read with defaults (missing JSON fields,
//!   a `NULL` summary, report or settings).

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::db::PrunePolicy;
use super::types::HistoryTableStatus;
use crate::cost::CostPlatform;
use crate::recommendations::{
    RecommendationRun, RecommendationTrendContainer, RecommendationTrendPoint, RunStatus,
    ScanTrigger,
};
use crate::rightsizing::summary::RecommendationSummary;
use crate::rightsizing::{
    sort_recommendations, strategy, Confidence, RightsizingReport, RightsizingSettings,
    RightsizingSource, Verdict, WorkloadRecommendation,
};

/// Migration 2 of `history.db` (appended to `db::MIGRATIONS`).
pub const MIGRATION: &str = r#"
CREATE TABLE rec_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id    TEXT    NOT NULL,
    started       INTEGER NOT NULL,
    finished      INTEGER,
    status        TEXT    NOT NULL,            -- running | success | failed | interrupted
    trigger       TEXT    NOT NULL,            -- manual | schedule
    error         TEXT,                        -- message or code (app-restarted, stopped, no-usage-source)
    source        TEXT,                        -- prometheus | metrics-server | none
    strategy      TEXT,
    source_config TEXT    NOT NULL,            -- canonical JSON of ClusterDef.prometheus (+ access in phase 7)
    settings      TEXT,                        -- RightsizingSettings used (JSON)
    window_start  INTEGER,
    window_end    INTEGER,
    workloads     INTEGER NOT NULL DEFAULT 0,
    summary       TEXT,                        -- RecommendationSummary (JSON, success only)
    report        TEXT,                        -- RightsizingReport without workloads (JSON)
    rows_kept     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX rec_runs_cluster ON rec_runs (cluster_id, started DESC);
CREATE INDEX rec_runs_status ON rec_runs (status);

CREATE TABLE rec_rows (
    run_id        INTEGER NOT NULL REFERENCES rec_runs (id) ON DELETE CASCADE,
    cluster_id    TEXT    NOT NULL,
    key           TEXT    NOT NULL,            -- kind/namespace/name
    namespace     TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    verdict       TEXT    NOT NULL,
    confidence    TEXT    NOT NULL,
    changed       INTEGER NOT NULL,
    monthly_delta REAL    NOT NULL,
    row           TEXT    NOT NULL,            -- WorkloadRecommendation (JSON)
    PRIMARY KEY (run_id, key)
);
CREATE INDEX rec_rows_trend ON rec_rows (cluster_id, key, run_id);

CREATE TABLE rec_latest (
    cluster_id    TEXT PRIMARY KEY,
    run_id        INTEGER NOT NULL REFERENCES rec_runs (id),
    source_config TEXT    NOT NULL
);
"#;

/// Error of runs still `running` when the writer starts.
pub const ERROR_APP_RESTARTED: &str = "app-restarted";
/// Error of runs stopped before they finished (abort, or a begin nobody
/// took the id of).
pub const ERROR_STOPPED: &str = "stopped";
/// Most runs [`runs`] returns.
pub const MAX_RUNS: u32 = 500;

/// A scan about to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanBegin {
    pub cluster_id: String,
    /// Epoch ms.
    pub started: i64,
    pub trigger: ScanTrigger,
    /// Canonical JSON of the cluster's Prometheus configuration.
    pub source_config: String,
}

/// How a scan ended.
// Moved once into a boxed writer operation; boxing the report as well would
// only add an allocation.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum ScanOutcome {
    Success {
        report: RightsizingReport,
        summary: RecommendationSummary,
        settings: RightsizingSettings,
    },
    Failed(String),
    Interrupted(String),
}

/// A successful run with its rows.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredScan {
    pub run: RecommendationRun,
    /// Workloads sorted by [`sort_recommendations`] (empty once thinned).
    pub report: RightsizingReport,
    /// The settings the run used.
    pub settings: RightsizingSettings,
}

/// [`latest`].
#[derive(Debug, Clone, PartialEq)]
pub struct LatestRead {
    /// The cluster's latest successful run, unless its source changed.
    pub scan: Option<StoredScan>,
    /// The latest run used another Prometheus configuration (it is hidden).
    pub source_changed: bool,
    /// The newest failed or interrupted run after the latest successful one.
    pub last_failure: Option<RecommendationRun>,
}

/// `kind/namespace/name`.
pub fn row_key(kind: &str, namespace: &str, name: &str) -> String {
    format!("{kind}/{namespace}/{name}")
}

/// The wire name of a unit enum (`over`, `high`, `prometheus`).
fn wire<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn from_wire<T: DeserializeOwned>(text: &str) -> Option<T> {
    serde_json::from_value(Value::String(text.to_string())).ok()
}

fn from_json<T: DeserializeOwned>(text: Option<String>) -> Option<T> {
    serde_json::from_str(&text?).ok()
}

fn finite(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// Insert a `running` run; returns its id.
pub fn begin(conn: &Connection, scan: &ScanBegin) -> Result<i64> {
    conn.execute(
        "INSERT INTO rec_runs (cluster_id, started, status, trigger, source_config)
         VALUES (?1, ?2, 'running', ?3, ?4)",
        params![
            scan.cluster_id,
            scan.started,
            scan.trigger.as_str(),
            scan.source_config
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The report without its workloads (JSON, `workloads: []`) and each
/// workload as JSON.
fn split_report(report: &RightsizingReport) -> Result<(String, Vec<String>)> {
    let mut head = serde_json::to_value(report)?;
    let rows = match head.get_mut("workloads").map(Value::take) {
        Some(Value::Array(items)) => items
            .iter()
            .map(serde_json::to_string)
            .collect::<serde_json::Result<Vec<_>>>()?,
        _ => Vec::new(),
    };
    head["workloads"] = Value::Array(Vec::new());
    Ok((head.to_string(), rows))
}

/// Record how run `run_id` ended, in one transaction. A success writes the
/// rows, completes the run and moves the cluster's latest pointer; a
/// failure or interruption only completes the run. A run that is no longer
/// `running` (already finished, swept, or deleted by a clear) is left alone.
pub fn finish(
    conn: &mut Connection,
    run_id: i64,
    finished: i64,
    outcome: &ScanOutcome,
) -> Result<()> {
    let tx = conn.transaction()?;
    let run: Option<(String, String)> = tx
        .query_row(
            "SELECT cluster_id, source_config FROM rec_runs WHERE id = ?1 AND status = 'running'",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((cluster_id, source_config)) = run else {
        tracing::debug!("recommendation run {run_id} is no longer running; outcome ignored");
        return Ok(());
    };
    match outcome {
        ScanOutcome::Success {
            report,
            summary,
            settings,
        } => {
            let (head, rows) = split_report(report)?;
            {
                let mut insert = tx.prepare_cached(
                    "INSERT OR REPLACE INTO rec_rows (run_id, cluster_id, key, namespace, kind,
                         name, verdict, confidence, changed, monthly_delta, row)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                )?;
                for (w, row) in report.workloads.iter().zip(&rows) {
                    insert.execute(params![
                        run_id,
                        cluster_id,
                        row_key(&w.kind, &w.namespace, &w.name),
                        w.namespace,
                        w.kind,
                        w.name,
                        wire(&w.verdict),
                        wire(&w.confidence),
                        w.changed,
                        finite(w.monthly_delta),
                        row,
                    ])?;
                }
            }
            let window_ms = i64::try_from(report.window_secs)
                .unwrap_or(i64::MAX)
                .saturating_mul(1000);
            tx.execute(
                "UPDATE rec_runs SET status = 'success', finished = ?2, error = NULL, source = ?3,
                     strategy = ?4, settings = ?5, window_start = ?6, window_end = ?7,
                     workloads = ?8, summary = ?9, report = ?10, rows_kept = 1
                 WHERE id = ?1",
                params![
                    run_id,
                    finished,
                    wire(&report.source),
                    report.strategy,
                    serde_json::to_string(settings)?,
                    report.window_end.saturating_sub(window_ms),
                    report.window_end,
                    rows.len() as i64,
                    serde_json::to_string(summary)?,
                    head,
                ],
            )?;
            tx.execute(
                "INSERT INTO rec_latest (cluster_id, run_id, source_config) VALUES (?1, ?2, ?3)
                 ON CONFLICT (cluster_id) DO UPDATE SET
                     run_id = excluded.run_id, source_config = excluded.source_config",
                params![cluster_id, run_id, source_config],
            )?;
        }
        ScanOutcome::Failed(error) | ScanOutcome::Interrupted(error) => {
            let status = if matches!(outcome, ScanOutcome::Failed(_)) {
                RunStatus::Failed
            } else {
                RunStatus::Interrupted
            };
            tx.execute(
                "UPDATE rec_runs SET status = ?2, finished = ?3, error = ?4 WHERE id = ?1",
                params![run_id, status.as_str(), finished, error],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Mark runs left `running` by a previous process as interrupted
/// (`app-restarted`); returns how many.
pub fn sweep_interrupted(conn: &Connection, now: i64) -> Result<u64> {
    let swept = conn.execute(
        "UPDATE rec_runs SET status = 'interrupted', error = ?1, finished = ?2
         WHERE status = 'running'",
        params![ERROR_APP_RESTARTED, now],
    )?;
    Ok(swept as u64)
}

// -- Reads -----------------------------------------------------------------------

/// Columns of [`run_row`], on `rec_runs` aliased `r`.
const RUN_COLUMNS: &str = "r.id, r.cluster_id, r.started, r.finished, r.status, r.trigger,
    r.error, r.source, r.strategy, r.window_start, r.window_end, r.workloads, r.rows_kept,
    r.summary";
/// Number of [`RUN_COLUMNS`] (the index of the first column after them).
const RUN_COLUMN_COUNT: usize = 14;

fn run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecommendationRun> {
    let status: String = row.get(4)?;
    let trigger: String = row.get(5)?;
    let source: Option<String> = row.get(7)?;
    let window: (Option<i64>, Option<i64>) = (row.get(9)?, row.get(10)?);
    let workloads: i64 = row.get(11)?;
    Ok(RecommendationRun {
        id: row.get(0)?,
        cluster_id: row.get(1)?,
        started_at: row.get(2)?,
        finished_at: row.get(3)?,
        status: RunStatus::parse(&status).unwrap_or(RunStatus::Failed),
        trigger: ScanTrigger::parse(&trigger).unwrap_or(ScanTrigger::Schedule),
        error: row.get(6)?,
        source: source.as_deref().and_then(from_wire),
        strategy: row.get(8)?,
        window_secs: match window {
            (Some(start), Some(end)) if end >= start => u64::try_from((end - start) / 1000).ok(),
            _ => None,
        },
        workloads: u32::try_from(workloads.max(0)).unwrap_or(u32::MAX),
        rows_kept: row.get(12)?,
        summary: from_json(row.get(13)?),
    })
}

/// The report of a successful run whose `report` column is missing or
/// unreadable (older builds): what the run's columns tell.
fn fallback_report(run: &RecommendationRun, settings: &RightsizingSettings) -> RightsizingReport {
    let pricing = CostPlatform::Generic.default_pricing();
    let at = run.finished_at.unwrap_or(run.started_at);
    RightsizingReport {
        source: run.source.unwrap_or(RightsizingSource::None),
        window_secs: run.window_secs.unwrap_or(0),
        settings: settings.clone(),
        currency: pricing.currency.clone(),
        pricing,
        workloads: Vec::new(),
        notes: Vec::new(),
        strategy: run.strategy.clone().unwrap_or_default(),
        strategies: strategy::strategies(),
        computed_at: at,
        strategy_auto: false,
        window_end: at,
    }
}

/// Successful run `run_id` of `cluster_id` with its rows (sorted by
/// [`sort_recommendations`]); `None` for another cluster's run, a run that
/// did not succeed, or one that is gone. Rows that no longer parse are
/// skipped.
pub fn scan(conn: &Connection, cluster_id: &str, run_id: i64) -> Result<Option<StoredScan>> {
    let found = conn
        .query_row(
            &format!(
                "SELECT {RUN_COLUMNS}, r.settings, r.report FROM rec_runs r
                 WHERE r.id = ?1 AND r.cluster_id = ?2 AND r.status = 'success'"
            ),
            params![run_id, cluster_id],
            |row| {
                Ok((
                    run_row(row)?,
                    row.get::<_, Option<String>>(RUN_COLUMN_COUNT)?,
                    row.get::<_, Option<String>>(RUN_COLUMN_COUNT + 1)?,
                ))
            },
        )
        .optional()?;
    let Some((run, settings, head)) = found else {
        return Ok(None);
    };
    let head: Option<RightsizingReport> = from_json(head);
    let settings: RightsizingSettings = from_json(settings)
        .or_else(|| head.as_ref().map(|r| r.settings.clone()))
        .unwrap_or_default();
    let mut report = head.unwrap_or_else(|| fallback_report(&run, &settings));
    let mut stmt = conn.prepare("SELECT row FROM rec_rows WHERE run_id = ?1")?;
    report.workloads = stmt
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .filter_map(|row| row.ok())
        .filter_map(|row| serde_json::from_str::<WorkloadRecommendation>(&row).ok())
        .collect();
    sort_recommendations(&mut report.workloads);
    Ok(Some(StoredScan {
        run,
        report,
        settings,
    }))
}

fn newest_failure_after(
    conn: &Connection,
    cluster_id: &str,
    after_id: i64,
) -> Result<Option<RecommendationRun>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {RUN_COLUMNS} FROM rec_runs r
                 WHERE r.cluster_id = ?1 AND r.id > ?2 AND r.status IN ('failed', 'interrupted')
                 ORDER BY r.id DESC LIMIT 1"
            ),
            params![cluster_id, after_id],
            run_row,
        )
        .optional()?)
}

/// The latest successful scan of `cluster_id` when it used `source_config`
/// (else `source_changed` and no scan), and the newest failed or
/// interrupted run after it.
pub fn latest(conn: &Connection, cluster_id: &str, source_config: &str) -> Result<LatestRead> {
    let pointer: Option<(i64, String)> = conn
        .query_row(
            "SELECT run_id, source_config FROM rec_latest WHERE cluster_id = ?1",
            [cluster_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (scan, source_changed) = match &pointer {
        Some((run_id, stored)) if stored == source_config => {
            (scan(conn, cluster_id, *run_id)?, false)
        }
        Some(_) => (None, true),
        None => (None, false),
    };
    let after = pointer.map_or(0, |(run_id, _)| run_id);
    Ok(LatestRead {
        scan,
        source_changed,
        last_failure: newest_failure_after(conn, cluster_id, after)?,
    })
}

/// Runs of `cluster_id`, newest first (1 to [`MAX_RUNS`]).
pub fn runs(conn: &Connection, cluster_id: &str, limit: u32) -> Result<Vec<RecommendationRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM rec_runs r WHERE r.cluster_id = ?1
         ORDER BY r.started DESC, r.id DESC LIMIT ?2"
    ))?;
    let runs = stmt
        .query_map(
            params![cluster_id, i64::from(limit.clamp(1, MAX_RUNS))],
            run_row,
        )?
        .collect::<rusqlite::Result<_>>()?;
    Ok(runs)
}

/// The newest run of `cluster_id`, whatever its status (the scheduler's
/// last attempt).
pub fn last_attempt(conn: &Connection, cluster_id: &str) -> Result<Option<RecommendationRun>> {
    Ok(runs(conn, cluster_id, 1)?.into_iter().next())
}

fn trend_containers(row: &str) -> Vec<RecommendationTrendContainer> {
    let Ok(w) = serde_json::from_str::<WorkloadRecommendation>(row) else {
        return Vec::new();
    };
    w.containers
        .into_iter()
        .map(|c| RecommendationTrendContainer {
            cpu_request: c.current.cpu_request,
            cpu_recommended: c.recommended.cpu_request,
            memory_request: c.current.memory_request,
            memory_recommended: c.recommended.memory_request,
            cpu_p95: c.usage.map(|u| u.cpu_p95),
            memory_max: c.usage.map(|u| u.memory_max),
            name: c.name,
        })
        .collect()
}

/// Workload `key` in every successful run of `cluster_id` whose rows are
/// kept, oldest first.
pub fn trend(
    conn: &Connection,
    cluster_id: &str,
    key: &str,
) -> Result<Vec<RecommendationTrendPoint>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.started, w.verdict, w.confidence, w.monthly_delta, w.row
         FROM rec_rows w JOIN rec_runs r ON r.id = w.run_id
         WHERE w.cluster_id = ?1 AND w.key = ?2 AND r.status = 'success' AND r.rows_kept = 1
         ORDER BY r.started ASC, r.id ASC",
    )?;
    let points = stmt
        .query_map(params![cluster_id, key], |r| {
            let verdict: String = r.get(2)?;
            let confidence: String = r.get(3)?;
            let row: String = r.get(5)?;
            Ok(RecommendationTrendPoint {
                run_id: r.get(0)?,
                at: r.get(1)?,
                verdict: from_wire(&verdict).unwrap_or(Verdict::NoData),
                confidence: from_wire(&confidence).unwrap_or(Confidence::Low),
                monthly_delta: r.get(4)?,
                containers: trend_containers(&row),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(points)
}

/// Every cluster with a latest successful run: its id, that run and the
/// source configuration it used.
pub fn fleet(conn: &Connection) -> Result<Vec<(String, RecommendationRun, String)>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS}, l.cluster_id, l.source_config
         FROM rec_latest l JOIN rec_runs r ON r.id = l.run_id
         ORDER BY l.cluster_id"
    ))?;
    let fleet = stmt
        .query_map([], |row| {
            Ok((
                row.get(RUN_COLUMN_COUNT)?,
                run_row(row)?,
                row.get(RUN_COLUMN_COUNT + 1)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(fleet)
}

// -- Retention and clear -----------------------------------------------------------

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Drop the rows of runs `ids` and mark them thinned.
fn drop_rows(conn: &Connection, ids: &[i64]) -> Result<()> {
    let mut rows = conn.prepare_cached("DELETE FROM rec_rows WHERE run_id = ?1")?;
    let mut run = conn.prepare_cached("UPDATE rec_runs SET rows_kept = 0 WHERE id = ?1")?;
    for id in ids {
        rows.execute([id])?;
        run.execute([id])?;
    }
    Ok(())
}

fn ids(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(sql)?;
    let ids = stmt
        .query_map(params, |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

/// Retention (spec §11, steps 1–2), in one transaction:
/// 1. runs started before `rec_before` are deleted, except each cluster's
///    latest (rows cascade);
/// 2. successful runs finished before `rec_rows_before` lose their rows
///    unless they are the latest or the last successful run of their UTC
///    day (per cluster); the run and its summary stay.
///
/// Returns the runs deleted plus the runs thinned.
pub fn prune(conn: &Connection, policy: &PrunePolicy) -> Result<u64> {
    let tx = conn.unchecked_transaction()?;
    let deleted = tx.execute(
        "DELETE FROM rec_runs WHERE started < ?1
             AND id NOT IN (SELECT run_id FROM rec_latest)",
        [policy.rec_before],
    )?;
    // Rows of runs deleted without foreign keys (older connections).
    tx.execute(
        "DELETE FROM rec_rows WHERE run_id NOT IN (SELECT id FROM rec_runs)",
        [],
    )?;
    let thin = ids(
        &tx,
        "SELECT id FROM rec_runs
         WHERE status = 'success' AND rows_kept = 1 AND finished < ?1
           AND id NOT IN (SELECT run_id FROM rec_latest)
           AND id NOT IN (
               SELECT id FROM (
                   SELECT id, ROW_NUMBER() OVER (
                       PARTITION BY cluster_id, started / ?2
                       ORDER BY started DESC, id DESC
                   ) AS n
                   FROM rec_runs WHERE status = 'success'
               ) WHERE n = 1
           )",
        params![policy.rec_rows_before, DAY_MS],
    )?;
    drop_rows(&tx, &thin)?;
    tx.commit()?;
    Ok(deleted as u64 + thin.len() as u64)
}

/// Size cap: drop the rows of the oldest runs that still have them (never a
/// cluster's latest), `fraction` of them at a time (at least one). Returns
/// how many runs were thinned.
pub fn delete_oldest_rows(conn: &Connection, fraction: f64) -> Result<u64> {
    let kept = ids(
        conn,
        "SELECT id FROM rec_runs
         WHERE rows_kept = 1 AND id NOT IN (SELECT run_id FROM rec_latest)
         ORDER BY started ASC, id ASC",
        [],
    )?;
    if kept.is_empty() {
        return Ok(0);
    }
    let n = ((kept.len() as f64 * fraction).ceil() as usize).clamp(1, kept.len());
    let tx = conn.unchecked_transaction()?;
    drop_rows(&tx, &kept[..n])?;
    tx.commit()?;
    Ok(n as u64)
}

/// Delete the stored scans of `cluster_id` (every cluster with `None`):
/// the latest pointer first, then the runs and their rows.
pub fn clear(conn: &Connection, cluster_id: Option<&str>) -> Result<()> {
    for table in ["rec_latest", "rec_rows", "rec_runs"] {
        match cluster_id {
            Some(id) => {
                conn.execute(&format!("DELETE FROM {table} WHERE cluster_id = ?1"), [id])?
            }
            None => conn.execute(&format!("DELETE FROM {table}"), [])?,
        };
    }
    Ok(())
}

/// Stored rows, and the start of the oldest run.
pub fn status(conn: &Connection) -> Result<HistoryTableStatus> {
    let (rows, oldest): (i64, Option<i64>) = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM rec_rows), (SELECT MIN(started) FROM rec_runs)",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(HistoryTableStatus {
        rows: rows as u64,
        oldest_ts: oldest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::CostPricing;
    use crate::history::db;
    use crate::history::types::HistoryKind;
    use crate::recommendations::{RunStatus, ScanTrigger};
    use crate::rightsizing::math::{change_of, GIB, MIB};
    use crate::rightsizing::strategy;
    use crate::rightsizing::summary::summarize;
    use crate::rightsizing::types::{
        Change, Confidence, ContainerRecommendation, ResourceValues, RightsizingReport,
        RightsizingSettings, RightsizingSource, UsageStats, Verdict, WorkloadRecommendation,
    };
    use crate::rightsizing::workload_history::WorkloadHistory;

    const CONFIG: &str = r#"{"mode":"auto"}"#;
    const OTHER: &str = r#"{"mode":"service","namespace":"monitoring","service":"prometheus-operated","port":9090}"#;

    fn temp_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("history.db")).unwrap();
        (dir, conn)
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn scan_at(cluster: &str, started: i64) -> ScanBegin {
        ScanBegin {
            cluster_id: cluster.into(),
            started,
            trigger: ScanTrigger::Schedule,
            source_config: CONFIG.into(),
        }
    }

    fn scan_begin(cluster: &str) -> ScanBegin {
        ScanBegin {
            trigger: ScanTrigger::Manual,
            ..scan_at(cluster, 1_000)
        }
    }

    /// A Deployment in `shop` whose `app` container shrinks from 1 core /
    /// 1 GiB to `cpu` / 256 MiB.
    fn deployment(name: &str, cpu: f64, monthly_delta: f64) -> WorkloadRecommendation {
        let current = ResourceValues {
            cpu_request: Some(1000.0),
            memory_request: Some(GIB),
            ..Default::default()
        };
        let recommended = ResourceValues {
            cpu_request: Some(cpu),
            memory_request: Some(256.0 * MIB),
            ..Default::default()
        };
        let container = ContainerRecommendation {
            name: "app".into(),
            current,
            recommended,
            usage: Some(UsageStats {
                cpu_p95: cpu / 2.0,
                cpu_max: cpu,
                memory_max: 200.0 * MIB,
                hours: 168.0,
                ..Default::default()
            }),
            cpu: change_of(current.cpu_request, recommended.cpu_request),
            memory: change_of(current.memory_request, recommended.memory_request),
            memory_limit: Change::Unchanged,
            cpu_limit: Change::Unchanged,
            confidence: Confidence::High,
            warnings: Vec::new(),
            cpu_limit_raised: false,
            memory_limit_raised: false,
            evidence: None,
        };
        WorkloadRecommendation {
            kind: "Deployment".into(),
            namespace: "shop".into(),
            name: name.into(),
            uid: format!("uid-{name}"),
            replicas: 2,
            confidence: Confidence::High,
            verdict: Verdict::Over,
            coverage_hours: 168.0,
            containers: vec![container],
            monthly_delta,
            monthly_current: 40.0,
            changed: true,
            pods: vec![format!("{name}-a"), format!("{name}-b")],
            pods_truncated: false,
            hpa: None,
            lenses: Vec::new(),
            cost_replicas: 2.0,
        }
    }

    fn web() -> WorkloadRecommendation {
        deployment("web", 200.0, -20.0)
    }

    fn report_of(workloads: Vec<WorkloadRecommendation>) -> RightsizingReport {
        let pricing = CostPricing {
            currency: "USD".into(),
            cpu_hour: 0.04,
            memory_gib_hour: 0.005,
            gpu_hour: None,
            storage_gib_month: None,
            discount_percent: 0.0,
        };
        RightsizingReport {
            source: RightsizingSource::Prometheus,
            window_secs: 7 * 86_400,
            settings: WorkloadHistory::defaults(),
            currency: pricing.currency.clone(),
            pricing,
            workloads,
            notes: Vec::new(),
            strategy: "workload-history".into(),
            strategies: strategy::strategies(),
            computed_at: 900,
            strategy_auto: true,
            window_end: 950,
        }
    }

    fn success(report: RightsizingReport) -> ScanOutcome {
        ScanOutcome::Success {
            summary: summarize(&report),
            settings: report.settings.clone(),
            report,
        }
    }

    /// A finished run of `cluster` started at `started`.
    fn run(conn: &mut Connection, cluster: &str, started: i64, outcome: &ScanOutcome) -> i64 {
        let id = begin(conn, &scan_at(cluster, started)).unwrap();
        finish(conn, id, started + 10, outcome).unwrap();
        id
    }

    #[test]
    fn migration_two_applies_on_fresh_and_version_one_databases() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("fresh.db");
        assert_eq!(db::schema_version(&db::open(&fresh).unwrap()).unwrap(), 2);

        let v1 = database_with_only_migration_one(dir.path());
        assert_eq!(db::schema_version(&v1).unwrap(), 1);
        assert_eq!(db::migrate(&v1).unwrap(), 2);
        assert_eq!(count(&v1, "audit"), 1, "existing data kept");
        for table in ["rec_runs", "rec_rows", "rec_latest"] {
            assert_eq!(count(&v1, table), 0, "{table}");
        }
        assert_eq!(db::migrate(&v1).unwrap(), 2, "applied once");
    }

    /// A database as a build with only migration 1 left it, with one audit entry.
    fn database_with_only_migration_one(dir: &std::path::Path) -> Connection {
        let conn = Connection::open(dir.join("v1.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute_batch(db::MIGRATIONS[0].1).unwrap();
        conn.execute("INSERT INTO schema_version VALUES (1, 0)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO audit (ts, cluster_id, cluster_name, context, action, dry_run, outcome,
                 duration_ms, targets, has_diff, revertible, search)
             VALUES (1, 'c1', 'one', 'ctx', 'scale', 0, 'ok', 1, '[]', 0, 0, '')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn latest_moves_only_on_success() {
        let (_dir, mut conn) = temp_db();
        let a = begin(&conn, &scan_begin("c1")).unwrap();
        finish(&mut conn, a, 10, &success(report_of(vec![web()]))).unwrap();
        let b = begin(&conn, &scan_begin("c1")).unwrap();
        finish(&mut conn, b, 20, &ScanOutcome::Failed("boom".into())).unwrap();

        let read = latest(&conn, "c1", CONFIG).unwrap();
        assert!(!read.source_changed);
        let scan = read.scan.unwrap();
        assert_eq!(scan.run.id, a);
        assert_eq!(scan.run.status, RunStatus::Success);
        assert_eq!(scan.run.trigger, ScanTrigger::Manual);
        assert_eq!(scan.run.finished_at, Some(10));
        assert_eq!(scan.run.window_secs, Some(7 * 86_400));
        assert_eq!(scan.run.strategy.as_deref(), Some("workload-history"));
        assert_eq!(scan.run.source, Some(RightsizingSource::Prometheus));
        assert!(scan.run.rows_kept);
        assert_eq!(scan.run.workloads, 1);
        assert_eq!(scan.run.summary.as_ref().unwrap().workloads, 1);
        assert_eq!(scan.report.workloads, vec![web()]);
        assert_eq!(scan.report.window_end, 950);
        assert_eq!(scan.settings, WorkloadHistory::defaults());
        let failure = read.last_failure.unwrap();
        assert_eq!(failure.id, b);
        assert_eq!(failure.status, RunStatus::Failed);
        assert_eq!(failure.error.as_deref(), Some("boom"));
        assert!(failure.summary.is_none() && failure.source.is_none());

        // A later success clears the failure; other clusters see nothing.
        let c = begin(&conn, &scan_begin("c1")).unwrap();
        finish(&mut conn, c, 30, &success(report_of(vec![web()]))).unwrap();
        let read = latest(&conn, "c1", CONFIG).unwrap();
        assert_eq!(read.scan.unwrap().run.id, c);
        assert!(read.last_failure.is_none());
        let none = latest(&conn, "c2", CONFIG).unwrap();
        assert!(none.scan.is_none() && !none.source_changed && none.last_failure.is_none());
    }

    #[test]
    fn source_config_mismatch_hides_the_latest() {
        let (_dir, mut conn) = temp_db();
        run(&mut conn, "c1", 1_000, &success(report_of(vec![web()])));
        let r = latest(&conn, "c1", OTHER).unwrap();
        assert!(r.scan.is_none() && r.source_changed);
        let r = latest(&conn, "c1", CONFIG).unwrap();
        assert!(r.scan.is_some() && !r.source_changed);
    }

    #[test]
    fn running_runs_become_interrupted_on_sweep() {
        let (_dir, mut conn) = temp_db();
        let done = run(&mut conn, "c1", 500, &success(report_of(vec![web()])));
        let running = begin(&conn, &scan_begin("c1")).unwrap();
        assert_eq!(runs(&conn, "c1", 10).unwrap()[0].status, RunStatus::Running);
        assert_eq!(sweep_interrupted(&conn, 99).unwrap(), 1);
        let list = runs(&conn, "c1", 10).unwrap();
        assert_eq!(list[0].id, running);
        assert_eq!(list[0].status, RunStatus::Interrupted);
        assert_eq!(list[0].error.as_deref(), Some(ERROR_APP_RESTARTED));
        assert_eq!(list[0].finished_at, Some(99));
        assert_eq!((list[1].id, list[1].status), (done, RunStatus::Success));
        assert_eq!(sweep_interrupted(&conn, 100).unwrap(), 0);
    }

    #[test]
    fn trend_lists_kept_runs_in_time_order() {
        let (_dir, mut conn) = temp_db();
        let first = run(&mut conn, "c1", 1_000, &success(report_of(vec![web()])));
        run(&mut conn, "c1", 2_000, &ScanOutcome::Failed("boom".into()));
        let second = run(
            &mut conn,
            "c1",
            3_000,
            &success(report_of(vec![deployment("web", 300.0, -15.0)])),
        );
        run(&mut conn, "c2", 4_000, &success(report_of(vec![web()])));

        let points = trend(&conn, "c1", "Deployment/shop/web").unwrap();
        assert_eq!(points.len(), 2);
        assert_eq!((points[0].run_id, points[0].at), (first, 1_000));
        assert_eq!((points[1].run_id, points[1].at), (second, 3_000));
        assert_eq!(points[1].verdict, Verdict::Over);
        assert_eq!(points[1].confidence, Confidence::High);
        assert_eq!(points[1].monthly_delta, -15.0);
        let c = &points[1].containers[0];
        assert_eq!(c.name, "app");
        assert_eq!(
            (c.cpu_request, c.cpu_recommended),
            (Some(1000.0), Some(300.0))
        );
        assert_eq!(
            (c.memory_request, c.memory_recommended),
            (Some(GIB), Some(256.0 * MIB))
        );
        assert_eq!((c.cpu_p95, c.memory_max), (Some(150.0), Some(200.0 * MIB)));
        assert!(trend(&conn, "c1", "Deployment/shop/api")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn scans_read_rows_in_report_order_and_only_for_their_cluster() {
        let (_dir, mut conn) = temp_db();
        let big_saving = deployment("api", 100.0, -30.0);
        let unchanged = WorkloadRecommendation {
            changed: false,
            monthly_delta: 0.0,
            ..deployment("idle", 1000.0, 0.0)
        };
        let id = run(
            &mut conn,
            "c1",
            1_000,
            &success(report_of(vec![unchanged, web(), big_saving])),
        );
        let stored = scan(&conn, "c1", id).unwrap().unwrap();
        let names: Vec<&str> = stored
            .report
            .workloads
            .iter()
            .map(|w| w.name.as_str())
            .collect();
        assert_eq!(names, vec!["api", "web", "idle"]);
        assert_eq!(count(&conn, "rec_rows"), 3);
        assert!(scan(&conn, "c2", id).unwrap().is_none(), "another cluster");
        let failed = run(&mut conn, "c1", 2_000, &ScanOutcome::Failed("x".into()));
        assert!(scan(&conn, "c1", failed).unwrap().is_none(), "no report");
        assert_eq!(row_key("Deployment", "shop", "web"), "Deployment/shop/web");
    }

    #[test]
    fn finishing_a_removed_or_finished_run_changes_nothing() {
        let (_dir, mut conn) = temp_db();
        let id = begin(&conn, &scan_begin("c1")).unwrap();
        // The cluster's history was cleared while the scan ran.
        conn.execute("DELETE FROM rec_runs WHERE id = ?1", [id])
            .unwrap();
        finish(&mut conn, id, 10, &success(report_of(vec![web()]))).unwrap();
        assert_eq!(count(&conn, "rec_rows"), 0);
        assert_eq!(count(&conn, "rec_latest"), 0);

        // The first finish wins: a late interruption does not undo a success.
        let id = begin(&conn, &scan_begin("c1")).unwrap();
        finish(&mut conn, id, 10, &success(report_of(vec![web()]))).unwrap();
        finish(
            &mut conn,
            id,
            20,
            &ScanOutcome::Interrupted("stopped".into()),
        )
        .unwrap();
        let only = &runs(&conn, "c1", 10).unwrap()[0];
        assert_eq!(
            (only.status, only.finished_at),
            (RunStatus::Success, Some(10))
        );
        assert_eq!(only.error, None);
    }

    #[test]
    fn runs_last_attempt_and_fleet() {
        let (_dir, mut conn) = temp_db();
        assert!(last_attempt(&conn, "c1").unwrap().is_none());
        let a = run(&mut conn, "c1", 1_000, &success(report_of(vec![web()])));
        run(
            &mut conn,
            "c1",
            2_000,
            &ScanOutcome::Interrupted("stopped".into()),
        );
        let c = begin(&conn, &scan_at("c1", 3_000)).unwrap();
        let other = run(&mut conn, "c2", 1_500, &success(report_of(vec![web()])));

        let list = runs(&conn, "c1", 10).unwrap();
        let ids: Vec<i64> = list.iter().map(|r| r.id).collect();
        assert_eq!(ids.first(), Some(&c), "newest first");
        assert_eq!(ids.len(), 3);
        assert_eq!(runs(&conn, "c1", 1).unwrap().len(), 1);
        assert_eq!(runs(&conn, "c1", 0).unwrap().len(), 1, "at least one");
        let last = last_attempt(&conn, "c1").unwrap().unwrap();
        assert_eq!((last.id, last.status), (c, RunStatus::Running));
        assert_eq!(last.trigger, ScanTrigger::Schedule);

        let fleet = fleet(&conn).unwrap();
        let summary: Vec<(String, i64, String)> = fleet
            .iter()
            .map(|(id, run, config)| (id.clone(), run.id, config.clone()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("c1".to_string(), a, CONFIG.to_string()),
                ("c2".to_string(), other, CONFIG.to_string())
            ]
        );
    }

    #[test]
    fn rows_from_older_builds_still_read() {
        let (_dir, conn) = temp_db();
        // A report without strategy_auto / window_end, settings without the
        // evidence thresholds, a NULL summary, and a row without pods / hpa /
        // lenses / cost_replicas / evidence / usage averages.
        let report = r#"{"source":"prometheus","window_secs":604800,
            "settings":{"cpu_headroom_percent":15.0,"memory_headroom_percent":20.0,
                "memory_limit_headroom_percent":40.0,"min_cpu_millicores":10.0,
                "min_memory_bytes":33554432.0,"days":7},
            "currency":"USD","pricing":{"currency":"USD","cpu_hour":0.04,"memory_gib_hour":0.005},
            "workloads":[],"notes":[],"strategy":"percentile-headroom","strategies":[],
            "computed_at":5}"#;
        let row = r#"{"kind":"Deployment","namespace":"shop","name":"legacy","uid":"u1",
            "replicas":2,"confidence":"high","verdict":"over","coverage_hours":168.0,
            "containers":[{"name":"app",
                "current":{"cpu_request":1000.0,"cpu_limit":null,"memory_request":1073741824.0,"memory_limit":null},
                "recommended":{"cpu_request":140.0,"cpu_limit":null,"memory_request":385875968.0,"memory_limit":null},
                "usage":{"cpu_p95":120.0,"cpu_max":300.0,"memory_max":314572800.0,"hours":168.0},
                "cpu":"decrease","memory":"decrease","memory_limit":"unchanged","cpu_limit":"unchanged",
                "confidence":"high","warnings":[],"cpu_limit_raised":false,"memory_limit_raised":false}],
            "monthly_delta":-12.5,"monthly_current":30.0,"changed":true}"#;
        for (id, report) in [(1, Some(report)), (2, None)] {
            conn.execute(
                "INSERT INTO rec_runs (id, cluster_id, started, finished, status, trigger, source,
                     strategy, source_config, settings, window_start, window_end, workloads,
                     summary, report, rows_kept)
                 VALUES (?1, 'c1', 1, 2, 'success', 'schedule', 'prometheus', 'percentile-headroom',
                     ?2, NULL, NULL, NULL, 1, NULL, ?3, 1)",
                rusqlite::params![id, CONFIG, report],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rec_rows (run_id, cluster_id, key, namespace, kind, name, verdict,
                     confidence, changed, monthly_delta, row)
                 VALUES (?1, 'c1', 'Deployment/shop/legacy', 'shop', 'Deployment', 'legacy',
                     'over', 'high', 1, -12.5, ?2)",
                rusqlite::params![id, row],
            )
            .unwrap();
        }
        let old = scan(&conn, "c1", 1).unwrap().unwrap();
        assert_eq!(old.report.workloads[0].name, "legacy");
        assert!(old.report.workloads[0].pods.is_empty());
        assert!(old.run.summary.is_none() && old.run.window_secs.is_none());
        assert_eq!(old.report.window_end, 0);
        assert_eq!(old.settings.min_hours, 24.0, "missing thresholds default");
        assert_eq!(old.settings.cpu_headroom_percent, 15.0, "from the report");

        let bare = scan(&conn, "c1", 2).unwrap().unwrap();
        assert_eq!(bare.report.workloads[0].name, "legacy");
        assert_eq!(bare.report.strategy, "percentile-headroom");
        assert_eq!(bare.report.source, RightsizingSource::Prometheus);
        assert_eq!(bare.settings, RightsizingSettings::default());
        assert_eq!(
            trend(&conn, "c1", "Deployment/shop/legacy").unwrap().len(),
            2
        );
    }

    const HOUR: i64 = 60 * 60 * 1000;
    const DAY: i64 = 24 * HOUR;

    /// Retention as of `now` with the default 30 days.
    fn policy(now: i64) -> PrunePolicy {
        PrunePolicy {
            audit_before: 0,
            data_before: 0,
            max_bytes: u64::MAX,
            rec_before: now - 30 * DAY,
            rec_rows_before: now - 48 * HOUR,
        }
    }

    fn rows_of(conn: &Connection, run_id: i64) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM rec_rows WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn kept_runs(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn
            .prepare("SELECT id FROM rec_runs WHERE rows_kept = 1 ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn retention_deletes_old_runs_but_keeps_the_latest() {
        let (_dir, mut conn) = temp_db();
        let d0 = 20_000 * DAY;
        let old = run(&mut conn, "c1", d0, &success(report_of(vec![web()])));
        let latest_c1 = run(
            &mut conn,
            "c1",
            d0 + 5 * DAY,
            &success(report_of(vec![web()])),
        );
        let failed = run(
            &mut conn,
            "c1",
            d0 + 6 * DAY,
            &ScanOutcome::Failed("x".into()),
        );
        let recent = run(
            &mut conn,
            "c1",
            d0 + 35 * DAY,
            &ScanOutcome::Failed("y".into()),
        );
        // Another cluster's only run: its latest, older than the retention.
        let latest_c2 = run(&mut conn, "c2", d0, &success(report_of(vec![web()])));

        let removed = prune(&conn, &policy(d0 + 40 * DAY)).unwrap();
        assert_eq!(removed, 2, "the old success and the old failure");
        let ids: Vec<i64> = runs(&conn, "c1", 10)
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec![recent, latest_c1]);
        assert!(!ids.contains(&old) && !ids.contains(&failed));
        assert_eq!(rows_of(&conn, old), 0, "rows cascade");
        assert_eq!(rows_of(&conn, latest_c1), 1);
        assert_eq!(
            latest(&conn, "c2", CONFIG).unwrap().scan.unwrap().run.id,
            latest_c2
        );
    }

    #[test]
    fn thinning_keeps_48_hours_then_one_run_per_day() {
        let (_dir, mut conn) = temp_db();
        // Hourly runs over 4 UTC days, each 30 minutes past the hour.
        let d0 = 20_000 * DAY;
        let ids: Vec<i64> = (0..96)
            .map(|h| {
                run(
                    &mut conn,
                    "c1",
                    d0 + h * HOUR + 30 * 60 * 1000,
                    &success(report_of(vec![web()])),
                )
            })
            .collect();
        let thinned = prune(&conn, &policy(d0 + 96 * HOUR)).unwrap();
        assert_eq!(thinned, 48 - 2, "the older days keep one run each");
        let kept = kept_runs(&conn);
        assert_eq!(kept.len(), 48 + 2);
        assert!(
            kept.contains(&ids[23]) && kept.contains(&ids[47]),
            "last run of each older day"
        );
        assert!(!kept.contains(&ids[22]) && !kept.contains(&ids[0]));
        assert!(kept.contains(&ids[95]), "the latest run");
        assert_eq!(count(&conn, "rec_rows"), 50);
        assert_eq!(count(&conn, "rec_runs"), 96, "runs and summaries stay");
        let thin = runs(&conn, "c1", 500).unwrap();
        let first = thin.iter().find(|r| r.id == ids[0]).unwrap();
        assert!(!first.rows_kept && first.summary.is_some());
        let stored = scan(&conn, "c1", ids[0]).unwrap().unwrap();
        assert!(
            stored.report.workloads.is_empty(),
            "a thinned run has no rows"
        );
        assert_eq!(trend(&conn, "c1", "Deployment/shop/web").unwrap().len(), 50);
        assert_eq!(
            prune(&conn, &policy(d0 + 96 * HOUR)).unwrap(),
            0,
            "idempotent"
        );
    }

    #[test]
    fn the_latest_run_keeps_its_rows_however_old() {
        let (_dir, mut conn) = temp_db();
        let d0 = 20_000 * DAY;
        let a = run(&mut conn, "c1", d0, &success(report_of(vec![web()])));
        let b = run(&mut conn, "c1", d0 + HOUR, &success(report_of(vec![web()])));
        prune(&conn, &policy(d0 + 10 * DAY)).unwrap();
        assert_eq!(kept_runs(&conn), vec![b], "same day: only the last one");
        assert_eq!(rows_of(&conn, a), 0);
        assert_eq!(
            delete_oldest_rows(&conn, 0.1).unwrap(),
            0,
            "never the latest"
        );
        assert_eq!(rows_of(&conn, b), 1);
    }

    /// Five audit entries and ten runs of 30 bulky workloads each (30 × 50
    /// long pod names per run); returns the run ids, oldest first.
    fn audit_and_bulky_runs(conn: &mut Connection) -> Vec<i64> {
        conn.execute_batch(
            &"INSERT INTO audit (ts, cluster_id, cluster_name, context, action, dry_run,
                 outcome, duration_ms, targets, has_diff, revertible, search)
             VALUES (1, 'c1', 'one', 'ctx', 'scale', 0, 'ok', 1, '[]', 0, 0, '');"
                .repeat(5),
        )
        .unwrap();
        let bulky = || {
            let workloads = (0..30)
                .map(|i| WorkloadRecommendation {
                    pods: (0..50)
                        .map(|p| format!("{i}-{p}-{}", "x".repeat(80)))
                        .collect(),
                    ..deployment(&format!("w{i}"), 200.0, -1.0)
                })
                .collect();
            success(report_of(workloads))
        };
        (0..10)
            .map(|i| run(conn, "c1", 1_000 + i, &bulky()))
            .collect()
    }

    /// Only the size cap: no retention cutoff applies.
    fn size_cap(max_bytes: u64) -> PrunePolicy {
        PrunePolicy {
            max_bytes,
            rec_before: 0,
            rec_rows_before: 0,
            ..policy(0)
        }
    }

    #[test]
    fn size_cap_drops_recommendation_rows_before_the_audit_log() {
        let (_dir, mut conn) = temp_db();
        let ids = audit_and_bulky_runs(&mut conn);
        let before = count(&conn, "rec_rows");
        assert_eq!(before, 300);
        assert!(db::used_bytes(&conn).unwrap() > 1_000_000);

        let report = db::prune(&conn, &size_cap(400_000)).unwrap();
        assert!(db::used_bytes(&conn).unwrap() <= 400_000);
        assert!(count(&conn, "audit") > 0 && count(&conn, "rec_rows") < before);
        assert_eq!(count(&conn, "audit"), 5, "the audit log is untouched");
        assert!(report.recommendations > 0 && report.audit == 0);
        assert_eq!(rows_of(&conn, ids[9]), 30, "the latest run keeps its rows");
        assert_eq!(rows_of(&conn, ids[0]), 0, "the oldest go first");
        assert_eq!(count(&conn, "rec_runs"), 10);
    }

    #[test]
    fn size_cap_is_reached_behind_many_events_and_changes() {
        let (_dir, mut conn) = temp_db();
        let ids = audit_and_bulky_runs(&mut conn);
        // Far more events and changes than 40 rounds of 10 % can clear.
        let tx = conn.transaction().unwrap();
        let padding = "y".repeat(200);
        for i in 0..3_000 {
            tx.execute(
                "INSERT INTO events (cluster_id, uid, count, last_ts, object, search)
                 VALUES ('c1', ?1, 1, ?2, ?3, '')",
                rusqlite::params![format!("e{i}"), i, padding],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO changes (cluster_id, journal_started, journal_id, ts, kind, name,
                     summary, omitted, search)
                 VALUES ('c1', 1, ?1, ?1, 'ConfigMap', 'cfg', ?2, 0, '')",
                rusqlite::params![i, padding],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        assert!(db::used_bytes(&conn).unwrap() > 2_500_000);

        let report = db::prune(&conn, &size_cap(400_000)).unwrap();
        assert!(
            db::used_bytes(&conn).unwrap() <= 400_000,
            "the cap is reached"
        );
        assert_eq!((count(&conn, "events"), count(&conn, "changes")), (0, 0));
        assert_eq!((report.events, report.changes), (3_000, 3_000));
        assert!(report.recommendations > 0, "then recommendation rows");
        assert_eq!(rows_of(&conn, ids[9]), 30, "never the latest run's rows");
        assert_eq!(count(&conn, "audit"), 5, "the audit log goes last");
    }

    #[test]
    fn clearing_recommendations_per_cluster() {
        let (_dir, mut conn) = temp_db();
        run(&mut conn, "c1", 1_000, &success(report_of(vec![web()])));
        run(&mut conn, "c1", 2_000, &ScanOutcome::Failed("x".into()));
        run(&mut conn, "c2", 1_500, &success(report_of(vec![web()])));
        let status = status(&conn).unwrap();
        assert_eq!((status.rows, status.oldest_ts), (2, Some(1_000)));

        clear(&conn, Some("c1")).unwrap();
        assert!(latest(&conn, "c1", CONFIG).unwrap().scan.is_none());
        assert!(runs(&conn, "c1", 10).unwrap().is_empty());
        assert!(latest(&conn, "c2", CONFIG).unwrap().scan.is_some());
        let status = self::status(&conn).unwrap();
        assert_eq!((status.rows, status.oldest_ts), (1, Some(1_500)));

        // Through history_clear's kinds: `recommendations` and `all`.
        db::clear(&conn, HistoryKind::Recommendations, Some("c2")).unwrap();
        assert!(fleet(&conn).unwrap().is_empty());
        run(&mut conn, "c3", 3_000, &success(report_of(vec![web()])));
        db::clear(&conn, HistoryKind::All, None).unwrap();
        for table in ["rec_runs", "rec_rows", "rec_latest"] {
            assert_eq!(count(&conn, table), 0, "{table}");
        }
        assert_eq!(self::status(&conn).unwrap(), HistoryTableStatus::default());
    }
}
