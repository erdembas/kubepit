//! Native OpenCode integration. Every call owns an isolated home and server;
//! only native authentication and declarative provider/model configuration cross
//! into that home. Native plugins, instructions and host tools stay disabled.

mod config;

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures::{future::BoxFuture, StreamExt};
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

use super::local_discovery;
use super::provider::{
    answer_cap, AiTimeouts, AssistantTurn, ChatMessage, ChatRequest, Egress, EgressCell, EventSink,
    Provider, ProviderError, ProviderErrorKind, RequestHook, StopReason, StreamEvent, UserBlock,
    MAX_RESPONSE_BYTES,
};
use super::sse::SseParser;
use super::types::{
    AiAgentCatalog, AiAgentModel, AiAgentOptions, AiModelInfo, AiProviderKind, AiUsage,
};

const REMOTE_ORIGIN: &str = "https://opencode.ai";
const AGENT: &str = "kubepit-assistant";
const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;

fn protocol(message: impl Into<String>) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Protocol, message)
}

fn bad_request(message: impl Into<String>) -> ProviderError {
    ProviderError::new(ProviderErrorKind::BadRequest, message)
}

fn io_error(error: std::io::Error) -> ProviderError {
    ProviderError::new(ProviderErrorKind::Network, format!("local agent: {error}"))
}

pub struct OpenCodeCliProvider {
    timeouts: AiTimeouts,
    egress: EgressCell,
    request_hook: Option<RequestHook>,
    options: AiAgentOptions,
}

impl OpenCodeCliProvider {
    pub fn new(
        kind: AiProviderKind,
        timeouts: AiTimeouts,
        egress: Egress,
    ) -> Result<Self, ProviderError> {
        if kind != AiProviderKind::OpencodeCli || !local_discovery::supported(kind) {
            return Err(bad_request(
                "this local agent cannot disable its host tools and integrations; choose another assistant provider",
            ));
        }
        let provider = Self {
            timeouts,
            egress: EgressCell::default(),
            request_hook: None,
            options: AiAgentOptions::default(),
        };
        provider.egress.set(egress);
        Ok(provider)
    }

    pub fn with_request_hook(mut self, hook: RequestHook) -> Self {
        self.request_hook = Some(hook);
        self
    }

    pub fn with_options(mut self, options: AiAgentOptions) -> Self {
        self.options = options;
        self
    }

    /// Fetch the installed agent's current account/model metadata. This starts
    /// an isolated server but never creates a conversation or model request.
    pub async fn catalog(
        &self,
        cancel: CancellationToken,
    ) -> Result<AiAgentCatalog, ProviderError> {
        self.egress.check(REMOTE_ORIGIN)?;
        if cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        tokio::select! {
            _ = cancel.cancelled() => Err(ProviderError::cancelled()),
            result = tokio::time::timeout(self.timeouts.total, async {
                let running = self.start_server().await?;
                running.server.catalog(running.version.clone()).await
            }) => result.unwrap_or_else(|_| Err(ProviderError::new(ProviderErrorKind::Timeout, "OpenCode model discovery timed out"))),
        }
    }

    async fn start_server(&self) -> Result<RunningServer, ProviderError> {
        self.egress.check(REMOTE_ORIGIN)?;
        let executable = local_discovery::resolve(AiProviderKind::OpencodeCli)
            .ok_or_else(|| bad_request("OpenCode CLI was not found"))?;
        let native_config = config::NativeConfig::load()?;
        let home = IsolatedHome::new()?;
        let listener =
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(io_error)?;
        let port = listener.local_addr().map_err(io_error)?.port();
        drop(listener);
        let password = uuid::Uuid::new_v4().to_string();
        let mut command = Command::new(&executable.path);
        command.env_clear();
        // Only OS/runtime necessities survive. No NODE_OPTIONS, proxy,
        // KUBECONFIG, provider config, shell hooks or prompt variables.
        for key in [
            "SystemRoot",
            "WINDIR",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "TMP",
            "TEMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        if let Some(path) = &executable.command_path {
            command.env("PATH", path);
        }
        configure_command(&mut command, home.path(), &password);
        native_config.apply(&mut command, isolated_config(home.path()))?;
        command.args(["--pure", "serve", "--hostname", "127.0.0.1", "--port"]);
        command.arg(port.to_string());
        let process = OwnedServer::spawn(command)?;
        let base = format!("http://127.0.0.1:{port}");
        // Reuse the explicit ring TLS configuration even for loopback: this
        // workspace builds reqwest with rustls-no-provider. The shared client
        // also disables redirects and loopback proxies.
        let client = super::provider::http_client(&self.timeouts, &base)?;
        let server = Server {
            base,
            client,
            password,
            process,
        };
        let version = server.ready(self.timeouts.connect).await?;
        Ok(RunningServer {
            server,
            _home: home,
            version,
        })
    }

    async fn run(
        &self,
        request: &ChatRequest,
        on_event: EventSink<'_>,
        cancel: &CancellationToken,
    ) -> Result<AssistantTurn, ProviderError> {
        self.egress.check(REMOTE_ORIGIN)?;
        if cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        let body = prompt_body(request, &self.options)?;
        validate_options(&self.options)?;
        let running = self.start_server().await?;
        let server = &running.server;
        if self.options.effort.is_some() {
            let catalog = server.catalog(running.version.clone()).await?;
            validate_model_effort(request, &self.options, &catalog)?;
        }
        let agents = server.json("GET", "/agent", None).await?;
        verify_agent(&agents)?;
        let session = server
            .json(
                "POST",
                "/session",
                Some(json!({"title":"Kubepit assistant", "permission": deny_rules()})),
            )
            .await?;
        verify_permissions(&session["permission"])?;
        let id = session["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| protocol("OpenCode returned an invalid session ID"))?;
        // Subscribe before prompting so fast responses cannot be missed.
        let response = server
            .get("/event")
            .send()
            .await
            .map_err(|_| protocol("could not subscribe to OpenCode events"))?;
        if !response.status().is_success() {
            return Err(protocol("OpenCode refused its event stream"));
        }
        self.egress.check(REMOTE_ORIGIN)?;
        if let Some(hook) = &self.request_hook {
            hook(body.clone(), cancel.clone()).await?;
        }
        if cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        server
            .json("POST", &format!("/session/{id}/prompt_async"), Some(body))
            .await?;
        let mut output =
            OpenCodeOutput::new(id.to_string(), request.model.clone(), request.max_tokens);
        let mut parser = SseParser::new();
        let mut stream = response.bytes_stream();
        loop {
            let delay = if output.started {
                self.timeouts.idle
            } else {
                self.timeouts.first_event
            };
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(output.error(ProviderError::cancelled())),
                item = tokio::time::timeout(delay, stream.next()) => item,
            };
            let bytes = match next {
                Ok(Some(Ok(bytes))) => bytes,
                Ok(Some(Err(_))) => {
                    return Err(output.error(protocol("OpenCode event stream failed")))
                }
                Ok(None) => {
                    return Err(output.error(protocol("OpenCode ended without a completed answer")))
                }
                Err(_) => {
                    return Err(output.error(ProviderError::new(
                        ProviderErrorKind::Timeout,
                        "OpenCode response timed out",
                    )))
                }
            };
            for (_, data) in parser
                .push(&bytes)
                .map_err(|error| output.error(protocol(error.to_string())))?
            {
                let value: Value = serde_json::from_str(&data).map_err(|_| {
                    output.error(protocol("OpenCode returned malformed event JSON"))
                })?;
                if output.event(&value, on_event)? {
                    return Ok(output.finish());
                }
            }
        }
    }
}

impl Provider for OpenCodeCliProvider {
    fn kind(&self) -> AiProviderKind {
        AiProviderKind::OpencodeCli
    }
    fn is_local(&self) -> bool {
        false
    }
    fn set_egress(&self, egress: Egress) {
        self.egress.set(egress);
    }
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<AiModelInfo>, ProviderError>> {
        Box::pin(async move {
            Ok(self
                .catalog(CancellationToken::new())
                .await?
                .models
                .into_iter()
                .map(|model| AiModelInfo {
                    id: model.id,
                    display_name: Some(model.name),
                    context_window: model.context_window,
                    max_output_tokens: model.max_output_tokens,
                    effort: Some(!model.efforts.is_empty()),
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
            self.egress.check(REMOTE_ORIGIN)?;
            let partial = parking_lot::Mutex::new((
                false,
                AssistantTurn {
                    raw: Value::Null,
                    text: String::new(),
                    tool_calls: vec![],
                    stop: StopReason::EndTurn,
                    usage: AiUsage::default(),
                    model: req.model.clone(),
                },
            ));
            let forward = |event: StreamEvent| {
                {
                    let mut state = partial.lock();
                    match &event {
                        StreamEvent::Text(text) => {
                            state.0 = true;
                            state.1.text.push_str(text);
                        }
                        StreamEvent::Thinking => state.0 = true,
                        StreamEvent::Usage(usage) => state.1.usage = *usage,
                        _ => {}
                    }
                }
                on_event(event);
            };
            let result = tokio::select! {
                _ = cancel.cancelled() => Err(ProviderError::cancelled()),
                result = tokio::time::timeout(answer_cap(&self.timeouts, req.max_tokens), self.run(req, &forward, cancel)) => {
                    result.unwrap_or_else(|_| Err(ProviderError::new(ProviderErrorKind::Timeout, "OpenCode request timed out")))
                }
            };
            result.map_err(|error| {
                let state = partial.lock();
                if state.0 {
                    error.with_partial(state.1.clone())
                } else {
                    error
                }
            })
        })
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn deny_rules() -> Value {
    json!([{"permission":"*","pattern":"*","action":"deny"}])
}

fn verify_permissions(value: &Value) -> Result<(), ProviderError> {
    // Native rules use last-match precedence. Defaults may allow tools before
    // our universal deny; every rule after that deny must remain a denial.
    // In particular, modern OpenCode appends its tool-output directory rule.
    if let Some(rules) = value.as_array() {
        if let Some(deny) = rules.iter().rposition(|rule| {
            rule["permission"] == "*" && rule["pattern"] == "*" && rule["action"] == "deny"
        }) {
            if rules[deny..].iter().all(|rule| {
                rule["action"] == "deny"
                    && rule["permission"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
                    && rule["pattern"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
            }) {
                return Ok(());
            }
        }
    }
    Err(protocol(
        "this OpenCode version did not enforce the no-tools permission policy",
    ))
}

fn verify_agent(agents: &Value) -> Result<(), ProviderError> {
    let agent = agents
        .as_array()
        .and_then(|agents| agents.iter().find(|agent| agent["name"] == AGENT))
        .ok_or_else(|| protocol("OpenCode did not expose the isolated assistant agent"))?;
    verify_permissions(&agent["permission"])
}

fn validate_options(options: &AiAgentOptions) -> Result<(), ProviderError> {
    if options.service_tier.is_some() || options.fast_mode {
        return Err(bad_request("OpenCode does not advertise separate service-tier or fast-mode controls; select one of its model variants instead"));
    }
    Ok(())
}

fn validate_model_effort(
    request: &ChatRequest,
    options: &AiAgentOptions,
    catalog: &AiAgentCatalog,
) -> Result<(), ProviderError> {
    let Some(effort) = &options.effort else {
        return Ok(());
    };
    let id = if request.model.is_empty() || request.model == "default" {
        catalog.default_model.as_deref().ok_or_else(|| {
            bad_request("choose an explicit OpenCode model before selecting a variant")
        })?
    } else {
        &request.model
    };
    let model = catalog.models.iter().find(|model| model.id == id)
        .ok_or_else(|| bad_request("the selected OpenCode model is not in its connected model catalog; refresh models or choose the agent default"))?;
    if !model.efforts.contains(effort) {
        return Err(bad_request("the selected variant is not offered by this OpenCode model; refresh models and choose an available variant"));
    }
    Ok(())
}

/// Copy only public model metadata. Native provider objects can also contain
/// credentials and environment values, which must never reach the webview/log.
fn parse_catalog(
    providers: &Value,
    config: &Value,
    version: Option<String>,
) -> Result<AiAgentCatalog, ProviderError> {
    let all = providers["all"]
        .as_array()
        .ok_or_else(|| protocol("OpenCode returned no provider catalog"))?;
    let connected = providers["connected"]
        .as_array()
        .ok_or_else(|| protocol("OpenCode returned no provider connection metadata"))?;
    let mut models = Vec::new();
    for provider in all {
        let Some(provider_id) = provider["id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        if !connected.iter().any(|id| id.as_str() == Some(provider_id)) {
            continue;
        }
        let provider_name = provider["name"].as_str().unwrap_or(provider_id);
        let Some(native_models) = provider["models"].as_object() else {
            continue;
        };
        for (key, model) in native_models {
            let id = model["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .unwrap_or(key);
            if id.is_empty() || id.len() > 1024 || provider_id.len() > 256 {
                continue;
            }
            if models.len() >= 4096 {
                return Err(protocol("OpenCode returned too many connected models"));
            }
            let name = model["name"].as_str().unwrap_or(id);
            let efforts: Vec<String> = model["variants"]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(name, value)| {
                    !name.is_empty()
                        && name.len() <= 128
                        && value["disabled"].as_bool() != Some(true)
                })
                .map(|(name, _)| name.clone())
                .take(128)
                .collect();
            models.push(AiAgentModel {
                id: format!("{provider_id}/{id}"),
                name: format!("{provider_name} · {name}"),
                description: model["description"].as_str().map(str::to_owned),
                context_window: positive_u32(&model["limit"]["input"])
                    .or_else(|| positive_u32(&model["limit"]["context"])),
                max_output_tokens: positive_u32(&model["limit"]["output"]),
                efforts,
                ..Default::default()
            });
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    // /provider.default is a map of per-provider defaults, not the one global
    // choice. Only the native effective config can name that global default.
    let default_model = config["model"]
        .as_str()
        .filter(|id| models.iter().any(|model| model.id == *id))
        .map(str::to_owned);
    for model in &mut models {
        model.is_default = default_model.as_deref() == Some(&model.id);
    }
    Ok(AiAgentCatalog {
        kind: AiProviderKind::OpencodeCli,
        models,
        default_model,
        authenticated: None,
        auth_method: Some("native-cli".into()),
        version,
    })
}

fn positive_u32(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn prompt_body(request: &ChatRequest, options: &AiAgentOptions) -> Result<Value, ProviderError> {
    if !request.tools.is_empty() {
        return Err(bad_request("local agents cannot use assistant tools"));
    }
    let mut messages = Vec::new();
    for message in &request.messages {
        match message {
            ChatMessage::User(blocks) => {
                if blocks
                    .iter()
                    .any(|block| matches!(block, UserBlock::ToolResult { .. }))
                {
                    return Err(bad_request("local agents cannot receive tool histories"));
                }
                let content: Vec<_> = blocks
                    .iter()
                    .map(|block| match block {
                        UserBlock::Text { text, .. } => json!({"type":"text","text":text}),
                        UserBlock::ToolResult {
                            content, is_error, ..
                        } => json!({"type":"text","text":content,"is_error":is_error}),
                    })
                    .collect();
                messages.push(json!({"role":"user","content":content}));
            }
            ChatMessage::Assistant(turn) => {
                if !turn.tool_calls.is_empty() {
                    return Err(bad_request("local agents cannot receive tool histories"));
                }
                messages.push(json!({"role":"assistant","content":turn.text}))
            }
        }
    }
    let text = serde_json::to_string(&json!({"system":request.system,"messages":messages}))
        .map_err(|_| bad_request("could not encode the local assistant request"))?;
    let mut body = json!({
        "agent":AGENT,
        "parts":[{"type":"text","text":text}],
        "tools":{"*":false},
        "system": request.system,
    });
    if !request.model.trim().is_empty() && request.model != "default" {
        let (provider, model) = request
            .model
            .split_once('/')
            .filter(|(provider, model)| !provider.is_empty() && !model.is_empty())
            .ok_or_else(|| bad_request("OpenCode models use provider/model IDs"))?;
        body["model"] = json!({"providerID":provider,"modelID":model});
    }
    if let Some(effort) = &options.effort {
        body["variant"] = json!(effort);
    }
    Ok(body)
}

fn configure_command(command: &mut Command, home: &Path, password: &str) {
    command.current_dir(home.join("work"));
    for (key, relative) in [
        ("HOME", ""),
        ("USERPROFILE", ""),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
    ] {
        command.env(key, home.join(relative));
    }
    for key in [
        "OPENCODE_PURE",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_PRUNE",
        "OPENCODE_DISABLE_SHARE",
        "OPENCODE_DISABLE_LSP_DOWNLOAD",
        "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
    ] {
        command.env(key, "1");
    }
    let config = isolated_config(home);
    command.env("OPENCODE_PERMISSION", config["permission"].to_string());
    command.env("OPENCODE_SERVER_USERNAME", "kubepit");
    command.env("OPENCODE_SERVER_PASSWORD", password);
    command.env("OPENCODE_CONFIG_CONTENT", config.to_string());
}

fn isolated_config(home: &Path) -> Value {
    // OpenCode automatically allows truncated tool-output files unless this
    // exact native glob is explicitly denied. The general wildcard alone does
    // not prevent that startup exception. Both layers retain universal denial.
    let tool_output = home.join("data/opencode/tool-output/*");
    let permission = json!({"*":"deny", "external_directory": {
        tool_output.to_string_lossy().as_ref(): "deny",
    }});
    json!({
        "autoupdate": false,
        "share": "disabled",
        "instructions": [],
        "plugin": [],
        "mcp": {},
        "permission": permission,
        "agent": {AGENT: {
            "description":"Kubepit assistant without tools",
            "mode":"primary",
            "prompt":"Answer the supplied conversation. All host tools and integrations are disabled.",
            "permission": permission,
        }},
    })
}

struct IsolatedHome {
    path: PathBuf,
}

impl IsolatedHome {
    fn new() -> Result<Self, ProviderError> {
        refuse_managed_config()?;
        let auth = native_auth_path();
        if let Some(auth) = &auth {
            validate_native_auth(auth)?;
        }
        Self::create(auth.as_deref())
    }

    fn create(auth: Option<&Path>) -> Result<Self, ProviderError> {
        let path = std::env::temp_dir().join(format!("kubepit-opencode-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(io_error)?;
        let home = Self { path };
        for dir in ["work", "config", "data/opencode", "cache", "state"] {
            std::fs::create_dir_all(home.path.join(dir)).map_err(io_error)?;
        }
        #[cfg(unix)]
        if let Some(auth) = auth.filter(|path| path.is_file()) {
            std::os::unix::fs::symlink(auth, home.path.join("data/opencode/auth.json"))
                .map_err(io_error)?;
        }
        #[cfg(not(unix))]
        let _ = auth;
        Ok(home)
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for IsolatedHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn native_auth_path() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| dirs::home_dir().map(|path| path.join(".local/share")))?;
    Some(data.join("opencode/auth.json"))
}

/// Well-known accounts can supply executable remote configuration. Do not
/// launch those accounts in an assistant transport; no credentials are logged.
fn validate_native_auth(path: &Path) -> Result<(), ProviderError> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(bad_request(
                "could not inspect OpenCode authentication configuration",
            ))
        }
    };
    if !metadata.is_file() || metadata.len() > MAX_METADATA_BYTES as u64 {
        return Err(bad_request(
            "OpenCode authentication configuration is invalid or too large",
        ));
    }
    let mut text = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| {
            file.take(MAX_METADATA_BYTES as u64 + 1)
                .read_to_end(&mut text)
        })
        .map_err(|_| bad_request("could not inspect OpenCode authentication configuration"))?;
    if text.len() > MAX_METADATA_BYTES {
        return Err(bad_request(
            "OpenCode authentication configuration is too large",
        ));
    }
    let value: Value = serde_json::from_slice(&text)
        .map_err(|_| bad_request("OpenCode authentication configuration is invalid"))?;
    let entries = value
        .as_object()
        .ok_or_else(|| bad_request("OpenCode authentication configuration is invalid"))?;
    if entries
        .values()
        .any(|entry| !matches!(entry["type"].as_str(), Some("api" | "oauth")))
    {
        return Err(bad_request("OpenCode remote authentication configuration cannot be isolated; choose another assistant provider"));
    }
    Ok(())
}

fn refuse_managed_config() -> Result<(), ProviderError> {
    #[cfg(target_os = "macos")]
    let paths = [
        "/Library/Application Support/opencode",
        "/Library/Managed Preferences",
    ];
    #[cfg(not(target_os = "macos"))]
    let paths = ["/etc/opencode"];
    for root in paths {
        let root = Path::new(root);
        if root.ends_with("Managed Preferences") {
            if root.join("ai.opencode.managed.plist").exists()
                || std::fs::read_dir(root)
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(Result::ok)
                    .any(|entry| entry.path().join("ai.opencode.managed.plist").exists())
            {
                return Err(bad_request("managed OpenCode configuration cannot be isolated; choose another assistant provider"));
            }
        } else if root.join("opencode.json").exists() || root.join("opencode.jsonc").exists() {
            return Err(bad_request("managed OpenCode configuration cannot be isolated; choose another assistant provider"));
        }
    }
    Ok(())
}

struct OwnedServer {
    child: Child,
}

impl OwnedServer {
    fn spawn(mut command: Command) -> Result<Self, ProviderError> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        Ok(Self {
            child: command.spawn().map_err(io_error)?,
        })
    }
}

impl Drop for OwnedServer {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            // SAFETY: the spawned child is the leader of its own process group.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}

struct Server {
    base: String,
    client: reqwest::Client,
    password: String,
    process: OwnedServer,
}

// Declaration order matters: kill the process before removing its private home.
struct RunningServer {
    server: Server,
    _home: IsolatedHome,
    version: Option<String>,
}

impl Server {
    async fn catalog(&self, version: Option<String>) -> Result<AiAgentCatalog, ProviderError> {
        let (providers, config) = tokio::try_join!(
            self.json("GET", "/provider", None),
            self.json("GET", "/config", None),
        )?;
        parse_catalog(&providers, &config, version)
    }
    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .get(format!("{}{path}", self.base))
            .basic_auth("kubepit", Some(&self.password))
    }

    async fn ready(&self, timeout: Duration) -> Result<Option<String>, ProviderError> {
        let _ = &self.process;
        tokio::time::timeout(timeout, async {
            loop {
                if let Ok(response) = self
                    .get("/global/health")
                    .timeout(Duration::from_millis(500))
                    .send()
                    .await
                {
                    if response.status().is_success() {
                        let health = response_json(response).await?;
                        return Ok(health["version"]
                            .as_str()
                            .filter(|version| version.len() <= 100)
                            .map(str::to_owned));
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| {
            ProviderError::new(
                ProviderErrorKind::Timeout,
                "OpenCode server did not become ready; update the CLI and retry",
            )
        })?
    }

    async fn json(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ProviderError> {
        let request = if method == "GET" {
            self.get(path)
        } else {
            self.client
                .post(format!("{}{path}", self.base))
                .basic_auth("kubepit", Some(&self.password))
        };
        let request = if let Some(body) = body {
            request.json(&body)
        } else {
            request
        };
        let response = request
            .send()
            .await
            .map_err(|_| protocol("OpenCode local API request failed"))?;
        response_json(response).await
    }
}

async fn response_json(response: reqwest::Response) -> Result<Value, ProviderError> {
    if !response.status().is_success() {
        return Err(protocol(format!(
            "OpenCode local API returned {}",
            response.status()
        )));
    }
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| protocol("OpenCode local API response failed"))?;
        if bytes.len().saturating_add(chunk.len()) > super::provider::MAX_JSON_BODY_BYTES {
            return Err(protocol("OpenCode metadata response was too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| protocol("OpenCode local API returned malformed JSON"))
}

struct OpenCodeOutput {
    session: String,
    model: String,
    parts: BTreeMap<String, String>,
    part_order: Vec<String>,
    part_types: HashMap<String, String>,
    roles: HashMap<String, String>,
    usage: AiUsage,
    started: bool,
    busy: bool,
    max_chars: usize,
    chars: usize,
    truncated: bool,
}

impl OpenCodeOutput {
    fn new(session: String, model: String, max_tokens: u32) -> Self {
        Self {
            session,
            model,
            parts: BTreeMap::new(),
            part_order: Vec::new(),
            part_types: HashMap::new(),
            roles: HashMap::new(),
            usage: AiUsage::default(),
            started: false,
            busy: false,
            // CLI output caps are conservative character budgets, not provider token accounting.
            max_chars: (max_tokens as usize).max(1),
            chars: 0,
            truncated: false,
        }
    }

    fn event(&mut self, event: &Value, on_event: EventSink<'_>) -> Result<bool, ProviderError> {
        let event = event.get("payload").unwrap_or(event);
        let props = &event["properties"];
        let session = props["sessionID"]
            .as_str()
            .or_else(|| props["part"]["sessionID"].as_str())
            .or_else(|| props["info"]["sessionID"].as_str());
        if session.is_some_and(|id| id != self.session) {
            return Ok(false);
        }
        match event["type"].as_str().unwrap_or_default() {
            "message.updated" => {
                let info = &props["info"];
                if let (Some(id), Some(role)) = (info["id"].as_str(), info["role"].as_str()) {
                    if self.roles.len() >= 1024 && !self.roles.contains_key(id) {
                        return Err(self.error(protocol("OpenCode emitted too many messages")));
                    }
                    self.roles.insert(id.to_string(), role.to_string());
                    if role == "assistant" {
                        let tokens = &info["tokens"];
                        self.usage = AiUsage {
                            input_tokens: tokens["input"].as_u64().unwrap_or(0),
                            output_tokens: tokens["output"].as_u64().unwrap_or(0),
                            cache_read_tokens: tokens["cache"]["read"].as_u64().unwrap_or(0),
                            cache_write_tokens: tokens["cache"]["write"].as_u64().unwrap_or(0),
                        };
                        on_event(StreamEvent::Usage(self.usage));
                        if let Some(model) = info["modelID"].as_str() {
                            self.model = info["providerID"]
                                .as_str()
                                .filter(|id| !id.is_empty())
                                .map(|provider| format!("{provider}/{model}"))
                                .unwrap_or_else(|| model.to_string());
                        }
                        if info.get("error").is_some_and(|value| !value.is_null()) {
                            return Err(self.error(protocol("OpenCode could not complete the model request; check its login and model")));
                        }
                    }
                }
            }
            "message.part.updated" => {
                let part = &props["part"];
                if self
                    .roles
                    .get(part["messageID"].as_str().unwrap_or_default())
                    .is_none_or(|role| role != "assistant")
                {
                    return Ok(false);
                }
                if let (Some(id), Some(kind)) = (part["id"].as_str(), part["type"].as_str()) {
                    if self.part_types.len() >= 1024 && !self.part_types.contains_key(id) {
                        return Err(self.error(protocol("OpenCode emitted too many parts")));
                    }
                    self.part_types.insert(id.to_string(), kind.to_string());
                }
                match part["type"].as_str() {
                    Some("text") => {
                        if let (Some(id), Some(text)) = (part["id"].as_str(), part["text"].as_str())
                        {
                            self.update(id, text, on_event)?;
                        }
                    }
                    Some("reasoning") => {
                        self.started = true;
                        on_event(StreamEvent::Thinking);
                    }
                    Some("tool") => {
                        return Err(self.error(protocol(
                            "OpenCode requested a host tool despite the no-tools policy",
                        )))
                    }
                    _ => {}
                }
            }
            "message.part.delta" if props["field"].as_str().is_none_or(|field| field == "text") => {
                if self
                    .roles
                    .get(props["messageID"].as_str().unwrap_or_default())
                    .is_none_or(|role| role != "assistant")
                {
                    return Ok(false);
                }
                if let (Some(id), Some(delta)) = (props["partID"].as_str(), props["delta"].as_str())
                {
                    if self.part_types.get(id).is_none_or(|kind| kind != "text") {
                        return Ok(false);
                    }
                    let next = format!(
                        "{}{delta}",
                        self.parts.get(id).map(String::as_str).unwrap_or_default()
                    );
                    self.update(id, &next, on_event)?;
                }
            }
            "session.status" => match props["status"]["type"].as_str() {
                Some("busy" | "retry") => self.busy = true,
                Some("idle") if self.busy => return Ok(true),
                _ => {}
            },
            "session.idle" if self.busy => return Ok(true),
            "permission.asked" | "permission.updated" | "question.asked" => {
                return Err(self.error(protocol(
                    "OpenCode requested access despite the no-tools policy",
                )))
            }
            "session.error" => {
                return Err(self.error(protocol(
                    "OpenCode model request failed; check its login and model",
                )))
            }
            _ => {}
        }
        Ok(self.truncated)
    }

    fn update(
        &mut self,
        id: &str,
        text: &str,
        on_event: EventSink<'_>,
    ) -> Result<(), ProviderError> {
        let current = self.parts.get(id).map(String::as_str).unwrap_or_default();
        if current == text {
            return Ok(());
        }
        let delta = text
            .strip_prefix(current)
            .ok_or_else(|| self.error(protocol("OpenCode rewrote an already streamed answer")))?;
        let total: usize = self.parts.values().map(String::len).sum();
        if total.saturating_add(delta.len()) > MAX_RESPONSE_BYTES {
            return Err(self.error(protocol("OpenCode answer exceeded the response limit")));
        }
        let remaining = self.max_chars.saturating_sub(self.chars);
        let count = delta.chars().count();
        let bounded = delta.chars().take(remaining).collect::<String>();
        self.chars += count.min(remaining);
        self.truncated = count > remaining;
        let text = format!("{current}{bounded}");
        if !bounded.is_empty() {
            self.started = true;
            on_event(StreamEvent::Text(bounded));
        }
        if !self.parts.contains_key(id) {
            self.part_order.push(id.to_string());
        }
        self.parts.insert(id.to_string(), text);
        Ok(())
    }

    fn finish(&self) -> AssistantTurn {
        let text: String = self
            .part_order
            .iter()
            .filter_map(|id| self.parts.get(id))
            .cloned()
            .collect();
        AssistantTurn {
            raw: json!({"role":"assistant","content":text}),
            text,
            tool_calls: vec![],
            stop: if self.truncated {
                StopReason::MaxTokens
            } else {
                StopReason::EndTurn
            },
            usage: self.usage,
            model: self.model.clone(),
        }
    }

    fn error(&self, error: ProviderError) -> ProviderError {
        if self.started {
            error.with_partial(self.finish())
        } else {
            error
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::provider::{ToolCallReq, ToolSpec};
    use super::*;

    fn request() -> ChatRequest {
        ChatRequest {
            model: "openai/fixture".into(),
            system: "Fixture system".into(),
            messages: vec![ChatMessage::User(vec![UserBlock::Text {
                text: "Fixture prompt".into(),
                cache: false,
            }])],
            tools: vec![],
            max_tokens: 100,
            effort: None,
        }
    }

    fn provider_catalog() -> Value {
        json!({
            "all":[
                {"id":"openai","name":"OpenAI","key":"fixture-secret-do-not-return","options":{"apiKey":"fixture-secret-do-not-return"},"models":{
                    "fixture":{"id":"fixture","name":"Fixture Reasoner","description":"Native model description","limit":{"context":200000,"input":180000,"output":16000},"variants":{"creative-mode":{},"high":{},"fast":{},"disabled-variant":{"disabled":true}}}
                }},
                {"id":"disconnected","name":"Disconnected","models":{"hidden":{"id":"hidden","name":"Do not show"}}}
            ],
            "connected":["openai"],
            "default":{"openai":"fixture","disconnected":"hidden"}
        })
    }

    #[test]
    fn native_catalog_filters_connections_and_preserves_model_capabilities_without_secrets() {
        let catalog = parse_catalog(
            &provider_catalog(),
            &json!({"model":"openai/fixture"}),
            Some("1.18.30".into()),
        )
        .unwrap();
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.default_model.as_deref(), Some("openai/fixture"));
        assert_eq!(catalog.authenticated, None);
        assert_eq!(catalog.version.as_deref(), Some("1.18.30"));
        let model = &catalog.models[0];
        assert_eq!(model.id, "openai/fixture");
        assert_eq!(model.name, "OpenAI · Fixture Reasoner");
        assert_eq!(model.context_window, Some(180000));
        assert_eq!(model.max_output_tokens, Some(16000));
        assert_eq!(model.efforts, ["creative-mode", "fast", "high"]);
        assert!(model.is_default);
        assert!(!model.supports_fast_mode);
        assert!(model.service_tiers.is_empty());
        assert!(!serde_json::to_string(&catalog)
            .unwrap()
            .contains("fixture-secret-do-not-return"));
        let automatic = parse_catalog(&provider_catalog(), &json!({}), None).unwrap();
        assert_eq!(
            automatic.default_model, None,
            "per-provider defaults must not be presented as one global choice"
        );
        assert!(!automatic.models[0].is_default);
    }

    #[test]
    fn custom_catalog_and_prompt_preserve_nested_native_model_ids() {
        let wire_model = "lm-stuidio/glm-4-7-flash/model-id";
        let selected = format!("9router/{wire_model}");
        let catalog = parse_catalog(
            &json!({"all":[{"id":"9router","name":"Custom provider",
                "env":["PRIVATE_TOKEN"],"options":{"apiKey":"fixture-secret"},
                "models":{wire_model:{"id":wire_model,"name":"Native model","variants":{"thinking":{}}}}
            }],"connected":["9router"]}),
            &json!({"model":selected,"provider":{"9router":{"options":{"apiKey":"fixture-secret"}}}}),
            None,
        ).unwrap();
        assert_eq!(catalog.models[0].id, selected);
        assert_eq!(catalog.default_model.as_deref(), Some(selected.as_str()));
        assert!(!serde_json::to_string(&catalog)
            .unwrap()
            .contains("fixture-secret"));
        assert!(!serde_json::to_string(&catalog)
            .unwrap()
            .contains("PRIVATE_TOKEN"));
        let mut req = request();
        req.model = selected;
        let options = AiAgentOptions {
            effort: Some("thinking".into()),
            ..Default::default()
        };
        validate_model_effort(&req, &options, &catalog).unwrap();
        let prompt = prompt_body(&req, &options).unwrap();
        assert_eq!(
            prompt["model"],
            json!({"providerID":"9router","modelID":wire_model})
        );
        assert_eq!(prompt["variant"], "thinking");
    }

    #[test]
    fn variants_are_native_strings_and_unknown_controls_fail_before_a_prompt() {
        let catalog = parse_catalog(&provider_catalog(), &json!({}), None).unwrap();
        let options = AiAgentOptions {
            effort: Some("creative-mode".into()),
            ..Default::default()
        };
        let mut req = request();
        validate_model_effort(&req, &options, &catalog).unwrap();
        assert_eq!(
            prompt_body(&req, &options).unwrap()["variant"],
            "creative-mode"
        );
        assert!(prompt_body(&req, &AiAgentOptions::default())
            .unwrap()
            .get("variant")
            .is_none());
        let unknown = AiAgentOptions {
            effort: Some("unsupported".into()),
            ..Default::default()
        };
        assert!(validate_model_effort(&req, &unknown, &catalog).is_err());
        req.model = "default".into();
        assert!(validate_model_effort(&req, &options, &catalog).is_err());
        req.model = "custom/unlisted".into();
        assert!(validate_model_effort(&req, &options, &catalog).is_err());
        assert!(validate_options(&AiAgentOptions {
            fast_mode: true,
            ..Default::default()
        })
        .is_err());
        assert!(validate_options(&AiAgentOptions {
            service_tier: Some("fast".into()),
            ..Default::default()
        })
        .is_err());
        assert!(parse_catalog(&json!({"all":[]}), &json!({}), None).is_err());
        assert!(
            parse_catalog(&json!({"all":[],"connected":[]}), &json!({}), None)
                .unwrap()
                .models
                .is_empty()
        );
    }

    #[test]
    fn isolated_config_and_last_permission_rule_disable_host_tools() {
        let home = Path::new("/private/tmp/kubepit-fixture");
        let config = isolated_config(home);
        let expected = json!({"*":"deny", "external_directory":{
            "/private/tmp/kubepit-fixture/data/opencode/tool-output/*":"deny"
        }});
        assert_eq!(config["agent"][AGENT]["permission"], expected);
        assert_eq!(config["permission"], expected);
        assert_eq!(config["instructions"], json!([]));
        assert_eq!(config["plugin"], json!([]));
        assert_eq!(config["share"], "disabled");
        assert!(verify_permissions(&deny_rules()).is_ok());
        assert!(verify_permissions(&json!([])).is_err());
        assert!(verify_permissions(&json!([
            {"permission":"*","pattern":"*","action":"deny"},
            {"permission":"bash","pattern":"*","action":"allow"}
        ]))
        .is_err());
        assert!(verify_agent(&json!([{"name":AGENT,"permission":deny_rules()}])).is_ok());
        assert!(verify_agent(&json!([{"name":"build","permission":deny_rules()}])).is_err());
    }

    #[test]
    fn native_agent_startup_directory_exception_is_denied_without_relaxing_permissions() {
        // Actual modern /agent rule ordering: native defaults precede global
        // and agent overrides; without the exact glob denial OpenCode appends
        // an allow for truncated output after the universal denial.
        let mut rules = json!([
            {"permission":"*","pattern":"*","action":"allow"},
            {"permission":"doom_loop","pattern":"*","action":"ask"},
            {"permission":"external_directory","pattern":"*","action":"ask"},
            {"permission":"external_directory","pattern":"/fixture/data/opencode/tool-output/*","action":"allow"},
            {"permission":"read","pattern":"*","action":"allow"},
            {"permission":"read","pattern":"*.env","action":"ask"},
            {"permission":"*","pattern":"*","action":"deny"},
            {"permission":"external_directory","pattern":"/fixture/data/opencode/tool-output/*","action":"deny"},
            {"permission":"*","pattern":"*","action":"deny"},
            {"permission":"external_directory","pattern":"/fixture/data/opencode/tool-output/*","action":"deny"}
        ]);
        assert!(verify_agent(&json!([{"name":AGENT,"permission":rules}])).is_ok());
        let suffix = rules.as_array_mut().unwrap().last_mut().unwrap();
        suffix["action"] = json!("allow");
        assert!(verify_permissions(&rules).is_err());
        rules.as_array_mut().unwrap().last_mut().unwrap()["action"] = json!("ask");
        assert!(verify_permissions(&rules).is_err());
        rules.as_array_mut().unwrap().last_mut().unwrap()["action"] = json!("unknown");
        assert!(verify_permissions(&rules).is_err());
        assert!(
            verify_permissions(&json!([{"permission":"read","pattern":"*","action":"deny"}]))
                .is_err()
        );
        assert!(verify_permissions(
            &json!([{"permission":"*","pattern":"*","action":"deny"},{"action":"deny"}])
        )
        .is_err());
    }

    #[test]
    fn prompt_is_literal_and_rejects_tools_and_tool_histories() {
        let mut req = request();
        let body = prompt_body(&req, &AiAgentOptions::default()).unwrap();
        assert_eq!(
            body["model"],
            json!({"providerID":"openai","modelID":"fixture"})
        );
        assert!(body.get("command").is_none());
        assert_eq!(body["tools"]["*"], false);
        let embedded: Value =
            serde_json::from_str(body["parts"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            embedded["messages"][0]["content"][0]["text"],
            "Fixture prompt"
        );
        req.tools.push(ToolSpec {
            name: "fixture",
            description: "fixture",
            schema: json!({}),
        });
        assert!(prompt_body(&req, &AiAgentOptions::default()).is_err());
        req.tools.clear();
        req.messages = vec![ChatMessage::User(vec![UserBlock::ToolResult {
            call_id: "a".into(),
            content: "b".into(),
            is_error: false,
        }])];
        assert!(prompt_body(&req, &AiAgentOptions::default()).is_err());
        let mut turn = OpenCodeOutput::new("ses_fixture".into(), "fixture".into(), 100).finish();
        turn.tool_calls.push(ToolCallReq {
            id: "a".into(),
            name: "fixture".into(),
            input: Ok(json!({})),
        });
        req.messages = vec![ChatMessage::Assistant(turn)];
        assert!(prompt_body(&req, &AiAgentOptions::default()).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn private_home_links_only_native_auth_and_cleanup_keeps_original() {
        use std::os::unix::fs::PermissionsExt;
        let source = tempfile::tempdir().unwrap();
        let auth = source.path().join("auth.json");
        std::fs::write(
            &auth,
            r#"{"fixture":{"type":"oauth","access":"fixture-secret"}}"#,
        )
        .unwrap();
        validate_native_auth(&auth).unwrap();
        let home = IsolatedHome::create(Some(&auth)).unwrap();
        assert_eq!(
            std::fs::metadata(home.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let link = home.path().join("data/opencode/auth.json");
        assert_eq!(std::fs::read_link(link).unwrap(), auth);
        let mut command = Command::new("fixture");
        command.env_clear();
        configure_command(&mut command, home.path(), "fixture-password");
        let env: BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.unwrap().to_string_lossy().into_owned(),
                )
            })
            .collect();
        assert_eq!(Path::new(&env["HOME"]), home.path());
        assert_eq!(env["OPENCODE_PURE"], "1");
        assert_eq!(env["OPENCODE_DISABLE_PROJECT_CONFIG"], "1");
        let permission: Value = serde_json::from_str(&env["OPENCODE_PERMISSION"]).unwrap();
        let config: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(permission, config["permission"]);
        assert_eq!(permission, config["agent"][AGENT]["permission"]);
        assert_eq!(
            permission["external_directory"][home
                .path()
                .join("data/opencode/tool-output/*")
                .to_string_lossy()
                .as_ref()],
            "deny"
        );
        assert!(!env.contains_key("KUBECONFIG"));
        assert!(!env.contains_key("OPENCODE_AUTH_CONTENT"));
        let path = home.path().to_path_buf();
        drop(home);
        assert!(!path.exists());
        assert!(auth.is_file());
        std::fs::write(
            &auth,
            r#"{"fixture":{"type":"wellknown","token":"never-print-me"}}"#,
        )
        .unwrap();
        let error = validate_native_auth(&auth).unwrap_err();
        assert!(!error.to_string().contains("never-print-me"));
    }

    fn event(kind: &str, properties: Value) -> Value {
        json!({"type":kind,"properties":properties})
    }

    #[test]
    fn streaming_preserves_order_usage_and_keeps_reasoning_out_of_answer() {
        let mut output = OpenCodeOutput::new("ses_fixture".into(), "fixture".into(), 100);
        let events = parking_lot::Mutex::new(Vec::new());
        let sink = |event| events.lock().push(event);
        output.event(&event("message.updated", json!({"info":{"sessionID":"ses_fixture","id":"msg","role":"assistant","modelID":"resolved-model","tokens":{"input":7,"output":3,"cache":{"read":2}}}})), &sink).unwrap();
        output
            .event(
                &event(
                    "message.part.updated",
                    json!({"part":{"id":"z","messageID":"msg","type":"text","text":"First "}}),
                ),
                &sink,
            )
            .unwrap();
        output
            .event(
                &event(
                    "message.part.updated",
                    json!({"part":{"id":"r","messageID":"msg","type":"reasoning","text":"hidden"}}),
                ),
                &sink,
            )
            .unwrap();
        output
            .event(
                &event(
                    "message.part.delta",
                    json!({"partID":"r","messageID":"msg","field":"text","delta":"also hidden"}),
                ),
                &sink,
            )
            .unwrap();
        output
            .event(
                &event(
                    "message.part.updated",
                    json!({"part":{"id":"a","messageID":"msg","type":"text","text":"second"}}),
                ),
                &sink,
            )
            .unwrap();
        output
            .event(
                &event(
                    "message.part.delta",
                    json!({"partID":"a","messageID":"msg","field":"text","delta":"."}),
                ),
                &sink,
            )
            .unwrap();
        let turn = output.finish();
        assert_eq!(turn.text, "First second.");
        assert_eq!(turn.model, "resolved-model");
        assert_eq!(turn.usage.input_tokens, 7);
        assert_eq!(turn.usage.cache_read_tokens, 2);
        let streamed: String = events
            .lock()
            .iter()
            .filter_map(|event| match event {
                StreamEvent::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(streamed, turn.text);
        assert!(turn.tool_calls.is_empty());
    }

    #[test]
    fn streams_refuse_tools_and_bound_unicode_answers() {
        let mut output = OpenCodeOutput::new("s".into(), "m".into(), 4);
        output
            .event(
                &event(
                    "message.updated",
                    json!({"info":{"id":"m","role":"assistant"}}),
                ),
                &|_| {},
            )
            .unwrap();
        assert!(output
            .event(
                &event(
                    "message.part.updated",
                    json!({"part":{"id":"p","messageID":"m","type":"text","text":"şğüıçö"}})
                ),
                &|_| {}
            )
            .unwrap());
        assert_eq!(output.finish().text, "şğüı");
        assert_eq!(output.finish().stop, StopReason::MaxTokens);
        let error = output
            .event(
                &event(
                    "message.part.updated",
                    json!({"part":{"id":"tool","messageID":"m","type":"tool","tool":"bash"}}),
                ),
                &|_| {},
            )
            .unwrap_err();
        assert_eq!(error.partial.unwrap().text, "şğüı");
    }

    #[test]
    fn final_usage_model_keeps_the_native_provider_prefix_for_pricing() {
        let mut output = OpenCodeOutput::new("s".into(), "default".into(), 100);
        output.event(&event("message.updated", json!({"info":{"id":"m","role":"assistant","providerID":"openai","modelID":"fixture"}})), &|_|{}).unwrap();
        assert_eq!(output.finish().model, "openai/fixture");
    }

    #[tokio::test]
    async fn cursor_and_remote_disabled_opencode_never_start_a_process() {
        assert!(OpenCodeCliProvider::new(
            AiProviderKind::CursorCli,
            AiTimeouts::default(),
            Egress::default()
        )
        .is_err());
        let provider = OpenCodeCliProvider::new(
            AiProviderKind::OpencodeCli,
            AiTimeouts::default(),
            Egress::default(),
        )
        .unwrap();
        assert_eq!(
            provider.list_models().await.unwrap_err().kind,
            ProviderErrorKind::EgressRefused
        );
        assert_eq!(
            provider
                .chat(&request(), &|_| {}, &CancellationToken::new())
                .await
                .unwrap_err()
                .kind,
            ProviderErrorKind::EgressRefused
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn model_discovery_reads_only_native_metadata_endpoints() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let fixture = tokio::spawn(async move {
            let mut paths = Vec::new();
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    let mut chunk = [0; 1024];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(count, 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    assert!(bytes.len() < 8192);
                }
                let headers = String::from_utf8(bytes).unwrap();
                let line = headers.lines().next().unwrap();
                let path = match line {
                    "GET /provider HTTP/1.1" => "/provider",
                    "GET /config HTTP/1.1" => "/config",
                    other => panic!("discovery made a non-metadata request: {other}"),
                };
                let body = if path == "/provider" {
                    provider_catalog()
                } else {
                    json!({"model":"openai/fixture"})
                }
                .to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
                paths.push(path);
            }
            paths.sort();
            paths
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read ignored"]);
        let base = format!("http://{address}");
        let server = Server {
            client: super::super::provider::http_client(&AiTimeouts::default(), &base).unwrap(),
            base,
            password: "fixture-password".into(),
            process: OwnedServer::spawn(command).unwrap(),
        };
        let catalog = tokio::time::timeout(
            Duration::from_secs(3),
            server.catalog(Some("fixture-version".into())),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(catalog.models[0].id, "openai/fixture");
        assert_eq!(catalog.version.as_deref(), Some("fixture-version"));
        assert_eq!(fixture.await.unwrap(), ["/config", "/provider"]);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn native_http_handshake_sends_auth_and_verified_permissions_before_prompt() {
        use base64::Engine;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let prompt = prompt_body(&request(), &AiAgentOptions::default()).unwrap();
        let expected_prompt = prompt.clone();
        let fixture = tokio::spawn(async move {
            for (method, path, response_body, expected_body) in [
                ("GET", "/global/health", json!({"healthy":true}), None),
                (
                    "GET",
                    "/agent",
                    json!([{"name":AGENT,"permission":[
                        {"permission":"*","pattern":"*","action":"allow"},
                        {"permission":"*","pattern":"*","action":"deny"},
                        {"permission":"external_directory","pattern":"/fixture/data/opencode/tool-output/*","action":"deny"}
                    ]}]),
                    None,
                ),
                (
                    "POST",
                    "/session",
                    json!({"id":"ses_fixture","permission":deny_rules()}),
                    Some(json!({"permission":deny_rules()})),
                ),
                (
                    "POST",
                    "/session/ses_fixture/prompt_async",
                    Value::Null,
                    Some(expected_prompt),
                ),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (header_end, content_length) = loop {
                    let mut chunk = [0; 1024];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(count, 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        assert_eq!(
                            headers.lines().next().unwrap(),
                            format!("{method} {path} HTTP/1.1")
                        );
                        let basic = base64::engine::general_purpose::STANDARD
                            .encode("kubepit:fixture-password");
                        assert!(headers.lines().any(|line| line
                            .eq_ignore_ascii_case(&format!("authorization: Basic {basic}"))));
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        break (end + 4, length);
                    }
                    assert!(bytes.len() < 32 * 1024);
                };
                while bytes.len() < header_end + content_length {
                    let mut chunk = [0; 1024];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(count, 0);
                    bytes.extend_from_slice(&chunk[..count]);
                }
                if let Some(expected) = expected_body {
                    let actual: Value =
                        serde_json::from_slice(&bytes[header_end..header_end + content_length])
                            .unwrap();
                    assert_eq!(actual, expected);
                }
                let response = if response_body.is_null() {
                    "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    let body = response_body.to_string();
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        // This is an owned fixture process, never an installed CLI. Its only
        // purpose is to exercise the server owner's lifetime alongside HTTP.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read ignored"]);
        let server = Server {
            base: format!("http://{address}"),
            client: super::super::provider::http_client(
                &AiTimeouts::default(),
                &format!("http://{address}"),
            )
            .unwrap(),
            password: "fixture-password".into(),
            process: OwnedServer::spawn(command).unwrap(),
        };
        server.ready(Duration::from_secs(1)).await.unwrap();
        let agents = server.json("GET", "/agent", None).await.unwrap();
        verify_agent(&agents).unwrap();
        let session = server
            .json("POST", "/session", Some(json!({"permission":deny_rules()})))
            .await
            .unwrap();
        verify_permissions(&session["permission"]).unwrap();
        assert_eq!(
            server
                .json("POST", "/session/ses_fixture/prompt_async", Some(prompt))
                .await
                .unwrap(),
            Value::Null
        );
        fixture.await.unwrap();
    }
}
