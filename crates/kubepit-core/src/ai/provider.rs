//! The provider abstraction (`Provider` trait, chat types, errors, retries,
//! timeouts, egress guard) — filled in by the providers task. The
//! foundation only fixes [`ToolSpec`], which the tool catalog (`tools.rs`)
//! and every provider share.

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
