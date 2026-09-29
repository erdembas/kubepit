//! Synthetic import and replacement fixtures; never read ~/.kube or the OS keychain.
use super::*;
use crate::credentials::secret_key;
use crate::events::NullSink;
use crate::paths::Paths;
use crate::secrets::{read_value, MemorySecretStore};
use crate::types::KubeconfigContextInput;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::Path;
use std::sync::Arc;

const CONTEXTLESS: &str = r#"
apiVersion: v1
kind: Config
current-context: suggested-name
clusters:
- name: selected
  cluster: {server: 'https://selected.example.test'}
- name: unused
  cluster: {server: 'https://unused.example.test'}
users:
- name: selected-user
  user: {token: selected-token}
- name: unused-user
  user: {token: unrelated-secret}
contexts: []
"#;

fn with_context() -> String {
    CONTEXTLESS.replace(
        "contexts: []",
        "contexts:\n- name: chosen\n  context: {cluster: selected, user: selected-user}",
    )
}

fn mapping() -> KubeconfigContextInput {
    KubeconfigContextInput {
        cluster: "selected".into(),
        user: Some("selected-user".into()),
        namespace: Some("team-a".into()),
    }
}

fn setup(keychain: bool) -> (tempfile::TempDir, Kubepit, Arc<MemorySecretStore>) {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::with_max_len(128));
    let app = Kubepit::open_with_secrets(
        Paths::new(dir.path().join("home")),
        Arc::new(NullSink),
        secrets.clone(),
    )
    .unwrap();
    if keychain {
        app.kubeconfig_storage_set(true).unwrap();
    }
    (dir, app, secrets)
}

fn pasted(app: &Kubepit) -> ClusterDef {
    app.cluster_add(vec![ClusterInput {
        name: "Keep my name".into(),
        context: "chosen".into(),
        kubeconfig_text: Some(with_context()),
        tags: vec!["keep-tag".into()],
        read_only: true,
        notes: "keep notes".into(),
        ..Default::default()
    }])
    .unwrap()
    .remove(0)
}

#[test]
fn file_import_is_portable_private_and_contains_only_the_selected_credentials() {
    let (dir, app, _) = setup(false);
    let source_dir = dir.path().join("source");
    std::fs::create_dir(&source_dir).unwrap();
    for (name, contents) in [
        ("ca.pem", "CA fixture"),
        ("cert.pem", "CERT fixture"),
        ("key.pem", "KEY fixture"),
        ("token", "file-token\n"),
    ] {
        std::fs::write(source_dir.join(name), contents).unwrap();
    }
    let source = source_dir.join("config");
    let text = with_context()
        .replace(
            "{server: 'https://selected.example.test'}",
            "{server: 'https://selected.example.test', certificate-authority: ca.pem}",
        )
        .replace(
            "{token: selected-token}",
            "{client-certificate: cert.pem, client-key: key.pem, tokenFile: token}",
        );
    std::fs::write(&source, &text).unwrap();
    let cluster = app
        .cluster_add(vec![ClusterInput {
            context: "chosen".into(),
            kubeconfig_path: Some(source.to_string_lossy().to_string()),
            ..Default::default()
        }])
        .unwrap()
        .remove(0);
    assert!(cluster.managed);
    assert_eq!(
        cluster.source_kubeconfig_path.as_deref(),
        source.canonicalize().unwrap().to_str()
    );
    assert_eq!(std::fs::read_to_string(&source).unwrap(), text);
    let managed = std::fs::read_to_string(&cluster.kubeconfig_path).unwrap();
    assert!(!managed.contains("unused"));
    assert!(!managed.contains("unrelated-secret"));
    for contents in ["CA fixture", "CERT fixture", "KEY fixture"] {
        assert!(managed.contains(&STANDARD.encode(contents)));
    }
    assert!(managed.contains("file-token"));
    assert!(!managed.contains("tokenFile"));
    assert!(!managed.contains("ca.pem"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&cluster.kubeconfig_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    std::fs::remove_dir_all(source_dir).unwrap();
    let exported = app.cluster_export_kubeconfig(&cluster.id).unwrap();
    assert_eq!(
        kubeconfig::load(Path::new(&exported)).unwrap().contexts[0].name,
        "chosen"
    );
    let metadata =
        serde_json::to_string(&app.cluster_kubeconfig_source(&cluster.id).unwrap()).unwrap();
    assert!(!metadata.contains("file-token"));
    assert!(!metadata.contains("KEY fixture"));
}

#[test]
fn contextless_sources_require_explicit_selection_and_never_modify_the_original() {
    let (dir, app, _) = setup(false);
    let source = dir.path().join("config");
    std::fs::write(&source, CONTEXTLESS).unwrap();
    let summary = kubeconfig::parse_file(&source);
    assert!(summary.error.is_none());
    assert!(summary.contexts.is_empty());
    assert_eq!(summary.clusters.len(), 2);
    assert_eq!(summary.users, ["selected-user", "unused-user"]);
    assert_eq!(summary.current_context.as_deref(), Some("suggested-name"));
    let input = ClusterInput {
        context: "suggested-name".into(),
        kubeconfig_path: Some(source.to_string_lossy().to_string()),
        ..Default::default()
    };
    assert!(app.cluster_add(vec![input.clone()]).is_err());
    assert!(app.cluster_list().is_empty());
    let cluster = app
        .cluster_add(vec![ClusterInput {
            create_context: Some(mapping()),
            ..input
        }])
        .unwrap()
        .remove(0);
    let stored = app.load_cluster_source(&cluster).unwrap();
    assert_eq!(stored.current_context.as_deref(), Some("suggested-name"));
    assert_eq!(
        stored.contexts[0].context.as_ref().unwrap().user.as_deref(),
        Some("selected-user")
    );
    assert_eq!(
        stored.contexts[0]
            .context
            .as_ref()
            .unwrap()
            .namespace
            .as_deref(),
        Some("team-a")
    );
    assert_eq!(stored.auth_infos.len(), 1);
    assert_eq!(std::fs::read_to_string(source).unwrap(), CONTEXTLESS);
}

#[test]
fn bad_selection_and_missing_dependency_fail_before_any_registration() {
    let (dir, app, _) = setup(false);
    for selected in [
        KubeconfigContextInput {
            cluster: "missing".into(),
            ..mapping()
        },
        KubeconfigContextInput {
            user: Some("missing".into()),
            ..mapping()
        },
    ] {
        assert!(app
            .cluster_add(vec![ClusterInput {
                context: "new".into(),
                kubeconfig_text: Some(CONTEXTLESS.into()),
                create_context: Some(selected),
                ..Default::default()
            }])
            .is_err());
    }
    let error = app
        .cluster_add(vec![ClusterInput {
            context: "chosen".into(),
            kubeconfig_text: Some(with_context()),
            create_context: Some(mapping()),
            ..Default::default()
        }])
        .unwrap_err();
    assert!(format!("{error:#}").contains("already exists"));
    let source = dir.path().join("missing-cert");
    std::fs::write(
        &source,
        with_context().replace("{token: selected-token}", "{client-key: missing.key}"),
    )
    .unwrap();
    let error = app
        .cluster_add(vec![ClusterInput {
            context: "chosen".into(),
            kubeconfig_path: Some(source.to_string_lossy().to_string()),
            ..Default::default()
        }])
        .unwrap_err();
    assert!(format!("{error:#}").contains("client key"));
    assert!(app.cluster_list().is_empty());
    assert_eq!(
        std::fs::read_dir(app.paths().kubeconfigs_dir())
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn replacement_preserves_identity_metadata_and_can_repair_an_unreadable_old_source() {
    let (_dir, app, _) = setup(false);
    let old = pasted(&app);
    std::fs::write(&old.kubeconfig_path, "users: [invalid-secret").unwrap();
    let fixed = app
        .cluster_reimport_kubeconfig(
            &old.id,
            KubeconfigImport {
                kubeconfig_text: Some(CONTEXTLESS.into()),
                context: "repaired".into(),
                create_context: Some(mapping()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(fixed.id, old.id);
    assert_eq!(fixed.created_at, old.created_at);
    assert_eq!(fixed.name, old.name);
    assert_eq!(fixed.tags, old.tags);
    assert_eq!(fixed.notes, old.notes);
    assert!(fixed.read_only);
    assert_ne!(fixed.kubeconfig_path, old.kubeconfig_path);
    assert!(!Path::new(&old.kubeconfig_path).exists());
    assert_eq!(
        app.load_cluster_source(&fixed).unwrap().contexts[0].name,
        "repaired"
    );
}

#[test]
fn registry_failure_keeps_old_source_and_removes_the_staged_replacement() {
    let (dir, app, _) = setup(false);
    let old = pasted(&app);
    let old_bytes = std::fs::read(&old.kubeconfig_path).unwrap();
    let registry = app.paths().clusters_file();
    std::fs::rename(&registry, dir.path().join("original-registry")).unwrap();
    std::fs::create_dir(&registry).unwrap();
    assert!(app
        .cluster_reimport_kubeconfig(
            &old.id,
            KubeconfigImport {
                kubeconfig_text: Some(with_context().replace("selected-token", "new-token")),
                context: "chosen".into(),
                ..Default::default()
            }
        )
        .is_err());
    assert_eq!(app.cluster_def(&old.id).unwrap(), old);
    assert_eq!(std::fs::read(&old.kubeconfig_path).unwrap(), old_bytes);
    assert_eq!(
        std::fs::read_dir(app.paths().kubeconfigs_dir())
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn oversized_embedded_credentials_cannot_replace_a_working_source() {
    let (dir, app, _) = setup(false);
    let old = pasted(&app);
    let original = std::fs::read(&old.kubeconfig_path).unwrap();
    let ca = dir.path().join("oversized-ca");
    std::fs::write(&ca, vec![b'x'; 13 * 1024 * 1024]).unwrap();
    let source = dir.path().join("config");
    std::fs::write(
        &source,
        with_context().replace(
            "{server: 'https://selected.example.test'}",
            "{server: 'https://selected.example.test', certificate-authority: oversized-ca}",
        ),
    )
    .unwrap();
    let error = app
        .cluster_reimport_kubeconfig(
            &old.id,
            KubeconfigImport {
                kubeconfig_path: Some(source.to_string_lossy().to_string()),
                context: "chosen".into(),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("generated kubeconfig is too large"));
    assert_eq!(app.cluster_def(&old.id).unwrap(), old);
    assert_eq!(std::fs::read(&old.kubeconfig_path).unwrap(), original);
    assert_eq!(
        std::fs::read_dir(app.paths().kubeconfigs_dir())
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn partial_keychain_failure_keeps_the_old_secret_registry_and_run_file() {
    let (_dir, app, secrets) = setup(true);
    let old = pasted(&app);
    let original = read_value(secrets.as_ref(), &secret_key(&old.id))
        .unwrap()
        .unwrap();
    let keys = secrets.keys();
    let run = app.cluster_export_kubeconfig(&old.id).unwrap();
    let run_bytes = std::fs::read(&run).unwrap();
    secrets.fail_writes_after(1);
    assert!(app
        .cluster_reimport_kubeconfig(
            &old.id,
            KubeconfigImport {
                kubeconfig_text: Some(
                    with_context().replace("selected-token", "replacement-token")
                ),
                context: "chosen".into(),
                ..Default::default()
            }
        )
        .is_err());
    assert_eq!(app.cluster_def(&old.id).unwrap(), old);
    assert_eq!(
        read_value(secrets.as_ref(), &secret_key(&old.id))
            .unwrap()
            .unwrap(),
        original
    );
    assert_eq!(secrets.keys(), keys);
    assert_eq!(std::fs::read(run).unwrap(), run_bytes);
    assert_eq!(
        std::fs::read_dir(app.paths().kubeconfigs_dir())
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn keychain_source_repair_migrates_and_removes_the_new_storage_revision() {
    let (_dir, app, secrets) = setup(true);
    let old = pasted(&app);
    // A historical managed source can have no contexts: inspect and repair it
    // without disclosing YAML or requiring its original file to remain present.
    app.store_managed(&old.id, CONTEXTLESS).unwrap();
    let summary = app.cluster_kubeconfig_source(&old.id).unwrap();
    assert!(summary.contexts.is_empty());
    assert_eq!(summary.users.len(), 2);
    let fixed = app
        .cluster_reimport_kubeconfig(
            &old.id,
            KubeconfigImport {
                context: "fixed".into(),
                create_context: Some(mapping()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!Path::new(&fixed.kubeconfig_path).exists());
    assert!(read_value(secrets.as_ref(), &secret_key(&old.id))
        .unwrap()
        .is_none());
    assert_eq!(app.load_cluster_source(&fixed).unwrap().contexts.len(), 1);
    app.kubeconfig_storage_set(false).unwrap();
    assert!(Path::new(&fixed.kubeconfig_path).exists());
    assert!(secrets.keys().is_empty());
    app.kubeconfig_storage_set(true).unwrap();
    assert!(!Path::new(&fixed.kubeconfig_path).exists());
    app.cluster_remove(&fixed.id).await.unwrap();
    assert!(secrets.keys().is_empty());
}

#[test]
fn legacy_linked_sources_become_managed_only_when_explicitly_reimported() {
    let (dir, app, _) = setup(false);
    let source = dir.path().join("legacy-config");
    std::fs::write(&source, CONTEXTLESS).unwrap();
    let mut old = pasted(&app);
    app.delete_managed(&old.id, Path::new(&old.kubeconfig_path));
    old.managed = false;
    old.kubeconfig_path = source.to_string_lossy().to_string();
    app.store
        .update_clusters(|clusters| {
            clusters[0] = old.clone();
            Ok(())
        })
        .unwrap();
    assert!(!app.cluster_def(&old.id).unwrap().managed);
    let fixed = app
        .cluster_reimport_kubeconfig(
            &old.id,
            KubeconfigImport {
                context: "fixed".into(),
                create_context: Some(mapping()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(fixed.managed);
    assert_eq!(fixed.id, old.id);
    assert_eq!(fixed.source_kubeconfig_path.as_deref(), source.to_str());
    assert_eq!(std::fs::read_to_string(source).unwrap(), CONTEXTLESS);
}

#[test]
fn reimport_serializes_with_an_inflight_edit_and_keeps_its_metadata() {
    use crate::secrets::SecretStore;
    use std::sync::mpsc;
    use std::time::Duration;

    type Gate = (String, mpsc::Sender<()>, mpsc::Receiver<()>);
    struct PausedRead {
        inner: MemorySecretStore,
        gate: parking_lot::Mutex<Option<Gate>>,
    }
    impl SecretStore for PausedRead {
        fn name(&self) -> &str {
            "test credential store"
        }
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            let value = self.inner.get(key)?;
            let gate = {
                let mut gate = self.gate.lock();
                if gate.as_ref().is_some_and(|(target, _, _)| target == key) {
                    gate.take()
                } else {
                    None
                }
            };
            if let Some((_, entered, release)) = gate {
                entered.send(()).unwrap();
                release.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            Ok(value)
        }
        fn set(&self, key: &str, value: &[u8]) -> Result<()> {
            self.inner.set(key, value)
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.inner.delete(key)
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(PausedRead {
        inner: MemorySecretStore::default(),
        gate: Default::default(),
    });
    let app = Arc::new(
        Kubepit::open_with_secrets(Paths::new(dir.path()), Arc::new(NullSink), secrets.clone())
            .unwrap(),
    );
    app.kubeconfig_storage_set(true).unwrap();
    let old = pasted(&app);
    let with_alternative = with_context().replace(
        "contexts:\n",
        "contexts:\n- name: alternative\n  context: {cluster: selected, user: selected-user}\n",
    );
    app.store_managed(&old.id, &with_alternative).unwrap();
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    *secrets.gate.lock() = Some((secret_key(&old.id), entered_tx, release_rx));
    let editing = {
        let app = app.clone();
        let mut edited = old.clone();
        edited.context = "alternative".into();
        edited.name = "Updated while importing".into();
        std::thread::spawn(move || app.cluster_update(edited))
    };
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    let (reimported_tx, reimported) = mpsc::channel();
    let importing = {
        let app = app.clone();
        let id = old.id.clone();
        std::thread::spawn(move || {
            let result = app.cluster_reimport_kubeconfig(
                &id,
                KubeconfigImport {
                    kubeconfig_text: Some(with_context()),
                    context: "chosen".into(),
                    ..Default::default()
                },
            );
            reimported_tx.send(result).unwrap();
        })
    };
    assert!(matches!(
        reimported.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    release.send(()).unwrap();
    editing.join().unwrap().unwrap();
    let replacement = reimported
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    importing.join().unwrap();
    assert_eq!(replacement.name, "Updated while importing");
    assert_eq!(app.cluster_def(&old.id).unwrap(), replacement);
    assert!(app.load_cluster_source(&replacement).is_ok());
    assert!(read_value(secrets.as_ref(), &secret_key(&old.id))
        .unwrap()
        .is_none());
}
