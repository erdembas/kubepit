//! The [`Kubepit`] service: one instance per process, owned by the desktop
//! shell's `AppState`.
//!
//! Domain modules add their operations as `impl Kubepit` blocks next to
//! their helpers (`connection.rs`, `resources.rs`, `watch.rs`, …), so this
//! file only holds the shared state plus the small app-level commands
//! (settings, workspace, app info, shutdown).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::connection::ClientPool;
use crate::error::ReadOnlyError;
use crate::events::EventSink;
use crate::metrics::MetricsGate;
use crate::metrics_history::MetricsHistory;
use crate::node_shell::NodeShells;
use crate::paths::Paths;
use crate::portforward::PortForwards;
use crate::store::Store;
use crate::tasks::TaskRegistry;
use crate::tools;
use crate::types::{AppInfo, ClusterDef, Settings, DEFAULT_DEBUG_IMAGE, DEFAULT_NODE_SHELL_IMAGE};

pub struct Kubepit {
    pub(crate) store: Store,
    pub(crate) sink: Arc<dyn EventSink>,
    pub(crate) pool: ClientPool,
    pub(crate) watches: TaskRegistry,
    pub(crate) log_streams: TaskRegistry,
    pub(crate) forwards: PortForwards,
    pub(crate) node_shells: NodeShells,
    pub(crate) metrics_gate: MetricsGate,
    // Fleet: per-cluster metrics samplers and running fleet-wide searches.
    pub(crate) metrics_history: MetricsHistory,
    pub(crate) fleet_searches: TaskRegistry,
}

impl Kubepit {
    /// Open (or initialise) the data directory at `paths`.
    pub fn open(paths: Paths, sink: Arc<dyn EventSink>) -> Result<Self> {
        let store = Store::open(paths)?;
        Ok(Self {
            store,
            sink,
            pool: ClientPool::default(),
            watches: TaskRegistry::default(),
            log_streams: TaskRegistry::default(),
            forwards: PortForwards::default(),
            node_shells: NodeShells::default(),
            metrics_gate: MetricsGate::default(),
            metrics_history: MetricsHistory::default(),
            fleet_searches: TaskRegistry::default(),
        })
    }

    pub fn paths(&self) -> &Paths {
        self.store.paths()
    }

    /// Registered cluster by id.
    pub fn cluster_def(&self, id: &str) -> Result<ClusterDef> {
        self.store
            .cluster(id)
            .ok_or_else(|| anyhow!("cluster {id} is not registered"))
    }

    /// The cluster, or a [`ReadOnlyError`] if it is marked read-only.
    pub(crate) fn ensure_writable(&self, cluster_id: &str, action: &str) -> Result<ClusterDef> {
        let cluster = self.cluster_def(cluster_id)?;
        if cluster.read_only {
            return Err(ReadOnlyError {
                cluster: cluster.name,
                action: action.to_string(),
            }
            .into());
        }
        Ok(cluster)
    }

    // -- App ----------------------------------------------------------------

    /// `app_info`. `app_version` comes from the desktop crate (the bundle
    /// version users see), not from this library.
    pub async fn app_info(&self, app_version: &str) -> AppInfo {
        let settings = self.settings();
        let (kubectl, helm) = tokio::join!(
            tools::kubectl_info(settings.kubectl_path.as_deref()),
            tools::helm_info(settings.helm_path.as_deref()),
        );
        AppInfo {
            version: app_version.to_string(),
            platform: tools::os_name().to_string(),
            data_dir: self.paths().root().to_string_lossy().to_string(),
            kubectl,
            helm,
        }
    }

    pub fn settings(&self) -> Settings {
        self.store.settings()
    }

    /// `settings_set`: normalises obviously invalid values instead of
    /// persisting them (empty image, zero font size, blank tool paths).
    pub fn set_settings(&self, mut settings: Settings) -> Result<Settings> {
        let blank_to_none =
            |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        settings.kubectl_path = blank_to_none(settings.kubectl_path);
        settings.helm_path = blank_to_none(settings.helm_path);
        settings.shell_path = blank_to_none(settings.shell_path);
        settings.kubeconfig_sync_paths = settings
            .kubeconfig_sync_paths
            .into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        if settings.node_shell_image.trim().is_empty() {
            settings.node_shell_image = DEFAULT_NODE_SHELL_IMAGE.to_string();
        }
        if settings.debug_image.trim().is_empty() {
            settings.debug_image = DEFAULT_DEBUG_IMAGE.to_string();
        }
        if settings.terminal_font_size == 0 {
            settings.terminal_font_size = Settings::default().terminal_font_size;
        }
        self.store.set_settings(settings)
    }

    pub fn workspace_load(&self) -> Result<Option<Value>> {
        self.store.load_workspace()
    }

    pub fn workspace_save(&self, snapshot: &Value) -> Result<()> {
        self.store.save_workspace(snapshot)
    }

    /// Stop background work and delete node-shell helper pods. Called when
    /// the app exits; bounded so a dead cluster cannot block shutdown.
    pub async fn shutdown(&self) {
        self.watches.stop_all();
        self.log_streams.stop_all();
        self.metrics_history.stop_all();
        self.fleet_searches.stop_all();
        self.forwards.stop_all(self.sink.as_ref());
        let cleanup = self.cleanup_all_node_shells();
        if tokio::time::timeout(Duration::from_secs(4), cleanup)
            .await
            .is_err()
        {
            tracing::warn!("timed out deleting node-shell pods during shutdown");
        }
    }
}
