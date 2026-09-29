//! A loopback provider never goes through an environment proxy: a
//! developer's `HTTP_PROXY` must not capture a local model's traffic (or
//! break these tests). This file holds a single test because it sets
//! process-wide environment variables before any other thread runs.

mod support;

use std::sync::Arc;

use kubepit_core::ai::anthropic::AnthropicProvider;
use kubepit_core::ai::provider::{
    AiTimeouts, ChatMessage, ChatRequest, Provider, RetryPolicy, UserBlock,
};
use serde_json::json;
use support::{Reply, Request};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn loopback_providers_bypass_environment_proxies() {
    let proxy = support::start(Arc::new(|_req: &Request, _log: &support::Log| {
        Reply::Json(502, json!({"error": "captured by the proxy"}))
    }))
    .await;
    let upstream = support::start(Arc::new(|_req: &Request, _log: &support::Log| {
        support::llm::anthropic_text("direct", json!({"input_tokens": 1}))
    }))
    .await;
    // Single test in this binary on a current-thread runtime: nothing else
    // reads the environment concurrently.
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::set_var(name, &proxy.url);
    }
    for name in ["NO_PROXY", "no_proxy"] {
        std::env::remove_var(name);
    }

    // The provider builds its own client: the caller cannot hand it one
    // that uses a proxy (or follows redirects).
    let provider = AnthropicProvider::new(
        upstream.url.clone(),
        "sk-ant-test".into(),
        AiTimeouts::default(),
        RetryPolicy::default(),
        None,
    )
    .unwrap();
    let req = ChatRequest {
        model: "claude-opus-5".into(),
        system: "system".into(),
        messages: vec![ChatMessage::User(vec![UserBlock::Text {
            text: "hi".into(),
            cache: false,
        }])],
        tools: vec![],
        max_tokens: 64,
        effort: None,
    };
    let turn = provider
        .chat(&req, &|_| {}, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(turn.text, "direct");
    assert_eq!(upstream.log.lock().len(), 1);
    assert!(proxy.log.lock().is_empty(), "the proxy saw local traffic");
}
