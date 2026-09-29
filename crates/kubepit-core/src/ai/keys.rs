//! Provider API keys in the OS credential store, at `ai/<provider-id>`.
//!
//! Keys go through [`crate::secrets`] (`write_value` chunks them where the
//! store caps entry sizes) on the store the process was opened with,
//! whatever `keychain_kubeconfigs` says. There is no plaintext fallback: a
//! locked or missing store is an error, and nothing is written under the
//! data folder. Tests use `MemorySecretStore`; `Kubepit::open` uses
//! `DisabledSecretStore`, so they can never reach the OS store.
//!
//! **A key is bound to the endpoint it was saved for.** The entry is
//! `{"v":1,"kind":"anthropic","origin":"https://api.anthropic.com","key":"…"}`
//! where `origin` is `scheme://host[:port]` of the provider's base URL at
//! the time ([`settings::origin`]). The binding is per origin: the path is
//! ignored, so `https://gw.example/a` and `https://gw.example/b` share one
//! (the same server is trusted with the key either way). [`read_key`] only
//! returns the key while the provider still has that kind and origin, so
//! editing a base URL can never send a stored key to another server;
//! anything else (another origin or kind, an older raw entry, another
//! app's value) is a [`KeyMismatch`] and the user sets the key again.
//! Keys are only bound to `https://` or loopback origins
//! ([`settings::key_safe`]): never sent in plain text over the network.

use std::collections::HashMap;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use super::settings;
use super::types::{AiProviderConfig, AiProviderKind};
use crate::secrets::{delete_value, read_value, write_value, SecretStore};

/// Longest API key `ai_key_set` accepts.
pub const MAX_KEY_BYTES: usize = 8 * 1024;

/// `ai/<provider-id>`.
pub fn key_name(provider_id: &str) -> String {
    format!("ai/{provider_id}")
}

/// The stored entry (version 1). No `Debug`: it holds the key.
#[derive(Serialize, Deserialize)]
struct Entry {
    v: u32,
    kind: AiProviderKind,
    origin: String,
    key: String,
}

/// What a stored entry is bound to, without the key. Safe to keep in
/// memory ([`BindingCache`]) and to compare with a provider's settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyBinding {
    /// No entry, or an empty key.
    Missing,
    /// A key for a provider of `kind` at `origin`.
    Bound {
        kind: AiProviderKind,
        origin: String,
    },
    /// An entry this version cannot bind: an older raw key, another format
    /// or another app's value.
    Unbound,
}

/// A stored key that must not be used for this provider. The message
/// never contains the key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyMismatch {
    #[error("The key was saved for {saved}; set it again for this address.")]
    Origin { saved: String },
    #[error("The key was saved for a provider of type {}; set it again for this provider.", saved.as_str())]
    Kind { saved: AiProviderKind },
    #[error("The stored key is not bound to an address (saved by an older version or another app); set it again.")]
    Unbound,
}

impl KeyBinding {
    /// `Ok(true)` when the stored key may be used for `provider`,
    /// `Ok(false)` when there is none.
    pub fn check(&self, provider: &AiProviderConfig) -> Result<bool, KeyMismatch> {
        match self {
            Self::Missing => Ok(false),
            Self::Unbound => Err(KeyMismatch::Unbound),
            Self::Bound { kind, origin } => {
                if settings::origin(&provider.base_url).as_deref() != Some(origin.as_str()) {
                    return Err(KeyMismatch::Origin {
                        saved: origin.clone(),
                    });
                }
                if *kind != provider.kind {
                    return Err(KeyMismatch::Kind { saved: *kind });
                }
                Ok(true)
            }
        }
    }
}

/// The kind and origin a key for `provider` is bound to. Fails when its
/// base URL is not usable, or is plain `http://` to another computer.
pub fn binding_for(provider: &AiProviderConfig) -> Result<KeyBinding> {
    let Some(origin) = settings::origin(&provider.base_url) else {
        bail!(
            "{} has no valid base URL: set one before its API key",
            provider.name
        );
    };
    if !settings::key_safe(&origin) {
        bail!(
            "{} uses plain http:// to another computer ({origin}): API keys are only sent over \
             https:// or to this computer",
            provider.name
        );
    }
    Ok(KeyBinding::Bound {
        kind: provider.kind,
        origin,
    })
}

/// The binding and the key of a raw entry.
fn parse(bytes: &[u8]) -> (KeyBinding, Option<String>) {
    if bytes.is_empty() {
        return (KeyBinding::Missing, None);
    }
    let Ok(entry) = serde_json::from_slice::<Entry>(bytes) else {
        return (KeyBinding::Unbound, None);
    };
    // Only a canonical, key-safe origin is echoed back or trusted.
    let origin_ok = settings::origin(&entry.origin).as_deref() == Some(entry.origin.as_str())
        && settings::key_safe(&entry.origin);
    if entry.v != 1 || !origin_ok {
        return (KeyBinding::Unbound, None);
    }
    if entry.key.is_empty() {
        return (KeyBinding::Missing, None);
    }
    let binding = KeyBinding::Bound {
        kind: entry.kind,
        origin: entry.origin,
    };
    (binding, Some(entry.key))
}

/// What the entry of `provider_id` is bound to; the key is read and
/// dropped. Errors are the store's (locked, missing).
pub fn read_binding(store: &dyn SecretStore, provider_id: &str) -> Result<KeyBinding> {
    Ok(match read_value(store, &key_name(provider_id))? {
        Some(bytes) => parse(&bytes).0,
        None => KeyBinding::Missing,
    })
}

/// The key of `provider`: `Ok(None)` when there is none; a [`KeyMismatch`]
/// error (downcastable) when the stored key was saved for another origin
/// or kind, or is not a bound entry; the store's error when it cannot be
/// read.
pub fn read_key(store: &dyn SecretStore, provider: &AiProviderConfig) -> Result<Option<String>> {
    let Some(bytes) = read_value(store, &key_name(&provider.id))? else {
        return Ok(None);
    };
    let (binding, key) = parse(&bytes);
    Ok(if binding.check(provider)? { key } else { None })
}

/// Store `key` for `provider`, bound to its kind and current origin
/// ([`binding_for`]).
pub fn write_key(store: &dyn SecretStore, provider: &AiProviderConfig, key: &str) -> Result<()> {
    let KeyBinding::Bound { kind, origin } = binding_for(provider)? else {
        unreachable!("binding_for only returns Bound");
    };
    let entry = Entry {
        v: 1,
        kind,
        origin,
        key: key.to_string(),
    };
    let bytes = serde_json::to_vec(&entry).map_err(|e| anyhow!("cannot encode the key: {e}"))?;
    write_value(store, &key_name(&provider.id), &bytes)
}

/// Succeeds when there is no key.
pub fn delete_key(store: &dyn SecretStore, provider_id: &str) -> Result<()> {
    delete_value(store, &key_name(provider_id))
}

/// Per-provider [`KeyBinding`]s already read (never the keys), so
/// `ai_status` does not read every secret (and maybe prompt) on each call.
/// Errors are never cached: a locked store is read again next time.
/// `ai_key_set` / `ai_key_delete` update it; a key changed outside Kubepit
/// shows up after a restart.
#[derive(Default)]
pub(crate) struct BindingCache {
    state: parking_lot::Mutex<CacheState>,
}

#[derive(Default)]
struct CacheState {
    /// Bumped by every set/forget, so a read that raced one is not cached.
    epoch: u64,
    bindings: HashMap<String, KeyBinding>,
}

impl BindingCache {
    pub(crate) fn get(&self, provider_id: &str) -> Option<KeyBinding> {
        self.state.lock().bindings.get(provider_id).cloned()
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.state.lock().epoch
    }

    /// Cache a binding read when the epoch was `epoch`, unless a set or
    /// forget happened since.
    pub(crate) fn insert_read(&self, provider_id: &str, binding: KeyBinding, epoch: u64) {
        let mut state = self.state.lock();
        if state.epoch == epoch {
            state.bindings.insert(provider_id.to_string(), binding);
        }
    }

    pub(crate) fn set(&self, provider_id: &str, binding: KeyBinding) {
        let mut state = self.state.lock();
        state.epoch += 1;
        state.bindings.insert(provider_id.to_string(), binding);
    }

    pub(crate) fn forget(&self, provider_id: &str) {
        let mut state = self.state.lock();
        state.epoch += 1;
        state.bindings.remove(provider_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::settings::default_providers;
    use crate::secrets::MemorySecretStore;

    fn provider(id: &str) -> AiProviderConfig {
        default_providers()
            .into_iter()
            .find(|p| p.id == id)
            .unwrap()
    }

    fn with_url(id: &str, base_url: &str) -> AiProviderConfig {
        AiProviderConfig {
            base_url: base_url.into(),
            ..provider(id)
        }
    }

    #[test]
    fn keys_round_trip_under_their_own_names() {
        // Chunked like on Windows (chunk headers are ~34 bytes).
        let store = MemorySecretStore::with_max_len(40);
        let anthropic = provider("anthropic");
        let key = format!("sk-ant-{}", "0123456789".repeat(10));
        assert_eq!(read_key(&store, &anthropic).unwrap(), None);
        write_key(&store, &anthropic, &key).unwrap();
        assert_eq!(read_key(&store, &anthropic).unwrap(), Some(key));
        assert!(store.keys().len() > 1);
        assert!(store.keys().iter().all(|k| k.starts_with("ai/anthropic")));
        delete_key(&store, "anthropic").unwrap();
        assert!(store.keys().is_empty());
        delete_key(&store, "anthropic").unwrap();
    }

    #[test]
    fn the_entry_binds_the_key_to_kind_and_origin() {
        let store = MemorySecretStore::default();
        write_key(
            &store,
            &with_url("anthropic", "HTTPS://API.anthropic.com:443/"),
            "k1",
        )
        .unwrap();
        let entry: serde_json::Value =
            serde_json::from_slice(&store.raw("ai/anthropic").unwrap()).unwrap();
        assert_eq!(
            entry,
            serde_json::json!({
                "v": 1, "kind": "anthropic", "origin": "https://api.anthropic.com", "key": "k1"
            })
        );
        // The same origin, spelled differently, or a different path: usable.
        for url in ["https://api.anthropic.com", "https://api.anthropic.com/v2/"] {
            let p = with_url("anthropic", url);
            assert_eq!(
                read_key(&store, &p).unwrap().as_deref(),
                Some("k1"),
                "{url}"
            );
        }
        // Another host, scheme or port: refused, with the saved origin.
        for url in [
            "https://gateway.example",
            "https://api.anthropic.com:8443",
            "http://127.0.0.1:4000",
            "",
        ] {
            let err = read_key(&store, &with_url("anthropic", url)).unwrap_err();
            let mismatch = err.downcast_ref::<KeyMismatch>().unwrap();
            assert_eq!(
                mismatch,
                &KeyMismatch::Origin {
                    saved: "https://api.anthropic.com".into()
                }
            );
            let text = err.to_string();
            assert!(
                text.contains("https://api.anthropic.com") && !text.contains("k1"),
                "{text}"
            );
        }
        // Another kind at the same origin.
        let other_kind = AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            ..provider("anthropic")
        };
        let err = read_key(&store, &other_kind).unwrap_err();
        assert!(matches!(
            err.downcast_ref::<KeyMismatch>(),
            Some(KeyMismatch::Kind {
                saved: AiProviderKind::Anthropic
            })
        ));
        assert_eq!(
            read_binding(&store, "anthropic").unwrap(),
            KeyBinding::Bound {
                kind: AiProviderKind::Anthropic,
                origin: "https://api.anthropic.com".into()
            }
        );
    }

    #[test]
    fn foreign_or_old_entries_are_mismatches_that_never_echo_the_value() {
        let store = MemorySecretStore::default();
        let openai = provider("openai");
        let raw_key = "sk-old-raw-key-0123456789";
        for value in [
            raw_key.as_bytes().to_vec(),
            vec![0xff, 0xfe],
            format!(r#"{{"v":2,"kind":"openai-compatible","origin":"https://api.openai.com","key":"{raw_key}"}}"#).into_bytes(),
            format!(r#"{{"v":1,"kind":"gemini","origin":"https://api.openai.com","key":"{raw_key}"}}"#).into_bytes(),
            // Not canonical, or plain http over the network: not trusted.
            format!(r#"{{"v":1,"kind":"openai-compatible","origin":"https://api.openai.com/v1","key":"{raw_key}"}}"#).into_bytes(),
            format!(r#"{{"v":1,"kind":"openai-compatible","origin":"http://10.0.0.1","key":"{raw_key}"}}"#).into_bytes(),
            format!(r#"{{"v":1,"kind":"openai-compatible","origin":"{raw_key}","key":"x"}}"#).into_bytes(),
        ] {
            store.set("ai/openai", &value).unwrap();
            let err = read_key(&store, &openai).unwrap_err();
            assert_eq!(err.downcast_ref::<KeyMismatch>(), Some(&KeyMismatch::Unbound));
            assert!(!err.to_string().contains(raw_key));
            assert_eq!(read_binding(&store, "openai").unwrap(), KeyBinding::Unbound);
        }
    }

    #[test]
    fn empty_entries_are_missing_and_store_errors_are_reported() {
        let store = MemorySecretStore::default();
        let openai = provider("openai");
        store.set("ai/openai", b"").unwrap();
        assert_eq!(read_key(&store, &openai).unwrap(), None);
        store
            .set(
                "ai/openai",
                br#"{"v":1,"kind":"openai-compatible","origin":"https://api.openai.com","key":""}"#,
            )
            .unwrap();
        assert_eq!(read_key(&store, &openai).unwrap(), None);
        assert_eq!(read_binding(&store, "openai").unwrap(), KeyBinding::Missing);
        store.set_available(false);
        let err = read_key(&store, &openai).unwrap_err();
        assert!(err.downcast_ref::<KeyMismatch>().is_none());
        assert!(err.to_string().contains("locked"), "{err}");
    }

    #[test]
    fn keys_are_only_bound_to_https_or_this_computer() {
        let store = MemorySecretStore::default();
        for url in [
            "http://10.0.0.5:8000/v1",
            "http://gateway.lan",
            "",
            "ftp://x",
        ] {
            assert!(
                write_key(&store, &with_url("openai", url), "k").is_err(),
                "{url}"
            );
        }
        assert!(store.keys().is_empty());
        for url in [
            "http://127.0.0.1:4000/v1",
            "http://localhost:1234",
            "https://x.example",
        ] {
            write_key(&store, &with_url("openai", url), "k").unwrap();
            assert_eq!(
                read_key(&store, &with_url("openai", url))
                    .unwrap()
                    .as_deref(),
                Some("k")
            );
        }
    }

    #[test]
    fn the_cache_ignores_reads_that_raced_a_change() {
        let cache = BindingCache::default();
        let epoch = cache.epoch();
        cache.set("anthropic", KeyBinding::Missing);
        cache.insert_read("anthropic", KeyBinding::Unbound, epoch);
        assert_eq!(cache.get("anthropic"), Some(KeyBinding::Missing));
        let epoch = cache.epoch();
        cache.insert_read("openai", KeyBinding::Unbound, epoch);
        assert_eq!(cache.get("openai"), Some(KeyBinding::Unbound));
        cache.forget("openai");
        assert_eq!(cache.get("openai"), None);
    }
}
