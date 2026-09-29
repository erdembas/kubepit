//! The OpenAI-compatible provider (spec D2): any `POST
//! {base}/chat/completions` endpoint (OpenAI, vLLM, LM Studio, llama.cpp,
//! LiteLLM, Ollama's compatibility layer …), streamed as SSE `data:` chunks
//! until `data: [DONE]`.
//!
//! - `Authorization: Bearer <key>` only when a key is set (local servers
//!   usually need none); `stream_options.include_usage` asks for the final
//!   usage chunk.
//! - The system prompt is the first message; a user message's text blocks
//!   (the context block, then the question) are joined with a blank line;
//!   tool results become `role: tool` messages (`ERROR: ` prefix when they
//!   failed); tools are sent sorted by name as `function` tools.
//! - Tool-call deltas accumulate by `index`; arguments are parsed strictly.
//!   `length` and `content_filter` finishes run no tools.
//! - Models that only take `max_completion_tokens` answer a 400 naming it;
//!   the provider then switches and sends the request once more.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::provider::{
    endpoint, parse_tool_input, secret_header, with_retries, AiTimeouts, AssistantTurn, Budget,
    Call, ChatMessage, ChatRequest, Decoder, Egress, EventSink, Provider, ProviderError,
    ProviderErrorKind, RetryPolicy, StopReason, StreamEvent, ToolCallReq, ToolSpec, UserBlock,
    MAX_TOOL_INPUT_BYTES, MAX_TURN_TEXT_BYTES,
};
use super::settings::is_loopback;
use super::sse::SseParser;
use super::types::{AiModelInfo, AiProviderKind, AiUsage};

const NAME: &str = "The OpenAI-compatible server";

pub struct OpenAiCompatProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    timeouts: AiTimeouts,
    retry: RetryPolicy,
    egress: Egress,
    /// Send `max_completion_tokens` instead of `max_tokens`.
    completion_tokens: AtomicBool,
}

impl OpenAiCompatProvider {
    /// A provider at `base_url` (e.g. `https://api.openai.com/v1`; a
    /// trailing slash is dropped). A blank key sends no `Authorization`.
    /// Egress: loopback only until [`OpenAiCompatProvider::with_egress`].
    pub fn new(
        client: reqwest::Client,
        base_url: String,
        api_key: Option<String>,
        timeouts: AiTimeouts,
        retry: RetryPolicy,
    ) -> Self {
        Self {
            client,
            base_url: base_url.trim().trim_end_matches('/').to_string(),
            api_key: api_key
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty()),
            timeouts,
            retry,
            egress: Egress::default(),
            completion_tokens: AtomicBool::new(false),
        }
    }

    /// The egress rule checked before every request.
    pub fn with_egress(mut self, egress: Egress) -> Self {
        self.egress = egress;
        self
    }

    /// The JSON body `chat` sends for `req`.
    pub fn request_body(&self, req: &ChatRequest) -> Value {
        self.body(req, self.completion_tokens.load(Ordering::SeqCst))
    }

    fn body(&self, req: &ChatRequest, completion_tokens: bool) -> Value {
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        body.insert("stream".into(), json!(true));
        body.insert("stream_options".into(), json!({"include_usage": true}));
        let cap = if completion_tokens {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        body.insert(cap.into(), json!(req.max_tokens));
        body.insert(
            "messages".into(),
            Value::Array(messages(&req.system, &req.messages)),
        );
        if !req.tools.is_empty() {
            body.insert("tools".into(), Value::Array(function_tools(&req.tools)));
        }
        Value::Object(body)
    }

    fn secrets(&self) -> Vec<&str> {
        self.api_key.as_deref().into_iter().collect()
    }

    fn authorized(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        Ok(match &self.api_key {
            Some(key) => request.header(
                reqwest::header::AUTHORIZATION,
                secret_header(&format!("Bearer {key}"))?,
            ),
            None => request,
        })
    }

    async fn attempt(
        &self,
        req: &ChatRequest,
        on_event: EventSink<'_>,
        cancel: &CancellationToken,
    ) -> Result<AssistantTurn, ProviderError> {
        let completion_tokens = self.completion_tokens.load(Ordering::SeqCst);
        match self
            .send_once(req, completion_tokens, on_event, cancel)
            .await
        {
            Err(error)
                if !completion_tokens
                    && error.kind == ProviderErrorKind::BadRequest
                    && error.message.contains("max_completion_tokens") =>
            {
                self.completion_tokens.store(true, Ordering::SeqCst);
                self.send_once(req, true, on_event, cancel).await
            }
            result => result,
        }
    }

    async fn send_once(
        &self,
        req: &ChatRequest,
        completion_tokens: bool,
        on_event: EventSink<'_>,
        cancel: &CancellationToken,
    ) -> Result<AssistantTurn, ProviderError> {
        let url = endpoint(&self.base_url, &["chat", "completions"])?;
        let body = serde_json::to_vec(&self.body(req, completion_tokens)).map_err(|e| {
            ProviderError::new(
                ProviderErrorKind::BadRequest,
                format!("could not encode the request: {e}"),
            )
        })?;
        let request = self
            .authorized(self.client.post(url.clone()))?
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .body(body);
        let secrets = self.secrets();
        let call = Call::new(NAME, &url, &secrets, &self.timeouts, cancel);
        let response = call.send(request).await?;
        let mut stream = CompletionStream::new(&req.model);
        call.read_stream(response, &mut stream, on_event).await?;
        Ok(stream.finish())
    }

    async fn get_models(&self, cancel: &CancellationToken) -> Result<Value, ProviderError> {
        let url = endpoint(&self.base_url, &["models"])?;
        let secrets = self.secrets();
        let call = Call::new(NAME, &url, &secrets, &self.timeouts, cancel);
        call.json(self.authorized(self.client.get(url.clone()))?)
            .await
    }
}

impl Provider for OpenAiCompatProvider {
    fn kind(&self) -> AiProviderKind {
        AiProviderKind::OpenaiCompatible
    }

    fn is_local(&self) -> bool {
        is_loopback(&self.base_url)
    }

    /// `GET {base}/models` → ids, sorted.
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<AiModelInfo>, ProviderError>> {
        Box::pin(async move {
            self.egress.check(&self.base_url)?;
            let cancel = CancellationToken::new();
            let value =
                with_retries(&self.retry, &|_| {}, &cancel, || self.get_models(&cancel)).await?;
            let data = value["data"].as_array().ok_or_else(|| {
                ProviderError::new(
                    ProviderErrorKind::Protocol,
                    format!("{NAME} sent a model list without data"),
                )
            })?;
            let mut ids: Vec<String> = data
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect();
            ids.sort();
            ids.dedup();
            Ok(ids
                .into_iter()
                .map(|id| AiModelInfo {
                    id,
                    ..Default::default()
                })
                .collect())
        })
    }

    fn chat<'a>(
        &'a self,
        req: &'a ChatRequest,
        on_event: EventSink<'a>,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<AssistantTurn, ProviderError>> {
        Box::pin(async move {
            self.egress.check(&self.base_url)?;
            with_retries(&self.retry, on_event, cancel, || {
                self.attempt(req, on_event, cancel)
            })
            .await
        })
    }
}

/// `finish_reason` → [`StopReason`].
pub fn stop_reason(finish_reason: &str) -> StopReason {
    match finish_reason {
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
        "content_filter" => StopReason::Refusal { category: None },
        _ => StopReason::EndTurn,
    }
}

/// Tools as OpenAI `function` tools, sorted by name (also Ollama's format).
pub(crate) fn function_tools(tools: &[ToolSpec]) -> Vec<Value> {
    let mut tools: Vec<_> = tools.iter().collect();
    tools.sort_by_key(|t| t.name);
    tools
        .into_iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {"name": t.name, "description": t.description, "parameters": t.schema},
            })
        })
        .collect()
}

/// The text blocks of a user message joined with a blank line (the
/// context block and the question become one message).
pub(crate) fn user_text(blocks: &[UserBlock]) -> Option<String> {
    let texts: Vec<&str> = blocks
        .iter()
        .filter_map(|b| match b {
            UserBlock::Text { text, .. } if !text.is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect();
    (!texts.is_empty()).then(|| texts.join("\n\n"))
}

/// A tool result's content, `ERROR: `-prefixed when the call failed.
pub(crate) fn tool_result_text(content: &str, is_error: bool) -> String {
    if is_error {
        format!("ERROR: {content}")
    } else {
        content.to_string()
    }
}

fn arguments_text(input: &Result<Value, String>) -> String {
    match input {
        Ok(value) => value.to_string(),
        Err(raw) => raw.clone(),
    }
}

fn assistant_message(text: &str, calls: &[ToolCallReq]) -> Value {
    let mut message = json!({"role": "assistant", "content": text});
    if !calls.is_empty() {
        message["tool_calls"] = calls
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "type": "function",
                    "function": {"name": c.name, "arguments": arguments_text(&c.input)},
                })
            })
            .collect();
    }
    message
}

fn messages(system: &str, messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::with_capacity(messages.len() + 1);
    if !system.is_empty() {
        out.push(json!({"role": "system", "content": system}));
    }
    for message in messages {
        match message {
            ChatMessage::User(blocks) => {
                for block in blocks {
                    if let UserBlock::ToolResult {
                        call_id,
                        content,
                        is_error,
                    } = block
                    {
                        out.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": tool_result_text(content, *is_error),
                        }));
                    }
                }
                if let Some(text) = user_text(blocks) {
                    out.push(json!({"role": "user", "content": text}));
                }
            }
            ChatMessage::Assistant(turn) => {
                if !turn.text.is_empty() || !turn.tool_calls.is_empty() {
                    out.push(assistant_message(&turn.text, &turn.tool_calls));
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Stream decoding
// ---------------------------------------------------------------------------

#[derive(Default)]
struct PendingCall {
    id: String,
    name: String,
    arguments: String,
}

struct CompletionStream {
    sse: SseParser,
    text: String,
    text_budget: Budget,
    input_budget: Budget,
    calls: BTreeMap<u64, PendingCall>,
    finish: Option<String>,
    usage: AiUsage,
    model: String,
    thinking_seen: bool,
}

fn protocol(message: impl Into<String>) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Protocol, message)
}

impl CompletionStream {
    fn new(model: &str) -> Self {
        Self {
            sse: SseParser::new(),
            text: String::new(),
            text_budget: Budget::default(),
            input_budget: Budget::default(),
            calls: BTreeMap::new(),
            finish: None,
            usage: AiUsage::default(),
            model: model.to_string(),
            thinking_seen: false,
        }
    }

    fn chunk(&mut self, data: &str, on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let data = data.trim();
        if data == "[DONE]" {
            return Ok(true);
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|e| protocol(format!("{NAME} sent a malformed stream chunk: {e}")))?;
        if !value["error"].is_null() {
            return Err(stream_error(&value["error"]));
        }
        if let Some(model) = value["model"].as_str().filter(|m| !m.is_empty()) {
            self.model = model.to_string();
        }
        let usage = &value["usage"];
        if usage.is_object() {
            let count = |v: &Value| v.as_u64().unwrap_or(0);
            self.usage = AiUsage {
                input_tokens: count(&usage["prompt_tokens"]),
                output_tokens: count(&usage["completion_tokens"]),
                cache_read_tokens: count(&usage["prompt_tokens_details"]["cached_tokens"]),
                cache_write_tokens: 0,
            };
            on_event(StreamEvent::Usage(self.usage));
        }
        let Some(choice) = value["choices"].as_array().and_then(|c| c.first()) else {
            return Ok(false);
        };
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            self.text_budget
                .add(text.len(), MAX_TURN_TEXT_BYTES, "text")?;
            self.text.push_str(text);
            on_event(StreamEvent::Text(text.to_string()));
        }
        let reasoning = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
            .unwrap_or_default();
        if !reasoning.is_empty() {
            self.text_budget
                .add(reasoning.len(), MAX_TURN_TEXT_BYTES, "text")?;
            if !std::mem::replace(&mut self.thinking_seen, true) {
                on_event(StreamEvent::Thinking);
            }
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for (position, call) in calls.iter().enumerate() {
                let index = call["index"].as_u64().unwrap_or(position as u64);
                let pending = self.calls.entry(index).or_default();
                if let Some(id) = call["id"].as_str().filter(|id| !id.is_empty()) {
                    pending.id = id.to_string();
                }
                let function = &call["function"];
                if let Some(name) = function["name"].as_str().filter(|n| !n.is_empty()) {
                    if pending.name.is_empty() {
                        pending.name = name.to_string();
                    }
                }
                if let Some(arguments) = function["arguments"].as_str() {
                    self.input_budget
                        .add(arguments.len(), MAX_TOOL_INPUT_BYTES, "tool input")?;
                    pending.arguments.push_str(arguments);
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish = Some(reason.to_string());
        }
        Ok(false)
    }

    fn finish(self) -> AssistantTurn {
        let mut stop = stop_reason(self.finish.as_deref().unwrap_or("stop"));
        let mut calls: Vec<ToolCallReq> = self
            .calls
            .into_values()
            .enumerate()
            .map(|(n, call)| ToolCallReq {
                id: if call.id.is_empty() {
                    format!("call_{}", n + 1)
                } else {
                    call.id
                },
                name: call.name,
                input: parse_tool_input(&call.arguments),
            })
            .collect();
        if stop == StopReason::EndTurn && !calls.is_empty() {
            stop = StopReason::ToolUse;
        }
        if matches!(stop, StopReason::MaxTokens | StopReason::Refusal { .. }) {
            calls.clear();
        }
        AssistantTurn {
            raw: assistant_message(&self.text, &calls),
            text: self.text,
            tool_calls: calls,
            stop,
            usage: self.usage,
            model: self.model,
        }
    }
}

impl Decoder for CompletionStream {
    fn feed(&mut self, bytes: &[u8], on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let events = self.sse.push(bytes).map_err(|e| protocol(e.to_string()))?;
        for (_name, data) in events {
            if self.chunk(&data, on_event)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn partial(&self) -> AssistantTurn {
        AssistantTurn {
            raw: assistant_message(&self.text, &[]),
            text: self.text.clone(),
            tool_calls: Vec::new(),
            stop: StopReason::EndTurn,
            usage: self.usage,
            model: self.model.clone(),
        }
    }

    /// Some servers close the stream without `[DONE]` after the finish.
    fn complete_at_eof(&self) -> bool {
        self.finish.is_some()
    }
}

/// A streamed `{"error": …}` chunk → the matching kind.
fn stream_error(error: &Value) -> ProviderError {
    let message = error["message"]
        .as_str()
        .or_else(|| error.as_str())
        .unwrap_or("unknown error");
    let code = error["type"]
        .as_str()
        .or_else(|| error["code"].as_str())
        .unwrap_or("error");
    let kind = if code.contains("rate_limit") {
        ProviderErrorKind::RateLimited
    } else if code.contains("overloaded") {
        ProviderErrorKind::Overloaded
    } else if code == "invalid_request_error" {
        ProviderErrorKind::BadRequest
    } else if code.contains("auth") || code == "invalid_api_key" {
        ProviderErrorKind::Auth
    } else {
        ProviderErrorKind::Server
    };
    ProviderError::new(kind, format!("{NAME} reported {code}: {message}"))
}
