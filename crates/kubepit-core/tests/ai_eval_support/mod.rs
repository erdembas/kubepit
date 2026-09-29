//! Shared, entirely synthetic diagnosis fixtures. Never reads kubeconfig or OS keys.
#![allow(dead_code)]
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use kubepit_core::ai::provider::{AiTimeouts, RetryPolicy};
use kubepit_core::ai::*;
use kubepit_core::secrets::MemorySecretStore;
use kubepit_core::Kubepit;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::support::{self, llm, FakeServer, Log, Reply, Request};

#[derive(Debug, Deserialize)]
pub struct Case {
    pub name: String,
    pub locale: AiLocale,
    pub intent: AiIntent,
    pub scope: AiScope,
    pub sections: Vec<AiContextSection>,
    pub secrets: Vec<String>,
    pub expect_sections: Vec<String>,
    pub max_input_tokens: u32,
    pub scripted_reply: String,
    pub expect_suggestions: Value,
    pub keywords: Vec<String>,
}

pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ai")
}

pub fn cases() -> Vec<Case> {
    let mut paths: Vec<_> = std::fs::read_dir(fixture_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    assert_eq!(paths.len(), 7, "seven diagnosis fixtures are required");
    paths
        .into_iter()
        .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
        .collect()
}

pub fn request(case: &Case, cluster: &str) -> AiRequest {
    let mut scope = case.scope.clone();
    scope.cluster_id = Some(cluster.into());
    AiRequest {
        session_id: None,
        intent: case.intent,
        message: match case.locale {
            AiLocale::Tr => "Olası nedeni açıklayın ve güvenli sonraki adımlar önerin.",
            _ => "Explain the likely cause and suggest safe next steps.",
        }
        .into(),
        scope,
        sections: case.sections.clone(),
        excluded: Vec::new(),
        locale: case.locale,
    }
}

pub struct Run {
    pub dir: tempfile::TempDir,
    pub app: Arc<Kubepit>,
    pub preview: AiPreview,
    pub events: Vec<AiEvent>,
    pub bodies: Vec<Value>,
    pub api: FakeServer,
    pub provider: FakeServer,
}

pub async fn collect(app: &Arc<Kubepit>, preview: &AiPreview) -> Vec<AiEvent> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    app.ai_send(&preview.preview_id, move |event| tx.send(event).is_ok())
        .unwrap();
    tokio::time::timeout(Duration::from_secs(120), async {
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            let done = matches!(event, AiEvent::Done { .. });
            events.push(event);
            if done {
                return events;
            }
        }
        panic!("assistant stream closed without Done: {events:?}");
    })
    .await
    .expect("assistant run timed out")
}

pub async fn run_case(case: &Case, record: bool) -> Run {
    let reply = case.scripted_reply.clone();
    let provider = support::start(Arc::new(move |request: &Request, _: &Log| {
        assert_eq!(
            request.path_only(),
            "/v1/messages",
            "eval must not request remote token counts/model metadata"
        );
        llm::anthropic_text(&reply, json!({"input_tokens": 1500, "output_tokens": 200}))
    }))
    .await;
    let api = support::start(Arc::new(|_: &Request, _: &Log| {
        Reply::Json(
            500,
            json!({"message":"fixture eval must not read the cluster"}),
        )
    }))
    .await;
    let (dir, app, _, cluster) =
        support::setup_with_secrets(&api.url, true, Arc::new(MemorySecretStore::default()));
    let mut settings = app.settings();
    settings.ai.enabled = true;
    settings.ai.tool_policy = AiToolPolicy::Off;
    settings.ai.max_context_tokens = case.max_input_tokens;
    settings
        .ai
        .providers
        .iter_mut()
        .find(|provider| provider.id == "anthropic")
        .unwrap()
        .base_url = provider.url.clone();
    app.set_settings(settings).unwrap();
    app.ai_key_set("anthropic", "sk-ant-synthetic-eval-key-1234567890")
        .unwrap();
    app.ai_cluster_set(&cluster, true, false).unwrap();
    app.set_history_recording(record);
    app.set_ai_timeouts(
        AiTimeouts {
            total: Duration::from_secs(5),
            first_event: Duration::from_secs(2),
            idle: Duration::from_secs(2),
            ..Default::default()
        },
        RetryPolicy {
            base: Duration::from_millis(1),
            ..Default::default()
        },
    );
    let preview = app.ai_preview(request(case, &cluster)).unwrap();
    assert!(provider.log.lock().is_empty(), "preview must be offline");
    let events = collect(&app, &preview).await;
    assert!(
        matches!(
            events.last(),
            Some(AiEvent::Done {
                stop: AiStop::End,
                ..
            })
        ),
        "{}: {events:?}",
        case.name
    );
    let bodies = provider
        .log
        .lock()
        .iter()
        .map(|request| serde_json::from_str(&request.body).unwrap())
        .collect();
    assert!(
        api.log.lock().is_empty(),
        "fixture evaluation must not access a cluster"
    );
    Run {
        dir,
        app,
        preview,
        events,
        bodies,
        api,
        provider,
    }
}

pub fn context(body: &Value) -> &str {
    body["messages"][0]["content"][0]["text"]
        .as_str()
        .expect("first content block is context")
}
