//! Cluster connections: one `kube::Client` per connected cluster.
//!
//! Connecting builds a client from the cluster's kubeconfig + context,
//! proves it works with `GET /version` (bounded by a timeout, because exec
//! credential plugins and unreachable VPN endpoints otherwise hang for
//! minutes), and records version/platform for the status badge.
//!
//! Every status change is pushed through [`EventSink::cluster_status`].
//! Other commands call [`Kubepit::client`], which auto-connects, so the UI
//! never has to sequence "connect, then list".
//!
//! Races: connects for the same cluster are serialised by a per-cluster
//! async mutex, and each slot carries an `epoch` bumped by disconnect, so a
//! slow connect that finishes after the user clicked "disconnect" is
//! discarded instead of resurrecting the connection.
//!
//! [`EventSink::cluster_status`]: crate::events::EventSink::cluster_status

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use kube::config::KubeConfigOptions;
use kube::Client;
use parking_lot::{Mutex, RwLock};

use crate::app::Kubepit;
use crate::error::kube_error;
use crate::kubeconfig;
use crate::objects::now_millis;
use crate::platform::{detect_platform, PlatformHints};
use crate::types::{ApiResourceInfo, ClusterDef, ClusterStatus, ConnState};

/// Upper bound for the `/version` probe (includes exec-plugin token fetch).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound for the OpenShift API-group probe; purely cosmetic.
const PLATFORM_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct Slot {
    client: Option<Client>,
    status: ClusterStatus,
    resources: Option<Arc<Vec<ApiResourceInfo>>>,
    epoch: u64,
    /// Finished connect attempts; lets queued auto-connects reuse a result
    /// that arrived while they waited instead of retrying immediately.
    attempts: u64,
}

impl Slot {
    fn new(id: &str) -> Self {
        Self {
            client: None,
            status: ClusterStatus::disconnected(id),
            resources: None,
            epoch: 0,
            attempts: 0,
        }
    }
}

/// Connection state for every cluster that has ever been touched.
#[derive(Default)]
pub struct ClientPool {
    slots: RwLock<HashMap<String, Slot>>,
    connect_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ClientPool {
    fn connect_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.connect_locks
            .lock()
            .entry(id.to_string())
            .or_default()
            .clone()
    }

    fn connected(&self, id: &str) -> Option<(Client, ClusterStatus)> {
        let slots = self.slots.read();
        let slot = slots.get(id)?;
        match (&slot.client, slot.status.state) {
            (Some(client), ConnState::Connected) => Some((client.clone(), slot.status.clone())),
            _ => None,
        }
    }

    fn attempts(&self, id: &str) -> u64 {
        self.slots.read().get(id).map(|s| s.attempts).unwrap_or(0)
    }

    fn finish_attempt(&self, id: &str) {
        if let Some(slot) = self.slots.write().get_mut(id) {
            slot.attempts += 1;
        }
    }

    fn epoch(&self, id: &str) -> u64 {
        self.slots.read().get(id).map(|s| s.epoch).unwrap_or(0)
    }

    /// Record a status (without a client) if `epoch` is still current.
    fn set_status(&self, status: ClusterStatus, epoch: u64) -> bool {
        let mut slots = self.slots.write();
        let slot = slots
            .entry(status.id.clone())
            .or_insert_with(|| Slot::new(&status.id));
        if slot.epoch != epoch {
            return false;
        }
        slot.client = None;
        slot.resources = None;
        slot.status = status;
        true
    }

    /// Install a freshly connected client if `epoch` is still current.
    fn commit(&self, client: Client, status: ClusterStatus, epoch: u64) -> bool {
        let mut slots = self.slots.write();
        let slot = slots
            .entry(status.id.clone())
            .or_insert_with(|| Slot::new(&status.id));
        if slot.epoch != epoch {
            return false;
        }
        slot.client = Some(client);
        slot.resources = None;
        slot.status = status;
        true
    }

    /// Drop the client and invalidate in-flight connects.
    fn disconnect(&self, id: &str) -> ClusterStatus {
        let mut slots = self.slots.write();
        let slot = slots.entry(id.to_string()).or_insert_with(|| Slot::new(id));
        slot.epoch += 1;
        slot.client = None;
        slot.resources = None;
        slot.status = ClusterStatus::disconnected(id);
        slot.status.clone()
    }

    fn forget(&self, id: &str) {
        let mut slots = self.slots.write();
        if let Some(slot) = slots.get_mut(id) {
            slot.epoch += 1;
        }
        slots.remove(id);
        self.connect_locks.lock().remove(id);
    }

    fn status(&self, id: &str) -> Option<ClusterStatus> {
        self.slots.read().get(id).map(|s| s.status.clone())
    }

    pub(crate) fn resources(&self, id: &str) -> Option<Arc<Vec<ApiResourceInfo>>> {
        self.slots.read().get(id).and_then(|s| s.resources.clone())
    }

    pub(crate) fn set_resources(&self, id: &str, resources: Arc<Vec<ApiResourceInfo>>) {
        if let Some(slot) = self.slots.write().get_mut(id) {
            if slot.client.is_some() {
                slot.resources = Some(resources);
            }
        }
    }

    /// The client of a connected cluster, without ever connecting (fleet
    /// search must not wake clusters the user left disconnected).
    pub(crate) fn connected_client(&self, id: &str) -> Option<Client> {
        self.connected(id).map(|(client, _)| client)
    }
}

/// What a successful connect learned about the cluster.
struct Established {
    client: Client,
    version: String,
    platform: Option<String>,
    server: String,
}

impl Kubepit {
    /// `cluster_connect`. Returns the resulting status; a failed connect is
    /// reported as `state: "error"` (and emitted) rather than as an `Err`,
    /// so the UI has a single code path for both outcomes.
    pub async fn cluster_connect(&self, id: &str) -> Result<ClusterStatus> {
        let cluster = self.cluster_def(id)?;
        let lock = self.pool.connect_lock(id);
        let attempts_before = self.pool.attempts(id);
        let _serialised = lock.lock().await;
        if let Some((_, status)) = self.pool.connected(id) {
            return Ok(status);
        }
        if self.pool.attempts(id) != attempts_before {
            // Another connect finished (and failed) while we waited: report
            // it instead of stacking another 15 s timeout behind it.
            return Ok(self.cluster_status(id));
        }

        let epoch = self.pool.epoch(id);
        // User file, managed file or OS credential store, proxy applied.
        let prepared = self.cluster_kubeconfig_async(&cluster).await;
        let server_hint = prepared
            .as_ref()
            .ok()
            .and_then(|kc| kubeconfig::server_for_context(kc, &cluster.context));
        let connecting = ClusterStatus {
            id: id.to_string(),
            state: ConnState::Connecting,
            error: None,
            version: None,
            platform: None,
            server: server_hint.clone(),
            connected_at: None,
        };
        if self.pool.set_status(connecting.clone(), epoch) {
            self.sink.cluster_status(&connecting);
        }

        // A fresh connection re-checks optional APIs such as metrics-server.
        self.metrics_gate.forget(id);
        let outcome = match prepared {
            Ok(single) => self.establish(&cluster, single).await,
            Err(e) => Err(e),
        };
        self.pool.finish_attempt(id);
        match outcome {
            Ok(est) => {
                let now = now_millis();
                let status = ClusterStatus {
                    id: id.to_string(),
                    state: ConnState::Connected,
                    error: None,
                    version: Some(est.version),
                    platform: est.platform,
                    server: Some(est.server).filter(|s| !s.is_empty()),
                    connected_at: Some(now),
                };
                let sampler_client = est.client.clone();
                let journal_client = est.client.clone();
                let history_client = est.client.clone();
                if !self.pool.commit(est.client, status.clone(), epoch) {
                    // Disconnected (or removed) while we were connecting.
                    return Ok(self
                        .pool
                        .status(id)
                        .unwrap_or_else(|| ClusterStatus::disconnected(id)));
                }
                self.sink.cluster_status(&status);
                self.touch_last_connected(id, now);
                self.start_alert_monitor(id, sampler_client.clone());
                self.autostart_saved_forwards(id, sampler_client.clone());
                self.start_metrics_sampler(id, sampler_client);
                self.start_change_journal(id, journal_client);
                self.start_history_persistence(id, history_client);
                self.start_recommendation_scans(id);
                tracing::info!(cluster = %cluster.name, "connected");
                Ok(status)
            }
            Err(err) => {
                let message = format!("{err:#}");
                // The message may quote kubeconfig fragments: keep it out
                // of default-level logs.
                tracing::warn!(cluster = %cluster.name, "connect failed");
                tracing::debug!(cluster = %cluster.name, "connect error: {message}");
                let status = ClusterStatus {
                    id: id.to_string(),
                    state: ConnState::Error,
                    error: Some(message),
                    version: None,
                    platform: None,
                    server: server_hint,
                    connected_at: None,
                };
                if self.pool.set_status(status.clone(), epoch) {
                    self.sink.cluster_status(&status);
                }
                Ok(status)
            }
        }
    }

    async fn establish(
        &self,
        cluster: &ClusterDef,
        single: kube::config::Kubeconfig,
    ) -> Result<Established> {
        // Keep the external-tools kubeconfig in sync with what we connect with.
        if let Err(e) = self.write_run_kubeconfig_from(cluster, &single) {
            tracing::warn!(cluster = %cluster.name, "could not write run kubeconfig: {e:#}");
        }
        let server = kubeconfig::server_for_context(&single, &cluster.context).unwrap_or_default();
        let options = KubeConfigOptions {
            context: Some(cluster.context.clone()),
            ..Default::default()
        };
        let config = kube::Config::from_custom_kubeconfig(single, &options)
            .await
            .map_err(|e| {
                anyhow!(
                    "invalid kubeconfig for context \"{}\": {e}",
                    cluster.context
                )
            })?;
        let client = Client::try_from(config).map_err(kube_error)?;

        let info = tokio::time::timeout(CONNECT_TIMEOUT, client.apiserver_version())
            .await
            .map_err(|_| {
                anyhow!(
                    "timed out after {}s waiting for the API server{}",
                    CONNECT_TIMEOUT.as_secs(),
                    if server.is_empty() {
                        String::new()
                    } else {
                        format!(" at {server}")
                    }
                )
            })?
            .map_err(kube_error)?;

        let has_openshift = tokio::time::timeout(PLATFORM_PROBE_TIMEOUT, client.list_api_groups())
            .await
            .ok()
            .and_then(Result::ok)
            .map(|groups| {
                groups
                    .groups
                    .iter()
                    .any(|g| g.name == "config.openshift.io")
            })
            .unwrap_or(false);
        let platform = detect_platform(&PlatformHints {
            git_version: &info.git_version,
            server: &server,
            context: &cluster.context,
            has_openshift,
        });
        Ok(Established {
            client,
            version: info.git_version,
            platform,
            server,
        })
    }

    fn touch_last_connected(&self, id: &str, now: i64) {
        let result = self.store.update_clusters(|list| {
            if let Some(c) = list.iter_mut().find(|c| c.id == id) {
                c.last_connected_at = Some(now);
            }
            Ok(())
        });
        match result {
            Ok(((), list)) => self.sink.cluster_list(&list),
            Err(e) => tracing::warn!("failed to record last_connected_at: {e:#}"),
        }
    }

    /// `cluster_disconnect`: drop the client and stop everything that used it
    /// (watches, log streams, port forwards).
    pub fn cluster_disconnect(&self, id: &str) {
        self.stop_cluster_work(id);
        let status = self.pool.disconnect(id);
        // Keychain mode: the run kubeconfig only lives while connected.
        if let Some(cluster) = self.store.cluster(id) {
            if self.run_kubeconfig_is_transient(&cluster) {
                self.remove_run_kubeconfig(id);
            }
        }
        self.sink.cluster_status(&status);
    }

    /// Forget a removed cluster entirely.
    pub(crate) fn forget_connection(&self, id: &str) {
        self.stop_cluster_work(id);
        self.forget_alerts(id);
        self.history.forget_cluster(id);
        self.pool.forget(id);
    }

    pub(crate) fn stop_cluster_work(&self, id: &str) {
        self.ai_stop_cluster(id);
        self.watches.stop_cluster(id);
        self.log_streams.stop_cluster(id);
        self.metrics_history.stop_cluster(id);
        self.stop_alert_monitor(id);
        self.prometheus.forget(id);
        self.prometheus_tunnels.forget(id);
        self.loki.forget(id);
        self.proxy_clients.forget(id);
        self.cost.forget(id);
        self.change_journals.stop_cluster(id);
        self.history.stop_cluster(id);
        self.stop_recommendation_scans(id);
        self.forwards.stop_cluster(id, self.sink.as_ref());
        self.openapi.forget(id);
    }

    /// `cluster_statuses`: one entry per registered cluster.
    pub fn cluster_statuses(&self) -> HashMap<String, ClusterStatus> {
        self.store
            .clusters()
            .into_iter()
            .map(|c| {
                let status = self
                    .pool
                    .status(&c.id)
                    .unwrap_or_else(|| ClusterStatus::disconnected(&c.id));
                (c.id, status)
            })
            .collect()
    }

    /// Current status of one cluster.
    pub fn cluster_status(&self, id: &str) -> ClusterStatus {
        self.pool
            .status(id)
            .unwrap_or_else(|| ClusterStatus::disconnected(id))
    }

    /// A connected client for `id`, connecting on demand.
    pub async fn client(&self, id: &str) -> Result<Client> {
        if let Some((client, _)) = self.pool.connected(id) {
            return Ok(client);
        }
        let cluster = self.cluster_def(id)?;
        let status = self.cluster_connect(id).await?;
        match self.pool.connected(id) {
            Some((client, _)) => Ok(client),
            None => Err(anyhow!(
                "cluster \"{}\" is not connected{}",
                cluster.name,
                status.error.map(|e| format!(": {e}")).unwrap_or_default()
            )),
        }
    }
}
