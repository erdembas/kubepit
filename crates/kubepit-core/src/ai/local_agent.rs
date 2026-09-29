//! Local CLI transports. The executable owns native accounts; selected provider
//! settings reach only its child environment and are never logged or persisted.
//! These are remote providers despite their local
//! executable. Only the consented, already-redacted conversation goes to stdin.

mod claude;
mod codex;
mod config;
mod process;
#[cfg(test)]
mod tests;

use futures::future::BoxFuture;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::local_discovery::{resolve, ResolvedExecutable};
use super::provider::{
    AiTimeouts, AssistantTurn, ChatMessage, ChatRequest, Egress, EventSink, Provider,
    ProviderError, ProviderErrorKind, RequestHook, StopReason, StreamEvent, UserBlock,
    MAX_RESPONSE_BYTES,
};
use super::types::{AiAgentCatalog, AiAgentOptions, AiModelInfo, AiProviderKind, AiUsage};

pub struct LocalAgentProvider {
    kind: AiProviderKind,
    timeouts: AiTimeouts,
    egress: parking_lot::Mutex<Egress>,
    request_hook: Option<RequestHook>,
    options: AiAgentOptions,
    #[cfg(test)]
    executable: Option<ResolvedExecutable>,
}

impl LocalAgentProvider {
    pub fn new(
        kind: AiProviderKind,
        timeouts: AiTimeouts,
        egress: Egress,
    ) -> Result<Self, ProviderError> {
        if !matches!(kind, AiProviderKind::CodexCli | AiProviderKind::ClaudeCli) {
            return Err(ProviderError::new(
                ProviderErrorKind::BadRequest,
                "this local agent protocol is not supported",
            ));
        }
        Ok(Self {
            kind,
            timeouts,
            egress: parking_lot::Mutex::new(egress),
            request_hook: None,
            options: AiAgentOptions::default(),
            #[cfg(test)]
            executable: None,
        })
    }

    pub fn with_request_hook(mut self, hook: RequestHook) -> Self {
        self.request_hook = Some(hook);
        self
    }

    pub fn with_options(mut self, options: AiAgentOptions) -> Self {
        self.options = options;
        self
    }

    pub async fn catalog(
        &self,
        cancel: CancellationToken,
    ) -> Result<AiAgentCatalog, ProviderError> {
        self.check_egress()?;
        if cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        let executable = self.executable()?;
        match self.kind {
            AiProviderKind::ClaudeCli => claude::catalog(&executable, self.timeouts, &cancel).await,
            AiProviderKind::CodexCli => codex::catalog(&executable, self.timeouts, &cancel).await,
            _ => unreachable!(),
        }
    }

    fn check_egress(&self) -> Result<(), ProviderError> {
        let egress = *self.egress.lock();
        if !egress.remote_allowed || egress.local_only {
            return Err(ProviderError::new(
                ProviderErrorKind::EgressRefused,
                "local agent CLIs contact remote providers; remote access must be enabled and local-only mode must be off",
            ));
        }
        Ok(())
    }

    fn executable(&self) -> Result<ResolvedExecutable, ProviderError> {
        #[cfg(test)]
        if let Some(executable) = &self.executable {
            return Ok(ResolvedExecutable {
                path: executable.path.clone(),
                command_path: executable.command_path.clone(),
            });
        }
        resolve(self.kind).ok_or_else(|| {
            ProviderError::new(
                ProviderErrorKind::NotFound,
                "the local agent executable was not found; install it and sign in using its CLI",
            )
        })
    }
}

impl Provider for LocalAgentProvider {
    fn kind(&self) -> AiProviderKind {
        self.kind
    }

    fn is_local(&self) -> bool {
        false
    }

    fn set_egress(&self, egress: Egress) {
        *self.egress.lock() = egress;
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<AiModelInfo>, ProviderError>> {
        Box::pin(async move {
            let catalog = self.catalog(CancellationToken::new()).await?;
            Ok(catalog.models.iter().map(AiModelInfo::from).collect())
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
            if cancel.is_cancelled() {
                return Err(ProviderError::cancelled());
            }
            let prompt = prompt(req)?;
            let executable = self.executable()?;
            // A rejected consent/rate-limit gate cannot even launch the agent.
            if let Some(hook) = &self.request_hook {
                let record = json!({
                    "transport": "local-cli", "provider": self.kind,
                    "model": req.model, "stdin": prompt,
                    "instructions": INSTRUCTIONS,
                    "options": self.options,
                    "max_output_tokens": req.max_tokens,
                });
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(ProviderError::cancelled()),
                    result = tokio::time::timeout(self.timeouts.total, hook(record, cancel.clone())) => {
                        result.map_err(|_| timeout())??;
                    }
                }
            }
            self.check_egress()?;
            if cancel.is_cancelled() {
                return Err(ProviderError::cancelled());
            }
            match self.kind {
                AiProviderKind::ClaudeCli => {
                    claude::chat(
                        &executable,
                        req,
                        &self.options,
                        &prompt,
                        self.timeouts,
                        on_event,
                        cancel,
                    )
                    .await
                }
                AiProviderKind::CodexCli => {
                    codex::chat(
                        &executable,
                        req,
                        &self.options,
                        &prompt,
                        self.timeouts,
                        on_event,
                        cancel,
                    )
                    .await
                }
                _ => unreachable!(),
            }
        })
    }
}

/// Lossless role-labelled history. No local tools are exposed to these agents;
/// this validation also prevents accidental future tool-policy regressions.
fn prompt(req: &ChatRequest) -> Result<String, ProviderError> {
    if !req.tools.is_empty() {
        return Err(ProviderError::new(
            ProviderErrorKind::BadRequest,
            "local agents accept explicit conversation context only; tools must be disabled",
        ));
    }
    let mut messages = Vec::new();
    for message in &req.messages {
        match message {
            ChatMessage::User(blocks) => {
                let mut content = Vec::new();
                for block in blocks {
                    match block {
                        UserBlock::Text { text, .. } => content.push(text.clone()),
                        UserBlock::ToolResult { .. } => {
                            return Err(protocol("local agents cannot accept tool results"))
                        }
                    }
                }
                messages.push(json!({"role": "user", "content": content}));
            }
            ChatMessage::Assistant(turn) => {
                if !turn.tool_calls.is_empty() {
                    return Err(protocol("local agents cannot accept tool calls"));
                }
                messages.push(json!({"role": "assistant", "content": turn.text}));
            }
        }
    }
    let prompt = json!({"system": req.system, "messages": messages}).to_string();
    if prompt.len() > MAX_RESPONSE_BYTES {
        return Err(ProviderError::new(
            ProviderErrorKind::BadRequest,
            "the local agent prompt is too large",
        ));
    }
    Ok(prompt)
}

const INSTRUCTIONS: &str = "You are the Kubepit Kubernetes assistant. Your input is a JSON object containing system instructions and a role-labelled conversation. Follow its system instructions and answer the final user message using only the supplied context. Do not access files, run commands, use tools, or retrieve additional context. Return the answer text directly.";

fn validate_options(
    catalog: &AiAgentCatalog,
    req: &ChatRequest,
    options: &AiAgentOptions,
) -> Result<(), ProviderError> {
    // Exact custom IDs are valid inputs even when the agent's picker omits
    // them. Native availability is checked during the request. Capabilities,
    // however, must be advertised before Kubepit can safely apply overrides.
    if options == &AiAgentOptions::default() {
        return Ok(());
    }
    let model = catalog.model(&req.model).ok_or_else(|| {
        ProviderError::new(
            ProviderErrorKind::BadRequest,
            "the selected model is not in the local agent catalog; refresh the model list",
        )
    })?;
    if options
        .effort
        .as_ref()
        .is_some_and(|effort| !model.efforts.contains(effort))
    {
        return Err(ProviderError::new(
            ProviderErrorKind::BadRequest,
            "the selected reasoning effort is not supported by this local agent model",
        ));
    }
    if options
        .service_tier
        .as_ref()
        .is_some_and(|tier| !model.service_tiers.contains(tier))
    {
        return Err(ProviderError::new(
            ProviderErrorKind::BadRequest,
            "the selected service tier is not supported by this local agent model",
        ));
    }
    if options.fast_mode && !model.supports_fast_mode {
        return Err(ProviderError::new(
            ProviderErrorKind::BadRequest,
            "fast mode is not available for this local agent model",
        ));
    }
    Ok(())
}

fn protocol(message: &str) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Protocol, message)
}

fn metadata_u32(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn timeout() -> ProviderError {
    ProviderError::new(ProviderErrorKind::Timeout, "the local agent timed out")
}

struct Answer {
    turn: AssistantTurn,
    started: bool,
    // Hard character bound as CLIs do not all expose a generated-token limit.
    // Four Unicode scalars per requested token is only an approximate fallback;
    // the byte cap is independent, and Claude also receives its native limit.
    chars: usize,
    max_chars: usize,
}

impl Answer {
    fn new(req: &ChatRequest) -> Self {
        Self {
            turn: AssistantTurn {
                raw: Value::Null,
                text: String::new(),
                tool_calls: Vec::new(),
                stop: StopReason::EndTurn,
                usage: AiUsage::default(),
                model: req.model.clone(),
            },
            started: false,
            chars: 0,
            max_chars: (req.max_tokens as usize).saturating_mul(4).max(1),
        }
    }

    /// `true` requests an immediate process stop after reaching the output cap.
    fn text(&mut self, text: &str, sink: EventSink<'_>) -> Result<bool, ProviderError> {
        if self.turn.text.len().saturating_add(text.len()) > MAX_RESPONSE_BYTES {
            return Err(protocol(
                "the local agent response exceeded the output limit",
            ));
        }
        let remaining = self.max_chars.saturating_sub(self.chars);
        let count = text.chars().count();
        let bounded = if count > remaining {
            text.chars().take(remaining).collect::<String>()
        } else {
            text.to_owned()
        };
        if !bounded.is_empty() {
            self.started = true;
            self.chars += count.min(remaining);
            self.turn.text.push_str(&bounded);
            sink(StreamEvent::Text(bounded));
        }
        if count >= remaining {
            self.turn.stop = StopReason::MaxTokens;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn thinking(&mut self, sink: EventSink<'_>) {
        self.started = true;
        sink(StreamEvent::Thinking);
    }

    fn failure(&self, error: ProviderError) -> ProviderError {
        if self.started {
            error.with_partial(self.turn.clone())
        } else {
            error
        }
    }
}
