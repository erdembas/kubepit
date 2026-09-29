//! Session integration tests use explicit temp Paths, a memory keychain and
//! fake loopback providers/clusters. Remote egress remains off in every test.
mod support;
use kubepit_core::ai::provider::{AiTimeouts, RetryPolicy};
use kubepit_core::ai::*;
use kubepit_core::history::AiLogFilter;
use kubepit_core::secrets::MemorySecretStore;
use kubepit_core::Kubepit;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use support::{llm, FakeServer, Log, Reply, Request};
use tokio::sync::mpsc;

const KEY: &str = "sk-ant-test-key-0123456789abcdefghij";
struct Fixture {
    _dir: tempfile::TempDir,
    app: Arc<Kubepit>,
    cluster: String,
    provider: FakeServer,
    api: FakeServer,
    secrets: Arc<MemorySecretStore>,
}
async fn fixture(router: impl Fn(&Request, &Log) -> Reply + Send + Sync + 'static) -> Fixture {
    let provider = support::start(Arc::new(router)).await;
    let api = support::start(Arc::new(|r: &Request, _: &Log| match r.path_only() {
        "/version" => Reply::Json(200, json!({"major":"1","minor":"31","gitVersion":"v1.31.0","gitCommit":"abc","gitTreeState":"clean","buildDate":"2024-01-01T00:00:00Z","goVersion":"go1.22","compiler":"gc","platform":"linux/amd64"})),
        _ => Reply::Json(200, json!({"apiVersion":"v1","kind":"EventList","metadata":{"resourceVersion":"1"},"items":[]})),
    })).await;
    let secrets = Arc::new(MemorySecretStore::default());
    let (dir, app, _, cluster) = support::setup_with_secrets(&api.url, true, secrets.clone());
    let mut settings = app.settings();
    settings.ai.enabled = true;
    settings
        .ai
        .providers
        .iter_mut()
        .find(|p| p.id == "anthropic")
        .unwrap()
        .base_url = provider.url.clone();
    app.set_settings(settings).unwrap();
    app.ai_key_set("anthropic", KEY).unwrap();
    app.ai_cluster_set(&cluster, true, false).unwrap();
    app.set_ai_timeouts(
        AiTimeouts {
            first_event: Duration::from_secs(2),
            idle: Duration::from_secs(2),
            total: Duration::from_secs(5),
            ..Default::default()
        },
        RetryPolicy {
            base: Duration::from_millis(1),
            ..Default::default()
        },
    );
    Fixture {
        _dir: dir,
        app,
        cluster,
        provider,
        api,
        secrets,
    }
}
async fn plain() -> Fixture {
    fixture(|_, _| {
        llm::anthropic_text(
            "A useful answer.",
            json!({"input_tokens":100,"output_tokens":20}),
        )
    })
    .await
}
fn request(f: &Fixture) -> AiRequest {
    AiRequest { session_id: None, intent: AiIntent::Explain, message: "Why does web-1 fail?".into(),
        scope: AiScope { cluster_id: Some(f.cluster.clone()), namespace: Some("team-a".into()), object: None },
        sections: vec![AiContextSection { id:"object".into(), kind:AiSectionKind::Object, label:"Secret/db".into(), priority:0, format:AiSectionFormat::Yaml,
            content:"apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ndata:\n  password: aHVudGVyMg==\nstringData:\n  password: hunter2\n".into() }], excluded:vec![], locale:AiLocale::En }
}
fn start(f: &Fixture, preview: &AiPreview) -> (String, mpsc::UnboundedReceiver<AiEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let id = f
        .app
        .ai_send(&preview.preview_id, move |e| tx.send(e).is_ok())
        .unwrap();
    (id, rx)
}
async fn event(rx: &mut mpsc::UnboundedReceiver<AiEvent>) -> AiEvent {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .expect("stream event")
}
async fn done(rx: &mut mpsc::UnboundedReceiver<AiEvent>) -> Vec<AiEvent> {
    let mut events = vec![];
    loop {
        let e = event(rx).await;
        let last = matches!(e, AiEvent::Done { .. });
        events.push(e);
        if last {
            return events;
        }
    }
}
async fn pending(rx: &mut mpsc::UnboundedReceiver<AiEvent>) -> AiToolCall {
    loop {
        match event(rx).await {
            AiEvent::ToolCall { call } if call.status == AiToolStatus::PendingApproval => {
                return call
            }
            AiEvent::Done { stop, .. } => panic!("ended before consent: {stop:?}"),
            _ => {}
        }
    }
}
fn bodies(f: &Fixture) -> Vec<Value> {
    f.provider
        .log
        .lock()
        .iter()
        .filter(|r| r.path_only() == "/v1/messages")
        .map(|r| serde_json::from_str(&r.body).unwrap())
        .collect()
}
fn assert_stop(events: &[AiEvent], stop: AiStop) {
    assert!(
        matches!(events.last(), Some(AiEvent::Done { stop: s, .. }) if *s == stop),
        "{events:?}"
    );
}

#[tokio::test]
async fn preview_is_offline_exact_single_use_and_redacted() {
    let f = plain().await;
    let preview = f.app.ai_preview(request(&f)).unwrap();
    assert!(f.provider.log.lock().is_empty());
    assert!(f.api.log.lock().is_empty());
    let (_, mut rx) = start(&f, &preview);
    let events = done(&mut rx).await;
    assert_stop(&events, AiStop::End);
    let sent = bodies(&f);
    assert_eq!(sent.len(), 1);
    let body = sent[0].to_string();
    assert!(!body.contains("hunter2") && !body.contains("aHVudGVyMg=="));
    for s in &preview.sections {
        assert!(sent[0]["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(&s.text));
    }
    assert!(sent[0]["messages"][0]["content"][1]["text"]
        .as_str()
        .unwrap()
        .ends_with(&preview.message));
    assert!(f.app.ai_send(&preview.preview_id, |_| true).is_err());
}

#[tokio::test]
async fn response_language_reaches_the_provider_without_translating_the_request() {
    let f = plain().await;
    for (index, locale) in [AiLocale::Tr, AiLocale::De].into_iter().enumerate() {
        let mut settings = f.app.settings();
        settings.ai.response_language = Some(locale);
        f.app.set_settings(settings).unwrap();

        // The user's text and cluster context retain their original language.
        let mut req = request(&f);
        req.locale = locale;
        let preview = f.app.ai_preview(req.clone()).unwrap();
        let (_, mut rx) = start(&f, &preview);
        assert_stop(&done(&mut rx).await, AiStop::End);
        let sent = bodies(&f);
        assert_eq!(
            sent[index]["system"][0]["text"],
            prompts::system_prompt(locale)
        );
        assert!(sent[index]["messages"][0]["content"][1]["text"]
            .as_str()
            .unwrap()
            .ends_with(&req.message));
        assert!(sent[index]["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("kind: Secret"));

        // A cached session cannot silently retain a different answer language.
        req.session_id = Some(preview.session_id);
        req.locale = AiLocale::En;
        assert!(f
            .app
            .ai_preview(req)
            .unwrap_err()
            .to_string()
            .contains("start a new conversation"));
    }
}

#[tokio::test]
async fn changing_response_language_invalidates_a_prepared_request() {
    let f = plain().await;
    let preview = f.app.ai_preview(request(&f)).unwrap();
    let mut settings = f.app.settings();
    settings.ai.response_language = Some(AiLocale::Tr);
    f.app.set_settings(settings).unwrap();
    assert!(f.app.ai_send(&preview.preview_id, |_| true).is_err());
    assert!(f.provider.log.lock().is_empty());
}

#[tokio::test]
async fn missing_or_locked_key_fails_before_sending() {
    let f = plain().await;
    let preview = f.app.ai_preview(request(&f)).unwrap();
    f.app.ai_key_delete("anthropic").unwrap();
    assert!(f
        .app
        .ai_send(&preview.preview_id, |_| true)
        .unwrap_err()
        .to_string()
        .contains("API key"));
    f.app.ai_key_set("anthropic", KEY).unwrap();
    f.secrets.set_available(false);
    assert!(f.app.ai_send(&preview.preview_id, |_| true).is_err());
    assert!(f.provider.log.lock().is_empty());
}
#[tokio::test]
async fn disabled_cluster_and_changed_settings_revoke_previews() {
    let f = plain().await;
    let preview = f.app.ai_preview(request(&f)).unwrap();
    f.app.ai_cluster_set(&f.cluster, false, false).unwrap();
    assert!(f.app.ai_send(&preview.preview_id, |_| true).is_err());
    assert!(f.app.ai_preview(request(&f)).is_err());
    f.app.ai_cluster_set(&f.cluster, true, false).unwrap();
    let preview = f.app.ai_preview(request(&f)).unwrap();
    let mut s = f.app.settings();
    s.ai.redaction.ips = true;
    f.app.set_settings(s).unwrap();
    assert!(f.app.ai_send(&preview.preview_id, |_| true).is_err());
    assert!(f.provider.log.lock().is_empty());
}
#[tokio::test]
async fn remote_and_local_only_refusals_do_not_connect() {
    let f = plain().await;
    let mut s = f.app.settings();
    s.ai.providers
        .iter_mut()
        .find(|p| p.id == "anthropic")
        .unwrap()
        .base_url = "https://example.invalid".into();
    s.ai.local_only = true;
    f.app.set_settings(s).unwrap();
    assert!(f.app.ai_preview(request(&f)).is_err());
    assert!(f.provider.log.lock().is_empty());
}
#[tokio::test]
async fn followups_preserve_the_prompt_prefix_and_reject_stale_parallel_previews() {
    let f = plain().await;
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    done(&mut rx).await;
    let mut follow = request(&f);
    follow.session_id = Some(p.session_id);
    follow.sections.clear();
    follow.message = "What next?".into();
    let p1 = f.app.ai_preview(follow.clone()).unwrap();
    let p2 = f.app.ai_preview(follow).unwrap();
    assert_eq!(p1.earlier_messages, 2);
    let (_, mut rx) = start(&f, &p1);
    done(&mut rx).await;
    assert!(f.app.ai_send(&p2.preview_id, |_| true).is_err());
    let sent = bodies(&f);
    assert_eq!(sent[0]["system"], sent[1]["system"]);
    assert_eq!(sent[0]["tools"], sent[1]["tools"]);
    assert_eq!(sent[0]["messages"][0], sent[1]["messages"][0]);
}
#[tokio::test]
async fn result_consent_denial_and_session_approval_control_egress() {
    let f = fixture(|_, log| {
        if log.lock().len() < 3 {
            llm::anthropic_tool_use("", "call-1", "get_events", &["{\"namespace\":\"team-a\"}"])
        } else {
            llm::anthropic_text("done", json!({"input_tokens":10}))
        }
    })
    .await;
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (run, mut rx) = start(&f, &p);
    let first = pending(&mut rx).await;
    assert_eq!(bodies(&f).len(), 1);
    assert!(first.result_preview.is_some());
    f.app
        .ai_tool_decision(&run, &first.id, AiToolDecision::Deny)
        .unwrap();
    let second = pending(&mut rx).await;
    assert_eq!(bodies(&f).len(), 2);
    let sent = bodies(&f);
    assert!(
        sent[1]["messages"].as_array().unwrap().last().unwrap()["content"][0]["is_error"]
            .as_bool()
            .unwrap()
    );
    assert!(sent[1].to_string().contains("declined"));
    f.app
        .ai_tool_decision(&run, &second.id, AiToolDecision::SendSession)
        .unwrap();
    assert_stop(&done(&mut rx).await, AiStop::End);
    assert!(f.api.log.lock().iter().all(|r| r.method == "GET"));
}
#[tokio::test]
async fn disconnect_while_waiting_for_consent_cancels_and_drops_decisions() {
    let f = fixture(|_, _| {
        llm::anthropic_tool_use("", "call-1", "get_events", &["{\"namespace\":\"team-a\"}"])
    })
    .await;
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (run, mut rx) = start(&f, &p);
    let call = pending(&mut rx).await;
    f.app.cluster_disconnect(&f.cluster);
    assert_stop(&done(&mut rx).await, AiStop::Cancelled);
    assert_eq!(bodies(&f).len(), 1);
    assert!(f
        .app
        .ai_tool_decision(&run, &call.id, AiToolDecision::Send)
        .is_err());
}
#[tokio::test]
async fn cancelling_a_hanging_stream_finishes_promptly() {
    let f = fixture(|_, _| Reply::Hang).await;
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (id, mut rx) = start(&f, &p);
    assert!(matches!(event(&mut rx).await, AiEvent::Started { .. }));
    assert!(f.app.ai_cancel(&id));
    assert_stop(&done(&mut rx).await, AiStop::Cancelled);
    assert!(!f.app.ai_cancel(&id));
}
#[tokio::test]
async fn closed_channel_stops_before_any_tool_or_second_request() {
    let f = fixture(|_, _| {
        llm::anthropic_tool_use(
            "partial text",
            "call-1",
            "get_events",
            &["{\"namespace\":\"team-a\"}"],
        )
    })
    .await;
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    f.app
        .ai_send(&p.preview_id, move |e| {
            let stop = matches!(e, AiEvent::Text { .. });
            let _ = tx.send(e);
            !stop
        })
        .unwrap();
    assert_stop(&done(&mut rx).await, AiStop::Cancelled);
    assert_eq!(bodies(&f).len(), 1);
    assert!(f.api.log.lock().is_empty());
}
#[tokio::test]
async fn invalid_tool_arguments_never_connect_to_cluster() {
    let f = fixture(|_, log| {
        if log.lock().is_empty() {
            llm::anthropic_tool_use("", "call-1", "get_resource", &["{\"kind\":1}"])
        } else {
            llm::anthropic_text("done", json!({"input_tokens":10}))
        }
    })
    .await;
    let mut s = f.app.settings();
    s.ai.tool_policy = AiToolPolicy::Session;
    f.app.set_settings(s).unwrap();
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    assert_stop(&done(&mut rx).await, AiStop::End);
    assert!(f.api.log.lock().is_empty());
    assert!(bodies(&f)[1].to_string().contains("invalid tool input"));
}
#[tokio::test]
async fn tool_rounds_are_bounded() {
    let f = fixture(|_, _| llm::anthropic_tool_use("", "call-1", "get_resource", &["{}"])).await;
    let mut s = f.app.settings();
    s.ai.tool_policy = AiToolPolicy::Session;
    f.app.set_settings(s).unwrap();
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    assert_stop(&done(&mut rx).await, AiStop::ToolLimit);
    assert_eq!(bodies(&f).len(), 9);
    assert!(f.api.log.lock().is_empty());
}
#[tokio::test]
async fn usage_cost_and_audit_use_redacted_wire_payloads() {
    let f = fixture(|_, _| {
        llm::anthropic_text(
            "done",
            json!({"input_tokens":1_000_000,"output_tokens":100_000}),
        )
    })
    .await;
    let mut s = f.app.settings();
    s.ai.prices = vec![AiPrice {
        model: "claude-opus-5".into(),
        input_per_mtok: 5.,
        output_per_mtok: 25.,
        cache_write_per_mtok: None,
        cache_read_per_mtok: None,
    }];
    f.app.set_settings(s).unwrap();
    f.app.set_history_recording(true);
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    let events = done(&mut rx).await;
    assert!(matches!(events.last(), Some(AiEvent::Done { cost: Some(v), .. }) if *v == 7.5));
    assert!(f.app.history_flush());
    let page = f.app.ai_log_list(&AiLogFilter::default()).unwrap();
    assert_eq!(page.entries.len(), 1);
    let detail = f.app.ai_log_get(page.entries[0].id).unwrap();
    assert!(!detail.request.contains("hunter2"));
    assert!(detail.request.contains("__SECRET__"));
    let logged: Value = serde_json::from_str(&detail.request).unwrap();
    assert_eq!(logged[0], bodies(&f)[0]);
}
#[tokio::test]
async fn session_end_invalidates_previews_and_stops_pending_consent() {
    let f = fixture(|_, _| llm::anthropic_tool_use("", "call-1", "get_resource", &["{}"])).await;
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    pending(&mut rx).await;
    f.app.ai_session_end(&p.session_id);
    assert_stop(&done(&mut rx).await, AiStop::Cancelled);
    let mut r = request(&f);
    r.session_id = Some(p.session_id);
    assert!(f.app.ai_preview(r).is_err());
}
#[tokio::test]
async fn the_preview_cache_is_bounded() {
    let f = plain().await;
    let first = f.app.ai_preview(request(&f)).unwrap();
    for _ in 0..33 {
        f.app.ai_preview(request(&f)).unwrap();
    }
    assert!(f.app.ai_send(&first.preview_id, |_| true).is_err());
    assert!(f.provider.log.lock().is_empty());
}

#[tokio::test]
async fn multiple_results_share_one_user_message_and_thinking_is_preserved() {
    let f = fixture(|_, log| {
        if log.lock().is_empty() {
            let mut events = vec![llm::message_start(json!({"input_tokens":10}))];
            events.extend(llm::thinking_block(0, "reasoning", "signed"));
            events.extend(llm::tool_use_block(1, "a", "get_resource", &["{}"]));
            events.extend(llm::tool_use_block(2, "b", "get_resource", &["{}"]));
            events.push(llm::message_delta("tool_use", 10));
            events.push(llm::message_stop());
            llm::anthropic_stream(&events)
        } else {
            llm::anthropic_text("done", json!({"input_tokens":10}))
        }
    })
    .await;
    let mut s = f.app.settings();
    s.ai.tool_policy = AiToolPolicy::Session;
    f.app.set_settings(s).unwrap();
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    assert_stop(&done(&mut rx).await, AiStop::End);
    let sent = bodies(&f);
    let messages = sent[1]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[2]["content"].as_array().unwrap().len(), 2);
    assert_eq!(
        messages[1]["content"][0],
        json!({"type":"thinking","thinking":"reasoning","signature":"signed"})
    );
    assert!(f.api.log.lock().is_empty());
}
#[tokio::test]
async fn compatibility_fallback_audits_each_exact_attempt() {
    let f=fixture(|_,log| if log.lock().is_empty() { Reply::Json(400,json!({"error":{"type":"invalid_request_error","message":"unsupported fallbacks parameter"}})) }
        else { llm::anthropic_text("done",json!({"input_tokens":10})) }).await;
    f.app.set_history_recording(true);
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    assert_stop(&done(&mut rx).await, AiStop::End);
    assert!(f.app.history_flush());
    let page = f.app.ai_log_list(&AiLogFilter::default()).unwrap();
    let detail = f.app.ai_log_get(page.entries[0].id).unwrap();
    let logged: Vec<Value> = serde_json::from_str(&detail.request).unwrap();
    assert_eq!(logged, bodies(&f));
    assert_eq!(logged.len(), 2);
    assert!(logged[0].get("fallbacks").is_some());
    assert!(logged[1].get("fallbacks").is_none());
}
#[tokio::test]
async fn fallback_usage_is_priced_at_the_model_that_answered() {
    let f = fixture(|_, _| {
        let mut events = vec![llm::message_start_of(
            "fallback-model",
            json!({"input_tokens":1_000_000}),
        )];
        events.extend(llm::fallback_block(0, "claude-opus-5", "fallback-model"));
        events.extend(llm::text_block(1, "done"));
        events.push(llm::message_delta("end_turn", 100_000));
        events.push(llm::message_stop());
        llm::anthropic_stream(&events)
    })
    .await;
    let mut s = f.app.settings();
    s.ai.prices = vec![AiPrice {
        model: "fallback-model".into(),
        input_per_mtok: 2.,
        output_per_mtok: 10.,
        cache_read_per_mtok: None,
        cache_write_per_mtok: None,
    }];
    f.app.set_settings(s).unwrap();
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    let events = done(&mut rx).await;
    assert_stop(&events, AiStop::End);
    assert!(matches!(events.last(),Some(AiEvent::Done{cost:Some(c),..}) if *c==3.0));
}
#[tokio::test]
async fn cut_stream_preserves_partial_text_and_never_runs_tools() {
    let f = fixture(|_, _| {
        let mut events = vec![llm::message_start(json!({"input_tokens":10}))];
        events.extend(llm::text_block(0, "partial answer"));
        events.push(llm::tool_use_start(1, "call-1", "get_events"));
        Reply::Sse {
            events: llm::anthropic_sse(&events),
            gap_ms: 0,
            cut_after: Some(events.len()),
        }
    })
    .await;
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    let events = done(&mut rx).await;
    assert_stop(&events, AiStop::Error);
    assert!(events.iter().any(|e| matches!(e, AiEvent::Text { .. })));
    assert!(events.iter().any(|e| matches!(
        e,
        AiEvent::Error {
            retryable: true,
            ..
        }
    )));
    assert_eq!(bodies(&f).len(), 1);
    assert!(f.api.log.lock().is_empty());
}
#[tokio::test]
async fn oversized_messages_and_duplicate_section_ids_are_rejected_offline() {
    let f = plain().await;
    let mut r = request(&f);
    r.message = "x".repeat(1_048_577);
    assert!(f.app.ai_preview(r).is_err());
    let mut r = request(&f);
    r.sections.push(r.sections[0].clone());
    assert!(f.app.ai_preview(r).is_err());
    assert!(f.provider.log.lock().is_empty());
}
#[tokio::test]
async fn disabling_assistant_while_awaiting_consent_cancels_without_egress() {
    let f = fixture(|_, _| llm::anthropic_tool_use("", "call-1", "get_resource", &["{}"])).await;
    let p = f.app.ai_preview(request(&f)).unwrap();
    let (_, mut rx) = start(&f, &p);
    pending(&mut rx).await;
    let mut s = f.app.settings();
    s.ai.enabled = false;
    f.app.set_settings(s).unwrap();
    assert_stop(&done(&mut rx).await, AiStop::Cancelled);
    assert_eq!(bodies(&f).len(), 1);
}
