//! Cluster registry: add / update / remove / export.
//!
//! A cluster is "context X in kubeconfig file Y". Existing files are
//! referenced by absolute path and never modified; pasted kubeconfigs are
//! stored under `kubeconfigs/<id>.yaml` (mode 0600) — or in the OS credential
//! store in keychain mode (`credentials.rs`) — and flagged `managed`.
//! After every change the full list is emitted on `cluster://list`, and the
//! derived `run/<id>.kubeconfig` is regenerated.

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use kube::config::Kubeconfig;

use crate::app::Kubepit;
use crate::kubeconfig;
use crate::objects::now_millis;
use crate::paths::{atomic_write, expand_tilde};
use crate::proxy;
use crate::types::{ClusterDef, ClusterInput};

/// Where a new cluster's kubeconfig comes from.
enum Origin {
    File(PathBuf),
    Pasted(String),
}

fn non_blank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_string();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

fn clean_namespaces(namespaces: Vec<String>) -> Vec<String> {
    clean_tags(namespaces)
}

/// Absolute, canonical path of an existing kubeconfig file.
fn resolve_kubeconfig_path(raw: &str) -> Result<PathBuf> {
    let path = expand_tilde(raw.trim());
    if !path.is_file() {
        bail!("kubeconfig file {} does not exist", path.display());
    }
    std::fs::canonicalize(&path)
        .with_context(|| format!("cannot resolve kubeconfig path {}", path.display()))
}

fn validate_input(index: usize, input: &ClusterInput) -> Result<(Origin, Kubeconfig)> {
    let label = if input.name.trim().is_empty() {
        format!("cluster #{} ({})", index + 1, input.context)
    } else {
        format!("cluster \"{}\"", input.name.trim())
    };
    if input.context.trim().is_empty() {
        bail!("{label}: a context name is required");
    }
    proxy::normalize(input.proxy_url.as_deref()).with_context(|| label.clone())?;
    match (
        non_blank(&input.kubeconfig_path),
        non_blank(&input.kubeconfig_text),
    ) {
        (Some(_), Some(_)) => {
            bail!("{label}: set either kubeconfig_path or kubeconfig_text, not both")
        }
        (None, None) => bail!("{label}: a kubeconfig path or pasted kubeconfig is required"),
        (Some(raw), None) => {
            let path = resolve_kubeconfig_path(raw).with_context(|| label.clone())?;
            let kc = kubeconfig::load(&path)
                .with_context(|| format!("{label}: failed to read {}", path.display()))?;
            kubeconfig::ensure_context(&kc, &input.context).with_context(|| label.clone())?;
            Ok((Origin::File(path), kc))
        }
        (None, Some(_)) => {
            let text = input.kubeconfig_text.clone().unwrap_or_default();
            let kc = kubeconfig::load_text(&text)
                .with_context(|| format!("{label}: the pasted kubeconfig is invalid"))?;
            kubeconfig::ensure_context(&kc, &input.context).with_context(|| label.clone())?;
            Ok((Origin::Pasted(text), kc))
        }
    }
}

impl Kubepit {
    /// `cluster_list`.
    pub fn cluster_list(&self) -> Vec<ClusterDef> {
        self.store.clusters()
    }

    /// `cluster_add`: validates every input first (all-or-nothing), then
    /// stores pasted kubeconfigs and appends the new definitions.
    pub fn cluster_add(&self, inputs: Vec<ClusterInput>) -> Result<Vec<ClusterDef>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let validated: Vec<(ClusterInput, Origin)> = inputs
            .into_iter()
            .enumerate()
            .map(|(i, input)| validate_input(i, &input).map(|(origin, _)| (input, origin)))
            .collect::<Result<_>>()?;

        let now = now_millis();
        let mut written: Vec<(String, PathBuf)> = Vec::new();
        let mut defs: Vec<ClusterDef> = Vec::new();
        let write_result: Result<()> = (|| {
            for (input, origin) in validated {
                let id = uuid::Uuid::new_v4().to_string();
                let (kubeconfig_path, managed) = match origin {
                    Origin::File(path) => (path, false),
                    Origin::Pasted(text) => {
                        let path = self.store_managed(&id, &text)?;
                        written.push((id.clone(), path.clone()));
                        (path, true)
                    }
                };
                let context = input.context.trim().to_string();
                let name = match input.name.trim() {
                    "" => context.clone(),
                    name => name.to_string(),
                };
                defs.push(ClusterDef {
                    id,
                    name,
                    context,
                    kubeconfig_path: kubeconfig_path.to_string_lossy().to_string(),
                    managed,
                    tags: clean_tags(input.tags),
                    environment: input.environment,
                    color: input.color.filter(|c| !c.trim().is_empty()),
                    default_namespace: input.default_namespace.filter(|n| !n.trim().is_empty()),
                    accessible_namespaces: clean_namespaces(input.accessible_namespaces),
                    read_only: input.read_only,
                    notes: input.notes,
                    created_at: now,
                    last_connected_at: None,
                    proxy_url: proxy::normalize(input.proxy_url.as_deref())?,
                });
            }
            Ok(())
        })();
        let commit = write_result.and_then(|()| {
            let new_defs = defs.clone();
            self.store.update_clusters(move |list| {
                list.extend(new_defs);
                Ok(())
            })
        });
        let list = match commit {
            Ok(((), list)) => list,
            Err(e) => {
                for (id, path) in written {
                    self.delete_managed(&id, &path);
                }
                return Err(e);
            }
        };
        for def in &defs {
            if self.run_kubeconfig_is_transient(def) {
                continue;
            }
            if let Err(e) = self.write_run_kubeconfig(def) {
                tracing::warn!(cluster = %def.name, "could not write run kubeconfig: {e:#}");
            }
        }
        self.sink.cluster_list(&list);
        Ok(defs)
    }

    /// `cluster_update`: replaces the editable fields. `id`, `created_at`,
    /// `managed` and `last_connected_at` are owned by the backend. Changing
    /// the context or kubeconfig path drops the live connection.
    pub fn cluster_update(&self, cluster: ClusterDef) -> Result<ClusterDef> {
        let existing = self.cluster_def(&cluster.id)?;
        let kubeconfig_path =
            if existing.managed || cluster.kubeconfig_path.trim() == existing.kubeconfig_path {
                existing.kubeconfig_path.clone()
            } else {
                resolve_kubeconfig_path(&cluster.kubeconfig_path)?
                    .to_string_lossy()
                    .to_string()
            };
        let context = cluster.context.trim().to_string();
        if context.is_empty() {
            bail!("a context name is required");
        }
        let proxy_url = proxy::normalize(cluster.proxy_url.as_deref())?;
        let target_changed =
            kubeconfig_path != existing.kubeconfig_path || context != existing.context;
        // A new proxy needs a new client, like a new context does.
        let connection_changed = target_changed || proxy_url != existing.proxy_url;
        let next = ClusterDef {
            id: existing.id.clone(),
            name: match cluster.name.trim() {
                "" => context.clone(),
                name => name.to_string(),
            },
            context,
            kubeconfig_path,
            managed: existing.managed,
            tags: clean_tags(cluster.tags),
            environment: cluster.environment,
            color: cluster.color.filter(|c| !c.trim().is_empty()),
            default_namespace: cluster.default_namespace.filter(|n| !n.trim().is_empty()),
            accessible_namespaces: clean_namespaces(cluster.accessible_namespaces),
            read_only: cluster.read_only,
            notes: cluster.notes,
            created_at: existing.created_at,
            last_connected_at: existing.last_connected_at,
            proxy_url,
        };
        if target_changed {
            let kc = self.load_cluster_source(&next)?;
            kubeconfig::ensure_context(&kc, &next.context)?;
        }
        let stored = next.clone();
        let ((), list) = self.store.update_clusters(move |list| {
            let slot = list
                .iter_mut()
                .find(|c| c.id == stored.id)
                .ok_or_else(|| anyhow!("cluster {} is not registered", stored.id))?;
            *slot = stored;
            Ok(())
        })?;
        if connection_changed {
            self.cluster_disconnect(&next.id);
        }
        if !self.run_kubeconfig_is_transient(&next) {
            if let Err(e) = self.write_run_kubeconfig(&next) {
                tracing::warn!(cluster = %next.name, "could not write run kubeconfig: {e:#}");
            }
        }
        self.sink.cluster_list(&list);
        Ok(next)
    }

    /// `cluster_remove`: disconnect, stop its work, delete node-shell pods,
    /// the managed kubeconfig and the run kubeconfig. Idempotent.
    pub async fn cluster_remove(&self, id: &str) -> Result<()> {
        let Some(existing) = self.store.cluster(id) else {
            return Ok(());
        };
        self.cleanup_cluster_node_shells(id).await;
        self.forget_connection(id);
        let removed_id = id.to_string();
        let ((), list) = self.store.update_clusters(move |list| {
            list.retain(|c| c.id != removed_id);
            Ok(())
        })?;
        if existing.managed {
            self.delete_managed(id, &PathBuf::from(&existing.kubeconfig_path));
        }
        self.remove_run_kubeconfig(id);
        self.forget_saved_forwards(id);
        self.sink.cluster_list(&list);
        Ok(())
    }

    /// `cluster_export_kubeconfig`: (re)write and return the path of the
    /// single-context kubeconfig for external tools.
    pub fn cluster_export_kubeconfig(&self, id: &str) -> Result<String> {
        let cluster = self.cluster_def(id)?;
        let path = self.write_run_kubeconfig(&cluster)?;
        Ok(path.to_string_lossy().to_string())
    }

    /// Regenerate `run/<id>.kubeconfig` from the cluster's kubeconfig (with
    /// its effective proxy).
    pub(crate) fn write_run_kubeconfig(&self, cluster: &ClusterDef) -> Result<PathBuf> {
        let single = self.cluster_kubeconfig(cluster)?;
        self.write_run_kubeconfig_from(cluster, &single)
    }

    pub(crate) fn write_run_kubeconfig_from(
        &self,
        cluster: &ClusterDef,
        single: &Kubeconfig,
    ) -> Result<PathBuf> {
        let path = self.paths().run_kubeconfig(&cluster.id)?;
        let yaml = kubeconfig::to_yaml(single)?;
        atomic_write(&path, yaml.as_bytes(), true)?;
        Ok(path)
    }
}

/// Fixtures shared by tests in other modules.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;
    use crate::events::NullSink;
    use crate::kubeconfig::tests::TWO_CONTEXTS;
    use crate::paths::Paths;
    use std::sync::Arc;

    /// A Kubepit rooted in a temp dir with one pasted cluster (context `dev`).
    pub(crate) fn app_with_cluster(read_only: bool) -> (tempfile::TempDir, Kubepit, ClusterDef) {
        let dir = tempfile::tempdir().unwrap();
        let app = Kubepit::open(Paths::new(dir.path().join("home")), Arc::new(NullSink)).unwrap();
        let cluster = app
            .cluster_add(vec![ClusterInput {
                name: "Dev".into(),
                context: "dev".into(),
                kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
                read_only,
                ..Default::default()
            }])
            .unwrap()
            .remove(0);
        (dir, app, cluster)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventSink;
    use crate::kubeconfig::tests::TWO_CONTEXTS;
    use crate::paths::Paths;
    use crate::types::{ClusterStatus, PortForward};
    use parking_lot::Mutex;
    use std::path::Path;
    use std::sync::Arc;

    #[derive(Default)]
    struct Recorder {
        lists: Mutex<Vec<usize>>,
    }

    impl EventSink for Recorder {
        fn cluster_status(&self, _status: &ClusterStatus) {}
        fn cluster_list(&self, clusters: &[ClusterDef]) {
            self.lists.lock().push(clusters.len());
        }
        fn port_forwards(&self, _forwards: &[PortForward]) {}
    }

    fn input(context: &str) -> ClusterInput {
        ClusterInput {
            context: context.into(),
            tags: vec![" prod ".into(), "prod".into(), "".into()],
            ..Default::default()
        }
    }

    fn setup() -> (tempfile::TempDir, Kubepit, Arc<Recorder>) {
        let dir = tempfile::tempdir().unwrap();
        let recorder = Arc::new(Recorder::default());
        let app = Kubepit::open(Paths::new(dir.path().join("home")), recorder.clone()).unwrap();
        (dir, app, recorder)
    }

    #[test]
    fn add_from_file_and_text() {
        let (dir, app, recorder) = setup();
        let file = dir.path().join("kubeconfig");
        std::fs::write(&file, TWO_CONTEXTS).unwrap();

        let from_file = ClusterInput {
            kubeconfig_path: Some(file.to_string_lossy().to_string()),
            ..input("prod")
        };
        let pasted = ClusterInput {
            name: "Pasted dev".into(),
            kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
            ..input("dev")
        };
        let added = app.cluster_add(vec![from_file, pasted]).unwrap();
        assert_eq!(added.len(), 2);
        assert_eq!(added[0].name, "prod");
        assert!(!added[0].managed);
        assert_eq!(added[0].tags, vec!["prod"]);
        assert!(added[0].created_at > 0);
        assert!(added[1].managed);
        assert_eq!(added[1].name, "Pasted dev");
        let managed = PathBuf::from(&added[1].kubeconfig_path);
        assert!(managed.starts_with(app.paths().kubeconfigs_dir()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&managed).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // Run kubeconfigs contain exactly one context.
        let run = app.cluster_export_kubeconfig(&added[0].id).unwrap();
        let kc = kubeconfig::load(Path::new(&run)).unwrap();
        assert_eq!(kc.contexts.len(), 1);
        assert_eq!(kc.current_context.as_deref(), Some("prod"));

        assert_eq!(app.cluster_list().len(), 2);
        assert_eq!(recorder.lists.lock().as_slice(), &[2]);
        // The user's own file is untouched.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), TWO_CONTEXTS);
    }

    #[test]
    fn add_is_all_or_nothing() {
        let (_dir, app, _) = setup();
        let good = ClusterInput {
            kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
            ..input("dev")
        };
        let bad = ClusterInput {
            kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
            ..input("nope")
        };
        let err = app.cluster_add(vec![good, bad]).unwrap_err();
        assert!(format!("{err:#}").contains("\"nope\" not found"));
        assert!(app.cluster_list().is_empty());
        let leftovers = std::fs::read_dir(app.paths().kubeconfigs_dir())
            .unwrap()
            .count();
        assert_eq!(leftovers, 0);

        let both = ClusterInput {
            kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
            kubeconfig_path: Some("/tmp/x".into()),
            ..input("dev")
        };
        assert!(app.cluster_add(vec![both]).is_err());
        assert!(app.cluster_add(vec![input("dev")]).is_err());
    }

    #[test]
    fn update_keeps_backend_owned_fields() {
        let (_dir, app, _) = setup();
        let added = app
            .cluster_add(vec![ClusterInput {
                kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
                ..input("dev")
            }])
            .unwrap();
        let mut edited = added[0].clone();
        edited.name = "Renamed".into();
        edited.read_only = true;
        edited.managed = false;
        edited.created_at = 0;
        edited.kubeconfig_path = "/somewhere/else".into();
        let updated = app.cluster_update(edited).unwrap();
        assert_eq!(updated.name, "Renamed");
        assert!(updated.read_only);
        assert!(updated.managed);
        assert_eq!(updated.created_at, added[0].created_at);
        assert_eq!(updated.kubeconfig_path, added[0].kubeconfig_path);

        let mut bad = updated.clone();
        bad.context = "missing".into();
        assert!(app.cluster_update(bad).is_err());
        assert_eq!(app.cluster_def(&updated.id).unwrap().context, "dev");
    }

    #[tokio::test]
    async fn remove_deletes_managed_and_run_files_only() {
        let (dir, app, _) = setup();
        let file = dir.path().join("kubeconfig");
        std::fs::write(&file, TWO_CONTEXTS).unwrap();
        let added = app
            .cluster_add(vec![
                ClusterInput {
                    kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
                    ..input("dev")
                },
                ClusterInput {
                    kubeconfig_path: Some(file.to_string_lossy().to_string()),
                    ..input("prod")
                },
            ])
            .unwrap();
        let managed = PathBuf::from(&added[0].kubeconfig_path);
        let run = app.paths().run_kubeconfig(&added[0].id).unwrap();
        assert!(managed.exists() && run.exists());

        app.cluster_remove(&added[0].id).await.unwrap();
        app.cluster_remove(&added[1].id).await.unwrap();
        app.cluster_remove("already-gone").await.unwrap();
        assert!(!managed.exists());
        assert!(!run.exists());
        assert!(file.exists(), "user kubeconfig must never be deleted");
        assert!(app.cluster_list().is_empty());
    }

    #[test]
    fn read_only_clusters_reject_mutations() {
        let (_dir, app, _) = setup();
        let added = app
            .cluster_add(vec![ClusterInput {
                kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
                read_only: true,
                ..input("dev")
            }])
            .unwrap();
        let err = app.ensure_writable(&added[0].id, "delete").unwrap_err();
        assert!(err.to_string().contains("is read-only"));
    }
}
