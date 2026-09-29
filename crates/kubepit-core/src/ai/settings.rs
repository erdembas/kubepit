//! `Settings.ai`: defaults (spec §7.1), normalization, provider defaults and
//! the egress rule shared by `ai_status` and the providers.

use std::net::IpAddr;

use super::types::{
    AiPrice, AiProviderConfig, AiProviderKind, AiRedactionSettings, AiSettings, AiToolPolicy,
};

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

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            local_only: false,
            active_provider: Some(DEFAULT_PROVIDER.to_string()),
            providers: default_providers(),
            clusters: Vec::new(),
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
    /// Trimmed values; blanks fall back to the kind's defaults.
    fn normalized(mut self) -> Self {
        self.id = self.id.trim().to_string();
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        if self.base_url.is_empty() {
            self.base_url = self.kind.default_base_url().to_string();
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

impl AiSettings {
    /// Clamp out-of-range values and restore missing defaults instead of
    /// persisting them: the budget range, blank provider fields, the three
    /// default providers, an unknown active provider, duplicate ids.
    pub fn normalized(mut self) -> Self {
        self.max_context_tokens = self
            .max_context_tokens
            .clamp(MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS);

        let mut providers: Vec<AiProviderConfig> = Vec::with_capacity(self.providers.len());
        for provider in self.providers.drain(..).map(AiProviderConfig::normalized) {
            if !provider.id.is_empty() && !providers.iter().any(|p| p.id == provider.id) {
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

        self.clusters = std::mem::take(&mut self.clusters)
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect();
        self.clusters.sort();
        self.clusters.dedup();

        let mut prices: Vec<AiPrice> = Vec::with_capacity(self.prices.len());
        for price in self.prices.drain(..).map(AiPrice::normalized) {
            if !price.model.is_empty() && !prices.iter().any(|p| p.model == price.model) {
                prices.push(price);
            }
        }
        self.prices = prices;
        self
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

    /// The assistant may be used with this cluster. Production clusters are
    /// only ever added with the user's typed acknowledgement.
    pub fn is_cluster_enabled(&self, cluster_id: &str) -> bool {
        self.clusters.iter().any(|id| id == cluster_id)
    }
}

/// `http(s)://` with a loopback host: `127.0.0.0/8`, `::1` or `localhost`.
/// Anything unparsable is not loopback.
pub fn is_loopback(base_url: &str) -> bool {
    let Ok(uri) = base_url.trim().parse::<http::Uri>() else {
        return false;
    };
    if !matches!(uri.scheme_str(), Some("http" | "https")) {
        return false;
    }
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

/// Whether a provider at `base_url` may be reached: loopback always; any
/// other address only when this process allows remote egress
/// (`Kubepit::set_ai_remote_providers`) and local-only mode is off.
pub fn egress_allowed(base_url: &str, remote_allowed: bool, local_only: bool) -> bool {
    is_loopback(base_url) || (remote_allowed && !local_only)
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
        ] {
            assert!(!is_loopback(url), "{url}");
        }
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
