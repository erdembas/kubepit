//! Port forwarding to pods and services.
//!
//! A forward binds `127.0.0.1:<local_port>` (0 = any free port). Every
//! accepted TCP connection opens its own `pods/portforward` WebSocket and is
//! copied bidirectionally. For services, the target pod is re-resolved per
//! connection (selector → a Running + Ready pod, service port → targetPort,
//! named ports looked up on the pod), so rolling restarts are survived
//! without restarting the forward.
//!
//! State changes (`active` ⇄ `error`, stop) emit the full list on
//! `portforward://changed`. Forwards of a cluster are stopped when it
//! disconnects or is removed.
//!
//! Connectivity: a forward may belong to a saved definition
//! (`saved_forwards.rs`, `saved_id`). Saved forwards that fail to start on
//! connect stay in the list in the `error` state without a listener, and
//! `port_forward_restart` re-binds any forward with its target and local
//! port (a pod forward whose pod was replaced by one of the same name, or a
//! service whose pods came back). Busy local ports are reported up front
//! with a free alternative.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::Client;
use parking_lot::Mutex;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::app::Kubepit;
use crate::error::kube_error;
use crate::events::EventSink;
use crate::objects::now_millis;
use crate::types::{
    LocalPortStatus, PortForward, PortForwardKind, PortForwardRequest, PortForwardState,
};

struct Entry {
    info: PortForward,
    cancel: CancellationToken,
    /// The accept loop; `None` for a forward that failed to start.
    task: Option<JoinHandle<()>>,
}

/// Registry of live forwards. Cheap to clone (shared state) so connection
/// tasks can report their own errors.
#[derive(Clone, Default)]
pub struct PortForwards {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    /// Bumped whenever a cluster's forwards are stopped, so a background
    /// start that raced with a disconnect does not resurrect a forward.
    generations: Arc<Mutex<HashMap<String, u64>>>,
}

impl PortForwards {
    pub fn list(&self) -> Vec<PortForward> {
        let mut list: Vec<PortForward> = self
            .entries
            .lock()
            .values()
            .map(|e| e.info.clone())
            .collect();
        list.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        list
    }

    pub(crate) fn emit(&self, sink: &dyn EventSink) {
        sink.port_forwards(&self.list());
    }

    pub(crate) fn get(&self, id: &str) -> Option<PortForward> {
        self.entries.lock().get(id).map(|e| e.info.clone())
    }

    /// The live forward started from (or saved as) `saved_id`.
    pub(crate) fn by_saved(&self, saved_id: &str) -> Option<PortForward> {
        self.entries
            .lock()
            .values()
            .find(|e| e.info.saved_id.as_deref() == Some(saved_id))
            .map(|e| e.info.clone())
    }

    /// Set `saved_id` on every forward `matches` accepts. Returns whether
    /// anything changed.
    pub(crate) fn relink(
        &self,
        matches: impl Fn(&PortForward) -> bool,
        saved_id: Option<&str>,
    ) -> bool {
        let next = saved_id.map(str::to_string);
        let mut changed = false;
        for entry in self.entries.lock().values_mut() {
            if matches(&entry.info) && entry.info.saved_id != next {
                entry.info.saved_id = next.clone();
                changed = true;
            }
        }
        changed
    }

    pub(crate) fn cluster_generation(&self, cluster_id: &str) -> u64 {
        self.generations
            .lock()
            .get(cluster_id)
            .copied()
            .unwrap_or(0)
    }

    /// Insert (or replace) an entry unless the cluster's forwards were
    /// stopped since `generation` was read; a replaced entry is stopped.
    fn insert(&self, entry: Entry, generation: Option<u64>) -> bool {
        let generations = self.generations.lock();
        if let Some(generation) = generation {
            let current = generations
                .get(&entry.info.cluster_id)
                .copied()
                .unwrap_or(0);
            if current != generation {
                entry.cancel.cancel();
                return false;
            }
        }
        let previous = self.entries.lock().insert(entry.info.id.clone(), entry);
        drop(generations);
        if let Some(previous) = previous {
            previous.cancel.cancel();
        }
        true
    }

    /// Record a forward that could not start (no listener) so the UI can
    /// show the error and offer a restart.
    pub(crate) fn insert_failed(
        &self,
        info: PortForward,
        generation: Option<u64>,
        sink: &dyn EventSink,
    ) {
        let entry = Entry {
            info,
            cancel: CancellationToken::new(),
            task: None,
        };
        if self.insert(entry, generation) {
            self.emit(sink);
        }
    }

    /// Stop the listener of `id` and wait until the port is released.
    async fn release(&self, id: &str) {
        let task = {
            let mut entries = self.entries.lock();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            entry.cancel.cancel();
            entry.task.take()
        };
        if let Some(task) = task {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
    }

    /// Update state/error; returns whether anything changed.
    fn set_state(&self, id: &str, state: PortForwardState, error: Option<String>) -> bool {
        let mut entries = self.entries.lock();
        let Some(entry) = entries.get_mut(id) else {
            return false;
        };
        if entry.info.state == state && entry.info.error == error {
            return false;
        }
        entry.info.state = state;
        entry.info.error = error;
        true
    }

    fn remove(&self, id: &str) -> bool {
        let removed = self.entries.lock().remove(id);
        match removed {
            Some(entry) => {
                entry.cancel.cancel();
                true
            }
            None => false,
        }
    }

    pub(crate) fn stop_cluster(&self, cluster_id: &str, sink: &dyn EventSink) {
        let stopped: Vec<Entry> = {
            let mut generations = self.generations.lock();
            *generations.entry(cluster_id.to_string()).or_default() += 1;
            let mut entries = self.entries.lock();
            let ids: Vec<String> = entries
                .values()
                .filter(|e| e.info.cluster_id == cluster_id)
                .map(|e| e.info.id.clone())
                .collect();
            ids.iter().filter_map(|id| entries.remove(id)).collect()
        };
        if stopped.is_empty() {
            return;
        }
        for entry in stopped {
            entry.cancel.cancel();
        }
        self.emit(sink);
    }

    pub(crate) fn stop_all(&self, sink: &dyn EventSink) {
        let all: Vec<Entry> = self.entries.lock().drain().map(|(_, e)| e).collect();
        if all.is_empty() {
            return;
        }
        for entry in all {
            entry.cancel.cancel();
        }
        self.emit(sink);
    }
}

fn pod_is_ready(pod: &Pod) -> bool {
    if pod.metadata.deletion_timestamp.is_some() {
        return false;
    }
    let Some(status) = pod.status.as_ref() else {
        return false;
    };
    status.phase.as_deref() == Some("Running")
        && status
            .conditions
            .as_ref()
            .is_some_and(|c| c.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}

/// First Running + Ready pod (by name, for stable choice across connections).
pub fn select_ready_pod(pods: &[Pod]) -> Option<&Pod> {
    let mut ready: Vec<&Pod> = pods.iter().filter(|p| pod_is_ready(p)).collect();
    ready.sort_by(|a, b| a.metadata.name.cmp(&b.metadata.name));
    ready.into_iter().next()
}

/// Map a service port to the container port on `pod` (numeric or named
/// `targetPort`; absent `targetPort` means "same as port").
pub fn resolve_target_port(service: &Service, pod: &Pod, service_port: u16) -> Result<u16> {
    let svc_name = service.metadata.name.as_deref().unwrap_or("service");
    let ports = service
        .spec
        .as_ref()
        .and_then(|s| s.ports.as_ref())
        .cloned()
        .unwrap_or_default();
    let port = ports
        .iter()
        .find(|p| p.port == i32::from(service_port))
        .ok_or_else(|| {
            let known: Vec<String> = ports.iter().map(|p| p.port.to_string()).collect();
            anyhow!(
                "service {svc_name} has no port {service_port} (ports: {})",
                if known.is_empty() {
                    "none".to_string()
                } else {
                    known.join(", ")
                }
            )
        })?;
    match &port.target_port {
        None => Ok(service_port),
        Some(IntOrString::Int(n)) => {
            u16::try_from(*n).map_err(|_| anyhow!("invalid targetPort {n}"))
        }
        Some(IntOrString::String(name)) => {
            if let Ok(n) = name.parse::<u16>() {
                return Ok(n);
            }
            pod.spec
                .as_ref()
                .into_iter()
                .flat_map(|s| s.containers.iter())
                .flat_map(|c| c.ports.iter().flatten())
                .find(|p| p.name.as_deref() == Some(name.as_str()))
                .and_then(|p| u16::try_from(p.container_port).ok())
                .ok_or_else(|| {
                    anyhow!(
                        "pod {} has no container port named \"{name}\" (targetPort of service {svc_name})",
                        pod.metadata.name.as_deref().unwrap_or("?")
                    )
                })
        }
    }
}

/// Whether `127.0.0.1:port` can be bound right now, with the same socket
/// options as a forward's listener.
async fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).await.is_ok()
}

/// A free port close to `port` (within the next hundred), else any free port.
pub async fn free_port_near(port: u16) -> Option<u16> {
    let start = port.saturating_add(1);
    let end = port.saturating_add(100);
    for candidate in start..=end {
        if candidate != port && port_is_free(candidate).await {
            return Some(candidate);
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

/// `port_forward_local_port`: is `port` free, and if not, which one is.
pub async fn local_port_status(port: u16) -> LocalPortStatus {
    if port == 0 || port_is_free(port).await {
        return LocalPortStatus {
            port,
            available: true,
            suggestion: None,
        };
    }
    LocalPortStatus {
        port,
        available: false,
        suggestion: free_port_near(port).await,
    }
}

/// Bind the local end of a forward, with an error that says what to do.
async fn bind_local(wanted: u16) -> Result<TcpListener> {
    match TcpListener::bind(("127.0.0.1", wanted)).await {
        Ok(listener) => Ok(listener),
        Err(e) if wanted == 0 => Err(e).context("cannot open a local port"),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            let hint = free_port_near(wanted)
                .await
                .map(|p| format!(" (port {p} is free)"))
                .unwrap_or_default();
            bail!("local port {wanted} is already in use by another program{hint}")
        }
        Err(e) => Err(e).with_context(|| format!("local port {wanted} is not available")),
    }
}

/// Resolve the pod and container port a new connection should go to.
async fn resolve_target(client: &Client, request: &PortForwardRequest) -> Result<(String, u16)> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), &request.namespace);
    match request.kind {
        PortForwardKind::Pod => {
            pods.get(&request.name)
                .await
                .map_err(kube_error)
                .with_context(|| format!("pod {}/{}", request.namespace, request.name))?;
            Ok((request.name.clone(), request.remote_port))
        }
        PortForwardKind::Service => {
            let services: Api<Service> = Api::namespaced(client.clone(), &request.namespace);
            let service = services
                .get(&request.name)
                .await
                .map_err(kube_error)
                .with_context(|| format!("service {}/{}", request.namespace, request.name))?;
            let selector = service
                .spec
                .as_ref()
                .and_then(|s| s.selector.clone())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    anyhow!(
                        "service {} has no pod selector; forward to a pod instead",
                        request.name
                    )
                })?;
            let label_selector = selector
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(",");
            let list = pods
                .list(&ListParams::default().labels(&label_selector))
                .await
                .map_err(kube_error)?;
            let pod = select_ready_pod(&list.items).ok_or_else(|| {
                anyhow!("no running and ready pod backs service {}", request.name)
            })?;
            let port = resolve_target_port(&service, pod, request.remote_port)?;
            let name = pod.metadata.name.clone().unwrap_or_default();
            Ok((name, port))
        }
    }
}

struct ForwardCtx {
    id: String,
    client: Client,
    request: PortForwardRequest,
    forwards: PortForwards,
    sink: Arc<dyn EventSink>,
}

impl ForwardCtx {
    fn report(&self, state: PortForwardState, error: Option<String>) {
        if self.forwards.set_state(&self.id, state, error) {
            self.forwards.emit(self.sink.as_ref());
        }
    }
}

async fn accept_loop(ctx: Arc<ForwardCtx>, listener: TcpListener, cancel: CancellationToken) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    let ctx = ctx.clone();
                    let cancel = cancel.child_token();
                    tokio::spawn(async move {
                        if let Err(e) = forward_connection(&ctx, socket, &cancel).await {
                            if !cancel.is_cancelled() {
                                let message = format!("{e:#}");
                                tracing::debug!("port-forward {}: {message}", ctx.id);
                                ctx.report(PortForwardState::Error, Some(message));
                            }
                        }
                    });
                }
                Err(e) => {
                    tracing::debug!("port-forward {} accept failed: {e}", ctx.id);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }
}

async fn forward_connection(
    ctx: &ForwardCtx,
    mut socket: TcpStream,
    cancel: &CancellationToken,
) -> Result<()> {
    let (pod, port) = resolve_target(&ctx.client, &ctx.request).await?;
    let pods: Api<Pod> = Api::namespaced(ctx.client.clone(), &ctx.request.namespace);
    let mut forwarder = pods
        .portforward(&pod, &[port])
        .await
        .map_err(kube_error)
        .with_context(|| format!("cannot open port-forward to pod {pod}:{port}"))?;
    let mut upstream = forwarder
        .take_stream(port)
        .context("port-forward stream unavailable")?;
    let error_rx = forwarder.take_error(port);
    ctx.report(PortForwardState::Active, None);

    tokio::select! {
        result = tokio::io::copy_bidirectional(&mut socket, &mut upstream) => {
            if let Err(e) = result {
                // Client resets are normal (browser closed the tab).
                tracing::debug!("port-forward {} connection ended: {e}", ctx.id);
            }
        }
        _ = cancel.cancelled() => {}
    }
    drop(upstream);
    if let Some(error_rx) = error_rx {
        if let Ok(Some(message)) = tokio::time::timeout(Duration::from_millis(200), error_rx).await
        {
            bail!("{message}");
        }
    }
    forwarder.abort();
    Ok(())
}

/// What a forward needs to run, independent of [`Kubepit`] so saved
/// forwards can start in the background when their cluster connects.
#[derive(Clone)]
pub(crate) struct Launcher {
    pub client: Client,
    pub forwards: PortForwards,
    pub sink: Arc<dyn EventSink>,
}

impl Launcher {
    /// Resolve the target, bind the local port and start accepting. The
    /// entry `id` is replaced if it exists (restart). With `generation`, the
    /// forward is dropped when its cluster disconnected in the meantime.
    pub(crate) async fn launch(
        &self,
        id: String,
        request: PortForwardRequest,
        saved_id: Option<String>,
        generation: Option<u64>,
    ) -> Result<PortForward> {
        // Fail fast on typos instead of on the first connection.
        resolve_target(&self.client, &request).await?;
        let listener = bind_local(request.local_port.unwrap_or(0)).await?;
        let local_port = listener.local_addr()?.port();
        let info = PortForward {
            id: id.clone(),
            cluster_id: request.cluster_id.clone(),
            namespace: request.namespace.clone(),
            kind: request.kind,
            name: request.name.clone(),
            remote_port: request.remote_port,
            local_port,
            state: PortForwardState::Active,
            error: None,
            created_at: now_millis(),
            saved_id,
        };
        let cancel = CancellationToken::new();
        let ctx = Arc::new(ForwardCtx {
            id,
            client: self.client.clone(),
            request,
            forwards: self.forwards.clone(),
            sink: self.sink.clone(),
        });
        let task = tokio::spawn(accept_loop(ctx, listener, cancel.clone()));
        let entry = Entry {
            info: info.clone(),
            cancel,
            task: Some(task),
        };
        if !self.forwards.insert(entry, generation) {
            bail!("the cluster disconnected while the forward was starting");
        }
        self.forwards.emit(self.sink.as_ref());
        Ok(info)
    }
}

pub(crate) fn validate_request(request: &PortForwardRequest) -> Result<()> {
    if request.remote_port == 0 {
        bail!("remote port must be between 1 and 65535");
    }
    if request.name.trim().is_empty() || request.namespace.trim().is_empty() {
        bail!("namespace and name are required");
    }
    Ok(())
}

/// The request a live forward was started with, pinned to its local port.
fn request_of(info: &PortForward) -> PortForwardRequest {
    PortForwardRequest {
        cluster_id: info.cluster_id.clone(),
        namespace: info.namespace.clone(),
        kind: info.kind,
        name: info.name.clone(),
        remote_port: info.remote_port,
        local_port: Some(info.local_port).filter(|p| *p != 0),
    }
}

impl Kubepit {
    pub(crate) async fn launcher(&self, cluster_id: &str) -> Result<Launcher> {
        Ok(Launcher {
            client: self.client(cluster_id).await?,
            forwards: self.forwards.clone(),
            sink: self.sink.clone(),
        })
    }

    /// `port_forward_start`. A forward to a saved target is linked to it.
    pub async fn port_forward_start(&self, request: PortForwardRequest) -> Result<PortForward> {
        validate_request(&request)?;
        let launcher = self.launcher(&request.cluster_id).await?;
        let saved_id = self
            .saved_forwards
            .find_target(&request)
            .map(|s| s.id)
            .filter(|id| self.forwards.by_saved(id).is_none());
        let id = uuid::Uuid::new_v4().to_string();
        launcher.launch(id, request, saved_id, None).await
    }

    /// `port_forward_restart`: stop the forward (if it runs) and start it
    /// again with the same target and local port. On failure the forward
    /// stays listed in the `error` state.
    pub async fn port_forward_restart(&self, id: &str) -> Result<PortForward> {
        let info = self
            .forwards
            .get(id)
            .ok_or_else(|| anyhow!("port forward {id} is not running"))?;
        let request = request_of(&info);
        self.forwards.release(id).await;
        let result = async {
            let launcher = self.launcher(&info.cluster_id).await?;
            launcher
                .launch(id.to_string(), request, info.saved_id.clone(), None)
                .await
        }
        .await;
        if let Err(e) = &result {
            if self
                .forwards
                .set_state(id, PortForwardState::Error, Some(format!("{e:#}")))
            {
                self.forwards.emit(self.sink.as_ref());
            }
        }
        result
    }

    /// `port_forward_stop`. Unknown ids are ignored.
    pub fn port_forward_stop(&self, id: &str) {
        if self.forwards.remove(id) {
            self.forwards.emit(self.sink.as_ref());
        }
    }

    /// `port_forward_list`.
    pub fn port_forward_list(&self) -> Vec<PortForward> {
        self.forwards.list()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod(name: &str, phase: &str, ready: bool) -> Pod {
        serde_json::from_value(json!({
            "metadata": {"name": name},
            "spec": {"containers": [{"name": "app", "ports": [
                {"name": "http", "containerPort": 8080},
                {"name": "metrics", "containerPort": 9090}
            ]}]},
            "status": {"phase": phase, "conditions": [
                {"type": "Ready", "status": if ready { "True" } else { "False" }}
            ]}
        }))
        .unwrap()
    }

    fn service() -> Service {
        serde_json::from_value(json!({
            "metadata": {"name": "web"},
            "spec": {"selector": {"app": "web"}, "ports": [
                {"port": 80, "targetPort": "http"},
                {"port": 443, "targetPort": 8443},
                {"port": 9090},
                {"port": 81, "targetPort": "missing"}
            ]}
        }))
        .unwrap()
    }

    #[test]
    fn picks_a_running_ready_pod() {
        let pods = vec![
            pod("web-c", "Running", true),
            pod("web-a", "Pending", false),
            pod("web-b", "Running", true),
            pod("web-0", "Running", false),
        ];
        assert_eq!(
            select_ready_pod(&pods).unwrap().metadata.name.as_deref(),
            Some("web-b")
        );
        assert!(select_ready_pod(&[pod("x", "Running", false)]).is_none());
    }

    #[test]
    fn maps_service_ports_to_container_ports() {
        let svc = service();
        let p = pod("web-a", "Running", true);
        assert_eq!(resolve_target_port(&svc, &p, 80).unwrap(), 8080);
        assert_eq!(resolve_target_port(&svc, &p, 443).unwrap(), 8443);
        assert_eq!(resolve_target_port(&svc, &p, 9090).unwrap(), 9090);
        let err = resolve_target_port(&svc, &p, 81).unwrap_err().to_string();
        assert!(err.contains("\"missing\""), "{err}");
        let err = resolve_target_port(&svc, &p, 1234).unwrap_err().to_string();
        assert!(err.contains("no port 1234"), "{err}");
    }

    #[test]
    fn registry_tracks_state_changes() {
        let forwards = PortForwards::default();
        let cancel = CancellationToken::new();
        forwards.entries.lock().insert(
            "a".into(),
            Entry {
                info: PortForward {
                    id: "a".into(),
                    cluster_id: "c1".into(),
                    namespace: "ns".into(),
                    kind: PortForwardKind::Pod,
                    name: "p".into(),
                    remote_port: 80,
                    local_port: 1234,
                    state: PortForwardState::Active,
                    error: None,
                    created_at: 1,
                    saved_id: Some("s1".into()),
                },
                cancel: cancel.clone(),
                task: None,
            },
        );
        assert!(forwards.set_state("a", PortForwardState::Error, Some("boom".into())));
        assert!(!forwards.set_state("a", PortForwardState::Error, Some("boom".into())));
        assert_eq!(forwards.list()[0].error.as_deref(), Some("boom"));
        assert_eq!(forwards.by_saved("s1").unwrap().id, "a");
        assert!(forwards.relink(|f| f.id == "a", None));
        assert!(!forwards.relink(|f| f.id == "a", None));
        assert!(forwards.by_saved("s1").is_none());
        let generation = forwards.cluster_generation("c1");
        forwards.stop_cluster("c1", &crate::events::NullSink);
        assert!(cancel.is_cancelled());
        assert!(forwards.list().is_empty());
        assert_ne!(forwards.cluster_generation("c1"), generation);
    }

    fn failed(id: &str) -> PortForward {
        PortForward {
            id: id.into(),
            cluster_id: "c1".into(),
            namespace: "ns".into(),
            kind: PortForwardKind::Service,
            name: "db".into(),
            remote_port: 5432,
            local_port: 5432,
            state: PortForwardState::Error,
            error: Some("local port 5432 is already in use".into()),
            created_at: 1,
            saved_id: Some("s1".into()),
        }
    }

    #[test]
    fn failed_starts_respect_disconnects() {
        let forwards = PortForwards::default();
        let stale = forwards.cluster_generation("c1");
        forwards.insert_failed(failed("x"), Some(stale), &crate::events::NullSink);
        assert_eq!(forwards.list().len(), 1);
        forwards.stop_cluster("c1", &crate::events::NullSink);
        // A background start that read the generation before the disconnect.
        forwards.insert_failed(failed("y"), Some(stale), &crate::events::NullSink);
        assert!(forwards.list().is_empty());
        assert_eq!(request_of(&failed("x")).local_port, Some(5432));
    }

    #[tokio::test]
    async fn busy_local_ports_are_detected_with_a_free_alternative() {
        let busy = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = busy.local_addr().unwrap().port();
        let status = local_port_status(port).await;
        assert!(!status.available);
        let free = status.suggestion.unwrap();
        assert_ne!(free, port);
        assert!(local_port_status(free).await.available);
        assert!(local_port_status(0).await.available);

        let err = bind_local(port).await.unwrap_err().to_string();
        assert!(err.contains("already in use"), "{err}");
        assert!(err.contains("is free"), "{err}");
        drop(busy);
        assert!(local_port_status(port).await.available);
    }
}
