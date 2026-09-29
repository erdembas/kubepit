//! Preview consent, bounded conversations and cancellable read-only tool runs.
//! A preview freezes the exact messages and provider configuration. It is single
//! use, invalidated by settings changes and never performs network I/O. Model
//! metadata is populated only by the explicit `ai_models` operation.
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::anthropic::AnthropicProvider;
use super::budget::estimate_tokens;
use super::context;
use super::keys;
use super::ollama::OllamaProvider;
use super::openai::OpenAiCompatProvider;
use super::pricing;
use super::prompts;
use super::provider::{
    AiTimeouts, ChatMessage, ChatRequest, Egress, Provider, ProviderErrorKind, RetryPolicy,
    StopReason, StreamEvent, UserBlock,
};
use super::redact::{redact_manifest_text, redact_message, redact_text, Pseudonyms, RedactOptions};
use super::tools::{self, ReadOnlyCluster, ToolOutput};
use super::*;
use crate::history::{AiLogOutcome, AiLogRecord};
use crate::tasks::TaskRegistry;
use crate::types::ClusterEnvironment;

pub const PREVIEW_TTL: Duration = Duration::from_secs(600);
pub const MAX_PREVIEWS: usize = 32;
pub const MAX_SESSIONS: usize = 20;
pub const SESSION_IDLE: Duration = Duration::from_secs(7200);
pub const MAX_TOOL_ROUNDS: usize = 8;
pub const MAX_TOOL_CALLS_PER_ROUND: usize = 16;
pub const REQUESTS_PER_MINUTE: u32 = 30;
// Bound work before parsing/redacting arbitrary IPC input, including the message.
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_SECTIONS: usize = 64;

pub struct RateLimiter {
    max: u32,
    window: Duration,
    requests: Mutex<VecDeque<Instant>>,
}
impl RateLimiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            max: max.max(1),
            window,
            requests: Mutex::new(VecDeque::new()),
        }
    }
    /// Reserves a slot only when available. A caller that waits must retry.
    pub fn acquire(&self, now: Instant) -> Option<Duration> {
        let mut q = self.requests.lock();
        while q
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= self.window)
        {
            q.pop_front();
        }
        if q.len() >= self.max as usize {
            return q.front().map(|t| {
                self.window
                    .saturating_sub(now.saturating_duration_since(*t))
            });
        }
        q.push_back(now);
        None
    }
}

pub(crate) struct Engine {
    data: Mutex<Data>,
    runs: TaskRegistry,
    timing: Mutex<(AiTimeouts, RetryPolicy)>,
    rate: RateLimiter,
}
impl Default for Engine {
    fn default() -> Self {
        Self {
            data: Mutex::new(Data::default()),
            runs: TaskRegistry::default(),
            timing: Mutex::new((AiTimeouts::default(), RetryPolicy::default())),
            rate: RateLimiter::new(REQUESTS_PER_MINUTE, Duration::from_secs(60)),
        }
    }
}
#[derive(Default)]
struct Data {
    previews: HashMap<String, Prepared>,
    sessions: HashMap<String, Session>,
    runs: HashMap<String, Running>,
    pending: HashMap<(String, String), oneshot::Sender<AiToolDecision>>,
    models: HashMap<String, Vec<AiModelInfo>>,
}
struct Running {
    session_id: String,
    cluster_id: Option<String>,
    cancel: CancellationToken,
}
#[derive(Clone)]
struct Session {
    id: String,
    scope: AiScope,
    locale: AiLocale,
    provider: AiProviderConfig,
    model_info: Option<AiModelInfo>,
    settings: AiSettings,
    chat: ChatRequest,
    pseudo: Pseudonyms,
    approved: bool,
    touched: Instant,
    revision: u64,
    active: Option<String>,
    window: u32,
    input_limit: u32,
}
#[derive(Clone)]
struct Prepared {
    preview: AiPreview,
    session: Session,
    intent: AiIntent,
    expires: Instant,
}
impl Data {
    fn expire(&mut self) {
        let now = Instant::now();
        self.sessions
            .retain(|_, s| s.active.is_some() || now.duration_since(s.touched) < SESSION_IDLE);
        self.previews
            .retain(|_, p| now < p.expires && self.sessions.contains_key(&p.session.id));
    }
}
fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn model_key(p: &AiProviderConfig) -> String {
    format!("{}:{}:{}", p.id, p.kind.as_str(), p.base_url)
}
fn default_window(kind: AiProviderKind) -> u32 {
    match kind {
        AiProviderKind::Anthropic => 200_000,
        AiProviderKind::OpenaiCompatible => settings::DEFAULT_OPENAI_CONTEXT_WINDOW,
        AiProviderKind::Ollama => settings::DEFAULT_OLLAMA_CONTEXT_WINDOW,
    }
}

// Concrete variants expose the exact wire-body renderer as well as Provider.
enum Client {
    Anthropic(AnthropicProvider),
    Openai(OpenAiCompatProvider),
    Ollama(OllamaProvider),
}
impl Client {
    fn provider(&self) -> &dyn Provider {
        match self {
            Self::Anthropic(p) => p,
            Self::Openai(p) => p,
            Self::Ollama(p) => p,
        }
    }
    fn with_hook(self, hook: super::provider::RequestHook) -> Self {
        match self {
            Self::Anthropic(p) => Self::Anthropic(p.with_request_hook(hook)),
            Self::Openai(p) => Self::Openai(p.with_request_hook(hook)),
            Self::Ollama(p) => Self::Ollama(p.with_request_hook(hook)),
        }
    }
}

impl Kubepit {
    fn ai_check(&self, provider: &AiProviderConfig, scope: &AiScope) -> Result<AiSettings> {
        let ai = self.settings().ai;
        if !ai.enabled {
            bail!("assistant is not enabled");
        }
        if ai.provider(&provider.id) != Some(provider) {
            bail!("assistant provider changed; preview the request again");
        }
        super::provider::check_egress(&provider.base_url, self.ai_remote_allowed(), ai.local_only)?;
        if provider.model.is_empty() {
            bail!("choose an assistant model first");
        }
        if let Some(id) = &scope.cluster_id {
            let cluster = self.cluster_def(id)?;
            if !ai.cluster_allowed(&cluster) {
                bail!("assistant is not enabled for this cluster");
            }
        } else if scope.namespace.is_some() || scope.object.is_some() {
            bail!("a namespace or object requires a cluster");
        }
        Ok(ai)
    }
    fn ai_client(
        &self,
        config: &AiProviderConfig,
        info: Option<AiModelInfo>,
        window: u32,
    ) -> Result<Client> {
        let (timeouts, retry) = *self.ai.engine.timing.lock();
        let egress = Egress {
            remote_allowed: self.ai_remote_allowed(),
            local_only: self.settings().ai.local_only,
        };
        egress.check(&config.base_url)?;
        // Read the key afresh; a cached status must never hide a locked keychain.
        let key = keys::read_key(self.secrets.as_ref(), config)?;
        if key.is_some() {
            super::provider::check_key_egress(&config.base_url)?;
        }
        Ok(match config.kind {
            AiProviderKind::Anthropic => Client::Anthropic(
                AnthropicProvider::new(
                    config.base_url.clone(),
                    key.ok_or_else(|| {
                        anyhow!("an API key is required for this assistant provider")
                    })?,
                    timeouts,
                    retry,
                    info,
                )?
                .with_egress(egress),
            ),
            AiProviderKind::OpenaiCompatible => Client::Openai(
                OpenAiCompatProvider::new(config.base_url.clone(), key, timeouts, retry)?
                    .with_egress(egress),
            ),
            AiProviderKind::Ollama => Client::Ollama(
                OllamaProvider::new(config.base_url.clone(), window, timeouts, retry)?
                    .with_egress(egress),
            ),
        })
    }
    /// Only provider metadata; no cluster data or conversation is sent.
    pub async fn ai_models(&self, provider_id: &str) -> Result<Vec<AiModelInfo>> {
        let ai = self.settings().ai;
        let config = ai
            .provider(provider_id)
            .ok_or_else(|| anyhow!("unknown assistant provider"))?;
        let client = self.ai_client(
            config,
            None,
            config
                .context_window
                .unwrap_or_else(|| default_window(config.kind)),
        )?;
        let models = client.provider().list_models().await?;
        self.ai
            .engine
            .data
            .lock()
            .models
            .insert(model_key(config), models.clone());
        Ok(models)
    }
    pub fn set_ai_timeouts(&self, timeouts: AiTimeouts, retry: RetryPolicy) {
        *self.ai.engine.timing.lock() = (timeouts, retry);
    }
    pub fn ai_preview(&self, request: AiRequest) -> Result<AiPreview> {
        let size = request.sections.iter().fold(request.message.len(), |n, s| {
            n.saturating_add(s.content.len())
                .saturating_add(s.id.len())
                .saturating_add(s.label.len())
        });
        if size > MAX_REQUEST_BYTES
            || request.message.len() > MAX_MESSAGE_BYTES
            || request.sections.len() > MAX_SECTIONS
        {
            bail!("assistant context is too large");
        }
        let mut ids = std::collections::HashSet::new();
        if request
            .sections
            .iter()
            .any(|s| s.id.len() > 2048 || s.label.len() > 2048 || !ids.insert(&s.id))
        {
            bail!("assistant section identifiers must be unique and at most 2048 bytes");
        }
        let ai = self.settings().ai;
        let config = ai
            .active()
            .ok_or_else(|| anyhow!("choose an assistant provider first"))?
            .clone();
        self.ai_check(&config, &request.scope)?;
        let mut data = self.ai.engine.data.lock();
        data.expire();
        let mut session = if let Some(id) = &request.session_id {
            let s = data
                .sessions
                .get(id)
                .ok_or_else(|| anyhow!("assistant session expired; start a new conversation"))?;
            if s.active.is_some() {
                bail!("an assistant run is already active in this session");
            }
            if s.scope != request.scope
                || s.locale != request.locale
                || s.provider != config
                || s.settings != ai
            {
                bail!("assistant session settings or scope changed; start a new conversation");
            }
            s.clone()
        } else {
            if data.sessions.len() >= MAX_SESSIONS {
                // Only an idle session can be evicted. Never kill a streaming run.
                let oldest = data
                    .sessions
                    .iter()
                    .filter(|(_, s)| s.active.is_none())
                    .min_by_key(|(_, s)| s.touched)
                    .map(|(id, _)| id.clone());
                if let Some(id) = oldest {
                    data.sessions.remove(&id);
                    data.previews.retain(|_, p| p.session.id != id);
                } else {
                    bail!("too many active assistant sessions");
                }
            }
            let info = data
                .models
                .get(&model_key(&config))
                .and_then(|m| m.iter().find(|m| m.id == config.model));
            let window = config
                .context_window
                .or_else(|| info.and_then(|m| m.context_window))
                .unwrap_or_else(|| default_window(config.kind));
            let max_tokens = config
                .max_output_tokens
                .min(info.and_then(|m| m.max_output_tokens).unwrap_or(u32::MAX));
            let prometheus = request
                .scope
                .cluster_id
                .as_deref()
                .and_then(|id| {
                    let c = self.cluster_def(id).ok()?;
                    self.prometheus.get_at(
                        id,
                        self.cluster_status(id).connected_at,
                        &(c.prometheus, c.prometheus_access),
                        Instant::now(),
                    )
                })
                .is_some_and(|s| s.state == crate::types::PrometheusState::Available);
            let tools = if request.scope.cluster_id.is_some() && ai.tool_policy != AiToolPolicy::Off
            {
                tools::tool_specs(prometheus)
            } else {
                vec![]
            };
            Session {
                id: Uuid::new_v4().to_string(),
                scope: request.scope.clone(),
                locale: request.locale,
                provider: config.clone(),
                model_info: info.cloned(),
                settings: ai.clone(),
                chat: ChatRequest {
                    model: config.model.clone(),
                    system: prompts::system_prompt(request.locale).into(),
                    messages: vec![],
                    tools,
                    max_tokens,
                    effort: ai.effort.or(Some(prompts::default_effort(request.intent))),
                },
                pseudo: Pseudonyms::default(),
                approved: ai.tool_policy == AiToolPolicy::Session,
                touched: Instant::now(),
                revision: 0,
                active: None,
                window,
                input_limit: ai.max_context_tokens.min(window.saturating_sub(max_tokens)),
            }
        };
        let earlier_messages = session.chat.messages.len() as u32;
        let opts = RedactOptions::from(&ai.redaction);
        // Include the system, tool schemas, framing and history in the budget.
        let system_tokens = estimate_tokens(&session.chat.system);
        let overhead = chat_tokens(&session.chat);
        let mut estimate_pseudo = session.pseudo.clone();
        let (message, _) = redact_message(&request.message, &opts, &mut estimate_pseudo);
        let instruction = prompts::intent_instructions(request.intent);
        let message_tokens = estimate_tokens(&message)
            .saturating_add(estimate_tokens(instruction))
            .saturating_add(96);
        let budget = session.input_limit.checked_sub(overhead.saturating_add(message_tokens))
            .ok_or_else(|| anyhow!("assistant conversation exceeds the context budget; start a new conversation or shorten the message"))?;
        let rendered = context::render(&request, &opts, &mut session.pseudo, budget);
        let mut blocks = vec![];
        if let Some(text) = rendered.context_block {
            blocks.push(UserBlock::Text {
                text,
                cache: earlier_messages == 0,
            });
        }
        blocks.push(UserBlock::Text {
            text: format!("{instruction}\n\n{}", rendered.message),
            cache: false,
        });
        session.chat.messages.push(ChatMessage::User(blocks));
        let estimated_input_tokens = chat_tokens(&session.chat);
        if estimated_input_tokens > session.input_limit {
            bail!("assistant request exceeds the context budget");
        }
        let cluster = request
            .scope
            .cluster_id
            .as_deref()
            .map(|id| self.cluster_def(id))
            .transpose()?;
        let preview = AiPreview {
            preview_id: Uuid::new_v4().to_string(),
            session_id: session.id.clone(),
            provider_id: config.id.clone(),
            provider_kind: config.kind,
            model: config.model.clone(),
            local: is_loopback(&config.base_url),
            production: cluster
                .as_ref()
                .is_some_and(|c| c.environment == Some(ClusterEnvironment::Production)),
            cluster_name: cluster.map(|c| c.name),
            message: rendered.message,
            sections: rendered.sections,
            earlier_messages,
            system_tokens,
            tools: session
                .chat
                .tools
                .iter()
                .map(|t| t.name.to_string())
                .collect(),
            estimated_input_tokens,
            context_window: session.window,
            budget,
            estimated_cost: pricing::cost(
                &AiUsage {
                    input_tokens: estimated_input_tokens as u64,
                    ..Default::default()
                },
                pricing::price_for(&ai.prices, &config.model),
            ),
            placeholders: session.pseudo.restore_map(),
            expires_at: epoch_ms() + PREVIEW_TTL.as_millis() as i64,
        };
        if !data.sessions.contains_key(&session.id) {
            let mut empty = session.clone();
            empty.chat.messages.clear();
            empty.pseudo = Pseudonyms::default();
            data.sessions.insert(session.id.clone(), empty);
        }
        if data.previews.len() >= MAX_PREVIEWS {
            if let Some(id) = data
                .previews
                .iter()
                .min_by_key(|(_, p)| p.expires)
                .map(|(id, _)| id.clone())
            {
                data.previews.remove(&id);
            }
        }
        data.previews.insert(
            preview.preview_id.clone(),
            Prepared {
                preview: preview.clone(),
                session,
                intent: request.intent,
                expires: Instant::now() + PREVIEW_TTL,
            },
        );
        Ok(preview)
    }
    pub fn ai_send<F>(self: &Arc<Self>, preview_id: &str, on_event: F) -> Result<String>
    where
        F: Fn(AiEvent) -> bool + Send + Sync + 'static,
    {
        // Keychain/client construction happens before consuming consent; missing
        // credentials fail synchronously without a network request or lost preview.
        let prepared = {
            let mut data = self.ai.engine.data.lock();
            data.expire();
            data.previews
                .get(preview_id)
                .cloned()
                .ok_or_else(|| anyhow!("assistant preview expired"))?
        };
        let ai = self.ai_check(&prepared.session.provider, &prepared.session.scope)?;
        if ai != prepared.session.settings {
            bail!("assistant settings changed; preview the request again");
        }
        let client = self.ai_client(
            &prepared.session.provider,
            prepared.session.model_info.clone(),
            prepared.session.window,
        )?;
        let run_id = format!("ai:{}", Uuid::new_v4());
        let cancel = CancellationToken::new();
        {
            let mut data = self.ai.engine.data.lock();
            data.expire();
            let session = data
                .sessions
                .get_mut(&prepared.session.id)
                .ok_or_else(|| anyhow!("assistant session expired"))?;
            if session.active.is_some() || session.revision != prepared.session.revision {
                bail!("assistant preview is stale; preview the request again");
            }
            if !data.previews.contains_key(preview_id) {
                bail!("assistant preview expired");
            }
            data.sessions.get_mut(&prepared.session.id).unwrap().active = Some(run_id.clone());
            data.previews
                .retain(|_, p| p.session.id != prepared.session.id);
            data.runs.insert(
                run_id.clone(),
                Running {
                    session_id: prepared.session.id.clone(),
                    cluster_id: prepared.session.scope.cluster_id.clone(),
                    cancel: cancel.clone(),
                },
            );
        }
        let guard = RunGuard::new(
            self.clone(),
            run_id.clone(),
            prepared,
            cancel,
            Arc::new(on_event),
        );
        let cluster_id = guard.session.scope.cluster_id.clone().unwrap_or_default();
        self.ai
            .engine
            .runs
            .spawn(&run_id, &cluster_id, run(guard, client));
        Ok(run_id)
    }
    pub fn ai_tool_decision(
        &self,
        run_id: &str,
        call_id: &str,
        decision: AiToolDecision,
    ) -> Result<()> {
        let sender = self
            .ai
            .engine
            .data
            .lock()
            .pending
            .remove(&(run_id.into(), call_id.into()))
            .ok_or_else(|| anyhow!("assistant tool decision is no longer pending"))?;
        sender
            .send(decision)
            .map_err(|_| anyhow!("assistant run ended"))
    }
    pub fn ai_run_active(&self, run_id: &str) -> bool {
        self.ai.engine.data.lock().runs.contains_key(run_id)
    }
    pub fn ai_cancel(&self, run_id: &str) -> bool {
        let mut data = self.ai.engine.data.lock();
        let Some(run) = data.runs.get(run_id) else {
            return false;
        };
        run.cancel.cancel();
        data.pending.retain(|(run, _), _| run != run_id);
        true
    }
    pub fn ai_session_end(&self, session_id: &str) {
        let mut data = self.ai.engine.data.lock();
        data.sessions.remove(session_id);
        data.previews.retain(|_, p| p.session.id != session_id);
        let runs: Vec<_> = data
            .runs
            .iter()
            .filter(|(_, r)| r.session_id == session_id)
            .map(|(id, r)| {
                r.cancel.cancel();
                id.clone()
            })
            .collect();
        data.pending.retain(|(run, _), _| !runs.contains(run));
    }
    pub(crate) fn ai_stop_cluster(&self, cluster_id: &str) {
        let mut data = self.ai.engine.data.lock();
        data.sessions
            .retain(|_, s| s.scope.cluster_id.as_deref() != Some(cluster_id));
        data.previews
            .retain(|_, p| p.session.scope.cluster_id.as_deref() != Some(cluster_id));
        let runs: Vec<_> = data
            .runs
            .iter()
            .filter(|(_, r)| r.cluster_id.as_deref() == Some(cluster_id))
            .map(|(id, r)| {
                r.cancel.cancel();
                id.clone()
            })
            .collect();
        data.pending.retain(|(run, _), _| !runs.contains(run));
    }
    pub(crate) fn ai_cancel_provider(&self, provider_id: &str) {
        let mut data = self.ai.engine.data.lock();
        let ids: Vec<_> = data
            .runs
            .iter()
            .filter(|(_, r)| {
                data.sessions
                    .get(&r.session_id)
                    .is_some_and(|s| s.provider.id == provider_id)
            })
            .map(|(id, r)| {
                r.cancel.cancel();
                id.clone()
            })
            .collect();
        data.pending.retain(|(id, _), _| !ids.contains(id));
    }
    pub(crate) async fn ai_shutdown(&self) {
        self.ai_stop_all();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !self.ai.engine.runs.is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        self.ai.engine.runs.stop_all();
    }
    pub(crate) fn ai_stop_all(&self) {
        let mut data = self.ai.engine.data.lock();
        for run in data.runs.values() {
            run.cancel.cancel();
        }
        data.pending.clear();
        data.previews.clear();
        data.sessions.clear();
    }
}

/// Conservatively includes protocol framing and raw provider blocks. The
/// estimate is deliberately independent of a provider's tokenizer/network.
fn chat_tokens(chat: &ChatRequest) -> u32 {
    let mut total = estimate_tokens(&chat.system).saturating_add(128);
    for tool in &chat.tools {
        total = total
            .saturating_add(estimate_tokens(tool.name))
            .saturating_add(estimate_tokens(tool.description))
            .saturating_add(estimate_tokens(&tool.schema.to_string()))
            .saturating_add(32);
    }
    for message in &chat.messages {
        total = total.saturating_add(32);
        match message {
            ChatMessage::User(blocks) => {
                for block in blocks {
                    let text = match block {
                        UserBlock::Text { text, .. } => text,
                        UserBlock::ToolResult { content, .. } => content,
                    };
                    total = total
                        .saturating_add(estimate_tokens(text))
                        .saturating_add(16);
                }
            }
            ChatMessage::Assistant(turn) => {
                total = total
                    .saturating_add(estimate_tokens(&turn.raw.to_string()))
                    .saturating_add(estimate_tokens(&turn.text))
            }
        }
    }
    total
}

#[derive(Default)]
struct Progress {
    actual_model: Option<String>,
    cost: f64,
    unknown_cost: bool,
    turns: u32,
    body_bytes: usize,
    usage: AiUsage,
    current_usage: AiUsage,
    response: String,
    bodies: Vec<Value>,
    tools: Vec<AiToolCall>,
    error: Option<String>,
}
struct RunGuard {
    app: Arc<Kubepit>,
    id: String,
    session: Session,
    intent: AiIntent,
    cluster_name: Option<String>,
    cancel: CancellationToken,
    sink: Arc<dyn Fn(AiEvent) -> bool + Send + Sync>,
    progress: Arc<Mutex<Progress>>,
    started: Instant,
    ts: i64,
    stop: AiStop,
    refusal_category: Option<String>,
}
impl RunGuard {
    fn new(
        app: Arc<Kubepit>,
        id: String,
        p: Prepared,
        cancel: CancellationToken,
        sink: Arc<dyn Fn(AiEvent) -> bool + Send + Sync>,
    ) -> Self {
        Self {
            app,
            id,
            session: p.session,
            intent: p.intent,
            cluster_name: p.preview.cluster_name,
            cancel,
            sink,
            progress: Arc::new(Mutex::new(Progress::default())),
            started: Instant::now(),
            ts: epoch_ms(),
            stop: AiStop::Cancelled,
            refusal_category: None,
        }
    }
    fn emit(&self, event: AiEvent) {
        if !(self.sink)(event) {
            self.cancel.cancel();
        }
    }
    fn stream(&self, event: StreamEvent) {
        let event = match event {
            StreamEvent::Text(delta) => {
                let mut p = self.progress.lock();
                if p.response.len() < crate::history::MAX_AI_RESPONSE_BYTES {
                    p.response.push_str(&delta);
                    p.response = tools::cap_text(
                        std::mem::take(&mut p.response),
                        crate::history::MAX_AI_RESPONSE_BYTES,
                    );
                }
                AiEvent::Text { delta }
            }
            StreamEvent::Thinking => AiEvent::Thinking,
            StreamEvent::Usage(usage) => {
                let mut p = self.progress.lock();
                p.current_usage = usage;
                let mut total = p.usage;
                total.add(&usage);
                AiEvent::Usage { usage: total }
            }
            StreamEvent::Fallback { from, to } => {
                self.progress.lock().actual_model = Some(to.clone());
                AiEvent::Fallback {
                    from_model: from,
                    to_model: to,
                }
            }
            StreamEvent::Retrying {
                attempt,
                delay_ms,
                reason,
            } => AiEvent::Retrying {
                attempt,
                delay_ms,
                reason,
            },
        };
        self.emit(event);
    }
    fn fail(&mut self, message: String, retryable: bool) {
        self.progress.lock().error = Some(message.clone());
        self.stop = AiStop::Error;
        self.emit(AiEvent::Error { message, retryable });
    }
    fn valid(&self) -> Result<()> {
        let settings = self
            .app
            .ai_check(&self.session.provider, &self.session.scope)?;
        if settings != self.session.settings {
            bail!("assistant settings changed; preview the request again");
        }
        Ok(())
    }
}
impl Drop for RunGuard {
    fn drop(&mut self) {
        if self.cancel.is_cancelled() {
            self.stop = AiStop::Cancelled;
        }
        let p = self.progress.lock();
        let mut usage = p.usage;
        usage.add(&p.current_usage);
        let actual_model = p
            .actual_model
            .as_deref()
            .unwrap_or(&self.session.provider.model);
        let has_partial = p.current_usage != AiUsage::default() || p.turns == 0;
        let partial_cost = if has_partial {
            pricing::cost(
                &p.current_usage,
                pricing::price_for(&self.session.settings.prices, actual_model),
            )
        } else {
            Some(0.0)
        };
        let cost = if p.unknown_cost {
            None
        } else {
            partial_cost.map(|c| c + p.cost)
        };
        let placeholders = self.session.pseudo.restore_map();
        {
            let mut data = self.app.ai.engine.data.lock();
            data.runs.remove(&self.id);
            data.pending.retain(|(id, _), _| id != &self.id);
            if let Some(saved) = data.sessions.get_mut(&self.session.id) {
                if saved.active.as_deref() == Some(&self.id) {
                    if matches!(self.stop, AiStop::End | AiStop::MaxTokens | AiStop::Refusal) {
                        *saved = self.session.clone();
                        saved.revision += 1;
                    }
                    saved.pseudo = self.session.pseudo.clone();
                    saved.approved = self.session.approved;
                    saved.active = None;
                    saved.touched = Instant::now();
                }
            }
        }
        self.app.ai_log_record(AiLogRecord {
            ts: self.ts,
            cluster_id: self.session.scope.cluster_id.clone(),
            cluster_name: self.cluster_name.clone(),
            provider_id: self.session.provider.id.clone(),
            model: actual_model.to_string(),
            intent: self.intent,
            outcome: match self.stop {
                AiStop::Cancelled => AiLogOutcome::Cancelled,
                AiStop::Error => AiLogOutcome::Error,
                AiStop::Refusal => AiLogOutcome::Refused,
                _ => AiLogOutcome::Ok,
            },
            error: p.error.clone(),
            duration_ms: self.started.elapsed().as_millis().min(i64::MAX as u128) as i64,
            usage,
            cost,
            tool_calls: p.tools.len() as u32,
            request: serde_json::to_string(&p.bodies).unwrap_or_default(),
            response: p.response.clone(),
            tools: serde_json::to_value(&p.tools).unwrap_or(Value::Null),
        });
        (self.sink)(AiEvent::Done {
            stop: self.stop,
            usage,
            cost,
            placeholders,
            refusal_category: self.refusal_category.clone(),
        });
    }
}

async fn run(mut guard: RunGuard, client: Client) {
    guard.emit(AiEvent::Started {
        run_id: guard.id.clone(),
        model: guard.session.provider.model.clone(),
    });
    let app = guard.app.clone();
    let scope = guard.session.scope.clone();
    let config = guard.session.provider.clone();
    let settings = guard.session.settings.clone();
    let progress = guard.progress.clone();
    let client = client.with_hook(Arc::new(move |body, cancel| {
        let (app, scope, config, settings, progress) = (app.clone(), scope.clone(), config.clone(), settings.clone(), progress.clone());
        Box::pin(async move {
            while let Some(wait) = app.ai.engine.rate.acquire(Instant::now()) {
                tokio::select! { biased; _ = cancel.cancelled() => return Err(super::provider::ProviderError::cancelled()), _ = tokio::time::sleep(wait) => {} }
            }
            if cancel.is_cancelled() { return Err(super::provider::ProviderError::cancelled()); }
            let current = app.ai_check(&config, &scope).map_err(|e| super::provider::ProviderError::new(ProviderErrorKind::EgressRefused, e.to_string()))?;
            if current != settings { return Err(super::provider::ProviderError::new(ProviderErrorKind::EgressRefused, "assistant settings changed")); }
            let bytes = body.to_string();
            let mut p = progress.lock();
            let remaining = crate::history::MAX_AI_REQUEST_BYTES.saturating_sub(p.body_bytes);
            if bytes.len() <= remaining { p.body_bytes += bytes.len(); p.bodies.push(body); }
            else if remaining > 128 {
                let prefix = tools::cap_text(bytes, remaining.saturating_sub(128));
                p.bodies.push(json!({"truncated":true,"body_prefix":prefix}));
                p.body_bytes = crate::history::MAX_AI_REQUEST_BYTES;
            }
            Ok(())
        })
    }));
    let mut rounds = 0;
    loop {
        if guard.cancel.is_cancelled() {
            return;
        }
        if let Err(e) = guard.valid() {
            guard.fail(e.to_string(), false);
            return;
        }
        if chat_tokens(&guard.session.chat) > guard.session.input_limit {
            guard.fail(
                "assistant conversation exceeds the context budget".into(),
                false,
            );
            return;
        }
        if guard.cancel.is_cancelled() {
            return;
        }
        client.provider().set_egress(Egress {
            remote_allowed: guard.app.ai_remote_allowed(),
            local_only: guard.app.settings().ai.local_only,
        });
        let result = client
            .provider()
            .chat(
                &guard.session.chat,
                &|event| guard.stream(event),
                &guard.cancel,
            )
            .await;
        let turn = match result {
            Ok(turn) => turn,
            Err(e) => {
                if e.kind != ProviderErrorKind::Cancelled && !guard.cancel.is_cancelled() {
                    guard.fail(e.message.clone(), e.retryable());
                }
                return;
            }
        };
        {
            let mut p = guard.progress.lock();
            p.usage.add(&turn.usage);
            p.current_usage = AiUsage::default();
            p.actual_model = Some(turn.model.clone());
            p.turns += 1;
            if let Some(c) = pricing::cost(
                &turn.usage,
                pricing::price_for(&guard.session.settings.prices, &turn.model),
            ) {
                p.cost += c;
            } else {
                p.unknown_cost = true;
            }
        }
        if guard.cancel.is_cancelled() {
            return;
        }
        let stop = turn.stop.clone();
        let calls = turn.tool_calls.clone();
        guard
            .session
            .chat
            .messages
            .push(ChatMessage::Assistant(turn));
        match stop {
            StopReason::EndTurn => {
                guard.stop = AiStop::End;
                return;
            }
            StopReason::MaxTokens => {
                guard.stop = AiStop::MaxTokens;
                return;
            }
            StopReason::Refusal { category } => {
                guard.stop = AiStop::Refusal;
                guard.refusal_category = category;
                return;
            }
            StopReason::ToolUse => {}
        }
        if rounds >= MAX_TOOL_ROUNDS || calls.len() > MAX_TOOL_CALLS_PER_ROUND {
            guard.stop = AiStop::ToolLimit;
            return;
        }
        rounds += 1;
        let mut ids = std::collections::HashSet::new();
        if calls.is_empty() || calls.iter().any(|c| !ids.insert(&c.id)) {
            guard.fail(
                "provider returned empty or duplicate tool calls".into(),
                true,
            );
            return;
        }
        let mut results = vec![];
        for call in calls {
            if guard.cancel.is_cancelled() {
                return;
            }
            if let Err(e) = guard.valid() {
                guard.fail(e.to_string(), false);
                return;
            }
            let input = call
                .input
                .clone()
                .unwrap_or_else(|raw| json!({"INVALID_JSON": raw}));
            let mut card = AiToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                input,
                status: AiToolStatus::Running,
                result_preview: None,
            };
            guard.emit(AiEvent::ToolCall { call: card.clone() });
            let parsed = if guard.session.chat.tools.iter().any(|t| t.name == call.name) {
                call.input
                    .as_ref()
                    .map_err(|raw| format!("invalid tool JSON: {raw}"))
                    .and_then(|v| tools::parse_input(&call.name, v))
            } else {
                Err("the tool is not available in this session".into())
            };
            let output = match (parsed, guard.session.scope.cluster_id.as_ref()) {
                (Ok(input), Some(cluster_id)) => {
                    let cluster = ReadOnlyCluster::new(guard.app.clone(), cluster_id.clone());
                    tokio::select! { biased; _ = guard.cancel.cancelled() => return, result = cluster.execute(&input) => result }
                }
                (Err(error), _) => ToolOutput {
                    text: error,
                    is_error: true,
                    format: AiSectionFormat::Text,
                },
                (_, None) => ToolOutput {
                    text: "no cluster is scoped to this session".into(),
                    is_error: true,
                    format: AiSectionFormat::Text,
                },
            };
            let opts = RedactOptions::from(&guard.session.settings.redaction);
            let (text, redactions) = match output.format {
                AiSectionFormat::Yaml | AiSectionFormat::Json => {
                    redact_manifest_text(&output.text, &opts, &mut guard.session.pseudo)
                }
                _ => redact_text(&output.text, &opts, &mut guard.session.pseudo),
            };
            let mut text = tools::cap_text(text, tools::MAX_TOOL_RESULT_BYTES);
            let mut is_error = output.is_error;
            let mut status = if is_error {
                AiToolStatus::Error
            } else {
                AiToolStatus::Done
            };
            // Even error text may contain cluster data; every result uses consent.
            if guard.session.settings.tool_policy == AiToolPolicy::Ask && !guard.session.approved {
                let (tx, rx) = oneshot::channel();
                {
                    let mut data = guard.app.ai.engine.data.lock();
                    if guard.cancel.is_cancelled() || !data.sessions.contains_key(&guard.session.id)
                    {
                        return;
                    }
                    data.pending.insert((guard.id.clone(), call.id.clone()), tx);
                }
                card.status = AiToolStatus::PendingApproval;
                card.result_preview = Some(text.clone());
                guard.emit(AiEvent::ToolCall { call: card.clone() });
                let decision = tokio::select! { biased; _ = guard.cancel.cancelled() => return, decision = rx => decision.unwrap_or(AiToolDecision::Deny) };
                match decision {
                    AiToolDecision::Deny => {
                        text = "The user declined to share this result.".into();
                        is_error = true;
                        status = AiToolStatus::Denied;
                    }
                    AiToolDecision::SendSession => guard.session.approved = true,
                    AiToolDecision::Send => {}
                }
            }
            if guard.cancel.is_cancelled() {
                return;
            }
            card.status = status;
            card.result_preview = None;
            guard.progress.lock().tools.push(card);
            guard.emit(AiEvent::ToolResult {
                call_id: call.id.clone(),
                status,
                tokens: estimate_tokens(&text),
                redactions,
            });
            results.push(UserBlock::ToolResult {
                call_id: call.id,
                content: text,
                is_error,
            });
        }
        guard.session.chat.messages.push(ChatMessage::User(results));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rate_limiter_spaces_requests_without_reserving_waiters() {
        let limiter = RateLimiter::new(30, Duration::from_secs(60));
        let t = Instant::now();
        for _ in 0..30 {
            assert!(limiter.acquire(t).is_none());
        }
        assert_eq!(limiter.acquire(t), Some(Duration::from_secs(60)));
        assert_eq!(
            limiter.acquire(t + Duration::from_secs(10)),
            Some(Duration::from_secs(50))
        );
        assert!(limiter.acquire(t + Duration::from_secs(60)).is_none());
    }
}
