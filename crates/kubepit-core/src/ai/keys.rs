//! Provider API keys in the OS credential store, at `ai/<provider-id>`.
//!
//! Keys go through [`crate::secrets`] (`write_value` chunks them where the
//! store caps entry sizes) on the store the process was opened with,
//! whatever `keychain_kubeconfigs` says. There is no plaintext fallback: a
//! locked or missing store is an error, and nothing is written under the
//! data folder. Tests use `MemorySecretStore`; `Kubepit::open` uses
//! `DisabledSecretStore`, so they can never reach the OS store.

use anyhow::{anyhow, Result};

use crate::secrets::{delete_value, read_value, write_value, SecretStore};

/// `ai/<provider-id>`.
pub fn key_name(provider_id: &str) -> String {
    format!("ai/{provider_id}")
}

/// The stored key; `Ok(None)` when there is none (or it is empty).
pub fn read_key(store: &dyn SecretStore, provider_id: &str) -> Result<Option<String>> {
    let Some(bytes) = read_value(store, &key_name(provider_id))? else {
        return Ok(None);
    };
    let key = String::from_utf8(bytes).map_err(|_| {
        anyhow!(
            "the {} entry {} is not valid text",
            store.name(),
            key_name(provider_id)
        )
    })?;
    Ok(Some(key).filter(|k| !k.is_empty()))
}

pub fn write_key(store: &dyn SecretStore, provider_id: &str, key: &str) -> Result<()> {
    write_value(store, &key_name(provider_id), key.as_bytes())
}

/// Succeeds when there is no key.
pub fn delete_key(store: &dyn SecretStore, provider_id: &str) -> Result<()> {
    delete_value(store, &key_name(provider_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecretStore;

    #[test]
    fn keys_round_trip_under_their_own_names() {
        // Chunked like on Windows (chunk headers are ~34 bytes).
        let store = MemorySecretStore::with_max_len(40);
        let key = format!("sk-ant-{}", "0123456789".repeat(10));
        assert_eq!(read_key(&store, "anthropic").unwrap(), None);
        write_key(&store, "anthropic", &key).unwrap();
        assert_eq!(read_key(&store, "anthropic").unwrap(), Some(key));
        assert!(store.keys().len() > 1);
        assert!(store.keys().iter().all(|k| k.starts_with("ai/anthropic")));
        delete_key(&store, "anthropic").unwrap();
        assert!(store.keys().is_empty());
        delete_key(&store, "anthropic").unwrap();
    }

    #[test]
    fn empty_or_invalid_entries_are_reported() {
        let store = MemorySecretStore::default();
        store.set("ai/openai", b"").unwrap();
        assert_eq!(read_key(&store, "openai").unwrap(), None);
        store.set("ai/openai", &[0xff, 0xfe]).unwrap();
        assert!(read_key(&store, "openai").is_err());
        store.set_available(false);
        let err = read_key(&store, "openai").unwrap_err().to_string();
        assert!(err.contains("locked"), "{err}");
    }
}
