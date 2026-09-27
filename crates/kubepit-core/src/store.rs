//! Persisted state: `clusters.json`, `settings.json`, `workspace.json`.
//!
//! The registry and settings are cached in memory behind `parking_lot`
//! locks and written through on every change (atomic temp-file + rename).
//! Mutations run under the write lock *including* the disk write, so two
//! concurrent `cluster_add` calls can never interleave and lose an entry.
//!
//! A corrupt file is never silently overwritten: it is moved aside to
//! `<name>.corrupt-<unix-ms>` and Kubepit starts from defaults, so the user
//! can recover it by hand.

use std::path::Path;

use anyhow::{Context, Result};
use parking_lot::RwLock;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::paths::{atomic_write, Paths};
use crate::types::{ClusterDef, Settings};

pub struct Store {
    paths: Paths,
    clusters: RwLock<Vec<ClusterDef>>,
    settings: RwLock<Settings>,
}

impl Store {
    /// Load (or initialise) the store rooted at `paths`.
    pub fn open(paths: Paths) -> Result<Self> {
        paths.ensure_dirs()?;
        let clusters: Vec<ClusterDef> = load_json_or_default(&paths.clusters_file())?;
        let settings: Settings = load_json_or_default(&paths.settings_file())?;
        Ok(Self {
            paths,
            clusters: RwLock::new(clusters),
            settings: RwLock::new(settings),
        })
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    pub fn clusters(&self) -> Vec<ClusterDef> {
        self.clusters.read().clone()
    }

    pub fn cluster(&self, id: &str) -> Option<ClusterDef> {
        self.clusters.read().iter().find(|c| c.id == id).cloned()
    }

    /// Mutate the registry and persist it before releasing the lock. When
    /// `f` fails, nothing is written and the in-memory list is untouched.
    pub fn update_clusters<R>(
        &self,
        f: impl FnOnce(&mut Vec<ClusterDef>) -> Result<R>,
    ) -> Result<(R, Vec<ClusterDef>)> {
        let mut guard = self.clusters.write();
        let mut next = guard.clone();
        let out = f(&mut next)?;
        write_json(&self.paths.clusters_file(), &next, false)?;
        *guard = next;
        Ok((out, guard.clone()))
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().clone()
    }

    pub fn set_settings(&self, settings: Settings) -> Result<Settings> {
        let mut guard = self.settings.write();
        write_json(&self.paths.settings_file(), &settings, false)?;
        *guard = settings;
        Ok(guard.clone())
    }

    /// The frontend-owned workspace snapshot, `None` when never saved.
    pub fn load_workspace(&self) -> Result<Option<Value>> {
        let path = self.paths.workspace_file();
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Null) => Ok(None),
                Ok(value) => Ok(Some(value)),
                Err(e) => {
                    tracing::warn!("workspace.json is corrupt ({e}); starting fresh");
                    quarantine(&path);
                    Ok(None)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("failed to read {}", path.display())),
        }
    }

    pub fn save_workspace(&self, snapshot: &Value) -> Result<()> {
        write_json(&self.paths.workspace_file(), snapshot, false)
    }
}

fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T, private: bool) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("failed to serialise state")?;
    atomic_write(path, &bytes, private)
}

fn load_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => Ok(T::default()),
        Ok(bytes) => match serde_json::from_slice::<T>(&bytes) {
            Ok(value) => Ok(value),
            Err(e) => {
                tracing::warn!(
                    "{} is corrupt ({e}); moved aside, starting from defaults",
                    path.display()
                );
                quarantine(path);
                Ok(T::default())
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e).with_context(|| format!("failed to read {}", path.display())),
    }
}

fn quarantine(path: &Path) {
    let stamp = chrono::Utc::now().timestamp_millis();
    let mut target = path.as_os_str().to_owned();
    target.push(format!(".corrupt-{stamp}"));
    let _ = std::fs::rename(path, &target);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cluster(id: &str) -> ClusterDef {
        ClusterDef {
            id: id.into(),
            name: id.into(),
            context: "ctx".into(),
            kubeconfig_path: "/tmp/config".into(),
            managed: false,
            tags: vec![],
            environment: None,
            color: None,
            default_namespace: None,
            accessible_namespaces: vec![],
            read_only: false,
            notes: String::new(),
            created_at: 1,
            last_connected_at: None,
        }
    }

    #[test]
    fn clusters_and_settings_persist() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(Paths::new(dir.path())).unwrap();
        assert!(store.clusters().is_empty());
        store
            .update_clusters(|list| {
                list.push(cluster("a"));
                Ok(())
            })
            .unwrap();
        let mut settings = store.settings();
        settings.terminal_font_size = 16;
        store.set_settings(settings).unwrap();

        let reopened = Store::open(Paths::new(dir.path())).unwrap();
        assert_eq!(reopened.clusters().len(), 1);
        assert_eq!(reopened.cluster("a").unwrap().name, "a");
        assert_eq!(reopened.settings().terminal_font_size, 16);
    }

    #[test]
    fn failed_mutation_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(Paths::new(dir.path())).unwrap();
        let result = store.update_clusters(|list| -> anyhow::Result<()> {
            list.push(cluster("a"));
            anyhow::bail!("validation failed")
        });
        assert!(result.is_err());
        assert!(store.clusters().is_empty());
        assert!(!dir.path().join("clusters.json").exists());
    }

    #[test]
    fn corrupt_files_are_quarantined_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("clusters.json"), "{not json").unwrap();
        let store = Store::open(Paths::new(dir.path())).unwrap();
        assert!(store.clusters().is_empty());
        let quarantined = std::fs::read_dir(dir.path()).unwrap().flatten().any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("clusters.json.corrupt-")
        });
        assert!(quarantined);
    }

    #[test]
    fn workspace_is_opaque_and_null_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(Paths::new(dir.path())).unwrap();
        assert_eq!(store.load_workspace().unwrap(), None);
        let snapshot = json!({"version": 1, "sections": [], "clusterSection": {"a": "s"}});
        store.save_workspace(&snapshot).unwrap();
        assert_eq!(store.load_workspace().unwrap(), Some(snapshot));
    }
}
