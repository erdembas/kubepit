//! Native model catalogs are metadata only: no session, prompt or cluster data.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use super::local_agent::LocalAgentProvider;
use super::opencode_cli::OpenCodeCliProvider;
use super::provider::Egress;
use super::{AiAgentCatalog, AiAgentModel, AiProviderKind};
use crate::app::Kubepit;

const CACHE_TTL: Duration = Duration::from_secs(300);

struct Entry {
    executable: PathBuf,
    fetched: Instant,
    catalog: AiAgentCatalog,
}

#[derive(Default)]
pub(crate) struct CatalogCache {
    entries: Mutex<HashMap<AiProviderKind, Entry>>,
    loads: Mutex<HashMap<AiProviderKind, Arc<tokio::sync::Mutex<()>>>>,
}

impl CatalogCache {
    fn get(&self, kind: AiProviderKind, executable: &Path, now: Instant) -> Option<AiAgentCatalog> {
        self.entries
            .lock()
            .get(&kind)
            .filter(|entry| {
                entry.executable == executable && now.duration_since(entry.fetched) < CACHE_TTL
            })
            .map(|entry| entry.catalog.clone())
    }

    pub(crate) fn peek(&self, kind: AiProviderKind) -> Option<AiAgentCatalog> {
        if !kind.is_cli() {
            return None;
        }
        let executable = super::local_discovery::resolve(kind)?;
        self.get(kind, &executable.path, Instant::now())
    }

    fn refreshed_since(
        &self,
        kind: AiProviderKind,
        executable: &Path,
        started: Instant,
    ) -> Option<AiAgentCatalog> {
        self.entries
            .lock()
            .get(&kind)
            .filter(|entry| {
                entry.executable == executable
                    && entry.fetched >= started
                    && entry.fetched.elapsed() < CACHE_TTL
            })
            .map(|entry| entry.catalog.clone())
    }

    fn insert(&self, executable: PathBuf, fetched: Instant, catalog: AiAgentCatalog) {
        self.entries.lock().insert(
            catalog.kind,
            Entry {
                executable,
                fetched,
                catalog,
            },
        );
    }

    fn load_lock(&self, kind: AiProviderKind) -> Arc<tokio::sync::Mutex<()>> {
        self.loads.lock().entry(kind).or_default().clone()
    }
}

impl AiAgentCatalog {
    /// Pin a known native resolution without dropping an alias's context modifier.
    pub fn session_model(&self, id: &str) -> Option<&str> {
        let model = self.model(id)?;
        let resolved = model
            .resolved_model
            .as_deref()
            .filter(|value| !value.is_empty());
        if resolved == Some(id) {
            return resolved;
        }
        if let Some(start) = model.id.find('[') {
            let modifier = &model.id[start..];
            if modifier.ends_with(']') && !resolved.is_some_and(|value| value.ends_with(modifier)) {
                return Some(&model.id);
            }
        }
        Some(resolved.unwrap_or(&model.id))
    }

    /// Resolve native aliases and the agent's own default without guessing a model.
    pub fn model(&self, id: &str) -> Option<&AiAgentModel> {
        if id.is_empty() || id == "default" {
            return self
                .default_model
                .as_deref()
                .and_then(|id| {
                    self.models
                        .iter()
                        .find(|m| m.id == id || m.resolved_model.as_deref() == Some(id))
                })
                .or_else(|| self.models.iter().find(|m| m.is_default));
        }
        self.models.iter().find(|m| m.id == id).or_else(|| {
            self.models
                .iter()
                .find(|m| m.resolved_model.as_deref() == Some(id))
        })
    }
}

impl Kubepit {
    /// Uses the installed agent's own account and protocol; never invokes inference.
    /// The provider need not be saved yet, so settings drafts can use the picker.
    pub async fn ai_agent_catalog(
        &self,
        kind: AiProviderKind,
        refresh: bool,
    ) -> Result<AiAgentCatalog> {
        let started = Instant::now();
        self.ai_catalog_allowed(kind)?;
        let executable = super::local_discovery::resolve(kind)
            .ok_or_else(|| anyhow::anyhow!("local assistant agent is not installed or is not executable; install it and refresh discovery"))?;
        let cache = &self.ai.agent_catalogs;
        if !refresh {
            if let Some(catalog) = cache.get(kind, &executable.path, Instant::now()) {
                return Ok(catalog);
            }
        }
        let load_lock = cache.load_lock(kind);
        let _load = load_lock.lock().await;
        self.ai_catalog_allowed(kind)?;
        if !refresh {
            if let Some(catalog) = cache.get(kind, &executable.path, Instant::now()) {
                return Ok(catalog);
            }
        } else if let Some(catalog) = cache.refreshed_since(kind, &executable.path, started) {
            return Ok(catalog);
        }
        let mut timeouts = self.ai.engine.timeouts();
        timeouts.total = timeouts.total.min(Duration::from_secs(45));
        let egress = Egress {
            remote_allowed: true,
            local_only: false,
        };
        let cancel = CancellationToken::new();
        let catalog = match kind {
            AiProviderKind::CodexCli | AiProviderKind::ClaudeCli => {
                LocalAgentProvider::new(kind, timeouts, egress)?
                    .catalog(cancel)
                    .await?
            }
            AiProviderKind::OpencodeCli => {
                OpenCodeCliProvider::new(kind, timeouts, egress)?
                    .catalog(cancel)
                    .await?
            }
            _ => unreachable!("unsupported catalog rejected before discovery"),
        };
        self.ai_catalog_allowed(kind)?;
        cache.insert(executable.path, Instant::now(), catalog.clone());
        Ok(catalog)
    }

    fn ai_catalog_allowed(&self, kind: AiProviderKind) -> Result<()> {
        if !kind.is_cli() || !super::local_discovery::supported(kind) {
            bail!("this local agent cannot disable its host tools and integrations; choose another assistant provider");
        }
        if !self.ai_remote_allowed() || self.settings().ai.local_only {
            bail!("local assistant agents may use cloud services; remote providers must be allowed and local-only mode must be off");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> AiAgentCatalog {
        AiAgentCatalog {
            kind: AiProviderKind::CodexCli,
            models: vec![AiAgentModel {
                id: "native-alias".into(),
                resolved_model: Some("native-v2".into()),
                is_default: true,
                ..Default::default()
            }],
            default_model: Some("native-alias".into()),
            authenticated: None,
            auth_method: None,
            version: None,
        }
    }

    #[test]
    fn cache_expires_and_tracks_executable_identity() {
        let cache = CatalogCache::default();
        let now = Instant::now();
        let exe = Path::new("/fixture/codex");
        cache.insert(exe.into(), now, catalog());
        assert!(cache.get(AiProviderKind::CodexCli, exe, now).is_some());
        assert!(cache.get(AiProviderKind::ClaudeCli, exe, now).is_none());
        assert!(cache
            .get(AiProviderKind::CodexCli, Path::new("/new/codex"), now)
            .is_none());
        assert!(cache
            .get(AiProviderKind::CodexCli, exe, now + CACHE_TTL)
            .is_none());
        assert!(cache
            .refreshed_since(AiProviderKind::CodexCli, exe, now)
            .is_some());
        assert!(cache
            .refreshed_since(AiProviderKind::CodexCli, exe, now + Duration::from_secs(1))
            .is_none());
    }

    #[test]
    fn model_lookup_preserves_native_aliases_and_default() {
        let mut catalog = catalog();
        assert_eq!(catalog.model("default").unwrap().id, "native-alias");
        assert_eq!(catalog.model("native-v2").unwrap().id, "native-alias");
        assert!(catalog.model("unknown").is_none());
        catalog.default_model = None;
        catalog.models[0].is_default = false;
        assert!(catalog.model("default").is_none());
    }

    #[test]
    fn session_resolution_keeps_alias_context_modifiers() {
        let mut catalog = catalog();
        assert_eq!(catalog.session_model("default"), Some("native-v2"));
        catalog.models[0].id = "native-alias[1m]".into();
        catalog.default_model = Some("native-alias[1m]".into());
        assert_eq!(catalog.session_model("default"), Some("native-alias[1m]"));
        assert_eq!(
            catalog.session_model("native-alias[1m]"),
            Some("native-alias[1m]")
        );
        assert_eq!(catalog.session_model("native-v2"), Some("native-v2"));
        catalog.models[0].resolved_model = Some("native-v2[1m]".into());
        assert_eq!(catalog.session_model("default"), Some("native-v2[1m]"));
    }
}
