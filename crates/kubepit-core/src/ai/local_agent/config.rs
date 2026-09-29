//! Model/account configuration projection. Executable integrations never cross
//! this boundary, and credentials stay in the child environment, never argv.
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tokio::process::Command;

use super::super::provider::{ProviderError, ProviderErrorKind};

const MAX_CONFIG_BYTES: usize = 4 * 1024 * 1024;

fn invalid() -> ProviderError {
    ProviderError::new(
        ProviderErrorKind::BadRequest,
        "the local agent model configuration could not be read; check its settings file",
    )
}

fn read_optional(path: &Path) -> Result<Option<String>, ProviderError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(invalid()),
    };
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(invalid());
    }
    String::from_utf8(bytes).map(Some).map_err(|_| invalid())
}

fn config_home(variable: &str, relative: &str) -> Option<PathBuf> {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(relative)))
}

pub(super) fn codex(command: &mut Command) -> Result<(), ProviderError> {
    if let Some(value) = std::env::var_os("OPENAI_BASE_URL") {
        command.env("OPENAI_BASE_URL", value);
    }
    let Some(path) = config_home("CODEX_HOME", ".codex") else {
        return Ok(());
    };
    let Some(text) = read_optional(&path.join("config.toml"))? else {
        return Ok(());
    };
    let config: toml::Value = toml::from_str(&text).map_err(|_| invalid())?;
    codex_provider_env(command, &config, |key| std::env::var_os(key));
    Ok(())
}

fn codex_provider_env(
    command: &mut Command,
    config: &toml::Value,
    env: impl Fn(&str) -> Option<OsString>,
) {
    let Some(providers) = config
        .get("model_providers")
        .and_then(toml::Value::as_table)
    else {
        return;
    };
    let mut index = 0;
    for (id, provider) in providers {
        let prefix = format!(
            "model_providers.{}",
            serde_json::to_string(id).expect("string")
        );
        let fields = provider
            .get("env_key")
            .and_then(toml::Value::as_str)
            .map(|name| (format!("{prefix}.env_key"), name))
            .into_iter()
            .chain(
                provider
                    .get("env_http_headers")
                    .and_then(toml::Value::as_table)
                    .into_iter()
                    .flatten()
                    .filter_map(|(header, name)| {
                        name.as_str().map(|name| {
                            (
                                format!(
                                    "{prefix}.env_http_headers.{}",
                                    serde_json::to_string(header).expect("string")
                                ),
                                name,
                            )
                        })
                    }),
            );
        for (field, source) in fields {
            let Some(value) = env(source) else {
                continue;
            };
            // A custom credential may be named NODE_OPTIONS, HOME, etc. Never
            // activate that name's unrelated runtime meaning in the child.
            let target = format!("KUBEPIT_CODEX_CREDENTIAL_{index}");
            index += 1;
            command.env(&target, value);
            command.arg("-c").arg(format!("{field}=\"{target}\""));
        }
    }
}

// Explicit native provider/model variables, observed in the installed CLI.
// Excludes helpers, executable credential chains, sockets, config-file paths,
// tool/permission switches, NODE_OPTIONS and arbitrary settings.env entries.
const CLAUDE_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BETAS",
    "ANTHROPIC_ORGANIZATION_ID",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_AWS_WORKSPACE_ID",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLOUD_ML_REGION",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
];

fn allowed_claude_env(name: &str) -> bool {
    CLAUDE_ENV.contains(&name)
        || (name.starts_with("VERTEX_REGION_CLAUDE_")
            && name
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
}

pub(super) fn claude(command: &mut Command) -> Result<Value, ProviderError> {
    let mut config = Value::Null;
    if let Some(home) = config_home("CLAUDE_CONFIG_DIR", ".claude") {
        if let Some(text) = read_optional(&home.join("settings.json"))? {
            config = serde_json::from_str(&text).map_err(|_| invalid())?;
            if !config.is_object() {
                return Err(invalid());
            }
        }
    }
    let parent = std::env::vars_os()
        .filter_map(|(key, value)| {
            key.to_str()
                .filter(|key| allowed_claude_env(key))
                .map(|key| (key.to_string(), value))
        })
        .collect();
    let (settings, env) = claude_projection(&config, parent);
    command.envs(env);
    Ok(settings)
}

fn claude_projection(
    config: &Value,
    mut env: BTreeMap<String, OsString>,
) -> (Value, BTreeMap<String, OsString>) {
    let mut settings = Map::new();
    if let Some(model) = config["model"].as_str() {
        settings.insert("model".into(), Value::String(model.into()));
    }
    if let Some(effort) = config["effortLevel"].as_str() {
        settings.insert("effortLevel".into(), Value::String(effort.into()));
    }
    for field in ["fallbackModel", "availableModels"] {
        if let Some(values) = config[field]
            .as_array()
            .filter(|values| values.iter().all(Value::is_string))
        {
            settings.insert(field.into(), Value::Array(values.clone()));
        }
    }
    if let Some(enabled) = config["enforceAvailableModels"].as_bool() {
        settings.insert("enforceAvailableModels".into(), Value::Bool(enabled));
    }
    if let Some(values) = config["modelOverrides"].as_object() {
        settings.insert(
            "modelOverrides".into(),
            Value::Object(
                values
                    .iter()
                    .filter(|(_, value)| value.is_string())
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            ),
        );
    }
    if let Some(rows) = config["modelPicker"]["options"].as_array() {
        let options = rows
            .iter()
            .filter_map(|row| {
                row["model"].as_str()?;
                let item = ["model", "label", "description", "behavesAs"]
                    .into_iter()
                    .filter_map(|key| {
                        row[key]
                            .as_str()
                            .map(|value| (key.into(), Value::String(value.into())))
                    })
                    .collect();
                Some(Value::Object(item))
            })
            .collect();
        let mut picker = Map::from_iter([("options".into(), Value::Array(options))]);
        if let Some(value) = config["modelPicker"]["replaceBuiltInOptions"].as_bool() {
            picker.insert("replaceBuiltInOptions".into(), Value::Bool(value));
        }
        settings.insert("modelPicker".into(), Value::Object(picker));
    }
    // Native user settings.env takes precedence over the launching environment.
    if let Some(values) = config["env"].as_object() {
        for (key, value) in values {
            if allowed_claude_env(key) {
                if let Some(value) = value.as_str() {
                    env.insert(key.clone(), OsString::from(value));
                }
            }
        }
    }
    (Value::Object(settings), env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_projects_native_picker_and_defaults_without_executable_settings() {
        let source = json!({
            "model":"gateway/model-v2", "fallbackModel":["sonnet"],"effortLevel":"low",
            "availableModels":["gateway/model-v2"],"enforceAvailableModels":true,
            "modelOverrides":{"claude-sonnet-fixture":"gateway/model-v2"},
            "modelPicker":{"replaceBuiltInOptions":true,"options":[{
                "model":"gateway/model-v2","label":"Gateway model","description":"Private gateway",
                "behavesAs":"claude-sonnet-4-6","command":"never-run"}]},
            "apiKeyHelper":"never-run", "awsAuthRefresh":"never-run", "gcpAuthRefresh":"never-run",
            "hooks":{"SessionStart":[{"command":"never-run"}]},
            "enabledPlugins":{"never-run":true}, "mcpServers":{"never-run":{"command":"never-run"}}
        });
        let (settings, _) = claude_projection(&source, BTreeMap::new());
        assert_eq!(settings["model"], "gateway/model-v2");
        assert_eq!(settings["effortLevel"], "low");
        assert_eq!(
            settings["modelPicker"]["options"][0]["behavesAs"],
            "claude-sonnet-4-6"
        );
        assert_eq!(settings["modelPicker"]["replaceBuiltInOptions"], true);
        assert_eq!(settings["availableModels"], json!(["gateway/model-v2"]));
        assert_eq!(settings["modelOverrides"], source["modelOverrides"]);
        assert!(!settings.to_string().contains("never-run"));
    }

    #[test]
    fn claude_gateway_credentials_stay_in_environment_with_native_precedence() {
        let source = json!({"env":{
            "ANTHROPIC_BASE_URL":"https://gateway.invalid/v1","ANTHROPIC_AUTH_TOKEN":"fixture-private-key",
            "ANTHROPIC_DEFAULT_OPUS_MODEL":"gateway/opus", "VERTEX_REGION_CLAUDE_SONNET":"region",
            "NODE_OPTIONS":"never-run","KUBECONFIG":"never-read","AWS_PROFILE":"never-run",
            "GOOGLE_APPLICATION_CREDENTIALS":"never-read","CLAUDE_CODE_USE_POWERSHELL_TOOL":"1"
        }});
        let parent = BTreeMap::from([(
            "ANTHROPIC_BASE_URL".into(),
            OsString::from("https://parent.invalid"),
        )]);
        let (settings, env) = claude_projection(&source, parent);
        assert_eq!(env["ANTHROPIC_BASE_URL"], "https://gateway.invalid/v1");
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "fixture-private-key");
        assert!(env.contains_key("VERTEX_REGION_CLAUDE_SONNET"));
        assert!(!env.contains_key("NODE_OPTIONS"));
        assert!(!env.contains_key("AWS_PROFILE"));
        assert!(!env.contains_key("GOOGLE_APPLICATION_CREDENTIALS"));
        let mut command = Command::new("fixture-only");
        command
            .envs(env)
            .arg("--settings")
            .arg(settings.to_string());
        assert!(!format!("{:?}", command.as_std().get_args()).contains("fixture-private-key"));
    }

    #[test]
    fn codex_provider_credential_references_are_remapped_without_runtime_side_effects() {
        let source: toml::Value = toml::from_str(
            r#"
[model_providers."gateway.custom"]
env_key="NODE_OPTIONS"
[model_providers."gateway.custom".env_http_headers]
"X-API.Token"="PRIVATE_GATEWAY_HEADER"
"Missing"="ABSENT"
"#,
        )
        .unwrap();
        let mut command = Command::new("fixture-only");
        command.env_clear();
        codex_provider_env(&mut command, &source, |key| match key {
            "NODE_OPTIONS" => Some("fixture-private-key".into()),
            "PRIVATE_GATEWAY_HEADER" => Some("fixture-header".into()),
            _ => None,
        });
        let env: BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.map(ToOwned::to_owned)))
            .collect();
        assert!(!env.contains_key(&OsString::from("NODE_OPTIONS")));
        assert_eq!(
            env[&OsString::from("KUBEPIT_CODEX_CREDENTIAL_0")],
            Some("fixture-private-key".into())
        );
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy())
            .collect();
        assert!(args.iter().any(|arg| arg
            .contains("model_providers.\"gateway.custom\".env_http_headers.\"X-API.Token\"")));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("fixture-private-key") || arg.contains("fixture-header")));
        assert_eq!(env.len(), 2);
    }

    #[test]
    fn configuration_reads_are_bounded_and_hide_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(&file, vec![b'x'; MAX_CONFIG_BYTES + 1]).unwrap();
        assert_eq!(read_optional(&file).unwrap_err().message, invalid().message);
        assert!(read_optional(dir.path()).is_err());
        assert!(read_optional(&dir.path().join("missing"))
            .unwrap()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn fifo_configuration_never_blocks_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let name = std::ffi::CString::new(file.as_os_str().as_bytes()).unwrap();
        // SAFETY: valid, nul-terminated pathname owned by this fixture.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read_optional(&file).is_err());
    }
}
