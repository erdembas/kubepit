//! The Ollama provider (spec D2): Ollama's native `POST {base}/api/chat`,
//! streamed as NDJSON lines until `done: true`. No key is ever sent.
//!
//! - `options.num_ctx` is the configured context window (Ollama's own
//!   default is much smaller) and `options.num_predict` the output cap.
//! - Messages follow the OpenAI-compatible shape (system first, text blocks
//!   joined with a blank line); tool results go back as `role: tool` with
//!   the `tool_name` of the call they answer. Ollama sends tool calls
//!   without ids, so they get `call_<n>` ids per response.
//! - `done_reason: length` runs no tools; `prompt_eval_count` /
//!   `eval_count` are the usage. Lines are bounded like SSE events.

use std::collections::HashMap;

use futures::future::BoxFuture;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::openai::{function_tools, tool_result_text, user_text};
use super::provider::{
    endpoint, is_local_url, parse_tool_input, provider_client, with_retries, AiTimeouts,
    AssistantTurn, Budget, Call, ChatMessage, ChatRequest, Deadlines, Decoder, Egress, EgressCell,
    EventSink, Provider, ProviderError, ProviderErrorKind, RetryPolicy, StopReason, StreamEvent,
    ToolCallReq, UserBlock, MAX_RESPONSE_BYTES, MAX_TOOL_CALLS, MAX_TOOL_INPUT_BYTES,
};
use super::settings::DEFAULT_OLLAMA_CONTEXT_WINDOW;
use super::sse::LineSplitter;
use super::types::{AiModelInfo, AiProviderKind, AiUsage};

const NAME: &str = "Ollama";

pub struct OllamaProvider {
    client: reqwest::Client,
    base_url: String,
    context_window: u32,
    timeouts: AiTimeouts,
    retry: RetryPolicy,
    egress: EgressCell,
    request_hook: Option<super::provider::RequestHook>,
}

impl OllamaProvider {
    /// A provider at `base_url` (e.g. `http://127.0.0.1:11434`; trimmed, a
    /// trailing slash dropped; must be an http(s) URL) running models with
    /// `context_window` tokens (`0` = the default 8192). It builds its own
    /// HTTP client for that base URL (no redirects, no proxy for loopback).
    /// Egress: loopback only until [`OllamaProvider::with_egress`].
    pub fn new(
        base_url: String,
        context_window: u32,
        timeouts: AiTimeouts,
        retry: RetryPolicy,
    ) -> Result<Self, ProviderError> {
        let (base_url, client) = provider_client(&timeouts, &base_url)?;
        Ok(Self {
            client,
            base_url,
            context_window: if context_window == 0 {
                DEFAULT_OLLAMA_CONTEXT_WINDOW
            } else {
                context_window
            },
            timeouts,
            retry,
            egress: EgressCell::default(),
            request_hook: None,
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
        let mut body = json!({
            "model": req.model,
            "stream": true,
            "messages": messages(&req.system, &req.messages),
            "options": {"num_ctx": self.context_window, "num_predict": req.max_tokens},
        });
        if !req.tools.is_empty() {
            body["tools"] = Value::Array(function_tools(&req.tools));
        }
        body
    }

    async fn send_once(
        &self,
        req: &ChatRequest,
        deadlines: Deadlines,
        on_event: EventSink<'_>,
        cancel: &CancellationToken,
    ) -> Result<AssistantTurn, ProviderError> {
        let url = endpoint(&self.base_url, &["api", "chat"])?;
        let body = serde_json::to_vec(&self.request_body(req)).map_err(|e| {
            ProviderError::new(
                ProviderErrorKind::BadRequest,
                format!("could not encode the request: {e}"),
            )
        })?;
        let request = self
            .client
            .post(url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
        let call = Call::new(NAME, &url, &[], &self.timeouts, deadlines, cancel);
        self.before_request(self.request_body(req), cancel).await?;
        let response = call.send(request).await?;
        let mut stream = ChatLines::new(&req.model);
        call.read_stream(response, &mut stream, on_event).await?;
        Ok(stream.finish())
    }

    async fn get_tags(
        &self,
        deadlines: Deadlines,
        cancel: &CancellationToken,
    ) -> Result<Value, ProviderError> {
        let url = endpoint(&self.base_url, &["api", "tags"])?;
        let call = Call::new(NAME, &url, &[], &self.timeouts, deadlines, cancel);
        call.json(self.client.get(url.clone())).await
    }
}

impl Provider for OllamaProvider {
    fn kind(&self) -> AiProviderKind {
        AiProviderKind::Ollama
    }

    fn is_local(&self) -> bool {
        is_local_url(&self.base_url)
    }

    fn set_egress(&self, egress: Egress) {
        self.egress.set(egress);
    }

    /// `GET {base}/api/tags` → the pulled models, sorted.
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<AiModelInfo>, ProviderError>> {
        Box::pin(async move {
            self.egress.check(&self.base_url)?;
            let cancel = CancellationToken::new();
            let deadlines = Deadlines::new(&self.timeouts, None);
            let value = with_retries(&self.retry, deadlines.content, &|_| {}, &cancel, || {
                self.get_tags(deadlines, &cancel)
            })
            .await?;
            let models = value["models"].as_array().ok_or_else(|| {
                ProviderError::new(
                    ProviderErrorKind::Protocol,
                    "Ollama sent a model list without models",
                )
            })?;
            let mut ids: Vec<String> = models
                .iter()
                .filter_map(|m| m["name"].as_str().or_else(|| m["model"].as_str()))
                .map(str::to_string)
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
            let deadlines = Deadlines::new(&self.timeouts, Some(req.max_tokens));
            with_retries(&self.retry, deadlines.content, on_event, cancel, || {
                self.send_once(req, deadlines, on_event, cancel)
            })
            .await
        })
    }
}

fn assistant_message(text: &str, calls: &[ToolCallReq]) -> Value {
    let mut message = json!({"role": "assistant", "content": text});
    if !calls.is_empty() {
        message["tool_calls"] = calls
            .iter()
            .map(|c| {
                let arguments = c.input.clone().unwrap_or_else(|_| json!({}));
                json!({"function": {"name": c.name, "arguments": arguments}})
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
    // Call id → tool name of the latest assistant turn (Ollama matches
    // results by name, not id).
    let mut names: HashMap<&str, &str> = HashMap::new();
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
                        let mut result = json!({
                            "role": "tool",
                            "content": tool_result_text(content, *is_error),
                        });
                        if let Some(name) = names.get(call_id.as_str()) {
                            result["tool_name"] = json!(name);
                        }
                        out.push(result);
                    }
                }
                if let Some(text) = user_text(blocks) {
                    out.push(json!({"role": "user", "content": text}));
                }
            }
            ChatMessage::Assistant(turn) => {
                names = turn
                    .tool_calls
                    .iter()
                    .map(|c| (c.id.as_str(), c.name.as_str()))
                    .collect();
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

struct ChatLines {
    lines: LineSplitter,
    text: String,
    /// Text, thinking and tool names / ids.
    budget: Budget,
    input_budget: Budget,
    calls: Vec<ToolCallReq>,
    done_reason: Option<String>,
    usage: AiUsage,
    model: String,
    thinking_seen: bool,
    saw_event: bool,
}

fn protocol(message: impl Into<String>) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Protocol, message)
}

impl ChatLines {
    fn new(model: &str) -> Self {
        Self {
            lines: LineSplitter::default(),
            text: String::new(),
            budget: Budget::default(),
            input_budget: Budget::default(),
            calls: Vec::new(),
            done_reason: None,
            usage: AiUsage::default(),
            model: model.to_string(),
            thinking_seen: false,
            saw_event: false,
        }
    }

    /// One NDJSON line; `Ok(true)` at `done: true`.
    fn line(&mut self, line: &str, on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let line = line.trim();
        if line.is_empty() {
            return Ok(false);
        }
        let value: Value = serde_json::from_str(line)
            .map_err(|e| protocol(format!("Ollama sent a malformed stream line: {e}")))?;
        self.saw_event = true;
        if let Some(error) = value["error"].as_str() {
            return Err(ProviderError::new(
                ProviderErrorKind::Server,
                format!("Ollama reported: {error}"),
            ));
        }
        if let Some(model) = value["model"].as_str().filter(|m| !m.is_empty()) {
            self.model = model.to_string();
        }
        let message = &value["message"];
        if let Some(text) = message["content"].as_str().filter(|t| !t.is_empty()) {
            self.budget.add(text.len(), MAX_RESPONSE_BYTES, "content")?;
            self.text.push_str(text);
            on_event(StreamEvent::Text(text.to_string()));
        }
        if let Some(thinking) = message["thinking"].as_str().filter(|t| !t.is_empty()) {
            self.budget
                .add(thinking.len(), MAX_RESPONSE_BYTES, "content")?;
            if !std::mem::replace(&mut self.thinking_seen, true) {
                on_event(StreamEvent::Thinking);
            }
        }
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            if self.calls.len() >= MAX_TOOL_CALLS {
                return Err(protocol(format!(
                    "Ollama sent more than {MAX_TOOL_CALLS} tool calls"
                )));
            }
            let function = &call["function"];
            self.budget.add(
                function["name"].as_str().map_or(0, str::len)
                    + call["id"].as_str().map_or(0, str::len),
                MAX_RESPONSE_BYTES,
                "content",
            )?;
            let arguments = &function["arguments"];
            let input = match arguments {
                Value::Object(_) => Ok(arguments.clone()),
                Value::String(raw) => parse_tool_input(raw),
                Value::Null => Ok(json!({})),
                other => Err(other.to_string()),
            };
            self.input_budget.add(
                arguments.to_string().len(),
                MAX_TOOL_INPUT_BYTES,
                "tool input",
            )?;
            let id = call["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{}", self.calls.len() + 1));
            self.calls.push(ToolCallReq {
                id,
                name: function["name"].as_str().unwrap_or_default().to_string(),
                input,
            });
        }
        if value["done"].as_bool() == Some(true) {
            self.done_reason = value["done_reason"].as_str().map(str::to_string);
            self.usage.input_tokens = value["prompt_eval_count"].as_u64().unwrap_or(0);
            self.usage.output_tokens = value["eval_count"].as_u64().unwrap_or(0);
            on_event(StreamEvent::Usage(self.usage));
            return Ok(true);
        }
        Ok(false)
    }

    fn finish(mut self) -> AssistantTurn {
        let stop = if self.done_reason.as_deref() == Some("length") {
            self.calls.clear();
            StopReason::MaxTokens
        } else if self.calls.is_empty() {
            StopReason::EndTurn
        } else {
            StopReason::ToolUse
        };
        AssistantTurn {
            raw: assistant_message(&self.text, &self.calls),
            text: self.text,
            tool_calls: self.calls,
            stop,
            usage: self.usage,
            model: self.model,
        }
    }
}

impl Decoder for ChatLines {
    /// NDJSON (`application/x-ndjson`), JSON, or no content type; never an
    /// HTML or other page from something in between.
    fn accepts(&self, content_type: &str) -> bool {
        content_type.is_empty()
            || content_type.starts_with("application/x-ndjson")
            || content_type.starts_with("application/json")
    }

    fn started(&self) -> bool {
        !self.text.is_empty() || self.thinking_seen || !self.calls.is_empty()
    }

    fn saw_event(&self) -> bool {
        self.saw_event
    }

    fn feed(&mut self, bytes: &[u8], on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let lines = self
            .lines
            .push(bytes)
            .map_err(|e| protocol(e.to_string()))?;
        for line in lines {
            if self.line(&line, on_event)? {
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
}
