//! The Anthropic Messages API provider (spec D2, D11, D12): raw HTTP to the
//! documented API (Rust has no official SDK), never through an OpenAI shim.
//!
//! - `POST {base}/v1/messages` with `x-api-key`, `anthropic-version:
//!   2023-06-01` and, while the server accepts it, the server-side refusal
//!   fallback (`fallbacks: "default"` + `anthropic-beta:
//!   server-side-fallback-2026-07-01`). A request rejected with a 400 that
//!   names the fallback parameter or the beta header (nothing streamed yet)
//!   turns it off for this provider and is sent again once without; a
//!   mid-stream error is never re-sent.
//! - Prompt caching: tools sorted by name → the frozen system prompt with a
//!   breakpoint → the session's first context block (at most two message
//!   breakpoints) → top-level automatic `cache_control`. Bodies are built
//!   deterministically.
//! - `thinking: {type: "adaptive"}` and `output_config.effort` only when the
//!   Models API reported support for the requested model; the effort is
//!   clamped to the levels it reports. Never `budget_tokens`, sampling
//!   parameters or an assistant prefill.
//! - `eager_input_streaming` only for the default base URL; every tool
//!   input is parsed strictly at block stop.
//! - Assistant content (thinking blocks and signatures included) is kept in
//!   [`AssistantTurn::raw`] and echoed back unchanged; after a mid-output
//!   fallback, the declined model's thinking and `tool_use` blocks before
//!   the last `fallback` block are dropped, as documented.
//! - `max_tokens` or `refusal` → no tool calls (and no `tool_use` blocks
//!   left in `raw` that would need an answer).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::provider::{
    check_key_egress, endpoint, is_event_stream, is_local_url, parse_tool_input, provider_client,
    secret_header, with_retries, AiTimeouts, AssistantTurn, Budget, Call, ChatMessage, ChatRequest,
    Deadlines, Decoder, Egress, EgressCell, EventSink, Provider, ProviderError, ProviderErrorKind,
    RetryPolicy, StopReason, StreamEvent, ToolCallReq, UserBlock, MAX_CONTENT_BLOCKS,
    MAX_RESPONSE_BYTES, MAX_TOOL_INPUT_BYTES,
};
use super::settings::ANTHROPIC_BASE_URL;
use super::sse::SseParser;
use super::types::{AiEffort, AiModelInfo, AiProviderKind, AiUsage};

/// The `anthropic-version` header.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// The beta header of the scalar `fallbacks: "default"` form.
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

const NAME: &str = "Anthropic";
/// Message-level cache breakpoints; with the system prompt and the
/// top-level automatic breakpoint this stays within the API's four.
const MAX_MESSAGE_BREAKPOINTS: usize = 2;
const MODELS_PAGE_LIMIT: &str = "100";
const MAX_MODEL_PAGES: usize = 20;
/// Effort levels in increasing order, with their Models API keys.
const EFFORT_LEVELS: [(AiEffort, &str); 5] = [
    (AiEffort::Low, "low"),
    (AiEffort::Medium, "medium"),
    (AiEffort::High, "high"),
    (AiEffort::Xhigh, "xhigh"),
    (AiEffort::Max, "max"),
];

pub struct AnthropicProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    timeouts: AiTimeouts,
    retry: RetryPolicy,
    model_info: Option<AiModelInfo>,
    egress: EgressCell,
    request_hook: Option<super::provider::RequestHook>,
    /// Send `fallbacks: "default"` (cleared when the server rejects it).
    fallbacks: AtomicBool,
}

impl AnthropicProvider {
    /// A provider at `base_url` (trimmed, a trailing slash dropped; must be
    /// an http(s) URL). It builds its own HTTP client for that base URL
    /// ([`super::provider::http_client`]: no redirects, no proxy for
    /// loopback), so the key's safety never depends on the caller. The key
    /// is trimmed. `model_info` (from [`AnthropicProvider::model_info`])
    /// enables adaptive thinking and effort for that model. Egress: loopback
    /// only until [`AnthropicProvider::with_egress`].
    pub fn new(
        base_url: String,
        api_key: String,
        timeouts: AiTimeouts,
        retry: RetryPolicy,
        model_info: Option<AiModelInfo>,
    ) -> Result<Self, ProviderError> {
        let (base_url, client) = provider_client(&timeouts, &base_url)?;
        Ok(Self {
            client,
            base_url,
            api_key: api_key.trim().to_string(),
            timeouts,
            retry,
            model_info,
            egress: EgressCell::default(),
            request_hook: None,
            fallbacks: AtomicBool::new(true),
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

    /// The JSON body `chat` sends for `req` (in its current fallback state).
    pub fn request_body(&self, req: &ChatRequest) -> Value {
        self.body(req, self.fallbacks.load(Ordering::SeqCst))
    }

    /// `GET {base}/v1/models/{id}`: context window, output cap and
    /// capabilities of one model.
    pub fn model_info(&self, id: &str) -> BoxFuture<'_, Result<AiModelInfo, ProviderError>> {
        let id = id.trim().to_string();
        Box::pin(async move {
            self.egress.check(&self.base_url)?;
            check_key_egress(&self.base_url)?;
            self.require_key()?;
            if id.is_empty() || id == "." || id == ".." {
                return Err(ProviderError::new(
                    ProviderErrorKind::BadRequest,
                    "no model id given",
                ));
            }
            let url = endpoint(&self.base_url, &["v1", "models", &id])?;
            let cancel = CancellationToken::new();
            let deadlines = Deadlines::new(&self.timeouts, None);
            let value = with_retries(&self.retry, deadlines.content, &|_| {}, &cancel, || {
                self.get_json(url.clone(), deadlines, &cancel)
            })
            .await?;
            model_from_json(&value).ok_or_else(|| {
                ProviderError::new(
                    ProviderErrorKind::Protocol,
                    "Anthropic sent a model without an id",
                )
            })
        })
    }

    fn require_key(&self) -> Result<(), ProviderError> {
        if self.api_key.is_empty() {
            return Err(ProviderError::new(
                ProviderErrorKind::Auth,
                "no Anthropic API key is stored",
            ));
        }
        Ok(())
    }

    fn body(&self, req: &ChatRequest, fallbacks: bool) -> Value {
        let info = self.model_info.as_ref().filter(|m| m.id == req.model);
        let max_tokens = match info.and_then(|m| m.max_output_tokens) {
            Some(cap) if cap > 0 => req.max_tokens.min(cap),
            _ => req.max_tokens,
        };
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        body.insert("max_tokens".into(), json!(max_tokens));
        body.insert("stream".into(), json!(true));
        if !req.system.is_empty() {
            body.insert(
                "system".into(),
                json!([{"type": "text", "text": req.system, "cache_control": {"type": "ephemeral"}}]),
            );
        }
        body.insert("messages".into(), Value::Array(messages(&req.messages)));
        if !req.tools.is_empty() {
            let eager = self.base_url == ANTHROPIC_BASE_URL;
            let mut tools: Vec<_> = req.tools.iter().collect();
            tools.sort_by_key(|t| t.name);
            let tools = tools
                .into_iter()
                .map(|t| {
                    let mut tool = json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.schema,
                    });
                    if eager {
                        tool["eager_input_streaming"] = json!(true);
                    }
                    tool
                })
                .collect();
            body.insert("tools".into(), Value::Array(tools));
        }
        body.insert("cache_control".into(), json!({"type": "ephemeral"}));
        if info.and_then(|m| m.adaptive_thinking) == Some(true) {
            body.insert("thinking".into(), json!({"type": "adaptive"}));
        }
        if let Some(effort) = supported_effort(info, req.effort) {
            body.insert("output_config".into(), json!({"effort": effort}));
        }
        if fallbacks {
            body.insert("fallbacks".into(), json!("default"));
        }
        Value::Object(body)
    }

    fn authorized(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        Ok(request
            .header("x-api-key", secret_header(&self.api_key)?)
            .header("anthropic-version", ANTHROPIC_VERSION))
    }

    async fn get_json(
        &self,
        url: reqwest::Url,
        deadlines: Deadlines,
        cancel: &CancellationToken,
    ) -> Result<Value, ProviderError> {
        let secrets = [self.api_key.as_str()];
        let call = Call::new(NAME, &url, &secrets, &self.timeouts, deadlines, cancel);
        call.json(self.authorized(self.client.get(url.clone()))?)
            .await
    }

    /// The `POST /v1/messages` request for `req`.
    fn message_request(
        &self,
        url: &reqwest::Url,
        req: &ChatRequest,
        fallbacks: bool,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        let body = serde_json::to_vec(&self.body(req, fallbacks)).map_err(|e| {
            ProviderError::new(
                ProviderErrorKind::BadRequest,
                format!("could not encode the request: {e}"),
            )
        })?;
        let mut request = self
            .authorized(self.client.post(url.clone()))?
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .body(body);
        if fallbacks {
            request = request.header("anthropic-beta", FALLBACK_BETA);
        }
        Ok(request)
    }

    /// One request. Only a request the server rejected (a status error:
    /// nothing streamed) because of the fallback parameter or its beta
    /// header is sent once more, without them.
    async fn attempt(
        &self,
        req: &ChatRequest,
        deadlines: Deadlines,
        on_event: EventSink<'_>,
        cancel: &CancellationToken,
    ) -> Result<AssistantTurn, ProviderError> {
        let url = endpoint(&self.base_url, &["v1", "messages"])?;
        let secrets = [self.api_key.as_str()];
        let fallbacks = self.fallbacks.load(Ordering::SeqCst);
        let call = Call::new(NAME, &url, &secrets, &self.timeouts, deadlines, cancel);
        self.before_request(self.body(req, fallbacks), cancel)
            .await?;
        let sent = call.send(self.message_request(&url, req, fallbacks)?).await;
        let (call, response) = match sent {
            Err(error) if fallbacks && rejects_fallbacks(&error) => {
                self.fallbacks.store(false, Ordering::SeqCst);
                tracing::info!("Anthropic rejected server-side fallbacks; sending without them");
                let call = Call::new(NAME, &url, &secrets, &self.timeouts, deadlines, cancel);
                self.before_request(self.body(req, false), cancel).await?;
                let response = call.send(self.message_request(&url, req, false)?).await?;
                (call, response)
            }
            sent => (call, sent?),
        };
        let mut stream = MessageStream::new(&req.model);
        call.read_stream(response, &mut stream, on_event).await?;
        Ok(stream.finish())
    }
}

/// A 400 that names the fallback parameter or the beta header.
fn rejects_fallbacks(error: &ProviderError) -> bool {
    let message = error.message.to_ascii_lowercase();
    error.kind == ProviderErrorKind::BadRequest
        && (message.contains("fallback") || message.contains("anthropic-beta"))
}

/// The effort to send: none without effort support; the requested level
/// when the Models API did not list levels; else the highest listed level
/// not above the requested one, or failing that the lowest listed level
/// above it (none when no level is listed).
fn supported_effort(info: Option<&AiModelInfo>, requested: Option<AiEffort>) -> Option<AiEffort> {
    let (info, requested) = (info?, requested?);
    if info.effort != Some(true) {
        return None;
    }
    let Some(levels) = &info.effort_levels else {
        return Some(requested);
    };
    let rank = |effort: AiEffort| EFFORT_LEVELS.iter().position(|(e, _)| *e == effort);
    let wanted = rank(requested)?;
    let ranked = || {
        levels
            .iter()
            .copied()
            .filter_map(move |level| rank(level).map(|r| (r, level)))
    };
    ranked()
        .filter(|(r, _)| *r <= wanted)
        .max_by_key(|(r, _)| *r)
        .or_else(|| {
            ranked()
                .filter(|(r, _)| *r > wanted)
                .min_by_key(|(r, _)| *r)
        })
        .map(|(_, level)| level)
}

impl Provider for AnthropicProvider {
    fn kind(&self) -> AiProviderKind {
        AiProviderKind::Anthropic
    }

    fn is_local(&self) -> bool {
        is_local_url(&self.base_url)
    }

    fn set_egress(&self, egress: Egress) {
        self.egress.set(egress);
    }

    /// `GET {base}/v1/models`, following `has_more` / `last_id`.
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<AiModelInfo>, ProviderError>> {
        Box::pin(async move {
            self.egress.check(&self.base_url)?;
            check_key_egress(&self.base_url)?;
            self.require_key()?;
            let cancel = CancellationToken::new();
            let deadlines = Deadlines::new(&self.timeouts, None);
            let mut models: Vec<AiModelInfo> = Vec::new();
            let mut after: Option<String> = None;
            for _ in 0..MAX_MODEL_PAGES {
                let mut url = endpoint(&self.base_url, &["v1", "models"])?;
                {
                    let mut query = url.query_pairs_mut();
                    query.append_pair("limit", MODELS_PAGE_LIMIT);
                    if let Some(after) = &after {
                        query.append_pair("after_id", after);
                    }
                }
                let page = with_retries(&self.retry, deadlines.content, &|_| {}, &cancel, || {
                    self.get_json(url.clone(), deadlines, &cancel)
                })
                .await?;
                let data = page["data"].as_array().ok_or_else(|| {
                    ProviderError::new(
                        ProviderErrorKind::Protocol,
                        "Anthropic sent a model list without data",
                    )
                })?;
                models.extend(data.iter().filter_map(model_from_json));
                let last = page["last_id"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| models.last().map(|m| m.id.clone()));
                if page["has_more"].as_bool() != Some(true) || last.is_none() || last == after {
                    break;
                }
                after = last;
            }
            Ok(models)
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
            check_key_egress(&self.base_url)?;
            self.require_key()?;
            let deadlines = Deadlines::new(&self.timeouts, Some(req.max_tokens));
            with_retries(&self.retry, deadlines.content, on_event, cancel, || {
                self.attempt(req, deadlines, on_event, cancel)
            })
            .await
        })
    }
}

/// A Models API entry → [`AiModelInfo`].
fn model_from_json(value: &Value) -> Option<AiModelInfo> {
    let tokens = |v: &Value| v.as_u64().map(|n| u32::try_from(n).unwrap_or(u32::MAX));
    let effort = &value["capabilities"]["effort"];
    let reported = EFFORT_LEVELS
        .iter()
        .any(|(_, key)| effort[*key].is_object());
    let levels: Vec<AiEffort> = EFFORT_LEVELS
        .iter()
        .filter(|(_, key)| effort[*key]["supported"].as_bool() == Some(true))
        .map(|(level, _)| *level)
        .collect();
    Some(AiModelInfo {
        id: value["id"].as_str()?.to_string(),
        display_name: value["display_name"].as_str().map(str::to_string),
        context_window: tokens(&value["max_input_tokens"]),
        max_output_tokens: tokens(&value["max_tokens"]),
        adaptive_thinking: value["capabilities"]["thinking"]["types"]["adaptive"]["supported"]
            .as_bool(),
        effort: effort["supported"].as_bool(),
        effort_levels: reported.then_some(levels),
    })
}

/// The `messages` array: tool results first in their user message (as the
/// API requires), at most [`MAX_MESSAGE_BREAKPOINTS`] cached text blocks,
/// assistant turns echoed from `raw`.
fn messages(messages: &[ChatMessage]) -> Vec<Value> {
    let mut breakpoints = 0;
    let mut out = Vec::with_capacity(messages.len());
    for message in messages {
        match message {
            ChatMessage::User(blocks) => {
                let mut content = Vec::new();
                for block in blocks {
                    if let UserBlock::ToolResult {
                        call_id,
                        content: text,
                        is_error,
                    } = block
                    {
                        content.push(json!({
                            "type": "tool_result",
                            "tool_use_id": call_id,
                            "content": text,
                            "is_error": is_error,
                        }));
                    }
                }
                for block in blocks {
                    if let UserBlock::Text { text, cache } = block {
                        if text.is_empty() {
                            continue;
                        }
                        let mut block = json!({"type": "text", "text": text});
                        if *cache && breakpoints < MAX_MESSAGE_BREAKPOINTS {
                            block["cache_control"] = json!({"type": "ephemeral"});
                            breakpoints += 1;
                        }
                        content.push(block);
                    }
                }
                if !content.is_empty() {
                    out.push(json!({"role": "user", "content": content}));
                }
            }
            ChatMessage::Assistant(turn) => {
                let content = assistant_content(turn);
                if !content.is_empty() {
                    out.push(json!({"role": "assistant", "content": content}));
                }
            }
        }
    }
    out
}

/// `raw` when it is Anthropic content, else rebuilt from text and calls.
fn assistant_content(turn: &AssistantTurn) -> Vec<Value> {
    if let Value::Array(blocks) = &turn.raw {
        if !blocks.is_empty() {
            return blocks.clone();
        }
    }
    let mut content = Vec::new();
    if !turn.text.is_empty() {
        content.push(json!({"type": "text", "text": turn.text}));
    }
    for call in &turn.tool_calls {
        content.push(json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.name,
            "input": call.input.clone().unwrap_or_else(|_| json!({})),
        }));
    }
    content
}

// ---------------------------------------------------------------------------
// Stream decoding
// ---------------------------------------------------------------------------

enum Kind {
    Text,
    Thinking,
    ToolUse {
        id: String,
        name: String,
    },
    Fallback,
    /// `redacted_thinking` and unknown block types: kept verbatim.
    Opaque,
}

struct Block {
    kind: Kind,
    /// The `content_block` of `content_block_start`.
    start: Value,
    /// Text, thinking text or tool-input JSON.
    buf: String,
    signature: String,
    done: bool,
}

/// The state of one streamed Messages API response.
struct MessageStream {
    sse: SseParser,
    blocks: BTreeMap<u64, Block>,
    /// `content_block_start` events so far (capped).
    starts: usize,
    text: String,
    /// Text, thinking, signatures and block payloads.
    budget: Budget,
    input_budget: Budget,
    usage: AiUsage,
    model: String,
    stop_reason: Option<String>,
    refusal_category: Option<String>,
    saw_event: bool,
}

fn protocol(message: impl Into<String>) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Protocol, message)
}

impl MessageStream {
    fn new(model: &str) -> Self {
        Self {
            sse: SseParser::new(),
            blocks: BTreeMap::new(),
            starts: 0,
            text: String::new(),
            budget: Budget::default(),
            input_budget: Budget::default(),
            usage: AiUsage::default(),
            model: model.to_string(),
            stop_reason: None,
            refusal_category: None,
            saw_event: false,
        }
    }

    fn merge_usage(&mut self, usage: &Value) {
        let set = |field: &str, target: &mut u64| {
            if let Some(n) = usage[field].as_u64() {
                *target = n;
            }
        };
        set("input_tokens", &mut self.usage.input_tokens);
        set("output_tokens", &mut self.usage.output_tokens);
        set(
            "cache_creation_input_tokens",
            &mut self.usage.cache_write_tokens,
        );
        set("cache_read_input_tokens", &mut self.usage.cache_read_tokens);
    }

    /// Handles one event; `Ok(true)` at `message_stop`.
    fn event(&mut self, data: &str, on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let value: Value = serde_json::from_str(data)
            .map_err(|e| protocol(format!("Anthropic sent a malformed stream event: {e}")))?;
        self.saw_event = true;
        let index = || {
            value["index"]
                .as_u64()
                .ok_or_else(|| protocol("Anthropic sent a content event without an index"))
        };
        match value["type"].as_str().unwrap_or_default() {
            "message_start" => {
                let message = &value["message"];
                if let Some(model) = message["model"].as_str() {
                    self.model = model.to_string();
                }
                self.merge_usage(&message["usage"]);
                on_event(StreamEvent::Usage(self.usage));
            }
            "content_block_start" => {
                let index = index()?;
                self.starts += 1;
                if self.starts > MAX_CONTENT_BLOCKS {
                    return Err(protocol(format!(
                        "Anthropic sent more than {MAX_CONTENT_BLOCKS} content blocks"
                    )));
                }
                // The whole payload (redacted data, ids, names, initial text).
                self.budget.add(data.len(), MAX_RESPONSE_BYTES, "content")?;
                let start = value["content_block"].clone();
                let kind = match start["type"].as_str().unwrap_or_default() {
                    "text" => Kind::Text,
                    "thinking" => {
                        on_event(StreamEvent::Thinking);
                        Kind::Thinking
                    }
                    "redacted_thinking" => {
                        on_event(StreamEvent::Thinking);
                        Kind::Opaque
                    }
                    "tool_use" => {
                        let input = &start["input"];
                        if input.as_object().is_some_and(|o| !o.is_empty()) {
                            self.input_budget.add(
                                input.to_string().len(),
                                MAX_TOOL_INPUT_BYTES,
                                "tool input",
                            )?;
                        }
                        Kind::ToolUse {
                            id: start["id"].as_str().unwrap_or_default().to_string(),
                            name: start["name"].as_str().unwrap_or_default().to_string(),
                        }
                    }
                    "fallback" => {
                        on_event(StreamEvent::Fallback {
                            from: start["from"]["model"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string(),
                            to: start["to"]["model"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string(),
                        });
                        Kind::Fallback
                    }
                    _ => Kind::Opaque,
                };
                let mut block = Block {
                    kind,
                    start,
                    buf: String::new(),
                    signature: String::new(),
                    done: false,
                };
                // Gateways may send a whole block in its start event: seed
                // the text, or the thinking text and signature, from it.
                match block.kind {
                    Kind::Text => {
                        if let Some(initial) =
                            block.start["text"].as_str().filter(|t| !t.is_empty())
                        {
                            block.buf.push_str(initial);
                            self.text.push_str(initial);
                            on_event(StreamEvent::Text(initial.to_string()));
                        }
                    }
                    Kind::Thinking => {
                        block
                            .buf
                            .push_str(block.start["thinking"].as_str().unwrap_or_default());
                        block
                            .signature
                            .push_str(block.start["signature"].as_str().unwrap_or_default());
                    }
                    _ => {}
                }
                self.blocks.insert(index, block);
            }
            "content_block_delta" => {
                let index = index()?;
                let block = self
                    .blocks
                    .get_mut(&index)
                    .ok_or_else(|| protocol("Anthropic sent a delta for an unknown block"))?;
                let delta = &value["delta"];
                let piece = |field: &str| delta[field].as_str().unwrap_or_default();
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => {
                        let text = piece("text");
                        self.budget.add(text.len(), MAX_RESPONSE_BYTES, "content")?;
                        block.buf.push_str(text);
                        self.text.push_str(text);
                        if !text.is_empty() {
                            on_event(StreamEvent::Text(text.to_string()));
                        }
                    }
                    "thinking_delta" => {
                        let thinking = piece("thinking");
                        self.budget
                            .add(thinking.len(), MAX_RESPONSE_BYTES, "content")?;
                        block.buf.push_str(thinking);
                    }
                    "signature_delta" => {
                        let signature = piece("signature");
                        self.budget
                            .add(signature.len(), MAX_RESPONSE_BYTES, "content")?;
                        block.signature.push_str(signature);
                    }
                    "input_json_delta" => {
                        let json = piece("partial_json");
                        self.input_budget
                            .add(json.len(), MAX_TOOL_INPUT_BYTES, "tool input")?;
                        block.buf.push_str(json);
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(block) = self.blocks.get_mut(&index()?) {
                    block.done = true;
                }
            }
            "message_delta" => {
                let delta = &value["delta"];
                if let Some(reason) = delta["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.to_string());
                }
                let details = if delta["stop_details"].is_object() {
                    &delta["stop_details"]
                } else {
                    &value["stop_details"]
                };
                if let Some(category) = details["category"].as_str() {
                    self.refusal_category = Some(category.to_string());
                }
                self.merge_usage(&value["usage"]);
                on_event(StreamEvent::Usage(self.usage));
            }
            "message_stop" => return Ok(true),
            "error" => return Err(stream_error(&value["error"])),
            // `ping` and event types added later.
            _ => {}
        }
        Ok(false)
    }

    fn stop(&self) -> StopReason {
        match self.stop_reason.as_deref() {
            Some("tool_use") => StopReason::ToolUse,
            Some("max_tokens" | "model_context_window_exceeded") => StopReason::MaxTokens,
            Some("refusal") => StopReason::Refusal {
                category: self.refusal_category.clone(),
            },
            // end_turn, stop_sequence, pause_turn.
            _ => StopReason::EndTurn,
        }
    }

    /// The complete turn: raw content rebuilt from the finished blocks.
    fn finish(self) -> AssistantTurn {
        let stop = self.stop();
        let runs_tools = !matches!(stop, StopReason::MaxTokens | StopReason::Refusal { .. });
        let last_fallback = self
            .blocks
            .iter()
            .filter(|(_, b)| matches!(b.kind, Kind::Fallback))
            .map(|(i, _)| *i)
            .max();
        let mut content = Vec::new();
        let mut tool_calls = Vec::new();
        for (index, block) in self.blocks {
            if !block.done {
                continue;
            }
            // Declined model's model-internal blocks before the last switch.
            let declined = last_fallback.is_some_and(|f| index < f);
            match block.kind {
                Kind::Text if !block.buf.is_empty() => {
                    content.push(json!({"type": "text", "text": block.buf}));
                }
                Kind::Fallback => content.push(block.start),
                Kind::Thinking if !declined => {
                    let mut raw = match block.start {
                        Value::Object(map) => map,
                        _ => Map::new(),
                    };
                    raw.insert("type".into(), json!("thinking"));
                    raw.insert("thinking".into(), json!(block.buf));
                    raw.insert("signature".into(), json!(block.signature));
                    content.push(Value::Object(raw));
                }
                Kind::Opaque if !declined => content.push(block.start),
                Kind::ToolUse { id, name } if !declined && runs_tools => {
                    // The whole input may come in `content_block_start`.
                    let input = match &block.start["input"] {
                        Value::Object(start) if block.buf.trim().is_empty() => {
                            Ok(Value::Object(start.clone()))
                        }
                        _ => parse_tool_input(&block.buf),
                    };
                    content.push(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": input.clone().unwrap_or_else(|_| json!({})),
                    }));
                    tool_calls.push(ToolCallReq { id, name, input });
                }
                _ => {}
            }
        }
        AssistantTurn {
            raw: Value::Array(content),
            text: self.text,
            tool_calls,
            stop,
            usage: self.usage,
            model: self.model,
        }
    }
}

impl Decoder for MessageStream {
    fn accepts(&self, content_type: &str) -> bool {
        is_event_stream(content_type)
    }

    fn feed(&mut self, bytes: &[u8], on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let events = self.sse.push(bytes).map_err(|e| protocol(e.to_string()))?;
        for (_name, data) in events {
            if self.event(&data, on_event)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn started(&self) -> bool {
        !self.blocks.is_empty()
    }

    fn saw_event(&self) -> bool {
        self.saw_event
    }

    fn partial(&self) -> AssistantTurn {
        let raw = if self.text.is_empty() {
            json!([])
        } else {
            json!([{"type": "text", "text": self.text}])
        };
        AssistantTurn {
            raw,
            text: self.text.clone(),
            tool_calls: Vec::new(),
            stop: StopReason::EndTurn,
            usage: self.usage,
            model: self.model.clone(),
        }
    }
}

/// An SSE `error` event (`{type, message}`) → the matching kind.
fn stream_error(error: &Value) -> ProviderError {
    let kind_name = error["type"].as_str().unwrap_or("error");
    let message = error["message"].as_str().unwrap_or_default();
    let kind = match kind_name {
        "overloaded_error" => ProviderErrorKind::Overloaded,
        "rate_limit_error" => ProviderErrorKind::RateLimited,
        "authentication_error" | "permission_error" => ProviderErrorKind::Auth,
        "not_found_error" => ProviderErrorKind::NotFound,
        "invalid_request_error" | "request_too_large" | "billing_error" => {
            ProviderErrorKind::BadRequest
        }
        "timeout_error" => ProviderErrorKind::Timeout,
        _ => ProviderErrorKind::Server,
    };
    ProviderError::new(kind, format!("{NAME} reported {kind_name}: {message}"))
}
