//! End-to-end tests of the assistant request log (`ai_log` in
//! `history.db`): the recording gate, body caps, export, clear, status and
//! retention. No cluster and no provider is involved; the database lives in
//! the test's temp home.

use std::sync::Arc;

use kubepit_core::ai::{AiIntent, AiUsage};
use kubepit_core::history::{
    AiLogFilter, AiLogOutcome, AiLogRecord, HistoryKind, HistorySettings, MAX_AI_REQUEST_BYTES,
    MAX_AI_RESPONSE_BYTES,
};
use kubepit_core::{Kubepit, NullSink, Paths};
use serde_json::{json, Value};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn open() -> (tempfile::TempDir, Arc<Kubepit>) {
    let dir = tempfile::tempdir().unwrap();
    let app = Kubepit::open(Paths::new(dir.path().join("home")), Arc::new(NullSink)).unwrap();
    (dir, Arc::new(app))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A finished explain run on `shop`, `n` seconds ago.
fn record(n: i64) -> AiLogRecord {
    AiLogRecord {
        ts: now() - n * 1000,
        cluster_id: Some("c-shop".into()),
        cluster_name: Some("shop".into()),
        provider_id: "anthropic".into(),
        model: "claude-opus-5".into(),
        intent: AiIntent::Explain,
        outcome: AiLogOutcome::Ok,
        error: None,
        duration_ms: 2_400,
        usage: AiUsage {
            input_tokens: 1_000 * n as u64,
            output_tokens: 200,
            cache_read_tokens: 0,
            cache_write_tokens: 50,
        },
        cost: Some(0.01),
        tool_calls: 1,
        request: json!({"messages": [{"role": "user", "content": format!("why is web-{n} failing? password __SECRET__")}]})
            .to_string(),
        response: format!("web-{n} is OOMKilled: raise the memory limit."),
        tools: json!([{"id": "call-1", "name": "get_pod_logs", "status": "sent"}]),
    }
}

#[tokio::test]
async fn records_only_when_history_records_and_logging_is_on() {
    let (dir, app) = open();
    assert!(!app.ai_log_record(record(1))); // recording off in tests by default
    app.set_history_recording(true);
    assert!(app.ai_log_record(record(2)) && app.history_flush());
    let mut s = app.settings();
    s.ai.log_requests = false;
    app.set_settings(s).unwrap();
    assert!(!app.ai_log_record(record(3)) && app.history_flush());
    let page = app.ai_log_list(&AiLogFilter::default()).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.entries[0].usage.input_tokens, 2_000);
    assert_eq!(page.entries[0].cluster_name.as_deref(), Some("shop"));
    assert_eq!(page.usage.input_tokens, 2_000);
    assert_eq!(page.cost, Some(0.01));
    let detail = app.ai_log_get(page.entries[0].id).unwrap();
    assert!(detail.request.contains("why is web-2 failing"));
    assert_eq!(detail.tools[0]["name"], "get_pod_logs");
    assert!(app.ai_log_get(page.entries[0].id + 100).is_err());
    assert!(dir.path().join("home").join("history.db").exists());
}

#[tokio::test]
async fn oversized_bodies_are_capped_and_export_is_json_lines() {
    let (_dir, app) = open();
    app.set_history_recording(true);
    let big = AiLogRecord {
        // Multi-byte text over the caps: cut on a character boundary.
        request: "ğ".repeat(MAX_AI_REQUEST_BYTES),
        response: "€".repeat(MAX_AI_RESPONSE_BYTES),
        ..record(5)
    };
    assert!(app.ai_log_record(big));
    assert!(app.ai_log_record(record(4)));
    assert!(app.history_flush());
    let page = app.ai_log_list(&AiLogFilter::default()).unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.entries[0].usage.input_tokens, 4_000, "newest first");
    let id = page.entries[1].id;
    let d = app.ai_log_get(id).unwrap();
    assert!(d.request.len() <= MAX_AI_REQUEST_BYTES + 64 && d.request.contains("[truncated:"));
    assert!(d.request.ends_with(&format!(
        "[truncated: {} bytes]",
        2 * MAX_AI_REQUEST_BYTES - MAX_AI_REQUEST_BYTES
    )));
    assert!(d.response.len() <= MAX_AI_RESPONSE_BYTES + 64);
    assert!(d.response.contains("[truncated:"));
    let export = app.ai_log_export(&AiLogFilter::default()).unwrap();
    assert_eq!(export.lines().count(), 2);
    assert!(export
        .lines()
        .all(|l| serde_json::from_str::<Value>(l).is_ok()));
    let first: Value = serde_json::from_str(export.lines().next().unwrap()).unwrap();
    assert_eq!(first["intent"], "explain");
    assert_eq!(first["outcome"], "ok");
    assert!(first["request"]
        .as_str()
        .unwrap()
        .contains("why is web-4 failing"));
    assert_eq!(first["tools"][0]["status"], "sent");

    // Filters apply to the export as to the list.
    let none = app
        .ai_log_export(&AiLogFilter {
            cluster_ids: vec!["other".into()],
            ..AiLogFilter::default()
        })
        .unwrap();
    assert!(none.is_empty());
    let text = app
        .ai_log_list(&AiLogFilter {
            text: Some("web-4 is oomkilled".into()),
            ..AiLogFilter::default()
        })
        .unwrap();
    assert_eq!(text.total, 1);
}

#[tokio::test]
async fn history_clear_ai_and_status_counts() {
    let (_dir, app) = open();
    app.set_history_recording(true);
    assert!(app.ai_log_record(record(1)));
    assert!(app.history_flush());
    let status = app.history_status();
    assert_eq!(status.ai.rows, 1);
    assert!(status.ai.oldest_ts.is_some());
    let wire = serde_json::to_value(&status).unwrap();
    assert_eq!(wire["ai"]["rows"], 1, "{wire}");
    app.history_clear(HistoryKind::Ai, None).unwrap();
    assert_eq!(app.history_status().ai.rows, 0);

    assert!(app.ai_log_record(record(1)));
    assert!(app.history_flush());
    let status = app.history_clear(HistoryKind::All, None).unwrap();
    assert_eq!(status.ai.rows, 0);
}

#[tokio::test]
async fn retention_follows_the_audit_retention() {
    let (_dir, app) = open();
    app.set_history_recording(true);
    let mut settings = app.settings();
    settings.history = HistorySettings {
        audit_retention_days: 30,
        retention_days: 1,
        ..HistorySettings::default()
    };
    app.set_settings(settings).unwrap();
    let old = AiLogRecord {
        ts: now() - 31 * DAY_MS,
        ..record(1)
    };
    let recent = AiLogRecord {
        // Older than the data retention, younger than the audit retention.
        ts: now() - 2 * DAY_MS,
        ..record(2)
    };
    assert!(app.ai_log_record(old) && app.ai_log_record(recent));
    assert!(app.history_flush());
    assert_eq!(app.history_status().ai.rows, 2);
    let report = app.history_prune().unwrap();
    assert_eq!(report.ai, 1);
    let page = app.ai_log_list(&AiLogFilter::default()).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.entries[0].usage.input_tokens, 2_000);
}
