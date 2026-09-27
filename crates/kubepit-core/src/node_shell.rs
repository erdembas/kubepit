//! Node shells: a privileged helper pod pinned to a node.
//!
//! The pod shares the host's PID/network/IPC namespaces and runs
//! `nsenter -t 1 -m -u -i -n sleep 14000`, so `kubectl exec` into it lands in
//! the node's mount/UTS/IPC/network namespaces — a root shell on the node
//! without SSH. `sleep 14000` bounds the pod's life (~4 h) even if Kubepit
//! crashes before cleaning up.
//!
//! Creation tries `kube-system` first (where `system-node-critical` priority
//! is allowed) and falls back to `default` when forbidden; if the priority
//! class is rejected it retries without it. Every helper pod is registered
//! against its terminal and deleted (grace period 0) when the terminal is
//! destroyed or exits, when its cluster is removed, and at app shutdown.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, DeleteParams, PostParams};
use kube::Client;
use parking_lot::Mutex;
use serde_json::json;

use crate::app::Kubepit;
use crate::error::{api_code, is_forbidden, kube_error};

/// How long to wait for the helper pod to reach `Running`.
pub const START_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const CANDIDATE_NAMESPACES: [&str; 2] = ["kube-system", "default"];

/// Command run inside the helper container.
pub const NSENTER_COMMAND: [&str; 9] = [
    "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "sleep", "14000",
];
/// Shell started by `kubectl exec` once the pod is running.
pub const NODE_SHELL_EXEC: &str = "((clear && bash) || (clear && ash) || (clear && sh))";

/// A live helper pod.
#[derive(Clone)]
pub struct NodeShellPod {
    /// Terminal the pod serves (informational; the registry key is the
    /// unique pod name so a restarted terminal reusing its id can never
    /// have its new pod deleted by the previous session's cleanup).
    pub terminal_id: String,
    pub cluster_id: String,
    pub namespace: String,
    pub name: String,
    client: Client,
}

/// Helper pods keyed by pod name.
#[derive(Clone, Default)]
pub struct NodeShells {
    pods: Arc<Mutex<HashMap<String, NodeShellPod>>>,
}

impl NodeShells {
    fn take(&self, pod_name: &str) -> Option<NodeShellPod> {
        self.pods.lock().remove(pod_name)
    }
}

/// `node-shell-<8 hex>`.
pub fn helper_pod_name() -> String {
    format!(
        "node-shell-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    )
}

/// The helper pod manifest.
pub fn helper_pod_manifest(
    name: &str,
    namespace: &str,
    node: &str,
    image: &str,
    with_priority: bool,
) -> serde_json::Value {
    let mut spec = json!({
        "nodeName": node,
        "hostPID": true,
        "hostNetwork": true,
        "hostIPC": true,
        "restartPolicy": "Never",
        "terminationGracePeriodSeconds": 0,
        "tolerations": [{"operator": "Exists"}],
        "containers": [{
            "name": "shell",
            "image": image,
            "command": NSENTER_COMMAND,
            "stdin": true,
            "tty": true,
            "securityContext": {"privileged": true}
        }]
    });
    if with_priority {
        spec["priorityClassName"] = json!("system-node-critical");
    }
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {
                "app.kubernetes.io/managed-by": "kubepit",
                "app.kubernetes.io/component": "node-shell"
            },
            "annotations": {"kubepit.io/node": node}
        },
        "spec": spec
    })
}

async fn delete_helper(client: &Client, namespace: &str, name: &str) -> Result<()> {
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let params = DeleteParams {
        grace_period_seconds: Some(0),
        ..DeleteParams::default()
    };
    match api.delete(name, &params).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let err = kube_error(e);
            if api_code(&err) == Some(404) {
                Ok(())
            } else {
                Err(err)
            }
        }
    }
}

fn delete_in_background(pod: NodeShellPod) {
    let task = async move {
        if let Err(e) = delete_helper(&pod.client, &pod.namespace, &pod.name).await {
            tracing::warn!(
                "failed to delete node-shell pod {}/{}: {e:#}",
                pod.namespace,
                pod.name
            );
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(task);
        }
        Err(_) => tracing::warn!("no runtime available to delete node-shell pod"),
    }
}

/// Describes why a pod is not running yet (for progress lines).
fn pending_reason(pod: &Pod) -> String {
    let status = pod.status.as_ref();
    let phase = status
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Pending".into());
    let waiting = status
        .and_then(|s| s.container_statuses.as_ref())
        .and_then(|cs| cs.first())
        .and_then(|c| c.state.as_ref())
        .and_then(|s| s.waiting.as_ref())
        .and_then(|w| w.reason.clone());
    let unschedulable = status
        .and_then(|s| s.conditions.as_ref())
        .and_then(|cs| {
            cs.iter()
                .find(|c| c.type_ == "PodScheduled" && c.status == "False")
        })
        .and_then(|c| c.message.clone());
    match (waiting, unschedulable) {
        (Some(reason), _) => format!("{phase}: {reason}"),
        (None, Some(message)) => format!("{phase}: {message}"),
        (None, None) => phase,
    }
}

/// Container waiting reasons that will not fix themselves in 60 seconds.
fn is_fatal_waiting(reason: &str) -> bool {
    matches!(
        reason,
        "ErrImagePull"
            | "ImagePullBackOff"
            | "InvalidImageName"
            | "CreateContainerConfigError"
            | "CreateContainerError"
    )
}

impl Kubepit {
    /// Create the helper pod for `terminal_id` and wait until it runs.
    /// `progress` receives human-readable lines (already newline-terminated).
    pub(crate) async fn start_node_shell(
        &self,
        terminal_id: &str,
        cluster_id: &str,
        node: &str,
        progress: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> Result<NodeShellPod> {
        let client = self.client(cluster_id).await?;
        let image = self.settings().node_shell_image;
        let name = helper_pod_name();
        progress(&format!(
            "Creating node shell pod {name} on node {node} ({image})…\r\n"
        ));

        let mut created_in: Option<&str> = None;
        let mut last_error: Option<anyhow::Error> = None;
        'namespaces: for namespace in CANDIDATE_NAMESPACES {
            for with_priority in [true, false] {
                let manifest = helper_pod_manifest(&name, namespace, node, &image, with_priority);
                let pod: Pod =
                    serde_json::from_value(manifest).context("invalid helper pod manifest")?;
                let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
                match api.create(&PostParams::default(), &pod).await {
                    Ok(_) => {
                        created_in = Some(namespace);
                        break 'namespaces;
                    }
                    Err(e) => {
                        let err = kube_error(e);
                        let text = format!("{err:#}").to_ascii_lowercase();
                        if with_priority && text.contains("priority") {
                            progress("Priority class rejected, retrying without it…\r\n");
                            last_error = Some(err);
                            continue;
                        }
                        if is_forbidden(&err) {
                            progress(&format!("Not allowed to create pods in {namespace}.\r\n"));
                            last_error = Some(err);
                            continue 'namespaces;
                        }
                        return Err(err.context("failed to create node shell pod"));
                    }
                }
            }
        }
        let Some(namespace) = created_in else {
            let err = last_error.unwrap_or_else(|| anyhow!("no namespace accepted the helper pod"));
            return Err(err.context("failed to create node shell pod"));
        };

        let shell = NodeShellPod {
            terminal_id: terminal_id.to_string(),
            cluster_id: cluster_id.to_string(),
            namespace: namespace.to_string(),
            name: name.clone(),
            client: client.clone(),
        };
        // Register immediately so a failure below (or app exit) still cleans up.
        self.node_shells
            .pods
            .lock()
            .insert(name.clone(), shell.clone());

        match self
            .wait_until_running(&client, namespace, &name, progress)
            .await
        {
            Ok(()) => Ok(shell),
            Err(e) => {
                if let Some(pod) = self.node_shells.take(&name) {
                    let _ = delete_helper(&pod.client, &pod.namespace, &pod.name).await;
                }
                Err(e)
            }
        }
    }

    async fn wait_until_running(
        &self,
        client: &Client,
        namespace: &str,
        name: &str,
        progress: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> Result<()> {
        let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        let mut last_reason = String::new();
        loop {
            let pod = api.get(name).await.map_err(kube_error)?;
            let phase = pod
                .status
                .as_ref()
                .and_then(|s| s.phase.as_deref())
                .unwrap_or("Pending");
            match phase {
                "Running" => {
                    progress("Node shell pod is running.\r\n");
                    return Ok(());
                }
                "Failed" | "Succeeded" => bail!(
                    "node shell pod stopped unexpectedly ({})",
                    pending_reason(&pod)
                ),
                _ => {}
            }
            let reason = pending_reason(&pod);
            if reason != last_reason {
                if !progress(&format!("Waiting for pod — {reason}\r\n")) {
                    bail!("terminal closed while waiting for the node shell pod");
                }
                last_reason = reason.clone();
            }
            if let Some(fatal) = reason.split(": ").nth(1).filter(|r| is_fatal_waiting(r)) {
                bail!(
                    "node shell pod cannot start: {fatal} (check the node shell image in Settings)"
                );
            }
            if tokio::time::Instant::now() >= deadline {
                bail!(
                    "node shell pod did not start within {}s (last status: {reason})",
                    START_TIMEOUT.as_secs()
                );
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// A one-shot cleanup for helper pod `pod_name`, safe to call from any
    /// thread (it spawns the delete on the runtime captured now).
    pub fn node_shell_cleanup(&self, pod_name: &str) -> Box<dyn FnOnce() + Send + 'static> {
        let shells = self.node_shells.clone();
        let pod_name = pod_name.to_string();
        let handle = tokio::runtime::Handle::try_current().ok();
        Box::new(move || {
            let Some(pod) = shells.take(&pod_name) else {
                return;
            };
            match handle {
                Some(handle) => {
                    handle.spawn(async move {
                        if let Err(e) = delete_helper(&pod.client, &pod.namespace, &pod.name).await
                        {
                            tracing::warn!(
                                "failed to delete node-shell pod {}/{}: {e:#}",
                                pod.namespace,
                                pod.name
                            );
                        }
                    });
                }
                None => delete_in_background(pod),
            }
        })
    }

    /// Delete helper pods of one cluster (cluster removal).
    pub(crate) async fn cleanup_cluster_node_shells(&self, cluster_id: &str) {
        let pods: Vec<NodeShellPod> = {
            let mut map = self.node_shells.pods.lock();
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, p)| p.cluster_id == cluster_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for pod in pods {
            let _ = delete_helper(&pod.client, &pod.namespace, &pod.name).await;
        }
    }

    /// Delete every helper pod (app shutdown).
    pub(crate) async fn cleanup_all_node_shells(&self) {
        let pods: Vec<NodeShellPod> = self
            .node_shells
            .pods
            .lock()
            .drain()
            .map(|(_, p)| p)
            .collect();
        let deletions = pods
            .iter()
            .map(|pod| delete_helper(&pod.client, &pod.namespace, &pod.name));
        for result in futures::future::join_all(deletions).await {
            if let Err(e) = result {
                tracing::warn!("failed to delete node-shell pod: {e:#}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_pod_is_privileged_and_pinned() {
        let manifest = helper_pod_manifest(
            "node-shell-abcd1234",
            "kube-system",
            "ip-10-0-0-1",
            "alpine:3.20",
            true,
        );
        let pod: Pod = serde_json::from_value(manifest.clone()).unwrap();
        let spec = pod.spec.unwrap();
        assert_eq!(spec.node_name.as_deref(), Some("ip-10-0-0-1"));
        assert_eq!(spec.host_pid, Some(true));
        assert_eq!(spec.host_network, Some(true));
        assert_eq!(spec.host_ipc, Some(true));
        assert_eq!(
            spec.priority_class_name.as_deref(),
            Some("system-node-critical")
        );
        assert_eq!(
            spec.tolerations.unwrap()[0].operator.as_deref(),
            Some("Exists")
        );
        let container = &spec.containers[0];
        assert_eq!(container.image.as_deref(), Some("alpine:3.20"));
        assert_eq!(
            container.command.as_ref().unwrap(),
            &NSENTER_COMMAND.map(String::from).to_vec()
        );
        assert_eq!(
            container.security_context.as_ref().unwrap().privileged,
            Some(true)
        );
        let without = helper_pod_manifest("n", "default", "node", "img", false);
        assert!(without["spec"].get("priorityClassName").is_none());
    }

    #[test]
    fn helper_pod_names_are_short_and_unique() {
        let a = helper_pod_name();
        let b = helper_pod_name();
        assert!(a.starts_with("node-shell-"));
        assert_eq!(a.len(), "node-shell-".len() + 8);
        assert_ne!(a, b);
    }

    #[test]
    fn pending_reasons_are_readable() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": {"name": "p"},
            "status": {"phase": "Pending", "containerStatuses": [{
                "name": "shell", "image": "x", "imageID": "", "ready": false, "restartCount": 0,
                "state": {"waiting": {"reason": "ImagePullBackOff"}}
            }]}
        }))
        .unwrap();
        let reason = pending_reason(&pod);
        assert_eq!(reason, "Pending: ImagePullBackOff");
        assert!(is_fatal_waiting(reason.split(": ").nth(1).unwrap()));
        assert!(!is_fatal_waiting("ContainerCreating"));
    }
}
