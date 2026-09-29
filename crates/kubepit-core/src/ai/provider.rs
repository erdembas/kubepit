//! The provider abstraction shared by the three assistant providers
//! (spec D2, §9, §10): the dyn-compatible [`Provider`] trait, the chat
//! types every provider maps to its wire format, [`ProviderError`], the
//! retry loop ([`with_retries`]), timeouts ([`AiTimeouts`]), the HTTPS
//! client ([`http_client`]) and the egress guard ([`check_egress`]).
//!
//! Safety rules enforced here, for every provider:
//!
//! - **Egress** is checked inside each provider entry point (`chat`,
//!   `list_models`, `model_info`) before any socket is opened; a provider
//!   built without [`Egress`] reaches loopback addresses only.
//! - **Keys stay with their base URL:** the client never follows redirects
//!   (a 3xx is a [`ProviderErrorKind::BadRequest`]), so a key header can
//!   never be replayed to another host.
//! - **Errors never carry request headers or keys:** messages are built from
//!   the status and the provider's (truncated) error body, with every key
//!   occurrence masked.
//! - **Loopback traffic bypasses proxies** (`HTTP_PROXY` & co. cannot
//!   capture a local model's traffic).
//! - **Streams are bounded:** one SSE event / NDJSON line, the tool-input
//!   JSON, everything else a response accumulates (text, thinking,
//!   signatures, block payloads), the number of content blocks and of tool
//!   calls have caps; overflow is a [`ProviderErrorKind::Protocol`] error.
//! - **The client is not the caller's:** every provider builds its own
//!   [`http_client`] for its base URL in its constructor, so no caller can
//!   hand it a client that follows redirects or uses a proxy for loopback.
//! - **One deadline per call:** `AiTimeouts::total` bounds a whole `chat`,
//!   retries included; a failure is re-sent automatically only when no
//!   content had started streaming.

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use hyper::body::Bytes;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::settings::is_loopback;
use super::types::{AiEffort, AiModelInfo, AiProviderKind, AiUsage};

/// Longest [`ProviderError::message`], in bytes.
pub const MAX_ERROR_MESSAGE_BYTES: usize = 2 * 1024;
/// Largest accumulated tool-input JSON of one response, in bytes.
pub const MAX_TOOL_INPUT_BYTES: usize = 256 * 1024;
/// Largest total of everything else one response accumulates (answer text,
/// thinking, signatures, content-block payloads, tool names), in bytes.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Most content blocks in one Anthropic response.
pub const MAX_CONTENT_BLOCKS: usize = 512;
/// Most tool calls in one response.
pub const MAX_TOOL_CALLS: usize = 128;
/// Largest JSON body read from a non-streaming endpoint (model lists).
pub const MAX_JSON_BODY_BYTES: usize = 8 * 1024 * 1024;
/// How much of an error response body is read before it is summarized.
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// A read-only tool offered to the model: its name, what it does and the
/// JSON Schema of its input (`additionalProperties: false`). Providers map
/// it to their wire format (Anthropic `input_schema`, OpenAI `parameters`)
/// and send tools sorted by name so the prompt prefix stays cacheable.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Chat types
// ---------------------------------------------------------------------------

/// One request to a model: the frozen system prompt, the conversation so
/// far, the offered tools and the output cap.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatRequest {
    pub model: String,
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub max_tokens: u32,
    /// Anthropic `output_config.effort`; sent only when the model supports it.
    pub effort: Option<AiEffort>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatMessage {
    User(Vec<UserBlock>),
    Assistant(AssistantTurn),
}

#[derive(Debug, Clone, PartialEq)]
pub enum UserBlock {
    /// Text; `cache: true` marks a prompt-cache breakpoint (the session's
    /// first context block).
    Text { text: String, cache: bool },
    /// The result of the tool call `call_id` (all results of one assistant
    /// turn go in one user message).
    ToolResult {
        call_id: String,
        content: String,
        is_error: bool,
    },
}

/// A tool call requested by the model. `input` is `Err(raw)` when the
/// streamed JSON did not parse strictly to an object: such a call must not
/// run (the session answers it with an error result).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallReq {
    pub id: String,
    pub name: String,
    pub input: Result<Value, String>,
}

/// One model response.
#[derive(Debug, Clone, PartialEq)]
pub struct AssistantTurn {
    /// The provider's own representation, echoed back unchanged in later
    /// requests to the same provider (Anthropic: the `content` array with
    /// thinking blocks and signatures; OpenAI / Ollama: the assistant
    /// message). `Null` when the turn is rebuilt from `text`/`tool_calls`.
    pub raw: Value,
    /// The answer text, as streamed.
    pub text: String,
    /// Calls to run. Always empty when `stop` is `MaxTokens` or `Refusal`.
    pub tool_calls: Vec<ToolCallReq>,
    pub stop: StopReason,
    pub usage: AiUsage,
    /// The model that produced the response (after a fallback: the
    /// fallback model).
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    /// A safety refusal (Anthropic `stop_details.category`, OpenAI
    /// `content_filter`).
    Refusal {
        category: Option<String>,
    },
}

/// Progress of one `chat` call, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// A piece of the answer text.
    Text(String),
    /// The model started a thinking block (its text is not shown).
    Thinking,
    /// Usage so far (the last one is final).
    Usage(AiUsage),
    /// The provider switched to another model (server-side fallback).
    Fallback { from: String, to: String },
    /// A failed attempt is retried after `delay_ms`.
    Retrying {
        attempt: u32,
        delay_ms: u64,
        reason: String,
    },
}

/// Where stream events go.
pub type EventSink<'a> = &'a (dyn Fn(StreamEvent) + Send + Sync);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderErrorKind {
    /// 401 / 403, or an unusable key.
    Auth,
    /// 400 / 413 / other 4xx, a redirect, or an invalid base URL.
    BadRequest,
    /// 404 (unknown model or endpoint).
    NotFound,
    /// 429.
    RateLimited,
    /// 529 / `overloaded_error`.
    Overloaded,
    /// Other 5xx.
    Server,
    /// No first event, a stalled stream, or the total time ran out.
    Timeout,
    /// Could not connect, or the connection broke mid-stream.
    Network,
    /// A response that does not follow the protocol (malformed or oversized).
    Protocol,
    /// Cancelled by the caller.
    Cancelled,
    /// The egress rule refused the base URL; nothing was sent.
    EgressRefused,
}

impl ProviderErrorKind {
    /// Stable kebab-case name (logs, the audit record).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::BadRequest => "bad-request",
            Self::NotFound => "not-found",
            Self::RateLimited => "rate-limited",
            Self::Overloaded => "overloaded",
            Self::Server => "server",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Protocol => "protocol",
            Self::Cancelled => "cancelled",
            Self::EgressRefused => "egress-refused",
        }
    }
}

/// A failed provider call. `message` never contains request headers or a
/// key and is at most [`MAX_ERROR_MESSAGE_BYTES`] long.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderError {
    pub kind: ProviderErrorKind,
    pub message: String,
    /// The provider's `retry-after`.
    pub retry_after: Option<Duration>,
    /// What streamed before the failure: `Some` as soon as any content
    /// (text, thinking, a tool call) had started, even if it has no text
    /// yet; `None` when nothing had. Text only, never tool calls. Boxed to
    /// keep `Result<_, ProviderError>` small.
    pub partial: Option<Box<AssistantTurn>>,
}

impl ProviderError {
    pub fn new(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: truncate(message.into(), MAX_ERROR_MESSAGE_BYTES),
            retry_after: None,
            partial: None,
        }
    }

    pub fn cancelled() -> Self {
        Self::new(ProviderErrorKind::Cancelled, "the request was cancelled")
    }

    /// Whether the user may try again (the UI offers "Retry"): transient
    /// failures and broken or malformed streams. Automatic retries are
    /// narrower (see [`with_retries`]).
    pub fn retryable(&self) -> bool {
        use ProviderErrorKind::*;
        matches!(
            self.kind,
            RateLimited | Overloaded | Server | Timeout | Network | Protocol
        )
    }

    /// Attaches what streamed so far (keeps an existing partial).
    pub fn with_partial(mut self, partial: AssistantTurn) -> Self {
        if self.partial.is_none() {
            self.partial = Some(Box::new(partial));
        }
        self
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// Spec §10: connect 10 s, first stream event 60 s, idle between events
/// 90 s, total 10 min (shortened in tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiTimeouts {
    pub connect: Duration,
    pub first_event: Duration,
    pub idle: Duration,
    pub total: Duration,
}

impl Default for AiTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(10),
            first_event: Duration::from_secs(60),
            idle: Duration::from_secs(90),
            total: Duration::from_secs(600),
        }
    }
}

/// Spec §10: up to 3 retries, 1 s · 2ⁿ⁻¹ ± 20 % capped at 30 s, or the
/// provider's `retry-after` capped at 60 s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base: Duration,
    pub cap: Duration,
    pub retry_after_cap: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base: Duration::from_secs(1),
            cap: Duration::from_secs(30),
            retry_after_cap: Duration::from_secs(60),
        }
    }
}

// ---------------------------------------------------------------------------
// The trait
// ---------------------------------------------------------------------------

/// A model provider. Dyn-compatible (`Box<dyn Provider>`): the async
/// methods return boxed futures.
pub trait Provider: Send + Sync {
    fn kind(&self) -> AiProviderKind;
    /// The base URL is a loopback address (like `AiProviderStatus::local`).
    fn is_local(&self) -> bool;
    /// The provider's models (Anthropic: with capabilities).
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<AiModelInfo>, ProviderError>>;
    /// Streams one response, retrying transient failures before any
    /// content arrived. `on_event` sees text, thinking, usage, fallback and
    /// retry events; `cancel` aborts the call (`Cancelled`, with the partial).
    fn chat<'a>(
        &'a self,
        req: &'a ChatRequest,
        on_event: EventSink<'a>,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<AssistantTurn, ProviderError>>;
}

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

/// The egress rule a provider enforces (spec D5). The default allows
/// loopback addresses only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Egress {
    /// This process may reach remote providers (`set_ai_remote_providers`).
    pub remote_allowed: bool,
    /// The user's local-only switch.
    pub local_only: bool,
}

impl Egress {
    pub fn check(&self, base_url: &str) -> Result<(), ProviderError> {
        check_egress(base_url, self.remote_allowed, self.local_only)
    }
}

/// Refuses a non-loopback `base_url` unless remote egress is allowed in
/// this process and local-only mode is off. Nothing is sent when it fails.
/// Loopback is decided by [`is_local_url`] (both URL parsers must agree).
pub fn check_egress(
    base_url: &str,
    remote_allowed: bool,
    local_only: bool,
) -> Result<(), ProviderError> {
    if is_local_url(base_url) || (remote_allowed && !local_only) {
        return Ok(());
    }
    let host = url_host(base_url).unwrap_or_else(|| "this address".to_string());
    let message = if local_only {
        format!("local-only mode is on: {host} is not a loopback address, so nothing was sent")
    } else {
        format!(
            "remote model providers are not allowed in this process: {host} is not a loopback address, so nothing was sent"
        )
    };
    Err(ProviderError::new(
        ProviderErrorKind::EgressRefused,
        message,
    ))
}

/// Whether `base_url` is a loopback address, as the settings rule
/// ([`is_loopback`], `http::Uri`) **and** the `url` parser reqwest connects
/// with both read it. Any disagreement (`http://127.1`, `http://0x7f000001`,
/// …) counts as remote: the guard fails closed.
pub fn is_local_url(base_url: &str) -> bool {
    is_loopback(base_url) && url_is_loopback(base_url)
}

fn url_is_loopback(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url.trim()) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    // `host_str` is the parser's normalized host (`127.1` → `127.0.0.1`,
    // IPv6 in brackets): exactly where reqwest will connect.
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// `host[:port]` of a URL, without scheme, user info or path.
fn url_host(base_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(base_url.trim()).ok()?;
    Some(host_label(&url))
}

pub(crate) fn host_label(url: &reqwest::Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => "the provider".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/// Runs `attempt` until it succeeds, fails for good, `policy` runs out or
/// the next wait would end after `deadline` (the call's total deadline,
/// shared by every attempt). Retried: `RateLimited`, `Overloaded`, `Server`
/// and `Network` (connect errors, dropped connections), and only when no
/// content had started streaming (`partial` is `None`). Each wait is
/// announced with [`StreamEvent::Retrying`] and ends early (`Cancelled`)
/// when `cancel` fires.
pub async fn with_retries<T, F, Fut>(
    policy: &RetryPolicy,
    deadline: Instant,
    on_event: EventSink<'_>,
    cancel: &CancellationToken,
    mut attempt: F,
) -> Result<T, ProviderError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, ProviderError>>,
{
    let mut retries = 0;
    loop {
        let error = match attempt().await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        if retries >= policy.max_retries || !auto_retryable(&error) || cancel.is_cancelled() {
            return Err(error);
        }
        let delay = retry_delay(policy, retries + 1, error.retry_after);
        if Instant::now() + delay >= deadline {
            return Err(error);
        }
        retries += 1;
        on_event(StreamEvent::Retrying {
            attempt: retries,
            delay_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
            reason: error.message.clone(),
        });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ProviderError::cancelled()),
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

fn auto_retryable(error: &ProviderError) -> bool {
    use ProviderErrorKind::*;
    let transient = matches!(error.kind, RateLimited | Overloaded | Server | Network);
    // Any started content (even thinking or a tool call without text) means
    // the answer was under way: never re-send it silently.
    transient && error.partial.is_none()
}

/// The wait before retry `attempt` (1-based): the provider's `retry-after`
/// capped at `retry_after_cap`, else `base · 2^(attempt-1)` capped at `cap`,
/// ± 20 % jitter.
pub fn retry_delay(policy: &RetryPolicy, attempt: u32, retry_after: Option<Duration>) -> Duration {
    if let Some(after) = retry_after {
        return after.min(policy.retry_after_cap);
    }
    let exponent = attempt.saturating_sub(1).min(20);
    let backoff = policy.base.saturating_mul(1u32 << exponent).min(policy.cap);
    // Uniform in [0.8, 1.2).
    let unit = (uuid::Uuid::new_v4().as_u128() % 10_000) as f64 / 10_000.0;
    backoff.mul_f64(0.8 + 0.4 * unit)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// The HTTPS client for a provider at `base_url`: rustls with the ring
/// provider and the platform's roots (the same stack as the rest of the
/// app), `connect` timeout, no redirects (a key must only reach its own
/// base URL), no hidden retries, and no proxy for loopback addresses.
/// Every provider builds its own in its constructor ([`provider_client`]);
/// none accepts a client from the caller.
pub fn http_client(t: &AiTimeouts, base_url: &str) -> Result<reqwest::Client, ProviderError> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(t.connect)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .user_agent(concat!("kubepit/", env!("CARGO_PKG_VERSION")))
        .tls_backend_preconfigured(tls_config());
    if is_local_url(base_url) {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|e| {
        ProviderError::new(
            ProviderErrorKind::Network,
            format!("could not set up the HTTP client: {}", error_chain(&e)),
        )
    })
}

/// A provider constructor's normalized base URL (trimmed, no trailing
/// slash; a valid http(s) URL) and its own [`http_client`].
pub(crate) fn provider_client(
    t: &AiTimeouts,
    base_url: &str,
) -> Result<(String, reqwest::Client), ProviderError> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    endpoint(&base_url, &[])?;
    let client = http_client(t, &base_url)?;
    Ok((base_url, client))
}

fn tls_config() -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports the default TLS versions")
        .with_root_certificates(crate::prometheus::tunnel::system_roots())
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config
}

/// `base_url` with `segments` appended as path segments (percent-encoded,
/// so a model id cannot change the path).
pub(crate) fn endpoint(base_url: &str, segments: &[&str]) -> Result<reqwest::Url, ProviderError> {
    let invalid = || {
        ProviderError::new(
            ProviderErrorKind::BadRequest,
            "the provider's base URL is not a valid http(s) URL",
        )
    };
    let mut url = reqwest::Url::parse(base_url.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid());
    }
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .map_err(|_| invalid())?
        .pop_if_empty()
        .extend(segments);
    Ok(url)
}

/// A header value that is never printed (`Debug` shows `Sensitive`).
pub(crate) fn secret_header(value: &str) -> Result<reqwest::header::HeaderValue, ProviderError> {
    let mut header = reqwest::header::HeaderValue::from_str(value).map_err(|_| {
        ProviderError::new(
            ProviderErrorKind::Auth,
            "the API key contains characters that cannot be sent in a header",
        )
    })?;
    header.set_sensitive(true);
    Ok(header)
}

/// Keeps at most `max` bytes (on a character boundary), marking the cut.
fn truncate(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    const MARK: &str = "…";
    let mut end = max.saturating_sub(MARK.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str(MARK);
    text
}

/// `text` with every key occurrence masked.
pub(crate) fn mask_secrets(text: &str, secrets: &[&str]) -> String {
    let mut text = text.to_string();
    for secret in secrets.iter().filter(|s| s.len() >= 4) {
        text = text.replace(secret, "[redacted]");
    }
    text
}

/// A reqwest error and its sources, without the URL.
fn error_chain(error: &reqwest::Error) -> String {
    let mut parts = Vec::new();
    let mut source: Option<&dyn std::error::Error> = std::error::Error::source(error);
    while let Some(err) = source {
        let text = err.to_string();
        if !parts.contains(&text) {
            parts.push(text);
        }
        source = err.source();
    }
    if parts.is_empty() {
        parts.push(error.to_string());
    }
    parts.join(": ")
}

/// The provider's status mapped to an error kind (spec §10).
pub(crate) fn status_kind(code: u16) -> ProviderErrorKind {
    use ProviderErrorKind::*;
    match code {
        401 | 403 => Auth,
        404 => NotFound,
        408 => Timeout,
        429 => RateLimited,
        529 => Overloaded,
        300..=399 => BadRequest,
        400..=499 => BadRequest,
        500..=599 => Server,
        _ => Protocol,
    }
}

/// `retry-after` in (possibly fractional) seconds; an HTTP date is ignored.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let seconds: f64 = value.trim().parse().ok()?;
    (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds.min(86_400.0)))
}

/// The human part of an error body: `error.type` + `error.message`
/// (Anthropic, OpenAI), `error` (Ollama) or `message`, else the text.
fn error_detail(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return text.trim().to_string();
    };
    let error = &value["error"];
    let kind = error["type"].as_str().or_else(|| error["code"].as_str());
    let message = error["message"]
        .as_str()
        .or_else(|| error.as_str())
        .or_else(|| value["message"].as_str())
        .or_else(|| value["detail"].as_str());
    match (kind, message) {
        (Some(kind), Some(message)) => format!("{kind}: {message}"),
        (None, Some(message)) => message.to_string(),
        (Some(kind), None) => kind.to_string(),
        (None, None) => text.trim().to_string(),
    }
}

/// One HTTP exchange with a provider: its name (for messages), the keys to
/// mask, the deadlines and the cancellation token.
pub(crate) struct Call<'a> {
    pub provider: &'static str,
    pub host: String,
    pub secrets: &'a [&'a str],
    pub timeouts: &'a AiTimeouts,
    pub cancel: &'a CancellationToken,
    /// When this request started (the first-event timer).
    started: Instant,
    /// The whole call's deadline, shared by its retries.
    deadline: Instant,
}

impl<'a> Call<'a> {
    pub fn new(
        provider: &'static str,
        url: &reqwest::Url,
        secrets: &'a [&'a str],
        timeouts: &'a AiTimeouts,
        deadline: Instant,
        cancel: &'a CancellationToken,
    ) -> Self {
        Self {
            provider,
            host: host_label(url),
            secrets,
            timeouts,
            cancel,
            started: Instant::now(),
            deadline,
        }
    }

    fn deadline(&self) -> Instant {
        self.deadline
    }

    fn first_event_deadline(&self) -> Instant {
        (self.started + self.timeouts.first_event).min(self.deadline())
    }

    /// `error` with the partial answer when content had started.
    fn fail<D: Decoder>(&self, error: ProviderError, decoder: &D) -> ProviderError {
        if decoder.started() {
            error.with_partial(decoder.partial())
        } else {
            error
        }
    }

    pub fn error(&self, kind: ProviderErrorKind, message: impl AsRef<str>) -> ProviderError {
        ProviderError::new(kind, mask_secrets(message.as_ref(), self.secrets))
    }

    fn timeout_error(&self, first: bool) -> ProviderError {
        let message = if Instant::now() >= self.deadline() {
            format!(
                "{} did not finish within {} s",
                self.provider,
                self.timeouts.total.as_secs()
            )
        } else if first {
            format!(
                "{} did not answer within {} s",
                self.provider,
                self.timeouts.first_event.as_secs_f32()
            )
        } else {
            format!(
                "{} stopped sending for {} s",
                self.provider,
                self.timeouts.idle.as_secs_f32()
            )
        };
        ProviderError::new(ProviderErrorKind::Timeout, message)
    }

    fn transport_error(&self, error: &reqwest::Error) -> ProviderError {
        let detail = error_chain(error);
        let message = if error.is_connect() && error.is_timeout() {
            format!(
                "could not connect to {} within {} s",
                self.host,
                self.timeouts.connect.as_secs_f32()
            )
        } else if error.is_connect() {
            format!("could not connect to {}: {detail}", self.host)
        } else if error.is_timeout() {
            return ProviderError::new(
                ProviderErrorKind::Timeout,
                format!("{} timed out: {detail}", self.provider),
            );
        } else {
            format!("the connection to {} failed: {detail}", self.host)
        };
        self.error(ProviderErrorKind::Network, message)
    }

    /// Sends `request` and waits for the response head (bounded by the
    /// first-event deadline). A non-2xx status becomes an error.
    pub async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ProviderError> {
        if self.cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        let deadline = tokio::time::Instant::from_std(self.first_event_deadline());
        let response = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(ProviderError::cancelled()),
            result = tokio::time::timeout_at(deadline, request.send()) => match result {
                Err(_) => return Err(self.timeout_error(true)),
                Ok(Err(e)) => return Err(self.transport_error(&e)),
                Ok(Ok(response)) => response,
            },
        };
        if response.status().is_success() {
            return Ok(response);
        }
        Err(self.status_error(response).await)
    }

    /// The error for a non-2xx response, from its (capped) body.
    async fn status_error(&self, mut response: reqwest::Response) -> ProviderError {
        let code = response.status().as_u16();
        let retry_after = retry_after(response.headers());
        let kind = status_kind(code);
        if (300..400).contains(&code) {
            return self.error(
                kind,
                format!(
                    "{} answered with a redirect ({code}); redirects are not followed, so check the provider's base URL",
                    self.provider
                ),
            );
        }
        let mut body = Vec::new();
        let read = async {
            while body.len() < MAX_ERROR_BODY_BYTES {
                match response.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    _ => break,
                }
            }
        };
        // Bounded by idle and the call's deadline; cancel wins.
        let until = (Instant::now() + self.timeouts.idle).min(self.deadline());
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return ProviderError::cancelled(),
            _ = tokio::time::timeout_at(tokio::time::Instant::from_std(until), read) => {}
        }
        body.truncate(MAX_ERROR_BODY_BYTES);
        let detail = error_detail(&body);
        let message = if detail.is_empty() {
            format!("{} answered {code}", self.provider)
        } else {
            format!("{} answered {code} {detail}", self.provider)
        };
        let mut error = self.error(kind, message);
        error.retry_after = retry_after;
        error
    }

    /// Sends a GET-like `request` and parses its JSON body (capped at
    /// [`MAX_JSON_BODY_BYTES`]).
    pub async fn json(&self, request: reqwest::RequestBuilder) -> Result<Value, ProviderError> {
        let mut response = self.send(request).await?;
        let mut body = Vec::new();
        let idle = self.timeouts.idle;
        loop {
            let deadline = tokio::time::Instant::from_std(self.deadline());
            let next = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(ProviderError::cancelled()),
                r = tokio::time::timeout_at(deadline.min(tokio::time::Instant::now() + idle), response.chunk()) => r,
            };
            match next {
                Err(_) => return Err(self.timeout_error(false)),
                Ok(Err(e)) => return Err(self.transport_error(&e)),
                Ok(Ok(None)) => break,
                Ok(Ok(Some(chunk))) => {
                    body.extend_from_slice(&chunk);
                    if body.len() > MAX_JSON_BODY_BYTES {
                        return Err(self.error(
                            ProviderErrorKind::Protocol,
                            format!("{} sent a response larger than 8 MiB", self.provider),
                        ));
                    }
                }
            }
        }
        serde_json::from_slice(&body).map_err(|e| {
            self.error(
                ProviderErrorKind::Protocol,
                format!(
                    "{} sent a response that is not valid JSON: {e}",
                    self.provider
                ),
            )
        })
    }

    /// Feeds the streamed body to `decoder` until it reports completion.
    /// A success whose content type the decoder does not accept (an HTML
    /// or JSON page from a proxy) is a `Protocol` error. Waits at most
    /// `first_event` for the first chunk, `idle` between chunks and the
    /// call's deadline overall; errors carry the partial answer once
    /// content had started.
    pub async fn read_stream<D: Decoder>(
        &self,
        mut response: reqwest::Response,
        decoder: &mut D,
        on_event: EventSink<'_>,
    ) -> Result<(), ProviderError> {
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !decoder.accepts(&content_type) {
            let shown = if content_type.is_empty() {
                "no content type"
            } else {
                content_type.as_str()
            };
            return Err(self.error(
                ProviderErrorKind::Protocol,
                format!(
                    "{} answered {} with {} instead of a stream; check the provider's base URL and any proxy in between",
                    self.provider,
                    response.status().as_u16(),
                    truncate(shown.to_string(), 100)
                ),
            ));
        }
        let mut first = true;
        loop {
            let wait_until = if first {
                self.first_event_deadline()
            } else {
                (Instant::now() + self.timeouts.idle).min(self.deadline())
            };
            let next = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => {
                    return Err(self.fail(ProviderError::cancelled(), decoder));
                }
                r = tokio::time::timeout_at(tokio::time::Instant::from_std(wait_until), response.chunk()) => r,
            };
            let chunk: Bytes = match next {
                Err(_) => return Err(self.fail(self.timeout_error(first), decoder)),
                Ok(Err(e)) => {
                    let error = if e.is_timeout() {
                        self.timeout_error(first)
                    } else {
                        self.error(
                            ProviderErrorKind::Network,
                            format!(
                                "the connection to {} broke mid-answer: {}",
                                self.host,
                                error_chain(&e)
                            ),
                        )
                    };
                    return Err(self.fail(error, decoder));
                }
                Ok(Ok(None)) => {
                    if decoder.complete_at_eof() {
                        return Ok(());
                    }
                    let error = if decoder.saw_event() {
                        self.error(
                            ProviderErrorKind::Network,
                            format!(
                                "{} closed the stream before the answer was complete",
                                self.provider
                            ),
                        )
                    } else {
                        self.error(
                            ProviderErrorKind::Protocol,
                            format!(
                                "{} ended the stream without sending anything",
                                self.provider
                            ),
                        )
                    };
                    return Err(self.fail(error, decoder));
                }
                Ok(Ok(Some(chunk))) => chunk,
            };
            first = false;
            match decoder.feed(&chunk, on_event) {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => {
                    let error = ProviderError {
                        message: truncate(
                            mask_secrets(&error.message, self.secrets),
                            MAX_ERROR_MESSAGE_BYTES,
                        ),
                        ..error
                    };
                    return Err(self.fail(error, decoder));
                }
            }
        }
    }
}

/// A provider's stream format: fed raw body bytes, it emits events and
/// reports when the response is complete.
pub(crate) trait Decoder {
    /// Whether a `200` with this (lowercased, possibly empty) content type
    /// is the provider's stream.
    fn accepts(&self, content_type: &str) -> bool;
    /// Consumes `bytes`; `Ok(true)` once the response is complete.
    fn feed(&mut self, bytes: &[u8], on_event: EventSink<'_>) -> Result<bool, ProviderError>;
    /// Any content (text, thinking, a tool call) has started.
    fn started(&self) -> bool;
    /// At least one event / line was parsed.
    fn saw_event(&self) -> bool;
    /// What streamed so far: the text, never tool calls.
    fn partial(&self) -> AssistantTurn;
    /// Whether the end of the body without an end marker still counts as a
    /// complete response.
    fn complete_at_eof(&self) -> bool {
        false
    }
}

/// `text/event-stream` (Anthropic, OpenAI-compatible).
pub(crate) fn is_event_stream(content_type: &str) -> bool {
    content_type.starts_with("text/event-stream")
}

/// Strict tool input: an empty string is `{}`, anything else must parse
/// with `serde_json::from_str` to a JSON object, else `Err(raw)`.
pub fn parse_tool_input(raw: &str) -> Result<Value, String> {
    if raw.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(value @ Value::Object(_)) => Ok(value),
        _ => Err(raw.to_string()),
    }
}

/// A counter of streamed bytes with a cap; `add` fails once exceeded.
#[derive(Debug, Default)]
pub(crate) struct Budget {
    used: usize,
}

impl Budget {
    pub fn add(&mut self, bytes: usize, cap: usize, what: &str) -> Result<(), ProviderError> {
        self.used = self.used.saturating_add(bytes);
        if self.used > cap {
            return Err(ProviderError::new(
                ProviderErrorKind::Protocol,
                format!(
                    "the provider sent more {what} than allowed ({} KiB)",
                    cap / 1024
                ),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(text: &str, calls: usize) -> AssistantTurn {
        AssistantTurn {
            raw: Value::Null,
            text: text.into(),
            tool_calls: (0..calls)
                .map(|i| ToolCallReq {
                    id: format!("c{i}"),
                    name: "get_pod".into(),
                    input: Ok(Value::Null),
                })
                .collect(),
            stop: StopReason::EndTurn,
            usage: AiUsage::default(),
            model: String::new(),
        }
    }

    #[test]
    fn retry_delays_follow_the_policy() {
        let policy = RetryPolicy::default();
        assert_eq!(
            retry_delay(&policy, 1, Some(Duration::from_secs(5))),
            Duration::from_secs(5)
        );
        assert_eq!(
            retry_delay(&policy, 1, Some(Duration::from_secs(600))),
            Duration::from_secs(60),
            "retry-after is capped"
        );
        for _ in 0..50 {
            let first = retry_delay(&policy, 1, None);
            assert!(first >= Duration::from_millis(800) && first < Duration::from_millis(1200));
            let third = retry_delay(&policy, 3, None);
            assert!(third >= Duration::from_millis(3200) && third < Duration::from_millis(4800));
            let late = retry_delay(&policy, 10, None);
            assert!(late >= Duration::from_secs(24) && late < Duration::from_secs(36));
        }
        assert!(retry_delay(&policy, u32::MAX, None) <= Duration::from_secs(36));
    }

    #[test]
    fn only_transient_failures_before_any_content_are_retried() {
        let error = |kind| ProviderError::new(kind, "x");
        for kind in [
            ProviderErrorKind::RateLimited,
            ProviderErrorKind::Overloaded,
            ProviderErrorKind::Server,
            ProviderErrorKind::Network,
        ] {
            assert!(auto_retryable(&error(kind)));
            // A partial exists only once content started (even thinking).
            assert!(!auto_retryable(&error(kind).with_partial(turn("", 0))));
            assert!(!auto_retryable(&error(kind).with_partial(turn("Hi", 0))));
            assert!(!auto_retryable(&error(kind).with_partial(turn("", 1))));
        }
        for kind in [
            ProviderErrorKind::Auth,
            ProviderErrorKind::BadRequest,
            ProviderErrorKind::NotFound,
            ProviderErrorKind::Timeout,
            ProviderErrorKind::Protocol,
            ProviderErrorKind::Cancelled,
            ProviderErrorKind::EgressRefused,
        ] {
            assert!(!auto_retryable(&error(kind)), "{kind:?}");
        }
    }

    #[test]
    fn statuses_map_to_kinds() {
        use ProviderErrorKind::*;
        for (code, kind) in [
            (400, BadRequest),
            (413, BadRequest),
            (401, Auth),
            (403, Auth),
            (404, NotFound),
            (429, RateLimited),
            (500, Server),
            (502, Server),
            (503, Server),
            (504, Server),
            (529, Overloaded),
            (307, BadRequest),
        ] {
            assert_eq!(status_kind(code), kind, "{code}");
        }
    }

    #[test]
    fn error_details_come_from_the_documented_bodies() {
        assert_eq!(
            error_detail(
                br#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#
            ),
            "rate_limit_error: slow down"
        );
        assert_eq!(
            error_detail(br#"{"error":{"message":"bad key","type":"invalid_request_error","code":"invalid_api_key"}}"#),
            "invalid_request_error: bad key"
        );
        assert_eq!(
            error_detail(br#"{"error":"model not found"}"#),
            "model not found"
        );
        assert_eq!(error_detail(b"  plain text  "), "plain text");
    }

    #[test]
    fn messages_are_masked_and_truncated() {
        let key = "sk-secret-123456";
        assert_eq!(
            mask_secrets(&format!("bad key {key}!"), &[key]),
            "bad key [redacted]!"
        );
        let long = ProviderError::new(ProviderErrorKind::Server, "é".repeat(5000));
        assert!(long.message.len() <= MAX_ERROR_MESSAGE_BYTES);
        assert!(long.message.ends_with('…'));
    }

    #[test]
    fn tool_input_parsing_is_strict() {
        assert_eq!(parse_tool_input(""), Ok(serde_json::json!({})));
        assert_eq!(
            parse_tool_input(r#"{"a":1}"#),
            Ok(serde_json::json!({"a": 1}))
        );
        assert_eq!(parse_tool_input(r#"{"a":"#), Err(r#"{"a":"#.to_string()));
        assert_eq!(parse_tool_input("[1]"), Err("[1]".to_string()));
        assert_eq!(parse_tool_input("\"x\""), Err("\"x\"".to_string()));
    }

    #[test]
    fn endpoints_append_encoded_segments() {
        assert_eq!(
            endpoint("https://api.anthropic.com", &["v1", "messages"])
                .unwrap()
                .as_str(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            endpoint("https://api.openai.com/v1/", &["chat", "completions"])
                .unwrap()
                .as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint("http://127.0.0.1:4000", &["v1", "models", "a/b?c"])
                .unwrap()
                .as_str(),
            "http://127.0.0.1:4000/v1/models/a%2Fb%3Fc"
        );
        assert!(endpoint("ftp://x", &["a"]).is_err());
        assert!(endpoint("not a url", &["a"]).is_err());
    }

    #[test]
    fn clients_build_for_local_and_remote_providers() {
        let t = AiTimeouts::default();
        assert!(http_client(&t, "http://127.0.0.1:11434").is_ok());
        assert!(http_client(&t, "https://api.anthropic.com").is_ok());
    }
}
