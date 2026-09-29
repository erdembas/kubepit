//! Codex's native JSON-RPC transport. No `exec` fallback: older versions that
//! cannot positively confirm an empty environment selection fail before a turn.

use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::super::local_discovery::ResolvedExecutable;
use super::super::provider::{
    AiTimeouts, AssistantTurn, ChatRequest, EventSink, ProviderError, ProviderErrorKind,
    StreamEvent,
};
use super::super::types::{AiAgentCatalog, AiAgentModel, AiAgentOptions, AiProviderKind, AiUsage};
use super::process::{controlled_command, Process, Scratch};
use super::{protocol, Answer, INSTRUCTIONS};

// Disable automatic context, hooks, native side-effect tools and plugin loading
// before app-server initialization. These session overrides never edit config.
const OVERRIDES: &[&str] = &[
    "features.shell_tool=false",
    "features.unified_exec=false",
    "features.apply_patch_freeform=false",
    "features.apps=false",
    "features.plugins=false",
    "features.hooks=false",
    "features.codex_hooks=false",
    "features.plugin_hooks=false",
    "features.memories=false",
    "features.memory_tool=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "agents.enabled=false",
    "features.js_repl=false",
    "features.browser_use=false",
    "features.computer_use=false",
    "features.image_generation=false",
    "features.imagegenext=false",
    "features.code_mode=false",
    "features.code_mode_only=false",
    "features.code_mode_host=false",
    "features.remote_control=false",
    "features.in_app_local_automation=false",
    "features.goals=false",
    "features.request_permissions=false",
    "features.request_permissions_tool=false",
    "features.request_rule=false",
    "features.external_agent_memory_import=false",
    "features.external_migration=false",
    "features.remote_plugin=false",
    "skills.include_instructions=false",
    "skills.bundled.enabled=false",
    "project_doc_max_bytes=0",
    "include_environment_context=false",
    "include_apps_instructions=false",
    "include_collaboration_mode_instructions=false",
    "include_permissions_instructions=false",
    "memories.use_memories=false",
    "memories.generate_memories=false",
    "web_search=\"disabled\"",
    "history.persistence=\"none\"",
    "analytics.enabled=false",
    "notify=[]",
    "shell_environment_policy.inherit=\"none\"",
    "approval_policy=\"never\"",
    "sandbox_mode=\"read-only\"",
];

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
    let command = command(executable, scratch.path())?;
    let mut process = Process::spawn(command, timeouts, req.max_tokens)?;
    let mut answer = Answer::new(req);
    let result = run(
        &mut process,
        scratch.path(),
        req,
        options,
        prompt,
        &mut answer,
        sink,
        cancel,
    )
    .await;
    result.map_err(|error| answer.failure(error))?;
    Ok(answer.turn)
}

fn command(
    executable: &ResolvedExecutable,
    cwd: &std::path::Path,
) -> Result<tokio::process::Command, ProviderError> {
    let mut command = controlled_command(executable, cwd);
    command
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .env_remove("CLAUDE_CONFIG_DIR");
    command.args(["app-server", "--listen", "stdio://"]);
    for value in OVERRIDES {
        command.arg("-c").arg(value);
    }
    // Unit transport fixtures must not inspect the developer's native files.
    // Configuration projection has separate file/value fixtures.
    if !cfg!(test) {
        super::config::codex(&mut command)?;
    }
    Ok(command)
}

/// Catalog, account status and selected defaults from the agent itself. This
/// creates no thread and never sends a turn, prompt, or cluster context.
pub(super) async fn catalog(
    executable: &ResolvedExecutable,
    timeouts: AiTimeouts,
    cancel: &CancellationToken,
) -> Result<AiAgentCatalog, ProviderError> {
    let scratch = Scratch::new()?;
    let mut process = Process::spawn(command(executable, scratch.path())?, timeouts, 0)?;
    let initialized = initialize(&mut process, cancel).await?;
    let config = rpc(
        &mut process,
        2,
        "config/read",
        json!({
            "cwd": scratch.path(), "includeLayers": false,
        }),
        cancel,
    )
    .await?;
    isolated_config(&config)?;
    load_catalog(&mut process, &config, &initialized, cancel).await
}

async fn load_catalog(
    process: &mut Process,
    config: &Value,
    initialized: &Value,
    cancel: &CancellationToken,
) -> Result<AiAgentCatalog, ProviderError> {
    let account = rpc(
        process,
        3,
        "account/read",
        json!({"refreshToken": false}),
        cancel,
    )
    .await?;
    let mut models = Vec::new();
    let mut seen_cursors = std::collections::HashSet::new();
    let mut cursor = Value::Null;
    for page in 0..20 {
        let result = rpc(
            process,
            10 + page,
            "model/list",
            json!({
                "limit": 100, "includeHidden": false, "cursor": cursor,
            }),
            cancel,
        )
        .await?;
        let data = result["data"]
            .as_array()
            .ok_or_else(|| protocol("Codex did not return its native model catalog"))?;
        models.extend(data.iter().filter(|model| model["hidden"] != true).cloned());
        if models.len() > 2000 {
            return Err(protocol("Codex returned an oversized model catalog"));
        }
        match result.get("nextCursor") {
            None | Some(Value::Null) => {
                return parse_catalog(&json!({
                    "models": models, "account": account,
                    "version": initialized["userAgent"],
                    "defaults": {
                        "model": config["config"]["model"],
                        "effort": config["config"]["model_reasoning_effort"],
                        "service_tier": config["config"]["service_tier"],
                    },
                }))
            }
            Some(Value::String(next)) if !next.is_empty() && seen_cursors.insert(next.clone()) => {
                cursor = json!(next);
            }
            _ => return Err(protocol("Codex returned an invalid model catalog cursor")),
        }
    }
    Err(protocol("Codex returned an oversized model catalog"))
}

fn parse_catalog(raw: &Value) -> Result<AiAgentCatalog, ProviderError> {
    let rows = raw["models"]
        .as_array()
        .ok_or_else(|| protocol("Codex did not return its native model catalog"))?;
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let id = row["model"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or_else(|| protocol("Codex did not return its native model catalog"))?;
        if !seen.insert(id.to_string()) {
            continue;
        }
        let efforts: Vec<String> = row["supportedReasoningEfforts"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value["reasoningEffort"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let tiers: Vec<String> = row["serviceTiers"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let default_effort = raw["defaults"]["effort"]
            .as_str()
            .filter(|effort| efforts.iter().any(|value| value == effort))
            .or_else(|| row["defaultReasoningEffort"].as_str())
            .map(str::to_string);
        let default_service_tier = raw["defaults"]["service_tier"]
            .as_str()
            .filter(|tier| tiers.iter().any(|value| value == tier))
            .or_else(|| row["defaultServiceTier"].as_str())
            .map(str::to_string);
        models.push(AiAgentModel {
            id: id.to_string(),
            name: row["displayName"].as_str().unwrap_or(id).to_string(),
            description: row["description"].as_str().map(str::to_string),
            is_default: row["isDefault"].as_bool().unwrap_or(false),
            context_window: super::metadata_u32(&row["contextWindow"]),
            max_output_tokens: super::metadata_u32(&row["maxOutputTokens"]),
            efforts,
            default_effort,
            service_tiers: tiers,
            default_service_tier,
            ..Default::default()
        });
    }
    let default_model = raw["defaults"]["model"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| {
            models
                .iter()
                .find(|model| model.is_default)
                .map(|model| model.id.clone())
        });
    if let Some(default) = &default_model {
        for model in &mut models {
            model.is_default = &model.id == default;
        }
    }
    let account = &raw["account"]["account"];
    let authenticated = if account.is_object() {
        Some(true)
    } else if raw["account"]["requiresOpenaiAuth"] == true {
        Some(false)
    } else {
        None
    };
    Ok(AiAgentCatalog {
        kind: AiProviderKind::CodexCli,
        models,
        default_model,
        authenticated,
        auth_method: account["type"].as_str().map(str::to_string),
        version: raw["version"]
            .as_str()
            .and_then(|ua| ua.split('/').nth(1))
            .and_then(|version| version.split_whitespace().next())
            .map(str::to_string),
    })
}

async fn initialize(
    process: &mut Process,
    cancel: &CancellationToken,
) -> Result<Value, ProviderError> {
    let result = rpc(process, 1, "initialize", json!({
        "clientInfo": {"name": "kubepit", "title": "Kubepit", "version": env!("CARGO_PKG_VERSION")},
        "capabilities": {"experimentalApi": true},
    }), cancel).await?;
    process
        .send(json!({"method": "initialized"}), cancel)
        .await?;
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
async fn run(
    process: &mut Process,
    cwd: &std::path::Path,
    req: &ChatRequest,
    options: &AiAgentOptions,
    prompt: &str,
    answer: &mut Answer,
    sink: EventSink<'_>,
    cancel: &CancellationToken,
) -> Result<(), ProviderError> {
    let initialized = initialize(process, cancel).await?;
    let effective = rpc(
        process,
        2,
        "config/read",
        json!({"cwd": cwd, "includeLayers": false}),
        cancel,
    )
    .await?;
    let overrides = isolated_config(&effective)?;
    let catalog = load_catalog(process, &effective, &initialized, cancel).await?;
    super::validate_options(&catalog, req, options)?;
    let mut params = json!({
        "cwd": cwd, "approvalPolicy": "never", "approvalsReviewer": "user",
        "sandbox": "read-only", "ephemeral": true, "environments": [],
        "runtimeWorkspaceRoots": [], "selectedCapabilityRoots": [], "dynamicTools": [],
        "baseInstructions": INSTRUCTIONS, "developerInstructions": "",
        "config": overrides,
    });
    if !req.model.is_empty() && req.model != "default" {
        params["model"] = json!(req.model);
    }
    let started = rpc(process, 3, "thread/start", params, cancel).await?;
    if !started["thread"]["environments"]
        .as_array()
        .is_some_and(Vec::is_empty)
        || started["approvalPolicy"] != "never"
    {
        return Err(protocol(
            "Codex cannot confirm disabled environment access; update the CLI",
        ));
    }
    let thread = started["thread"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| protocol("Codex did not return a thread id"))?;
    if let Some(model) = started["model"].as_str() {
        answer.turn.model = model.to_owned();
    }
    // The sole user input contains the exact consented JSON recorded by the
    // request hook. No images, file mentions or path-bearing input variants.
    let mut turn_params = json!({
        "threadId": thread, "input": [{"type": "text", "text": prompt}],
        "environments": [], "approvalPolicy": "never",
    });
    if let Some(effort) = &options.effort {
        turn_params["effort"] = json!(effort);
    }
    if let Some(tier) = &options.service_tier {
        turn_params["serviceTier"] = json!(tier);
    }
    process
        .send(
            json!({"id": 4, "method": "turn/start", "params": turn_params}),
            cancel,
        )
        .await?;
    let mut streamed_items = std::collections::HashSet::new();
    while let Some(value) = process.next(cancel).await? {
        if value.get("method").is_some() && value.get("id").is_some() {
            deny_request(process, &value, cancel).await?;
            continue;
        }
        if value.get("error").is_some() {
            return Err(agent_error());
        }
        if value["id"] == 4 {
            if !value["result"]["turn"]["id"].is_string() {
                return Err(protocol("Codex did not start a turn"));
            }
            continue;
        }
        let params = &value["params"];
        match value["method"].as_str() {
            Some("item/agentMessage/delta") => {
                let text = params["delta"]
                    .as_str()
                    .ok_or_else(|| protocol("Codex sent an invalid text event"))?;
                if let Some(id) = params["itemId"].as_str() {
                    streamed_items.insert(id.to_owned());
                    if streamed_items.len() > 512 {
                        return Err(protocol("Codex sent too many answer items"));
                    }
                }
                if answer.text(text, sink)? {
                    return Ok(());
                }
            }
            Some("item/reasoning/summaryTextDelta" | "item/reasoning/textDelta") => {
                answer.thinking(sink)
            }
            Some("item/started" | "item/completed") => {
                let item = &params["item"];
                match item["type"].as_str() {
                    Some("agentMessage") if value["method"] == "item/completed" => {
                        if !item["id"]
                            .as_str()
                            .is_some_and(|id| streamed_items.contains(id))
                        {
                            if let Some(text) = item["text"].as_str() {
                                if answer.text(text, sink)? {
                                    return Ok(());
                                }
                            }
                        }
                    }
                    Some("agentMessage" | "userMessage" | "reasoning" | "plan") => {}
                    _ => return Err(protocol("Codex attempted an unsupported local tool")),
                }
            }
            Some("thread/tokenUsage/updated") => {
                let usage = params["tokenUsage"]
                    .get("last")
                    .unwrap_or(&params["tokenUsage"]["total"]);
                let cached = usage["cachedInputTokens"].as_u64().unwrap_or(0);
                answer.turn.usage = AiUsage {
                    input_tokens: usage["inputTokens"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_sub(cached),
                    output_tokens: usage["outputTokens"].as_u64().unwrap_or(0),
                    cache_read_tokens: cached,
                    cache_write_tokens: 0,
                };
                sink(StreamEvent::Usage(answer.turn.usage));
            }
            Some("turn/completed") => {
                // A notification can arrive before the response to turn/start.
                if params["turn"]["status"] != "completed" {
                    return Err(agent_error());
                }
                sink(StreamEvent::Usage(answer.turn.usage));
                return Ok(());
            }
            Some("error") => return Err(agent_error()),
            _ => {}
        }
        if answer.started {
            process.content_started();
        }
    }
    Err(protocol("Codex stopped without a complete result"))
}

/// Existing maps merge in Codex: `mcp_servers={}` would *not* disable the user's
/// servers. Inspect effective configuration first and disable every entry by its
/// exact key in a nested map; names with dots are not dotted-path expressions.
fn isolated_config(effective: &Value) -> Result<Value, ProviderError> {
    let config = effective["config"]
        .as_object()
        .ok_or_else(|| protocol("Codex did not return its effective configuration"))?;
    let mut servers = Map::new();
    if let Some(value) = config.get("mcp_servers") {
        if !value.is_null() {
            let entries = value
                .as_object()
                .ok_or_else(|| protocol("Codex returned an invalid MCP configuration"))?;
            for name in entries.keys() {
                servers.insert(name.clone(), json!({"enabled": false}));
            }
        }
    }
    // These switches must survive enterprise/user config merging. A newer
    // incompatible CLI fails here instead of silently gaining host capabilities.
    for feature in [
        "shell_tool",
        "plugins",
        "hooks",
        "codex_hooks",
        "plugin_hooks",
        "apps",
        "memories",
        "multi_agent",
        "multi_agent_v2",
    ] {
        let value = &effective["config"]["features"][feature];
        if value != &Value::Bool(false) && value["enabled"] != false {
            return Err(protocol(
                "Codex did not accept the required isolation settings",
            ));
        }
    }
    Ok(json!({"mcp_servers": servers}))
}

async fn rpc(
    process: &mut Process,
    id: u64,
    method: &str,
    params: Value,
    cancel: &CancellationToken,
) -> Result<Value, ProviderError> {
    process
        .send(
            json!({"id": id, "method": method, "params": params}),
            cancel,
        )
        .await?;
    while let Some(value) = process.next(cancel).await? {
        if value.get("method").is_some() && value.get("id").is_some() {
            deny_request(process, &value, cancel).await?;
        } else if value["id"] == id {
            if value.get("error").is_some() {
                return Err(agent_error());
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| protocol("Codex sent an invalid RPC response"));
        } else if value["method"] == "error" {
            return Err(agent_error());
        }
    }
    Err(protocol("Codex stopped during initialization"))
}

async fn deny_request(
    process: &mut Process,
    value: &Value,
    cancel: &CancellationToken,
) -> Result<(), ProviderError> {
    let reply = match value["method"].as_str() {
        Some("item/commandExecution/requestApproval" | "item/fileChange/requestApproval") => {
            json!({"id": value["id"], "result": {"decision": "decline"}})
        }
        Some("item/permissions/requestApproval") => {
            json!({"id": value["id"], "result": {"permissions": {}, "scope": "turn"}})
        }
        _ => {
            json!({"id": value["id"], "error": {"code": -32601, "message": "Kubepit disables local agent tools"}})
        }
    };
    process.send(reply, cancel).await?;
    Err(protocol("Codex requested unsupported local access"))
}

fn agent_error() -> ProviderError {
    ProviderError::new(
        ProviderErrorKind::Auth,
        "Codex could not complete the request; check the CLI sign-in, model access and version",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_catalog_preserves_capabilities_and_configured_defaults() {
        let catalog = parse_catalog(&json!({
            "models": [{"model":"native-model","displayName":"Native model","description":"From the CLI",
                "isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"minimal"},{"reasoningEffort":"ultra"}],
                "defaultReasoningEffort":"minimal","serviceTiers":[{"id":"standard"},{"id":"priority"}],
                "defaultServiceTier":"standard","contextWindow":400000,"maxOutputTokens":50000}],
            "defaults":{"model":"native-model","effort":"ultra","service_tier":"priority"},
            "account":{"account":{"type":"chatgpt","email":"never-surface@example.invalid"},"requiresOpenaiAuth":true},
            "version":"codex/0.158.0-alpha.2.1 (Mac OS)"
        })).unwrap();
        let model = &catalog.models[0];
        assert_eq!(model.efforts, ["minimal", "ultra"]);
        assert_eq!(model.default_effort.as_deref(), Some("ultra"));
        assert_eq!(model.default_service_tier.as_deref(), Some("priority"));
        assert_eq!(model.context_window, Some(400000));
        assert_eq!(model.max_output_tokens, Some(50000));
        assert!(!model.supports_fast_mode);
        assert_eq!(catalog.version.as_deref(), Some("0.158.0-alpha.2.1"));
        assert_eq!(catalog.authenticated, Some(true));
        assert!(!serde_json::to_string(&catalog)
            .unwrap()
            .contains("never-surface"));
    }

    #[test]
    fn absent_limits_and_account_remain_unknown() {
        let catalog = parse_catalog(&json!({
            "models":[{"model":"gpt-fixture-1m","description":"1 million tokens"}],
            "account":{"account":null,"requiresOpenaiAuth":false}
        }))
        .unwrap();
        assert_eq!(catalog.models[0].context_window, None);
        assert_eq!(catalog.models[0].max_output_tokens, None);
        assert_eq!(catalog.authenticated, None);
        assert_eq!(catalog.default_model, None);
    }

    #[test]
    fn disables_each_mcp_entry_without_interpreting_its_name_as_a_path() {
        let features: Map<String, Value> = [
            "shell_tool",
            "plugins",
            "hooks",
            "codex_hooks",
            "plugin_hooks",
            "apps",
            "memories",
            "multi_agent",
            "multi_agent_v2",
        ]
        .into_iter()
        .map(|name| (name.into(), json!(false)))
        .collect();
        let config = isolated_config(&json!({"config": {"features": features,
            "mcp_servers": {"user.server": {"command": "never-start-me"}, "remote": {"url": "https://invalid.example"}}}})).unwrap();
        assert_eq!(config["mcp_servers"]["user.server"]["enabled"], false);
        assert_eq!(config["mcp_servers"]["remote"]["enabled"], false);
        assert!(config["mcp_servers"]["user.server"]
            .get("command")
            .is_none());
    }

    #[test]
    fn refuses_unconfirmed_isolation() {
        assert!(isolated_config(&json!({"config": {}})).is_err());
        assert!(isolated_config(&json!({"config": {"features": {"shell_tool": true}}})).is_err());
    }
}
