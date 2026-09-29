//! Serde contract types of the assistant, mirrored in the "Assistant"
//! section of `apps/desktop/src/types/index.ts`. Field names are the
//! snake_case names of the TS contract; enum spellings are pinned by the
//! tests at the bottom of this file.
//!
//! The history side (`AiLogRecord`, `AiLogFilter`, …) lives in
//! `history/types.rs` next to the other `history.db` types.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Settings (`Settings.ai`), status, usage
// ---------------------------------------------------------------------------

/// Which HTTP or installed-agent protocol a provider speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiProviderKind {
    /// Anthropic Messages API (`POST /v1/messages`).
    Anthropic,
    /// Any `POST /chat/completions` endpoint (`openai-compatible`).
    OpenaiCompatible,
    /// Ollama's native `POST /api/chat`.
    Ollama,
    /// Installed agents, using their own sign-in and a restricted transport.
    CodexCli,
    ClaudeCli,
    OpencodeCli,
    CursorCli,
}

/// Metadata-only discovery. Finding an executable does not prove it is signed in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiLocalAgent {
    pub kind: AiProviderKind,
    pub name: String,
    pub executable: Option<String>,
    pub source: Option<String>,
    pub available: bool,
    /// The installed tool can be run without bypassing Assistant permissions.
    pub supported: bool,
}

/// Native model metadata, obtained without sending a conversation to the agent.
/// Identifiers and capability values belong to the agent, not Kubepit enums.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiAgentModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub resolved_model: Option<String>,
    pub is_alias: bool,
    pub is_default: bool,
    pub context_window: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub service_tiers: Vec<String>,
    pub default_service_tier: Option<String>,
    pub supports_fast_mode: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiAgentCatalog {
    pub kind: AiProviderKind,
    pub models: Vec<AiAgentModel>,
    /// Only set when the native agent reports a global default.
    pub default_model: Option<String>,
    /// None means the agent did not report account status.
    pub authenticated: Option<bool>,
    pub auth_method: Option<String>,
    pub version: Option<String>,
}

/// Persisted per provider; null leaves the choice to the native agent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AiAgentOptions {
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub fast_mode: bool,
}

impl From<&AiAgentModel> for AiModelInfo {
    fn from(model: &AiAgentModel) -> Self {
        Self {
            id: model.id.clone(),
            display_name: Some(model.name.clone()),
            context_window: model.context_window,
            max_output_tokens: model.max_output_tokens,
            effort: Some(!model.efforts.is_empty()),
            ..Self::default()
        }
    }
}

/// One configured provider. The API key is never part of the settings: it
/// lives in the OS credential store at `ai/<id>` (see `ai/keys.rs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiProviderConfig {
    /// Stable id; HTTP provider ids also identify their keychain entry.
    pub id: String,
    pub kind: AiProviderKind,
    /// Display name.
    #[serde(default)]
    pub name: String,
    /// Without a trailing slash (normalized); empty for installed agents.
    #[serde(default)]
    pub base_url: String,
    /// Model id; empty = not chosen yet (OpenAI-compatible, Ollama).
    /// Installed agents use `default` to let the CLI choose.
    #[serde(default)]
    pub model: String,
    /// Context window in tokens; `None` = from the Models API or a default.
    #[serde(default)]
    pub context_window: Option<u32>,
    /// Output token cap per response.
    #[serde(default)]
    pub max_output_tokens: u32,
}

/// Optional redaction layers. Secret values are always redacted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AiRedactionSettings {
    /// JWTs, bearer tokens, cloud keys, URL credentials → `__TOKEN__`.
    pub tokens: bool,
    /// IP addresses → `__IP_n__` (restorable locally).
    pub ips: bool,
    /// Hostnames → `__HOST_n__` (restorable locally).
    pub hostnames: bool,
}

impl Default for AiRedactionSettings {
    fn default() -> Self {
        Self {
            tokens: true,
            ips: false,
            hostnames: false,
        }
    }
}

/// Whether read-only tool results may leave the machine.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiToolPolicy {
    /// No tools are offered to the model.
    Off,
    /// Every tool result waits for the user's "Send".
    #[default]
    Ask,
    /// Results are sent without asking (for the whole session).
    Session,
}

/// Anthropic `output_config.effort`; sent only when the model supports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// The user's price for one model, in currency units per million tokens.
/// Prices are never built in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiPrice {
    pub model: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    /// `None` = the input price.
    #[serde(default)]
    pub cache_write_per_mtok: Option<f64>,
    /// `None` = the input price.
    #[serde(default)]
    pub cache_read_per_mtok: Option<f64>,
}

/// `Settings.ai`. Defaults and normalization live in `ai/settings.rs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AiSettings {
    /// Master switch; off by default.
    pub enabled: bool,
    /// Refuse every non-loopback provider in the backend.
    pub local_only: bool,
    /// Preferred answer language; `None` follows the application language.
    pub response_language: Option<AiLocale>,
    /// Id of the provider requests go to.
    pub active_provider: Option<String>,
    pub providers: Vec<AiProviderConfig>,
    /// Clusters the assistant may be used with. Read-only in `settings_set`;
    /// changed by `ai_cluster_set`, pruned on `cluster_remove`.
    pub clusters: Vec<String>,
    /// The production clusters of `clusters` that were enabled with the
    /// typed acknowledgement while they were production. Backend-owned like
    /// `clusters`: a production cluster missing here is not enabled.
    #[serde(default)]
    pub production_acknowledged: Vec<String>,
    pub redaction: AiRedactionSettings,
    pub tool_policy: AiToolPolicy,
    /// Keep every request in the local `ai_log` of `history.db`.
    pub log_requests: bool,
    /// Context budget in tokens (2 000–900 000).
    pub max_context_tokens: u32,
    /// `None` = per intent (explain/fix/yaml high, chat medium, others low).
    pub effort: Option<AiEffort>,
    /// Native reasoning variants and speed options, keyed by provider id.
    pub agent_options: BTreeMap<String, AiAgentOptions>,
    pub prices: Vec<AiPrice>,
}

/// Token usage of one response or a whole run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl AiUsage {
    pub fn add(&mut self, other: &AiUsage) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
    }
}

/// One provider in `ai_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiProviderStatus {
    pub id: String,
    pub kind: AiProviderKind,
    /// The model endpoint is loopback. False for CLIs, which may use the cloud.
    pub local: bool,
    /// A usable API key is stored for it: false when there is none, and
    /// also when the stored key was saved for another origin or provider
    /// kind (`ai/keys.rs`).
    pub has_key: bool,
    /// Why there is no usable key: the credential store could not be read
    /// (locked, missing), or the stored key was saved for another origin or
    /// kind (a `KeyMismatch` message). Never contains the key.
    pub key_error: Option<String>,
    /// Requests may go to it: a valid base URL, loopback or remote egress
    /// on and not local-only; when a key is involved (Anthropic, or a key
    /// is stored) only over `https://` or to a loopback address
    /// (`settings::provider_allowed`).
    pub allowed: bool,
}

/// `ai_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiStatus {
    pub enabled: bool,
    pub local_only: bool,
    /// This process may reach remote providers (the desktop app does).
    pub remote_allowed: bool,
    /// Name of the credential store ("macOS Keychain").
    pub keychain: String,
    pub providers: Vec<AiProviderStatus>,
}

/// One model from a provider's model list (`ai_models`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiModelInfo {
    pub id: String,
    pub display_name: Option<String>,
    /// Input context window in tokens (`max_input_tokens`).
    pub context_window: Option<u32>,
    /// Output cap in tokens (`max_tokens`).
    pub max_output_tokens: Option<u32>,
    /// Supports `thinking: {type: "adaptive"}`; `None` = unknown.
    pub adaptive_thinking: Option<bool>,
    /// Supports `output_config.effort`; `None` = unknown.
    pub effort: Option<bool>,
    /// The effort levels the Models API reports as supported
    /// (`capabilities.effort.<level>.supported`); `None` = not reported.
    /// Rust-only (never serialized, so not part of the TS contract): the
    /// Anthropic provider clamps a requested level to these.
    #[serde(skip)]
    pub effort_levels: Option<Vec<AiEffort>>,
}

// ---------------------------------------------------------------------------
// Requests, context sections, redaction counts
// ---------------------------------------------------------------------------

/// What the user asks for; picks the intent instructions and default effort.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiIntent {
    Explain,
    Fix,
    Chat,
    Kubectl,
    Promql,
    Logql,
    ExplainQuery,
    Yaml,
}

/// Answer language, independent of the application's UI locale.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiLocale {
    #[default]
    En,
    Tr,
    De,
    Fr,
    Es,
    It,
    Pt,
    Ru,
    Ar,
    Hi,
    Ja,
    Ko,
    Zh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiSectionKind {
    Scope,
    Object,
    Containers,
    Events,
    Logs,
    Health,
    Changes,
    Alerts,
    Metrics,
    Schema,
    Query,
    Editor,
}

/// How a section's content is redacted and trimmed (`yaml`/`json` as
/// manifests, `log` cut in the middle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiSectionFormat {
    Yaml,
    Json,
    Text,
    Log,
}

/// One piece of context gathered by the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiContextSection {
    /// Unique within the request (`events`, `logs:web-1/app`).
    pub id: String,
    pub kind: AiSectionKind,
    /// Identifier only (`pod/web-1`, `web-1/app@previous`).
    pub label: String,
    /// 0 = kept longest; higher numbers are trimmed first.
    pub priority: u8,
    pub format: AiSectionFormat,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiObjectRef {
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

/// Where the request comes from: cluster, namespace, selection.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiScope {
    pub cluster_id: Option<String>,
    pub namespace: Option<String>,
    pub object: Option<AiObjectRef>,
}

/// `ai_preview` input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiRequest {
    /// `None` starts a new session.
    pub session_id: Option<String>,
    pub intent: AiIntent,
    /// What the user typed.
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub scope: AiScope,
    #[serde(default)]
    pub sections: Vec<AiContextSection>,
    /// Section ids the user excluded in the preview.
    #[serde(default)]
    pub excluded: Vec<String>,
    /// Resolved answer language: the saved preference or the application locale.
    #[serde(default)]
    pub locale: AiLocale,
}

/// How many values each redaction layer replaced.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactionCounts {
    pub secrets: u32,
    pub tokens: u32,
    pub ips: u32,
    pub hostnames: u32,
}

impl RedactionCounts {
    pub fn add(&mut self, other: &Self) {
        self.secrets += other.secrets;
        self.tokens += other.tokens;
        self.ips += other.ips;
        self.hostnames += other.hostnames;
    }
}

/// One section as it will be sent (redacted, budgeted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiPreviewSection {
    pub id: String,
    pub kind: AiSectionKind,
    pub label: String,
    /// The exact text that will be sent.
    pub text: String,
    /// Estimated tokens of `text` (≈).
    pub tokens: u32,
    /// Estimated tokens before trimming.
    pub original_tokens: u32,
    pub trimmed: bool,
    /// Excluded by the user: listed, not sent.
    pub excluded: bool,
    pub redactions: RedactionCounts,
}

// ---------------------------------------------------------------------------
// Preview, runs and events
// ---------------------------------------------------------------------------

/// `ai_preview`: the exact redacted payload, stored under `preview_id` until
/// `ai_send` sends it (single use, `expires_at`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiPreview {
    pub preview_id: String,
    pub session_id: String,
    pub provider_id: String,
    pub provider_kind: AiProviderKind,
    pub model: String,
    /// The provider is on a loopback address.
    pub local: bool,
    /// The scoped cluster is a production cluster.
    pub production: bool,
    pub cluster_name: Option<String>,
    /// The redacted typed message.
    pub message: String,
    pub sections: Vec<AiPreviewSection>,
    /// Messages of this session already sent (not shown again).
    pub earlier_messages: u32,
    pub system_tokens: u32,
    /// Tool names offered to the model (empty under policy `off`).
    pub tools: Vec<String>,
    pub estimated_input_tokens: u32,
    pub context_window: u32,
    pub budget: u32,
    /// From the user's price table; `None` without a price.
    pub estimated_cost: Option<f64>,
    /// `__IP_n__` / `__HOST_n__` → original, for local restore only.
    pub placeholders: BTreeMap<String, String>,
    /// Epoch ms.
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiToolStatus {
    /// Running locally (a read-only GET).
    Running,
    /// Waiting for the user's decision (policy `ask`).
    PendingApproval,
    /// Sent to the model.
    Done,
    /// The user declined to send the result.
    Denied,
    Error,
}

/// The user's answer to a pending tool result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiToolDecision {
    Send,
    /// Send this and every later result of the session.
    SendSession,
    Deny,
}

/// One tool call as shown in the tool card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub status: AiToolStatus,
    /// The redacted result (shown before it is sent under `ask`).
    pub result_preview: Option<String>,
}

/// Why a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiStop {
    End,
    MaxTokens,
    Refusal,
    Cancelled,
    ToolLimit,
    Error,
}

/// Streamed over `ai_send`'s `Channel<AiEvent>`, tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AiEvent {
    Started {
        run_id: String,
        model: String,
    },
    Text {
        delta: String,
    },
    /// The model is thinking (content is not shown).
    Thinking,
    ToolCall {
        call: AiToolCall,
    },
    ToolResult {
        call_id: String,
        status: AiToolStatus,
        tokens: u32,
        redactions: RedactionCounts,
    },
    Retrying {
        attempt: u32,
        delay_ms: u64,
        reason: String,
    },
    /// The provider answered with a fallback model.
    Fallback {
        from_model: String,
        to_model: String,
    },
    Usage {
        usage: AiUsage,
    },
    /// Always the last event of a run.
    Done {
        stop: AiStop,
        usage: AiUsage,
        cost: Option<f64>,
        placeholders: BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refusal_category: Option<String>,
    },
    Error {
        message: String,
        retryable: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wire<T: Serialize>(value: T) -> Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn enums_use_the_contract_spellings() {
        assert_eq!(wire(AiProviderKind::Anthropic), json!("anthropic"));
        assert_eq!(
            wire(AiProviderKind::OpenaiCompatible),
            json!("openai-compatible")
        );
        assert_eq!(wire(AiProviderKind::Ollama), json!("ollama"));
        let policies = [AiToolPolicy::Off, AiToolPolicy::Ask, AiToolPolicy::Session];
        assert_eq!(wire(policies), json!(["off", "ask", "session"]));
        let efforts = [
            AiEffort::Low,
            AiEffort::Medium,
            AiEffort::High,
            AiEffort::Xhigh,
            AiEffort::Max,
        ];
        assert_eq!(
            wire(efforts),
            json!(["low", "medium", "high", "xhigh", "max"])
        );
        let intents = [
            AiIntent::Explain,
            AiIntent::Fix,
            AiIntent::Chat,
            AiIntent::Kubectl,
            AiIntent::Promql,
            AiIntent::Logql,
            AiIntent::ExplainQuery,
            AiIntent::Yaml,
        ];
        assert_eq!(
            wire(intents),
            json!([
                "explain",
                "fix",
                "chat",
                "kubectl",
                "promql",
                "logql",
                "explain-query",
                "yaml"
            ])
        );
        let locales = [
            AiLocale::En,
            AiLocale::Tr,
            AiLocale::De,
            AiLocale::Fr,
            AiLocale::Es,
            AiLocale::It,
            AiLocale::Pt,
            AiLocale::Ru,
            AiLocale::Ar,
            AiLocale::Hi,
            AiLocale::Ja,
            AiLocale::Ko,
            AiLocale::Zh,
        ];
        let locale_codes =
            json!(["en", "tr", "de", "fr", "es", "it", "pt", "ru", "ar", "hi", "ja", "ko", "zh"]);
        assert_eq!(wire(locales), locale_codes);
        assert_eq!(
            serde_json::from_value::<Vec<AiLocale>>(locale_codes).unwrap(),
            locales
        );
        let kinds = [
            AiSectionKind::Scope,
            AiSectionKind::Object,
            AiSectionKind::Containers,
            AiSectionKind::Events,
            AiSectionKind::Logs,
            AiSectionKind::Health,
            AiSectionKind::Changes,
            AiSectionKind::Alerts,
            AiSectionKind::Metrics,
            AiSectionKind::Schema,
            AiSectionKind::Query,
            AiSectionKind::Editor,
        ];
        assert_eq!(
            wire(kinds),
            json!([
                "scope",
                "object",
                "containers",
                "events",
                "logs",
                "health",
                "changes",
                "alerts",
                "metrics",
                "schema",
                "query",
                "editor"
            ])
        );
        let formats = [
            AiSectionFormat::Yaml,
            AiSectionFormat::Json,
            AiSectionFormat::Text,
            AiSectionFormat::Log,
        ];
        assert_eq!(wire(formats), json!(["yaml", "json", "text", "log"]));
        let statuses = [
            AiToolStatus::Running,
            AiToolStatus::PendingApproval,
            AiToolStatus::Done,
            AiToolStatus::Denied,
            AiToolStatus::Error,
        ];
        assert_eq!(
            wire(statuses),
            json!(["running", "pending-approval", "done", "denied", "error"])
        );
        let decisions = [
            AiToolDecision::Send,
            AiToolDecision::SendSession,
            AiToolDecision::Deny,
        ];
        assert_eq!(wire(decisions), json!(["send", "send-session", "deny"]));
        let stops = [
            AiStop::End,
            AiStop::MaxTokens,
            AiStop::Refusal,
            AiStop::Cancelled,
            AiStop::ToolLimit,
            AiStop::Error,
        ];
        assert_eq!(
            wire(stops),
            json!([
                "end",
                "max-tokens",
                "refusal",
                "cancelled",
                "tool-limit",
                "error"
            ])
        );
    }

    #[test]
    fn events_are_tagged_by_type_with_snake_case_fields() {
        let done = AiEvent::Done {
            stop: AiStop::MaxTokens,
            refusal_category: None,
            usage: AiUsage {
                input_tokens: 10,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
            },
            cost: Some(0.5),
            placeholders: BTreeMap::from([("__IP_1__".to_string(), "10.0.0.1".to_string())]),
        };
        assert_eq!(
            wire(&done),
            json!({
                "type": "done",
                "stop": "max-tokens",
                "usage": {"input_tokens": 10, "output_tokens": 2, "cache_read_tokens": 3, "cache_write_tokens": 4},
                "cost": 0.5,
                "placeholders": {"__IP_1__": "10.0.0.1"},
            })
        );
        let call = AiEvent::ToolCall {
            call: AiToolCall {
                id: "c1".into(),
                name: "get_events".into(),
                input: json!({"namespace": "shop"}),
                status: AiToolStatus::PendingApproval,
                result_preview: None,
            },
        };
        assert_eq!(
            wire(&call),
            json!({
                "type": "tool-call",
                "call": {
                    "id": "c1",
                    "name": "get_events",
                    "input": {"namespace": "shop"},
                    "status": "pending-approval",
                    "result_preview": null,
                },
            })
        );
        let result = AiEvent::ToolResult {
            call_id: "c1".into(),
            status: AiToolStatus::Done,
            tokens: 12,
            redactions: RedactionCounts::default(),
        };
        assert_eq!(wire(&result)["type"], "tool-result");
        assert_eq!(wire(&result)["call_id"], "c1");
        assert_eq!(wire(AiEvent::Thinking), json!({"type": "thinking"}));
        let fallback = AiEvent::Fallback {
            from_model: "a".into(),
            to_model: "b".into(),
        };
        assert_eq!(
            wire(&fallback),
            json!({"type": "fallback", "from_model": "a", "to_model": "b"})
        );
        // Round trip.
        let back: AiEvent = serde_json::from_value(wire(&done)).unwrap();
        assert_eq!(back, done);
    }

    #[test]
    fn usage_and_redaction_counts_add_up() {
        let mut u = AiUsage {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
        };
        let same = u;
        u.add(&same);
        assert_eq!(
            u,
            AiUsage {
                input_tokens: 2,
                output_tokens: 4,
                cache_read_tokens: 6,
                cache_write_tokens: 8,
            }
        );
        let mut c = RedactionCounts {
            secrets: 1,
            tokens: 0,
            ips: 2,
            hostnames: 0,
        };
        c.add(&RedactionCounts {
            secrets: 1,
            tokens: 1,
            ips: 0,
            hostnames: 3,
        });
        assert_eq!(
            c,
            RedactionCounts {
                secrets: 2,
                tokens: 1,
                ips: 2,
                hostnames: 3,
            }
        );
    }

    #[test]
    fn requests_tolerate_missing_optional_fields() {
        let req: AiRequest =
            serde_json::from_value(json!({"session_id": null, "intent": "explain-query"})).unwrap();
        assert_eq!(req.intent, AiIntent::ExplainQuery);
        assert_eq!(req.locale, AiLocale::En);
        assert!(req.sections.is_empty() && req.excluded.is_empty());
        assert_eq!(req.scope, AiScope::default());
    }
}
