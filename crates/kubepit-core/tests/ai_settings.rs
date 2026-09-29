//! Assistant settings, API keys in the credential store and per-cluster
//! enablement. No provider is contacted: these are local operations, and
//! remote egress stays off in every test process.

mod support;

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use kubepit_core::ai::keys::KeyMismatch;
use kubepit_core::ai::{
    AiProviderConfig, AiProviderKind, AiProviderStatus, AiSettings, AiToolPolicy,
};
use kubepit_core::events::NullSink;
use kubepit_core::secrets::{MemorySecretStore, SecretStore};
use kubepit_core::types::{ClusterEnvironment, ClusterInput};
use kubepit_core::{Kubepit, Paths};

const KEY: &str = "sk-ant-test-0123456789abcdefghij";

/// [`support::home_contains`] with a positive control: the data folder
/// exists and a string known to be in `settings.json` is found there, so
/// not finding `needle` means something.
fn assert_not_in_home(root: &Path, needle: &str) {
    assert!(
        root.join("home").is_dir(),
        "{} has no data folder",
        root.display()
    );
    assert!(
        support::home_contains(root, "\"ai\""),
        "positive control: \"ai\" not found under {}",
        root.display()
    );
    assert!(
        !support::home_contains(root, needle),
        "{needle} reached the data folder"
    );
}

fn provider_status(app: &Kubepit, id: &str) -> AiProviderStatus {
    app.ai_status()
        .providers
        .into_iter()
        .find(|p| p.id == id)
        .unwrap()
}

fn add_cluster(app: &Kubepit, name: &str, environment: Option<ClusterEnvironment>) -> String {
    app.cluster_add(vec![ClusterInput {
        name: name.into(),
        context: "fake".into(),
        kubeconfig_text: Some(support::kubeconfig_for("http://127.0.0.1:9")),
        environment,
        ..Default::default()
    }])
    .unwrap()
    .remove(0)
    .id
}

fn set_environment(app: &Kubepit, id: &str, environment: Option<ClusterEnvironment>) {
    let mut def = app.cluster_def(id).unwrap();
    def.environment = environment;
    app.cluster_update(def).unwrap();
}

#[test]
fn home_contains_has_a_positive_control() {
    let (dir, _app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    assert!(support::home_contains(dir.path(), "\"ai\""));
    assert!(support::home_contains(dir.path(), "\"max_context_tokens\""));
    assert!(!support::home_contains(dir.path(), "no such text anywhere"));
    assert!(!support::home_contains(
        &dir.path().join("missing"),
        "\"ai\""
    ));
    assert_not_in_home(dir.path(), KEY);
}

#[test]
fn assistant_is_off_by_default_and_keys_live_only_in_the_keychain() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (dir, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    let ai = app.settings().ai;
    assert!(!ai.enabled && !ai.local_only);
    assert_eq!(ai.active_provider.as_deref(), Some("anthropic"));
    assert_eq!(ai.provider("anthropic").unwrap().model, "claude-opus-5");
    assert_eq!(
        ai.provider("anthropic").unwrap().base_url,
        "https://api.anthropic.com"
    );
    assert_eq!(
        ai.provider("ollama").unwrap().base_url,
        "http://127.0.0.1:11434"
    );
    assert_eq!(ai.tool_policy, AiToolPolicy::Ask);
    assert!(ai.redaction.tokens && !ai.redaction.ips && !ai.redaction.hostnames);
    assert!(ai.log_requests && ai.max_context_tokens == 60_000 && ai.prices.is_empty());
    assert!(ai.production_acknowledged.is_empty());
    let status = app.ai_key_set("anthropic", KEY).unwrap();
    assert!(status
        .providers
        .iter()
        .any(|p| p.id == "anthropic" && p.has_key));
    assert_eq!(status.keychain, "test credential store");
    assert_eq!(secrets.keys(), vec!["ai/anthropic".to_string()]);
    assert_not_in_home(dir.path(), KEY);
    app.ai_key_delete("anthropic").unwrap();
    assert!(secrets.keys().is_empty());
    assert!(!provider_status(&app, "anthropic").has_key);
}

#[test]
fn locked_keychain_fails_without_plaintext_fallback() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (dir, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    secrets.set_available(false);
    let err = app.ai_key_set("anthropic", KEY).unwrap_err().to_string();
    assert!(err.contains("locked"), "{err}");
    let p = provider_status(&app, "anthropic");
    assert!(!p.has_key && p.key_error.is_some());
    assert_not_in_home(dir.path(), KEY);
}

#[test]
fn keys_need_a_known_provider_and_a_value() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    assert!(app.ai_key_set("nope", KEY).is_err());
    assert!(app.ai_key_set("anthropic", "   ").is_err());
    assert!(app.ai_key_set("anthropic", "sk-ant one").is_err());
    let err = app
        .ai_key_set("anthropic", &"k".repeat(8 * 1024 + 1))
        .unwrap_err()
        .to_string();
    assert!(err.contains("8 KiB"), "{err}");
    assert!(secrets.keys().is_empty());
    app.ai_key_set("anthropic", &"k".repeat(8 * 1024)).unwrap();
    // Surrounding whitespace from a paste is not part of the key.
    app.ai_key_set("openai", &format!("  {KEY}\n")).unwrap();
    let entry: serde_json::Value =
        serde_json::from_slice(&secrets.raw("ai/openai").unwrap()).unwrap();
    assert_eq!(
        entry,
        serde_json::json!({
            "v": 1, "kind": "openai-compatible", "origin": "https://api.openai.com", "key": KEY
        })
    );
}

#[test]
fn keys_are_bound_to_the_address_they_were_saved_for() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    app.ai_key_set("anthropic", KEY).unwrap();
    assert!(provider_status(&app, "anthropic").has_key);

    // Point the provider elsewhere: the key is not offered to that server.
    let mut s = app.settings();
    s.ai.providers[0].base_url = "https://gateway.example/anthropic".into();
    let saved = app.set_settings(s).unwrap();
    let p = provider_status(&app, "anthropic");
    assert!(!p.has_key);
    let error = p.key_error.unwrap();
    assert_eq!(
        error,
        "The key was saved for https://api.anthropic.com; set it again for this address."
    );
    assert!(!error.contains(KEY));
    let anthropic = saved.ai.provider("anthropic").unwrap();
    let err = kubepit_core::ai::keys::read_key(secrets.as_ref(), anthropic).unwrap_err();
    assert!(err.downcast_ref::<KeyMismatch>().is_some());

    // Setting it again binds it to the new address.
    app.ai_key_set("anthropic", KEY).unwrap();
    let p = provider_status(&app, "anthropic");
    assert!(p.has_key && p.key_error.is_none());
    assert_eq!(
        kubepit_core::ai::keys::read_key(secrets.as_ref(), anthropic)
            .unwrap()
            .as_deref(),
        Some(KEY)
    );

    // An entry from before keys were bound (a raw key) is not used.
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    secrets.set("ai/openai", KEY.as_bytes()).unwrap();
    let p = provider_status(&app, "openai");
    assert!(!p.has_key);
    let error = p.key_error.unwrap();
    assert!(
        error.contains("set it again") && !error.contains(KEY),
        "{error}"
    );
}

#[test]
fn keys_never_go_over_plain_http_to_another_computer() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    let mut s = app.settings();
    s.ai.providers[0].base_url = "http://10.0.0.5:8080".into();
    s.ai.providers[1].base_url = "http://127.0.0.1:4000/v1".into();
    app.set_settings(s).unwrap();
    let err = app.ai_key_set("anthropic", KEY).unwrap_err().to_string();
    assert!(err.contains("https://"), "{err}");
    assert!(secrets.keys().is_empty());
    let anthropic = provider_status(&app, "anthropic");
    assert!(!anthropic.allowed && !anthropic.local);
    // Loopback over http is fine (local gateways, Ollama, tests).
    app.ai_key_set("openai", KEY).unwrap();
    let openai = provider_status(&app, "openai");
    assert!(openai.has_key && openai.allowed && openai.local);
}

/// Counts reads, to prove `ai_status` does not read every secret each time.
struct CountingStore {
    inner: MemorySecretStore,
    gets: AtomicUsize,
}

impl SecretStore for CountingStore {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        self.inner.get(key)
    }
    fn set(&self, key: &str, value: &[u8]) -> anyhow::Result<()> {
        self.inner.set(key, value)
    }
    fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.inner.delete(key)
    }
}

#[test]
fn status_reads_each_key_once_and_retries_a_locked_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(CountingStore {
        inner: MemorySecretStore::default(),
        gets: AtomicUsize::new(0),
    });
    let app = Kubepit::open_with_secrets(
        Paths::new(dir.path().join("home")),
        Arc::new(NullSink),
        store.clone(),
    )
    .unwrap();
    let gets = || store.gets.load(Ordering::SeqCst);

    // Locked: every call reads again (errors are not cached).
    store.inner.set_available(false);
    assert!(provider_status(&app, "anthropic").key_error.is_some());
    let after_first = gets();
    assert!(after_first >= 3, "one read per provider");
    assert!(provider_status(&app, "anthropic").key_error.is_some());
    assert_eq!(gets(), after_first * 2);

    // Unlocked: read once, then served from the cache.
    store.inner.set_available(true);
    app.ai_status();
    let after_unlock = gets();
    assert_eq!(after_unlock, after_first * 3);
    for _ in 0..5 {
        app.ai_status();
    }
    assert_eq!(gets(), after_unlock);

    // Setting and deleting a key update the cache: the status that follows
    // reads nothing (the store's own write/delete look at the old entry).
    app.ai_key_set("anthropic", KEY).unwrap();
    let after_set = gets();
    assert!(provider_status(&app, "anthropic").has_key);
    app.ai_key_delete("anthropic").unwrap();
    let after_delete = gets();
    assert!(!provider_status(&app, "anthropic").has_key);
    app.ai_status();
    assert_eq!(gets(), after_delete);
    assert_eq!(after_delete - after_set, 1, "only delete_value's own read");
}

#[test]
fn settings_set_refuses_unsafe_provider_settings() {
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let custom = |id: &str, base_url: &str| AiProviderConfig {
        id: id.into(),
        kind: AiProviderKind::OpenaiCompatible,
        name: "Gateway".into(),
        base_url: base_url.into(),
        model: String::new(),
        context_window: None,
        max_output_tokens: 0,
    };
    let before = app.settings();
    for (provider, needle) in [
        (custom("gateway", "ftp://gateway.example"), "http://"),
        (custom("gateway", "gateway.example/v1"), "http://"),
        (
            custom("gateway", "https://user:pw@gateway.example"),
            "user name",
        ),
        (
            custom("gateway", "https://gateway.example/v1?key=1"),
            "query",
        ),
        (
            custom("gateway", "https://gateway.example/v1#x"),
            "fragment",
        ),
        (custom("gateway", "http://evil\\@127.0.0.1"), "backslash"),
        (custom("Gateway", "https://gateway.example"), "id"),
        (custom("gate way", "https://gateway.example"), "id"),
        (custom("", "https://gateway.example"), "id"),
        (custom("../x", "https://gateway.example"), "id"),
        (custom(&"g".repeat(65), "https://gateway.example"), "id"),
    ] {
        let mut s = app.settings();
        s.ai.providers.push(provider.clone());
        let err = app.set_settings(s).unwrap_err().to_string();
        assert!(
            err.contains(needle),
            "{:?} {:?}: {err}",
            provider.id,
            provider.base_url
        );
    }
    assert_eq!(app.settings(), before, "nothing was saved");

    // A custom provider may keep a blank base URL; it is not allowed.
    let mut s = app.settings();
    s.ai.providers.push(custom("my.gateway_1-x", "  "));
    let saved = app.set_settings(s).unwrap();
    assert_eq!(saved.ai.provider("my.gateway_1-x").unwrap().base_url, "");
    let status = provider_status(&app, "my.gateway_1-x");
    assert!(!status.allowed && !status.local);
    assert!(app.ai_key_set("my.gateway_1-x", KEY).is_err());
    // A default provider gets its base URL back.
    let mut s = app.settings();
    s.ai.providers[0].base_url = " / ".into();
    let saved = app.set_settings(s).unwrap();
    assert_eq!(
        saved.ai.provider("anthropic").unwrap().base_url,
        "https://api.anthropic.com"
    );
}

#[test]
fn production_clusters_need_an_acknowledgement() {
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let prod = add_cluster(&app, "prod", Some(ClusterEnvironment::Production));
    let err = app
        .ai_cluster_set(&prod, true, false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("production"), "{err}");
    assert!(app.settings().ai.clusters.is_empty());
    let saved = app.ai_cluster_set(&prod, true, true).unwrap();
    assert_eq!(saved.ai.clusters, vec![prod.clone()]);
    assert_eq!(saved.ai.production_acknowledged, vec![prod.clone()]);
    assert!(saved.ai.cluster_allowed(&app.cluster_def(&prod).unwrap()));
    // Disabling needs no acknowledgement, and drops it.
    let saved = app.ai_cluster_set(&prod, false, false).unwrap();
    assert!(saved.ai.clusters.is_empty() && saved.ai.production_acknowledged.is_empty());
    assert!(app.ai_cluster_set("not-registered", true, true).is_err());
}

#[test]
fn acknowledgements_follow_the_environment() {
    let (_d, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    // Enabled as a non-production cluster: no acknowledgement recorded,
    // even when one is given.
    let saved = app.ai_cluster_set(&id, true, true).unwrap();
    assert_eq!(saved.ai.clusters, vec![id.clone()]);
    assert!(saved.ai.production_acknowledged.is_empty());

    set_environment(&app, &id, Some(ClusterEnvironment::Production));
    assert!(
        app.settings().ai.clusters.is_empty(),
        "must be enabled again"
    );
    app.ai_cluster_set(&id, true, true).unwrap();
    assert_eq!(app.settings().ai.production_acknowledged, vec![id.clone()]);
    // Leaving production keeps it enabled and drops the acknowledgement,
    // so becoming production again needs a new one.
    set_environment(&app, &id, Some(ClusterEnvironment::Staging));
    let ai = app.settings().ai;
    assert_eq!(ai.clusters, vec![id.clone()]);
    assert!(ai.production_acknowledged.is_empty());
    set_environment(&app, &id, Some(ClusterEnvironment::Production));
    assert!(app.settings().ai.clusters.is_empty());
}

#[test]
fn a_cluster_that_becomes_production_must_be_enabled_again() {
    let (_d, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    app.ai_cluster_set(&id, true, false).unwrap();
    set_environment(&app, &id, Some(ClusterEnvironment::Production));
    assert!(app.settings().ai.clusters.is_empty());
}

#[test]
fn enabling_races_with_becoming_production_safely() {
    let (_d, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    for round in 0..40 {
        set_environment(&app, &id, None);
        app.ai_cluster_set(&id, false, false).unwrap();
        let enable = {
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || app.ai_cluster_set(&id, true, false))
        };
        let promote = {
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                set_environment(&app, &id, Some(ClusterEnvironment::Production))
            })
        };
        let _ = enable.join().unwrap();
        promote.join().unwrap();
        let def = app.cluster_def(&id).unwrap();
        assert_eq!(def.environment, Some(ClusterEnvironment::Production));
        let ai = app.settings().ai;
        assert!(
            !ai.clusters.contains(&id),
            "round {round}: production and enabled"
        );
        assert!(!ai.cluster_allowed(&def));
    }
}

/// Makes `settings.json` unwritable (a directory in its place).
fn break_settings_file(dir: &Path) -> std::path::PathBuf {
    let file = dir.join("home").join("settings.json");
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    file
}

#[test]
fn a_failed_forget_fails_the_cluster_change() {
    let (dir, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    app.ai_cluster_set(&id, true, false).unwrap();
    let file = break_settings_file(dir.path());
    let mut def = app.cluster_def(&id).unwrap();
    def.environment = Some(ClusterEnvironment::Production);
    let err = format!("{:#}", app.cluster_update(def.clone()).unwrap_err());
    assert!(
        err.contains("assistant") && err.contains("nothing was changed"),
        "{err}"
    );
    // Not production, so the enablement it still has is fine.
    assert_eq!(app.cluster_def(&id).unwrap().environment, None);
    assert_eq!(app.settings().ai.clusters, vec![id.clone()]);

    std::fs::remove_dir(&file).unwrap();
    app.cluster_update(def).unwrap();
    assert!(app.settings().ai.clusters.is_empty());
}

#[tokio::test]
async fn a_failed_cleanup_does_not_fail_the_removal() {
    let (dir, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    app.ai_cluster_set(&id, true, false).unwrap();
    let file = break_settings_file(dir.path());
    // The cluster is gone; its leftover id is harmless (an unregistered
    // cluster cannot be used) and is dropped by the next start.
    app.cluster_remove(&id).await.unwrap();
    assert!(app.cluster_list().is_empty());
    assert_eq!(app.settings().ai.clusters, vec![id.clone()]);

    std::fs::remove_dir(&file).unwrap();
    std::fs::write(&file, serde_json::to_vec(&app.settings()).unwrap()).unwrap();
    drop(app);
    let app = Kubepit::open(Paths::new(dir.path().join("home")), Arc::new(NullSink)).unwrap();
    assert!(app.settings().ai.clusters.is_empty());
}

/// Holds the first `ai/` write after it reached the store, until released.
struct PausingStore {
    inner: MemorySecretStore,
    gate: parking_lot::Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
}

impl SecretStore for PausingStore {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        self.inner.get(key)
    }
    fn set(&self, key: &str, value: &[u8]) -> anyhow::Result<()> {
        self.inner.set(key, value)?;
        let gate = self.gate.lock().take();
        if let Some((entered, release)) = gate {
            entered.send(()).unwrap();
            release.recv().unwrap();
        }
        Ok(())
    }
    fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.inner.delete(key)
    }
}

#[test]
fn key_changes_are_serialized_with_the_status_cache() {
    let dir = tempfile::tempdir().unwrap();
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let store = Arc::new(PausingStore {
        inner: MemorySecretStore::default(),
        gate: parking_lot::Mutex::new(Some((entered_tx, release_rx))),
    });
    let app = Arc::new(
        Kubepit::open_with_secrets(
            Paths::new(dir.path().join("home")),
            Arc::new(NullSink),
            store.clone(),
        )
        .unwrap(),
    );
    // The set has written the key but not yet updated the cache...
    let set = {
        let app = app.clone();
        std::thread::spawn(move || app.ai_key_set("anthropic", KEY).map(|_| ()))
    };
    entered
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    // ... when a delete comes in. It must wait for the set to finish.
    let delete = {
        let app = app.clone();
        std::thread::spawn(move || app.ai_key_delete("anthropic").map(|_| ()))
    };
    std::thread::sleep(std::time::Duration::from_millis(200));
    release.send(()).unwrap();
    set.join().unwrap().unwrap();
    delete.join().unwrap().unwrap();
    let stored = store.inner.raw("ai/anthropic").is_some();
    assert!(!stored, "the delete ran last");
    assert_eq!(provider_status(&app, "anthropic").has_key, stored);
}

#[test]
fn settings_set_cannot_change_enabled_clusters() {
    let (_d, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let mut s = app.settings();
    s.ai.clusters = vec![id.clone()];
    s.ai.production_acknowledged = vec![id.clone()];
    let saved = app.set_settings(s).unwrap();
    assert!(saved.ai.clusters.is_empty() && saved.ai.production_acknowledged.is_empty());

    // ... and keeps the stored ones.
    let prod = add_cluster(&app, "prod", Some(ClusterEnvironment::Production));
    app.ai_cluster_set(&id, true, false).unwrap();
    app.ai_cluster_set(&prod, true, true).unwrap();
    let mut s = app.settings();
    s.ai.clusters.clear();
    s.ai.production_acknowledged.clear();
    s.ai.max_context_tokens = 1;
    let saved = app.set_settings(s).unwrap();
    let mut both = vec![id, prod.clone()];
    both.sort();
    assert_eq!(saved.ai.clusters, both);
    assert_eq!(saved.ai.production_acknowledged, vec![prod]);
    assert_eq!(saved.ai.max_context_tokens, 2_000, "normalized on save");
}

#[test]
fn reopening_drops_what_the_registry_no_longer_allows() {
    let (dir, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let prod = add_cluster(&app, "prod", Some(ClusterEnvironment::Production));
    app.ai_cluster_set(&id, true, false).unwrap();
    app.ai_cluster_set(&prod, true, true).unwrap();
    // A hand edit: enable a production cluster without an acknowledgement
    // and a cluster that does not exist.
    let file = dir.path().join("home").join("settings.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    value["ai"]["production_acknowledged"] = serde_json::json!([]);
    value["ai"]["clusters"] = serde_json::json!([id, prod, "gone"]);
    std::fs::write(&file, value.to_string()).unwrap();
    drop(app);
    let app = Kubepit::open(Paths::new(dir.path().join("home")), Arc::new(NullSink)).unwrap();
    let ai = app.settings().ai;
    assert_eq!(ai.clusters, vec![id]);
    assert!(ai.production_acknowledged.is_empty());
}

#[tokio::test]
async fn removing_a_cluster_forgets_its_enablement() {
    let (_d, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let prod = add_cluster(&app, "prod", Some(ClusterEnvironment::Production));
    app.ai_cluster_set(&id, true, false).unwrap();
    app.ai_cluster_set(&prod, true, true).unwrap();
    app.cluster_remove(&id).await.unwrap();
    app.cluster_remove(&prod).await.unwrap();
    let ai = app.settings().ai;
    assert!(ai.clusters.is_empty() && ai.production_acknowledged.is_empty());
}

#[test]
fn remote_egress_is_off_until_the_process_enables_it() {
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let allowed = |app: &Kubepit, id: &str| provider_status(app, id).allowed;
    assert!(!app.ai_remote_allowed() && !app.ai_status().remote_allowed);
    assert!(!allowed(&app, "anthropic") && allowed(&app, "ollama"));
    app.set_ai_remote_providers(true);
    assert!(allowed(&app, "anthropic"));
    let mut s = app.settings();
    s.ai.local_only = true;
    app.set_settings(s).unwrap();
    assert!(!allowed(&app, "anthropic") && allowed(&app, "ollama"));
    let status = app.ai_status();
    assert!(status.local_only);
    let ollama = status.providers.iter().find(|p| p.id == "ollama").unwrap();
    assert!(ollama.local && !ollama.has_key && ollama.key_error.is_none());
}

#[test]
fn normalize_clamps_and_restores_defaults() {
    let mut ai = AiSettings {
        max_context_tokens: 10,
        ..Default::default()
    };
    ai.providers.retain(|p| p.id != "ollama");
    ai.providers[0].base_url = "  ".into();
    let n = ai.normalized();
    assert_eq!(n.max_context_tokens, 2_000);
    assert!(n.provider("ollama").is_some());
    assert_eq!(
        n.provider("anthropic").unwrap().base_url,
        "https://api.anthropic.com"
    );
    let big = AiSettings {
        max_context_tokens: 5_000_000,
        ..Default::default()
    };
    assert_eq!(big.normalized().max_context_tokens, 900_000);
}
