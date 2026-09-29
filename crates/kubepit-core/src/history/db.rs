//! `history.db`: schema, migrations, writes (used by the writer thread only)
//! and queries (a separate read connection; WAL lets both run at once).
//!
//! - `schema_version` records every applied migration; a database written
//!   by a newer Kubepit is refused instead of being "migrated" backwards.
//! - Pages are reclaimed incrementally (`auto_vacuum = INCREMENTAL`, set
//!   before the first table exists); a full `VACUUM` only runs after a clear
//!   or when a prune left most of the file free.
//! - Paging is newest first with an opaque `"<ts>:<id>"` cursor (audit,
//!   events) or the row id (changes, which are inserted in time order).

use std::path::Path;

use anyhow::{bail, Context, Result};
use rusqlite::types::Value as Sql;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde_json::Value;

use super::recommendations;
use super::types::{
    AuditAction, AuditDetail, AuditEntry, AuditFilter, AuditObject, AuditOutcome, AuditPage,
    AuditTarget, HistoryChangePage, HistoryEventFilter, HistoryEventPage, HistoryKind,
    HistoryTableStatus,
};
use crate::change_journal::{ChangeDetail, ChangeFilter, ChangeSummary};

/// Largest page any query returns.
pub const MAX_PAGE: u32 = 1000;
/// Most entries `history_audit_export` writes.
pub const MAX_EXPORT: u32 = 100_000;

/// Every migration, in order. Never edit a released one; append.
pub(crate) const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        r#"
CREATE TABLE audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    cluster_id   TEXT    NOT NULL,
    cluster_name TEXT    NOT NULL,
    context      TEXT    NOT NULL,
    identity     TEXT,
    action       TEXT    NOT NULL,
    dry_run      INTEGER NOT NULL,
    outcome      TEXT    NOT NULL,
    error        TEXT,
    duration_ms  INTEGER NOT NULL,
    targets      TEXT    NOT NULL,
    request      TEXT,
    result       TEXT,
    has_diff     INTEGER NOT NULL,
    revertible   INTEGER NOT NULL,
    search       TEXT    NOT NULL
);
CREATE INDEX audit_ts ON audit (ts DESC, id DESC);
CREATE INDEX audit_cluster_ts ON audit (cluster_id, ts DESC);

CREATE TABLE audit_objects (
    audit_id   INTEGER NOT NULL REFERENCES audit (id) ON DELETE CASCADE,
    target     INTEGER NOT NULL,
    before     TEXT,
    after      TEXT,
    omitted    INTEGER NOT NULL,
    revertible INTEGER NOT NULL,
    PRIMARY KEY (audit_id, target)
);

CREATE TABLE events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id         TEXT    NOT NULL,
    uid                TEXT    NOT NULL,
    namespace          TEXT,
    involved_kind      TEXT,
    involved_name      TEXT,
    involved_uid       TEXT,
    type               TEXT,
    reason             TEXT,
    count              INTEGER NOT NULL,
    last_ts            INTEGER NOT NULL,
    object             TEXT    NOT NULL,
    search             TEXT    NOT NULL,
    UNIQUE (cluster_id, uid)
);
CREATE INDEX events_cluster_ts ON events (cluster_id, last_ts DESC, id DESC);
CREATE INDEX events_involved ON events (cluster_id, involved_uid);
CREATE INDEX events_ts ON events (last_ts);

CREATE TABLE changes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id      TEXT    NOT NULL,
    journal_started INTEGER NOT NULL,
    journal_id      INTEGER NOT NULL,
    ts              INTEGER NOT NULL,
    kind            TEXT    NOT NULL,
    namespace       TEXT,
    name            TEXT    NOT NULL,
    summary         TEXT    NOT NULL,
    before_yaml     TEXT,
    after_yaml      TEXT,
    omitted         INTEGER NOT NULL,
    search          TEXT    NOT NULL,
    UNIQUE (cluster_id, journal_started, journal_id)
);
CREATE INDEX changes_cluster_id ON changes (cluster_id, id DESC);
CREATE INDEX changes_ts ON changes (ts);
"#,
    ),
    (2, recommendations::MIGRATION),
];

/// Newest schema this build knows.
pub fn latest_version() -> i64 {
    MIGRATIONS.last().map_or(0, |(v, _)| *v)
}

/// Open (creating and migrating) the database at `path`.
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;
    }
    let conn =
        Connection::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    set_private(path);
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    // Must precede the first table of a fresh database to take effect.
    let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    if pages == 0 {
        conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
    }
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        tracing::debug!("history.db journal mode is {mode}");
    }
    conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

#[cfg(unix)]
fn set_private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private(_path: &Path) {}

/// Apply every pending migration; returns the resulting version.
pub fn migrate(conn: &Connection) -> Result<i64> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
             version    INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
         );",
    )?;
    let latest = latest_version();
    let current = schema_version(conn)?;
    if current > latest {
        bail!("history.db uses schema version {current}, newer than this Kubepit ({latest})");
    }
    for (version, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        // IMMEDIATE: a second connection migrating at the same time waits,
        // then sees the version already applied.
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let applied = (|| -> Result<()> {
            if schema_version(conn)? >= *version {
                return Ok(());
            }
            conn.execute_batch(sql)
                .with_context(|| format!("history.db migration {version} failed"))?;
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?1, ?2)",
                params![version, crate::objects::now_millis()],
            )?;
            Ok(())
        })();
        match applied {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    schema_version(conn)
}

pub fn schema_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |r| r.get(0),
    )?)
}

// -- Rows written by the writer ------------------------------------------------

/// Before/after of one audit target, already redacted (compact JSON).
#[derive(Debug, Clone, PartialEq)]
pub struct AuditObjectRecord {
    pub target: u32,
    pub before: Option<String>,
    pub after: Option<String>,
    pub omitted: bool,
    pub revertible: bool,
}

/// A finished action, ready to insert.
#[derive(Debug, Clone, PartialEq)]
pub struct AuditRecord {
    pub ts: i64,
    pub cluster_id: String,
    pub cluster_name: String,
    pub context: String,
    pub identity: Option<String>,
    pub action: AuditAction,
    pub dry_run: bool,
    pub outcome: AuditOutcome,
    pub error: Option<String>,
    pub duration_ms: i64,
    pub targets: Vec<AuditTarget>,
    pub request: Option<Value>,
    pub result: Option<String>,
    pub objects: Vec<AuditObjectRecord>,
}

impl AuditRecord {
    fn search(&self) -> String {
        let mut text = format!(
            "{} {} {} {}",
            self.cluster_name,
            self.context,
            self.identity.as_deref().unwrap_or(""),
            self.action.as_str()
        );
        for target in &self.targets {
            text.push(' ');
            text.push_str(&target.label());
            if let Some(e) = &target.error {
                text.push(' ');
                text.push_str(e);
            }
        }
        for extra in [&self.error, &self.result].into_iter().flatten() {
            text.push(' ');
            text.push_str(extra);
        }
        text.to_lowercase()
    }
}

/// One Kubernetes Event (upserted by uid: repeats bump count and last_ts).
#[derive(Debug, Clone, PartialEq)]
pub struct EventRow {
    pub cluster_id: String,
    pub uid: String,
    pub namespace: Option<String>,
    pub involved_kind: Option<String>,
    pub involved_name: Option<String>,
    pub involved_uid: Option<String>,
    pub event_type: Option<String>,
    pub reason: Option<String>,
    pub count: i64,
    pub last_ts: i64,
    /// The Event as JSON (managedFields stripped).
    pub object: String,
    pub search: String,
}

impl EventRow {
    /// `None` for objects that are not usable Events (no uid).
    pub fn from_event(cluster_id: &str, event: &Value) -> Option<Self> {
        let s = |pointer: &str| {
            event
                .pointer(pointer)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        let uid = s("/metadata/uid")?;
        let mut object = event.clone();
        crate::objects::strip_managed_fields(&mut object);
        let count = event
            .get("count")
            .and_then(Value::as_i64)
            .or_else(|| event.pointer("/series/count").and_then(Value::as_i64))
            .unwrap_or(1);
        let row = Self {
            cluster_id: cluster_id.to_string(),
            uid,
            namespace: s("/metadata/namespace"),
            involved_kind: s("/involvedObject/kind"),
            involved_name: s("/involvedObject/name"),
            involved_uid: s("/involvedObject/uid"),
            event_type: s("/type"),
            reason: s("/reason"),
            count,
            last_ts: crate::objects::event_time_millis(event),
            search: format!(
                "{} {} {}/{} {} {}",
                s("/reason").unwrap_or_default(),
                s("/involvedObject/kind").unwrap_or_default(),
                s("/metadata/namespace").unwrap_or_default(),
                s("/involvedObject/name").unwrap_or_default(),
                s("/message").unwrap_or_default(),
                s("/type").unwrap_or_default(),
            )
            .to_lowercase(),
            object: serde_json::to_string(&object).ok()?,
        };
        Some(row)
    }
}

/// One change-journal entry (idempotent per journal and entry id).
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeRow {
    pub cluster_id: String,
    pub journal_started: i64,
    pub journal_id: i64,
    pub summary: ChangeSummary,
    pub before_yaml: Option<String>,
    pub after_yaml: Option<String>,
    pub omitted: bool,
}

impl ChangeRow {
    fn search(&self) -> String {
        let s = &self.summary;
        let mut text = format!(
            "{} {}/{} {}",
            s.gvk.kind,
            s.namespace.as_deref().unwrap_or(""),
            s.name,
            s.actor.as_ref().map_or("", |a| a.manager.as_str())
        );
        for p in &s.paths {
            text.push(' ');
            text.push_str(&p.path);
            if !p.redacted {
                for v in [&p.before, &p.after].into_iter().flatten() {
                    text.push(' ');
                    text.push_str(v);
                }
            }
        }
        text.to_lowercase()
    }
}

pub fn insert_audit(tx: &Transaction<'_>, record: &AuditRecord) -> Result<i64> {
    let has_diff = record
        .objects
        .iter()
        .any(|o| !o.omitted && (o.before.is_some() || o.after.is_some()));
    let revertible = record.objects.iter().any(|o| o.revertible);
    tx.execute(
        "INSERT INTO audit (ts, cluster_id, cluster_name, context, identity, action, dry_run,
             outcome, error, duration_ms, targets, request, result, has_diff, revertible, search)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            record.ts,
            record.cluster_id,
            record.cluster_name,
            record.context,
            record.identity,
            record.action.as_str(),
            record.dry_run,
            record.outcome.as_str(),
            record.error,
            record.duration_ms,
            serde_json::to_string(&record.targets)?,
            record
                .request
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            record.result,
            has_diff,
            revertible,
            record.search(),
        ],
    )?;
    let id = tx.last_insert_rowid();
    for object in &record.objects {
        tx.execute(
            "INSERT OR REPLACE INTO audit_objects (audit_id, target, before, after, omitted, revertible)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                object.target,
                object.before,
                object.after,
                object.omitted,
                object.revertible
            ],
        )?;
    }
    Ok(id)
}

pub fn upsert_events(tx: &Transaction<'_>, rows: &[EventRow]) -> Result<()> {
    let mut stmt = tx.prepare_cached(
        "INSERT INTO events (cluster_id, uid, namespace, involved_kind, involved_name,
             involved_uid, type, reason, count, last_ts, object, search)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (cluster_id, uid) DO UPDATE SET
             count = excluded.count, last_ts = MAX(last_ts, excluded.last_ts),
             type = excluded.type, reason = excluded.reason,
             object = excluded.object, search = excluded.search",
    )?;
    for row in rows {
        stmt.execute(params![
            row.cluster_id,
            row.uid,
            row.namespace,
            row.involved_kind,
            row.involved_name,
            row.involved_uid,
            row.event_type,
            row.reason,
            row.count,
            row.last_ts,
            row.object,
            row.search,
        ])?;
    }
    Ok(())
}

pub fn insert_changes(tx: &Transaction<'_>, rows: &[ChangeRow]) -> Result<()> {
    let mut stmt = tx.prepare_cached(
        "INSERT OR IGNORE INTO changes (cluster_id, journal_started, journal_id, ts, kind,
             namespace, name, summary, before_yaml, after_yaml, omitted, search)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )?;
    for row in rows {
        stmt.execute(params![
            row.cluster_id,
            row.journal_started,
            row.journal_id,
            row.summary.ts,
            row.summary.gvk.kind,
            row.summary.namespace,
            row.summary.name,
            serde_json::to_string(&row.summary)?,
            row.before_yaml,
            row.after_yaml,
            row.omitted,
            row.search(),
        ])?;
    }
    Ok(())
}

/// Delete rows of `kind` (optionally of one cluster).
pub fn clear(conn: &Connection, kind: HistoryKind, cluster_id: Option<&str>) -> Result<()> {
    let tables: &[&str] = match kind {
        HistoryKind::Audit => &["audit"],
        HistoryKind::Events => &["events"],
        HistoryKind::Changes => &["changes"],
        HistoryKind::Recommendations => &[],
        HistoryKind::All => &["audit", "events", "changes"],
    };
    if matches!(kind, HistoryKind::Recommendations | HistoryKind::All) {
        recommendations::clear(conn, cluster_id)?;
    }
    for table in tables {
        match cluster_id {
            Some(id) => {
                conn.execute(&format!("DELETE FROM {table} WHERE cluster_id = ?1"), [id])?
            }
            None => conn.execute(&format!("DELETE FROM {table}"), [])?,
        };
    }
    // Orphans left by rows deleted without foreign keys (older connections).
    conn.execute(
        "DELETE FROM audit_objects WHERE audit_id NOT IN (SELECT id FROM audit)",
        [],
    )?;
    Ok(())
}

// -- Retention -----------------------------------------------------------------

/// What pruning keeps (epoch ms cutoffs and a byte budget).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrunePolicy {
    /// Audit entries older than this are deleted.
    pub audit_before: i64,
    /// Events and changes older than this are deleted.
    pub data_before: i64,
    /// Upper bound of the live pages (database without free pages).
    pub max_bytes: u64,
    /// Recommendation runs started before this are deleted (except the
    /// latest of each cluster).
    pub rec_before: i64,
    /// Successful runs finished before this keep their rows only when they
    /// are the latest or the last successful run of their UTC day.
    pub rec_rows_before: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PruneReport {
    pub audit: u64,
    pub events: u64,
    pub changes: u64,
    /// Recommendation runs deleted or stripped of their rows.
    pub recommendations: u64,
    pub vacuumed: bool,
}

/// Bytes held by pages in use.
pub fn used_bytes(conn: &Connection) -> Result<u64> {
    let (pages, free, size): (i64, i64, i64) = conn.query_row(
        "SELECT (SELECT page_count FROM pragma_page_count()),
                (SELECT freelist_count FROM pragma_freelist_count()),
                (SELECT page_size FROM pragma_page_size())",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    Ok(((pages - free).max(0) * size) as u64)
}

/// Share of a table one size-cap round deletes.
const CAP_FRACTION: f64 = 0.1;
/// Rows one size-cap round deletes at least (while the table has them), so
/// a table of any size empties in about a hundred rounds instead of
/// crawling one row at a time through its tail.
const CAP_MIN_ROWS: i64 = 100;
/// Safety net only: every round deletes something or ends the loop.
const CAP_MAX_ROUNDS: u32 = 10_000;

fn delete_oldest(conn: &Connection, table: &str, ts: &str, fraction: f64) -> Result<u64> {
    let rows: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
    if rows == 0 {
        return Ok(0);
    }
    let n = ((rows as f64 * fraction).ceil() as i64).max(CAP_MIN_ROWS);
    let deleted = conn.execute(
        &format!(
            "DELETE FROM {table} WHERE id IN (SELECT id FROM {table} ORDER BY {ts} ASC, id ASC LIMIT ?1)"
        ),
        [n],
    )?;
    Ok(deleted as u64)
}

/// Apply retention (and the thinning of recommendation scans), then the
/// size cap (oldest events and changes first, then the rows of the oldest
/// recommendation scans, the audit log only when nothing else is left),
/// then reclaim space.
pub fn prune(conn: &Connection, policy: &PrunePolicy) -> Result<PruneReport> {
    let mut report = PruneReport {
        audit: conn.execute("DELETE FROM audit WHERE ts < ?1", [policy.audit_before])? as u64,
        events: conn.execute(
            "DELETE FROM events WHERE last_ts < ?1",
            [policy.data_before],
        )? as u64,
        changes: conn.execute("DELETE FROM changes WHERE ts < ?1", [policy.data_before])? as u64,
        recommendations: recommendations::prune(conn, policy)?,
        vacuumed: false,
    };
    // Until the cap is reached or nothing is left to delete: a fixed number
    // of rounds could stop in bulky events before reaching the scans.
    let mut rounds = 0;
    while used_bytes(conn)? > policy.max_bytes && rounds < CAP_MAX_ROUNDS {
        rounds += 1;
        let events = delete_oldest(conn, "events", "last_ts", CAP_FRACTION)?;
        let changes = delete_oldest(conn, "changes", "ts", CAP_FRACTION)?;
        report.events += events;
        report.changes += changes;
        if events + changes > 0 {
            continue;
        }
        let scans = recommendations::delete_oldest_rows(conn, CAP_FRACTION)?;
        report.recommendations += scans;
        if scans > 0 {
            continue;
        }
        let audit = delete_oldest(conn, "audit", "ts", CAP_FRACTION)?;
        if audit == 0 {
            break;
        }
        report.audit += audit;
    }
    conn.execute(
        "DELETE FROM audit_objects WHERE audit_id NOT IN (SELECT id FROM audit)",
        [],
    )?;
    if report.audit + report.events + report.changes + report.recommendations > 0 {
        report.vacuumed = reclaim(conn)?;
    }
    Ok(report)
}

/// Return free pages to the file system: incrementally, or with a full
/// `VACUUM` when most of the file is free (e.g. a database created before
/// incremental auto-vacuum). Returns whether a full vacuum ran.
pub fn reclaim(conn: &Connection) -> Result<bool> {
    let (pages, free, auto): (i64, i64, i64) = conn.query_row(
        "SELECT (SELECT page_count FROM pragma_page_count()),
                (SELECT freelist_count FROM pragma_freelist_count()),
                (SELECT auto_vacuum FROM pragma_auto_vacuum())",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let full = auto != 2 && free * 4 > pages && free > 256;
    if full {
        vacuum(conn)?;
    } else if free > 0 {
        conn.execute_batch("PRAGMA incremental_vacuum;")?;
    }
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    Ok(full)
}

pub fn vacuum(conn: &Connection) -> Result<()> {
    conn.execute_batch("VACUUM;")?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    Ok(())
}

// -- Queries -------------------------------------------------------------------

fn like_pattern(text: &str) -> String {
    let escaped = text
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn clean_text(text: &Option<String>) -> Option<String> {
    text.as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

fn page_limit(limit: u32) -> i64 {
    i64::from(limit.clamp(1, MAX_PAGE))
}

/// `"<ts>:<id>"` → `(ts, id)`.
pub fn parse_cursor(cursor: &str) -> Option<(i64, i64)> {
    let (ts, id) = cursor.split_once(':')?;
    Some((ts.parse().ok()?, id.parse().ok()?))
}

pub fn cursor_of(ts: i64, id: i64) -> String {
    format!("{ts}:{id}")
}

/// `IN (?, ?, …)` for `values`, pushing them onto `args`.
fn in_list(values: impl IntoIterator<Item = String>, args: &mut Vec<Sql>) -> String {
    let marks: Vec<&str> = values
        .into_iter()
        .map(|v| {
            args.push(Sql::Text(v));
            "?"
        })
        .collect();
    format!("({})", marks.join(", "))
}

fn audit_where(filter: &AuditFilter, args: &mut Vec<Sql>) -> String {
    let mut clauses = vec!["1 = 1".to_string()];
    if !filter.cluster_ids.is_empty() {
        let list = in_list(filter.cluster_ids.iter().cloned(), args);
        clauses.push(format!("cluster_id IN {list}"));
    }
    if !filter.actions.is_empty() {
        let list = in_list(filter.actions.iter().map(|a| a.as_str().to_string()), args);
        clauses.push(format!("action IN {list}"));
    }
    if let Some(outcome) = filter.outcome {
        args.push(Sql::Text(outcome.as_str().into()));
        clauses.push("outcome = ?".into());
    }
    if let Some(text) = clean_text(&filter.text) {
        args.push(Sql::Text(like_pattern(&text)));
        clauses.push("search LIKE ? ESCAPE '\\'".into());
    }
    if let Some(since) = filter.since {
        args.push(Sql::Integer(since));
        clauses.push("ts >= ?".into());
    }
    if let Some(until) = filter.until {
        args.push(Sql::Integer(until));
        clauses.push("ts <= ?".into());
    }
    clauses.join(" AND ")
}

const AUDIT_COLUMNS: &str = "id, ts, cluster_id, cluster_name, context, identity, action, dry_run,
    outcome, error, duration_ms, targets, request, result, has_diff, revertible";

fn audit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditEntry> {
    let action: String = row.get(6)?;
    let outcome: String = row.get(8)?;
    let targets: String = row.get(11)?;
    let request: Option<String> = row.get(12)?;
    Ok(AuditEntry {
        id: row.get(0)?,
        ts: row.get(1)?,
        cluster_id: row.get(2)?,
        cluster_name: row.get(3)?,
        context: row.get(4)?,
        identity: row.get(5)?,
        action: AuditAction::parse(&action).unwrap_or(AuditAction::Patch),
        dry_run: row.get(7)?,
        outcome: if outcome == "ok" {
            AuditOutcome::Ok
        } else {
            AuditOutcome::Error
        },
        error: row.get(9)?,
        duration_ms: row.get(10)?,
        targets: serde_json::from_str(&targets).unwrap_or_default(),
        request: request.and_then(|r| serde_json::from_str(&r).ok()),
        result: row.get(13)?,
        has_diff: row.get(14)?,
        revertible: row.get(15)?,
    })
}

pub fn list_audit(conn: &Connection, filter: &AuditFilter) -> Result<AuditPage> {
    let mut args = Vec::new();
    let base = audit_where(filter, &mut args);
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM audit WHERE {base}"),
        params_from_iter(args.iter()),
        |r| r.get(0),
    )?;
    let mut clause = base;
    if let Some((ts, id)) = filter.cursor.as_deref().and_then(parse_cursor) {
        args.push(Sql::Integer(ts));
        args.push(Sql::Integer(ts));
        args.push(Sql::Integer(id));
        clause.push_str(" AND (ts < ? OR (ts = ? AND id < ?))");
    }
    let limit = page_limit(filter.limit);
    args.push(Sql::Integer(limit + 1));
    let mut stmt = conn.prepare(&format!(
        "SELECT {AUDIT_COLUMNS} FROM audit WHERE {clause} ORDER BY ts DESC, id DESC LIMIT ?"
    ))?;
    let mut entries: Vec<AuditEntry> = stmt
        .query_map(params_from_iter(args.iter()), audit_row)?
        .collect::<rusqlite::Result<_>>()?;
    let next_cursor = if entries.len() as i64 > limit {
        entries.truncate(limit as usize);
        entries.last().map(|e| cursor_of(e.ts, e.id))
    } else {
        None
    };
    Ok(AuditPage {
        entries,
        next_cursor,
        total: total as u64,
    })
}

fn to_yaml(json: &str) -> String {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|v| serde_yaml::to_string(&v).ok())
        .unwrap_or_default()
}

pub fn get_audit(conn: &Connection, id: i64) -> Result<Option<AuditDetail>> {
    let entry = conn
        .query_row(
            &format!("SELECT {AUDIT_COLUMNS} FROM audit WHERE id = ?1"),
            [id],
            audit_row,
        )
        .optional()?;
    let Some(entry) = entry else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT target, before, after, omitted, revertible FROM audit_objects
         WHERE audit_id = ?1 ORDER BY target",
    )?;
    let objects = stmt
        .query_map([id], |row| {
            let before: Option<String> = row.get(1)?;
            let after: Option<String> = row.get(2)?;
            Ok(AuditObject {
                target: row.get(0)?,
                before_yaml: before.as_deref().map(to_yaml),
                after_yaml: after.as_deref().map(to_yaml),
                omitted: row.get(3)?,
                revertible: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(AuditDetail { entry, objects }))
}

/// The filtered entries as JSON lines, newest first (bodies left out).
pub fn export_audit(conn: &Connection, filter: &AuditFilter) -> Result<String> {
    let mut args = Vec::new();
    let clause = audit_where(filter, &mut args);
    args.push(Sql::Integer(i64::from(MAX_EXPORT)));
    let mut stmt = conn.prepare(&format!(
        "SELECT {AUDIT_COLUMNS} FROM audit WHERE {clause} ORDER BY ts DESC, id DESC LIMIT ?"
    ))?;
    let mut out = String::new();
    for entry in stmt.query_map(params_from_iter(args.iter()), audit_row)? {
        out.push_str(&serde_json::to_string(&entry?)?);
        out.push('\n');
    }
    Ok(out)
}

pub fn list_events(
    conn: &Connection,
    cluster_id: &str,
    filter: &HistoryEventFilter,
) -> Result<HistoryEventPage> {
    let mut args = vec![Sql::Text(cluster_id.to_string())];
    let mut clauses = vec!["cluster_id = ?".to_string()];
    if !filter.namespaces.is_empty() {
        let list = in_list(filter.namespaces.iter().cloned(), &mut args);
        clauses.push(format!("namespace IN {list}"));
    }
    let object_ref = (
        filter.involved_uid.as_deref().filter(|s| !s.is_empty()),
        filter.involved_kind.as_deref().filter(|s| !s.is_empty()),
        filter.involved_name.as_deref().filter(|s| !s.is_empty()),
    );
    match object_ref {
        (Some(uid), Some(kind), Some(name)) => {
            args.extend([
                Sql::Text(uid.into()),
                Sql::Text(kind.into()),
                Sql::Text(name.into()),
            ]);
            clauses.push("(involved_uid = ? OR (involved_kind = ? AND involved_name = ?))".into());
        }
        (Some(uid), _, _) => {
            args.push(Sql::Text(uid.into()));
            clauses.push("involved_uid = ?".into());
        }
        (None, kind, name) => {
            if let Some(kind) = kind {
                args.push(Sql::Text(kind.into()));
                clauses.push("involved_kind = ?".into());
            }
            if let Some(name) = name {
                args.push(Sql::Text(name.into()));
                clauses.push("involved_name = ?".into());
            }
        }
    }
    if !filter.types.is_empty() {
        let list = in_list(filter.types.iter().cloned(), &mut args);
        clauses.push(format!("type IN {list}"));
    }
    if let Some(text) = clean_text(&filter.text) {
        args.push(Sql::Text(like_pattern(&text)));
        clauses.push("search LIKE ? ESCAPE '\\'".into());
    }
    if let Some(since) = filter.since {
        args.push(Sql::Integer(since));
        clauses.push("last_ts >= ?".into());
    }
    if let Some(until) = filter.until {
        args.push(Sql::Integer(until));
        clauses.push("last_ts <= ?".into());
    }
    if let Some((ts, id)) = filter.cursor.as_deref().and_then(parse_cursor) {
        args.extend([Sql::Integer(ts), Sql::Integer(ts), Sql::Integer(id)]);
        clauses.push("(last_ts < ? OR (last_ts = ? AND id < ?))".into());
    }
    let limit = page_limit(filter.limit);
    args.push(Sql::Integer(limit + 1));
    let mut stmt = conn.prepare(&format!(
        "SELECT id, last_ts, object FROM events WHERE {} ORDER BY last_ts DESC, id DESC LIMIT ?",
        clauses.join(" AND ")
    ))?;
    let mut rows: Vec<(i64, i64, String)> = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|(id, ts, _)| cursor_of(*ts, *id))
    } else {
        None
    };
    let events = rows
        .into_iter()
        .filter_map(|(_, _, json)| serde_json::from_str(&json).ok())
        .collect();
    Ok(HistoryEventPage {
        events,
        next_cursor,
    })
}

fn change_summary(id: i64, json: &str) -> Option<ChangeSummary> {
    let mut summary: ChangeSummary = serde_json::from_str(json).ok()?;
    summary.id = id as u64;
    Some(summary)
}

pub fn list_changes(
    conn: &Connection,
    cluster_id: &str,
    filter: &ChangeFilter,
) -> Result<HistoryChangePage> {
    let mut args = vec![Sql::Text(cluster_id.to_string())];
    let mut clauses = vec!["cluster_id = ?".to_string()];
    if !filter.namespaces.is_empty() {
        let a = in_list(filter.namespaces.iter().cloned(), &mut args);
        let b = in_list(filter.namespaces.iter().cloned(), &mut args);
        clauses.push(format!(
            "(namespace IN {a} OR (namespace IS NULL AND kind = 'Namespace' AND name IN {b}))"
        ));
    }
    if !filter.kinds.is_empty() {
        let list = in_list(filter.kinds.iter().cloned(), &mut args);
        clauses.push(format!("kind IN {list}"));
    }
    if let Some(name) = filter.name.as_deref().filter(|n| !n.is_empty()) {
        args.push(Sql::Text(name.into()));
        clauses.push("name = ?".into());
    }
    if let Some(text) = clean_text(&filter.text) {
        args.push(Sql::Text(like_pattern(&text)));
        clauses.push("search LIKE ? ESCAPE '\\'".into());
    }
    if let Some(since) = filter.since {
        args.push(Sql::Integer(since));
        clauses.push("ts >= ?".into());
    }
    if let Some(until) = filter.until {
        args.push(Sql::Integer(until));
        clauses.push("ts <= ?".into());
    }
    if let Some(cursor) = filter.cursor {
        args.push(Sql::Integer(cursor as i64));
        clauses.push("id < ?".into());
    }
    let limit = page_limit(filter.limit);
    args.push(Sql::Integer(limit + 1));
    let mut stmt = conn.prepare(&format!(
        "SELECT id, summary FROM changes WHERE {} ORDER BY id DESC LIMIT ?",
        clauses.join(" AND ")
    ))?;
    let mut entries: Vec<ChangeSummary> = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .filter_map(|row| row.ok())
        .filter_map(|(id, json)| change_summary(id, &json))
        .collect();
    let next_cursor = if entries.len() as i64 > limit {
        entries.truncate(limit as usize);
        entries.last().map(|e| e.id)
    } else {
        None
    };
    Ok(HistoryChangePage {
        entries,
        next_cursor,
    })
}

pub fn get_change(conn: &Connection, cluster_id: &str, id: i64) -> Result<Option<ChangeDetail>> {
    let row = conn
        .query_row(
            "SELECT summary, before_yaml, after_yaml, omitted FROM changes
             WHERE cluster_id = ?1 AND id = ?2",
            params![cluster_id, id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(summary, before_yaml, after_yaml, omitted)| {
        Some(ChangeDetail {
            summary: change_summary(id, &summary)?,
            before_yaml,
            after_yaml,
            omitted,
        })
    }))
}

pub fn table_status(conn: &Connection, table: &str, ts: &str) -> Result<HistoryTableStatus> {
    let (rows, oldest): (i64, Option<i64>) = conn.query_row(
        &format!("SELECT COUNT(*), MIN({ts}) FROM {table}"),
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(HistoryTableStatus {
        rows: rows as u64,
        oldest_ts: oldest,
    })
}

/// Database + write-ahead log + shared-memory index on disk.
pub fn size_on_disk(path: &Path) -> u64 {
    let mut total = 0;
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        if let Ok(meta) = std::fs::metadata(std::path::PathBuf::from(name)) {
            total += meta.len();
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::change_journal::ChangeOp;
    use crate::types::Gvk;
    use serde_json::json;

    fn temp_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("history.db")).unwrap();
        (dir, conn)
    }

    fn audit_record(ts: i64, cluster: &str, action: AuditAction) -> AuditRecord {
        AuditRecord {
            ts,
            cluster_id: cluster.into(),
            cluster_name: format!("{cluster}-name"),
            context: "ctx".into(),
            identity: None,
            action,
            dry_run: false,
            outcome: AuditOutcome::Ok,
            error: None,
            duration_ms: 12,
            targets: vec![AuditTarget::core("Pod", Some("shop"), &format!("web-{ts}"))],
            request: None,
            result: None,
            objects: Vec::new(),
        }
    }

    fn insert(conn: &mut Connection, records: &[AuditRecord]) {
        let tx = conn.transaction().unwrap();
        for r in records {
            insert_audit(&tx, r).unwrap();
        }
        tx.commit().unwrap();
    }

    #[test]
    fn migrations_create_the_schema_once_and_refuse_newer_databases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("history.db");
        let conn = open(&path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let auto: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap();
        assert_eq!(auto, 2, "incremental auto-vacuum");
        let applied: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(applied, MIGRATIONS.len() as i64);
        drop(conn);

        // Re-opening applies nothing new.
        let conn = open(&path).unwrap();
        assert_eq!(migrate(&conn).unwrap(), latest_version());
        let applied: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(applied, MIGRATIONS.len() as i64);

        // A future Kubepit's database is left alone.
        conn.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?1, 0)",
            [latest_version() + 1],
        )
        .unwrap();
        drop(conn);
        let err = open(&path).unwrap_err();
        assert!(format!("{err:#}").contains("newer"), "{err:#}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn audit_pages_are_newest_first_with_filters_and_totals() {
        let (_dir, mut conn) = temp_db();
        let mut records: Vec<AuditRecord> = (1..=7)
            .map(|i| {
                audit_record(
                    1_000 + i,
                    if i % 2 == 0 { "c2" } else { "c1" },
                    AuditAction::Scale,
                )
            })
            .collect();
        records[2].outcome = AuditOutcome::Error;
        records[2].error = Some("admission webhook denied".into());
        records[3].action = AuditAction::Delete;
        // Same timestamp as the newest: the id breaks the tie.
        records.push(audit_record(1_007, "c1", AuditAction::Patch));
        insert(&mut conn, &records);

        let mut filter = AuditFilter {
            limit: 3,
            ..AuditFilter::default()
        };
        let first = list_audit(&conn, &filter).unwrap();
        assert_eq!(first.total, 8);
        let ts: Vec<i64> = first.entries.iter().map(|e| e.ts).collect();
        assert_eq!(ts, vec![1_007, 1_007, 1_006]);
        assert_eq!(
            first.entries[0].action,
            AuditAction::Patch,
            "later insert first"
        );
        let mut seen: Vec<i64> = first.entries.iter().map(|e| e.id).collect();
        filter.cursor = first.next_cursor.clone();
        let second = list_audit(&conn, &filter).unwrap();
        seen.extend(second.entries.iter().map(|e| e.id));
        filter.cursor = second.next_cursor.clone();
        let third = list_audit(&conn, &filter).unwrap();
        assert!(third.next_cursor.is_none());
        seen.extend(third.entries.iter().map(|e| e.id));
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 8, "every entry exactly once");

        let only = |f: AuditFilter| list_audit(&conn, &f).unwrap();
        let c2 = only(AuditFilter {
            cluster_ids: vec!["c2".into()],
            ..AuditFilter::default()
        });
        assert_eq!(c2.total, 3);
        let errors = only(AuditFilter {
            outcome: Some(AuditOutcome::Error),
            ..AuditFilter::default()
        });
        assert_eq!(errors.entries.len(), 1);
        assert_eq!(
            errors.entries[0].error.as_deref(),
            Some("admission webhook denied")
        );
        let deletes = only(AuditFilter {
            actions: vec![AuditAction::Delete],
            ..AuditFilter::default()
        });
        assert_eq!(deletes.entries[0].ts, 1_004);
        let text = only(AuditFilter {
            text: Some("WEBHOOK".into()),
            ..AuditFilter::default()
        });
        assert_eq!(text.total, 1);
        let wildcard = only(AuditFilter {
            text: Some("%".into()),
            ..AuditFilter::default()
        });
        assert_eq!(wildcard.total, 0, "LIKE wildcards are literal");
        let window = only(AuditFilter {
            since: Some(1_002),
            until: Some(1_004),
            ..AuditFilter::default()
        });
        assert_eq!(window.total, 3);

        let jsonl = export_audit(&conn, &AuditFilter::default()).unwrap();
        assert_eq!(jsonl.lines().count(), 8);
        let first_line: AuditEntry = serde_json::from_str(jsonl.lines().next().unwrap()).unwrap();
        assert_eq!(first_line.ts, 1_007);
    }

    #[test]
    fn audit_details_keep_objects_and_cascade_on_delete() {
        let (_dir, mut conn) = temp_db();
        let mut record = audit_record(5, "c1", AuditAction::Patch);
        record.objects.push(AuditObjectRecord {
            target: 0,
            before: Some(json!({"spec": {"replicas": 1}}).to_string()),
            after: Some(json!({"spec": {"replicas": 3}}).to_string()),
            omitted: false,
            revertible: true,
        });
        insert(&mut conn, &[record]);
        let page = list_audit(&conn, &AuditFilter::default()).unwrap();
        let entry = &page.entries[0];
        assert!(entry.has_diff && entry.revertible);
        let detail = get_audit(&conn, entry.id).unwrap().unwrap();
        assert_eq!(detail.objects.len(), 1);
        assert!(detail.objects[0]
            .after_yaml
            .as_deref()
            .unwrap()
            .contains("replicas: 3"));
        assert!(get_audit(&conn, entry.id + 1).unwrap().is_none());

        clear(&conn, HistoryKind::Audit, None).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM audit_objects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    fn event(uid: &str, involved: &str, reason: &str, last: &str, count: i64) -> Value {
        json!({"apiVersion": "v1", "kind": "Event",
               "metadata": {"name": format!("{involved}.{uid}"), "namespace": "shop", "uid": uid,
                            "managedFields": [{"manager": "kubelet"}]},
               "involvedObject": {"kind": "Pod", "name": involved, "uid": format!("uid-{involved}"),
                                  "namespace": "shop"},
               "reason": reason, "message": format!("{reason} happened"), "type": "Warning",
               "count": count, "lastTimestamp": last})
    }

    #[test]
    fn events_upsert_by_uid_and_page_by_last_occurrence() {
        let (_dir, mut conn) = temp_db();
        let rows: Vec<EventRow> = [
            event("e1", "web-1", "BackOff", "2024-05-01T10:00:00Z", 1),
            event("e2", "web-2", "Unhealthy", "2024-05-01T10:01:00Z", 1),
            event("e3", "web-1", "Pulled", "2024-05-01T10:02:00Z", 1),
        ]
        .iter()
        .map(|e| EventRow::from_event("c1", e).unwrap())
        .collect();
        assert!(!rows[0].object.contains("managedFields"));
        let tx = conn.transaction().unwrap();
        upsert_events(&tx, &rows).unwrap();
        // e1 repeats later: one row, newer occurrence, bigger count.
        let repeat = EventRow::from_event(
            "c1",
            &event("e1", "web-1", "BackOff", "2024-05-01T10:05:00Z", 4),
        )
        .unwrap();
        upsert_events(&tx, &[repeat]).unwrap();
        tx.commit().unwrap();

        let page = |f: HistoryEventFilter| list_events(&conn, "c1", &f).unwrap();
        let all = page(HistoryEventFilter::default());
        let reasons: Vec<&str> = all
            .events
            .iter()
            .map(|e| e["reason"].as_str().unwrap())
            .collect();
        assert_eq!(reasons, vec!["BackOff", "Pulled", "Unhealthy"]);
        assert_eq!(all.events[0]["count"], 4);
        let web1 = page(HistoryEventFilter {
            involved_uid: Some("uid-web-1".into()),
            ..HistoryEventFilter::default()
        });
        assert_eq!(web1.events.len(), 2);
        // A re-created object: same kind and name, another uid.
        let recreated = page(HistoryEventFilter {
            involved_uid: Some("uid-new".into()),
            involved_kind: Some("Pod".into()),
            involved_name: Some("web-2".into()),
            ..HistoryEventFilter::default()
        });
        assert_eq!(recreated.events.len(), 1);
        let first = page(HistoryEventFilter {
            limit: 2,
            ..HistoryEventFilter::default()
        });
        assert_eq!(first.events.len(), 2);
        let rest = page(HistoryEventFilter {
            limit: 2,
            cursor: first.next_cursor.clone(),
            ..HistoryEventFilter::default()
        });
        assert_eq!(rest.events.len(), 1);
        assert_eq!(rest.events[0]["reason"], "Unhealthy");
        assert!(rest.next_cursor.is_none());
        let text = page(HistoryEventFilter {
            text: Some("unhealthy HAPPENED".into()),
            ..HistoryEventFilter::default()
        });
        assert_eq!(text.events.len(), 1);
        assert!(list_events(&conn, "c2", &HistoryEventFilter::default())
            .unwrap()
            .events
            .is_empty());
    }

    fn change(id: u64, ts: i64, kind: &str, namespace: Option<&str>, name: &str) -> ChangeRow {
        ChangeRow {
            cluster_id: "c1".into(),
            journal_started: 100,
            journal_id: id as i64,
            summary: ChangeSummary {
                id,
                ts,
                cluster_id: "c1".into(),
                gvk: Gvk {
                    group: String::new(),
                    version: "v1".into(),
                    kind: kind.into(),
                    plural: format!("{}s", kind.to_lowercase()),
                    namespaced: namespace.is_some(),
                },
                namespace: namespace.map(str::to_string),
                name: name.into(),
                uid: format!("uid-{name}"),
                op: ChangeOp::Modified,
                actor: None,
                paths: Vec::new(),
                path_count: 0,
                truncated: false,
            },
            before_yaml: Some("a: 1\n".into()),
            after_yaml: Some("a: 2\n".into()),
            omitted: false,
        }
    }

    #[test]
    fn changes_are_idempotent_and_filter_like_the_journal() {
        let (_dir, mut conn) = temp_db();
        let rows = vec![
            change(1, 10, "ConfigMap", Some("shop"), "cfg"),
            change(2, 20, "Namespace", None, "shop"),
            change(3, 30, "ConfigMap", Some("ops"), "cfg"),
        ];
        let tx = conn.transaction().unwrap();
        insert_changes(&tx, &rows).unwrap();
        insert_changes(&tx, &rows[..1]).unwrap();
        tx.commit().unwrap();
        let list = |f: ChangeFilter| list_changes(&conn, "c1", &f).unwrap();
        let all = list(ChangeFilter::default());
        assert_eq!(all.entries.len(), 3, "duplicates ignored");
        let shop = list(ChangeFilter {
            namespaces: vec!["shop".into()],
            ..ChangeFilter::default()
        });
        let names: Vec<(String, Option<String>)> = shop
            .entries
            .iter()
            .map(|e| (e.gvk.kind.clone(), e.namespace.clone()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("Namespace".into(), None),
                ("ConfigMap".into(), Some("shop".into()))
            ]
        );
        let page = list(ChangeFilter {
            limit: 2,
            ..ChangeFilter::default()
        });
        assert_eq!(page.entries.len(), 2);
        let older = list(ChangeFilter {
            limit: 2,
            cursor: page.next_cursor,
            ..ChangeFilter::default()
        });
        assert_eq!(older.entries.len(), 1);
        assert_eq!(older.entries[0].ts, 10);
        let until = list(ChangeFilter {
            until: Some(20),
            ..ChangeFilter::default()
        });
        assert_eq!(until.entries.len(), 2);
        let detail = get_change(&conn, "c1", older.entries[0].id as i64)
            .unwrap()
            .unwrap();
        assert_eq!(detail.after_yaml.as_deref(), Some("a: 2\n"));
        assert_eq!(detail.summary.id, older.entries[0].id);
        assert!(get_change(&conn, "c2", older.entries[0].id as i64)
            .unwrap()
            .is_none());
    }

    #[test]
    fn prune_applies_retention_then_the_size_cap() {
        let (_dir, mut conn) = temp_db();
        insert(
            &mut conn,
            &[
                audit_record(10, "c1", AuditAction::Scale),
                audit_record(500, "c1", AuditAction::Scale),
            ],
        );
        let tx = conn.transaction().unwrap();
        insert_changes(
            &tx,
            &[
                change(1, 10, "ConfigMap", Some("a"), "x"),
                change(2, 500, "ConfigMap", Some("a"), "y"),
            ],
        )
        .unwrap();
        tx.commit().unwrap();
        let report = prune(
            &conn,
            &PrunePolicy {
                audit_before: 100,
                data_before: 100,
                max_bytes: u64::MAX,
                rec_before: 0,
                rec_rows_before: 0,
            },
        )
        .unwrap();
        assert_eq!((report.audit, report.changes), (1, 1));
        assert_eq!(table_status(&conn, "audit", "ts").unwrap().rows, 1);
        assert_eq!(
            table_status(&conn, "changes", "ts").unwrap().oldest_ts,
            Some(500)
        );

        // Size cap: bulky events go before the audit log.
        let big = "x".repeat(4096);
        let tx = conn.transaction().unwrap();
        let rows: Vec<EventRow> = (0..400)
            .map(|i| {
                let mut e = event(
                    &format!("e{i}"),
                    "web",
                    "BackOff",
                    "2024-05-01T10:00:00Z",
                    1,
                );
                e["message"] = json!(big);
                EventRow::from_event("c1", &e).unwrap()
            })
            .collect();
        upsert_events(&tx, &rows).unwrap();
        tx.commit().unwrap();
        let before = used_bytes(&conn).unwrap();
        assert!(before > 1_000_000, "{before}");
        prune(
            &conn,
            &PrunePolicy {
                audit_before: 0,
                data_before: 0,
                max_bytes: 400_000,
                rec_before: 0,
                rec_rows_before: 0,
            },
        )
        .unwrap();
        assert!(used_bytes(&conn).unwrap() <= 400_000);
        assert_eq!(
            table_status(&conn, "audit", "ts").unwrap().rows,
            1,
            "audit kept"
        );
        assert!(table_status(&conn, "events", "last_ts").unwrap().rows < 400);
    }
}
