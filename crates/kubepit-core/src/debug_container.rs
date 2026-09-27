//! Ephemeral debug containers (`kubectl debug -it <pod> --image … --target …`).
//!
//! The container is added through the pod's `ephemeralcontainers`
//! subresource with a strategic-merge patch — the list merges on `name`, so
//! debug containers added earlier are kept — with stdin + TTY so a terminal
//! can `kubectl attach` to it, and `targetContainerName` to share the target
//! container's process namespace. The command then polls the pod until the
//! new container runs, failing early on image-pull and create errors.
//!
//! Profiles mirror `kubectl debug --profile`: `general` adds nothing (the
//! most compatible choice under Pod Security admission), `netadmin` adds
//! `NET_ADMIN` + `NET_RAW` (tcpdump, iptables), `sysadmin` runs privileged.
//! Ephemeral containers cannot be removed: they stay until the pod is
//! recreated.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, Patch, PatchParams};
use serde_json::{json, Value};

use crate::app::Kubepit;
use crate::error::{api_code, kube_error};
use crate::node_shell::is_fatal_waiting;
use crate::types::{DebugProfile, PodDebugRequest};

/// How long to wait for the debug container to run.
pub const DEBUG_START_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// `debugger-<5 chars>`, like kubectl.
pub fn debug_container_name() -> String {
    format!(
        "debugger-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..5]
    )
}

/// RFC 1123 label: what Kubernetes accepts as a container name.
pub fn is_valid_container_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

/// The strategic-merge patch that adds one ephemeral container.
pub fn ephemeral_container_patch(name: &str, request: &PodDebugRequest) -> Value {
    let mut container = json!({
        "name": name,
        "image": request.image.trim(),
        "stdin": true,
        "tty": true,
        "terminationMessagePolicy": "File",
    });
    if let Some(target) = request
        .target_container
        .as_deref()
        .filter(|t| !t.is_empty())
    {
        container["targetContainerName"] = json!(target);
    }
    if let Some(command) = request.command.as_ref().filter(|c| !c.is_empty()) {
        container["command"] = json!(command);
    }
    match request.profile {
        Some(DebugProfile::Netadmin) => {
            container["securityContext"] =
                json!({"capabilities": {"add": ["NET_ADMIN", "NET_RAW"]}});
        }
        Some(DebugProfile::Sysadmin) => {
            container["securityContext"] = json!({"privileged": true});
        }
        Some(DebugProfile::General) | None => {}
    }
    json!({"spec": {"ephemeralContainers": [container]}})
}

/// Where a debug container is on its way to running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DebugState {
    Running,
    /// Still starting; the text says why (for errors on timeout).
    Starting(String),
    /// Will not start by itself.
    Failed(String),
}

pub fn debug_container_state(pod: &Pod, name: &str) -> DebugState {
    let status = pod
        .status
        .as_ref()
        .and_then(|s| s.ephemeral_container_statuses.as_ref())
        .and_then(|all| all.iter().find(|s| s.name == name));
    let Some(state) = status.and_then(|s| s.state.as_ref()) else {
        return DebugState::Starting("waiting for the kubelet".into());
    };
    if state.running.is_some() {
        return DebugState::Running;
    }
    if let Some(done) = &state.terminated {
        let reason = done.reason.as_deref().unwrap_or("Terminated");
        let mut text = format!("{reason}, exit code {}", done.exit_code);
        if let Some(message) = done.message.as_deref().filter(|m| !m.trim().is_empty()) {
            text.push_str(&format!(": {}", message.trim()));
        }
        return DebugState::Failed(format!(
            "the debug container exited right away ({text}); pick an image with a shell or pass a command"
        ));
    }
    let waiting = state.waiting.as_ref();
    let reason = waiting
        .and_then(|w| w.reason.as_deref())
        .unwrap_or("ContainerCreating");
    if is_fatal_waiting(reason) {
        let message = waiting
            .and_then(|w| w.message.as_deref())
            .map(|m| format!(": {m}"))
            .unwrap_or_default();
        return DebugState::Failed(format!(
            "the debug container cannot start: {reason}{message}"
        ));
    }
    DebugState::Starting(reason.to_string())
}

/// Every container name already used in the pod (all three kinds).
fn container_names(pod: &Pod) -> Vec<String> {
    let Some(spec) = pod.spec.as_ref() else {
        return Vec::new();
    };
    let mut names: Vec<String> = spec.containers.iter().map(|c| c.name.clone()).collect();
    names.extend(
        spec.init_containers
            .iter()
            .flatten()
            .map(|c| c.name.clone()),
    );
    names.extend(
        spec.ephemeral_containers
            .iter()
            .flatten()
            .map(|c| c.name.clone()),
    );
    names
}

/// Explain a failed PATCH of the ephemeralcontainers subresource.
fn explain_patch_error(err: anyhow::Error) -> anyhow::Error {
    match api_code(&err) {
        Some(404 | 405) => err.context(
            "this cluster does not support ephemeral containers (Kubernetes 1.23 or newer is required)",
        ),
        Some(403) => err.context("not allowed to add debug containers to this pod"),
        Some(422) => err.context("the API server rejected the debug container"),
        _ => err.context("failed to add the debug container"),
    }
}

impl Kubepit {
    /// `pod_debug`: add an ephemeral debug container to `pod` and wait until
    /// it runs. Returns the container name to attach to.
    pub async fn pod_debug(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        mut request: PodDebugRequest,
    ) -> Result<String> {
        self.ensure_writable(cluster_id, "starting a debug container")?;
        if request.image.trim().is_empty() {
            request.image = self.settings().debug_image;
        }
        let name = match request.name.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => {
                if !is_valid_container_name(name) {
                    bail!("\"{name}\" is not a valid container name (lowercase letters, digits and '-')");
                }
                name.to_string()
            }
            _ => debug_container_name(),
        };
        let client = self.client(cluster_id).await?;
        let api: Api<Pod> = Api::namespaced(client, namespace);
        let current = api.get(pod).await.map_err(kube_error)?;
        let names = container_names(&current);
        if names.contains(&name) {
            bail!("pod {pod} already has a container named {name}");
        }
        if let Some(target) = request
            .target_container
            .as_deref()
            .filter(|t| !t.is_empty())
        {
            let regular = current
                .spec
                .as_ref()
                .is_some_and(|s| s.containers.iter().any(|c| c.name == target));
            if !regular {
                bail!("pod {pod} has no container named {target}");
            }
        }
        let patch = ephemeral_container_patch(&name, &request);
        api.patch_ephemeral_containers(pod, &PatchParams::default(), &Patch::Strategic(patch))
            .await
            .map_err(|e| explain_patch_error(kube_error(e)))?;

        let deadline = tokio::time::Instant::now() + DEBUG_START_TIMEOUT;
        loop {
            let latest = api.get(pod).await.map_err(kube_error)?;
            match debug_container_state(&latest, &name) {
                DebugState::Running => return Ok(name),
                DebugState::Failed(message) => return Err(anyhow!(message)),
                DebugState::Starting(reason) => {
                    if tokio::time::Instant::now() >= deadline {
                        bail!(
                            "the debug container did not start within {}s (last status: {reason})",
                            DEBUG_START_TIMEOUT.as_secs()
                        );
                    }
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::tests_support::app_with_cluster;

    fn pod_with(status: Value) -> Pod {
        serde_json::from_value(json!({
            "metadata": {"name": "web"},
            "spec": {"containers": [{"name": "app"}],
                     "ephemeralContainers": [{"name": "debugger-a1b2c"}]},
            "status": {"ephemeralContainerStatuses": [status]}
        }))
        .unwrap()
    }

    fn status(state: Value) -> Value {
        json!({"name": "debugger-a1b2c", "image": "busybox", "imageID": "", "ready": false,
               "restartCount": 0, "state": state})
    }

    #[test]
    fn patch_matches_kubectl_debug() {
        let request = PodDebugRequest {
            image: " docker.io/library/busybox:1.36 ".into(),
            target_container: Some("app".into()),
            name: None,
            command: None,
            profile: None,
        };
        let patch = ephemeral_container_patch("debugger-a1b2c", &request);
        assert_eq!(
            patch,
            json!({"spec": {"ephemeralContainers": [{
                "name": "debugger-a1b2c",
                "image": "docker.io/library/busybox:1.36",
                "stdin": true,
                "tty": true,
                "terminationMessagePolicy": "File",
                "targetContainerName": "app"
            }]}})
        );
        let net = ephemeral_container_patch(
            "d",
            &PodDebugRequest {
                image: "nicolaka/netshoot".into(),
                command: Some(vec!["zsh".into()]),
                profile: Some(DebugProfile::Netadmin),
                ..Default::default()
            },
        );
        let c = &net["spec"]["ephemeralContainers"][0];
        assert_eq!(c["command"], json!(["zsh"]));
        assert_eq!(
            c["securityContext"]["capabilities"]["add"],
            json!(["NET_ADMIN", "NET_RAW"])
        );
        assert!(c.get("targetContainerName").is_none());
        let sys = ephemeral_container_patch(
            "d",
            &PodDebugRequest {
                image: "busybox".into(),
                profile: Some(DebugProfile::Sysadmin),
                ..Default::default()
            },
        );
        assert_eq!(
            sys["spec"]["ephemeralContainers"][0]["securityContext"],
            json!({"privileged": true})
        );
    }

    #[test]
    fn names_are_kubectl_style_and_validated() {
        let name = debug_container_name();
        assert!(name.starts_with("debugger-"));
        assert_eq!(name.len(), "debugger-".len() + 5);
        assert!(is_valid_container_name(&name));
        assert!(is_valid_container_name("dbg-1"));
        assert!(!is_valid_container_name("Debug"));
        assert!(!is_valid_container_name("-x"));
        assert!(!is_valid_container_name("x-"));
        assert!(!is_valid_container_name(""));
        assert!(!is_valid_container_name(&"a".repeat(64)));
    }

    #[test]
    fn states_are_classified() {
        assert_eq!(
            debug_container_state(&pod_with(status(json!({"running": {}}))), "debugger-a1b2c"),
            DebugState::Running
        );
        assert!(matches!(
            debug_container_state(&pod_with(status(json!({"running": {}}))), "other"),
            DebugState::Starting(_)
        ));
        assert_eq!(
            debug_container_state(
                &pod_with(status(json!({"waiting": {"reason": "ContainerCreating"}}))),
                "debugger-a1b2c"
            ),
            DebugState::Starting("ContainerCreating".into())
        );
        let DebugState::Failed(pull) = debug_container_state(
            &pod_with(status(json!({"waiting": {"reason": "ImagePullBackOff",
                                               "message": "Back-off pulling image \"nope\""}}))),
            "debugger-a1b2c",
        ) else {
            panic!("image pull must fail early");
        };
        assert!(pull.contains("ImagePullBackOff") && pull.contains("nope"));
        let DebugState::Failed(exited) = debug_container_state(
            &pod_with(status(
                json!({"terminated": {"exitCode": 127, "reason": "Error"}}),
            )),
            "debugger-a1b2c",
        ) else {
            panic!("terminated must fail");
        };
        assert!(exited.contains("exit code 127"));
    }

    #[test]
    fn patch_errors_explain_themselves() {
        let not_found = anyhow::Error::new(crate::error::ApiError {
            code: 404,
            reason: "NotFound".into(),
            message: "the server could not find the requested resource".into(),
        });
        let text = format!("{:#}", explain_patch_error(not_found));
        assert!(
            text.starts_with("this cluster does not support ephemeral containers"),
            "{text}"
        );
        let forbidden = anyhow::Error::new(crate::error::ApiError {
            code: 403,
            reason: "Forbidden".into(),
            message: "pods \"web\" is forbidden".into(),
        });
        assert!(format!("{:#}", explain_patch_error(forbidden)).contains("not allowed"));
    }

    #[tokio::test]
    async fn read_only_clusters_refuse_debug_containers() {
        let (_dir, app, cluster) = app_with_cluster(true);
        let err = app
            .pod_debug(&cluster.id, "ns", "web", PodDebugRequest::default())
            .await
            .unwrap_err();
        assert!(crate::error::is_read_only(&err));
    }
}
