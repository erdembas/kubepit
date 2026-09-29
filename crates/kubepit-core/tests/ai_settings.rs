//! Assistant settings, API keys in the credential store and per-cluster
//! enablement. No provider is contacted: these are local operations, and
//! remote egress stays off in every test process.

mod support;

use std::sync::Arc;

use kubepit_core::ai::{AiSettings, AiToolPolicy};
use kubepit_core::secrets::MemorySecretStore;
use kubepit_core::types::{ClusterEnvironment, ClusterInput};

const KEY: &str = "sk-ant-test-0123456789abcdefghij";

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
    let status = app.ai_key_set("anthropic", KEY).unwrap();
    assert!(status
        .providers
        .iter()
        .any(|p| p.id == "anthropic" && p.has_key));
    assert_eq!(status.keychain, "test credential store");
    assert_eq!(secrets.keys(), vec!["ai/anthropic".to_string()]);
    assert!(!support::home_contains(dir.path(), KEY));
    app.ai_key_delete("anthropic").unwrap();
    assert!(secrets.keys().is_empty());
}

#[test]
fn locked_keychain_fails_without_plaintext_fallback() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (dir, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    secrets.set_available(false);
    let err = app.ai_key_set("anthropic", KEY).unwrap_err().to_string();
    assert!(err.contains("locked"), "{err}");
    let p = app
        .ai_status()
        .providers
        .into_iter()
        .find(|p| p.id == "anthropic")
        .unwrap();
    assert!(!p.has_key && p.key_error.is_some());
    assert!(!support::home_contains(dir.path(), KEY));
}

#[test]
fn keys_need_a_known_provider_and_a_value() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    assert!(app.ai_key_set("nope", KEY).is_err());
    assert!(app.ai_key_set("anthropic", "   ").is_err());
    assert!(app.ai_key_set("anthropic", "sk-ant one").is_err());
    assert!(secrets.keys().is_empty());
    // Surrounding whitespace from a paste is not part of the key.
    app.ai_key_set("openai", &format!("  {KEY}\n")).unwrap();
    assert_eq!(secrets.raw("ai/openai").unwrap(), KEY.as_bytes());
}

#[test]
fn production_clusters_need_an_acknowledgement() {
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let prod = app
        .cluster_add(vec![ClusterInput {
            name: "prod".into(),
            context: "fake".into(),
            kubeconfig_text: Some(support::kubeconfig_for("http://127.0.0.1:9")),
            environment: Some(ClusterEnvironment::Production),
            ..Default::default()
        }])
        .unwrap()
        .remove(0);
    let err = app
        .ai_cluster_set(&prod.id, true, false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("production"), "{err}");
    let saved = app.ai_cluster_set(&prod.id, true, true).unwrap();
    assert_eq!(saved.ai.clusters, vec![prod.id.clone()]);
    // Disabling needs no acknowledgement.
    assert!(app
        .ai_cluster_set(&prod.id, false, false)
        .unwrap()
        .ai
        .clusters
        .is_empty());
}

#[test]
fn a_cluster_that_becomes_production_must_be_enabled_again() {
    let (_d, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    app.ai_cluster_set(&id, true, false).unwrap();
    let mut def = app.cluster_def(&id).unwrap();
    def.environment = Some(ClusterEnvironment::Production);
    app.cluster_update(def).unwrap();
    assert!(app.settings().ai.clusters.is_empty());
}

#[test]
fn settings_set_cannot_change_enabled_clusters() {
    let (_d, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let mut s = app.settings();
    s.ai.clusters = vec![id.clone()];
    assert!(app.set_settings(s).unwrap().ai.clusters.is_empty());

    // ... and keeps the stored ones.
    app.ai_cluster_set(&id, true, false).unwrap();
    let mut s = app.settings();
    s.ai.clusters.clear();
    s.ai.max_context_tokens = 1;
    let saved = app.set_settings(s).unwrap();
    assert_eq!(saved.ai.clusters, vec![id]);
    assert_eq!(saved.ai.max_context_tokens, 2_000, "normalized on save");
}

#[tokio::test]
async fn removing_a_cluster_forgets_its_enablement() {
    let (_d, app, _r, id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    app.ai_cluster_set(&id, true, false).unwrap();
    app.cluster_remove(&id).await.unwrap();
    assert!(app.settings().ai.clusters.is_empty());
}

#[test]
fn remote_egress_is_off_until_the_process_enables_it() {
    let (_d, app, _r, _id) =
        support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let allowed = |app: &kubepit_core::Kubepit, id: &str| {
        app.ai_status()
            .providers
            .iter()
            .find(|p| p.id == id)
            .unwrap()
            .allowed
    };
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
