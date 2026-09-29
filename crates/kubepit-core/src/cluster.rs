//! Cluster registry: add / update / remove / export.
//!
//! A cluster is "context X in kubeconfig file Y". Imported files and pasted
//! kubeconfigs are stored under `kubeconfigs/<storage-id>.yaml` (mode 0600) —
//! or in the OS credential store in keychain mode (`credentials.rs`) — and
//! flagged `managed`. Legacy linked sources are never rewritten or migrated
//! without an explicit reimport.
//! After every change the full list is emitted on `cluster://list`, and the
//! derived `run/<id>.kubeconfig` is regenerated.

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use kube::config::Kubeconfig;

use crate::app::Kubepit;
use crate::cost::CostConfig;
use crate::kubeconfig;
use crate::objects::now_millis;
use crate::paths::{atomic_write, expand_tilde};
use crate::prometheus::access::{overlapping_sources, PrometheusAccess};
use crate::proxy;
use crate::types::{
    ClusterDef, ClusterEnvironment, ClusterInput, KubeconfigImport, KubeconfigSource, LokiConfig,
    PrometheusConfig,
};

struct PreparedKubeconfig {
    text: String,
    source_path: Option<String>,
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

/// The observability sources of a new cluster, normalized like
/// `cluster_update` does before anything is stored.
struct Sources {
    cost: CostConfig,
    prometheus: PrometheusConfig,
    prometheus_access: PrometheusAccess,
    loki: LokiConfig,
}

/// Refuse `candidate` when it would read the data of a cluster in `others`
/// from a shared Prometheus (see [`overlapping_sources`]).
fn ensure_disjoint_sources<'a>(
    candidate: &ClusterDef,
    others: impl IntoIterator<Item = &'a ClusterDef>,
) -> Result<()> {
    let clash = others.into_iter().find(|other| {
        other.id != candidate.id
            && overlapping_sources(
                (&candidate.prometheus, &candidate.prometheus_access),
                (&other.prometheus, &other.prometheus_access),
            )
    });
    if let Some(other) = clash {
        bail!(
            "Prometheus: the cluster labels of \"{}\" and \"{}\" overlap on the same service and \
             tenant; give each cluster its own value of one label (for example cluster=\"{}\")",
            candidate.name,
            other.name,
            candidate.name
        );
    }
    Ok(())
}

fn prepare_kubeconfig(
    input: &KubeconfigImport,
    stored: Option<(Kubeconfig, Option<String>)>,
    preserve_pasted: bool,
) -> Result<PreparedKubeconfig> {
    let context = input.context.trim();
    if context.is_empty() {
        bail!("a context name is required");
    }
    let (mut kc, source_path, pasted) = match (
        non_blank(&input.kubeconfig_path),
        non_blank(&input.kubeconfig_text),
    ) {
        (Some(_), Some(_)) => bail!("set either kubeconfig_path or kubeconfig_text, not both"),
        (Some(raw), None) => {
            let path = resolve_kubeconfig_path(raw)?;
            let kc = kubeconfig::load(&path)?;
            (kc, Some(path.to_string_lossy().to_string()), false)
        }
        (None, Some(text)) => (kubeconfig::load_text(text)?, None, true),
        (None, None) => {
            let (kc, source_path) =
                stored.context("a kubeconfig path or pasted kubeconfig is required")?;
            (kc, source_path, false)
        }
    };
    if let Some(mapping) = &input.create_context {
        kubeconfig::create_context(&mut kc, context, mapping)?;
    }
    // Validate the complete selected mapping, not only the context's name.
    let mut single = kubeconfig::single_context(&kc, context)?;
    let server = kubeconfig::server_for_context(&single, context);
    if server
        .as_deref()
        .is_none_or(|server| server.trim().is_empty())
    {
        bail!("context \"{context}\" has no server");
    }
    // Pasted sources have no source directory. Preserve the existing paste
    // contract; file imports and repairs must carry portable credentials.
    if pasted && preserve_pasted && input.create_context.is_none() {
        return Ok(PreparedKubeconfig {
            text: input.kubeconfig_text.clone().unwrap_or_default(),
            source_path,
        });
    }
    if !pasted || !preserve_pasted {
        kubeconfig::embed_credentials(&mut single)?;
    }
    Ok(PreparedKubeconfig {
        text: kubeconfig::to_yaml(&single)?,
        source_path,
    })
}

fn validate_input(index: usize, input: &ClusterInput) -> Result<(PreparedKubeconfig, Sources)> {
    let label = if input.name.trim().is_empty() {
        format!("cluster #{} ({})", index + 1, input.context)
    } else {
        format!("cluster \"{}\"", input.name.trim())
    };
    if input.context.trim().is_empty() {
        bail!("{label}: a context name is required");
    }
    proxy::normalize(input.proxy_url.as_deref()).with_context(|| label.clone())?;
    let sources = Sources {
        cost: input
            .cost
            .clone()
            .normalized()
            .with_context(|| label.clone())?,
        prometheus: input
            .prometheus
            .clone()
            .normalized()
            .with_context(|| label.clone())?,
        prometheus_access: input
            .prometheus_access
            .clone()
            .normalized()
            .with_context(|| label.clone())?,
        loki: input
            .loki
            .clone()
            .normalized()
            .with_context(|| label.clone())?,
    };
    sources
        .prometheus_access
        .ensure_source(&sources.prometheus)
        .with_context(|| label.clone())?;
    let prepared = prepare_kubeconfig(
        &KubeconfigImport {
            kubeconfig_path: input.kubeconfig_path.clone(),
            kubeconfig_text: input.kubeconfig_text.clone(),
            context: input.context.clone(),
            create_context: input.create_context.clone(),
        },
        None,
        true,
    )
    .with_context(|| label)?;
    Ok((prepared, sources))
}

impl Kubepit {
    /// `cluster_list`.
    pub fn cluster_list(&self) -> Vec<ClusterDef> {
        self.store.clusters()
    }

    /// `cluster_add`: validates every input first (all-or-nothing, including
    /// its Prometheus, Loki and cost settings), then stores managed
    /// kubeconfigs and appends the new definitions.
    pub fn cluster_add(&self, inputs: Vec<ClusterInput>) -> Result<Vec<ClusterDef>> {
        let _guard = self.kubeconfig_mutations.lock();
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let validated: Vec<(ClusterInput, PreparedKubeconfig, Sources)> = inputs
            .into_iter()
            .enumerate()
            .map(|(i, input)| {
                validate_input(i, &input).map(|(origin, sources)| (input, origin, sources))
            })
            .collect::<Result<_>>()?;

        let now = now_millis();
        let mut written: Vec<(String, PathBuf)> = Vec::new();
        let mut defs: Vec<ClusterDef> = Vec::new();
        let write_result: Result<()> = (|| {
            for (input, prepared, sources) in validated {
                let id = uuid::Uuid::new_v4().to_string();
                let kubeconfig_path = self.store_managed(&id, &prepared.text)?;
                written.push((id.clone(), kubeconfig_path.clone()));
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
                    source_kubeconfig_path: prepared.source_path,
                    managed: true,
                    tags: clean_tags(input.tags),
                    environment: input.environment,
                    color: input.color.filter(|c| !c.trim().is_empty()),
                    default_namespace: input.default_namespace.filter(|n| !n.trim().is_empty()),
                    accessible_namespaces: clean_namespaces(input.accessible_namespaces),
                    read_only: input.read_only,
                    notes: input.notes,
                    created_at: now,
                    last_connected_at: None,
                    cost: sources.cost,
                    prometheus: sources.prometheus,
                    prometheus_access: sources.prometheus_access,
                    loki: sources.loki,
                    proxy_url: proxy::normalize(input.proxy_url.as_deref())?,
                });
            }
            Ok(())
        })();
        let commit = write_result.and_then(|()| {
            let new_defs = defs.clone();
            self.store.update_clusters(move |list| {
                for (i, def) in new_defs.iter().enumerate() {
                    ensure_disjoint_sources(def, list.iter().chain(&new_defs[..i]))?;
                }
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
        let _guard = self.kubeconfig_mutations.lock();
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
            source_kubeconfig_path: existing.source_kubeconfig_path.clone(),
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
            cost: cluster.cost.normalized()?,
            prometheus: cluster.prometheus.normalized()?,
            prometheus_access: cluster.prometheus_access.normalized()?,
            loki: cluster.loki.normalized()?,
            proxy_url,
        };
        next.prometheus_access.ensure_source(&next.prometheus)?;
        if target_changed {
            let kc = self.load_cluster_source(&next)?;
            kubeconfig::ensure_context(&kc, &next.context)?;
        }
        // Every check that can refuse the save runs before the assistant is
        // turned off below (it runs again, authoritatively, in the save).
        ensure_disjoint_sources(&next, self.store.clusters().iter())?;
        // Enabling the assistant on a production cluster needs a typed
        // acknowledgement: a cluster that becomes production must get it.
        // Turned off before the save, so failing to turn it off changes
        // nothing, and reconciled again after it (see below).
        let becomes_production = next.environment == Some(ClusterEnvironment::Production)
            && existing.environment != Some(ClusterEnvironment::Production);
        if becomes_production {
            self.ai_forget_cluster(&next.id).map_err(|e| {
                e.context(format!(
                    "could not turn off the assistant for \"{}\"; nothing was changed",
                    next.name
                ))
            })?;
        }
        let stored = next.clone();
        let ((), list) = self.store.update_clusters(move |list| {
            ensure_disjoint_sources(&stored, list.iter())?;
            let slot = list
                .iter_mut()
                .find(|c| c.id == stored.id)
                .ok_or_else(|| anyhow!("cluster {} is not registered", stored.id))?;
            // Metadata validation can wait on a keychain read. A reimport
            // committed meanwhile must not be overwritten with the old path.
            if slot.kubeconfig_path != existing.kubeconfig_path
                || slot.context != existing.context
                || slot.managed != existing.managed
            {
                bail!("the cluster source changed; reopen its settings and try again");
            }
            *slot = stored;
            Ok(())
        })?;
        if connection_changed {
            self.cluster_disconnect(&next.id);
        }
        // `ai_cluster_set` may have enabled it (as not production) between
        // the forget and the save; a production cluster without an
        // acknowledgement is disabled. Failing that is the command's error;
        // failing to drop a stale acknowledgement is only logged.
        let ai_reconciled = self.ai_reconcile_cluster(&next.id);
        // Secret values read for the old settings must not outlive them,
        // and scans of the new source start soon.
        if next.prometheus != existing.prometheus
            || next.prometheus_access != existing.prometheus_access
        {
            self.prometheus_tunnels.forget(&next.id);
            self.recommendations_source_changed(&next.id);
        }
        if !self.run_kubeconfig_is_transient(&next) {
            if let Err(e) = self.write_run_kubeconfig(&next) {
                tracing::warn!(cluster = %next.name, "could not write run kubeconfig: {e:#}");
            }
        }
        self.sink.cluster_list(&list);
        ai_reconciled.map_err(|e| {
            e.context(format!(
                "\"{}\" was saved, but the assistant could not be turned off for it",
                next.name
            ))
        })?;
        Ok(next)
    }

    /// Metadata only, including keychain-backed sources; never returns credentials.
    pub fn cluster_kubeconfig_source(&self, id: &str) -> Result<KubeconfigSource> {
        let cluster = self.cluster_def(id)?;
        let source = self.load_cluster_source(&cluster)?;
        Ok(kubeconfig::source_from(cluster.kubeconfig_path, &source))
    }

    /// Stage a fresh managed source, atomically switch the registry pointer, then
    /// retire the old source. A failed write never overwrites the working copy.
    pub fn cluster_reimport_kubeconfig(
        &self,
        id: &str,
        input: KubeconfigImport,
    ) -> Result<ClusterDef> {
        let _guard = self.kubeconfig_mutations.lock();
        let existing = self.cluster_def(id)?;
        let stored = if non_blank(&input.kubeconfig_path).is_none()
            && non_blank(&input.kubeconfig_text).is_none()
        {
            Some((
                self.load_cluster_source(&existing)?,
                existing
                    .source_kubeconfig_path
                    .clone()
                    .or_else(|| (!existing.managed).then(|| existing.kubeconfig_path.clone())),
            ))
        } else {
            None
        };
        let prepared = prepare_kubeconfig(&input, stored, false)?;
        let storage_id = uuid::Uuid::new_v4().to_string();
        let path = self.store_managed(&storage_id, &prepared.text)?;
        let committed = self.store.update_clusters(|list| {
            let slot = list
                .iter_mut()
                .find(|cluster| cluster.id == id)
                .with_context(|| format!("cluster {id} is not registered"))?;
            if slot.kubeconfig_path != existing.kubeconfig_path || slot.context != existing.context
            {
                bail!("the cluster source changed; reopen its settings and try again");
            }
            slot.context = input.context.trim().to_string();
            slot.kubeconfig_path = path.to_string_lossy().to_string();
            slot.source_kubeconfig_path = prepared.source_path;
            slot.managed = true;
            Ok(slot.clone())
        });
        let (updated, list) = match committed {
            Ok(committed) => committed,
            Err(error) => {
                self.delete_managed(&storage_id, &path);
                return Err(error);
            }
        };
        self.cluster_disconnect(id);
        self.remove_run_kubeconfig(id);
        if existing.managed {
            self.delete_managed(&existing.id, &PathBuf::from(&existing.kubeconfig_path));
        }
        if !self.run_kubeconfig_is_transient(&updated) {
            if let Err(error) = self.write_run_kubeconfig(&updated) {
                tracing::warn!(cluster = %updated.name, "could not write run kubeconfig: {error:#}");
            }
        }
        self.sink.cluster_list(&list);
        Ok(updated)
    }

    /// `cluster_remove`: disconnect, stop its work, delete node-shell pods,
    /// the managed kubeconfig and the run kubeconfig, and drop it from the
    /// assistant's cluster lists. Idempotent.
    pub async fn cluster_remove(&self, id: &str) -> Result<()> {
        if self.store.cluster(id).is_none() {
            // Tidies a leftover of an earlier removal (see below).
            self.ai_forget_removed_cluster(id);
            return Ok(());
        }
        self.cleanup_cluster_node_shells(id).await;
        self.forget_connection(id);
        // Its stored recommendation scans go too (after its scan stopped).
        self.forget_recommendations(id).await;
        // Reimport/migration may run while asynchronous cleanup is pending.
        // Reload under the mutation lock and delete the latest revision only;
        // no lock is held across an await.
        let _guard = self.kubeconfig_mutations.lock();
        let Some(existing) = self.store.cluster(id) else {
            return Ok(());
        };
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
        // After the removal, so `ai_cluster_set` cannot enable it again.
        self.ai_forget_removed_cluster(id);
        self.sink.cluster_list(&list);
        Ok(())
    }

    /// Drop a removed cluster from the assistant's lists. Never fails the
    /// removal: an unregistered cluster cannot be used, and loading drops
    /// a leftover id (`ai_reconcile_cluster` logs a failed save).
    fn ai_forget_removed_cluster(&self, id: &str) {
        if let Err(e) = self.ai_reconcile_cluster(id) {
            tracing::warn!(
                cluster = id,
                "could not drop a removed cluster from the assistant settings: {e:#}"
            );
        }
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

#[cfg(test)]
#[path = "cluster/import_tests.rs"]
mod import_tests;

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
        assert!(added[0].managed);
        assert_eq!(
            added[0].source_kubeconfig_path.as_deref(),
            file.canonicalize().unwrap().to_str()
        );
        assert_ne!(added[0].kubeconfig_path, file.to_string_lossy());
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
    fn prometheus_credentials_need_a_chosen_service() {
        use crate::prometheus::access::{PrometheusAccess, PrometheusAuth};
        use crate::types::PromScheme;

        let (_dir, app, _) = setup();
        let secured = PrometheusAccess {
            auth: Some(PrometheusAuth::Bearer {
                namespace: "monitoring".into(),
                secret: "prom-auth".into(),
                token_key: "token".into(),
            }),
            ..Default::default()
        };
        let service = PrometheusConfig::Service {
            namespace: "monitoring".into(),
            service: "thanos-query".into(),
            port: 9090,
            scheme: PromScheme::Https,
            path_prefix: String::new(),
        };
        let add = |prometheus: PrometheusConfig| ClusterInput {
            kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
            prometheus,
            prometheus_access: secured.clone(),
            ..input("dev")
        };
        // Detection (or nothing) with credentials is refused before anything is stored.
        for config in [PrometheusConfig::Auto, PrometheusConfig::Off] {
            let err = app.cluster_add(vec![add(config)]).unwrap_err();
            assert!(
                format!("{err:#}").contains("chosen in the cluster settings"),
                "{err:#}"
            );
        }
        assert!(app.cluster_list().is_empty());
        let added = app.cluster_add(vec![add(service)]).unwrap().remove(0);
        assert!(added.prometheus_access.auth.is_some());

        // Switching back to detection keeps the credentials out.
        let mut auto = added.clone();
        auto.prometheus = PrometheusConfig::Auto;
        let err = app.cluster_update(auto.clone()).unwrap_err();
        assert!(
            err.to_string().contains("chosen in the cluster settings"),
            "{err}"
        );
        assert_eq!(
            app.cluster_def(&added.id).unwrap().prometheus,
            added.prometheus
        );
        auto.prometheus_access.auth = None;
        app.cluster_update(auto).unwrap();
    }

    #[test]
    fn access_changes_drop_cached_secret_values() {
        use crate::prometheus::access::PrometheusAccess;

        let (_dir, app, _) = setup();
        let added = app
            .cluster_add(vec![ClusterInput {
                kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
                ..input("dev")
            }])
            .unwrap()
            .remove(0);
        let tunnels = &app.prometheus_tunnels;
        tunnels.seed(&added.id, &added.prometheus_access);
        // Other edits keep them…
        let mut renamed = added.clone();
        renamed.name = "Renamed".into();
        let renamed = app.cluster_update(renamed).unwrap();
        assert!(tunnels.holds(&added.id));
        // …new access settings or another source drop them at once.
        let mut tenant = renamed.clone();
        tenant.prometheus_access = PrometheusAccess {
            tenant: "team-a".into(),
            ..Default::default()
        };
        let tenant = app.cluster_update(tenant).unwrap();
        assert!(!tunnels.holds(&added.id));
        tunnels.seed(&added.id, &tenant.prometheus_access);
        let mut off = tenant.clone();
        off.prometheus = PrometheusConfig::Off;
        app.cluster_update(off).unwrap();
        assert!(!tunnels.holds(&added.id));
        // Disconnect and removal drop them too.
        tunnels.seed(&added.id, &tenant.prometheus_access);
        app.cluster_disconnect(&added.id);
        assert!(!tunnels.holds(&added.id));
    }

    #[test]
    fn prometheus_access_is_validated_and_shared_sources_stay_disjoint() {
        use crate::prometheus::access::PrometheusAccess;
        use crate::types::PromScheme;

        let (_dir, app, _) = setup();
        let shared = PrometheusConfig::Service {
            namespace: "monitoring".into(),
            service: "thanos-query".into(),
            port: 9090,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        let labelled = |name: &str, value: &str| PrometheusAccess {
            tenant: " team-a ".into(),
            cluster_labels: [(name.to_string(), value.to_string())]
                .into_iter()
                .collect(),
            ..Default::default()
        };
        let add = |context: &str, access: PrometheusAccess| ClusterInput {
            kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
            prometheus: shared.clone(),
            prometheus_access: access,
            ..input(context)
        };

        // A reserved label key is refused before anything is stored.
        assert!(app
            .cluster_add(vec![add("dev", labelled("pod", "x"))])
            .is_err());
        // Two new clusters of one batch that would read each other's data.
        let err = app
            .cluster_add(vec![
                add("dev", labelled("cluster", "dev")),
                add("prod", labelled("region", "eu")),
            ])
            .unwrap_err();
        assert!(format!("{err:#}").contains("overlap"), "{err:#}");
        assert!(app.cluster_list().is_empty());

        let added = app
            .cluster_add(vec![
                add("dev", labelled("cluster", "dev")),
                add("prod", labelled("cluster", "prod")),
            ])
            .unwrap();
        assert_eq!(added[0].prometheus_access.tenant, "team-a", "normalized");
        assert_eq!(
            app.cluster_list()[1].prometheus_access,
            added[1].prometheus_access
        );

        // Against a stored cluster: on add…
        let err = app
            .cluster_add(vec![add("dev", labelled("region", "eu"))])
            .unwrap_err();
        assert!(format!("{err:#}").contains("overlap"), "{err:#}");
        assert_eq!(app.cluster_list().len(), 2);
        // …and on update; a cluster is never compared with itself.
        let mut edited = added[1].clone();
        edited.prometheus_access = labelled("cluster", "dev");
        assert!(app.cluster_update(edited).is_err());
        let mut renamed = added[0].clone();
        renamed.name = "Dev 2".into();
        app.cluster_update(renamed).unwrap();
        let mut reserved = added[0].clone();
        reserved.prometheus_access = labelled("namespace", "x");
        assert!(app.cluster_update(reserved).is_err());
        assert_eq!(
            app.cluster_def(&added[1].id).unwrap().prometheus_access,
            added[1].prometheus_access
        );
    }

    #[test]
    fn a_refused_save_keeps_the_assistant_enabled() {
        use crate::prometheus::access::PrometheusAccess;
        use crate::types::PromScheme;

        let (_dir, app, _) = setup();
        let shared = PrometheusConfig::Service {
            namespace: "monitoring".into(),
            service: "thanos-query".into(),
            port: 9090,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        let labelled = |value: &str| PrometheusAccess {
            cluster_labels: [("cluster".to_string(), value.to_string())]
                .into_iter()
                .collect(),
            ..Default::default()
        };
        let add = |context: &str, value: &str| ClusterInput {
            kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
            prometheus: shared.clone(),
            prometheus_access: labelled(value),
            ..input(context)
        };
        let added = app
            .cluster_add(vec![add("dev", "dev"), add("prod", "prod")])
            .unwrap();
        app.ai_cluster_set(&added[1].id, true, false).unwrap();
        // Becoming production with a source that overlaps the other
        // cluster's: the save is refused, so nothing may change.
        let mut edited = added[1].clone();
        edited.environment = Some(ClusterEnvironment::Production);
        edited.prometheus_access = labelled("dev");
        let err = app.cluster_update(edited).unwrap_err();
        assert!(format!("{err:#}").contains("overlap"), "{err:#}");
        assert_eq!(app.cluster_def(&added[1].id).unwrap().environment, None);
        assert_eq!(app.settings().ai.clusters, vec![added[1].id.clone()]);
    }

    /// Makes `settings.json` unwritable (a directory in its place).
    fn break_settings(app: &Kubepit) -> PathBuf {
        let file = app.paths().settings_file();
        let _ = std::fs::remove_file(&file);
        std::fs::create_dir(&file).unwrap();
        file
    }

    #[test]
    fn a_failed_reconcile_only_fails_the_save_for_an_unacknowledged_production_cluster() {
        let (_dir, app, _) = setup();
        let added = app
            .cluster_add(vec![ClusterInput {
                kubeconfig_text: Some(TWO_CONTEXTS.to_string()),
                environment: Some(ClusterEnvironment::Production),
                ..input("prod")
            }])
            .unwrap()
            .remove(0);
        app.ai_cluster_set(&added.id, true, true).unwrap();

        // Leaving production only drops the acknowledgement: a failure to
        // save that is logged, and the change is saved.
        let file = break_settings(&app);
        let mut staging = added.clone();
        staging.environment = Some(ClusterEnvironment::Staging);
        app.cluster_update(staging).unwrap();
        assert_eq!(
            app.cluster_def(&added.id).unwrap().environment,
            Some(ClusterEnvironment::Staging)
        );
        std::fs::remove_dir(&file).unwrap();

        // A production cluster enabled without an acknowledgement (only
        // reachable through a race) must be turned off: that failure is
        // the command's error.
        let mut production = app.cluster_def(&added.id).unwrap();
        production.environment = Some(ClusterEnvironment::Production);
        app.store
            .update_clusters(|list| {
                list[0] = production.clone();
                Ok(())
            })
            .unwrap();
        app.store
            .update_settings(|s| {
                s.ai.production_acknowledged.clear();
                Ok(())
            })
            .unwrap();
        assert!(app.settings().ai.is_cluster_enabled(&added.id));
        let file = break_settings(&app);
        production.notes = "edited".into();
        let err = format!("{:#}", app.cluster_update(production.clone()).unwrap_err());
        assert!(err.contains("could not be turned off"), "{err}");
        std::fs::remove_dir(&file).unwrap();
        app.cluster_update(production).unwrap();
        assert!(app.settings().ai.clusters.is_empty());
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
