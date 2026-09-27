//! OS credential store access behind the [`SecretStore`] trait.
//!
//! When `settings.keychain_kubeconfigs` is on, pasted (managed) kubeconfigs
//! live in the platform credential store instead of `kubeconfigs/<id>.yaml`:
//! the macOS Keychain, the Windows Credential Manager or the Secret Service
//! on Linux ([`KeyringSecretStore`], service `io.github.erdembas.kubepit`).
//!
//! Tests never touch the real store: [`crate::Kubepit::open`] uses
//! [`DisabledSecretStore`], tests pass a [`MemorySecretStore`], and only the
//! desktop shell wires up the keyring.
//!
//! Some stores cap the size of one entry (Windows: 2 560 bytes, far below a
//! kubeconfig with embedded certificates), so [`write_value`] splits large
//! values over several entries: the chunks are written first, then a small
//! header at the key names them (the commit point), then the chunks of the
//! previous value are deleted. A crash in between leaves orphan chunks, never
//! a half-written value.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;

/// Service name of every Kubepit entry in the OS credential store.
pub const SERVICE: &str = "io.github.erdembas.kubepit";

/// A byte-string key/value store for secrets.
pub trait SecretStore: Send + Sync + 'static {
    /// Human-readable name for messages ("macOS Keychain").
    fn name(&self) -> &str;
    /// `Ok(None)` when there is no entry for `key`.
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    fn set(&self, key: &str, value: &[u8]) -> Result<()>;
    /// Remove `key`; succeeds when it does not exist.
    fn delete(&self, key: &str) -> Result<()>;
    /// Largest value one entry can hold, if the store has a limit.
    fn max_value_len(&self) -> Option<usize> {
        None
    }
}

// -- Chunked values ---------------------------------------------------------

const CHUNK_MAGIC: &str = "kubepit-chunked:v1:";

fn chunk_key(key: &str, generation: &str, index: usize) -> String {
    format!("{key}#{generation}.{index}")
}

/// `(generation, count)` when `value` is a chunk header.
fn parse_header(value: &[u8]) -> Option<(String, usize)> {
    let text = std::str::from_utf8(value).ok()?;
    let rest = text.strip_prefix(CHUNK_MAGIC)?;
    let (generation, count) = rest.split_once(':')?;
    let count = count.parse::<usize>().ok()?;
    let valid = !generation.is_empty() && generation.chars().all(|c| c.is_ascii_hexdigit());
    valid.then(|| (generation.to_string(), count))
}

fn delete_chunks(store: &dyn SecretStore, key: &str, generation: &str, count: usize) {
    for index in 0..count {
        if let Err(e) = store.delete(&chunk_key(key, generation, index)) {
            tracing::warn!("could not delete a credential store chunk of {key}: {e:#}");
        }
    }
}

/// Store `value` at `key`, splitting it when the store caps entry sizes.
pub fn write_value(store: &dyn SecretStore, key: &str, value: &[u8]) -> Result<()> {
    let previous = store.get(key)?.and_then(|v| parse_header(&v));
    match store.max_value_len() {
        Some(max) if value.len() > max => {
            let max = max.max(1);
            let generation = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
            let chunks: Vec<&[u8]> = value.chunks(max).collect();
            for (index, chunk) in chunks.iter().enumerate() {
                if let Err(e) = store.set(&chunk_key(key, &generation, index), chunk) {
                    delete_chunks(store, key, &generation, index);
                    return Err(e);
                }
            }
            let header = format!("{CHUNK_MAGIC}{generation}:{}", chunks.len());
            if let Err(e) = store.set(key, header.as_bytes()) {
                delete_chunks(store, key, &generation, chunks.len());
                return Err(e);
            }
        }
        _ => store.set(key, value)?,
    }
    if let Some((generation, count)) = previous {
        delete_chunks(store, key, &generation, count);
    }
    Ok(())
}

/// Read a value written by [`write_value`].
pub fn read_value(store: &dyn SecretStore, key: &str) -> Result<Option<Vec<u8>>> {
    let Some(value) = store.get(key)? else {
        return Ok(None);
    };
    let Some((generation, count)) = parse_header(&value) else {
        return Ok(Some(value));
    };
    let mut out = Vec::new();
    for index in 0..count {
        let chunk = store
            .get(&chunk_key(key, &generation, index))?
            .ok_or_else(|| anyhow!("the {} entry {key} is incomplete", store.name()))?;
        out.extend_from_slice(&chunk);
    }
    Ok(Some(out))
}

/// Delete a value written by [`write_value`] (and its chunks).
pub fn delete_value(store: &dyn SecretStore, key: &str) -> Result<()> {
    if let Some((generation, count)) = store.get(key)?.and_then(|v| parse_header(&v)) {
        delete_chunks(store, key, &generation, count);
    }
    store.delete(key)
}

// -- Implementations --------------------------------------------------------

/// No credential store: reads find nothing, writes fail with a clear error.
/// The default of [`crate::Kubepit::open`], so library users and tests can
/// never reach the real OS store by accident.
#[derive(Debug, Default, Clone, Copy)]
pub struct DisabledSecretStore;

impl SecretStore for DisabledSecretStore {
    fn name(&self) -> &str {
        "OS credential store"
    }

    fn get(&self, _key: &str) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }

    fn set(&self, _key: &str, _value: &[u8]) -> Result<()> {
        bail!("no OS credential store is available in this build")
    }

    fn delete(&self, _key: &str) -> Result<()> {
        Ok(())
    }
}

/// In-memory store for tests, with failure injection.
#[derive(Default)]
pub struct MemorySecretStore {
    entries: Mutex<HashMap<String, Vec<u8>>>,
    max_len: Option<usize>,
    unavailable: AtomicBool,
    /// Successful `set` calls left before writes start failing.
    sets_left: Mutex<Option<usize>>,
    writes: AtomicUsize,
}

impl MemorySecretStore {
    /// A store whose entries hold at most `max_len` bytes (like Windows).
    pub fn with_max_len(max_len: usize) -> Self {
        Self {
            max_len: Some(max_len),
            ..Self::default()
        }
    }

    /// Make every operation fail as if the store were locked or missing.
    pub fn set_available(&self, available: bool) {
        self.unavailable.store(!available, Ordering::SeqCst);
    }

    /// Let `count` more writes succeed, then fail every write.
    pub fn fail_writes_after(&self, count: usize) {
        *self.sets_left.lock() = Some(count);
    }

    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.entries.lock().keys().cloned().collect();
        keys.sort();
        keys
    }

    pub fn raw(&self, key: &str) -> Option<Vec<u8>> {
        self.entries.lock().get(key).cloned()
    }

    /// Number of successful writes so far.
    pub fn write_count(&self) -> usize {
        self.writes.load(Ordering::SeqCst)
    }

    fn check(&self) -> Result<()> {
        if self.unavailable.load(Ordering::SeqCst) {
            bail!("the test credential store is locked");
        }
        Ok(())
    }
}

impl SecretStore for MemorySecretStore {
    fn name(&self) -> &str {
        "test credential store"
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.check()?;
        Ok(self.entries.lock().get(key).cloned())
    }

    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        self.check()?;
        if let Some(max) = self.max_len {
            if value.len() > max {
                bail!("value of {key} is longer than {max} bytes");
            }
        }
        {
            let mut left = self.sets_left.lock();
            if let Some(n) = left.as_mut() {
                if *n == 0 {
                    bail!("the test credential store refused the write");
                }
                *n -= 1;
            }
        }
        self.entries.lock().insert(key.to_string(), value.to_vec());
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.check()?;
        self.entries.lock().remove(key);
        Ok(())
    }

    fn max_value_len(&self) -> Option<usize> {
        self.max_len
    }
}

/// The platform credential store through the `keyring` crate.
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringSecretStore;

impl KeyringSecretStore {
    fn entry(&self, key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, key).map_err(|e| self.error(e))
    }

    fn error(&self, err: keyring::Error) -> anyhow::Error {
        let name = self.name();
        match err {
            keyring::Error::NoDefaultStore => {
                anyhow!("the {name} is not available on this system")
            }
            keyring::Error::NoStorageAccess(e) => {
                anyhow!("the {name} is locked or refused access: {e}")
            }
            keyring::Error::PlatformFailure(e) => anyhow!("the {name} failed: {e}"),
            other => anyhow!("the {name} failed: {other}"),
        }
    }
}

impl SecretStore for KeyringSecretStore {
    fn name(&self) -> &str {
        if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else if cfg!(windows) {
            "Windows Credential Manager"
        } else {
            "Secret Service"
        }
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match self.entry(key)?.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(self.error(e)),
        }
    }

    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        self.entry(key)?
            .set_secret(value)
            .map_err(|e| self.error(e))
            .with_context(|| format!("cannot store {key}"))
    }

    fn delete(&self, key: &str) -> Result<()> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(self.error(e)),
        }
    }

    fn max_value_len(&self) -> Option<usize> {
        // CRED_MAX_CREDENTIAL_BLOB_SIZE is 2 560 bytes; keep some headroom.
        cfg!(windows).then_some(2048)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_values_are_stored_as_is() {
        let store = MemorySecretStore::default();
        write_value(&store, "k", b"hello").unwrap();
        assert_eq!(store.raw("k").unwrap(), b"hello");
        assert_eq!(read_value(&store, "k").unwrap().unwrap(), b"hello");
        delete_value(&store, "k").unwrap();
        assert_eq!(read_value(&store, "k").unwrap(), None);
        delete_value(&store, "k").unwrap();
    }

    #[test]
    fn large_values_are_chunked_and_replaced_cleanly() {
        let store = MemorySecretStore::with_max_len(64);
        let big: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        write_value(&store, "kubeconfig/a", &big).unwrap();
        assert_eq!(read_value(&store, "kubeconfig/a").unwrap().unwrap(), big);
        let chunks = store.keys().len() - 1;
        assert_eq!(chunks, 1000usize.div_ceil(64));

        // Replacing drops the previous chunks.
        let other = vec![7u8; 200];
        write_value(&store, "kubeconfig/a", &other).unwrap();
        assert_eq!(read_value(&store, "kubeconfig/a").unwrap().unwrap(), other);
        assert_eq!(store.keys().len(), 1 + 200usize.div_ceil(64));

        // Shrinking below the limit stores it inline and cleans up.
        write_value(&store, "kubeconfig/a", b"tiny").unwrap();
        assert_eq!(store.keys(), vec!["kubeconfig/a".to_string()]);

        write_value(&store, "kubeconfig/a", &big).unwrap();
        delete_value(&store, "kubeconfig/a").unwrap();
        assert!(store.keys().is_empty());
    }

    #[test]
    fn a_failed_chunked_write_keeps_the_previous_value() {
        // Headers are ~34 bytes; real limits are in the kilobytes.
        let store = MemorySecretStore::with_max_len(40);
        let previous = vec![9u8; 100];
        write_value(&store, "k", &previous).unwrap();
        let before = store.keys();
        store.fail_writes_after(1);
        assert!(write_value(&store, "k", &[1u8; 100]).is_err());
        assert_eq!(store.keys(), before);
        assert_eq!(read_value(&store, "k").unwrap().unwrap(), previous);
    }

    #[test]
    fn unavailable_store_errors_and_missing_chunks_are_reported() {
        let store = MemorySecretStore::with_max_len(40);
        write_value(&store, "k", &[3u8; 100]).unwrap();
        let chunk = store.keys().into_iter().find(|k| k.contains('#')).unwrap();
        store.delete(&chunk).unwrap();
        let err = read_value(&store, "k").unwrap_err().to_string();
        assert!(err.contains("incomplete"), "{err}");

        store.set_available(false);
        assert!(read_value(&store, "k").is_err());
        assert!(write_value(&store, "k", b"x").is_err());
    }

    #[test]
    fn disabled_store_finds_nothing_and_refuses_writes() {
        let store = DisabledSecretStore;
        assert_eq!(store.get("k").unwrap(), None);
        assert!(store.set("k", b"v").is_err());
        store.delete("k").unwrap();
    }

    #[test]
    fn headers_are_parsed_strictly() {
        assert_eq!(
            parse_header(b"kubepit-chunked:v1:abc123:4"),
            Some(("abc123".to_string(), 4))
        );
        assert_eq!(parse_header(b"apiVersion: v1"), None);
        assert_eq!(parse_header(b"kubepit-chunked:v1::4"), None);
        assert_eq!(parse_header(b"kubepit-chunked:v1:xyz:4"), None);
    }
}
