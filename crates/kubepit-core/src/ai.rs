//! AI assistant: opt-in, local-first help with diagnosis and authoring
//! (spec `docs/superpowers/specs/2026-09-28-ai-assistant-design.md`).
//!
//! Everything that can leave the machine goes through this module, so the
//! privacy rules are enforced (and tested) in one place:
//!
//! - **Off by default, per cluster.** `Settings.ai.enabled` is off; each
//!   cluster is enabled with [`Kubepit::ai_cluster_set`], production ones only
//!   with the user's typed acknowledgement (`ai.production_acknowledged`).
//!   `settings_set` cannot change either list, removing a cluster (or
//!   making it production) forgets it, and loading drops what the registry
//!   no longer allows.
//! - **Keys** live in the OS credential store at `ai/<provider-id>`
//!   ([`keys`]), bound to the provider kind and origin they were saved for;
//!   they are never written under the data folder, never returned to the
//!   webview and never sent over plain `http://` to another computer.
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
//! | [`tools`]    | read-only tool catalog, input parsing, executor       |
//! | [`logs`]     | plain-text log condensation for tool results          |

pub mod keys;
pub mod logs;
pub mod provider;
pub mod settings;
pub mod tools;
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
    /// What each provider's stored key is bound to (never the key).
    key_bindings: keys::BindingCache,
    /// Held across a key write or delete *and* its cache update, so the
    /// cache always describes the entry the credential store ends up with.
    key_writes: parking_lot::Mutex<()>,
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

    /// The binding of a provider's stored key: cached after the first
    /// successful read; a failed read (locked store) is retried next time.
    fn ai_key_binding(&self, provider_id: &str) -> Result<keys::KeyBinding> {
        if let Some(binding) = self.ai.key_bindings.get(provider_id) {
            return Ok(binding);
        }
        let epoch = self.ai.key_bindings.epoch();
        let binding = keys::read_binding(self.secrets.as_ref(), provider_id)?;
        self.ai
            .key_bindings
            .insert_read(provider_id, binding.clone(), epoch);
        Ok(binding)
    }

    /// `ai_status`: the switches, the credential store's name and, per
    /// provider, whether a usable key is stored and whether requests may go
    /// to it. Reads each provider's credential store entry once per process
    /// (then `ai_key_set` / `ai_key_delete` keep the cache current); never
    /// contacts a provider. A key saved for another address or provider
    /// type is `has_key: false` with a `key_error` saying so.
    pub fn ai_status(&self) -> AiStatus {
        let ai = self.settings().ai;
        let remote_allowed = self.ai_remote_allowed();
        let providers = ai
            .providers
            .iter()
            .map(|p| {
                let (has_key, key_error) = match self.ai_key_binding(&p.id) {
                    Ok(binding) => match binding.check(p) {
                        Ok(present) => (present, None),
                        Err(mismatch) => (false, Some(mismatch.to_string())),
                    },
                    Err(e) => (false, Some(format!("{e:#}"))),
                };
                AiProviderStatus {
                    id: p.id.clone(),
                    kind: p.kind,
                    local: is_loopback(&p.base_url),
                    has_key,
                    key_error,
                    allowed: settings::provider_allowed(p, has_key, remote_allowed, ai.local_only),
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
    /// credential store (never on disk, never returned), bound to the
    /// provider's kind and current origin (`ai/keys.rs`). Surrounding
    /// whitespace from a paste is dropped; at most 8 KiB; only for an
    /// `https://` or loopback base URL.
    pub fn ai_key_set(&self, provider_id: &str, key: &str) -> Result<AiStatus> {
        let ai = self.settings().ai;
        let provider = ai
            .provider(provider_id.trim())
            .ok_or_else(|| anyhow!("there is no assistant provider {provider_id}"))?;
        let key = key.trim();
        if key.is_empty() {
            bail!("the API key is empty");
        }
        if key.len() > keys::MAX_KEY_BYTES {
            bail!("the API key is longer than 8 KiB");
        }
        if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            bail!("the API key must not contain spaces or line breaks");
        }
        let binding = keys::binding_for(provider)?;
        {
            let _serialized = self.ai.key_writes.lock();
            let written = keys::write_key(self.secrets.as_ref(), provider, key).map_err(|e| {
                anyhow!(
                    "could not store the {} API key in the {}: {e:#}",
                    provider.name,
                    self.secrets.name()
                )
            });
            match written {
                Ok(()) => self.ai.key_bindings.set(&provider.id, binding),
                Err(e) => {
                    // A partial write may have left anything behind.
                    self.ai.key_bindings.forget(&provider.id);
                    return Err(e);
                }
            }
        }
        Ok(self.ai_status())
    }

    /// `ai_key_delete`: remove a provider's key (also of a provider that is
    /// no longer configured). Succeeds when there is none.
    pub fn ai_key_delete(&self, provider_id: &str) -> Result<AiStatus> {
        let provider_id = provider_id.trim();
        if provider_id.is_empty() {
            bail!("no assistant provider given");
        }
        {
            let _serialized = self.ai.key_writes.lock();
            let deleted = keys::delete_key(self.secrets.as_ref(), provider_id).map_err(|e| {
                anyhow!(
                    "could not remove the API key from the {}: {e:#}",
                    self.secrets.name()
                )
            });
            match deleted {
                Ok(()) => self
                    .ai
                    .key_bindings
                    .set(provider_id, keys::KeyBinding::Missing),
                Err(e) => {
                    self.ai.key_bindings.forget(provider_id);
                    return Err(e);
                }
            }
        }
        Ok(self.ai_status())
    }

    /// `ai_cluster_set`: enable or disable the assistant for a cluster.
    /// Enabling a production cluster needs `acknowledge_production` (the
    /// UI's typed confirmation), which is recorded in
    /// `ai.production_acknowledged`. The cluster is read under the settings
    /// lock (lock order: settings, then clusters), so it cannot become
    /// production between the check and the write; `cluster_update` then
    /// forgets it. Returns the saved settings.
    pub fn ai_cluster_set(
        &self,
        cluster_id: &str,
        enabled: bool,
        acknowledge_production: bool,
    ) -> Result<Settings> {
        let ((), saved) = self.store.update_settings(|settings| {
            if !enabled {
                settings.ai.forget_cluster(cluster_id);
                return Ok(());
            }
            let cluster = self
                .store
                .cluster(cluster_id)
                .ok_or_else(|| anyhow!("cluster {cluster_id} is not registered"))?;
            let production = cluster.environment == Some(ClusterEnvironment::Production);
            if production && !acknowledge_production {
                bail!(
                    "{} is a production cluster: confirm to enable the assistant",
                    cluster.name
                );
            }
            settings.ai.enable_cluster(cluster_id, production);
            Ok(())
        })?;
        Ok(saved)
    }

    /// Disable the assistant for a cluster (it becomes production). The
    /// membership check runs under the settings lock; nothing is written
    /// when it was not enabled.
    pub(crate) fn ai_forget_cluster(&self, cluster_id: &str) -> Result<()> {
        self.store
            .update_settings(|settings| {
                settings.ai.forget_cluster(cluster_id);
                Ok(())
            })
            .map(|_| ())
    }

    /// Make a cluster's enablement match the registry after it changed or
    /// was removed ([`AiSettings::reconcile_cluster`]): an unregistered
    /// cluster is forgotten, a production one without an acknowledgement
    /// is disabled, a stale acknowledgement is dropped. Reads the cluster
    /// under the settings lock.
    ///
    /// Fails only when saving fails while a registered production cluster
    /// without an acknowledgement had to be disabled. Any other leftover
    /// (a stale acknowledgement, the id of a removed cluster) cannot enable
    /// anything ([`AiSettings::cluster_allowed`]) and is dropped at the
    /// next start, so failing to save it is logged.
    pub(crate) fn ai_reconcile_cluster(&self, cluster_id: &str) -> Result<()> {
        let mut disables_production = false;
        let saved = self.store.update_settings(|settings| {
            let cluster = self.store.cluster(cluster_id);
            let was_enabled = settings.ai.is_cluster_enabled(cluster_id);
            settings.ai.reconcile_cluster(cluster_id, cluster.as_ref());
            disables_production =
                cluster.is_some() && was_enabled && !settings.ai.is_cluster_enabled(cluster_id);
            Ok(())
        });
        match saved {
            Ok(_) => Ok(()),
            Err(e) if disables_production => Err(e),
            Err(e) => {
                tracing::warn!(
                    cluster = cluster_id,
                    "could not tidy the assistant's cluster lists (done at the next start): {e:#}"
                );
                Ok(())
            }
        }
    }
}
