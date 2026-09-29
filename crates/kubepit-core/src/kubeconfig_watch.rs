//! Kubeconfig file watching.
//!
//! Watches the files discovery reads (`$KUBECONFIG` entries, `~/.kube/config`
//! and the other files directly in `~/.kube`, `settings.kubeconfig_sync_paths`)
//! plus the file of every registered cluster, with `notify`. Directories are
//! watched rather than files, because editors and `kubectl` replace files by
//! renaming, which silently ends a file watch.
//!
//! Events are debounced (~500 ms of quiet). Then:
//!
//! 1. discovery runs again and contexts that appeared in the changed files,
//!    and are not registered, are reported as new;
//! 2. the `run/<id>.kubeconfig` of every cluster sourced from a changed file
//!    is regenerated (rotated tokens and certificates reach kubectl, helm and
//!    terminals); connected clusters whose kubeconfig changed are reported
//!    so the UI can suggest a reconnect;
//! 3. `kubeconfig://changed` is emitted when there is something to report.
//!
//! User files are only ever read. The watch set is re-evaluated every few
//! seconds, so new sync paths and newly registered clusters are picked up
//! without restarting. Discovery roots are injectable ([`DiscoveryRoots`])
//! so tests only ever watch temp dirs.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::app::Kubepit;
use crate::kubeconfig;
use crate::paths::{atomic_write, expand_tilde};
use crate::types::{ClusterDef, KubeconfigChanged, KubeconfigNewContext};

/// Quiet time after the last event before a batch is processed.
pub const DEBOUNCE: Duration = Duration::from_millis(500);
/// How often the watch set is re-evaluated.
const REARM_EVERY: Duration = Duration::from_secs(3);

/// Where discovery looks: the home directory and `$KUBECONFIG`.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryRoots {
    pub home: Option<PathBuf>,
    pub kubeconfig_env: Option<OsString>,
}

impl DiscoveryRoots {
    /// The real home directory and `$KUBECONFIG` (may probe the login shell).
    pub fn system() -> Self {
        Self {
            home: dirs::home_dir(),
            kubeconfig_env: kubeconfig::kubeconfig_env(),
        }
    }
}

/// Canonical form used for both watch targets and event paths. Files that
/// no longer exist keep their canonical parent.
fn norm(path: &Path) -> PathBuf {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent)
            .map(|p| p.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

/// What to watch, derived from settings, the registry and the roots.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Targets {
    /// Directories whose direct, non-hidden files are kubeconfig candidates.
    scan_dirs: HashSet<PathBuf>,
    /// Individual kubeconfig files.
    files: HashSet<PathBuf>,
}

impl Targets {
    pub(crate) fn compute(
        roots: &DiscoveryRoots,
        sync_paths: &[String],
        clusters: &[ClusterDef],
    ) -> Self {
        let mut targets = Targets::default();
        if let Some(env) = &roots.kubeconfig_env {
            for entry in std::env::split_paths(env) {
                if !entry.as_os_str().is_empty() {
                    targets.files.insert(norm(&entry));
                }
            }
        }
        if let Some(home) = &roots.home {
            let kube = home.join(".kube");
            targets.files.insert(norm(&kube.join("config")));
            if kube.is_dir() {
                targets.scan_dirs.insert(norm(&kube));
            }
        }
        for raw in sync_paths {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let path = expand_tilde(trimmed);
            if path.is_dir() {
                targets.scan_dirs.insert(norm(&path));
            } else {
                targets.files.insert(norm(&path));
            }
        }
        for cluster in clusters.iter().filter(|c| !c.managed) {
            targets
                .files
                .insert(norm(Path::new(&cluster.kubeconfig_path)));
        }
        targets
    }

    /// Existing directories to hand to the OS watcher.
    fn dirs(&self) -> HashSet<PathBuf> {
        let parents = self
            .files
            .iter()
            .filter_map(|f| f.parent().map(Path::to_path_buf));
        self.scan_dirs
            .iter()
            .cloned()
            .chain(parents)
            .filter(|d| d.is_dir())
            .collect()
    }

    /// Whether a changed path can affect discovery or a registered cluster.
    pub(crate) fn is_relevant(&self, path: &Path) -> bool {
        let path = norm(path);
        if self.files.contains(&path) {
            return true;
        }
        !is_hidden(&path)
            && path
                .parent()
                .is_some_and(|parent| self.scan_dirs.contains(parent))
    }
}

/// Contexts (with their servers) per canonical kubeconfig path.
pub(crate) type Snapshot = HashMap<PathBuf, BTreeMap<String, Option<String>>>;

fn snapshot(roots: &DiscoveryRoots, sync_paths: &[String], extra: &[PathBuf]) -> Snapshot {
    let mut out: Snapshot = HashMap::new();
    let mut add = |source: crate::types::KubeconfigSource| {
        if source.error.is_some() {
            return;
        }
        let contexts = source
            .contexts
            .into_iter()
            .map(|c| (c.name, c.server))
            .collect();
        out.insert(norm(Path::new(&source.path)), contexts);
    };
    for source in kubeconfig::discover_with(
        roots.home.as_deref(),
        roots.kubeconfig_env.clone(),
        sync_paths,
    ) {
        add(source);
    }
    for path in extra {
        if path.is_file() {
            add(kubeconfig::parse_file(path));
        }
    }
    out
}

/// Contexts of the changed files that were not there before and are not
/// registered yet, ordered by path then context.
pub(crate) fn new_contexts(
    changed: &[PathBuf],
    before: &Snapshot,
    after: &Snapshot,
    clusters: &[ClusterDef],
) -> Vec<KubeconfigNewContext> {
    let registered: HashSet<(PathBuf, &str)> = clusters
        .iter()
        // Imported copies still count as registered at their original path.
        // This is discovery identity only: managed copies never follow changes
        // to that file, and pasted configs have no source-file identity.
        .filter(|c| !c.managed || c.source_kubeconfig_path.is_some())
        .map(|c| {
            let source = c
                .source_kubeconfig_path
                .as_deref()
                .unwrap_or(&c.kubeconfig_path);
            (norm(Path::new(source)), c.context.as_str())
        })
        .collect();
    let mut out = Vec::new();
    let mut paths = changed.to_vec();
    paths.sort();
    paths.dedup();
    for path in paths {
        let Some(now) = after.get(&path) else {
            continue;
        };
        let known = before.get(&path);
        for (context, server) in now {
            let seen = known.is_some_and(|k| k.contains_key(context));
            if seen || registered.contains(&(path.clone(), context.as_str())) {
                continue;
            }
            out.push(KubeconfigNewContext {
                path: path.to_string_lossy().to_string(),
                context: context.clone(),
                server: server.clone(),
            });
        }
    }
    out
}

impl Kubepit {
    /// Regenerate the run kubeconfig of every user cluster sourced from one
    /// of `changed`; returns the connected ones whose kubeconfig changed.
    pub(crate) fn refresh_changed_clusters(&self, changed: &HashSet<PathBuf>) -> Vec<String> {
        let mut reconnect = Vec::new();
        for cluster in self.cluster_list() {
            if cluster.managed || !changed.contains(&norm(Path::new(&cluster.kubeconfig_path))) {
                continue;
            }
            let single = match self.cluster_kubeconfig(&cluster) {
                Ok(single) => single,
                Err(e) => {
                    tracing::warn!(cluster = %cluster.name, "kubeconfig changed but is unusable: {e:#}");
                    continue;
                }
            };
            let (Ok(path), Ok(yaml)) = (
                self.paths().run_kubeconfig(&cluster.id),
                kubeconfig::to_yaml(&single),
            ) else {
                continue;
            };
            let before = std::fs::read_to_string(&path).ok();
            if before.as_deref() == Some(yaml.as_str()) {
                continue;
            }
            if let Err(e) = atomic_write(&path, yaml.as_bytes(), true) {
                tracing::warn!(cluster = %cluster.name, "could not write run kubeconfig: {e:#}");
                continue;
            }
            if self.pool.connected_client(&cluster.id).is_some() {
                reconnect.push(cluster.id.clone());
            }
        }
        reconnect
    }

    /// Start watching kubeconfig files (desktop app). Idempotent.
    pub fn start_kubeconfig_watch(self: &Arc<Self>) {
        self.start_kubeconfig_watch_with(DiscoveryRoots::system);
    }

    /// [`Self::start_kubeconfig_watch`] with injectable roots (tests use temp
    /// dirs). `roots` runs on the watcher thread.
    pub fn start_kubeconfig_watch_with(
        self: &Arc<Self>,
        roots: impl FnOnce() -> DiscoveryRoots + Send + 'static,
    ) {
        let mut slot = self.kubeconfig_watch.lock();
        if slot.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel::<Option<notify::Result<notify::Event>>>();
        let weak = Arc::downgrade(self);
        let events = tx.clone();
        let spawned = std::thread::Builder::new()
            .name("kubeconfig-watch".into())
            .spawn(move || watch_loop(weak, roots(), events, rx));
        match spawned {
            Ok(thread) => *slot = Some(WatchHandle { tx, thread }),
            Err(e) => tracing::warn!("could not start the kubeconfig watcher: {e}"),
        }
    }

    /// Stop the watcher thread (app exit).
    pub fn stop_kubeconfig_watch(&self) {
        let handle = self.kubeconfig_watch.lock().take();
        if let Some(handle) = handle {
            let _ = handle.tx.send(None);
            let _ = handle.thread.join();
        }
    }
}

/// The running watcher; `None` on the channel stops it.
pub struct WatchHandle {
    tx: mpsc::Sender<Option<notify::Result<notify::Event>>>,
    thread: std::thread::JoinHandle<()>,
}

struct WatchState {
    roots: DiscoveryRoots,
    targets: Targets,
    watched: HashSet<PathBuf>,
    baseline: Snapshot,
}

impl WatchState {
    fn cluster_files(clusters: &[ClusterDef]) -> Vec<PathBuf> {
        clusters
            .iter()
            .filter(|c| !c.managed)
            .map(|c| norm(Path::new(&c.kubeconfig_path)))
            .collect()
    }

    /// Recompute targets and (un)watch directories; returns whether the
    /// target set changed.
    fn rearm(&mut self, app: &Kubepit, watcher: &mut RecommendedWatcher) -> bool {
        let settings = app.settings();
        let clusters = app.cluster_list();
        let targets = Targets::compute(&self.roots, &settings.kubeconfig_sync_paths, &clusters);
        if targets == self.targets && !self.watched.is_empty() {
            return false;
        }
        let dirs = targets.dirs();
        for gone in self.watched.difference(&dirs) {
            let _ = watcher.unwatch(gone);
        }
        let mut watched = HashSet::new();
        for dir in &dirs {
            if self.watched.contains(dir) {
                watched.insert(dir.clone());
                continue;
            }
            match watcher.watch(dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    watched.insert(dir.clone());
                }
                Err(e) => tracing::debug!("cannot watch {}: {e}", dir.display()),
            }
        }
        let changed = targets != self.targets;
        self.targets = targets;
        self.watched = watched;
        if changed {
            self.baseline = snapshot(
                &self.roots,
                &settings.kubeconfig_sync_paths,
                &Self::cluster_files(&clusters),
            );
        }
        changed
    }

    fn process(&mut self, app: &Kubepit, changed: HashSet<PathBuf>) -> KubeconfigChanged {
        let settings = app.settings();
        let clusters = app.cluster_list();
        let mut extra = Self::cluster_files(&clusters);
        extra.extend(changed.iter().cloned());
        let after = snapshot(&self.roots, &settings.kubeconfig_sync_paths, &extra);
        let changed_list: Vec<PathBuf> = changed.iter().cloned().collect();
        let new_contexts = new_contexts(&changed_list, &self.baseline, &after, &clusters);
        self.baseline = after;
        let reconnect = app.refresh_changed_clusters(&changed);
        let mut paths: Vec<String> = changed_list
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        paths.sort();
        KubeconfigChanged {
            paths,
            new_contexts,
            reconnect,
        }
    }
}

fn watch_loop(
    app: Weak<Kubepit>,
    roots: DiscoveryRoots,
    events: mpsc::Sender<Option<notify::Result<notify::Event>>>,
    rx: mpsc::Receiver<Option<notify::Result<notify::Event>>>,
) {
    let mut watcher = match notify::recommended_watcher(move |event| {
        let _ = events.send(Some(event));
    }) {
        Ok(watcher) => watcher,
        Err(e) => {
            tracing::warn!("kubeconfig watching is unavailable: {e}");
            return;
        }
    };
    let mut state = WatchState {
        roots,
        targets: Targets::default(),
        watched: HashSet::new(),
        baseline: Snapshot::new(),
    };
    {
        let Some(app) = app.upgrade() else {
            return;
        };
        state.rearm(&app, &mut watcher);
    }
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut deadline: Option<Instant> = None;
    let mut next_rearm = Instant::now() + REARM_EVERY;
    loop {
        let now = Instant::now();
        let wake = deadline.map_or(next_rearm, |d| d.min(next_rearm));
        match rx.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(Some(Ok(event))) => {
                for path in event.paths {
                    if state.targets.is_relevant(&path) {
                        pending.insert(norm(&path));
                        deadline = Some(Instant::now() + DEBOUNCE);
                    }
                }
            }
            Ok(Some(Err(e))) => tracing::debug!("kubeconfig watch error: {e}"),
            Ok(None) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        let due = deadline.is_some_and(|d| now >= d);
        if !due && now < next_rearm {
            continue;
        }
        let Some(app) = app.upgrade() else {
            return;
        };
        if due {
            deadline = None;
            let change = state.process(&app, std::mem::take(&mut pending));
            if !change.new_contexts.is_empty() || !change.reconnect.is_empty() {
                app.sink.kubeconfig_changed(&change);
            }
        }
        if now >= next_rearm {
            state.rearm(&app, &mut watcher);
            next_rearm = Instant::now() + REARM_EVERY;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kubeconfig::tests::TWO_CONTEXTS;

    fn cluster(path: &Path, context: &str, managed: bool) -> ClusterDef {
        ClusterDef {
            id: format!("id-{context}"),
            name: context.into(),
            context: context.into(),
            kubeconfig_path: path.to_string_lossy().to_string(),
            source_kubeconfig_path: None,
            managed,
            tags: vec![],
            environment: None,
            color: None,
            default_namespace: None,
            accessible_namespaces: vec![],
            read_only: false,
            notes: String::new(),
            created_at: 0,
            last_connected_at: None,
            cost: Default::default(),
            prometheus: Default::default(),
            prometheus_access: Default::default(),
            loki: Default::default(),
            proxy_url: None,
        }
    }

    #[test]
    fn targets_cover_discovery_and_registered_files() {
        let home = tempfile::tempdir().unwrap();
        let kube = home.path().join(".kube");
        std::fs::create_dir_all(&kube).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let env_file = elsewhere.path().join("env.yaml");
        let sync_dir = elsewhere.path().join("sync");
        std::fs::create_dir_all(&sync_dir).unwrap();
        let picked = elsewhere.path().join("picked.yaml");
        std::fs::write(&picked, TWO_CONTEXTS).unwrap();
        let roots = DiscoveryRoots {
            home: Some(home.path().to_path_buf()),
            kubeconfig_env: Some(std::env::join_paths([&env_file]).unwrap()),
        };
        let targets = Targets::compute(
            &roots,
            &[sync_dir.to_string_lossy().to_string(), " ".into()],
            &[
                cluster(&picked, "dev", false),
                cluster(Path::new("/managed/x.yaml"), "m", true),
            ],
        );
        assert!(targets.is_relevant(&kube.join("config")));
        assert!(targets.is_relevant(&kube.join("staging.yaml")));
        assert!(!targets.is_relevant(&kube.join(".config.swp")));
        assert!(!targets.is_relevant(&kube.join("cache/discovery/x.json")));
        assert!(targets.is_relevant(&env_file));
        assert!(!targets.is_relevant(&elsewhere.path().join("other.yaml")));
        assert!(targets.is_relevant(&sync_dir.join("team.yaml")));
        assert!(targets.is_relevant(&picked));
        assert!(!targets.is_relevant(Path::new("/managed/x.yaml")));
        let dirs = targets.dirs();
        assert!(dirs.contains(&norm(&kube)));
        assert!(dirs.contains(&norm(&sync_dir)));
        assert!(dirs.contains(&norm(elsewhere.path())));
    }

    #[test]
    fn only_unseen_unregistered_contexts_of_changed_files_are_new() {
        let file = PathBuf::from("/k/config");
        let other = PathBuf::from("/k/other.yaml");
        let ctx = |names: &[&str]| -> BTreeMap<String, Option<String>> {
            names
                .iter()
                .map(|n| (n.to_string(), Some(format!("https://{n}"))))
                .collect()
        };
        let before: Snapshot = [(file.clone(), ctx(&["dev"])), (other.clone(), ctx(&["a"]))].into();
        let after: Snapshot = [
            (file.clone(), ctx(&["dev", "stg", "prod"])),
            (other.clone(), ctx(&["a", "b"])),
            (PathBuf::from("/k/new.yaml"), ctx(&["n1"])),
        ]
        .into();
        let registered = [cluster(&file, "prod", false)];
        let found = new_contexts(
            &[file.clone(), PathBuf::from("/k/new.yaml")],
            &before,
            &after,
            &registered,
        );
        let names: Vec<(&str, &str)> = found
            .iter()
            .map(|c| (c.path.as_str(), c.context.as_str()))
            .collect();
        // `other.yaml` did not change; `prod` is registered.
        assert_eq!(names, vec![("/k/config", "stg"), ("/k/new.yaml", "n1")]);
        assert_eq!(found[0].server.as_deref(), Some("https://stg"));
    }

    #[test]
    fn imported_source_identity_suppresses_duplicates_without_watching_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("source.yaml");
        let other = dir.path().join("other.yaml");
        std::fs::write(&file, TWO_CONTEXTS).unwrap();
        std::fs::write(&other, TWO_CONTEXTS).unwrap();
        let file = norm(&file);
        let other = norm(&other);
        let managed = dir.path().join("managed.yaml");
        let mut imported = cluster(&managed, "copied", true);
        imported.source_kubeconfig_path = Some(file.to_string_lossy().to_string());
        let registered = [
            imported.clone(),
            cluster(&file, "legacy", false),
            // Pasted configs never claim a discovery source, even if their
            // stored path happens to match a source being scanned.
            cluster(&file, "pasted", true),
        ];
        let after: Snapshot = [
            (
                file.clone(),
                ["copied", "legacy", "pasted", "fresh"]
                    .into_iter()
                    .map(|name| (name.to_string(), None))
                    .collect(),
            ),
            (other.clone(), [("copied".to_string(), None)].into()),
        ]
        .into();
        let found = new_contexts(
            &[file.clone(), other.clone()],
            &Snapshot::new(),
            &after,
            &registered,
        );
        let actual: HashSet<(&str, &str)> = found
            .iter()
            .map(|c| (c.path.as_str(), c.context.as_str()))
            .collect();
        assert_eq!(
            actual,
            [
                (file.to_str().unwrap(), "fresh"),
                (file.to_str().unwrap(), "pasted"),
                (other.to_str().unwrap(), "copied"),
            ]
            .into()
        );

        let targets = Targets::compute(&DiscoveryRoots::default(), &[], &[imported]);
        assert!(!targets.is_relevant(&file));
        assert!(!targets.is_relevant(&managed));
    }
}
