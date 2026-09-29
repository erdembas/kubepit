//! The Anthropic Messages API provider against the fake provider server on
//! 127.0.0.1: headers, body shape, cache breakpoints, usage mapping,
//! thinking and fallback blocks, refusals, strict tool input, retries,
//! timeouts, cancellation, the Models API and the egress / key-safety rules.
//! No real provider is ever contacted (remote egress stays off).

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use kubepit_core::ai::anthropic::AnthropicProvider;
use kubepit_core::ai::is_loopback;
use kubepit_core::ai::provider::{
    check_egress, is_local_url, AiTimeouts, AssistantTurn, ChatMessage, ChatRequest, Egress,
    Provider, ProviderError, ProviderErrorKind, RetryPolicy, StopReason, StreamEvent, ToolCallReq,
    ToolSpec, UserBlock, MAX_CONTENT_BLOCKS, MAX_ERROR_MESSAGE_BYTES,
};
use kubepit_core::ai::{AiEffort, AiModelInfo, AiUsage};
use parking_lot::Mutex;
use serde_json::{json, Value};
use support::llm::{self, *};
use support::{Reply, Request, SseEvent};
use tokio_util::sync::CancellationToken;

const KEY: &str = "sk-ant-test-key-0123456789abcdef";

fn fast_retry() -> RetryPolicy {
    RetryPolicy {
        base: Duration::from_millis(10),
        ..Default::default()
    }
}

/// The provider builds its own client (no redirects, no proxy for
/// loopback), so key safety never depends on the caller.
fn anthropic_with(url: &str, timeouts: AiTimeouts, info: Option<AiModelInfo>) -> AnthropicProvider {
    AnthropicProvider::new(
        url.to_string(),
        KEY.to_string(),
        timeouts,
        fast_retry(),
        info,
    )
    .unwrap()
}

fn anthropic(url: &str) -> AnthropicProvider {
    anthropic_with(url, AiTimeouts::default(), None)
}

fn model(id: &str) -> AiModelInfo {
    AiModelInfo {
        id: id.to_string(),
        ..Default::default()
    }
}

fn tool(name: &'static str) -> ToolSpec {
    ToolSpec {
        name,
        description: "Reads one thing from the cluster.",
        schema: json!({
            "type": "object",
            "properties": {"namespace": {"type": "string"}},
            "additionalProperties": false,
        }),
    }
}

fn text(text: &str, cache: bool) -> UserBlock {
    UserBlock::Text {
        text: text.to_string(),
        cache,
    }
}

fn request(messages: Vec<ChatMessage>, tools: Vec<ToolSpec>) -> ChatRequest {
    ChatRequest {
        model: "claude-opus-5".into(),
        system: "You are Kubepit's assistant.".into(),
        messages,
        tools,
        max_tokens: 4096,
        effort: None,
    }
}

/// One user message with the question only.
fn ask(question: &str) -> ChatRequest {
    request(vec![ChatMessage::User(vec![text(question, false)])], vec![])
}

fn req_with_effort(effort: AiEffort) -> ChatRequest {
    ChatRequest {
        effort: Some(effort),
        ..ask("Why is web-1 crashing?")
    }
}

/// Serves `reply` for every request.
async fn serve(reply: impl Fn() -> Reply + Send + Sync + 'static) -> support::FakeServer {
    support::start(Arc::new(move |_req: &Request, _log: &support::Log| reply())).await
}

/// Runs `chat` and returns the result with every stream event.
async fn chat(
    provider: &AnthropicProvider,
    req: &ChatRequest,
) -> (Result<AssistantTurn, ProviderError>, Vec<StreamEvent>) {
    let events = Mutex::new(Vec::new());
    let cancel = CancellationToken::new();
    let result = provider
        .chat(req, &|e| events.lock().push(e), &cancel)
        .await;
    (result, events.into_inner())
}

fn texts(events: &[StreamEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::Text(t) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

fn header(req: &Request, name: &str) -> String {
    req.header(name)
        .unwrap_or_else(|| panic!("no {name} header"))
        .to_string()
}

fn header_opt(req: &Request, name: &str) -> Option<String> {
    req.header(name).map(str::to_string)
}

fn block_types(raw: &Value) -> Vec<String> {
    raw.as_array()
        .unwrap()
        .iter()
        .map(|b| b["type"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn sends_documented_headers_and_a_cacheable_body() {
    let server = serve(|| anthropic_text("OK", json!({"input_tokens": 10}))).await;
    let req = request(
        vec![ChatMessage::User(vec![
            text("<context>\npod web-1 is crashing\n</context>", true),
            text("Why is web-1 crashing?", false),
        ])],
        vec![tool("list_pods"), tool("get_events")],
    );
    let (result, _) = chat(&anthropic(&server.url), &req).await;
    result.unwrap();
    let log = server.log.lock();
    assert_eq!(log.len(), 1);
    let req = &log[0];
    assert_eq!(req.method, "POST");
    assert_eq!(req.path, "/v1/messages");
    assert_eq!(header(req, "x-api-key"), KEY);
    assert_eq!(header(req, "anthropic-version"), "2023-06-01");
    assert_eq!(
        header(req, "anthropic-beta"),
        "server-side-fallback-2026-07-01"
    );
    assert_eq!(header(req, "content-type"), "application/json");
    assert_eq!(header_opt(req, "authorization"), None);
    let body: Value = serde_json::from_str(&req.body).unwrap();
    assert_eq!(body["model"], "claude-opus-5");
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_tokens"], 4096);
    assert_eq!(body["system"][0]["type"], "text");
    assert_eq!(body["system"][0]["text"], "You are Kubepit's assistant.");
    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(
        body["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    assert!(body["messages"][0]["content"][1]
        .get("cache_control")
        .is_none());
    assert_eq!(body["cache_control"]["type"], "ephemeral");
    assert_eq!(body["fallbacks"], "default");
    let names: Vec<_> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["get_events", "list_pods"]);
    assert!(names.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    assert!(
        body["tools"][0].get("eager_input_streaming").is_none(),
        "eager input streaming only for the default base URL"
    );
    assert!(
        body.get("thinking").is_none(),
        "no capability info → no thinking param"
    );
    assert!(body.get("output_config").is_none());
    for field in ["temperature", "top_p", "top_k", "budget_tokens"] {
        assert!(body.get(field).is_none(), "{field} must not be sent");
    }
}

#[test]
fn thinking_and_effort_follow_model_capabilities() {
    let provider_with =
        |info: AiModelInfo| anthropic_with("http://127.0.0.1:9", AiTimeouts::default(), Some(info));
    let info = AiModelInfo {
        adaptive_thinking: Some(true),
        effort: Some(true),
        ..model("claude-opus-5")
    };
    let body = provider_with(info).request_body(&req_with_effort(AiEffort::High));
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert_eq!(body["output_config"]["effort"], "high");
    assert!(body.get("budget_tokens").is_none() && body["thinking"].get("budget_tokens").is_none());

    // Unknown or unsupported capabilities: neither parameter.
    let unknown = anthropic("http://127.0.0.1:9").request_body(&req_with_effort(AiEffort::Low));
    assert!(unknown.get("thinking").is_none() && unknown.get("output_config").is_none());
    let unsupported = provider_with(AiModelInfo {
        adaptive_thinking: Some(false),
        effort: Some(false),
        ..model("claude-opus-5")
    })
    .request_body(&req_with_effort(AiEffort::Low));
    assert!(unsupported.get("thinking").is_none() && unsupported.get("output_config").is_none());

    // Capabilities of another model do not apply.
    let other = provider_with(AiModelInfo {
        adaptive_thinking: Some(true),
        effort: Some(true),
        ..model("claude-haiku-4-5")
    })
    .request_body(&req_with_effort(AiEffort::Max));
    assert!(other.get("thinking").is_none() && other.get("output_config").is_none());

    // The output cap from the Models API bounds max_tokens.
    let capped = provider_with(AiModelInfo {
        max_output_tokens: Some(1024),
        ..model("claude-opus-5")
    })
    .request_body(&ask("hi"));
    assert_eq!(capped["max_tokens"], 1024);
}

#[test]
fn effort_is_clamped_to_the_levels_the_model_supports() {
    let with_levels = |levels: Vec<AiEffort>, requested: AiEffort| {
        anthropic_with(
            "http://127.0.0.1:9",
            AiTimeouts::default(),
            Some(AiModelInfo {
                effort: Some(true),
                effort_levels: Some(levels),
                ..model("claude-opus-5")
            }),
        )
        .request_body(&req_with_effort(requested))
    };
    use AiEffort::*;
    let all = vec![Low, Medium, High, Xhigh, Max];
    assert_eq!(with_levels(all, Xhigh)["output_config"]["effort"], "xhigh");
    // Unsupported level → the highest supported level below it.
    let no_xhigh = vec![Low, Medium, High, Max];
    assert_eq!(
        with_levels(no_xhigh, Xhigh)["output_config"]["effort"],
        "high"
    );
    assert_eq!(
        with_levels(vec![Low], Max)["output_config"]["effort"],
        "low"
    );
    // Nothing supported at or below the request → omitted.
    let body = with_levels(vec![High, Max], Low);
    assert!(body.get("output_config").is_none());
    let body = with_levels(vec![], Medium);
    assert!(body.get("output_config").is_none());
}

#[test]
fn eager_input_streaming_is_sent_only_to_the_default_base_url() {
    let req = request(
        vec![ChatMessage::User(vec![text("hi", false)])],
        vec![tool("get_pod")],
    );
    for (base, eager) in [
        ("https://api.anthropic.com", true),
        ("https://api.anthropic.com/", true),
        ("https://api.anthropic.com.proxy.example", false),
        ("https://proxy.example.com", false),
        ("http://127.0.0.1:4000", false),
    ] {
        let body = anthropic_with(base, AiTimeouts::default(), None).request_body(&req);
        let tool = &body["tools"][0];
        assert_eq!(tool.get("eager_input_streaming").is_some(), eager, "{base}");
        if eager {
            assert_eq!(tool["eager_input_streaming"], true);
        }
    }
}

#[test]
fn tool_results_go_back_in_one_user_message_and_assistant_turns_are_echoed() {
    let raw = json!([
        {"type": "thinking", "thinking": "", "signature": "sig-1"},
        {"type": "text", "text": "Checking both."},
        {"type": "tool_use", "id": "c1", "name": "get_pod", "input": {"namespace": "shop"}},
        {"type": "tool_use", "id": "c2", "name": "get_events", "input": {"namespace": "shop"}},
    ]);
    let turn = AssistantTurn {
        raw: raw.clone(),
        text: "Checking both.".into(),
        tool_calls: vec![],
        stop: StopReason::ToolUse,
        usage: AiUsage::default(),
        model: "claude-opus-5".into(),
    };
    let built = AssistantTurn {
        raw: Value::Null,
        text: "Built from parts.".into(),
        tool_calls: vec![ToolCallReq {
            id: "c9".into(),
            name: "get_pod".into(),
            input: Err("{\"pod\": \"we".into()),
        }],
        stop: StopReason::ToolUse,
        usage: AiUsage::default(),
        model: "claude-opus-5".into(),
    };
    let req = request(
        vec![
            ChatMessage::User(vec![
                text("<context>a</context>", true),
                text("<context>b</context>", true),
                text("<context>c</context>", true),
                text("question", false),
            ]),
            ChatMessage::Assistant(turn),
            ChatMessage::User(vec![
                UserBlock::ToolResult {
                    call_id: "c1".into(),
                    content: "pod: web-1".into(),
                    is_error: false,
                },
                UserBlock::ToolResult {
                    call_id: "c2".into(),
                    content: "forbidden".into(),
                    is_error: true,
                },
            ]),
            ChatMessage::Assistant(built),
        ],
        vec![],
    );
    let body = anthropic("http://127.0.0.1:9").request_body(&req);
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    // At most two message breakpoints (system + top-level make four).
    let cached: Vec<bool> = messages[0]["content"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.get("cache_control").is_some())
        .collect();
    assert_eq!(cached, vec![true, true, false, false]);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(
        messages[1]["content"], raw,
        "assistant content echoed unchanged"
    );
    assert_eq!(messages[2]["role"], "user");
    let results = messages[2]["content"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["type"], "tool_result");
    assert_eq!(results[0]["tool_use_id"], "c1");
    assert_eq!(results[0]["content"], "pod: web-1");
    assert_eq!(results[0]["is_error"], false);
    assert_eq!(results[1]["tool_use_id"], "c2");
    assert_eq!(results[1]["is_error"], true);
    // Without raw content the turn is rebuilt from its parts.
    assert_eq!(
        messages[3]["content"],
        json!([
            {"type": "text", "text": "Built from parts."},
            {"type": "tool_use", "id": "c9", "name": "get_pod", "input": {}},
        ])
    );
}

#[tokio::test]
async fn streams_text_and_maps_usage_with_cache_tokens() {
    let server = serve(|| {
        anthropic_text(
            "Hello",
            json!({"input_tokens": 1200, "cache_creation_input_tokens": 800, "cache_read_input_tokens": 0}),
        )
    })
    .await;
    let (result, events) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert_eq!(texts(&events), vec!["Hel", "lo"]);
    assert_eq!(turn.text, "Hello");
    assert_eq!(
        turn.usage,
        AiUsage {
            input_tokens: 1200,
            output_tokens: 5,
            cache_read_tokens: 0,
            cache_write_tokens: 800
        }
    );
    assert!(matches!(turn.stop, StopReason::EndTurn));
    assert_eq!(turn.model, "claude-opus-5");
    assert_eq!(turn.raw, json!([{"type": "text", "text": "Hello"}]));
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::Usage(u) if u.output_tokens == 5)));
}

#[tokio::test]
async fn tool_input_is_parsed_strictly() {
    let server = serve(|| {
        anthropic_tool_use(
            "Checking",
            "toolu_1",
            "get_pod",
            &["{\"namespace\":\"sh", "op\",\"pod\":\"web-1\"}"],
        )
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert!(matches!(turn.stop, StopReason::ToolUse));
    assert_eq!(turn.tool_calls.len(), 1);
    assert_eq!(turn.tool_calls[0].id, "toolu_1");
    assert_eq!(turn.tool_calls[0].name, "get_pod");
    assert_eq!(
        turn.tool_calls[0].input,
        Ok(json!({"namespace": "shop", "pod": "web-1"}))
    );
    assert_eq!(
        turn.raw[1],
        json!({"type": "tool_use", "id": "toolu_1", "name": "get_pod",
               "input": {"namespace": "shop", "pod": "web-1"}})
    );

    let server = serve(|| anthropic_tool_use("", "toolu_2", "get_pod", &["{\"pod\": \"web"])).await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert_eq!(turn.tool_calls[0].input, Err("{\"pod\": \"web".to_string()));
    assert_eq!(
        turn.raw[0]["input"],
        json!({}),
        "unparseable input echoes as {{}}"
    );

    // A tool without arguments sends no input deltas.
    let server = serve(|| anthropic_tool_use("", "toolu_3", "list_namespaces", &[])).await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    assert_eq!(result.unwrap().tool_calls[0].input, Ok(json!({})));

    // The whole input in `content_block_start`, no deltas.
    let server = serve(|| {
        anthropic_stream(&[
            message_start(json!({"input_tokens": 10})),
            block_start(
                0,
                json!({"type": "tool_use", "id": "toolu_4", "name": "get_pod",
                       "input": {"namespace": "shop", "pod": "web-1"}}),
            ),
            block_stop(0),
            message_delta("tool_use", 5),
            message_stop(),
        ])
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert_eq!(
        turn.tool_calls[0].input,
        Ok(json!({"namespace": "shop", "pod": "web-1"}))
    );
    assert_eq!(
        turn.raw[0]["input"],
        json!({"namespace": "shop", "pod": "web-1"})
    );
}

#[tokio::test]
async fn thinking_blocks_are_kept_verbatim_in_raw() {
    let server = serve(|| {
        let mut events = vec![message_start(json!({"input_tokens": 10}))];
        events.extend(thinking_block(0, "", "sig"));
        events.push(block_start(
            1,
            json!({"type": "redacted_thinking", "data": "opaque"}),
        ));
        events.push(block_stop(1));
        events.extend(text_block(2, "Done"));
        events.push(message_delta("end_turn", 3));
        events.push(message_stop());
        anthropic_stream(&events)
    })
    .await;
    let (result, events) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert_eq!(
        turn.raw[0],
        json!({"type": "thinking", "thinking": "", "signature": "sig"})
    );
    assert_eq!(
        turn.raw[1],
        json!({"type": "redacted_thinking", "data": "opaque"})
    );
    assert_eq!(turn.raw[2], json!({"type": "text", "text": "Done"}));
    assert_eq!(turn.text, "Done");
    assert!(events.iter().any(|e| matches!(e, StreamEvent::Thinking)));
}

#[tokio::test]
async fn a_stream_cut_mid_tool_input_is_retryable_and_runs_nothing() {
    let server = serve(|| {
        let mut events = vec![message_start(json!({"input_tokens": 10}))];
        events.extend(text_block(0, "Checking"));
        events.push(tool_use_start(1, "toolu_1", "get_pod"));
        events.push(input_json_delta(1, "{\"namespace\":\"sh"));
        let n = events.len();
        Reply::Sse {
            events: anthropic_sse(&events),
            gap_ms: 0,
            cut_after: Some(n),
        }
    })
    .await;
    let (result, events) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert!(err.retryable());
    assert_eq!(err.kind, ProviderErrorKind::Network);
    let partial = err.partial.unwrap();
    assert_eq!(partial.text, "Checking");
    assert!(partial.tool_calls.is_empty());
    assert_eq!(block_types(&partial.raw), vec!["text"]);
    assert_eq!(texts(&events).concat(), "Checking");
    assert_eq!(
        server.log.lock().len(),
        1,
        "no automatic retry once text streamed"
    );
}

#[tokio::test]
async fn malformed_sse_json_is_a_protocol_error() {
    let server = serve(|| {
        let mut events = anthropic_sse(&[
            message_start(json!({"input_tokens": 10})),
            block_start(0, json!({"type": "text", "text": ""})),
        ]);
        events.push(SseEvent {
            event: Some("content_block_delta".into()),
            data: "{not json".into(),
        });
        Reply::Sse {
            events,
            gap_ms: 0,
            cut_after: None,
        }
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol);
    assert!(err.retryable());
    assert!(err.partial.unwrap().tool_calls.is_empty());
    assert_eq!(server.log.lock().len(), 1);
}

#[tokio::test]
async fn refusal_stops_without_tool_calls() {
    let server = serve(|| anthropic_refusal("cyber")).await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert!(matches!(turn.stop, StopReason::Refusal { category: Some(ref c) } if c == "cyber"));
    assert!(turn.tool_calls.is_empty());
    assert_eq!(
        block_types(&turn.raw),
        vec!["text"],
        "no tool_use left to answer"
    );
    assert_eq!(turn.text, "Let me look");
}

#[tokio::test]
async fn max_tokens_with_a_pending_tool_call_runs_nothing() {
    let server = serve(|| {
        let mut events = vec![message_start(json!({"input_tokens": 10}))];
        events.extend(tool_use_block(
            0,
            "toolu_1",
            "get_pod",
            &["{\"pod\":\"web-1\"}"],
        ));
        events.push(message_delta("max_tokens", 4096));
        events.push(message_stop());
        anthropic_stream(&events)
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert!(matches!(turn.stop, StopReason::MaxTokens));
    assert!(turn.tool_calls.is_empty());
    assert!(block_types(&turn.raw).is_empty());
}

#[tokio::test]
async fn fallback_blocks_emit_a_fallback_event() {
    let server = serve(|| {
        let mut events = vec![message_start_of(
            "claude-opus-4-8",
            json!({"input_tokens": 10}),
        )];
        events.extend(fallback_block(0, "claude-opus-5", "claude-opus-4-8"));
        events.extend(text_block(1, "OK"));
        events.push(message_delta("end_turn", 1));
        events.push(message_stop());
        anthropic_stream(&events)
    })
    .await;
    let (result, events) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert!(events.contains(&StreamEvent::Fallback {
        from: "claude-opus-5".into(),
        to: "claude-opus-4-8".into()
    }));
    assert_eq!(turn.model, "claude-opus-4-8");
    assert_eq!(turn.text, "OK");
}

#[tokio::test]
async fn a_mid_output_fallback_drops_the_declined_blocks_from_the_echo() {
    let server = serve(|| {
        let mut events = vec![message_start(json!({"input_tokens": 10}))];
        events.extend(text_block(0, "Let me check. "));
        events.extend(thinking_block(1, "", "sig-declined"));
        events.extend(tool_use_block(2, "toolu_declined", "get_pod", &["{}"]));
        events.extend(fallback_block(3, "claude-opus-5", "claude-opus-4-8"));
        events.extend(text_block(4, "Here"));
        events.extend(tool_use_block(
            5,
            "toolu_2",
            "get_events",
            &["{\"namespace\":\"shop\"}"],
        ));
        events.push(message_delta("tool_use", 9));
        events.push(message_stop());
        anthropic_stream(&events)
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let turn = result.unwrap();
    assert_eq!(
        block_types(&turn.raw),
        vec!["text", "fallback", "text", "tool_use"]
    );
    assert_eq!(turn.text, "Let me check. Here");
    let ids: Vec<_> = turn.tool_calls.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec!["toolu_2"]);
}

#[tokio::test]
async fn retries_without_fallbacks_when_the_parameter_is_rejected() {
    let server = support::start(Arc::new(|_req: &Request, log: &support::Log| {
        if log.lock().is_empty() {
            anthropic_error(
                400,
                "invalid_request_error",
                "fallbacks: not supported for this model",
                None,
            )
        } else {
            anthropic_text("OK", json!({"input_tokens": 10}))
        }
    }))
    .await;
    let provider = anthropic(&server.url);
    let (result, events) = chat(&provider, &ask("hi")).await;
    assert_eq!(result.unwrap().text, "OK");
    let log = server.log.lock().clone();
    assert_eq!(log.len(), 2);
    let first: Value = serde_json::from_str(&log[0].body).unwrap();
    assert_eq!(first["fallbacks"], "default");
    let second: Value = serde_json::from_str(&log[1].body).unwrap();
    assert!(second.get("fallbacks").is_none());
    assert_eq!(header_opt(&log[1], "anthropic-beta"), None);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, StreamEvent::Retrying { .. })),
        "the fallback retry is not a backoff retry"
    );
    // The provider remembers: later requests go without the parameter.
    let (again, _) = chat(&provider, &ask("again")).await;
    again.unwrap();
    let third: Value = serde_json::from_str(&server.log.lock()[2].body).unwrap();
    assert!(third.get("fallbacks").is_none());
}

#[tokio::test]
async fn a_rejected_beta_header_or_fallback_field_also_turns_fallbacks_off() {
    for message in [
        "anthropic-beta: Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header",
        "Unknown field: fallback is not available for this organization",
    ] {
        let server = support::start(Arc::new(move |_req: &Request, log: &support::Log| {
            if log.lock().is_empty() {
                anthropic_error(400, "invalid_request_error", message, None)
            } else {
                anthropic_text("OK", json!({"input_tokens": 10}))
            }
        }))
        .await;
        let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
        assert_eq!(result.unwrap().text, "OK", "{message}");
        let log = server.log.lock().clone();
        assert_eq!(log.len(), 2, "{message}");
        let second: Value = serde_json::from_str(&log[1].body).unwrap();
        assert!(second.get("fallbacks").is_none());
        assert_eq!(header_opt(&log[1], "anthropic-beta"), None);
    }

    // Other 400s are not retried.
    let server =
        serve(|| anthropic_error(400, "invalid_request_error", "max_tokens: too large", None))
            .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::BadRequest);
    assert_eq!(server.log.lock().len(), 1);
}

#[tokio::test]
async fn a_mid_stream_error_naming_fallbacks_is_never_re_sent() {
    let server = serve(|| {
        anthropic_stream(&[
            message_start(json!({"input_tokens": 10})),
            error_event(
                "invalid_request_error",
                "fallbacks: not supported for this model",
            ),
        ])
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::BadRequest);
    assert_eq!(server.log.lock().len(), 1, "nothing is sent twice");
}

#[tokio::test]
async fn honours_retry_after_and_gives_up_after_three_retries() {
    let server =
        serve(|| anthropic_error(429, "rate_limit_error", "Too many requests", Some(0))).await;
    let (result, events) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(server.log.lock().len(), 4);
    assert_eq!(err.kind, ProviderErrorKind::RateLimited);
    assert_eq!(err.retry_after, Some(Duration::ZERO));
    assert!(err.retryable());
    let retry_events: Vec<u32> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::Retrying {
                attempt, delay_ms, ..
            } => {
                assert_eq!(*delay_ms, 0, "retry-after: 0 is honoured");
                Some(*attempt)
            }
            _ => None,
        })
        .collect();
    assert_eq!(retry_events, vec![1, 2, 3]);
}

#[tokio::test]
async fn overloaded_errors_before_any_content_are_retried() {
    let server = support::start(Arc::new(|_req: &Request, log: &support::Log| {
        if log.lock().is_empty() {
            anthropic_stream(&[
                message_start(json!({"input_tokens": 10})),
                error_event("overloaded_error", "Overloaded"),
            ])
        } else {
            anthropic_text("OK", json!({"input_tokens": 10}))
        }
    }))
    .await;
    let (result, events) = chat(&anthropic(&server.url), &ask("hi")).await;
    assert_eq!(result.unwrap().text, "OK");
    assert_eq!(server.log.lock().len(), 2);
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::Retrying { attempt: 1, .. })));
}

#[tokio::test]
async fn errors_after_streamed_text_keep_the_partial_and_are_not_retried() {
    let server = serve(|| {
        anthropic_stream(&[
            message_start(json!({"input_tokens": 10})),
            block_start(0, json!({"type": "text", "text": ""})),
            block_delta(0, json!({"type": "text_delta", "text": "Partial"})),
            error_event("overloaded_error", "Overloaded"),
        ])
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Overloaded);
    assert!(err.retryable());
    assert_eq!(err.partial.unwrap().text, "Partial");
    assert_eq!(server.log.lock().len(), 1);
}

#[tokio::test]
async fn any_started_content_block_prevents_an_automatic_re_send() {
    let starts = [
        json!({"type": "thinking", "thinking": "", "signature": ""}),
        json!({"type": "redacted_thinking", "data": "opaque"}),
        json!({"type": "tool_use", "id": "toolu_1", "name": "get_pod", "input": {}}),
    ];
    for start in starts {
        let block = start.clone();
        let server = serve(move || {
            anthropic_stream(&[
                message_start(json!({"input_tokens": 10})),
                block_start(0, block.clone()),
                error_event("overloaded_error", "Overloaded"),
            ])
        })
        .await;
        let (result, events) = chat(&anthropic(&server.url), &ask("hi")).await;
        let err = result.unwrap_err();
        assert_eq!(err.kind, ProviderErrorKind::Overloaded, "{start}");
        assert!(err.retryable());
        let partial = err.partial.expect("content had started");
        assert!(partial.text.is_empty() && partial.tool_calls.is_empty());
        assert_eq!(server.log.lock().len(), 1, "{start}");
        assert!(!events
            .iter()
            .any(|e| matches!(e, StreamEvent::Retrying { .. })));
    }
}

#[tokio::test]
async fn retries_share_one_total_deadline() {
    // Every attempt stalls 250 ms before failing with nothing streamed.
    let server = serve(|| Reply::Sse {
        events: anthropic_sse(&[
            message_start(json!({"input_tokens": 10})),
            error_event("overloaded_error", "Overloaded"),
        ]),
        gap_ms: 250,
        cut_after: None,
    })
    .await;
    let timeouts = AiTimeouts {
        total: Duration::from_millis(400),
        ..Default::default()
    };
    let started = Instant::now();
    let (result, _) = chat(&anthropic_with(&server.url, timeouts, None), &ask("hi")).await;
    let err = result.unwrap_err();
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(err.kind, ProviderErrorKind::Timeout, "{}", err.message);
    assert!(server.log.lock().len() <= 2);
}

#[tokio::test]
async fn authentication_errors_are_not_retried_and_never_echo_the_key() {
    let server = serve(|| {
        anthropic_error(
            401,
            "authentication_error",
            &format!("invalid x-api-key: {KEY}"),
            None,
        )
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(server.log.lock().len(), 1);
    assert_eq!(err.kind, ProviderErrorKind::Auth);
    assert!(!err.retryable());
    assert!(!err.message.contains(KEY), "{}", err.message);
    assert!(!format!("{err:?}").contains(KEY));
    assert!(
        err.message.contains("authentication_error"),
        "{}",
        err.message
    );

    let provider = anthropic(&server.url);
    let err = provider.list_models().await.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Auth);
    assert!(!err.message.contains(KEY));
}

#[tokio::test]
async fn error_messages_are_truncated() {
    let long = "x".repeat(10 * 1024);
    let server = serve(move || anthropic_error(400, "invalid_request_error", &long, None)).await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::BadRequest);
    assert!(
        err.message.len() <= MAX_ERROR_MESSAGE_BYTES,
        "{}",
        err.message.len()
    );
    assert!(err.message.contains("invalid_request_error"));

    let server = serve(|| Reply::Raw {
        code: 502,
        headers: vec![("content-type".into(), "text/html".into())],
        body: format!("<html>{}</html>", "y".repeat(8 * 1024)),
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Server);
    assert!(err.message.len() <= MAX_ERROR_MESSAGE_BYTES);
    assert_eq!(server.log.lock().len(), 4, "5xx is retried three times");
}

#[tokio::test]
async fn redirects_are_not_followed_so_the_key_stays_with_its_base_url() {
    let elsewhere = serve(|| anthropic_text("stolen", json!({}))).await;
    let target = format!("{}/v1/messages", elsewhere.url);
    let server = serve(move || Reply::Raw {
        code: 307,
        headers: vec![("location".into(), target.clone())],
        body: String::new(),
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::BadRequest);
    assert!(!err.retryable());
    assert!(!err.message.contains(KEY));
    assert_eq!(server.log.lock().len(), 1);
    assert!(
        elsewhere.log.lock().is_empty(),
        "the redirect target saw nothing"
    );

    let err = anthropic(&server.url).list_models().await.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::BadRequest);
    assert!(elsewhere.log.lock().is_empty());
}

#[tokio::test]
async fn oversized_stream_events_are_protocol_errors() {
    let huge = "a".repeat(1024 * 1024 + 1024);
    let server = serve(move || {
        anthropic_stream(&[
            message_start(json!({"input_tokens": 10})),
            block_start(0, json!({"type": "text", "text": ""})),
            block_delta(0, json!({"type": "text_delta", "text": huge})),
            message_delta("end_turn", 1),
            message_stop(),
        ])
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);
    assert_eq!(server.log.lock().len(), 1);
}

#[tokio::test]
async fn oversized_tool_input_is_a_protocol_error() {
    let chunk = format!("\"{}", "b".repeat(64 * 1024));
    let server = serve(move || {
        let mut events = vec![
            message_start(json!({"input_tokens": 10})),
            tool_use_start(0, "toolu_1", "get_pod"),
            input_json_delta(0, "{\"pod\":"),
        ];
        for _ in 0..6 {
            events.push(input_json_delta(0, &chunk));
        }
        events.push(block_stop(0));
        events.push(message_delta("tool_use", 1));
        events.push(message_stop());
        anthropic_stream(&events)
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);
    assert!(err.partial.unwrap().tool_calls.is_empty());
}

#[tokio::test]
async fn idle_streams_time_out() {
    let timeouts = AiTimeouts {
        idle: Duration::from_millis(200),
        first_event: Duration::from_millis(200),
        ..Default::default()
    };
    let server = serve(|| Reply::Hang).await;
    let started = Instant::now();
    let (result, _) = chat(&anthropic_with(&server.url, timeouts, None), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Timeout);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        server.log.lock().len(),
        1,
        "stream timeouts are not retried"
    );

    // Idle between events (the first one arrived in time).
    let timeouts = AiTimeouts {
        idle: Duration::from_millis(200),
        first_event: Duration::from_secs(5),
        ..Default::default()
    };
    let server = serve(|| {
        let mut events = vec![message_start(json!({"input_tokens": 10}))];
        events.extend(text_block(0, "Slow answer"));
        Reply::Sse {
            events: anthropic_sse(&events),
            gap_ms: 600,
            cut_after: None,
        }
    })
    .await;
    let started = Instant::now();
    let (result, _) = chat(&anthropic_with(&server.url, timeouts, None), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Timeout);
    assert!(err.retryable());
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn cancellation_stops_the_stream() {
    let server = serve(|| {
        let mut events = vec![message_start(json!({"input_tokens": 10}))];
        events.extend(text_block(0, "This answer arrives very slowly"));
        events.push(message_delta("end_turn", 5));
        events.push(message_stop());
        Reply::Sse {
            events: anthropic_sse(&events),
            gap_ms: 300,
            cut_after: None,
        }
    })
    .await;
    let provider = anthropic(&server.url);
    let cancel = CancellationToken::new();
    let seen = Mutex::new(Vec::new());
    let started = Instant::now();
    let result = provider
        .chat(
            &ask("hi"),
            &|e| {
                if let StreamEvent::Text(t) = &e {
                    seen.lock().push(t.clone());
                    cancel.cancel();
                }
            },
            &cancel,
        )
        .await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Cancelled);
    assert!(!err.retryable());
    assert!(started.elapsed() < Duration::from_secs(1) + Duration::from_millis(700));
    assert_eq!(seen.lock().len(), 1);
    assert_eq!(err.partial.unwrap().text, "Thi");

    // Already cancelled: nothing is sent.
    let server = serve(|| anthropic_text("OK", json!({}))).await;
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let err = anthropic(&server.url)
        .chat(&ask("hi"), &|_| {}, &cancelled)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Cancelled);
    assert!(server.log.lock().is_empty());
}

#[tokio::test]
async fn lists_models_with_capabilities_across_pages() {
    let server = support::start(Arc::new(|req: &Request, _log: &support::Log| {
        match req.path_only() {
            "/v1/models" if req.path.contains("after_id=m1") => anthropic_models_page(
                vec![json!({"type": "model", "id": "m2", "display_name": "Model Two"})],
                false,
            ),
            "/v1/models" => anthropic_models_page(
                vec![llm::anthropic_model(
                    "m1",
                    "Model One",
                    1_000_000,
                    128_000,
                    true,
                    true,
                )],
                true,
            ),
            _ => Reply::Json(404, json!({})),
        }
    }))
    .await;
    let models = anthropic(&server.url).list_models().await.unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["m1", "m2"]
    );
    assert_eq!(models[0].display_name.as_deref(), Some("Model One"));
    assert_eq!(models[0].context_window, Some(1_000_000));
    assert_eq!(models[0].max_output_tokens, Some(128_000));
    assert_eq!(models[0].adaptive_thinking, Some(true));
    assert_eq!(models[0].effort, Some(true));
    // The fixture reports low/medium/high/max (no xhigh).
    assert_eq!(
        models[0].effort_levels,
        Some(vec![
            AiEffort::Low,
            AiEffort::Medium,
            AiEffort::High,
            AiEffort::Max
        ])
    );
    assert_eq!(models[1].effort_levels, None);
    assert_eq!(models[1].context_window, None);
    assert_eq!(models[1].adaptive_thinking, None);
    let log = server.log.lock();
    assert_eq!(log.len(), 2);
    for req in log.iter() {
        assert_eq!(req.method, "GET");
        assert_eq!(header(req, "x-api-key"), KEY);
        assert_eq!(header(req, "anthropic-version"), "2023-06-01");
        assert!(req.path.contains("limit="));
    }
    assert!(!log[0].path.contains("after_id"));
    assert!(log[1].path.contains("after_id=m1"));
}

#[tokio::test]
async fn model_info_reads_one_model() {
    let server = support::start(Arc::new(|req: &Request, _log: &support::Log| {
        match req.path_only() {
            "/v1/models/claude-opus-5" => Reply::Json(
                200,
                llm::anthropic_model(
                    "claude-opus-5",
                    "Claude Opus 5",
                    1_000_000,
                    128_000,
                    true,
                    true,
                ),
            ),
            _ => anthropic_error(404, "not_found_error", "model: nope", None),
        }
    }))
    .await;
    let provider = anthropic(&server.url);
    let info = provider.model_info("claude-opus-5").await.unwrap();
    assert_eq!(info.id, "claude-opus-5");
    assert_eq!(info.adaptive_thinking, Some(true));
    assert_eq!(info.effort, Some(true));
    assert_eq!(info.context_window, Some(1_000_000));
    let err = provider.model_info("nope/../x").await.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::NotFound);
    assert_eq!(server.log.lock()[1].path, "/v1/models/nope%2F..%2Fx");
}

#[test]
fn egress_guard_allows_only_loopback_without_the_opt_in() {
    assert_eq!(
        check_egress("https://api.anthropic.com", false, false)
            .unwrap_err()
            .kind,
        ProviderErrorKind::EgressRefused
    );
    assert!(check_egress("http://127.0.0.1:4000", false, false).is_ok());
    assert!(check_egress("https://api.anthropic.com", true, true).is_err());
    assert!(check_egress("https://api.anthropic.com", true, false).is_ok());
    assert!(check_egress("http://127.0.0.1:4000", true, true).is_ok());
    assert!(!check_egress("https://api.anthropic.com", false, false)
        .unwrap_err()
        .retryable());
}

#[tokio::test]
async fn every_provider_entry_point_checks_egress_before_connecting() {
    let server = serve(|| anthropic_text("OK", json!({}))).await;
    // Reaches the local fake server, but is not a loopback name: the guard
    // must refuse it before any socket is opened.
    let port = server.url.rsplit(':').next().unwrap();
    let url = format!("http://[::ffff:127.0.0.1]:{port}");
    assert!(!is_loopback(&url), "precondition: {url} counts as remote");
    for egress in [
        Egress::default(),
        Egress {
            remote_allowed: false,
            local_only: false,
        },
        Egress {
            remote_allowed: true,
            local_only: true,
        },
    ] {
        let provider = anthropic(&url).with_egress(egress);
        let (result, _) = chat(&provider, &ask("hi")).await;
        assert_eq!(result.unwrap_err().kind, ProviderErrorKind::EgressRefused);
        assert_eq!(
            provider.list_models().await.unwrap_err().kind,
            ProviderErrorKind::EgressRefused
        );
        assert_eq!(
            provider.model_info("claude-opus-5").await.unwrap_err().kind,
            ProviderErrorKind::EgressRefused
        );
    }
    assert!(server.log.lock().is_empty());
    assert!(!anthropic(&url).is_local());
    assert!(anthropic(&server.url).is_local());
}

#[test]
fn loopback_needs_both_url_parsers_to_agree() {
    // `url` (what reqwest connects to) reads these as 127.0.0.1, `http`
    // does not: the guard fails closed and treats them as remote.
    for url in [
        "http://127.1:4000",
        "http://0x7f000001:4000",
        "http://2130706433:4000",
    ] {
        assert!(!is_local_url(url), "{url}");
        assert_eq!(
            check_egress(url, false, false).unwrap_err().kind,
            ProviderErrorKind::EgressRefused,
            "{url}"
        );
        assert!(!anthropic(url).is_local(), "{url}");
    }
    for url in [
        "http://127.0.0.1:4000",
        "http://localhost:11434",
        "http://[::1]:8080",
    ] {
        assert!(is_local_url(url), "{url}");
        assert!(check_egress(url, false, false).is_ok(), "{url}");
    }
    assert!(AnthropicProvider::new(
        "not a url".into(),
        KEY.into(),
        AiTimeouts::default(),
        RetryPolicy::default(),
        None
    )
    .is_err());
}

#[tokio::test]
async fn the_key_is_trimmed() {
    let server = serve(|| anthropic_text("OK", json!({}))).await;
    let provider = AnthropicProvider::new(
        server.url.clone(),
        format!("  {KEY}\n"),
        AiTimeouts::default(),
        fast_retry(),
        None,
    )
    .unwrap();
    let (result, _) = chat(&provider, &ask("hi")).await;
    result.unwrap();
    assert_eq!(header(&server.log.lock()[0], "x-api-key"), KEY);
}

#[tokio::test]
async fn a_success_that_is_not_an_event_stream_is_a_protocol_error() {
    let server = serve(|| Reply::Raw {
        code: 200,
        headers: vec![("content-type".into(), "text/html".into())],
        body: "<html>Sign in to the proxy</html>".into(),
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);
    assert!(err.partial.is_none());
    assert_eq!(server.log.lock().len(), 1, "not retried");

    // An event stream that ends cleanly without a single event.
    let server = serve(|| Reply::Sse {
        events: vec![],
        gap_ms: 0,
        cut_after: None,
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);
    assert_eq!(server.log.lock().len(), 1);
}

#[tokio::test]
async fn reading_an_error_body_honours_cancel_and_the_deadline() {
    let server = serve(|| Reply::Stall { code: 400 }).await;
    let provider = anthropic(&server.url);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        trigger.cancel();
    });
    let started = Instant::now();
    let err = provider
        .chat(&ask("hi"), &|_| {}, &cancel)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(2));

    let timeouts = AiTimeouts {
        total: Duration::from_millis(300),
        ..Default::default()
    };
    let started = Instant::now();
    let (result, _) = chat(&anthropic_with(&server.url, timeouts, None), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::BadRequest, "{}", err.message);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn every_streamed_payload_counts_against_the_response_budget() {
    // Signatures: many 900 KiB signature deltas.
    let chunk = "s".repeat(900 * 1024);
    let server = serve(move || {
        let mut events = vec![
            message_start(json!({"input_tokens": 10})),
            block_start(
                0,
                json!({"type": "thinking", "thinking": "", "signature": ""}),
            ),
        ];
        for _ in 0..12 {
            events.push(block_delta(
                0,
                json!({"type": "signature_delta", "signature": chunk}),
            ));
        }
        anthropic_stream(&events)
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);

    // Block starts: many large redacted_thinking payloads.
    let data = "d".repeat(900 * 1024);
    let server = serve(move || {
        let mut events = vec![message_start(json!({"input_tokens": 10}))];
        for i in 0..12 {
            events.push(block_start(
                i,
                json!({"type": "redacted_thinking", "data": data}),
            ));
            events.push(block_stop(i));
        }
        anthropic_stream(&events)
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::Protocol);

    // Block count.
    let server = serve(|| {
        let mut events = vec![message_start(json!({"input_tokens": 10}))];
        for i in 0..=MAX_CONTENT_BLOCKS {
            events.push(block_start(i, json!({"type": "text", "text": ""})));
            events.push(block_stop(i));
        }
        events.push(message_delta("end_turn", 1));
        events.push(message_stop());
        anthropic_stream(&events)
    })
    .await;
    let (result, _) = chat(&anthropic(&server.url), &ask("hi")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);
}
