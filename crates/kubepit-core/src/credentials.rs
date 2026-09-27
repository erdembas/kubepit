//! Where a cluster's kubeconfig comes from, and what clients get from it.
//!
//! - User clusters reference their own kubeconfig file, which is only read.
//! - Managed (pasted) kubeconfigs live in `kubeconfigs/<id>.yaml` (mode
//!   0600), or — with `settings.keychain_kubeconfigs` — in the OS credential
//!   store under `kubeconfig/<id>` ([`crate::secrets`]).
//!
//! Reads look in the configured location first and fall back to the other
//! one, so an interrupted migration never makes a cluster unusable.
//! [`Kubepit::kubeconfig_storage_set`] migrates entry by entry: copy, verify
//! the copy reads back identically, then delete the original. When an entry
//! fails, the entries already moved are moved back and the setting keeps its
//! old value; at no point is the only copy deleted.
//!
//! In keychain mode `run/<id>.kubeconfig` of managed clusters is transient:
//! written on connect (or when a terminal / helm needs it), deleted on
//! disconnect, on exit and at the next start after a crash.
//!
//! [`Kubepit::cluster_kubeconfig`] builds the single-context kubeconfig with
//! the cluster's effective proxy applied; the Rust client and the run
//! kubeconfig are both made from it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use kube::config::Kubeconfig;

use crate::app::Kubepit;
use crate::kubeconfig;
use crate::paths::{atomic_write, Paths};
use crate::proxy;
use crate::secrets::{delete_value, read_value, write_value, SecretStore};
use crate::types::{ClusterDef, ClusterProxyInfo, Settings};

/// Credential store key of a managed kubeconfig.
pub fn secret_key(cluster_id: &str) -> String {
    format!("kubeconfig/{cluster_id}")
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("cannot read {}", path.display())),
    }
}

/// Everything needed to read a cluster's kubeconfig, detached from
/// [`Kubepit`] so it can run on the blocking pool (a credential store read
/// may wait for the user to unlock it).
#[derive(Clone)]
pub(crate) struct CredentialSource {
    secrets: Arc<dyn SecretStore>,
    paths: Paths,
    keychain: bool,
}

impl CredentialSource {
    /// Raw bytes of a managed kubeconfig, from the file or the store.
    fn read_managed(&self, cluster: &ClusterDef) -> Result<Vec<u8>> {
        let path = PathBuf::from(&cluster.kubeconfig_path);
        let key = secret_key(&cluster.id);
        let store = self.secrets.as_ref();
        // Configured location first, the other one as a fallback.
        let order = if self.keychain {
            [true, false]
        } else {
            [false, true]
        };
        let mut first_error = None;
        for from_store in order {
            let result = if from_store {
                read_value(store, &key)
            } else if self.paths.is_managed_path(&path) {
                read_file(&path)
            } else {
                Ok(None)
            };
            match result {
                Ok(Some(bytes)) => return Ok(bytes),
                Ok(None) => {}
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        match first_error {
            Some(e) => Err(e)
                .with_context(|| format!("cannot read the kubeconfig of \"{}\"", cluster.name)),
            None => bail!(
                "the kubeconfig of \"{}\" is missing (neither {} nor the {} has it)",
                cluster.name,
                path.display(),
                store.name()
            ),
        }
    }

    /// The full kubeconfig a cluster was registered from.
    pub(crate) fn load(&self, cluster: &ClusterDef) -> Result<Kubeconfig> {
        if !cluster.managed {
            let path = Path::new(&cluster.kubeconfig_path);
            return kubeconfig::load(path)
                .with_context(|| format!("failed to read kubeconfig {}", path.display()));
        }
        let bytes = self.read_managed(cluster)?;
        let text = String::from_utf8(bytes)
            .map_err(|_| anyhow!("the stored kubeconfig of \"{}\" is not UTF-8", cluster.name))?;
        kubeconfig::load_text(&text)
            .with_context(|| format!("the stored kubeconfig of \"{}\" is invalid", cluster.name))
    }

    /// Single-context kubeconfig with the effective proxy applied.
    pub(crate) fn single(&self, cluster: &ClusterDef) -> Result<Kubeconfig> {
        let kc = self.load(cluster)?;
        let mut single = kubeconfig::single_context(&kc, &cluster.context)?;
        proxy::apply(&mut single, cluster.proxy_url.as_deref())?;
        Ok(single)
    }
}

impl Kubepit {
    fn keychain_mode(&self) -> bool {
        self.settings().keychain_kubeconfigs
    }

    pub(crate) fn credential_source(&self) -> CredentialSource {
        CredentialSource {
            secrets: self.secrets.clone(),
            paths: self.paths().clone(),
            keychain: self.keychain_mode(),
        }
    }

    /// The full kubeconfig a cluster was registered from.
    pub(crate) fn load_cluster_source(&self, cluster: &ClusterDef) -> Result<Kubeconfig> {
        self.credential_source().load(cluster)
    }

    /// Single-context kubeconfig with the effective proxy applied: what the
    /// Rust client connects with and what `run/<id>.kubeconfig` contains.
    pub(crate) fn cluster_kubeconfig(&self, cluster: &ClusterDef) -> Result<Kubeconfig> {
        self.credential_source().single(cluster)
    }

    /// [`Self::cluster_kubeconfig`] on the blocking pool.
    pub(crate) async fn cluster_kubeconfig_async(
        &self,
        cluster: &ClusterDef,
    ) -> Result<Kubeconfig> {
        let source = self.credential_source();
        let cluster = cluster.clone();
        tokio::task::spawn_blocking(move || source.single(&cluster))
            .await
            .map_err(|e| anyhow!("background task failed: {e}"))?
    }

    /// `cluster_proxy_info`: the proxy a cluster's connections go through.
    pub fn cluster_proxy_info(&self, id: &str) -> Result<ClusterProxyInfo> {
        let cluster = self.cluster_def(id)?;
        let kc = self.load_cluster_source(&cluster)?;
        let single = kubeconfig::single_context(&kc, &cluster.context)?;
        Ok(proxy::effective(cluster.proxy_url.as_deref(), &single))
    }

    /// Store a pasted kubeconfig for a new cluster; returns the path recorded
    /// in its `ClusterDef` (the file only exists in file mode).
    pub(crate) fn store_managed(&self, id: &str, text: &str) -> Result<PathBuf> {
        let path = self.paths().managed_kubeconfig(id)?;
        if self.keychain_mode() {
            let store = self.secrets.as_ref();
            write_value(store, &secret_key(id), text.as_bytes())
                .with_context(|| format!("cannot store the kubeconfig in the {}", store.name()))?;
        } else {
            atomic_write(&path, text.as_bytes(), true)?;
        }
        Ok(path)
    }

    /// Delete a managed kubeconfig wherever it is. Idempotent.
    pub(crate) fn delete_managed(&self, id: &str, path: &Path) {
        if self.paths().is_managed_path(path) {
            let _ = std::fs::remove_file(path);
        } else {
            tracing::warn!(
                "refusing to delete {} — not inside the managed kubeconfig folder",
                path.display()
            );
        }
        if let Err(e) = delete_value(self.secrets.as_ref(), &secret_key(id)) {
            tracing::warn!("could not delete a stored kubeconfig: {e:#}");
        }
    }

    /// Move one managed kubeconfig file into the store. `Ok(false)` when
    /// there was no file to move.
    fn move_to_store(&self, cluster: &ClusterDef) -> Result<bool> {
        let path = PathBuf::from(&cluster.kubeconfig_path);
        if !self.paths().is_managed_path(&path) {
            return Ok(false);
        }
        let Some(bytes) = read_file(&path)? else {
            return Ok(false);
        };
        let store = self.secrets.as_ref();
        let key = secret_key(&cluster.id);
        write_value(store, &key, &bytes)?;
        if read_value(store, &key)?.as_deref() != Some(bytes.as_slice()) {
            let _ = delete_value(store, &key);
            bail!("the {} did not return what was stored", store.name());
        }
        std::fs::remove_file(&path).with_context(|| format!("cannot delete {}", path.display()))?;
        Ok(true)
    }

    /// Move one managed kubeconfig from the store back to its file.
    fn move_to_file(&self, cluster: &ClusterDef) -> Result<bool> {
        let path = PathBuf::from(&cluster.kubeconfig_path);
        if !self.paths().is_managed_path(&path) {
            return Ok(false);
        }
        let store = self.secrets.as_ref();
        let key = secret_key(&cluster.id);
        let Some(bytes) = read_value(store, &key)? else {
            return Ok(false);
        };
        atomic_write(&path, &bytes, true)?;
        if read_file(&path)?.as_deref() != Some(bytes.as_slice()) {
            bail!("{} does not contain what was written", path.display());
        }
        if let Err(e) = delete_value(store, &key) {
            // Both copies exist now; nothing is lost.
            tracing::warn!(cluster = %cluster.name, "could not delete the stored kubeconfig: {e:#}");
        }
        Ok(true)
    }

    /// `kubeconfig_storage_set`: keep managed kubeconfigs in the OS
    /// credential store (`true`) or in `kubeconfigs/` (`false`), migrating
    /// the existing ones. See the module docs for the guarantees.
    pub fn kubeconfig_storage_set(&self, keychain: bool) -> Result<Settings> {
        let mut settings = self.settings();
        if settings.keychain_kubeconfigs == keychain {
            return Ok(settings);
        }
        let store_name = self.secrets.name().to_string();
        let managed: Vec<ClusterDef> = self
            .cluster_list()
            .into_iter()
            .filter(|c| c.managed)
            .collect();
        let mut moved: Vec<&ClusterDef> = Vec::new();
        for cluster in &managed {
            let result = if keychain {
                self.move_to_store(cluster)
            } else {
                self.move_to_file(cluster)
            };
            match result {
                Ok(true) => moved.push(cluster),
                Ok(false) => {}
                Err(err) => {
                    for done in moved.iter().rev() {
                        let back = if keychain {
                            self.move_to_file(done)
                        } else {
                            self.move_to_store(done)
                        };
                        if let Err(e) = back {
                            tracing::warn!(cluster = %done.name, "could not undo the kubeconfig move: {e:#}");
                        }
                    }
                    let what = if keychain {
                        format!(
                            "move the kubeconfig of \"{}\" to the {store_name}",
                            cluster.name
                        )
                    } else {
                        format!(
                            "move the kubeconfig of \"{}\" out of the {store_name}",
                            cluster.name
                        )
                    };
                    return Err(err.context(format!("could not {what}; nothing was changed")));
                }
            }
        }
        settings.keychain_kubeconfigs = keychain;
        let saved = self.store.set_settings(settings)?;
        if keychain {
            // Run kubeconfigs of idle managed clusters hold the same credentials.
            for cluster in &managed {
                if self.pool.connected_client(&cluster.id).is_none() {
                    self.remove_run_kubeconfig(&cluster.id);
                }
            }
        } else {
            for cluster in &managed {
                if let Err(e) = self.write_run_kubeconfig(cluster) {
                    tracing::warn!(cluster = %cluster.name, "could not write run kubeconfig: {e:#}");
                }
            }
        }
        Ok(saved)
    }

    /// In keychain mode the run kubeconfig of a managed cluster only exists
    /// while it is needed.
    pub(crate) fn run_kubeconfig_is_transient(&self, cluster: &ClusterDef) -> bool {
        cluster.managed && self.keychain_mode()
    }

    pub(crate) fn remove_run_kubeconfig(&self, id: &str) {
        if let Ok(path) = self.paths().run_kubeconfig(id) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Delete every transient run kubeconfig (exit, and start after a crash).
    pub(crate) fn remove_transient_run_kubeconfigs(&self) {
        if !self.keychain_mode() {
            return;
        }
        for cluster in self.cluster_list() {
            if cluster.managed {
                self.remove_run_kubeconfig(&cluster.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::events::NullSink;
    use crate::kubeconfig::tests::TWO_CONTEXTS;
    use crate::paths::Paths;
    use crate::secrets::MemorySecretStore;
    use crate::types::ClusterInput;

    fn setup() -> (tempfile::TempDir, Kubepit, Arc<MemorySecretStore>) {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecretStore::with_max_len(256));
        let app = Kubepit::open_with_secrets(
            Paths::new(dir.path().join("home")),
            Arc::new(NullSink),
            secrets.clone(),
        )
        .unwrap();
        (dir, app, secrets)
    }

    fn pasted(app: &Kubepit, context: &str) -> ClusterDef {
        app.cluster_add(vec![ClusterInput {
            context: context.into(),
            kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
            ..Default::default()
        }])
        .unwrap()
        .remove(0)
    }

    #[test]
    fn toggling_moves_managed_kubeconfigs_both_ways() {
        let (dir, app, secrets) = setup();
        let user_file = dir.path().join("config");
        std::fs::write(&user_file, TWO_CONTEXTS).unwrap();
        let from_file = app
            .cluster_add(vec![ClusterInput {
                context: "prod".into(),
                kubeconfig_path: Some(user_file.to_string_lossy().to_string()),
                ..Default::default()
            }])
            .unwrap()
            .remove(0);
        let a = pasted(&app, "dev");
        let b = pasted(&app, "prod");
        let run_a = app.paths().run_kubeconfig(&a.id).unwrap();
        assert!(run_a.exists());

        let settings = app.kubeconfig_storage_set(true).unwrap();
        assert!(settings.keychain_kubeconfigs);
        assert!(!Path::new(&a.kubeconfig_path).exists());
        assert!(!Path::new(&b.kubeconfig_path).exists());
        // Chunked (the test store holds 256 bytes per entry).
        assert!(secrets.keys().len() > 2);
        assert_eq!(
            read_value(secrets.as_ref(), &secret_key(&a.id))
                .unwrap()
                .unwrap(),
            TWO_CONTEXTS.as_bytes()
        );
        // Idle managed clusters lose their run kubeconfig; user files stay.
        assert!(!run_a.exists());
        assert!(user_file.exists());
        assert_eq!(app.cluster_kubeconfig(&a).unwrap().contexts[0].name, "dev");
        assert_eq!(
            app.cluster_kubeconfig(&from_file).unwrap().contexts[0].name,
            "prod"
        );
        // Terminals and helm still get a run kubeconfig on demand.
        assert!(app.cluster_export_kubeconfig(&b.id).is_ok());

        // A cluster added now goes straight to the store.
        let c = pasted(&app, "dev");
        assert!(!Path::new(&c.kubeconfig_path).exists());
        assert!(!app.paths().run_kubeconfig(&c.id).unwrap().exists());
        assert!(read_value(secrets.as_ref(), &secret_key(&c.id))
            .unwrap()
            .is_some());

        let settings = app.kubeconfig_storage_set(false).unwrap();
        assert!(!settings.keychain_kubeconfigs);
        for cluster in [&a, &b, &c] {
            assert_eq!(
                std::fs::read_to_string(&cluster.kubeconfig_path).unwrap(),
                TWO_CONTEXTS
            );
            assert!(app.paths().run_kubeconfig(&cluster.id).unwrap().exists());
        }
        assert!(secrets.keys().is_empty());
    }

    #[test]
    fn an_unavailable_store_changes_nothing() {
        let (_dir, app, secrets) = setup();
        let a = pasted(&app, "dev");
        secrets.set_available(false);
        let err = format!("{:#}", app.kubeconfig_storage_set(true).unwrap_err());
        assert!(err.contains("test credential store"), "{err}");
        assert!(err.contains("nothing was changed"), "{err}");
        assert!(!app.settings().keychain_kubeconfigs);
        assert_eq!(
            std::fs::read_to_string(&a.kubeconfig_path).unwrap(),
            TWO_CONTEXTS
        );
    }

    #[test]
    fn a_failure_midway_moves_the_others_back() {
        let (_dir, app, secrets) = setup();
        let a = pasted(&app, "dev");
        let b = pasted(&app, "prod");
        // Enough writes for the first kubeconfig's chunks, not the second's.
        let chunks = TWO_CONTEXTS.len().div_ceil(256) + 1;
        secrets.fail_writes_after(chunks);
        assert!(app.kubeconfig_storage_set(true).is_err());
        assert!(!app.settings().keychain_kubeconfigs);
        for cluster in [&a, &b] {
            assert_eq!(
                std::fs::read_to_string(&cluster.kubeconfig_path).unwrap(),
                TWO_CONTEXTS
            );
        }
        assert!(secrets.keys().is_empty());
    }

    #[test]
    fn reads_fall_back_to_the_other_location() {
        let (_dir, app, secrets) = setup();
        let a = pasted(&app, "dev");
        // Simulate an interrupted migration: the entry is only in the store.
        write_value(
            secrets.as_ref(),
            &secret_key(&a.id),
            TWO_CONTEXTS.as_bytes(),
        )
        .unwrap();
        std::fs::remove_file(&a.kubeconfig_path).unwrap();
        assert!(app.cluster_kubeconfig(&a).is_ok());

        secrets.set_available(false);
        let err = format!("{:#}", app.cluster_kubeconfig(&a).unwrap_err());
        assert!(err.contains("locked"), "{err}");
    }

    #[tokio::test]
    async fn removing_a_cluster_deletes_its_stored_kubeconfig() {
        let (_dir, app, secrets) = setup();
        app.kubeconfig_storage_set(true).unwrap();
        let a = pasted(&app, "dev");
        assert!(!secrets.keys().is_empty());
        app.cluster_remove(&a.id).await.unwrap();
        assert!(secrets.keys().is_empty());
    }

    #[test]
    fn adding_fails_cleanly_when_the_store_refuses() {
        let (_dir, app, secrets) = setup();
        app.kubeconfig_storage_set(true).unwrap();
        secrets.set_available(false);
        let err = app
            .cluster_add(vec![ClusterInput {
                context: "dev".into(),
                kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
                ..Default::default()
            }])
            .unwrap_err();
        assert!(format!("{err:#}").contains("test credential store"));
        assert!(app.cluster_list().is_empty());
    }

    #[test]
    fn the_default_store_never_reaches_the_os() {
        let dir = tempfile::tempdir().unwrap();
        let app = Kubepit::open(Paths::new(dir.path().join("home")), Arc::new(NullSink)).unwrap();
        pasted(&app, "dev");
        let err = format!("{:#}", app.kubeconfig_storage_set(true).unwrap_err());
        assert!(err.contains("no OS credential store"), "{err}");
        assert!(!app.settings().keychain_kubeconfigs);
    }

    #[test]
    fn proxy_override_reaches_the_run_kubeconfig() {
        let (_dir, app, _) = setup();
        let mut a = pasted(&app, "dev");
        a.proxy_url = Some("socks5h://bastion:1080".into());
        let a = app.cluster_update(a).unwrap();
        let run = app.cluster_export_kubeconfig(&a.id).unwrap();
        let text = std::fs::read_to_string(run).unwrap();
        assert!(text.contains("proxy-url: socks5://bastion:1080"), "{text}");
        let info = app.cluster_proxy_info(&a.id).unwrap();
        assert_eq!(info.url.as_deref(), Some("socks5h://bastion:1080"));

        let mut bad = a.clone();
        bad.proxy_url = Some("ftp://nope".into());
        assert!(app.cluster_update(bad).is_err());
    }
}
