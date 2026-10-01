//! Bounded, explicit probes from an existing running Pod. Nothing is installed
//! and no helper Pod is created. Every command is an argument array, never shell
//! text. Read-only protection runs before any access, and the API enforces RBAC.
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Result};
use k8s_openapi::api::{
    core::v1::{Pod, Service},
    discovery::v1::EndpointSlice,
};
use kube::api::{Api, AttachParams, ListParams};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::{app::Kubepit, types::AccessCheck};

const OUTPUT_CAP: usize = 8192;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const READ_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkProbeProtocol {
    Tcp,
    Http,
    Https,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkDiagnosticsRequest {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub target_namespace: String,
    pub service: String,
    pub port: u16,
    pub protocol: NetworkProbeProtocol,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkProbeStatus {
    Passed,
    Failed,
    Unavailable,
    TimedOut,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkProbeResult {
    /// Stable kind and reason codes are translated in the UI.
    pub kind: String,
    pub status: NetworkProbeStatus,
    pub reason: String,
    pub command: Vec<String>,
    pub output: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkServiceContext {
    pub selector: BTreeMap<String, String>,
    pub cluster_ip: Option<String>,
    pub external_name: Option<String>,
    pub ready_endpoints: usize,
    pub unready_endpoints: usize,
    pub addresses: Vec<String>,
    /// EndpointSlice access failure is a caveat, never a healthy zero count.
    pub endpoints_error: Option<String>,
    pub endpoints_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkDiagnosticsReport {
    pub request: NetworkDiagnosticsRequest,
    pub host: String,
    pub checked_at: String,
    pub probes: Vec<NetworkProbeResult>,
    pub service: NetworkServiceContext,
}

fn label(value: &str) -> bool {
    crate::debug_container::is_valid_container_name(value)
}

pub fn validate_request(request: &NetworkDiagnosticsRequest) -> Result<()> {
    if !label(&request.namespace)
        || !label(&request.target_namespace)
        || !label(&request.container)
        || !label(&request.service)
        || request.pod.len() > 253
        || !request.pod.split('.').all(label)
    {
        bail!("network-diagnostics:invalid-name");
    }
    if request.port == 0 {
        bail!("network-diagnostics:invalid-port");
    }
    // Request targets only the selected Service. No credentials, fragments,
    // query parameters, controls, whitespace or URL authority may be supplied.
    if !request.path.starts_with('/')
        || request.path.starts_with("//")
        || request.path.len() > 1024
        || request
            .path
            .bytes()
            .any(|b| !b.is_ascii_graphic() || matches!(b, b'?' | b'#' | b'\\'))
    {
        bail!("network-diagnostics:invalid-path");
    }
    Ok(())
}

pub fn probe_commands(request: &NetworkDiagnosticsRequest) -> Vec<(String, Vec<String>)> {
    let host = format!("{}.{}.svc", request.service, request.target_namespace);
    let port = request.port.to_string();
    let args = |items: &[&str]| items.iter().map(|s| (*s).to_string()).collect();
    let mut result = vec![
        ("dns".into(), args(&["timeout", "5", "nslookup", &host])),
        (
            "tcp".into(),
            args(&["timeout", "5", "nc", "-z", "-w", "4", &host, &port]),
        ),
    ];
    if request.protocol == NetworkProbeProtocol::Https {
        result.push((
            "tls".into(),
            args(&[
                "timeout",
                "5",
                "openssl",
                "s_client",
                "-brief",
                "-verify_return_error",
                "-verify_hostname",
                &host,
                "-connect",
                &format!("{host}:{port}"),
                "-servername",
                &host,
            ]),
        ));
    }
    if request.protocol != NetworkProbeProtocol::Tcp {
        let scheme = if request.protocol == NetworkProbeProtocol::Https {
            "https"
        } else {
            "http"
        };
        result.push(("http".into(), args(&["curl", "--disable", "--noproxy", "*", "--silent", "--show-error", "--head", "--fail", "--output", "/dev/null", "--max-time", "5", "--connect-timeout", "3", "--proto", "=http,https", "--write-out", "HTTP %{http_code}\nRemote %{remote_ip}\nConnect %{time_connect}s\nTotal %{time_total}s\n", "--url", &format!("{scheme}://{host}:{port}{}", request.path)])));
    }
    result
}

fn exit_code(status: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Status) -> Option<i32> {
    status
        .details
        .as_ref()?
        .causes
        .as_ref()?
        .iter()
        .find(|cause| cause.reason.as_deref() == Some("ExitCode"))?
        .message
        .as_ref()?
        .parse()
        .ok()
}

pub fn classify_output(code: Option<i32>, output: &str) -> (NetworkProbeStatus, &'static str) {
    let lower = output.to_ascii_lowercase();
    if code == Some(127)
        || lower.contains("executable file not found")
        || lower.contains("not found in $path")
        || lower.contains("no such file or directory")
    {
        return (NetworkProbeStatus::Unavailable, "missing_tool");
    }
    if lower.contains("invalid option")
        || lower.contains("unrecognized option")
        || lower.contains("unknown option")
        || lower.contains("illegal option")
    {
        return (NetworkProbeStatus::Unavailable, "unsupported_tool");
    }
    if code == Some(124) || code == Some(28) {
        return (NetworkProbeStatus::TimedOut, "timeout");
    }
    match code {
        Some(0) => (NetworkProbeStatus::Passed, "completed"),
        Some(_) => (NetworkProbeStatus::Failed, "probe_failed"),
        None => (NetworkProbeStatus::Unavailable, "exec_failed"),
    }
}

async fn read_capped(reader: Option<impl AsyncRead + Unpin>) -> Result<Vec<u8>> {
    let Some(reader) = reader else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    reader
        .take((OUTPUT_CAP + 1) as u64)
        .read_to_end(&mut out)
        .await?;
    Ok(out)
}

async fn probe(
    api: &Api<Pod>,
    request: &NetworkDiagnosticsRequest,
    kind: String,
    command: Vec<String>,
) -> NetworkProbeResult {
    let started = Instant::now();
    let mut result = NetworkProbeResult {
        kind,
        command: command.clone(),
        status: NetworkProbeStatus::Unavailable,
        reason: "exec_failed".into(),
        output: String::new(),
        duration_ms: 0,
    };
    let mut params = AttachParams::default()
        .container(&request.container)
        .stdin(false)
        .stdout(true)
        .stderr(true)
        .tty(false);
    params.max_stdout_buf_size = Some(OUTPUT_CAP);
    params.max_stderr_buf_size = Some(OUTPUT_CAP);
    let opened =
        tokio::time::timeout(PROBE_TIMEOUT, api.exec(&request.pod, command, &params)).await;
    match opened {
        Ok(Ok(mut process)) => {
            let status = process.take_status();
            let run = async {
                let (stdout, stderr) =
                    tokio::try_join!(read_capped(process.stdout()), read_capped(process.stderr()))?;
                if stdout.len() > OUTPUT_CAP || stderr.len() > OUTPUT_CAP {
                    return Ok::<_, anyhow::Error>((stdout, stderr, None, true));
                }
                let status = match status {
                    Some(status) => status.await,
                    None => None,
                };
                Ok((stdout, stderr, status, false))
            };
            let remaining = PROBE_TIMEOUT.saturating_sub(started.elapsed());
            match tokio::time::timeout(remaining, run).await {
                Ok(Ok((stdout, stderr, status, overflow))) => {
                    let mut bytes = stdout;
                    if !bytes.is_empty() && !stderr.is_empty() {
                        bytes.push(b'\n');
                    }
                    bytes.extend(stderr);
                    bytes.truncate(OUTPUT_CAP);
                    result.output = String::from_utf8_lossy(&bytes).into_owned();
                    if overflow {
                        result.reason = "output_limit".into();
                    } else {
                        let code = status.as_ref().and_then(|s| {
                            if s.status.as_deref() == Some("Success") {
                                Some(0)
                            } else {
                                exit_code(s)
                            }
                        });
                        if result.output.is_empty() {
                            result.output = status
                                .as_ref()
                                .and_then(|s| s.message.clone())
                                .unwrap_or_default();
                        }
                        let (state, reason) = classify_output(code, &result.output);
                        result.status = state;
                        result.reason = reason.into();
                    }
                }
                Ok(Err(error)) => {
                    result.output = error.to_string();
                }
                Err(_) => {
                    result.status = NetworkProbeStatus::TimedOut;
                    result.reason = "timeout".into();
                }
            }
            // Abort the websocket task on completion, overflow and timeout.
            process.abort();
        }
        Ok(Err(error)) => {
            result.output = error.to_string();
            let (state, reason) = classify_output(None, &result.output);
            result.status = state;
            result.reason = reason.into();
        }
        Err(_) => {
            result.status = NetworkProbeStatus::TimedOut;
            result.reason = "timeout".into();
        }
    }
    let mut end = result.output.len().min(OUTPUT_CAP);
    while !result.output.is_char_boundary(end) {
        end -= 1;
    }
    result.output.truncate(end);
    result.duration_ms = started.elapsed().as_millis() as u64;
    result
}

fn service_context(
    service: &Service,
    slices: &[EndpointSlice],
    truncated: bool,
    error: Option<String>,
) -> NetworkServiceContext {
    let spec = service.spec.as_ref();
    let mut context = NetworkServiceContext {
        selector: spec.and_then(|s| s.selector.clone()).unwrap_or_default(),
        cluster_ip: spec.and_then(|s| s.cluster_ip.clone()),
        external_name: spec.and_then(|s| s.external_name.clone()),
        ready_endpoints: 0,
        unready_endpoints: 0,
        addresses: Vec::new(),
        endpoints_error: error,
        endpoints_truncated: truncated,
    };
    for endpoint in slices.iter().flat_map(|s| s.endpoints.iter().flatten()) {
        if endpoint.conditions.as_ref().and_then(|c| c.ready) == Some(false) {
            context.unready_endpoints += 1;
        } else {
            context.ready_endpoints += 1;
        }
        for address in &endpoint.addresses {
            if context.addresses.len() < 24 {
                context.addresses.push(address.clone());
            }
        }
    }
    context
}

impl Kubepit {
    pub(crate) async fn network_diagnostics_run_unaudited(
        &self,
        cluster_id: &str,
        request: &NetworkDiagnosticsRequest,
    ) -> Result<NetworkDiagnosticsReport> {
        self.ensure_writable(cluster_id, "running network diagnostics via Pod exec")
            .map_err(|error| {
                if error
                    .downcast_ref::<crate::error::ReadOnlyError>()
                    .is_some()
                {
                    anyhow!("network-diagnostics:read-only")
                } else {
                    error
                }
            })?;
        validate_request(request)?;
        let reads = async {
            let checks = self
                .access_review(
                    cluster_id,
                    vec![AccessCheck {
                        verb: "create".into(),
                        group: String::new(),
                        resource: "pods".into(),
                        subresource: Some("exec".into()),
                        namespace: Some(request.namespace.clone()),
                        name: Some(request.pod.clone()),
                    }],
                )
                .await?;
            let decision = checks
                .first()
                .ok_or_else(|| anyhow!("network-diagnostics:exec-permission"))?;
            if !decision.allowed || decision.error.is_some() {
                bail!("network-diagnostics:exec-permission");
            }
            let client = self.client(cluster_id).await?;
            let pods: Api<Pod> = Api::namespaced(client.clone(), &request.namespace);
            let pod = pods.get(&request.pod).await?;
            let running = pod
                .status
                .as_ref()
                .and_then(|s| s.container_statuses.as_ref())
                .is_some_and(|containers| {
                    containers.iter().any(|c| {
                        c.name == request.container
                            && c.state.as_ref().is_some_and(|s| s.running.is_some())
                    })
                });
            if !running {
                bail!("network-diagnostics:source-not-running");
            }
            let services: Api<Service> = Api::namespaced(client.clone(), &request.target_namespace);
            let service = services.get(&request.service).await?;
            let valid_port = service
                .spec
                .as_ref()
                .and_then(|s| s.ports.as_ref())
                .is_some_and(|ports| {
                    ports.iter().any(|p| {
                        p.port == i32::from(request.port)
                            && p.protocol.as_deref().unwrap_or("TCP") == "TCP"
                    })
                });
            if !valid_port {
                bail!("network-diagnostics:invalid-service-port");
            }
            let slices: Api<EndpointSlice> = Api::namespaced(client, &request.target_namespace);
            let listed = slices
                .list(
                    &ListParams::default()
                        .labels(&format!("kubernetes.io/service-name={}", request.service))
                        .limit(100),
                )
                .await;
            let context = match listed {
                Ok(list) => service_context(
                    &service,
                    &list.items,
                    list.metadata
                        .continue_
                        .as_ref()
                        .is_some_and(|c| !c.is_empty()),
                    None,
                ),
                Err(error) => service_context(&service, &[], false, Some(error.to_string())),
            };
            Ok::<_, anyhow::Error>((pods, context))
        };
        let (pods, service) = tokio::time::timeout(READ_TIMEOUT, reads)
            .await
            .map_err(|_| anyhow!("network-diagnostics:inspection-timeout"))??;
        let mut probes = Vec::new();
        for (kind, command) in probe_commands(request) {
            // Recheck immediately before each exec, including if the user
            // changed the cluster's protection while an earlier probe ran.
            self.ensure_writable(cluster_id, "running network diagnostics via Pod exec")
                .map_err(|error| {
                    if error
                        .downcast_ref::<crate::error::ReadOnlyError>()
                        .is_some()
                    {
                        anyhow!("network-diagnostics:read-only")
                    } else {
                        error
                    }
                })?;
            probes.push(probe(&pods, request, kind, command).await);
        }
        Ok(NetworkDiagnosticsReport {
            host: format!("{}.{}.svc", request.service, request.target_namespace),
            checked_at: chrono::Utc::now().to_rfc3339(),
            request: request.clone(),
            probes,
            service,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> NetworkDiagnosticsRequest {
        NetworkDiagnosticsRequest {
            namespace: "checkout".into(),
            pod: "api-123".into(),
            container: "app".into(),
            target_namespace: "checkout".into(),
            service: "payments".into(),
            port: 443,
            protocol: NetworkProbeProtocol::Https,
            path: "/health".into(),
        }
    }
    #[test]
    fn rejects_argument_injection_and_unbounded_targets() {
        for value in ["--help", "x;id", "x/y", "a b", "", "-x"] {
            let mut r = request();
            r.service = value.into();
            assert!(validate_request(&r).is_err());
        }
        for value in [
            "//other.host",
            "/?token=secret",
            "/#a",
            "/\n",
            "https://other.host",
            "/\\evil",
        ] {
            let mut r = request();
            r.path = value.into();
            assert!(validate_request(&r).is_err());
        }
        assert!(validate_request(&request()).is_ok());
    }
    #[test]
    fn commands_are_fixed_arrays_and_http_cannot_redirect_or_read_config() {
        let commands = probe_commands(&request());
        assert_eq!(commands.len(), 4);
        let http = &commands[3].1;
        assert_eq!(&http[..2], &["curl", "--disable"]);
        assert!(!http
            .iter()
            .any(|s| ["sh", "-c", "-L", "--location", "--insecure"].contains(&s.as_str())));
        assert_eq!(
            http.last().unwrap(),
            "https://payments.checkout.svc:443/health"
        );
        assert!(http.windows(2).any(|w| w == ["--output", "/dev/null"]));
        assert!(commands[2].1.iter().any(|s| s == "-verify_hostname"));
    }
    #[test]
    fn missing_or_incompatible_tools_are_not_network_failures() {
        assert_eq!(
            classify_output(Some(127), "timeout: nslookup: No such file or directory").0,
            NetworkProbeStatus::Unavailable
        );
        assert_eq!(
            classify_output(Some(1), "nc: invalid option -- z").1,
            "unsupported_tool"
        );
        assert_eq!(
            classify_output(Some(124), "").0,
            NetworkProbeStatus::TimedOut
        );
        assert_eq!(
            classify_output(Some(28), "curl: operation timed out").0,
            NetworkProbeStatus::TimedOut
        );
        assert_eq!(
            classify_output(Some(7), "Connection refused").0,
            NetworkProbeStatus::Failed
        );
        assert_eq!(classify_output(None, "").0, NetworkProbeStatus::Unavailable);
    }
    #[test]
    fn endpoint_context_preserves_not_ready_and_partial_information() {
        let service: Service = serde_json::from_value(serde_json::json!({"metadata":{"name":"payments"},"spec":{"selector":{"app":"payments"},"clusterIP":"10.0.0.1"}})).unwrap();
        let slice: EndpointSlice = serde_json::from_value(serde_json::json!({"metadata":{"name":"payments-1"},"addressType":"IPv4","endpoints":[{"addresses":["10.1.0.1"],"conditions":{"ready":true}},{"addresses":["10.1.0.2"],"conditions":{"ready":false}}]})).unwrap();
        let c = service_context(&service, &[slice], true, None);
        assert_eq!((c.ready_endpoints, c.unready_endpoints), (1, 1));
        assert!(c.endpoints_truncated);
        assert_eq!(c.selector.get("app").unwrap(), "payments");
        assert!(
            service_context(&service, &[], false, Some("Forbidden".into()))
                .endpoints_error
                .is_some()
        );
    }
    #[tokio::test]
    async fn read_only_rejected_before_connecting_or_validating() {
        let dir = tempfile::tempdir().unwrap();
        let app = Kubepit::open(
            crate::Paths::new(dir.path().join("home")),
            std::sync::Arc::new(crate::NullSink),
        )
        .unwrap();
        let clusters = app
            .cluster_add(vec![crate::types::ClusterInput {
                name: "fixture".into(),
                context: "dev".into(),
                read_only: true,
                kubeconfig_text: Some(crate::kubeconfig::tests::TWO_CONTEXTS.into()),
                ..Default::default()
            }])
            .unwrap();
        let error = app
            .network_diagnostics_run_unaudited(&clusters[0].id, &request())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("read-only"));
    }
}
