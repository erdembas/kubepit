//! The OpenAI-compatible and Ollama providers against the fake provider
//! server on 127.0.0.1: request shapes, streamed text and tool calls,
//! usage, stop reasons, model lists, errors and the egress rule. No real
//! provider is ever contacted.

mod support;

use std::sync::Arc;
use std::time::Duration;

use kubepit_core::ai::is_loopback;
use kubepit_core::ai::ollama::OllamaProvider;
use kubepit_core::ai::openai::{stop_reason, OpenAiCompatProvider};
use kubepit_core::ai::provider::{
    AiTimeouts, AssistantTurn, ChatMessage, ChatRequest, Egress, Provider, ProviderError,
    ProviderErrorKind, RetryPolicy, StopReason, StreamEvent, ToolCallReq, ToolSpec, UserBlock,
    MAX_TOOL_CALLS,
};
use kubepit_core::ai::{AiProviderKind, AiUsage};
use parking_lot::Mutex;
use serde_json::{json, Value};
use support::llm::*;
use support::{Reply, Request, SseEvent};
use tokio_util::sync::CancellationToken;

const KEY: &str = "sk-openai-test-0123456789abcdef";

fn fast_retry() -> RetryPolicy {
    RetryPolicy {
        base: Duration::from_millis(10),
        ..Default::default()
    }
}

/// Providers build their own client (no redirects, no proxy for loopback).
fn openai(url: &str, key: Option<&str>) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new(
        url.to_string(),
        key.map(str::to_string),
        AiTimeouts::default(),
        fast_retry(),
    )
    .unwrap()
}

fn ollama(url: &str) -> OllamaProvider {
    OllamaProvider::new(url.to_string(), 8192, AiTimeouts::default(), fast_retry()).unwrap()
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

fn request(model: &str, messages: Vec<ChatMessage>, tools: Vec<ToolSpec>) -> ChatRequest {
    ChatRequest {
        model: model.into(),
        system: "You are Kubepit's assistant.".into(),
        messages,
        tools,
        max_tokens: 1024,
        effort: None,
    }
}

/// A question with a context block and two tools.
fn ask(model: &str) -> ChatRequest {
    request(
        model,
        vec![ChatMessage::User(vec![
            text("<context>\npod web-1 in shop\n</context>", true),
            text("Why is web-1 crashing?", false),
        ])],
        vec![tool("list_pods"), tool("get_events")],
    )
}

/// The conversation after one tool round: question, assistant tool call,
/// tool results (one failed).
fn after_tool_round(model: &str) -> ChatRequest {
    let turn = AssistantTurn {
        raw: Value::Null,
        text: "Checking the events.".into(),
        tool_calls: vec![ToolCallReq {
            id: "c1".into(),
            name: "get_events".into(),
            input: Ok(json!({"namespace": "shop"})),
        }],
        stop: StopReason::ToolUse,
        usage: AiUsage::default(),
        model: model.into(),
    };
    let mut req = ask(model);
    req.messages.push(ChatMessage::Assistant(turn));
    req.messages.push(ChatMessage::User(vec![
        UserBlock::ToolResult {
            call_id: "c1".into(),
            content: "Warning BackOff web-1".into(),
            is_error: false,
        },
        UserBlock::ToolResult {
            call_id: "c2".into(),
            content: "forbidden".into(),
            is_error: true,
        },
    ]));
    req
}

async fn serve(reply: impl Fn() -> Reply + Send + Sync + 'static) -> support::FakeServer {
    support::start(Arc::new(move |_req: &Request, _log: &support::Log| reply())).await
}

async fn chat(
    provider: &dyn Provider,
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

fn body_of(req: &Request) -> Value {
    serde_json::from_str(&req.body).unwrap()
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

fn tool_call_stream() -> Reply {
    openai_stream(&[
        openai_chunk(json!({"role": "assistant", "content": "Look"}), None),
        openai_chunk(
            json!({"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                    "function": {"name": "get_events", "arguments": "{\"names"}}]}),
            None,
        ),
        openai_chunk(
            json!({"tool_calls": [{"index": 0, "function": {"arguments": "pace\":\"shop\"}"}}]}),
            None,
        ),
        openai_chunk(json!({}), Some("tool_calls")),
        openai_usage(json!({
            "prompt_tokens": 900, "completion_tokens": 40,
            "prompt_tokens_details": {"cached_tokens": 512},
        })),
    ])
}

#[tokio::test]
async fn openai_streams_text_tool_calls_and_usage() {
    let server = serve(tool_call_stream).await;
    let provider = openai(&server.url, Some(KEY));
    let (result, events) = chat(&provider, &ask("gpt-test")).await;
    let turn = result.unwrap();
    assert_eq!(texts(&events), vec!["Look"]);
    assert_eq!(turn.text, "Look");
    assert!(matches!(turn.stop, StopReason::ToolUse));
    assert_eq!(turn.tool_calls.len(), 1);
    assert_eq!(turn.tool_calls[0].id, "c1");
    assert_eq!(turn.tool_calls[0].name, "get_events");
    assert_eq!(
        turn.tool_calls[0].input.as_ref().unwrap()["namespace"],
        "shop"
    );
    // `prompt_tokens` (900) includes the 512 cached ones; `input_tokens`
    // is the uncached rest, as with Anthropic, so nothing is counted twice.
    assert_eq!(
        turn.usage,
        AiUsage {
            input_tokens: 388,
            output_tokens: 40,
            cache_read_tokens: 512,
            cache_write_tokens: 0
        }
    );
    assert_eq!(turn.model, "gpt-test");
    assert_eq!(turn.raw["role"], "assistant");
    assert_eq!(
        turn.raw["tool_calls"][0]["function"]["arguments"],
        "{\"namespace\":\"shop\"}"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::Usage(u) if u.input_tokens == 388)));
}

#[tokio::test]
async fn openai_sends_bearer_only_with_a_key_and_asks_for_usage() {
    let server =
        serve(|| openai_stream(&[openai_chunk(json!({"content": "OK"}), Some("stop"))])).await;
    let (result, _) = chat(&openai(&server.url, Some("k")), &ask("gpt-test")).await;
    assert_eq!(result.unwrap().text, "OK");
    let req = server.log.lock()[0].clone();
    assert_eq!(req.method, "POST");
    assert_eq!(req.path, "/chat/completions");
    assert_eq!(req.header("authorization"), Some("Bearer k"));
    assert_eq!(req.header("content-type"), Some("application/json"));
    assert_eq!(req.header("x-api-key"), None);
    let body = body_of(&req);
    assert_eq!(body["stream"], true);
    assert_eq!(body["stream_options"]["include_usage"], true);
    assert_eq!(body["model"], "gpt-test");
    assert_eq!(body["max_tokens"], 1024);
    let names: Vec<_> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["get_events", "list_pods"],
        "tools sorted by name"
    );
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["function"]["parameters"]["type"], "object");

    // Without a key (a local server): no authorization header.
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    result.unwrap();
    let (result, _) = chat(&openai(&server.url, Some("  ")), &ask("gpt-test")).await;
    result.unwrap();
    let log = server.log.lock();
    assert_eq!(log[1].header("authorization"), None);
    assert_eq!(log[2].header("authorization"), None);
}

#[test]
fn openai_folds_context_into_the_first_user_message_and_tool_results_into_tool_messages() {
    let body = openai("http://127.0.0.1:9", None).request_body(&after_tool_round("gpt-test"));
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 5);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(
        body["messages"][0]["content"],
        "You are Kubepit's assistant."
    );
    assert_eq!(body["messages"][1]["role"], "user");
    assert!(body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .starts_with("<context>"));
    assert_eq!(
        body["messages"][1]["content"],
        "<context>\npod web-1 in shop\n</context>\n\nWhy is web-1 crashing?"
    );
    assert_eq!(body["messages"][2]["role"], "assistant");
    assert_eq!(body["messages"][2]["content"], "Checking the events.");
    assert_eq!(
        body["messages"][2]["tool_calls"],
        json!([{"id": "c1", "type": "function",
                "function": {"name": "get_events", "arguments": "{\"namespace\":\"shop\"}"}}])
    );
    assert_eq!(body["messages"][3]["role"], "tool");
    assert_eq!(body["messages"][3]["tool_call_id"], "c1");
    assert_eq!(body["messages"][3]["content"], "Warning BackOff web-1");
    assert_eq!(body["messages"][4]["tool_call_id"], "c2");
    assert_eq!(body["messages"][4]["content"], "ERROR: forbidden");
    assert!(body.get("cache_control").is_none() && body.get("fallbacks").is_none());
}

#[test]
fn openai_finish_reasons_map_to_stop_reasons() {
    assert_eq!(stop_reason("stop"), StopReason::EndTurn);
    assert_eq!(stop_reason("tool_calls"), StopReason::ToolUse);
    assert_eq!(stop_reason("function_call"), StopReason::ToolUse);
    assert_eq!(stop_reason("length"), StopReason::MaxTokens);
    assert_eq!(
        stop_reason("content_filter"),
        StopReason::Refusal { category: None }
    );
    assert_eq!(stop_reason("something_new"), StopReason::EndTurn);
}

#[tokio::test]
async fn openai_length_and_content_filter_run_no_tools() {
    for (finish, expected) in [
        ("length", StopReason::MaxTokens),
        ("content_filter", StopReason::Refusal { category: None }),
    ] {
        let server = serve(move || {
            openai_stream(&[
                openai_chunk(
                    json!({"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                            "function": {"name": "get_pod", "arguments": "{\"pod\":\"web-1\"}"}}]}),
                    None,
                ),
                openai_chunk(json!({}), Some(finish)),
            ])
        })
        .await;
        let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
        let turn = result.unwrap();
        assert_eq!(turn.stop, expected);
        assert!(turn.tool_calls.is_empty());
        assert!(turn.raw.get("tool_calls").is_none());
    }
}

#[tokio::test]
async fn openai_unparseable_arguments_are_kept_raw() {
    let server = serve(|| {
        openai_stream(&[
            openai_chunk(
                json!({"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                        "function": {"name": "get_pod", "arguments": "{\"pod\": \"we"}}]}),
                None,
            ),
            openai_chunk(json!({}), Some("tool_calls")),
        ])
    })
    .await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    let turn = result.unwrap();
    assert_eq!(turn.tool_calls[0].input, Err("{\"pod\": \"we".to_string()));
}

#[tokio::test]
async fn openai_switches_to_max_completion_tokens_when_asked() {
    let server = support::start(Arc::new(|_req: &Request, log: &support::Log| {
        if log.lock().is_empty() {
            Reply::Json(
                400,
                json!({"error": {"message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
                                 "type": "invalid_request_error", "param": "max_tokens", "code": "unsupported_parameter"}}),
            )
        } else {
            openai_stream(&[openai_chunk(json!({"content": "OK"}), Some("stop"))])
        }
    }))
    .await;
    let provider = openai(&server.url, Some(KEY));
    let (result, _) = chat(&provider, &ask("gpt-test")).await;
    assert_eq!(result.unwrap().text, "OK");
    let log = server.log.lock().clone();
    assert_eq!(log.len(), 2);
    assert_eq!(body_of(&log[0])["max_tokens"], 1024);
    let second = body_of(&log[1]);
    assert!(second.get("max_tokens").is_none());
    assert_eq!(second["max_completion_tokens"], 1024);
}

#[tokio::test]
async fn openai_drops_stream_options_when_the_server_rejects_them() {
    let server = support::start(Arc::new(|_req: &Request, log: &support::Log| {
        if log.lock().is_empty() {
            Reply::Json(
                400,
                json!({"error": {"message": "Unrecognized request argument supplied: stream_options",
                                 "type": "invalid_request_error"}}),
            )
        } else {
            openai_stream(&[openai_chunk(json!({"content": "OK"}), Some("stop"))])
        }
    }))
    .await;
    let provider = openai(&server.url, None);
    let (result, _) = chat(&provider, &ask("gpt-test")).await;
    assert_eq!(result.unwrap().text, "OK");
    let log = server.log.lock().clone();
    assert_eq!(log.len(), 2);
    assert_eq!(body_of(&log[0])["stream_options"]["include_usage"], true);
    assert!(body_of(&log[1]).get("stream_options").is_none());
    // Remembered for later requests.
    let (again, _) = chat(&provider, &ask("gpt-test")).await;
    again.unwrap();
    assert!(body_of(&server.log.lock()[2])
        .get("stream_options")
        .is_none());

    // Any other 400 is returned as is.
    let server = serve(|| {
        Reply::Json(
            400,
            json!({"error": {"message": "messages: too long", "type": "invalid_request_error"}}),
        )
    })
    .await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::BadRequest);
    assert_eq!(server.log.lock().len(), 1);
}

#[tokio::test]
async fn openai_tool_calls_without_an_index_are_keyed_by_id() {
    let server = serve(|| {
        openai_stream(&[
            openai_chunk(
                json!({"tool_calls": [{"id": "a", "type": "function",
                        "function": {"name": "get_pod", "arguments": "{\"pod\":"}}]}),
                None,
            ),
            openai_chunk(
                json!({"tool_calls": [{"id": "b", "type": "function",
                        "function": {"name": "get_events", "arguments": "{}"}}]}),
                None,
            ),
            openai_chunk(
                json!({"tool_calls": [{"id": "a", "function": {"arguments": "\"web-1\"}"}}]}),
                None,
            ),
            openai_chunk(json!({}), Some("tool_calls")),
        ])
    })
    .await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    let turn = result.unwrap();
    let calls: Vec<_> = turn
        .tool_calls
        .iter()
        .map(|c| (c.id.as_str(), c.name.as_str(), c.input.clone()))
        .collect();
    assert_eq!(
        calls,
        vec![
            ("a", "get_pod", Ok(json!({"pod": "web-1"}))),
            ("b", "get_events", Ok(json!({}))),
        ]
    );
}

#[tokio::test]
async fn openai_and_ollama_cap_the_number_of_tool_calls() {
    let server = serve(|| {
        let mut chunks: Vec<Value> = (0..=MAX_TOOL_CALLS)
            .map(|i| {
                openai_chunk(
                    json!({"tool_calls": [{"index": i, "id": format!("c{i}"), "type": "function",
                            "function": {"name": "get_pod", "arguments": "{}"}}]}),
                    None,
                )
            })
            .collect();
        chunks.push(openai_chunk(json!({}), Some("tool_calls")));
        openai_stream(&chunks)
    })
    .await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);

    let server = serve(|| {
        let calls: Vec<Value> = (0..=MAX_TOOL_CALLS)
            .map(|_| json!({"function": {"name": "get_pod", "arguments": {}}}))
            .collect();
        ollama_stream(&[
            json!({"model": "llama3.1:8b", "done": false,
                   "message": {"role": "assistant", "content": "", "tool_calls": calls}}),
            ollama_done("stop", 1, 1),
        ])
    })
    .await;
    let (result, _) = chat(&ollama(&server.url), &ask("llama3.1:8b")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::Protocol);
}

#[tokio::test]
async fn openai_errors_never_echo_the_key_and_cut_streams_keep_the_partial() {
    let server = serve(|| {
        Reply::Json(
            401,
            json!({"error": {"message": format!("Incorrect API key provided: {KEY}"),
                             "type": "invalid_request_error", "code": "invalid_api_key"}}),
        )
    })
    .await;
    let (result, _) = chat(&openai(&server.url, Some(KEY)), &ask("gpt-test")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Auth);
    assert!(!err.message.contains(KEY), "{}", err.message);
    assert_eq!(server.log.lock().len(), 1);

    let server = serve(|| Reply::Sse {
        events: vec![support::SseEvent {
            event: None,
            data: openai_chunk(json!({"content": "Half an answer"}), None).to_string(),
        }],
        gap_ms: 0,
        cut_after: Some(1),
    })
    .await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Network);
    assert!(err.retryable());
    assert_eq!(err.partial.unwrap().text, "Half an answer");

    let server = serve(|| {
        openai_stream(&[json!({"error": {"message": "backend exploded", "type": "server_error"}})])
    })
    .await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Server);
    assert!(err.message.contains("backend exploded"));
}

#[tokio::test]
async fn openai_lists_models() {
    let server = support::start(Arc::new(|req: &Request, _log: &support::Log| {
        match req.path_only() {
            "/v1/models" => Reply::Json(
                200,
                json!({"object": "list", "data": [
                    {"id": "gpt-b", "object": "model"}, {"id": "gpt-a", "object": "model"}]}),
            ),
            _ => Reply::Json(404, json!({})),
        }
    }))
    .await;
    let base = format!("{}/v1", server.url);
    let provider = openai(&base, Some(KEY));
    let models = provider.list_models().await.unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["gpt-a", "gpt-b"]
    );
    assert_eq!(
        server.log.lock()[0].header("authorization"),
        Some(&*format!("Bearer {KEY}"))
    );
    assert_eq!(provider.kind(), AiProviderKind::OpenaiCompatible);
    assert!(provider.is_local());
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ollama_streams_ndjson_sets_num_ctx_and_synthesizes_call_ids() {
    let server = serve(|| {
        ollama_stream(&[
            ollama_line("Check"),
            ollama_line("ing"),
            json!({
                "model": "llama3.1:8b", "created_at": "2026-09-29T10:00:00Z",
                "message": {"role": "assistant", "content": "", "tool_calls": [
                    {"function": {"name": "get_events", "arguments": {"namespace": "shop"}}},
                    {"function": {"name": "list_pods", "arguments": {"namespace": "shop"}}},
                ]},
                "done": false,
            }),
            ollama_done("stop", 321, 12),
        ])
    })
    .await;
    let (result, events) = chat(&ollama(&server.url), &ask("llama3.1:8b")).await;
    let turn = result.unwrap();
    let req = server.log.lock()[0].clone();
    assert_eq!(req.path, "/api/chat");
    assert_eq!(req.header("authorization"), None);
    let body = body_of(&req);
    assert_eq!(body["options"]["num_ctx"], 8192);
    assert_eq!(body["options"]["num_predict"], 1024);
    assert_eq!(body["stream"], true);
    assert_eq!(body["model"], "llama3.1:8b");
    assert_eq!(body["messages"][0]["role"], "system");
    assert!(body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .starts_with("<context>"));
    assert_eq!(body["tools"][0]["function"]["name"], "get_events");
    assert_eq!(texts(&events), vec!["Check", "ing"]);
    assert_eq!(turn.text, "Checking");
    assert!(matches!(turn.stop, StopReason::ToolUse));
    assert_eq!(turn.tool_calls[0].id, "call_1");
    assert_eq!(turn.tool_calls[1].id, "call_2");
    assert_eq!(turn.tool_calls[0].name, "get_events");
    assert_eq!(turn.tool_calls[0].input, Ok(json!({"namespace": "shop"})));
    assert_eq!(turn.usage.input_tokens, 321);
    assert_eq!(turn.usage.output_tokens, 12);
    assert_eq!(turn.model, "llama3.1:8b");
}

#[test]
fn ollama_sends_tool_results_with_their_tool_name() {
    let body = ollama("http://127.0.0.1:9").request_body(&after_tool_round("llama3.1:8b"));
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 5);
    assert_eq!(
        messages[2]["tool_calls"],
        json!([{"function": {"name": "get_events", "arguments": {"namespace": "shop"}}}])
    );
    assert_eq!(messages[3]["role"], "tool");
    assert_eq!(messages[3]["tool_name"], "get_events");
    assert_eq!(messages[3]["content"], "Warning BackOff web-1");
    assert_eq!(messages[4]["content"], "ERROR: forbidden");
    assert!(messages[4].get("tool_name").is_none(), "unknown call id");
}

#[tokio::test]
async fn ollama_length_stops_and_error_lines_fail_with_the_partial() {
    let server = serve(|| {
        ollama_stream(&[
            json!({
                "model": "llama3.1:8b",
                "message": {"role": "assistant", "content": "", "tool_calls": [
                    {"function": {"name": "get_events", "arguments": {"namespace": "shop"}}}]},
                "done": false,
            }),
            ollama_done("length", 10, 1024),
        ])
    })
    .await;
    let (result, _) = chat(&ollama(&server.url), &ask("llama3.1:8b")).await;
    let turn = result.unwrap();
    assert!(matches!(turn.stop, StopReason::MaxTokens));
    assert!(turn.tool_calls.is_empty());

    let server = serve(|| {
        ollama_stream(&[
            ollama_line("Partial"),
            json!({"error": "an unknown error was encountered while running the model"}),
        ])
    })
    .await;
    let (result, _) = chat(&ollama(&server.url), &ask("llama3.1:8b")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Server);
    assert_eq!(err.partial.unwrap().text, "Partial");

    let server = serve(|| {
        Reply::Json(
            404,
            json!({"error": "model \"nope\" not found, try pulling it first"}),
        )
    })
    .await;
    let (result, _) = chat(&ollama(&server.url), &ask("nope")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::NotFound);
    assert!(err.message.contains("try pulling it first"));
}

#[tokio::test]
async fn ollama_oversized_lines_are_protocol_errors() {
    let huge = "z".repeat(1024 * 1024 + 16);
    let server = serve(move || ollama_stream(&[ollama_line(&huge)])).await;
    let (result, _) = chat(&ollama(&server.url), &ask("llama3.1:8b")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::Protocol);
}

#[tokio::test]
async fn ollama_lists_local_models_and_is_local_on_loopback() {
    let server = support::start(Arc::new(|req: &Request, _log: &support::Log| {
        match req.path_only() {
            "/api/tags" => Reply::Json(
                200,
                json!({"models": [
                    {"name": "qwen2.5-coder:7b", "model": "qwen2.5-coder:7b", "size": 1},
                    {"name": "llama3.1:8b", "model": "llama3.1:8b", "size": 2},
                ]}),
            ),
            _ => Reply::Json(404, json!({})),
        }
    }))
    .await;
    let provider = ollama(&server.url);
    let models = provider.list_models().await.unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["llama3.1:8b", "qwen2.5-coder:7b"]
    );
    assert!(provider.is_local());
    assert_eq!(provider.kind(), AiProviderKind::Ollama);
    assert_eq!(server.log.lock()[0].method, "GET");
}

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

#[tokio::test]
async fn openai_and_ollama_check_egress_before_connecting() {
    let server =
        serve(|| openai_stream(&[openai_chunk(json!({"content": "OK"}), Some("stop"))])).await;
    let port = server.url.rsplit(':').next().unwrap();
    let url = format!("http://[::ffff:127.0.0.1]:{port}");
    assert!(!is_loopback(&url), "precondition: {url} counts as remote");
    let providers: Vec<Box<dyn Provider>> =
        vec![Box::new(openai(&url, Some(KEY))), Box::new(ollama(&url))];
    for provider in &providers {
        let (result, _) = chat(provider.as_ref(), &ask("m")).await;
        assert_eq!(result.unwrap_err().kind, ProviderErrorKind::EgressRefused);
        assert_eq!(
            provider.list_models().await.unwrap_err().kind,
            ProviderErrorKind::EgressRefused
        );
        assert!(!provider.is_local());
    }
    assert!(server.log.lock().is_empty());
}

#[tokio::test]
async fn egress_can_be_refreshed_on_a_cached_provider() {
    let server = serve(|| ollama_stream(&[ollama_line("OK"), ollama_done("stop", 1, 1)])).await;
    let port = server.url.rsplit(':').next().unwrap();
    let url = format!("http://[::ffff:127.0.0.1]:{port}");
    let provider = ollama(&url);
    let (result, _) = chat(&provider, &ask("m")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::EgressRefused);
    // The session refreshes the rule per send on its cached instance.
    provider.set_egress(Egress {
        remote_allowed: true,
        local_only: false,
    });
    let (result, _) = chat(&provider, &ask("m")).await;
    if let Err(err) = &result {
        assert_ne!(
            err.kind,
            ProviderErrorKind::EgressRefused,
            "{}",
            err.message
        );
    }
    provider.set_egress(Egress {
        remote_allowed: true,
        local_only: true,
    });
    let (result, _) = chat(&provider, &ask("m")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::EgressRefused);
    assert_eq!(
        provider.list_models().await.unwrap_err().kind,
        ProviderErrorKind::EgressRefused
    );
}

#[tokio::test]
async fn openai_sends_a_key_only_over_https_or_to_loopback() {
    let server =
        serve(|| openai_stream(&[openai_chunk(json!({"content": "OK"}), Some("stop"))])).await;
    let port = server.url.rsplit(':').next().unwrap();
    let url = format!("http://[::ffff:127.0.0.1]:{port}");
    let remote = Egress {
        remote_allowed: true,
        local_only: false,
    };
    let with_key = openai(&url, Some(KEY)).with_egress(remote);
    let (result, _) = chat(&with_key, &ask("m")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::EgressRefused);
    assert_eq!(
        with_key.list_models().await.unwrap_err().kind,
        ProviderErrorKind::EgressRefused
    );
    assert!(server.log.lock().is_empty(), "the key was never sent");
    // Without a key plain http to a remote host is allowed.
    let keyless = openai(&url, None).with_egress(remote);
    let (result, _) = chat(&keyless, &ask("m")).await;
    if let Err(err) = &result {
        assert_ne!(
            err.kind,
            ProviderErrorKind::EgressRefused,
            "{}",
            err.message
        );
    }
}

#[tokio::test]
async fn openai_a_reused_index_with_a_new_id_starts_a_new_call() {
    let server = serve(|| {
        openai_stream(&[
            openai_chunk(
                json!({"tool_calls": [{"index": 0, "id": "a", "type": "function",
                        "function": {"name": "get_pod", "arguments": "{}"}}]}),
                None,
            ),
            openai_chunk(
                json!({"tool_calls": [{"index": 0, "id": "b", "type": "function",
                        "function": {"name": "get_events", "arguments": "{\"names"}}]}),
                None,
            ),
            openai_chunk(
                json!({"tool_calls": [{"index": 0, "function": {"arguments": "pace\":\"shop\"}"}}]}),
                None,
            ),
            // Same index, no id, a different name: a new call too.
            openai_chunk(
                json!({"tool_calls": [{"index": 0, "type": "function",
                        "function": {"name": "list_pods", "arguments": "{}"}}]}),
                None,
            ),
            openai_chunk(json!({}), Some("tool_calls")),
        ])
    })
    .await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    let turn = result.unwrap();
    let calls: Vec<_> = turn
        .tool_calls
        .iter()
        .map(|c| (c.id.as_str(), c.name.as_str(), c.input.clone()))
        .collect();
    assert_eq!(
        calls,
        vec![
            ("a", "get_pod", Ok(json!({}))),
            ("b", "get_events", Ok(json!({"namespace": "shop"}))),
            ("call_3", "list_pods", Ok(json!({}))),
        ]
    );
}

fn sse_body(chunks: &[Value]) -> String {
    let mut body: String = chunks
        .iter()
        .map(|c| {
            SseEvent {
                event: None,
                data: c.to_string(),
            }
            .wire()
        })
        .collect();
    body.push_str("data: [DONE]\n\n");
    body
}

#[tokio::test]
async fn openai_accepts_event_streams_with_or_without_a_content_type() {
    for content_type in [Some("text/event-stream; charset=utf-8"), None] {
        let server = serve(move || Reply::Raw {
            code: 200,
            headers: content_type
                .map(|ct| vec![("content-type".to_string(), ct.to_string())])
                .unwrap_or_default(),
            body: sse_body(&[openai_chunk(json!({"content": "OK"}), Some("stop"))]),
        })
        .await;
        let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
        assert_eq!(result.unwrap().text, "OK", "{content_type:?}");
    }

    // No content type, but not an event stream: a protocol error.
    let server = serve(|| Reply::Raw {
        code: 200,
        headers: vec![],
        body: json!({"choices": [{"message": {"content": "not streamed"}}]}).to_string(),
    })
    .await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    assert_eq!(result.unwrap_err().kind, ProviderErrorKind::Protocol);
    assert_eq!(server.log.lock().len(), 1, "not retried");
}

#[tokio::test]
async fn html_pages_from_a_proxy_are_protocol_errors() {
    let page = || Reply::Raw {
        code: 200,
        headers: vec![("content-type".into(), "text/html; charset=utf-8".into())],
        body: "<html>Please sign in</html>".into(),
    };
    let server = serve(page).await;
    let (result, _) = chat(&openai(&server.url, None), &ask("gpt-test")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);
    assert_eq!(server.log.lock().len(), 1);

    let server = serve(page).await;
    let (result, _) = chat(&ollama(&server.url), &ask("llama3.1:8b")).await;
    let err = result.unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Protocol, "{}", err.message);
    assert_eq!(server.log.lock().len(), 1);
}

#[tokio::test]
async fn ollama_also_accepts_json_streams() {
    let server = serve(|| Reply::Stream(vec![ollama_line("OK"), ollama_done("stop", 1, 1)])).await;
    let (result, _) = chat(&ollama(&server.url), &ask("llama3.1:8b")).await;
    assert_eq!(result.unwrap().text, "OK");
}
