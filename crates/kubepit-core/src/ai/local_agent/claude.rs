use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::super::local_discovery::ResolvedExecutable;
use super::super::provider::{
    AiTimeouts, AssistantTurn, ChatRequest, EventSink, ProviderError, ProviderErrorKind,
    StopReason, StreamEvent,
};
use super::super::types::{AiAgentCatalog, AiAgentModel, AiAgentOptions, AiProviderKind, AiUsage};
use super::process::{controlled_command, Process, Scratch};
use super::{protocol, Answer, INSTRUCTIONS};

pub(super) async fn chat(
    executable: &ResolvedExecutable,
    req: &ChatRequest,
    options: &AiAgentOptions,
    prompt: &str,
    timeouts: AiTimeouts,
    sink: EventSink<'_>,
    cancel: &CancellationToken,
) -> Result<AssistantTurn, ProviderError> {
    let scratch = Scratch::new()?;
    let mut command = command(executable, scratch.path(), options.fast_mode)?;
    if !req.model.is_empty() && req.model != "default" {
        command.arg("--model").arg(&req.model);
    }
    if let Some(effort) = &options.effort {
        command.arg("--effort").arg(effort);
    }
    command.env("CLAUDE_CODE_MAX_OUTPUT_TOKENS", req.max_tokens.to_string());
    let mut process = Process::spawn(command, timeouts, req.max_tokens)?;
    let catalog = parse_catalog(&initialize(&mut process, cancel).await?)?;
    super::validate_options(&catalog, req, options)?;
    process
        .send(
            json!({
                "type": "user", "message": {"role": "user", "content": prompt},
                "parent_tool_use_id": null, "session_id": "",
            }),
            cancel,
        )
        .await?;
    process.close_input();
    let mut answer = Answer::new(req);
    let result = receive(&mut process, &mut answer, sink, cancel).await;
    result.map_err(|error| answer.failure(error))?;
    Ok(answer.turn)
}

fn command(
    executable: &ResolvedExecutable,
    cwd: &std::path::Path,
    fast_mode: bool,
) -> Result<tokio::process::Command, ProviderError> {
    let mut command = controlled_command(executable, cwd);
    // Unit transport fixtures do not load workstation settings or credentials.
    let mut settings = if cfg!(test) {
        json!({})
    } else {
        super::config::claude(&mut command)?
    };
    command
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_HOME");
    command.args([
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--no-chrome",
        "--permission-mode",
        "dontAsk",
        "--system-prompt",
        INSTRUCTIONS,
    ]);
    let isolation = json!({
        "disableAllHooks": true, "enabledPlugins": {}, "autoMemoryEnabled": false,
        // This is a process-only override. Per-session opt-in would reset
        // fastMode on startup and silently ignore the user's selection.
        "fastMode": fast_mode, "fastModePerSessionOptIn": false,
    });
    settings
        .as_object_mut()
        .expect("projected object")
        .extend(isolation.as_object().expect("isolation object").clone());
    command.arg("--settings").arg(settings.to_string());
    command
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env("DISABLE_AUTOUPDATER", "1")
        .env("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1")
        .env("CLAUDE_CODE_DISABLE_ATTACHMENTS", "1")
        .env("CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS", "1")
        .env("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1")
        .env("CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL", "1")
        .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
    Ok(command)
}

/// The same metadata-only initialize control request used by the native SDK's
/// supportedModels(). Stdin stays open, and no user message is ever submitted.
pub(super) async fn catalog(
    executable: &ResolvedExecutable,
    timeouts: AiTimeouts,
    cancel: &CancellationToken,
) -> Result<AiAgentCatalog, ProviderError> {
    let scratch = Scratch::new()?;
    let command = command(executable, scratch.path(), false)?;
    let mut process = Process::spawn(command, timeouts, 0)?;
    parse_catalog(&initialize(&mut process, cancel).await?)
}

async fn initialize(
    process: &mut Process,
    cancel: &CancellationToken,
) -> Result<Value, ProviderError> {
    process
        .send(
            json!({
                "type": "control_request", "request_id": "kubepit-catalog",
                "request": {"subtype": "initialize", "hooks": {}, "sdkMcpServers": [],
                    "skills": [], "agents": {}, "promptSuggestions": false},
            }),
            cancel,
        )
        .await?;
    while let Some(value) = process.next(cancel).await? {
        match value["type"].as_str() {
            Some("control_response") if value["response"]["request_id"] == "kubepit-catalog" => {
                if value["response"]["subtype"] != "success" {
                    return Err(agent_error());
                }
                let result = &value["response"]["response"];
                if !result["models"].is_array() {
                    return Err(protocol("Claude did not return its native model catalog"));
                }
                return Ok(result.clone());
            }
            Some("control_request" | "assistant" | "stream_event" | "result") => {
                return Err(protocol("Claude requested unsupported local access"));
            }
            _ => {}
        }
    }
    Err(protocol("Claude did not return its native model catalog"))
}

fn parse_catalog(raw: &Value) -> Result<AiAgentCatalog, ProviderError> {
    let rows = raw["models"]
        .as_array()
        .ok_or_else(|| protocol("Claude did not return its native model catalog"))?;
    if rows.len() > 2000 {
        return Err(protocol("Claude returned an oversized model catalog"));
    }
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let fast_unavailable = raw
        .get("fast_mode_disabled_reason")
        .is_some_and(|reason| !reason.is_null());
    for row in rows {
        let id = row["value"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or_else(|| protocol("Claude did not return its native model catalog"))?;
        if !seen.insert(id.to_string()) {
            continue;
        }
        let resolved_model = row["resolvedModel"].as_str().map(str::to_string);
        let alias = matches!(
            id.split('[').next().unwrap_or(id),
            "default" | "sonnet" | "opus" | "haiku" | "opusplan"
        ) || resolved_model
            .as_deref()
            .is_some_and(|resolved| resolved != id);
        let efforts = if row["supportsEffort"] == false {
            Vec::new()
        } else {
            row["supportedEffortLevels"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        models.push(AiAgentModel {
            id: id.to_string(),
            name: row["displayName"].as_str().unwrap_or(id).to_string(),
            description: row["description"].as_str().map(str::to_string),
            resolved_model,
            is_alias: alias,
            is_default: row["isDefault"].as_bool().unwrap_or(id == "default"),
            context_window: super::metadata_u32(&row["contextWindow"]),
            max_output_tokens: super::metadata_u32(&row["maxOutputTokens"]),
            efforts,
            default_effort: row["defaultEffortLevel"].as_str().map(str::to_string),
            supports_fast_mode: row["supportsFastMode"] == true && !fast_unavailable,
            ..Default::default()
        });
    }
    let account = &raw["account"];
    let source = ["tokenSource", "apiKeySource"]
        .into_iter()
        .filter_map(|field| account[field].as_str())
        .find(|source| !source.is_empty() && *source != "none");
    let authenticated = if source.is_some() {
        Some(true)
    } else if account["tokenSource"] == "none" || account["apiKeySource"] == "none" {
        Some(false)
    } else {
        None
    };
    Ok(AiAgentCatalog {
        kind: AiProviderKind::ClaudeCli,
        default_model: raw["defaultModel"]
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                models
                    .iter()
                    .find(|model| model.is_default)
                    .map(|model| model.id.clone())
            }),
        models,
        authenticated,
        auth_method: source.map(str::to_string),
        version: raw["claude_code_version"].as_str().map(str::to_string),
    })
}

async fn receive(
    process: &mut Process,
    answer: &mut Answer,
    sink: EventSink<'_>,
    cancel: &CancellationToken,
) -> Result<(), ProviderError> {
    let mut initialized = false;
    let mut saw_delta = false;
    let mut result_received = false;
    while let Some(value) = process.next(cancel).await? {
        match value["type"].as_str() {
            Some("system") if value["subtype"] == "init" => {
                // A CLI that ignores the no-tool flags is never allowed to
                // continue. Older binaries reject unsupported flags themselves.
                if !value["tools"].as_array().is_some_and(Vec::is_empty)
                    || value["mcp_servers"]
                        .as_array()
                        .is_some_and(|servers| !servers.is_empty())
                {
                    return Err(protocol(
                        "Claude did not disable its tools and MCP servers; update the CLI",
                    ));
                }
                initialized = true;
                if let Some(model) = value["model"].as_str() {
                    answer.turn.model = model.to_owned();
                }
            }
            Some("stream_event") => {
                if !initialized {
                    return Err(protocol("Claude streamed before confirming tool isolation"));
                }
                let event = &value["event"];
                match event["type"].as_str() {
                    Some("content_block_start") => match event["content_block"]["type"].as_str() {
                        Some("tool_use" | "server_tool_use") => {
                            return Err(protocol("Claude attempted a tool call"))
                        }
                        Some("thinking") => answer.thinking(sink),
                        _ => {}
                    },
                    Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                        let text = event["delta"]["text"]
                            .as_str()
                            .ok_or_else(|| protocol("Claude sent an invalid text event"))?;
                        saw_delta = true;
                        if answer.text(text, sink)? {
                            return Ok(());
                        }
                    }
                    Some("message_start") => {
                        answer.turn.usage = usage(&event["message"]["usage"]);
                    }
                    Some("message_delta") => {
                        if let Some(output) = event["usage"]["output_tokens"].as_u64() {
                            answer.turn.usage.output_tokens = output;
                        }
                        match event["delta"]["stop_reason"].as_str() {
                            Some("max_tokens") => answer.turn.stop = StopReason::MaxTokens,
                            Some("refusal") => {
                                answer.turn.stop = StopReason::Refusal { category: None }
                            }
                            Some("tool_use") => {
                                return Err(protocol("Claude attempted a tool call"))
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            Some("assistant") => {
                if !initialized {
                    return Err(protocol("Claude replied before confirming tool isolation"));
                }
                if value["error"].as_str().is_some() {
                    return Err(agent_error());
                }
                if let Some(blocks) = value["message"]["content"].as_array() {
                    for block in blocks {
                        match block["type"].as_str() {
                            Some("tool_use" | "server_tool_use") => {
                                return Err(protocol("Claude attempted a tool call"))
                            }
                            Some("text") if !saw_delta => {
                                let text = block["text"]
                                    .as_str()
                                    .ok_or_else(|| protocol("Claude sent an invalid text block"))?;
                                if answer.text(text, sink)? {
                                    return Ok(());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if value["message"]["usage"].is_object() {
                    answer.turn.usage = usage(&value["message"]["usage"]);
                }
            }
            Some("result") => {
                if !initialized {
                    return Err(protocol(
                        "Claude completed before confirming tool isolation",
                    ));
                }
                if value["is_error"] == true || value["subtype"].as_str() != Some("success") {
                    return Err(agent_error());
                }
                if answer.turn.text.is_empty() {
                    if let Some(text) = value["result"].as_str() {
                        if answer.text(text, sink)? {
                            return Ok(());
                        }
                    }
                }
                if value["usage"].is_object() {
                    answer.turn.usage = usage(&value["usage"]);
                }
                sink(StreamEvent::Usage(answer.turn.usage));
                result_received = true;
            }
            Some("control_request") => {
                return Err(protocol("Claude requested unsupported local access"))
            }
            _ => {}
        }
        if answer.started {
            process.content_started();
        }
    }
    process.successful_exit(cancel).await?;
    if !result_received {
        return Err(protocol("Claude stopped without a complete result"));
    }
    Ok(())
}

fn usage(value: &Value) -> AiUsage {
    AiUsage {
        input_tokens: value["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: value["output_tokens"].as_u64().unwrap_or(0),
        cache_read_tokens: value["cache_read_input_tokens"].as_u64().unwrap_or(0),
        cache_write_tokens: value["cache_creation_input_tokens"].as_u64().unwrap_or(0),
    }
}

fn agent_error() -> ProviderError {
    ProviderError::new(ProviderErrorKind::Auth,
        "Claude could not complete the request; check the CLI sign-in, model access and usage limits")
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[test]
    fn native_aliases_and_model_capabilities_are_preserved_without_guessing_limits() {
        let catalog = parse_catalog(&json!({
            "models":[
                {"value":"default","displayName":"Default","resolvedModel":"claude-fixture-v1",
                    "description":"Uses the native model default","supportsEffort":true,
                    "supportedEffortLevels":["low","medium","high","max"],"defaultEffortLevel":"high"},
                {"value":"opus[1m]","displayName":"Opus","resolvedModel":"claude-opus-fixture","supportsFastMode":true,
                    "supportedEffortLevels":["low","medium","high","xhigh","max"]},
                {"value":"claude-fixture-v2","displayName":"Custom","supportsEffort":false,
                    "supportedEffortLevels":["high"],"contextWindow":123456,"maxOutputTokens":7890}
            ],
            "account":{"tokenSource":"none","apiKeySource":"environment","email":"never-surface@example.invalid"}
        })).unwrap();
        assert_eq!(catalog.default_model.as_deref(), Some("default"));
        assert_eq!(catalog.authenticated, Some(true));
        assert_eq!(catalog.auth_method.as_deref(), Some("environment"));
        assert_eq!(catalog.models[0].default_effort.as_deref(), Some("high"));
        assert_eq!(catalog.models[1].context_window, None);
        assert_eq!(catalog.models[1].max_output_tokens, None);
        assert!(catalog.models[1].is_alias);
        assert_eq!(catalog.models[1].id, "opus[1m]");
        assert_eq!(
            catalog.models[1].resolved_model.as_deref(),
            Some("claude-opus-fixture")
        );
        assert!(catalog.models[1].supports_fast_mode);
        assert_eq!(catalog.models[2].context_window, Some(123456));
        assert!(catalog.models[2].efforts.is_empty());
        assert!(!serde_json::to_string(&catalog)
            .unwrap()
            .contains("never-surface"));
    }

    #[test]
    fn account_restriction_disables_fast_mode_even_for_capable_models() {
        let catalog = parse_catalog(
            &json!({"models":[{"value":"default","supportsFastMode":true}],
            "fast_mode_disabled_reason":"subscription","account":{"tokenSource":"none"}}),
        )
        .unwrap();
        assert!(!catalog.models[0].supports_fast_mode);
        assert_eq!(catalog.authenticated, Some(false));
        assert_eq!(catalog.auth_method, None);
    }
}
