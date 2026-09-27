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
use tokio_util::sync::CancellationToken;

use crate::app::Kubepit;
use crate::error::kube_error;
use crate::events::EventSink;
use crate::objects::now_millis;
use crate::types::{PortForward, PortForwardKind, PortForwardRequest, PortForwardState};

struct Entry {
    info: PortForward,
    cancel: CancellationToken,
}

/// Registry of live forwards. Cheap to clone (shared state) so connection
/// tasks can report their own errors.
#[derive(Clone, Default)]
pub struct PortForwards {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
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

    fn emit(&self, sink: &dyn EventSink) {
        sink.port_forwards(&self.list());
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

impl Kubepit {
    /// `port_forward_start`.
    pub async fn port_forward_start(&self, request: PortForwardRequest) -> Result<PortForward> {
        if request.remote_port == 0 {
            bail!("remote port must be between 1 and 65535");
        }
        if request.name.trim().is_empty() || request.namespace.trim().is_empty() {
            bail!("namespace and name are required");
        }
        let client = self.client(&request.cluster_id).await?;
        // Fail fast on typos instead of on the first connection.
        resolve_target(&client, &request).await?;

        let wanted = request.local_port.unwrap_or(0);
        let listener = TcpListener::bind(("127.0.0.1", wanted))
            .await
            .with_context(|| {
                if wanted == 0 {
                    "cannot open a local port".to_string()
                } else {
                    format!("local port {wanted} is not available")
                }
            })?;
        let local_port = listener.local_addr()?.port();
        let id = uuid::Uuid::new_v4().to_string();
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
        };
        let cancel = CancellationToken::new();
        self.forwards.entries.lock().insert(
            id.clone(),
            Entry {
                info: info.clone(),
                cancel: cancel.clone(),
            },
        );
        let ctx = Arc::new(ForwardCtx {
            id,
            client,
            request,
            forwards: self.forwards.clone(),
            sink: self.sink.clone(),
        });
        tokio::spawn(accept_loop(ctx, listener, cancel));
        self.forwards.emit(self.sink.as_ref());
        Ok(info)
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
                },
                cancel: cancel.clone(),
            },
        );
        assert!(forwards.set_state("a", PortForwardState::Error, Some("boom".into())));
        assert!(!forwards.set_state("a", PortForwardState::Error, Some("boom".into())));
        assert_eq!(forwards.list()[0].error.as_deref(), Some("boom"));
        forwards.stop_cluster("c1", &crate::events::NullSink);
        assert!(cancel.is_cancelled());
        assert!(forwards.list().is_empty());
    }
}
