//! Import native provider configuration as data, never native integrations.
//!
//! A fresh home prevents OpenCode from loading plugins, instructions and host
//! tools, but it must not erase the user's provider endpoints and model catalog.
//! Only provider/model fields cross that boundary. Credentials stay private to
//! the child process; neither the source documents nor substituted values are
//! logged, written to configuration files, or returned through the catalog.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tokio::process::Command;

use super::{bad_request, ProviderError, MAX_METADATA_BYTES};

const MAX_INLINE_BYTES: usize = 96 * 1024;
const FIELDS: &[&str] = &[
    "provider",
    "model",
    "small_model",
    "enabled_providers",
    "disabled_providers",
];

// Native built-in providers may be connected by environment alone, without an
// auth.json entry or a provider block. These are credential/endpoint data names
// used by the installed native catalog. Never inherit process startup settings,
// cloud credential-file locations, profiles, or executable credential chains.
const NATIVE_PROVIDER_ENV: &[&str] = &[
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENCODE_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPINFRA_API_KEY",
    "DEEPSEEK_API_KEY",
    "CEREBRAS_API_KEY",
    "COHERE_API_KEY",
    "TOGETHER_API_KEY",
    "PERPLEXITY_API_KEY",
    "DASHSCOPE_API_KEY",
    "ALIBABA_CODING_PLAN_API_KEY",
    "ALIBABA_TOKEN_PLAN_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "ZHIPU_API_KEY",
    "AZURE_API_KEY",
    "AZURE_RESOURCE_NAME",
    "AZURE_COGNITIVE_SERVICES_API_KEY",
    "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "HF_TOKEN",
    "FIREWORKS_API_KEY",
    "VENICE_API_KEY",
    "AI_GATEWAY_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_GATEWAY_ID",
    "LMSTUDIO_API_KEY",
    "OLLAMA_API_KEY",
    "NVIDIA_API_KEY",
    "SILICONFLOW_API_KEY",
    "SILICONFLOW_CN_API_KEY",
    "NEBIUS_API_KEY",
    "NOVITA_API_KEY",
    "V0_API_KEY",
    "SUBCONSCIOUS_API_KEY",
    "SYNTHETIC_API_KEY",
];

// These are compiled into the supported OpenCode CLI. An arbitrary npm spec,
// even under --pure, would be installed and imported as executable code.
const BUNDLED_SDKS: &[&str] = &[
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/amazon-bedrock/mantle",
    "@ai-sdk/anthropic",
    "@ai-sdk/azure",
    "@ai-sdk/google",
    "@ai-sdk/google-vertex",
    "@ai-sdk/google-vertex/anthropic",
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/xai",
    "@ai-sdk/mistral",
    "@ai-sdk/groq",
    "@ai-sdk/deepinfra",
    "@ai-sdk/cerebras",
    "@ai-sdk/cohere",
    "@ai-sdk/gateway",
    "@ai-sdk/togetherai",
    "@ai-sdk/perplexity",
    "@ai-sdk/vercel",
    "@ai-sdk/alibaba",
    "@ai-sdk/github-copilot",
    "@openrouter/ai-sdk-provider",
    "gitlab-ai-provider",
    "venice-ai-sdk-provider",
];

// Provider options configure SDK construction, unlike model options/variants
// which are HTTP request data. Keep common SDK connection settings and inline
// credentials; reject unknown construction controls rather than importing a
// credential process, filesystem path, fetch implementation or custom agent.
const PROVIDER_OPTIONS: &[&str] = &[
    "apiKey",
    "baseURL",
    "headers",
    "name",
    "timeout",
    "headerTimeout",
    "chunkTimeout",
    "setCacheKey",
    "enterpriseUrl",
    "compatibility",
    "includeUsage",
    "supportsStructuredOutputs",
    "useCompletionUrls",
    "strictJsonSchema",
    "region",
    "location",
    "project",
    "resourceName",
    "apiVersion",
    "useDeploymentBasedUrls",
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
    "accountId",
    "gateway",
    "url",
    "organization",
    "projectId",
];

pub(super) struct NativeConfig {
    pub(super) value: Value,
    environment: Vec<(String, OsString)>,
}

impl NativeConfig {
    pub(super) fn load() -> Result<Self, ProviderError> {
        let environment: BTreeMap<String, String> = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        let home = dirs::home_dir();
        let cwd = std::env::current_dir().map_err(|_| invalid())?;
        Self::from_sources(home.as_deref(), &cwd, &environment)
    }

    fn from_sources(
        home: Option<&Path>,
        cwd: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Self, ProviderError> {
        let config_home = environment
            .get("XDG_CONFIG_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.map(|path| path.join(".config")));
        let mut files = Vec::new();
        if let Some(root) = config_home {
            for name in ["config.json", "opencode.json", "opencode.jsonc"] {
                files.push((root.join("opencode").join(name), false));
            }
        }
        if let Some(path) = environment
            .get("OPENCODE_CONFIG")
            .filter(|value| !value.is_empty())
        {
            files.push((absolute(cwd, path), true));
        }
        // OpenCode searches the user's ~/.opencode directory even when project
        // configuration is disabled. No project ancestors are traversed here.
        let mut directories = Vec::new();
        if let Some(home) = home {
            directories.push(home.join(".opencode"));
        }
        if let Some(path) = environment
            .get("OPENCODE_CONFIG_DIR")
            .filter(|value| !value.is_empty())
        {
            directories.push(absolute(cwd, path));
        }
        for directory in directories {
            for name in ["opencode.json", "opencode.jsonc"] {
                files.push((directory.join(name), false));
            }
        }
        let mut budget = MAX_METADATA_BYTES;
        let mut layers = Vec::new();
        for (path, required) in files {
            let Some(text) = read_text(&path, &mut budget, required)? else {
                continue;
            };
            layers.push((
                parse_document(&text)?,
                path.parent().unwrap_or(cwd).to_owned(),
            ));
        }
        if let Some(text) = environment
            .get("OPENCODE_CONFIG_CONTENT")
            .filter(|value| !value.is_empty())
        {
            consume(&mut budget, text.len())?;
            layers.push((parse_document(text)?, cwd.to_owned()));
        }
        // Resolve selectors across all layers first. A disabled legacy provider
        // must not require its missing credentials, SDK or host-only options to
        // be loaded just to list an unrelated active provider.
        let mut selectors = json!({});
        for (source, directory) in &layers {
            let fields: Map<_, _> = source
                .iter()
                .filter(|(key, _)| {
                    matches!(key.as_str(), "enabled_providers" | "disabled_providers")
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            merge(
                &mut selectors,
                project_value(&fields, directory, home, environment, &mut budget, None)?,
            );
        }
        let filter = ProviderFilter::from(&selectors)?;
        let mut value = selectors;
        for (source, directory) in layers {
            merge(
                &mut value,
                project_value(
                    &source,
                    &directory,
                    home,
                    environment,
                    &mut budget,
                    Some(&filter),
                )?,
            );
        }
        Self::prepare(value, environment)
    }

    fn prepare(
        mut value: Value,
        source_env: &BTreeMap<String, String>,
    ) -> Result<Self, ProviderError> {
        let mut environment: Vec<(String, OsString)> = NATIVE_PROVIDER_ENV
            .iter()
            .filter_map(|name| {
                source_env
                    .get(*name)
                    .filter(|value| !value.is_empty())
                    .map(|value| ((*name).to_string(), OsString::from(value)))
            })
            .collect();
        let filter = ProviderFilter::from(&value)?;
        if let Some(providers) = value.get_mut("provider") {
            let providers = providers.as_object_mut().ok_or_else(invalid)?;
            providers.retain(|id, _| filter.active(id));
            for provider in providers.values_mut() {
                let provider = provider.as_object_mut().ok_or_else(invalid)?;
                validate_sdk(provider.get("npm"))?;
                protect_endpoint(provider.get_mut("api"), &mut environment)?;
                if let Some(options) = provider.get_mut("options").and_then(Value::as_object_mut) {
                    protect_endpoint(options.get_mut("baseURL"), &mut environment)?;
                }
                if let Some(options) = provider.get("options") {
                    let options = options.as_object().ok_or_else(invalid)?;
                    if options
                        .keys()
                        .any(|key| !PROVIDER_OPTIONS.contains(&key.as_str()))
                    {
                        return Err(bad_request("OpenCode provider options require unsupported host access; use API-key or OAuth provider settings"));
                    }
                    for (key, value) in options {
                        if key == "headers" {
                            if !value
                                .as_object()
                                .is_some_and(|headers| headers.values().all(Value::is_string))
                            {
                                return Err(invalid());
                            }
                        } else if value.is_object() || value.is_array() {
                            return Err(bad_request("OpenCode provider options require unsupported host access; use API-key or OAuth provider settings"));
                        }
                    }
                }
                if let Some(models) = provider.get_mut("models") {
                    for model in models.as_object_mut().ok_or_else(invalid)?.values_mut() {
                        validate_sdk(model.get("provider").and_then(|value| value.get("npm")))?;
                        protect_endpoint(
                            model
                                .get_mut("provider")
                                .and_then(|value| value.get_mut("api")),
                            &mut environment,
                        )?;
                    }
                }
                if let Some(keys) = provider.get_mut("env") {
                    let keys = keys.as_array_mut().ok_or_else(invalid)?;
                    for key in keys {
                        let source = key.as_str().ok_or_else(invalid)?;
                        let name = format!("KUBEPIT_OPENCODE_PROVIDER_{}", environment.len());
                        // Rename provider credential variables. Passing the
                        // original name could enable NODE_OPTIONS, hooks or a
                        // different HOME before OpenCode even reads the config.
                        let secret = source_env.get(source).cloned().unwrap_or_default();
                        environment.push((name.clone(), OsString::from(secret)));
                        *key = Value::String(name);
                    }
                }
            }
        }
        Ok(Self { value, environment })
    }

    pub(super) fn apply(&self, command: &mut Command, safety: Value) -> Result<(), ProviderError> {
        let mut value = self.value.clone();
        merge(&mut value, safety);
        // OpenCode expands references in the raw JSON before parsing it. Escape
        // braces so credential contents cannot trigger a second substitution.
        let encoded = escape_string_braces(&value)?;
        if encoded.len() > MAX_INLINE_BYTES {
            return Err(bad_request("OpenCode provider configuration is too large"));
        }
        command.envs(self.environment.iter().map(|(key, value)| (key, value)));
        command.env("OPENCODE_CONFIG_CONTENT", encoded);
        Ok(())
    }
}

fn escape_string_braces(value: &Value) -> Result<String, ProviderError> {
    let text = serde_json::to_string(value).map_err(|_| invalid())?;
    let mut result = String::with_capacity(text.len());
    let mut quoted = false;
    let mut escaped = false;
    for character in text.chars() {
        if character == '"' && !escaped {
            quoted = !quoted;
        }
        if quoted && character == '{' {
            result.push_str("\\u007b");
        } else {
            result.push(character);
        }
        escaped = !escaped && character == '\\';
    }
    Ok(result)
}

fn validate_sdk(value: Option<&Value>) -> Result<(), ProviderError> {
    if let Some(value) = value {
        if !value
            .as_str()
            .is_some_and(|sdk| BUNDLED_SDKS.contains(&sdk))
        {
            return Err(bad_request("OpenCode provider SDK is not bundled; external provider packages cannot run with Assistant permissions"));
        }
    }
    Ok(())
}

fn protect_endpoint(
    value: Option<&mut Value>,
    environment: &mut Vec<(String, OsString)>,
) -> Result<(), ProviderError> {
    let Some(value) = value else { return Ok(()) };
    let text = value.as_str().ok_or_else(invalid)?;
    // Native SDK endpoint expansion is a separate ${NAME} pass, after config
    // parsing. Preserve unresolved variables and reference-like secret values
    // as literal data with one synthetic indirection, never re-interpret them.
    if text.contains("${") {
        let name = format!("KUBEPIT_OPENCODE_ENDPOINT_{}", environment.len());
        environment.push((name.clone(), text.into()));
        *value = Value::String(format!("${{{name}}}"));
    } else if !text.is_empty() && !text.starts_with("https://") && !text.starts_with("http://") {
        return Err(invalid());
    }
    Ok(())
}

fn endpoint_path(path: &[String]) -> bool {
    match path {
        [root, _, api] => root == "provider" && api == "api",
        [root, _, options, base] => root == "provider" && options == "options" && base == "baseURL",
        [root, _, models, _, provider, api] => {
            root == "provider" && models == "models" && provider == "provider" && api == "api"
        }
        _ => false,
    }
}

fn parse_document(text: &str) -> Result<Map<String, Value>, ProviderError> {
    let parsed: Value = serde_json::from_str(&jsonc(text)?).map_err(|_| invalid())?;
    match parsed {
        Value::Object(source) => Ok(source),
        _ => Err(invalid()),
    }
}

struct ProviderFilter {
    enabled: Option<BTreeSet<String>>,
    disabled: BTreeSet<String>,
}

impl ProviderFilter {
    fn from(value: &Value) -> Result<Self, ProviderError> {
        fn ids(value: Option<&Value>) -> Result<Option<BTreeSet<String>>, ProviderError> {
            value
                .map(|value| {
                    value
                        .as_array()
                        .ok_or_else(invalid)?
                        .iter()
                        .map(|id| {
                            id.as_str()
                                .filter(|id| !id.is_empty())
                                .map(str::to_string)
                                .ok_or_else(invalid)
                        })
                        .collect()
                })
                .transpose()
        }
        Ok(Self {
            enabled: ids(value.get("enabled_providers"))?,
            disabled: ids(value.get("disabled_providers"))?.unwrap_or_default(),
        })
    }

    fn active(&self, id: &str) -> bool {
        !self.disabled.contains(id)
            && self
                .enabled
                .as_ref()
                .is_none_or(|enabled| enabled.contains(id))
    }
}

#[cfg(test)]
fn project(
    text: &str,
    directory: &Path,
    home: Option<&Path>,
    environment: &BTreeMap<String, String>,
    budget: &mut usize,
) -> Result<Value, ProviderError> {
    project_value(
        &parse_document(text)?,
        directory,
        home,
        environment,
        budget,
        None,
    )
}

fn project_value(
    source: &Map<String, Value>,
    directory: &Path,
    home: Option<&Path>,
    environment: &BTreeMap<String, String>,
    budget: &mut usize,
    filter: Option<&ProviderFilter>,
) -> Result<Value, ProviderError> {
    let mut result = Map::new();
    for field in FIELDS {
        if filter.is_some() && matches!(*field, "enabled_providers" | "disabled_providers") {
            continue;
        }
        if let Some(value) = source.get(*field) {
            let mut value = value.clone();
            if *field == "provider" {
                if let Some(filter) = filter {
                    value
                        .as_object_mut()
                        .ok_or_else(invalid)?
                        .retain(|id, _| filter.active(id));
                }
            }
            substitute(
                &mut value,
                directory,
                home,
                environment,
                budget,
                &mut vec![(*field).to_string()],
            )?;
            result.insert((*field).to_string(), value);
        }
    }
    Ok(Value::Object(result))
}

fn substitute(
    value: &mut Value,
    directory: &Path,
    home: Option<&Path>,
    environment: &BTreeMap<String, String>,
    budget: &mut usize,
    path: &mut Vec<String>,
) -> Result<(), ProviderError> {
    match value {
        Value::String(text) => {
            // Scan the original string once. Secret contents are data, never
            // new reference instructions, even if they contain marker text.
            *text = references(text, endpoint_path(path), |kind, name| match kind {
                "env" | "url" => {
                    let value = environment.get(name).cloned().unwrap_or_else(|| {
                        if kind == "url" {
                            format!("${{{name}}}")
                        } else {
                            String::new()
                        }
                    });
                    consume(budget, value.len())?;
                    Ok(value)
                }
                _ => {
                    let path = if let Some(tail) = name.strip_prefix("~/") {
                        home.ok_or_else(invalid)?.join(tail)
                    } else {
                        absolute(directory, name)
                    };
                    read_text(&path, budget, true)?
                        .map(|text| text.trim().to_string())
                        .ok_or_else(invalid)
                }
            })?;
        }
        Value::Array(items) => {
            for item in items {
                path.push(String::new());
                substitute(item, directory, home, environment, budget, path)?;
                path.pop();
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                if matches!(key.as_str(), "__proto__" | "prototype" | "constructor") {
                    return Err(invalid());
                }
                path.push(key.clone());
                substitute(item, directory, home, environment, budget, path)?;
                path.pop();
            }
        }
        _ => {}
    }
    Ok(())
}

fn references(
    text: &str,
    endpoint: bool,
    mut lookup: impl FnMut(&str, &str) -> Result<String, ProviderError>,
) -> Result<String, ProviderError> {
    let mut result = String::new();
    let mut rest = text;
    while let Some((start, kind)) = [
        rest.find("{env:").map(|start| (start, "env")),
        rest.find("{file:").map(|start| (start, "file")),
        endpoint
            .then(|| rest.find("${").map(|start| (start, "url")))
            .flatten(),
    ]
    .into_iter()
    .flatten()
    .min_by_key(|(start, _)| *start)
    {
        let prefix = match kind {
            "env" => "{env:",
            "url" => "${",
            _ => "{file:",
        };
        let tail = &rest[start + prefix.len()..];
        let Some(end) = tail.find('}') else { break };
        result.push_str(&rest[..start]);
        result.push_str(&lookup(kind, &tail[..end])?);
        rest = &tail[end + 1..];
    }
    result.push_str(rest);
    Ok(result)
}

fn absolute(directory: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_owned()
    } else {
        directory.join(path)
    }
}

fn read_text(
    path: &Path,
    budget: &mut usize,
    required: bool,
) -> Result<Option<String>, ProviderError> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(bad_request(
                "could not read OpenCode provider configuration or its referenced credential file",
            ))
        }
    };
    if !metadata.is_file() {
        return Err(invalid());
    }
    if metadata.len() > *budget as u64 {
        return Err(bad_request("OpenCode provider configuration is too large"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Avoid hanging if a regular file is replaced by a FIFO after stat.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(bad_request(
                "could not read OpenCode provider configuration or its referenced credential file",
            ))
        }
    };
    if !file.metadata().map_err(|_| invalid())?.is_file() {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(*budget as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    consume(budget, bytes.len())?;
    String::from_utf8(bytes).map(Some).map_err(|_| invalid())
}

fn consume(budget: &mut usize, bytes: usize) -> Result<(), ProviderError> {
    *budget = budget
        .checked_sub(bytes)
        .ok_or_else(|| bad_request("OpenCode provider configuration is too large"))?;
    Ok(())
}

fn invalid() -> ProviderError {
    bad_request("OpenCode provider configuration is invalid")
}

fn merge(target: &mut Value, source: Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge(target.entry(key).or_insert(Value::Null), value);
            }
        }
        (target, source) => *target = source,
    }
}

/// JSONC permits comments and trailing commas, not JavaScript expressions.
/// Replace comments with whitespace so adjacent JSON tokens never coalesce.
fn jsonc(text: &str) -> Result<String, ProviderError> {
    let mut bytes = text.trim_start_matches('\u{feff}').as_bytes().to_vec();
    let mut quoted = false;
    let mut escaped = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if quoted {
            if byte == b'"' && !escaped {
                quoted = false;
            }
            escaped = !escaped && byte == b'\\';
            index += 1;
            continue;
        }
        if byte == b'"' {
            quoted = true;
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            while index < bytes.len() && bytes[index] != b'\n' {
                bytes[index] = b' ';
                index += 1;
            }
        } else if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            bytes[index] = b' ';
            bytes[index + 1] = b' ';
            index += 2;
            let mut closed = false;
            while index + 1 < bytes.len() {
                if bytes[index] == b'*' && bytes[index + 1] == b'/' {
                    bytes[index] = b' ';
                    bytes[index + 1] = b' ';
                    index += 2;
                    closed = true;
                    break;
                }
                if bytes[index] != b'\n' && bytes[index] != b'\r' {
                    bytes[index] = b' ';
                }
                index += 1;
            }
            if !closed {
                return Err(invalid());
            }
        } else {
            index += 1;
        }
    }
    quoted = false;
    escaped = false;
    for index in 0..bytes.len() {
        let byte = bytes[index];
        if quoted {
            if byte == b'"' && !escaped {
                quoted = false;
            }
            escaped = !escaped && byte == b'\\';
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b',' {
            let next = bytes[index + 1..]
                .iter()
                .find(|byte| !byte.is_ascii_whitespace());
            if matches!(next, Some(b'}' | b']')) {
                bytes[index] = b' ';
            }
        }
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn imports_native_custom_providers_defaults_limits_and_nested_model_ids() {
        let home = tempfile::tempdir().unwrap();
        write(
            &home.path().join(".config/opencode/opencode.jsonc"),
            r#"{
          // Provider names and wire model IDs belong to OpenCode, not Kubepit.
          "provider": {
            "hwc-maas": {
              "name": "Huawei Cloud - MaaS", "npm": "@ai-sdk/openai-compatible",
              "options": {"baseURL": "https://example.invalid/api/v1"},
              "models": {"glm-5.1": {"name": "GLM 5.1", "limit": {"context": 200000, "output": 8000},
                "variants": {"thinking": {"reasoningEffort": "high"}, "hidden": {"disabled": true}}}, "glm-5.2": {}}
            },
            "9router": {"npm": "@ai-sdk/openai-compatible", "models": {"lm-stuidio/glm-4-7-flash/model-id": {}}}
          },
          "model": "9router/lm-stuidio/glm-4-7-flash/model-id",
          "small_model": "hwc-maas/glm-5.1",
          "enabled_providers": ["hwc-maas", "9router",],
          "disabled_providers": ["unused"],
        }"#,
        );
        let native =
            NativeConfig::from_sources(Some(home.path()), home.path(), &BTreeMap::new()).unwrap();
        assert_eq!(
            native.value["model"],
            "9router/lm-stuidio/glm-4-7-flash/model-id"
        );
        assert!(native.value["provider"]["9router"]["models"]
            .get("lm-stuidio/glm-4-7-flash/model-id")
            .is_some());
        assert_eq!(
            native.value["provider"]["hwc-maas"]["models"]["glm-5.1"]["variants"]["thinking"]
                ["reasoningEffort"],
            "high"
        );
        assert_eq!(
            native.value["provider"]["hwc-maas"]["models"]["glm-5.1"]["limit"]["context"],
            200000
        );
        assert_eq!(
            native.value["enabled_providers"].as_array().unwrap().len(),
            2
        );
        assert_eq!(native.value["small_model"], "hwc-maas/glm-5.1");
    }

    #[test]
    fn native_layers_merge_in_order_with_source_relative_credentials() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path();
        let root = path.join("config-root/opencode");
        write(
            &root.join("config.json"),
            r#"{"provider":{"custom":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://old.invalid","headers":{"X-Old":"retained"}},"models":{"old":{}}}},"model":"custom/old"}"#,
        );
        write(
            &root.join("opencode.json"),
            r#"{"provider":{"custom":{"models":{"new":{}}}},"model":"custom/new"}"#,
        );
        write(&root.join("token"), " fixture-global-secret\n");
        write(
            &root.join("opencode.jsonc"),
            r#"{"provider":{"custom":{"options":{"apiKey":"{file:token}"}}},"model":"custom/global-jsonc"}"#,
        );
        write(
            &path.join("explicit/config.json"),
            r#"{"provider":{"custom":{"options":{"baseURL":"https://explicit.invalid"}}},"model":"custom/explicit"}"#,
        );
        write(
            &path.join(".opencode/opencode.json"),
            r#"{"model":"custom/home-directory"}"#,
        );
        write(
            &path.join("override/opencode.json"),
            r#"{"model":"custom/directory-json"}"#,
        );
        write(
            &path.join("override/opencode.jsonc"),
            r#"{"model":"custom/directory-jsonc"}"#,
        );
        let env = BTreeMap::from([
            ("XDG_CONFIG_HOME".into(), path.join("config-root").to_string_lossy().into_owned()),
            ("OPENCODE_CONFIG".into(), "explicit/config.json".into()),
            ("OPENCODE_CONFIG_DIR".into(), "override".into()),
            ("OPENCODE_CONFIG_CONTENT".into(), r#"{"model":"custom/inline","provider":{"custom":{"options":{"headers":{"X-New":"last"}}}}}"#.into()),
        ]);
        let native = NativeConfig::from_sources(Some(path), path, &env).unwrap();
        let provider = &native.value["provider"]["custom"];
        assert_eq!(native.value["model"], "custom/inline");
        assert_eq!(provider["options"]["apiKey"], "fixture-global-secret");
        assert_eq!(provider["options"]["baseURL"], "https://explicit.invalid");
        assert_eq!(
            provider["options"]["headers"],
            json!({"X-Old":"retained","X-New":"last"})
        );
        assert_eq!(provider["models"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn final_native_provider_filters_skip_inactive_sdks_options_and_missing_credentials() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".config/opencode");
        write(
            &root.join("config.json"),
            r#"{
            "provider":{
                "hwc-maas":{"npm":"@ai-sdk/openai-compatible","models":{"glm-5.1":{},"glm-5.2":{}}},
                "legacy":{"npm":"file:///never-import.js","options":{"apiKey":"{file:/never-read-missing-credential}"}},
                "excluded":{"npm":"third-party-package","options":{"googleAuthOptions":{"keyFilename":"/never-open"}}}
            },
            "enabled_providers":["hwc-maas","legacy","excluded"]
        }"#,
        );
        write(
            &root.join("opencode.jsonc"),
            r#"{
            "enabled_providers":["hwc-maas","legacy"],
            "disabled_providers":["legacy"],
            "model":"hwc-maas/glm-5.2"
        }"#,
        );
        let native =
            NativeConfig::from_sources(Some(home.path()), home.path(), &BTreeMap::new()).unwrap();
        assert_eq!(
            native.value["provider"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["hwc-maas"]
        );
        assert_eq!(
            native.value["provider"]["hwc-maas"]["models"]
                .as_object()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(native.value["model"], "hwc-maas/glm-5.2");
        for invalid in [
            json!({"enabled_providers":"hwc-maas"}),
            json!({"disabled_providers":[false]}),
            json!({"enabled_providers":[""]}),
        ] {
            assert!(NativeConfig::prepare(invalid, &BTreeMap::new()).is_err());
        }
        let no_enabled = NativeConfig::prepare(
            json!({"enabled_providers":[],"provider":{"legacy":{"npm":"external-package"}}}),
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(no_enabled.value["provider"], json!({}));
    }

    #[test]
    fn resolves_only_provider_references_and_prevents_native_second_expansion() {
        let home = tempfile::tempdir().unwrap();
        write(
            &home.path().join("token"),
            "secret with \"quotes\" and {env:NEVER_RESOLVE}\n",
        );
        let text = r#"{
          "provider":{"custom":{"npm":"@ai-sdk/openai-compatible","env":["NODE_OPTIONS","SECOND_KEY"],
            "options":{"baseURL":"https://{env:FIXTURE_HOST}/v1","apiKey":"{file:~/token}","headers":{"X-Missing":"{env:MISSING}","X-Literal":"{env:REFERENCE_LIKE_SECRET}"}}}},
          "plugin":["untrusted-plugin", "{file:/missing-plugin-file}"],
          "instructions":["{file:/missing-instructions-file}"],
          "mcp":{"bad":{"command":["{file:/missing-command-file}"]}},
          "agent":{"build":{"prompt":"{file:/missing-prompt-file}"}}
        }"#;
        let env = BTreeMap::from([
            ("FIXTURE_HOST".into(), "example.invalid".into()),
            ("NODE_OPTIONS".into(), "fixture-env-secret".into()),
            ("SECOND_KEY".into(), "fixture-secondary".into()),
            ("NEVER_RESOLVE".into(), "must-not-appear".into()),
            (
                "REFERENCE_LIKE_SECRET".into(),
                "literal {file:/never-read-this-secret-path} {env:NEVER_RESOLVE}".into(),
            ),
        ]);
        let mut budget = MAX_METADATA_BYTES;
        let layer = project(text, home.path(), Some(home.path()), &env, &mut budget).unwrap();
        let native = NativeConfig::prepare(layer, &env).unwrap();
        assert_eq!(native.value.as_object().unwrap().len(), 1);
        assert_eq!(
            native.value["provider"]["custom"]["options"]["baseURL"],
            "https://example.invalid/v1"
        );
        assert_eq!(
            native.value["provider"]["custom"]["options"]["headers"]["X-Missing"],
            ""
        );
        assert_eq!(native.environment.len(), 2);
        assert_eq!(native.environment[0].0, "KUBEPIT_OPENCODE_PROVIDER_0");
        let mut command = Command::new("fixture-never-run");
        native
            .apply(&mut command, super::super::isolated_config(home.path()))
            .unwrap();
        let actual_env: BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.unwrap().to_string_lossy().into_owned(),
                )
            })
            .collect();
        assert!(!actual_env.contains_key("NODE_OPTIONS"));
        let content = &actual_env["OPENCODE_CONFIG_CONTENT"];
        assert!(!content.contains("{env:"));
        assert!(!content.contains("{file:"));
        assert!(!content.contains("must-not-appear"));
        assert!(!content.contains("untrusted-plugin"));
        let decoded: Value = serde_json::from_str(content).unwrap();
        assert_eq!(
            decoded["provider"]["custom"]["options"]["apiKey"],
            "secret with \"quotes\" and {env:NEVER_RESOLVE}"
        );
        assert_eq!(decoded["permission"]["*"], "deny");
        assert_eq!(
            decoded["provider"]["custom"]["options"]["headers"]["X-Literal"],
            "literal {file:/never-read-this-secret-path} {env:NEVER_RESOLVE}"
        );
        assert_eq!(decoded["plugin"], json!([]));
        assert_eq!(decoded["mcp"], json!({}));
    }

    #[test]
    fn rejects_external_provider_modules_at_both_levels_and_host_sdk_options() {
        for provider in [
            json!({"npm":"not-bundled-provider"}),
            json!({"npm":"file:///private/provider.js"}),
            json!({"npm":"@ai-sdk/openai-compatible", "models":{"custom":{"provider":{"npm":"file:///private/model.js"}}}}),
            json!({"npm":"@ai-sdk/openai-compatible", "options":{"fetch":"/private/fetch.js"}}),
            json!({"npm":"@ai-sdk/google-vertex", "options":{"googleAuthOptions":{"keyFilename":"/private/credentials"}}}),
        ] {
            assert!(NativeConfig::prepare(
                json!({"provider":{"custom":provider}}),
                &BTreeMap::new()
            )
            .is_err());
        }
    }

    #[test]
    fn native_environment_only_providers_keep_credentials_without_host_process_settings() {
        let source = BTreeMap::from([
            ("OPENAI_API_KEY".into(), "fixture-openai-secret".into()),
            (
                "ANTHROPIC_API_KEY".into(),
                "fixture-anthropic-secret".into(),
            ),
            (
                "GOOGLE_GENERATIVE_AI_API_KEY".into(),
                "fixture-gemini-secret".into(),
            ),
            ("NODE_OPTIONS".into(), "--require=/private/code.js".into()),
            (
                "GOOGLE_APPLICATION_CREDENTIALS".into(),
                "/private/credential-chain.json".into(),
            ),
            ("AWS_PROFILE".into(), "host-profile".into()),
            ("KUBECONFIG".into(), "/private/kubeconfig".into()),
        ]);
        let native = NativeConfig::prepare(json!({}), &source).unwrap();
        assert_eq!(native.environment.len(), 3);
        let mut command = Command::new("fixture-never-run");
        native
            .apply(
                &mut command,
                super::super::isolated_config(Path::new("/fixture")),
            )
            .unwrap();
        let environment: BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.unwrap().to_string_lossy().into_owned(),
                )
            })
            .collect();
        assert_eq!(environment["OPENAI_API_KEY"], "fixture-openai-secret");
        for forbidden in [
            "NODE_OPTIONS",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AWS_PROFILE",
            "KUBECONFIG",
        ] {
            assert!(!environment.contains_key(forbidden));
        }
        assert!(!environment["OPENCODE_CONFIG_CONTENT"].contains("fixture-openai-secret"));
    }

    #[test]
    fn native_endpoint_variables_resolve_without_reinterpreting_injected_text() {
        let home = tempfile::tempdir().unwrap();
        let source = BTreeMap::from([
            ("FIXTURE_HOST".into(), "example.invalid".into()),
            (
                "LITERAL_ENDPOINT".into(),
                "https://example.invalid/${OPENCODE_SERVER_PASSWORD}".into(),
            ),
        ]);
        let mut budget = MAX_METADATA_BYTES;
        let value = project(r#"{"provider":{
            "custom":{"npm":"@ai-sdk/openai-compatible","api":"https://${FIXTURE_HOST}/v1", "options":{"baseURL":"https://${FIXTURE_HOST}/custom"},
                "models":{"nested/model":{"provider":{"api":"https://${FIXTURE_HOST}/model"},"options":{"body":"${FIXTURE_HOST}"}}}},
            "literal":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"{env:LITERAL_ENDPOINT}"}},
            "missing":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://${MISSING_FIXTURE_HOST}/v1"}}
        }}"#, home.path(), Some(home.path()), &source, &mut budget).unwrap();
        let native = NativeConfig::prepare(value, &source).unwrap();
        assert_eq!(
            native.value["provider"]["custom"]["api"],
            "https://example.invalid/v1"
        );
        assert_eq!(
            native.value["provider"]["custom"]["options"]["baseURL"],
            "https://example.invalid/custom"
        );
        assert_eq!(
            native.value["provider"]["custom"]["models"]["nested/model"]["provider"]["api"],
            "https://example.invalid/model"
        );
        assert_eq!(
            native.value["provider"]["custom"]["models"]["nested/model"]["options"]["body"],
            "${FIXTURE_HOST}"
        );
        assert!(native.value["provider"]["literal"]["options"]["baseURL"]
            .as_str()
            .unwrap()
            .starts_with("${KUBEPIT_OPENCODE_ENDPOINT_"));
        assert!(native
            .environment
            .iter()
            .any(|(_, value)| value == "https://example.invalid/${OPENCODE_SERVER_PASSWORD}"));
        assert!(native
            .environment
            .iter()
            .any(|(_, value)| value == "https://${MISSING_FIXTURE_HOST}/v1"));
    }

    #[test]
    fn jsonc_comments_trailing_commas_urls_escapes_and_invalid_input() {
        let valid = r#"{
          "url":"https://example.invalid/a//b", /* comments between tokens */
          "text":"escaped \\\"quote\\\" // is still a string",
          "array":[1, /* nested */ 2,],
        }"#;
        let parsed: Value = serde_json::from_str(&jsonc(valid).unwrap()).unwrap();
        assert_eq!(parsed["url"], "https://example.invalid/a//b");
        assert_eq!(parsed["array"], json!([1, 2]));
        assert!(jsonc("{/* unterminated").is_err());
        for invalid in ["{bad:1}", "{\"x\":'single'}", "{\"x\":1/*gap*/2}"] {
            assert!(serde_json::from_str::<Value>(&jsonc(invalid).unwrap()).is_err());
        }
    }

    #[test]
    fn failures_are_bounded_and_never_include_secret_source_content() {
        let home = tempfile::tempdir().unwrap();
        let mut budget = 4;
        write(&home.path().join("secret"), "fixture-private-secret");
        let error = read_text(&home.path().join("secret"), &mut budget, true).unwrap_err();
        assert!(!error.message.contains("fixture-private-secret"));
        let mut budget = MAX_METADATA_BYTES;
        let error = project(
            r#"{"provider":{"custom":{"options":{"apiKey":"fixture-private-secret"}},"broken": }"#,
            home.path(),
            Some(home.path()),
            &BTreeMap::new(),
            &mut budget,
        )
        .unwrap_err();
        assert!(!error.message.contains("fixture-private-secret"));
        let native = NativeConfig::prepare(
            json!({"provider":{"custom":{"options":{"apiKey":"x".repeat(MAX_INLINE_BYTES)}}}}),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(native
            .apply(&mut Command::new("fixture-never-run"), json!({}))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_non_regular_reference_files_without_opening_them() {
        use std::os::unix::ffi::OsStrExt;
        let home = tempfile::tempdir().unwrap();
        let fifo = home.path().join("credential-fifo");
        let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: a valid nul-terminated private fixture path; no descriptor is
        // opened. Opening this FIFO for blocking reads would hang the test.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(read_text(&fifo, &mut 1024, true).is_err());
        assert!(read_text(home.path(), &mut 1024, true).is_err());
    }
}
