//! `Settings.ai`: defaults (spec §7.1), normalization, validation, lenient
//! loading, per-cluster enablement and the egress rules shared by
//! `ai_status`, the keys and the providers.

use std::net::IpAddr;

use anyhow::{bail, Result};
use serde_json::Value;

use super::types::{
    AiPrice, AiProviderConfig, AiProviderKind, AiRedactionSettings, AiSettings, AiToolPolicy,
};
use crate::types::{ClusterDef, ClusterEnvironment};

/// Provider requests go to unless the user picks another.
pub const DEFAULT_PROVIDER: &str = "anthropic";
/// Default Anthropic model (no date suffix).
pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-5";
pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
pub const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
pub const DEFAULT_MAX_CONTEXT_TOKENS: u32 = 60_000;
/// `max_context_tokens` is clamped to this range.
pub const MIN_CONTEXT_TOKENS: u32 = 2_000;
pub const MAX_CONTEXT_TOKENS: u32 = 900_000;
/// Context window of an OpenAI-compatible provider without one configured.
pub const DEFAULT_OPENAI_CONTEXT_WINDOW: u32 = 32_768;
/// Context window of the default Ollama provider (`options.num_ctx`).
pub const DEFAULT_OLLAMA_CONTEXT_WINDOW: u32 = 8_192;

impl AiProviderKind {
    /// The contract spelling (`anthropic`, `openai-compatible`, `ollama`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenaiCompatible => "openai-compatible",
            Self::Ollama => "ollama",
        }
    }

    /// The base URL of the default provider of this kind. Normalization
    /// only uses it for the three default provider ids
    /// ([`default_base_url`]).
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Anthropic => ANTHROPIC_BASE_URL,
            Self::OpenaiCompatible => OPENAI_BASE_URL,
            Self::Ollama => OLLAMA_BASE_URL,
        }
    }

    pub fn default_max_output_tokens(self) -> u32 {
        match self {
            Self::Anthropic => 64_000,
            Self::OpenaiCompatible | Self::Ollama => 4_096,
        }
    }

    /// Display name of a provider of this kind without one.
    pub fn default_name(self) -> &'static str {
        match self {
            Self::Anthropic => "Anthropic",
            Self::OpenaiCompatible => "OpenAI-compatible",
            Self::Ollama => "Ollama",
        }
    }
}

fn provider_default(id: &str, kind: AiProviderKind) -> AiProviderConfig {
    AiProviderConfig {
        id: id.to_string(),
        kind,
        name: kind.default_name().to_string(),
        base_url: kind.default_base_url().to_string(),
        model: match kind {
            AiProviderKind::Anthropic => DEFAULT_ANTHROPIC_MODEL.to_string(),
            _ => String::new(),
        },
        context_window: match kind {
            AiProviderKind::Ollama => Some(DEFAULT_OLLAMA_CONTEXT_WINDOW),
            _ => None,
        },
        max_output_tokens: kind.default_max_output_tokens(),
    }
}

/// `anthropic`, `openai` and `ollama` with the spec's defaults.
pub fn default_providers() -> Vec<AiProviderConfig> {
    vec![
        provider_default("anthropic", AiProviderKind::Anthropic),
        provider_default("openai", AiProviderKind::OpenaiCompatible),
        provider_default("ollama", AiProviderKind::Ollama),
    ]
}

/// The base URL a blank one falls back to: only the three default
/// providers (same id and kind) have one. A custom provider with a blank
/// base URL stays blank, and is not allowed.
pub fn default_base_url(id: &str, kind: AiProviderKind) -> Option<&'static str> {
    match (id, kind) {
        ("anthropic", AiProviderKind::Anthropic) => Some(ANTHROPIC_BASE_URL),
        ("openai", AiProviderKind::OpenaiCompatible) => Some(OPENAI_BASE_URL),
        ("ollama", AiProviderKind::Ollama) => Some(OLLAMA_BASE_URL),
        _ => None,
    }
}

/// Provider ids are also keychain entry names (`ai/<id>`):
/// `[a-z0-9._-]{1,64}`.
pub fn valid_provider_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

/// Surrounding whitespace and trailing slashes removed, repeatedly, so the
/// result is stable (`" https://x/ / "` → `"https://x"`).
pub fn trim_base_url(url: &str) -> &str {
    let mut current = url;
    loop {
        let next = current.trim().trim_end_matches('/');
        if next == current {
            return current;
        }
        current = next;
    }
}

/// A usable provider base URL: `http://` or `https://` with a host, and no
/// user info, query, fragment, whitespace or backslash (WHATWG parsers,
/// like the HTTP client's, read `\` as `/`, so `http://evil\@127.0.0.1`
/// goes to `evil`). `url` is already trimmed.
fn parse_base_url(url: &str) -> Result<http::Uri, &'static str> {
    if url.is_empty() {
        return Err("it is empty");
    }
    if url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err("it contains spaces, control characters or backslashes");
    }
    if url.contains('?') {
        return Err("it must not contain a query (?…)");
    }
    if url.contains('#') {
        return Err("it must not contain a fragment (#…)");
    }
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("it must start with http:// or https://");
    }
    let uri: http::Uri = url.parse().map_err(|_| "it is not a valid URL")?;
    if !matches!(uri.scheme_str(), Some("http" | "https")) {
        return Err("it must start with http:// or https://");
    }
    let Some(authority) = uri.authority() else {
        return Err("it has no host");
    };
    if authority.as_str().contains('@') {
        return Err("it must not contain a user name or password");
    }
    let host = authority.host();
    if host.is_empty() {
        return Err("it has no host");
    }
    // `host:99999` parses, but has no port.
    let port = &authority.as_str()[host.len()..];
    if port.len() > 1 && authority.port_u16().is_none() {
        return Err("its port is not valid");
    }
    Ok(uri)
}

/// Why `base_url` cannot be used, `None` when it can.
pub fn base_url_problem(base_url: &str) -> Option<&'static str> {
    parse_base_url(trim_base_url(base_url)).err()
}

fn host_is_loopback(uri: &http::Uri) -> bool {
    let Some(host) = uri.host() else {
        return false;
    };
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// `scheme://host[:port]` of a usable base URL: lowercase, without the
/// scheme's default port. API keys are bound to it (`ai/keys.rs`).
pub fn origin(base_url: &str) -> Option<String> {
    let uri = parse_base_url(trim_base_url(base_url)).ok()?;
    let scheme = uri.scheme_str()?.to_ascii_lowercase();
    let host = uri.host()?.to_ascii_lowercase();
    let port = match (scheme.as_str(), uri.port_u16()) {
        ("http", Some(80)) | ("https", Some(443)) | (_, None) => String::new(),
        (_, Some(port)) => format!(":{port}"),
    };
    Some(format!("{scheme}://{host}{port}"))
}

/// An API key may be sent to `base_url`: `https://`, or any usable URL on
/// this computer. Never plain `http://` over the network.
pub fn key_safe(base_url: &str) -> bool {
    parse_base_url(trim_base_url(base_url))
        .is_ok_and(|uri| uri.scheme_str() == Some("https") || host_is_loopback(&uri))
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            local_only: false,
            active_provider: Some(DEFAULT_PROVIDER.to_string()),
            providers: default_providers(),
            clusters: Vec::new(),
            production_acknowledged: Vec::new(),
            redaction: AiRedactionSettings::default(),
            tool_policy: AiToolPolicy::Ask,
            log_requests: true,
            max_context_tokens: DEFAULT_MAX_CONTEXT_TOKENS,
            effort: None,
            prices: Vec::new(),
        }
    }
}

impl AiProviderConfig {
    /// Trimmed values; blanks fall back to the kind's defaults, a blank base
    /// URL only for the default providers ([`default_base_url`]). An
    /// unusable base URL (a hand edit; `settings_set` refuses them) counts
    /// as blank, so it can never block saving the other settings.
    fn normalized(mut self) -> Self {
        self.id = self.id.trim().to_string();
        let base_url = trim_base_url(&self.base_url);
        self.base_url = match parse_base_url(base_url) {
            Ok(_) => base_url.to_string(),
            Err(_) => String::new(),
        };
        if self.base_url.is_empty() {
            if let Some(url) = default_base_url(&self.id, self.kind) {
                self.base_url = url.to_string();
            }
        }
        self.model = self.model.trim().to_string();
        if self.model.is_empty() && self.kind == AiProviderKind::Anthropic {
            self.model = DEFAULT_ANTHROPIC_MODEL.to_string();
        }
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            self.name = self.kind.default_name().to_string();
        }
        if self.max_output_tokens == 0 {
            self.max_output_tokens = self.kind.default_max_output_tokens();
        }
        self.context_window = self.context_window.filter(|n| *n > 0);
        self
    }
}

fn price_value(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

impl AiPrice {
    fn normalized(mut self) -> Self {
        self.model = self.model.trim().to_string();
        self.input_per_mtok = price_value(self.input_per_mtok);
        self.output_per_mtok = price_value(self.output_per_mtok);
        self.cache_write_per_mtok = self.cache_write_per_mtok.map(price_value);
        self.cache_read_per_mtok = self.cache_read_per_mtok.map(price_value);
        self
    }
}

/// Sorted, without blanks or duplicates.
fn normalized_ids(ids: Vec<String>) -> Vec<String> {
    let mut ids: Vec<String> = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

fn insert_sorted(ids: &mut Vec<String>, id: &str) {
    if let Err(at) = ids.binary_search_by(|probe| probe.as_str().cmp(id)) {
        ids.insert(at, id.to_string());
    }
}

impl AiSettings {
    /// Clamp out-of-range values and restore missing defaults instead of
    /// persisting them: the budget range, blank provider fields, the three
    /// default providers, an unknown active provider, duplicate or invalid
    /// ids. Idempotent: `normalized(normalized(x)) == normalized(x)`.
    pub fn normalized(mut self) -> Self {
        self.max_context_tokens = self
            .max_context_tokens
            .clamp(MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS);

        let mut providers: Vec<AiProviderConfig> = Vec::with_capacity(self.providers.len());
        for provider in self.providers.drain(..).map(AiProviderConfig::normalized) {
            if valid_provider_id(&provider.id) && !providers.iter().any(|p| p.id == provider.id) {
                providers.push(provider);
            }
        }
        for default in default_providers() {
            if !providers.iter().any(|p| p.id == default.id) {
                providers.push(default);
            }
        }
        self.providers = providers;

        self.active_provider = self
            .active_provider
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .map(|id| {
                if self.providers.iter().any(|p| p.id == id) {
                    id
                } else {
                    DEFAULT_PROVIDER.to_string()
                }
            });

        self.clusters = normalized_ids(std::mem::take(&mut self.clusters));
        let clusters = &self.clusters;
        self.production_acknowledged =
            normalized_ids(std::mem::take(&mut self.production_acknowledged));
        self.production_acknowledged
            .retain(|id| clusters.binary_search(id).is_ok());

        let mut prices: Vec<AiPrice> = Vec::with_capacity(self.prices.len());
        for price in self.prices.drain(..).map(AiPrice::normalized) {
            if !price.model.is_empty() && !prices.iter().any(|p| p.model == price.model) {
                prices.push(price);
            }
        }
        self.prices = prices;
        self
    }

    /// What `settings_set` refuses instead of normalizing: provider ids
    /// outside `[a-z0-9._-]{1,64}` and base URLs that are not blank and not
    /// usable ([`base_url_problem`]). A blank base URL is accepted: the
    /// default providers get theirs back, a custom one stays not allowed.
    pub fn validate(&self) -> Result<()> {
        for provider in &self.providers {
            let id = provider.id.trim();
            if !valid_provider_id(id) {
                bail!(
                    "assistant provider id \"{id}\" is not valid: use 1 to 64 lowercase letters, \
                     digits, '.', '_' or '-'"
                );
            }
            let url = trim_base_url(&provider.base_url);
            if !url.is_empty() {
                if let Err(why) = parse_base_url(url) {
                    bail!("the base URL of assistant provider \"{id}\" is not valid: {why}");
                }
            }
        }
        Ok(())
    }

    /// `settings.ai` as stored in `settings.json`, never failing: a newer
    /// build's (or a hand-edited) provider kind drops that provider, an
    /// unknown `effort`, `tool_policy` or other unreadable field falls back
    /// to its default, and a value that is not an object resets the group.
    /// The other settings are not affected. Not normalized.
    pub fn from_stored(value: Value) -> Self {
        if let Ok(ai) = serde_json::from_value::<Self>(value.clone()) {
            return ai;
        }
        let Value::Object(mut fields) = value else {
            tracing::warn!("settings.ai is not an object; using the assistant defaults");
            return Self::default();
        };
        if let Some(Value::Array(providers)) = fields.get_mut("providers") {
            providers.retain(|provider| {
                match serde_json::from_value::<AiProviderConfig>(provider.clone()) {
                    Ok(_) => true,
                    Err(e) => {
                        tracing::warn!("ignoring an assistant provider in settings.ai: {e}");
                        false
                    }
                }
            });
        }
        let Ok(Value::Object(mut merged)) = serde_json::to_value(Self::default()) else {
            return Self::default();
        };
        for (name, value) in fields {
            let mut trial = merged.clone();
            trial.insert(name.clone(), value);
            match serde_json::from_value::<Self>(Value::Object(trial.clone())) {
                Ok(_) => merged = trial,
                Err(e) => {
                    tracing::warn!("settings.ai.{name} is not valid ({e}); using its default")
                }
            }
        }
        serde_json::from_value(Value::Object(merged)).unwrap_or_else(|e| {
            tracing::warn!("settings.ai is not valid ({e}); using the assistant defaults");
            Self::default()
        })
    }

    pub fn provider(&self, id: &str) -> Option<&AiProviderConfig> {
        self.providers.iter().find(|p| p.id == id)
    }

    /// The provider requests go to; `None` when none is chosen.
    pub fn active(&self) -> Option<&AiProviderConfig> {
        self.active_provider
            .as_deref()
            .and_then(|id| self.provider(id))
    }

    /// The id is in the enabled list. Use [`Self::cluster_allowed`] to
    /// decide whether the assistant may be used with a cluster.
    pub fn is_cluster_enabled(&self, cluster_id: &str) -> bool {
        self.clusters.iter().any(|id| id == cluster_id)
    }

    /// The assistant may be used with `cluster`: it is enabled and, if it is
    /// a production cluster, it was enabled with the typed acknowledgement
    /// while it was production.
    pub fn cluster_allowed(&self, cluster: &ClusterDef) -> bool {
        self.is_cluster_enabled(&cluster.id)
            && (cluster.environment != Some(ClusterEnvironment::Production)
                || self.production_acknowledged.contains(&cluster.id))
    }

    /// Enable a cluster; `production` records the typed acknowledgement
    /// (the caller checked it). Enabling a cluster that is not production
    /// drops an old acknowledgement: it would not cover a later change.
    pub fn enable_cluster(&mut self, cluster_id: &str, production: bool) {
        insert_sorted(&mut self.clusters, cluster_id);
        if production {
            insert_sorted(&mut self.production_acknowledged, cluster_id);
        } else {
            self.production_acknowledged.retain(|id| id != cluster_id);
        }
    }

    /// Disable a cluster: drop it from the enabled clusters and the
    /// acknowledgements.
    pub fn forget_cluster(&mut self, cluster_id: &str) {
        self.clusters.retain(|id| id != cluster_id);
        self.production_acknowledged.retain(|id| id != cluster_id);
    }

    /// Make one cluster's enablement match the registry (`cluster` is
    /// `None` when `cluster_id` is not registered): an unregistered cluster
    /// is forgotten, a production one stays enabled only when acknowledged,
    /// and only enabled production clusters keep an acknowledgement.
    pub fn reconcile_cluster(&mut self, cluster_id: &str, cluster: Option<&ClusterDef>) {
        let Some(cluster) = cluster else {
            self.forget_cluster(cluster_id);
            return;
        };
        let production = cluster.environment == Some(ClusterEnvironment::Production);
        let enabled = self.is_cluster_enabled(cluster_id);
        let acknowledged = self
            .production_acknowledged
            .iter()
            .any(|id| id == cluster_id);
        if production && enabled && !acknowledged {
            self.clusters.retain(|id| id != cluster_id);
        }
        if acknowledged && (!production || !enabled) {
            self.production_acknowledged.retain(|id| id != cluster_id);
        }
    }

    /// [`Self::reconcile_cluster`] for every id in either list (at load:
    /// hand edits, a downgrade, or a cluster removed by another build).
    pub fn reconcile_clusters(&mut self, clusters: &[ClusterDef]) {
        let mut ids = self.clusters.clone();
        ids.extend(self.production_acknowledged.iter().cloned());
        for id in ids {
            let cluster = clusters.iter().find(|c| c.id == id);
            self.reconcile_cluster(&id, cluster);
        }
    }
}

/// A usable `http(s)://` base URL with a loopback host: `127.0.0.0/8`,
/// `::1` or `localhost`. Anything else (unparsable, user info, `\`, …) is
/// not loopback.
pub fn is_loopback(base_url: &str) -> bool {
    parse_base_url(trim_base_url(base_url)).is_ok_and(|uri| host_is_loopback(&uri))
}

/// Whether a provider at `base_url` may be reached: the URL must be usable;
/// loopback always; any other address only when this process allows remote
/// egress (`Kubepit::set_ai_remote_providers`) and local-only mode is off.
pub fn egress_allowed(base_url: &str, remote_allowed: bool, local_only: bool) -> bool {
    parse_base_url(trim_base_url(base_url))
        .is_ok_and(|uri| host_is_loopback(&uri) || (remote_allowed && !local_only))
}

/// [`egress_allowed`] for a request that carries an API key: also refuses
/// plain `http://` to another computer ([`key_safe`]).
pub fn key_egress_allowed(base_url: &str, remote_allowed: bool, local_only: bool) -> bool {
    egress_allowed(base_url, remote_allowed, local_only) && key_safe(base_url)
}

/// `AiProviderStatus.allowed`: a provider that sends an API key (Anthropic
/// always, the others when one is stored) must pass [`key_egress_allowed`],
/// a keyless one (Ollama, a local OpenAI-compatible server) [`egress_allowed`].
pub fn provider_allowed(
    provider: &AiProviderConfig,
    has_key: bool,
    remote_allowed: bool,
    local_only: bool,
) -> bool {
    if provider.kind == AiProviderKind::Anthropic || has_key {
        key_egress_allowed(&provider.base_url, remote_allowed, local_only)
    } else {
        egress_allowed(&provider.base_url, remote_allowed, local_only)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Settings;

    #[test]
    fn loopback_hosts_are_recognized_strictly() {
        for url in [
            "http://127.0.0.1:11434",
            "http://127.9.8.7",
            "https://localhost:8443/v1",
            "http://LOCALHOST",
            "http://[::1]:11434",
            "  http://127.0.0.1:4000/  ",
        ] {
            assert!(is_loopback(url), "{url}");
        }
        for url in [
            "https://api.anthropic.com",
            "http://10.0.0.1:11434",
            "http://localhost.evil.example",
            "http://127.0.0.1@evil.example",
            "ftp://127.0.0.1",
            "127.0.0.1:11434",
            "",
            "not a url",
            "http://0.0.0.0:11434",
            // Loopback in some parsers, not here: the safe answer is "no".
            "http://[::ffff:127.0.0.1]",
            "http://localhost.",
            // WHATWG parsers (reqwest's `url`) read `\` as `/`: the host is
            // 127.0.0.1 in the first, `evil` in the second. Both are refused.
            "http://127.0.0.1\\@evil",
            "http://evil\\@127.0.0.1",
        ] {
            assert!(!is_loopback(url), "{url}");
        }
    }

    #[test]
    fn normalizing_twice_changes_nothing() {
        let nasty_urls = [
            " https://x/ / ",
            "https://x//",
            "https://x/\t/\n",
            "\u{a0}https://gateway.example/v1/\u{a0}/",
            "  /",
            "/ /",
            "",
            "http://127.0.0.1:11434/ ",
        ];
        for url in nasty_urls {
            for kind in [
                AiProviderKind::Anthropic,
                AiProviderKind::OpenaiCompatible,
                AiProviderKind::Ollama,
            ] {
                for id in ["anthropic", "openai", "ollama", " custom ", "gateway"] {
                    let mut ai = AiSettings::default();
                    ai.providers.insert(
                        0,
                        AiProviderConfig {
                            id: id.into(),
                            kind,
                            name: " \t".into(),
                            base_url: url.into(),
                            model: " m ".into(),
                            context_window: Some(0),
                            max_output_tokens: 0,
                        },
                    );
                    ai.active_provider = Some(format!(" {id} "));
                    ai.clusters = vec![" b".into(), "a ".into(), "b".into(), " ".into()];
                    ai.prices = vec![AiPrice {
                        model: " m ".into(),
                        input_per_mtok: f64::NAN,
                        output_per_mtok: -3.0,
                        cache_write_per_mtok: Some(f64::INFINITY),
                        cache_read_per_mtok: None,
                    }];
                    ai.max_context_tokens = u32::MAX;
                    let once = ai.normalized();
                    let twice = once.clone().normalized();
                    assert_eq!(once, twice, "{id:?} {kind:?} {url:?}");
                    let p = once.provider(id.trim()).unwrap();
                    assert!(!p.base_url.ends_with('/'), "{url:?}");
                    assert_eq!(p.base_url, p.base_url.trim(), "{url:?}");
                }
            }
        }
    }

    #[test]
    fn origins_are_canonical() {
        for (url, expected) in [
            ("https://api.anthropic.com", "https://api.anthropic.com"),
            (
                " HTTPS://API.Anthropic.com:443/v1/ ",
                "https://api.anthropic.com",
            ),
            ("http://127.0.0.1:80", "http://127.0.0.1"),
            ("http://127.0.0.1:11434/", "http://127.0.0.1:11434"),
            (
                "https://gateway.example:8443/a/b",
                "https://gateway.example:8443",
            ),
            ("http://[::1]:4000", "http://[::1]:4000"),
        ] {
            assert_eq!(origin(url), Some(expected.to_string()), "{url}");
        }
        for url in [
            "",
            "ftp://x",
            "https://u:p@x",
            "https://x/?a",
            "https://x/#a",
            "https://x:99999",
            "http://a b",
            "http://evil\\@127.0.0.1",
            "https://",
        ] {
            assert_eq!(origin(url), None, "{url}");
            assert!(base_url_problem(url).is_some(), "{url}");
        }
    }

    #[test]
    fn keys_need_https_or_this_computer() {
        let at = |kind: AiProviderKind, base_url: &str| AiProviderConfig {
            id: "x".into(),
            kind,
            name: "X".into(),
            base_url: base_url.into(),
            model: String::new(),
            context_window: None,
            max_output_tokens: 1,
        };
        use AiProviderKind::{Anthropic, Ollama, OpenaiCompatible};
        // (provider, has_key, allowed with remote egress on)
        for (provider, has_key, allowed) in [
            (at(Anthropic, "https://api.anthropic.com"), false, true),
            (at(Anthropic, "http://gateway.lan"), false, false),
            (at(Anthropic, "http://10.0.0.5:8080"), true, false),
            (at(Anthropic, "http://127.0.0.1:4000"), true, true),
            (at(OpenaiCompatible, "http://10.0.0.5:8000/v1"), false, true),
            (at(OpenaiCompatible, "http://10.0.0.5:8000/v1"), true, false),
            (
                at(OpenaiCompatible, "https://api.openai.com/v1"),
                true,
                true,
            ),
            (at(Ollama, "http://192.168.1.20:11434"), false, true),
            (at(OpenaiCompatible, ""), false, false),
            (at(Ollama, "ftp://127.0.0.1"), false, false),
        ] {
            assert_eq!(
                provider_allowed(&provider, has_key, true, false),
                allowed,
                "{:?} {} key={has_key}",
                provider.kind,
                provider.base_url
            );
            // Without the process opt-in only loopback is allowed.
            assert_eq!(
                provider_allowed(&provider, has_key, false, false),
                allowed && is_loopback(&provider.base_url)
            );
        }
        assert!(key_egress_allowed("https://api.anthropic.com", true, false));
        assert!(!key_egress_allowed("http://api.anthropic.com", true, false));
        assert!(key_egress_allowed("http://localhost:4000", false, true));
        assert!(!key_safe("http://[::ffff:127.0.0.1]:4000"));
    }

    #[test]
    fn validation_refuses_unsafe_ids_and_urls() {
        let with = |id: &str, base_url: &str| {
            let mut ai = AiSettings::default();
            ai.providers.push(AiProviderConfig {
                id: id.into(),
                base_url: base_url.into(),
                ..ai.providers[1].clone()
            });
            ai.validate()
        };
        assert!(AiSettings::default().validate().is_ok());
        assert!(with(" my.gw_1-x ", " https://gw.example/v1/ ").is_ok());
        assert!(with("custom", "").is_ok(), "blank stays blank, not allowed");
        assert!(with(&"a".repeat(64), "http://127.0.0.1:1").is_ok());
        for id in ["", " ", "Upper", "a b", "a/b", "ü", &"a".repeat(65)] {
            assert!(with(id, "https://x").is_err(), "{id:?}");
        }
        for url in [
            "ftp://x",
            "x.example",
            "https://user@x",
            "https://x/v1?k=1",
            "https://x/v1#f",
            "https://x\\y",
            "https://x:0x50",
        ] {
            let err = with("custom", url).unwrap_err().to_string();
            assert!(
                err.contains("custom") && err.contains("base URL"),
                "{url}: {err}"
            );
        }
    }

    #[test]
    fn custom_providers_keep_a_blank_base_url() {
        let mut ai = AiSettings::default();
        ai.providers[0].base_url = " ".into();
        ai.providers[1].kind = AiProviderKind::Anthropic; // id `openai`, another kind
        ai.providers[1].base_url = String::new();
        ai.providers.push(AiProviderConfig {
            id: "gateway".into(),
            base_url: "/".into(),
            ..ai.providers[2].clone()
        });
        let n = ai.normalized();
        assert_eq!(
            n.provider("anthropic").unwrap().base_url,
            ANTHROPIC_BASE_URL
        );
        assert_eq!(n.provider("openai").unwrap().base_url, "");
        assert_eq!(n.provider("gateway").unwrap().base_url, "");
        assert!(!egress_allowed("", true, false));

        // Unusable base URLs (hand edits) count as blank.
        let mut ai = AiSettings::default();
        ai.providers[2].base_url = "ftp://127.0.0.1:11434".into();
        ai.providers.push(AiProviderConfig {
            id: "gateway".into(),
            base_url: "https://user:pw@gateway.example".into(),
            ..ai.providers[1].clone()
        });
        let n = ai.normalized();
        assert_eq!(n.provider("ollama").unwrap().base_url, OLLAMA_BASE_URL);
        assert_eq!(n.provider("gateway").unwrap().base_url, "");
        assert!(n.validate().is_ok());
    }

    #[test]
    fn stored_ai_groups_load_leniently() {
        let ai = AiSettings::from_stored(serde_json::json!({
            "enabled": true,
            "effort": "ultra",
            "tool_policy": "session",
            "max_context_tokens": "lots",
            "redaction": {"ips": true},
            "providers": [
                {"id": "x", "kind": "gemini"},
                {"id": "gw", "kind": "ollama", "base_url": "http://127.0.0.1:1"},
                "not a provider"
            ],
            "clusters": ["a"]
        }));
        assert!(ai.enabled && ai.redaction.ips);
        assert_eq!(ai.effort, None);
        assert_eq!(ai.tool_policy, AiToolPolicy::Session);
        assert_eq!(ai.max_context_tokens, DEFAULT_MAX_CONTEXT_TOKENS);
        assert_eq!(ai.providers.len(), 1);
        assert_eq!(ai.providers[0].id, "gw");
        assert_eq!(ai.clusters, vec!["a".to_string()]);
        assert_eq!(AiSettings::from_stored(Value::Null), AiSettings::default());
        assert_eq!(
            AiSettings::from_stored(serde_json::json!("nope")),
            AiSettings::default()
        );
    }

    #[test]
    fn reconciling_follows_the_registry() {
        let cluster = |id: &str, production: bool| ClusterDef {
            id: id.into(),
            name: id.into(),
            context: "c".into(),
            kubeconfig_path: "/k".into(),
            managed: false,
            tags: vec![],
            environment: production.then_some(ClusterEnvironment::Production),
            color: None,
            default_namespace: None,
            accessible_namespaces: vec![],
            read_only: false,
            notes: String::new(),
            created_at: 0,
            last_connected_at: None,
            cost: Default::default(),
            prometheus: Default::default(),
            prometheus_access: Default::default(),
            loki: Default::default(),
            proxy_url: None,
        };
        let mut ai = AiSettings::default();
        ai.enable_cluster("p", true);
        ai.enable_cluster("d", false);
        ai.enable_cluster("q", false);
        assert_eq!(ai.clusters, ["d", "p", "q"]);
        assert_eq!(ai.production_acknowledged, ["p"]);
        // q became production without an acknowledgement.
        let registry = [cluster("p", true), cluster("d", false), cluster("q", true)];
        ai.reconcile_clusters(&registry);
        assert_eq!(ai.clusters, ["d", "p"]);
        assert!(ai.cluster_allowed(&registry[0]) && ai.cluster_allowed(&registry[1]));
        assert!(!ai.cluster_allowed(&registry[2]));
        // p left production: still enabled, acknowledgement dropped.
        ai.reconcile_cluster("p", Some(&cluster("p", false)));
        assert_eq!(
            (ai.clusters.len(), ai.production_acknowledged.len()),
            (2, 0)
        );
        // Unregistered: forgotten.
        ai.reconcile_cluster("d", None);
        assert_eq!(ai.clusters, ["p"]);
        ai.forget_cluster("p");
        assert!(ai.clusters.is_empty());
    }

    #[test]
    fn egress_needs_the_process_opt_in_and_not_local_only() {
        assert!(egress_allowed("http://127.0.0.1:1", false, true));
        assert!(!egress_allowed("https://api.anthropic.com", false, false));
        assert!(!egress_allowed("https://api.anthropic.com", true, true));
        assert!(egress_allowed("https://api.anthropic.com", true, false));
    }

    #[test]
    fn settings_without_ai_load_the_defaults() {
        let s: Settings = serde_json::from_str(r#"{"log_tail_lines": 5}"#).unwrap();
        assert_eq!(s.ai, AiSettings::default());
        let s: Settings = serde_json::from_str(r#"{"ai": {"enabled": true}}"#).unwrap();
        assert!(s.ai.enabled);
        assert_eq!(s.ai.providers, default_providers());
        assert_eq!(s.ai.max_context_tokens, DEFAULT_MAX_CONTEXT_TOKENS);
    }

    #[test]
    fn defaults_match_the_spec() {
        let ai = AiSettings::default();
        let openai = ai.provider("openai").unwrap();
        assert_eq!(openai.kind, AiProviderKind::OpenaiCompatible);
        assert_eq!(openai.base_url, "https://api.openai.com/v1");
        assert_eq!((openai.model.as_str(), openai.context_window), ("", None));
        assert_eq!(openai.max_output_tokens, 4_096);
        let ollama = ai.provider("ollama").unwrap();
        assert_eq!(ollama.context_window, Some(8_192));
        let anthropic = ai.active().unwrap();
        assert_eq!(anthropic.id, "anthropic");
        assert_eq!(anthropic.max_output_tokens, 64_000);
        assert_eq!(anthropic.context_window, None);
        assert_eq!(ai.normalized(), AiSettings::default());
    }

    #[test]
    fn normalize_trims_dedupes_and_repairs() {
        let mut ai = AiSettings::default();
        ai.providers[0].base_url = " https://gateway.example/anthropic/ ".into();
        ai.providers[0].model = "  ".into();
        ai.providers[1].max_output_tokens = 0;
        ai.providers[2].context_window = Some(0);
        let mut duplicate = ai.providers[1].clone();
        duplicate.base_url = "http://127.0.0.1:1234/v1".into();
        ai.providers.push(duplicate);
        ai.providers.push(AiProviderConfig {
            id: "  ".into(),
            ..ai.providers[1].clone()
        });
        ai.active_provider = Some("gone".into());
        ai.clusters = vec!["b".into(), " a ".into(), "b".into(), "".into()];
        ai.prices = vec![
            AiPrice {
                model: " claude-opus-5 ".into(),
                input_per_mtok: -1.0,
                output_per_mtok: 25.0,
                cache_write_per_mtok: Some(-2.0),
                cache_read_per_mtok: None,
            },
            AiPrice {
                model: "claude-opus-5".into(),
                input_per_mtok: 9.0,
                output_per_mtok: 9.0,
                cache_write_per_mtok: None,
                cache_read_per_mtok: None,
            },
            AiPrice {
                model: " ".into(),
                input_per_mtok: 1.0,
                output_per_mtok: 1.0,
                cache_write_per_mtok: None,
                cache_read_per_mtok: None,
            },
        ];
        let n = ai.normalized();
        let anthropic = n.provider("anthropic").unwrap();
        assert_eq!(anthropic.base_url, "https://gateway.example/anthropic");
        assert_eq!(anthropic.model, DEFAULT_ANTHROPIC_MODEL);
        assert_eq!(n.provider("openai").unwrap().max_output_tokens, 4_096);
        assert_eq!(
            n.provider("openai").unwrap().base_url,
            "https://api.openai.com/v1",
            "the first entry of an id wins"
        );
        assert_eq!(n.provider("ollama").unwrap().context_window, None);
        assert_eq!(n.providers.len(), 3);
        assert_eq!(n.active_provider.as_deref(), Some(DEFAULT_PROVIDER));
        assert_eq!(n.clusters, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(n.prices.len(), 1);
        assert_eq!(n.prices[0].model, "claude-opus-5");
        assert_eq!(n.prices[0].input_per_mtok, 0.0);
        assert_eq!(n.prices[0].cache_write_per_mtok, Some(0.0));

        let none = AiSettings {
            active_provider: Some(" ".into()),
            ..AiSettings::default()
        };
        assert_eq!(none.normalized().active_provider, None);
        assert!(AiSettings {
            active_provider: None,
            ..AiSettings::default()
        }
        .active()
        .is_none());
    }
}
