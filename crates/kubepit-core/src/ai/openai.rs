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
//! - Tool-call deltas accumulate by `index` (by `id` when a server sends no
//!   index); arguments are parsed strictly. `length` and `content_filter`
//!   finishes run no tools.
//! - Usage is normalized to Anthropic's meaning: OpenAI's `prompt_tokens`
//!   includes the cached tokens, so `input_tokens` is `prompt_tokens −
//!   cached_tokens` and `cache_read_tokens` the cached ones.
//! - Two one-shot compatibility switches, only for a request the server
//!   rejected (a 400 before anything streamed): models that only take
//!   `max_completion_tokens`, and servers that do not know `stream_options`.

use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::provider::{
    check_key_egress, endpoint, is_event_stream, is_local_url, parse_tool_input, provider_client,
    secret_header, with_retries, AiTimeouts, AssistantTurn, Budget, Call, ChatMessage, ChatRequest,
    Deadlines, Decoder, Egress, EgressCell, EventSink, Provider, ProviderError, ProviderErrorKind,
    RetryPolicy, StopReason, StreamEvent, ToolCallReq, ToolSpec, UserBlock, MAX_RESPONSE_BYTES,
    MAX_TOOL_CALLS, MAX_TOOL_INPUT_BYTES,
};
use super::sse::SseParser;
use super::types::{AiModelInfo, AiProviderKind, AiUsage};

const NAME: &str = "The OpenAI-compatible server";

pub struct OpenAiCompatProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    timeouts: AiTimeouts,
    retry: RetryPolicy,
    egress: EgressCell,
    request_hook: Option<super::provider::RequestHook>,
    /// Send `max_completion_tokens` instead of `max_tokens`.
    completion_tokens: AtomicBool,
    /// Send `stream_options.include_usage` (cleared when rejected).
    stream_options: AtomicBool,
}

/// The request variant chosen by the compatibility switches.
#[derive(Clone, Copy)]
struct Shape {
    completion_tokens: bool,
    stream_options: bool,
}

impl OpenAiCompatProvider {
    /// A provider at `base_url` (e.g. `https://api.openai.com/v1`; trimmed,
    /// a trailing slash dropped; must be an http(s) URL). It builds its own
    /// HTTP client for that base URL (no redirects, no proxy for loopback).
    /// A blank key sends no `Authorization`. Egress: loopback only until
    /// [`OpenAiCompatProvider::with_egress`].
    pub fn new(
        base_url: String,
        api_key: Option<String>,
        timeouts: AiTimeouts,
        retry: RetryPolicy,
    ) -> Result<Self, ProviderError> {
        let (base_url, client) = provider_client(&timeouts, &base_url)?;
        Ok(Self {
            client,
            base_url,
            api_key: api_key
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty()),
            timeouts,
            retry,
            egress: EgressCell::default(),
            request_hook: None,
            completion_tokens: AtomicBool::new(false),
            stream_options: AtomicBool::new(true),
        })
    }

    /// The egress rule checked before every request.
    pub fn with_egress(self, egress: Egress) -> Self {
        self.egress.set(egress);
        self
    }

    /// Session-owned gate and audit callback for every HTTP chat attempt.
    pub fn with_request_hook(mut self, hook: super::provider::RequestHook) -> Self {
        self.request_hook = Some(hook);
        self
    }

    async fn before_request(
        &self,
        body: Value,
        cancel: &CancellationToken,
    ) -> Result<(), ProviderError> {
        if cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        if let Some(hook) = &self.request_hook {
            hook(body, cancel.clone()).await?;
        }
        Ok(())
    }

    /// The JSON body `chat` sends for `req`.
    pub fn request_body(&self, req: &ChatRequest) -> Value {
        self.body(req, self.shape())
    }

    fn shape(&self) -> Shape {
        Shape {
            completion_tokens: self.completion_tokens.load(Ordering::SeqCst),
            stream_options: self.stream_options.load(Ordering::SeqCst),
        }
    }

    fn body(&self, req: &ChatRequest, shape: Shape) -> Value {
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        body.insert("stream".into(), json!(true));
        if shape.stream_options {
            body.insert("stream_options".into(), json!({"include_usage": true}));
        }
        let cap = if shape.completion_tokens {
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

    /// The egress rule, and with a key: HTTPS or loopback only.
    fn check_egress(&self) -> Result<(), ProviderError> {
        self.egress.check(&self.base_url)?;
        if self.api_key.is_some() {
            check_key_egress(&self.base_url)?;
        }
        Ok(())
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

    fn completion_request(
        &self,
        url: &reqwest::Url,
        req: &ChatRequest,
        shape: Shape,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        let body = serde_json::to_vec(&self.body(req, shape)).map_err(|e| {
            ProviderError::new(
                ProviderErrorKind::BadRequest,
                format!("could not encode the request: {e}"),
            )
        })?;
        Ok(self
            .authorized(self.client.post(url.clone()))?
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .body(body))
    }

    /// Flips the compatibility switch a rejected request names; `false`
    /// when it names none that is still on.
    fn adapt_to(&self, error: &ProviderError) -> bool {
        if error.kind != ProviderErrorKind::BadRequest {
            return false;
        }
        if error.message.contains("max_completion_tokens")
            && !self.completion_tokens.swap(true, Ordering::SeqCst)
        {
            return true;
        }
        error.message.contains("stream_options")
            && self.stream_options.swap(false, Ordering::SeqCst)
    }

    /// One request; a request rejected for a compatibility switch (a status
    /// error: nothing streamed) is sent again with the switch flipped.
    async fn attempt(
        &self,
        req: &ChatRequest,
        deadlines: Deadlines,
        on_event: EventSink<'_>,
        cancel: &CancellationToken,
    ) -> Result<AssistantTurn, ProviderError> {
        let url = endpoint(&self.base_url, &["chat", "completions"])?;
        let secrets = self.secrets();
        let mut switches = 0;
        let (call, response) = loop {
            let call = Call::new(NAME, &url, &secrets, &self.timeouts, deadlines, cancel);
            self.before_request(self.body(req, self.shape()), cancel)
                .await?;
            match call
                .send(self.completion_request(&url, req, self.shape())?)
                .await
            {
                Ok(response) => break (call, response),
                Err(error) if switches < 2 && self.adapt_to(&error) => switches += 1,
                Err(error) => return Err(error),
            }
        };
        let mut stream = CompletionStream::new(&req.model);
        call.read_stream(response, &mut stream, on_event).await?;
        Ok(stream.finish())
    }

    async fn get_models(
        &self,
        deadlines: Deadlines,
        cancel: &CancellationToken,
    ) -> Result<Value, ProviderError> {
        let url = endpoint(&self.base_url, &["models"])?;
        let secrets = self.secrets();
        let call = Call::new(NAME, &url, &secrets, &self.timeouts, deadlines, cancel);
        call.json(self.authorized(self.client.get(url.clone()))?)
            .await
    }
}

impl Provider for OpenAiCompatProvider {
    fn kind(&self) -> AiProviderKind {
        AiProviderKind::OpenaiCompatible
    }

    fn is_local(&self) -> bool {
        is_local_url(&self.base_url)
    }

    fn set_egress(&self, egress: Egress) {
        self.egress.set(egress);
    }

    /// `GET {base}/models` → ids, sorted.
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<AiModelInfo>, ProviderError>> {
        Box::pin(async move {
            self.check_egress()?;
            let cancel = CancellationToken::new();
            let deadlines = Deadlines::new(&self.timeouts, None);
            let value = with_retries(&self.retry, deadlines.content, &|_| {}, &cancel, || {
                self.get_models(deadlines, &cancel)
            })
            .await?;
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
            self.check_egress()?;
            let deadlines = Deadlines::new(&self.timeouts, Some(req.max_tokens));
            with_retries(&self.retry, deadlines.content, on_event, cancel, || {
                self.attempt(req, deadlines, on_event, cancel)
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
    /// The delta `index`, when the server sends one.
    index: Option<u64>,
    id: String,
    name: String,
    arguments: String,
}

struct CompletionStream {
    sse: SseParser,
    text: String,
    /// Text, reasoning and tool names / ids.
    budget: Budget,
    input_budget: Budget,
    /// In order of first appearance.
    calls: Vec<PendingCall>,
    finish: Option<String>,
    usage: AiUsage,
    model: String,
    thinking_seen: bool,
    saw_event: bool,
}

fn protocol(message: impl Into<String>) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Protocol, message)
}

impl CompletionStream {
    fn new(model: &str) -> Self {
        Self {
            sse: SseParser::new(),
            text: String::new(),
            budget: Budget::default(),
            input_budget: Budget::default(),
            calls: Vec::new(),
            finish: None,
            usage: AiUsage::default(),
            model: model.to_string(),
            thinking_seen: false,
            saw_event: false,
        }
    }

    /// The pending call a tool-call delta continues: the latest one with
    /// its `index`, else with its `id`, else the latest one. A delta that
    /// brings a different id, or a different name to a call that already
    /// has one, starts a new call (servers that reuse `index` 0). New calls
    /// are capped.
    fn call_for(
        &mut self,
        index: Option<u64>,
        id: Option<&str>,
        name: Option<&str>,
    ) -> Result<&mut PendingCall, ProviderError> {
        let found = match (index, id) {
            (Some(index), _) => self.calls.iter().rposition(|c| c.index == Some(index)),
            (None, Some(id)) => self.calls.iter().rposition(|c| c.id == id),
            (None, None) => self.calls.len().checked_sub(1),
        };
        let found = found.filter(|&position| {
            let call = &self.calls[position];
            let other_id = id.is_some_and(|id| !call.id.is_empty() && call.id != id);
            let other_name = name.is_some_and(|name| !call.name.is_empty() && call.name != name);
            !other_id && !other_name
        });
        let position = match found {
            Some(position) => position,
            None => {
                if self.calls.len() >= MAX_TOOL_CALLS {
                    return Err(protocol(format!(
                        "{NAME} sent more than {MAX_TOOL_CALLS} tool calls"
                    )));
                }
                self.calls.push(PendingCall {
                    index,
                    ..Default::default()
                });
                self.calls.len() - 1
            }
        };
        Ok(&mut self.calls[position])
    }

    fn chunk(&mut self, data: &str, on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let data = data.trim();
        self.saw_event = true;
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
            let prompt = count(&usage["prompt_tokens"]);
            let cached = count(&usage["prompt_tokens_details"]["cached_tokens"]);
            // `prompt_tokens` includes the cached tokens: keep only the
            // uncached rest in `input_tokens` (Anthropic's meaning) so cost
            // and usage never count the cached part twice.
            self.usage = AiUsage {
                input_tokens: prompt.saturating_sub(cached),
                output_tokens: count(&usage["completion_tokens"]),
                cache_read_tokens: cached,
                cache_write_tokens: 0,
            };
            on_event(StreamEvent::Usage(self.usage));
        }
        let Some(choice) = value["choices"].as_array().and_then(|c| c.first()) else {
            return Ok(false);
        };
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            self.budget.add(text.len(), MAX_RESPONSE_BYTES, "content")?;
            self.text.push_str(text);
            on_event(StreamEvent::Text(text.to_string()));
        }
        let reasoning = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
            .unwrap_or_default();
        if !reasoning.is_empty() {
            self.budget
                .add(reasoning.len(), MAX_RESPONSE_BYTES, "content")?;
            if !std::mem::replace(&mut self.thinking_seen, true) {
                on_event(StreamEvent::Thinking);
            }
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let function = &call["function"];
                let id = call["id"].as_str().filter(|id| !id.is_empty());
                let name = function["name"].as_str().filter(|n| !n.is_empty());
                let arguments = function["arguments"].as_str().unwrap_or_default();
                self.budget.add(
                    id.map_or(0, str::len) + name.map_or(0, str::len),
                    MAX_RESPONSE_BYTES,
                    "content",
                )?;
                self.input_budget
                    .add(arguments.len(), MAX_TOOL_INPUT_BYTES, "tool input")?;
                let pending = self.call_for(call["index"].as_u64(), id, name)?;
                if let Some(id) = id {
                    pending.id = id.to_string();
                }
                if let Some(name) = name {
                    if pending.name.is_empty() {
                        pending.name = name.to_string();
                    }
                }
                pending.arguments.push_str(arguments);
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
            .into_iter()
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
    /// An event stream, or no content type at all (some servers send
    /// none; a body that is not SSE then still ends as a protocol error).
    fn accepts(&self, content_type: &str) -> bool {
        content_type.is_empty() || is_event_stream(content_type)
    }

    fn feed(&mut self, bytes: &[u8], on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let events = self.sse.push(bytes).map_err(|e| protocol(e.to_string()))?;
        for (_name, data) in events {
            if self.chunk(&data, on_event)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn started(&self) -> bool {
        !self.text.is_empty() || self.thinking_seen || !self.calls.is_empty()
    }

    fn saw_event(&self) -> bool {
        self.saw_event
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
