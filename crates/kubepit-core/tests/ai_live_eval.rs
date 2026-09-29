//! Optional, explicitly gated remote quality evaluation of synthetic fixtures.
//! Ignored by normal tests. No real cluster, kubeconfig or OS keychain is read.
mod ai_eval_support;
mod support;

use kubepit_core::ai::{AiEvent, AiStop, AiToolPolicy};
use kubepit_core::secrets::MemorySecretStore;
use std::sync::Arc;

#[tokio::test]
#[ignore = "calls the Anthropic API with your own key; run manually"]
async fn live_diagnosis_eval() {
    if std::env::var("KUBEPIT_AI_LIVE_EVAL").as_deref() != Ok("1") {
        eprintln!(
            "Set KUBEPIT_AI_LIVE_EVAL=1 and ANTHROPIC_API_KEY to run the synthetic live eval."
        );
        return;
    }
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY is required");
    let model = std::env::var("KUBEPIT_AI_LIVE_MODEL").unwrap_or_else(|_| "claude-opus-5".into());
    let (_dir, app, _, cluster) = support::setup_with_secrets(
        "http://127.0.0.1:9",
        true,
        Arc::new(MemorySecretStore::default()),
    );
    let mut settings = app.settings();
    settings.ai.enabled = true;
    settings.ai.tool_policy = AiToolPolicy::Off;
    settings.ai.log_requests = false;
    settings
        .ai
        .providers
        .iter_mut()
        .find(|p| p.id == "anthropic")
        .unwrap()
        .model = model;
    app.set_settings(settings).unwrap();
    app.ai_key_set("anthropic", &key).unwrap();
    app.ai_cluster_set(&cluster, true, false).unwrap();
    // This ignored test is the only eval that opts into remote provider egress.
    app.set_ai_remote_providers(true);
    app.ai_models("anthropic")
        .await
        .expect("fetch model capabilities");
    let mut passed = 0;
    for case in ai_eval_support::cases() {
        let preview = app
            .ai_preview(ai_eval_support::request(&case, &cluster))
            .unwrap();
        let events = ai_eval_support::collect(&app, &preview).await;
        let answer: String = events
            .iter()
            .filter_map(|event| match event {
                AiEvent::Text { delta } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        let lower = answer.to_lowercase();
        let expected_yaml = case.expect_suggestions["manifest"].as_u64().unwrap_or(0) as usize;
        let ok = case
            .keywords
            .iter()
            .all(|word| lower.contains(&word.to_lowercase()))
            && lower.matches("```yaml").count() >= expected_yaml
            && matches!(
                events.last(),
                Some(AiEvent::Done {
                    stop: AiStop::End,
                    ..
                })
            );
        if ok {
            passed += 1;
        }
        if let Some(AiEvent::Done { usage, cost, .. }) = events.last() {
            eprintln!("{}: pass={ok}, tokens={usage:?}, cost={cost:?}", case.name);
        }
        app.ai_session_end(&preview.session_id);
    }
    assert!(passed >= 6, "{passed}/7 cases passed");
}
