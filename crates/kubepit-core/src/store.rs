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

use crate::ai::AiSettings;
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
        let mut settings = load_settings(&paths.settings_file())?;
        // Hand edits, a downgrade, a cluster removed or made production
        // elsewhere: the assistant never starts enabled where it may not be.
        settings.ai = std::mem::take(&mut settings.ai).normalized();
        settings.ai.reconcile_clusters(&clusters);
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

    /// Mutate the settings and persist them before releasing the lock. This
    /// is the only way to change them: every caller changes just its own
    /// fields of the current value, so backend-owned fields
    /// (`keychain_kubeconfigs`, the assistant's cluster lists) are never
    /// lost to a stale snapshot. When `f` fails or the write fails, nothing
    /// changes; unchanged settings are not rewritten.
    ///
    /// Lock order: settings, then clusters. `f` may read the registry
    /// ([`Self::cluster`]); no [`Self::update_clusters`] closure touches the
    /// settings. `f` must not call [`Self::settings`] (not reentrant).
    pub fn update_settings<R>(
        &self,
        f: impl FnOnce(&mut Settings) -> Result<R>,
    ) -> Result<(R, Settings)> {
        let mut guard = self.settings.write();
        let mut next = guard.clone();
        let out = f(&mut next)?;
        if next != *guard {
            write_json(&self.paths.settings_file(), &next, false)?;
            *guard = next;
        }
        Ok((out, guard.clone()))
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

pub(crate) fn write_json<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
    private: bool,
) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("failed to serialise state")?;
    atomic_write(path, &bytes, private)
}

/// `settings.json`: like [`load_json_or_default`], except that the `ai`
/// group is read leniently ([`AiSettings::from_stored`]): an assistant
/// setting from a newer build or a hand edit never resets the others.
fn load_settings(path: &Path) -> Result<Settings> {
    let value: Value = load_json_or_default(path)?;
    let mut fields = match value {
        Value::Null => return Ok(Settings::default()),
        Value::Object(fields) => fields,
        _ => {
            tracing::warn!(
                "{} is not a JSON object; moved aside, starting from defaults",
                path.display()
            );
            quarantine(path);
            return Ok(Settings::default());
        }
    };
    let ai = fields.remove("ai");
    let mut settings: Settings = match serde_json::from_value(Value::Object(fields)) {
        Ok(settings) => settings,
        Err(e) => {
            tracing::warn!(
                "{} is corrupt ({e}); moved aside, starting from defaults",
                path.display()
            );
            quarantine(path);
            return Ok(Settings::default());
        }
    };
    if let Some(ai) = ai {
        settings.ai = AiSettings::from_stored(ai);
    }
    Ok(settings)
}

pub(crate) fn load_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
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
            source_kubeconfig_path: None,
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
            cost: Default::default(),
            prometheus: Default::default(),
            prometheus_access: Default::default(),
            loki: Default::default(),
            proxy_url: None,
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
        let (out, saved) = store
            .update_settings(|settings| {
                settings.terminal_font_size = 16;
                Ok("done")
            })
            .unwrap();
        assert_eq!((out, saved.terminal_font_size), ("done", 16));

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

        let result = store.update_settings(|settings| -> anyhow::Result<()> {
            settings.terminal_font_size = 20;
            anyhow::bail!("validation failed")
        });
        assert!(result.is_err());
        assert_eq!(store.settings(), Settings::default());
        assert!(!dir.path().join("settings.json").exists());
        // Nothing changed: nothing is written.
        store.update_settings(|_| Ok(())).unwrap();
        assert!(!dir.path().join("settings.json").exists());
    }

    #[test]
    fn loading_drops_assistant_clusters_the_registry_does_not_allow() {
        let dir = tempfile::tempdir().unwrap();
        let prod = |id: &str| ClusterDef {
            environment: Some(crate::types::ClusterEnvironment::Production),
            ..cluster(id)
        };
        let clusters = vec![
            cluster("dev"),
            prod("acked"),
            prod("unacked"),
            cluster("stale-ack"),
        ];
        write_json(&dir.path().join("clusters.json"), &clusters, false).unwrap();
        let file = json!({
            "terminal_font_size": 15,
            "ai": {
                "clusters": ["dev", "acked", "unacked", "stale-ack", "gone", " dev "],
                "production_acknowledged": ["acked", "stale-ack", "gone", "dev-not-enabled"]
            }
        });
        std::fs::write(dir.path().join("settings.json"), file.to_string()).unwrap();
        let settings = Store::open(Paths::new(dir.path())).unwrap().settings();
        assert_eq!(settings.terminal_font_size, 15);
        assert_eq!(settings.ai.clusters, ["acked", "dev", "stale-ack"]);
        assert_eq!(settings.ai.production_acknowledged, ["acked"]);
        for c in &clusters {
            let expected = ["dev", "acked", "stale-ack"].contains(&c.id.as_str());
            assert_eq!(settings.ai.cluster_allowed(c), expected, "{}", c.id);
        }
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

    fn quarantined(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().flatten().any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("settings.json.corrupt-")
        })
    }

    #[test]
    fn an_unreadable_ai_group_keeps_the_other_settings() {
        // A newer build's provider kind, effort and tool policy.
        let dir = tempfile::tempdir().unwrap();
        let file = json!({
            "terminal_font_size": 17,
            "ai": {
                "enabled": true,
                "log_requests": false,
                "effort": "ultra",
                "tool_policy": "sometimes",
                "providers": [
                    {"id": "future", "kind": "gemini", "base_url": "https://g.example"},
                    {"id": "gateway", "kind": "openai-compatible",
                     "base_url": "https://gateway.example/v1"}
                ]
            }
        });
        std::fs::write(dir.path().join("settings.json"), file.to_string()).unwrap();
        let settings = Store::open(Paths::new(dir.path())).unwrap().settings();
        assert_eq!(settings.terminal_font_size, 17);
        assert!(settings.ai.enabled && !settings.ai.log_requests);
        assert_eq!(settings.ai.effort, None);
        assert_eq!(settings.ai.tool_policy, crate::ai::AiToolPolicy::Ask);
        assert!(settings.ai.provider("future").is_none());
        assert!(settings.ai.provider("gateway").is_some());
        assert!(
            settings.ai.provider("anthropic").is_some(),
            "defaults re-added"
        );
        assert!(!quarantined(dir.path()));

        // An `ai` value that is not an object: the whole group is reset.
        let dir = tempfile::tempdir().unwrap();
        let file = json!({"terminal_font_size": 18, "ai": ["not", "an", "object"]});
        std::fs::write(dir.path().join("settings.json"), file.to_string()).unwrap();
        let settings = Store::open(Paths::new(dir.path())).unwrap().settings();
        assert_eq!(settings.terminal_font_size, 18);
        assert_eq!(settings.ai, crate::ai::AiSettings::default());
        assert!(!quarantined(dir.path()));

        // Anything else that is broken still quarantines the whole file.
        let dir = tempfile::tempdir().unwrap();
        let file = json!({"terminal_font_size": "big"});
        std::fs::write(dir.path().join("settings.json"), file.to_string()).unwrap();
        let settings = Store::open(Paths::new(dir.path())).unwrap().settings();
        assert_eq!(settings, Settings::default());
        assert!(quarantined(dir.path()));
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
