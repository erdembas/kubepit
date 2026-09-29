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

use crate::alerts::AlertCenter;
use crate::change_journal::ChangeJournals;
use crate::connection::ClientPool;
use crate::error::ReadOnlyError;
use crate::events::EventSink;
use crate::history::History;
use crate::loki::LokiCache;
use crate::metrics::MetricsGate;
use crate::metrics_history::MetricsHistory;
use crate::node_shell::NodeShells;
use crate::openapi::OpenApiCache;
use crate::paths::Paths;
use crate::portforward::PortForwards;
use crate::prometheus::tunnel::TunnelCache;
use crate::prometheus::PrometheusCache;
use crate::saved_forwards::SavedForwards;
use crate::secrets::{DisabledSecretStore, SecretStore};
use crate::service_proxy::ProxyClients;
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
    // Local manifests: running "Watch"es of sources (`manifests/watch.rs`).
    pub(crate) manifest_watches: TaskRegistry,
    // Alerts: per-cluster monitors and the notification center's history.
    pub(crate) alerts: AlertCenter,
    // Prometheus: detection result per connection, and the Secret values of
    // authenticated tunnels (at most five minutes).
    pub(crate) prometheus: PrometheusCache,
    pub(crate) prometheus_tunnels: TunnelCache,
    // Service proxy (Prometheus, Loki): retry-free client per connection.
    pub(crate) proxy_clients: ProxyClients,
    // Loki: detection result per connection.
    pub(crate) loki: LokiCache,
    // OpenAPI v3 documents per connection (YAML editing, API explorer).
    pub(crate) openapi: OpenApiCache,
    // Connectivity: OS credential store, saved port forwards, kubeconfig watcher.
    pub(crate) secrets: Arc<dyn SecretStore>,
    pub(crate) saved_forwards: SavedForwards,
    pub(crate) kubeconfig_watch: parking_lot::Mutex<Option<crate::kubeconfig_watch::WatchHandle>>,
    // Change timeline: per-cluster change journals.
    pub(crate) change_journals: ChangeJournals,
    // Persistent history: audit log, persisted events and changes.
    pub(crate) history: History,
    // Power user: custom actions (`actions.json`).
    pub(crate) custom_actions: crate::custom_actions::CustomActionsStore,
    // Cost insight: detection and reports per connection.
    pub(crate) cost: crate::cost::CostState,
    // Recommendations: scan statuses, running scans (`recommendations/scan.rs`).
    pub(crate) recommendations: crate::recommendations::Recommendations,
}

impl Kubepit {
    /// Open (or initialise) the data directory at `paths`. Managed
    /// kubeconfigs can only be kept on disk: the OS credential store is
    /// never reached (see [`Self::open_with_secrets`]).
    pub fn open(paths: Paths, sink: Arc<dyn EventSink>) -> Result<Self> {
        Self::open_with_secrets(paths, sink, Arc::new(DisabledSecretStore))
    }

    /// [`Self::open`] with the credential store used for keychain mode
    /// (the desktop passes the OS keyring, tests an in-memory store).
    pub fn open_with_secrets(
        paths: Paths,
        sink: Arc<dyn EventSink>,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Self> {
        let store = Store::open(paths)?;
        let alerts = AlertCenter::new(store.settings().alerts);
        let saved_forwards = SavedForwards::open(store.paths().port_forwards_file())?;
        let history = History::new(store.paths().history_db());
        let custom_actions =
            crate::custom_actions::CustomActionsStore::open(store.paths().custom_actions_file())?;
        let app = Self {
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
            manifest_watches: TaskRegistry::default(),
            alerts,
            prometheus: PrometheusCache::default(),
            prometheus_tunnels: TunnelCache::default(),
            proxy_clients: ProxyClients::default(),
            loki: LokiCache::default(),
            openapi: OpenApiCache::default(),
            secrets,
            saved_forwards,
            kubeconfig_watch: parking_lot::Mutex::new(None),
            change_journals: ChangeJournals::default(),
            history,
            custom_actions,
            cost: crate::cost::CostState::default(),
            recommendations: crate::recommendations::Recommendations::default(),
        };
        // Left behind by a crash while in keychain mode.
        app.remove_transient_run_kubeconfigs();
        Ok(app)
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
        settings.alerts = settings.alerts.normalized();
        // Only `kubeconfig_storage_set` flips this, because it migrates.
        settings.keychain_kubeconfigs = self.settings().keychain_kubeconfigs;
        settings.change_journal_disabled.sort();
        settings.change_journal_disabled.dedup();
        settings.history = settings.history.normalized();
        settings.recommendations = settings.recommendations.normalized();
        let saved = self.store.set_settings(settings)?;
        self.apply_alert_settings(&saved.alerts);
        self.sync_change_journals();
        self.sync_history();
        self.sync_recommendation_scans();
        Ok(saved)
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
        self.stop_kubeconfig_watch();
        self.remove_transient_run_kubeconfigs();
        self.watches.stop_all();
        self.log_streams.stop_all();
        self.metrics_history.stop_all();
        self.fleet_searches.stop_all();
        self.manifest_watches.stop_all();
        self.alerts.stop_all();
        self.change_journals.stop_all();
        self.stop_all_recommendation_scans();
        self.history.shutdown();
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
