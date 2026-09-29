//! AI assistant: opt-in, local-first help with diagnosis and authoring
//! (spec `docs/superpowers/specs/2026-09-28-ai-assistant-design.md`).
//!
//! Everything that can leave the machine goes through this module, so the
//! privacy rules are enforced (and tested) in one place:
//!
//! - **Off by default, per cluster.** `Settings.ai.enabled` is off; each
//!   cluster is enabled with [`Kubepit::ai_cluster_set`], production ones only
//!   with the user's typed acknowledgement. `settings_set` cannot change the
//!   enabled clusters, and removing a cluster (or making it production)
//!   forgets it.
//! - **Keys** live in the OS credential store at `ai/<provider-id>`
//!   ([`keys`]); they are never written under the data folder and never
//!   returned to the webview.
//! - **Remote egress is opt-in per process**
//!   ([`Kubepit::set_ai_remote_providers`]): without it only loopback
//!   providers are allowed ([`settings::egress_allowed`]). The desktop shell
//!   turns it on; tests never do. Local-only mode refuses every remote
//!   provider even then.
//! - The module schedules no background work.
//!
//! | Module       | Responsibility                                        |
//! |--------------|-------------------------------------------------------|
//! | [`types`]    | serde contract types mirrored in `types/index.ts`     |
//! | [`settings`] | defaults, normalization, loopback / egress rule       |
//! | [`keys`]     | `ai/<provider-id>` credential store entries           |
//! | [`provider`] | the `Provider` trait and chat types (`ToolSpec`)      |

pub mod budget;
pub mod context;
pub mod keys;
pub mod prompts;
pub mod provider;
pub mod redact;
pub mod settings;
pub mod types;

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, bail, Result};

use crate::app::Kubepit;
use crate::types::{ClusterEnvironment, Settings};

pub use settings::{egress_allowed, is_loopback};
pub use types::*;

/// Assistant state owned by [`Kubepit`].
#[derive(Default)]
pub struct AiState {
    /// Non-loopback providers may be reached from this process (D5).
    remote_allowed: AtomicBool,
}

impl Kubepit {
    /// Allow requests to remote (non-loopback) model providers from this
    /// process. Only the desktop shell calls this; tests never do, so no
    /// test can reach a real provider.
    pub fn set_ai_remote_providers(&self, on: bool) {
        self.ai.remote_allowed.store(on, Ordering::SeqCst);
    }

    pub fn ai_remote_allowed(&self) -> bool {
        self.ai.remote_allowed.load(Ordering::SeqCst)
    }

    /// `ai_status`: the switches, the credential store's name and, per
    /// provider, whether a key is stored and whether requests may go to it.
    /// Reads the credential store; never contacts a provider.
    pub fn ai_status(&self) -> AiStatus {
        let ai = self.settings().ai;
        let remote_allowed = self.ai_remote_allowed();
        let providers = ai
            .providers
            .iter()
            .map(|p| {
                let (has_key, key_error) = match keys::read_key(self.secrets.as_ref(), &p.id) {
                    Ok(key) => (key.is_some(), None),
                    Err(e) => (false, Some(format!("{e:#}"))),
                };
                AiProviderStatus {
                    id: p.id.clone(),
                    kind: p.kind,
                    local: is_loopback(&p.base_url),
                    has_key,
                    key_error,
                    allowed: egress_allowed(&p.base_url, remote_allowed, ai.local_only),
                }
            })
            .collect();
        AiStatus {
            enabled: ai.enabled,
            local_only: ai.local_only,
            remote_allowed,
            keychain: self.secrets.name().to_string(),
            providers,
        }
    }

    /// `ai_key_set`: store the API key of a configured provider in the
    /// credential store (never on disk, never returned). Surrounding
    /// whitespace from a paste is dropped.
    pub fn ai_key_set(&self, provider_id: &str, key: &str) -> Result<AiStatus> {
        let ai = self.settings().ai;
        let provider = ai
            .provider(provider_id.trim())
            .ok_or_else(|| anyhow!("there is no assistant provider {provider_id}"))?;
        let key = key.trim();
        if key.is_empty() {
            bail!("the API key is empty");
        }
        if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            bail!("the API key must not contain spaces or line breaks");
        }
        keys::write_key(self.secrets.as_ref(), &provider.id, key).map_err(|e| {
            anyhow!(
                "could not store the {} API key in the {}: {e:#}",
                provider.name,
                self.secrets.name()
            )
        })?;
        Ok(self.ai_status())
    }

    /// `ai_key_delete`: remove a provider's key (also of a provider that is
    /// no longer configured). Succeeds when there is none.
    pub fn ai_key_delete(&self, provider_id: &str) -> Result<AiStatus> {
        let provider_id = provider_id.trim();
        if provider_id.is_empty() {
            bail!("no assistant provider given");
        }
        keys::delete_key(self.secrets.as_ref(), provider_id).map_err(|e| {
            anyhow!(
                "could not remove the API key from the {}: {e:#}",
                self.secrets.name()
            )
        })?;
        Ok(self.ai_status())
    }

    /// `ai_cluster_set`: enable or disable the assistant for a cluster.
    /// Enabling a production cluster needs `acknowledge_production` (the
    /// UI's typed confirmation). Returns the saved settings.
    pub fn ai_cluster_set(
        &self,
        cluster_id: &str,
        enabled: bool,
        acknowledge_production: bool,
    ) -> Result<Settings> {
        if enabled {
            let cluster = self.cluster_def(cluster_id)?;
            if cluster.environment == Some(ClusterEnvironment::Production)
                && !acknowledge_production
            {
                bail!(
                    "{} is a production cluster: confirm to enable the assistant",
                    cluster.name
                );
            }
        }
        self.store.update_settings(|settings| {
            let clusters = &mut settings.ai.clusters;
            clusters.retain(|id| id != cluster_id);
            if enabled {
                clusters.push(cluster_id.to_string());
            }
            clusters.sort();
            clusters.dedup();
        })
    }

    /// Drop a cluster from the enabled list (cluster removed, or it became
    /// a production cluster).
    pub(crate) fn ai_forget_cluster(&self, cluster_id: &str) {
        if !self.settings().ai.is_cluster_enabled(cluster_id) {
            return;
        }
        let saved = self.store.update_settings(|settings| {
            settings.ai.clusters.retain(|id| id != cluster_id);
        });
        if let Err(e) = saved {
            tracing::warn!("could not disable the assistant for cluster {cluster_id}: {e:#}");
        }
    }
}
