//! On-demand, bounded connection checks. This client is never put in the pool:
//! diagnosing a disconnected cluster must not start watches or write credentials.
//! Reports contain fixed codes only, never kubeconfig, helper output or API errors.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures::future::join_all;
use k8s_openapi::api::authentication::v1::SelfSubjectReview;
use k8s_openapi::api::authorization::v1::SelfSubjectAccessReview;
use kube::api::{Api, PostParams};
use kube::config::{AuthInfo, ExecConfig, ExecInteractiveMode, KubeConfigOptions};
use kube::{Client, Config};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::time::timeout;

use crate::access::access_review_request;
use crate::objects::now_millis;
use crate::types::AccessCheck;
use crate::Kubepit;

const LOCAL_TIMEOUT: Duration = Duration::from_secs(5);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(4);
const AUTH_TIMEOUT: Duration = Duration::from_secs(8);
const API_TIMEOUT: Duration = Duration::from_secs(8);
const REVIEW_TIMEOUT: Duration = Duration::from_secs(3);
const AUTH_OUTPUT_CAP: u64 = 1024 * 1024;
const STAGES: [&str; 7] = [
    "kubeconfig",
    "auth-helper",
    "network",
    "tls",
    "api",
    "authentication",
    "permissions",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionDoctorStep {
    pub stage: String,
    /// `passed` | `warning` | `failed` | `skipped`.
    pub status: String,
    pub code: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionDoctorCapability {
    /// Stable capability ID; translated by the UI.
    pub id: String,
    pub allowed: Option<bool>,
    pub blocked_by_read_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionDoctorTool {
    pub id: String,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionDoctorReport {
    pub cluster_id: String,
    pub namespace: String,
    pub checked_at: i64,
    pub elapsed_ms: u64,
    pub steps: Vec<ConnectionDoctorStep>,
    pub capabilities: Vec<ConnectionDoctorCapability>,
    pub tools: Vec<ConnectionDoctorTool>,
    /// Actual API discovery, separately from permission to list its pod metrics.
    pub metrics_api: String,
}

impl ConnectionDoctorReport {
    fn step(&mut self, stage: &str, status: &str, code: &str) {
        self.steps.push(ConnectionDoctorStep {
            stage: stage.into(),
            status: status.into(),
            code: code.into(),
        });
    }

    fn finish(mut self, start: Instant) -> Self {
        for stage in STAGES {
            if !self.steps.iter().any(|s| s.stage == stage) {
                self.step(stage, "skipped", "previous-step-failed");
            }
        }
        self.steps
            .sort_by_key(|s| STAGES.iter().position(|stage| *stage == s.stage));
        self.elapsed_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
        self
    }
}

fn valid_namespace(namespace: &str) -> bool {
    !namespace.is_empty()
        && namespace.len() <= 63
        && namespace
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !namespace.starts_with('-')
        && !namespace.ends_with('-')
}

fn executable(exec: &ExecConfig) -> Option<PathBuf> {
    let command = exec.command.as_deref()?;
    let path = crate::tools::find_executable(command, None)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.metadata().ok()?.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(path)
}

/// Only an explicitly-created, valid child group can be signalled. Auth helpers
/// occasionally leave a child holding stdout; those children share the bound.
struct AuthGroup(Option<u32>);
impl Drop for AuthGroup {
    fn drop(&mut self) {
        #[cfg(not(unix))]
        let _ = self.0;
        #[cfg(unix)]
        if let Some(group) = self.0.filter(|p| *p > 1 && *p <= i32::MAX as u32) {
            // SAFETY: our command used process_group(0); never signal group 0/1.
            unsafe {
                libc::kill(-(group as i32), libc::SIGKILL);
            }
        }
    }
}

/// kube-rs runs exec auth synchronously. Resolve it explicitly with bounded
/// output/time first, so Client construction cannot launch an unbounded helper.
async fn prepare_auth(
    auth: &mut AuthInfo,
    limit: Duration,
) -> std::result::Result<&'static str, &'static str> {
    let Some(exec) = auth.exec.clone() else {
        // Legacy providers may launch their own unbounded synchronous commands.
        return if auth.auth_provider.is_some() {
            Err("legacy-auth-provider")
        } else {
            Ok("no-auth-helper")
        };
    };
    let path = executable(&exec).ok_or("auth-helper-missing")?;
    if !matches!(
        exec.api_version.as_deref(),
        Some("client.authentication.k8s.io/v1" | "client.authentication.k8s.io/v1beta1")
    ) {
        return Err("auth-helper-failed");
    }
    if exec.interactive_mode == Some(ExecInteractiveMode::Always) {
        return Err("auth-interactive");
    }
    let mut command = tokio::process::Command::new(path);
    command
        .args(exec.args.as_deref().unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    if let Some(envs) = &exec.env {
        for env in envs {
            if let (Some(name), Some(value)) = (env.get("name"), env.get("value")) {
                command.env(name, value);
            }
        }
    }
    if let Some(names) = &exec.drop_env {
        for name in names {
            command.env_remove(name);
        }
    }
    let mut spec = json!({"interactive": false});
    if exec.provide_cluster_info {
        spec["cluster"] = serde_json::to_value(exec.cluster.as_ref().ok_or("auth-helper-failed")?)
            .map_err(|_| "auth-helper-failed")?;
    }
    command.env(
        "KUBERNETES_EXEC_INFO",
        json!({
            "apiVersion": exec.api_version, "kind": "ExecCredential", "spec": spec,
        })
        .to_string(),
    );
    let mut child = command.spawn().map_err(|_| "auth-helper-failed")?;
    let _group = AuthGroup(child.id());
    let stdout = child.stdout.take().ok_or("auth-helper-failed")?;
    let task = async {
        let mut bytes = Vec::new();
        stdout
            .take(AUTH_OUTPUT_CAP + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "auth-helper-failed")?;
        if bytes.len() as u64 > AUTH_OUTPUT_CAP {
            return Err("auth-helper-failed");
        }
        if !child
            .wait()
            .await
            .map_err(|_| "auth-helper-failed")?
            .success()
        {
            return Err("auth-helper-failed");
        }
        // Support JSON and YAML credentials, as kube-rs does, without surfacing
        // parser errors (which can contain the credential source text).
        let value: Value = serde_yaml::from_slice(&bytes).map_err(|_| "auth-helper-failed")?;
        apply_exec_credentials(auth, &exec, value)?;
        Ok("auth-helper-ready")
    };
    timeout(limit, task)
        .await
        .map_err(|_| "auth-helper-timeout")?
}

fn apply_exec_credentials(
    auth: &mut AuthInfo,
    exec: &ExecConfig,
    value: Value,
) -> std::result::Result<(), &'static str> {
    if value["kind"] != "ExecCredential"
        || value["apiVersion"].as_str() != exec.api_version.as_deref()
    {
        return Err("auth-helper-failed");
    }
    if let Some(expiry) = value
        .pointer("/status/expirationTimestamp")
        .and_then(Value::as_str)
    {
        let expiry =
            chrono::DateTime::parse_from_rfc3339(expiry).map_err(|_| "auth-helper-failed")?;
        if expiry <= chrono::Utc::now() {
            return Err("auth-expired");
        }
    }
    let token = value
        .pointer("/status/token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let cert = value
        .pointer("/status/clientCertificateData")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let key = value
        .pointer("/status/clientKeyData")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if token.is_none() && !(cert.is_some() && key.is_some()) {
        return Err("auth-helper-failed");
    }
    auth.exec = None;
    auth.auth_provider = None;
    if let Some(token) = token {
        auth.token = Some(token.to_owned().into());
    }
    if let (Some(cert), Some(key)) = (cert, key) {
        auth.client_certificate_data = Some(STANDARD.encode(cert));
        auth.client_key_data = Some(STANDARD.encode(key).into());
    }
    Ok(())
}

/// Fixed codes only; the complete error chain is inspected but never emitted.
fn api_error_code(error: &kube::Error) -> &'static str {
    if let kube::Error::Api(status) = error {
        return match status.code {
            401 => "unauthorized",
            403 => "forbidden",
            _ => "api-failed",
        };
    }
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = cause {
        let text = error.to_string().to_ascii_lowercase();
        if [
            "certificate",
            "tls",
            "unknownissuer",
            "invalidpeer",
            "certvalid",
        ]
        .iter()
        .any(|s| text.contains(s))
        {
            return "tls-failed";
        }
        cause = error.source();
    }
    "api-unreachable"
}

async fn network(config: &Config) -> std::result::Result<&'static str, &'static str> {
    // Config includes kubeconfig/explicit proxy plus kube-rs' environment fallback.
    // Resolve the proxy endpoint, never the private cluster hostname, when proxied.
    let endpoint = config.proxy_url.as_ref().unwrap_or(&config.cluster_url);
    let host = endpoint
        .host()
        .ok_or("endpoint-invalid")?
        .trim_matches(['[', ']']);
    let port = endpoint
        .port_u16()
        .unwrap_or_else(|| match endpoint.scheme_str() {
            Some("https") => 443,
            Some("socks5" | "socks5h") => 1080,
            _ => 80,
        });
    let addresses: Vec<_> = timeout(NETWORK_TIMEOUT, tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| "network-timeout")?
        .map_err(|_| "dns-failed")?
        .take(8)
        .collect();
    if addresses.is_empty() {
        return Err("dns-failed");
    }
    timeout(
        NETWORK_TIMEOUT,
        tokio::net::TcpStream::connect(addresses.as_slice()),
    )
    .await
    .map_err(|_| "network-timeout")?
    .map_err(|_| "tcp-failed")?;
    Ok(if config.proxy_url.is_some() {
        "proxy-reachable"
    } else {
        "endpoint-reachable"
    })
}

fn checks(namespace: &str) -> Vec<(&'static str, bool, AccessCheck)> {
    [
        ("namespaces", false, "list", "", "namespaces", None, None),
        ("pods", false, "list", "", "pods", None, Some(namespace)),
        ("watches", false, "watch", "", "pods", None, Some(namespace)),
        (
            "logs",
            false,
            "get",
            "",
            "pods",
            Some("log"),
            Some(namespace),
        ),
        (
            "metrics",
            false,
            "list",
            "metrics.k8s.io",
            "pods",
            None,
            Some(namespace),
        ),
        ("helm", false, "list", "", "secrets", None, Some(namespace)),
        (
            "exec",
            true,
            "create",
            "",
            "pods",
            Some("exec"),
            Some(namespace),
        ),
        (
            "rollouts",
            true,
            "patch",
            "apps",
            "deployments",
            None,
            Some(namespace),
        ),
    ]
    .into_iter()
    .map(|(id, mutating, verb, group, resource, subresource, ns)| {
        (
            id,
            mutating,
            AccessCheck {
                verb: verb.into(),
                group: group.into(),
                resource: resource.into(),
                subresource: subresource.map(str::to_string),
                namespace: ns.map(str::to_string),
                name: None,
            },
        )
    })
    .collect()
}

impl Kubepit {
    pub async fn connection_doctor_run(
        &self,
        cluster_id: &str,
        namespace: Option<&str>,
    ) -> Result<ConnectionDoctorReport> {
        let start = Instant::now();
        let cluster = self.cluster_def(cluster_id)?;
        let namespace = namespace
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(cluster.default_namespace.as_deref())
            .or_else(|| cluster.accessible_namespaces.first().map(String::as_str))
            .unwrap_or("default");
        let mut report = ConnectionDoctorReport {
            cluster_id: cluster_id.into(),
            namespace: namespace.into(),
            checked_at: now_millis(),
            elapsed_ms: 0,
            steps: Vec::new(),
            capabilities: Vec::new(),
            tools: Vec::new(),
            metrics_api: "unchecked".into(),
        };
        let settings = self.settings();
        for (id, override_path) in [
            ("kubectl", settings.kubectl_path.as_deref()),
            ("helm", settings.helm_path.as_deref()),
        ] {
            report.tools.push(ConnectionDoctorTool {
                id: id.into(),
                available: crate::tools::find_executable(id, override_path).is_some(),
            });
        }
        if !valid_namespace(namespace) {
            report.step("kubeconfig", "failed", "namespace-invalid");
            return Ok(report.finish(start));
        }
        let config = async {
            let single = self
                .cluster_kubeconfig_async(&cluster)
                .await
                .map_err(|_| ())?;
            Config::from_custom_kubeconfig(
                single,
                &KubeConfigOptions {
                    context: Some(cluster.context.clone()),
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| ())
        };
        let mut config = match timeout(LOCAL_TIMEOUT, config).await {
            Ok(Ok(config)) => config,
            _ => {
                report.step("kubeconfig", "failed", "kubeconfig-invalid");
                return Ok(report.finish(start));
            }
        };
        report.step("kubeconfig", "passed", "kubeconfig-ready");
        match prepare_auth(&mut config.auth_info, AUTH_TIMEOUT).await {
            Ok(code) => report.step("auth-helper", "passed", code),
            Err(code) => {
                report.step("auth-helper", "failed", code);
                return Ok(report.finish(start));
            }
        }
        match network(&config).await {
            Ok(code) => report.step("network", "passed", code),
            Err(code) => {
                report.step("network", "failed", code);
                return Ok(report.finish(start));
            }
        }
        let tls = if config.cluster_url.scheme_str() != Some("https") {
            "tls-not-used"
        } else if config.accept_invalid_certs {
            "tls-unverified"
        } else {
            "tls-verified"
        };
        config.connect_timeout = Some(NETWORK_TIMEOUT);
        config.read_timeout = Some(API_TIMEOUT);
        config.write_timeout = Some(API_TIMEOUT);
        config.default_retry = false;
        let client = match Client::try_from(config) {
            Ok(client) => client,
            Err(_) => {
                report.step("tls", "failed", "client-invalid");
                return Ok(report.finish(start));
            }
        };
        let api_result = timeout(API_TIMEOUT, client.apiserver_version()).await;
        let code = match &api_result {
            Ok(Ok(_)) => "api-ready",
            Ok(Err(error)) => api_error_code(error),
            Err(_) => "api-timeout",
        };
        if matches!(
            code,
            "api-ready" | "forbidden" | "unauthorized" | "api-failed"
        ) {
            report.step(
                "tls",
                if tls == "tls-verified" {
                    "passed"
                } else {
                    "warning"
                },
                tls,
            );
        } else {
            report.step(
                "tls",
                if code == "tls-failed" {
                    "failed"
                } else {
                    "skipped"
                },
                if code == "tls-failed" {
                    code
                } else {
                    "tls-unknown"
                },
            );
        }
        report.step(
            "api",
            if code == "api-ready" {
                "passed"
            } else if code == "forbidden" {
                "warning"
            } else {
                "failed"
            },
            code,
        );
        if code == "unauthorized" {
            report.step("authentication", "failed", code);
            return Ok(report.finish(start));
        }
        if !matches!(code, "api-ready" | "forbidden") {
            return Ok(report.finish(start));
        }
        let identity: Api<SelfSubjectReview> = Api::all(client.clone());
        let identity = timeout(
            REVIEW_TIMEOUT,
            identity.create(&PostParams::default(), &SelfSubjectReview::default()),
        )
        .await;
        match identity {
            Ok(Ok(identity)) => {
                let username = identity
                    .status
                    .and_then(|s| s.user_info)
                    .and_then(|u| u.username);
                if username.as_deref() == Some("system:anonymous") {
                    report.step("authentication", "failed", "anonymous");
                } else if username.is_some() {
                    report.step("authentication", "passed", "identity-confirmed");
                } else {
                    report.step("authentication", "warning", "identity-unavailable");
                }
            }
            Ok(Err(error)) if api_error_code(&error) == "unauthorized" => {
                report.step("authentication", "failed", "unauthorized")
            }
            _ => report.step("authentication", "warning", "identity-unavailable"),
        }
        let reviews = checks(namespace).into_iter().map(|(id, mutating, check)| {
            let api: Api<SelfSubjectAccessReview> = Api::all(client.clone());
            async move {
                let allowed = timeout(
                    REVIEW_TIMEOUT,
                    api.create(&PostParams::default(), &access_review_request(&check)),
                )
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|review| review.status)
                .filter(|status| status.evaluation_error.as_deref().is_none_or(str::is_empty))
                .map(|status| status.allowed);
                ConnectionDoctorCapability {
                    id: id.into(),
                    allowed,
                    blocked_by_read_only: mutating && cluster.read_only,
                }
            }
        });
        report.capabilities = join_all(reviews).await;
        report.metrics_api = match timeout(
            REVIEW_TIMEOUT,
            client.list_api_group_resources("metrics.k8s.io/v1beta1"),
        )
        .await
        {
            Ok(Ok(resources)) if resources.resources.iter().any(|r| r.name == "pods") => {
                "available"
            }
            Ok(Ok(_)) => "missing",
            Ok(Err(kube::Error::Api(status))) if status.code == 404 => "missing",
            _ => "unavailable",
        }
        .into();
        let unavailable = report.capabilities.iter().any(|c| c.allowed.is_none());
        let restricted = report
            .capabilities
            .iter()
            .any(|c| c.allowed == Some(false) || c.blocked_by_read_only);
        report.step(
            "permissions",
            if unavailable || restricted {
                "warning"
            } else {
                "passed"
            },
            if unavailable {
                "permissions-incomplete"
            } else if restricted {
                "permissions-limited"
            } else {
                "permissions-ready"
            },
        );
        Ok(report.finish(start))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_namespace_injection_and_preserves_scopes() {
        for invalid in ["a/b", "*", "UPPER", "-start", "end-", ""] {
            assert!(!valid_namespace(invalid));
        }
        assert!(valid_namespace("team-a"));
        let checks = checks("team-a");
        assert_eq!(checks.len(), 8);
        assert!(checks[0].2.namespace.is_none());
        assert!(checks[1..]
            .iter()
            .all(|(_, _, c)| c.namespace.as_deref() == Some("team-a")));
    }

    #[test]
    fn accepts_exec_credentials_only_with_matching_protocol_and_live_expiry() {
        let exec = ExecConfig {
            api_version: Some("client.authentication.k8s.io/v1".into()),
            ..Default::default()
        };
        let mut auth = AuthInfo {
            exec: Some(exec.clone()),
            ..Default::default()
        };
        let good = json!({"kind":"ExecCredential", "apiVersion":exec.api_version, "status":{"token":"fixture-secret"}});
        apply_exec_credentials(&mut auth, &exec, good.clone()).unwrap();
        assert!(auth.exec.is_none());
        assert!(auth.token.is_some());
        let mut expired = good.clone();
        expired["status"]["expirationTimestamp"] = json!("2000-01-01T00:00:00Z");
        assert_eq!(
            apply_exec_credentials(&mut auth, &exec, expired),
            Err("auth-expired")
        );
        let mut wrong = good;
        wrong["apiVersion"] = json!("wrong");
        assert_eq!(
            apply_exec_credentials(&mut auth, &exec, wrong),
            Err("auth-helper-failed")
        );
    }

    #[cfg(unix)]
    fn fixture_helper(script: &str) -> (tempfile::TempDir, AuthInfo) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth-helper");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let auth = AuthInfo {
            exec: Some(ExecConfig {
                api_version: Some("client.authentication.k8s.io/v1".into()),
                command: Some(path.to_string_lossy().into_owned()),
                interactive_mode: Some(ExecInteractiveMode::Never),
                ..Default::default()
            }),
            ..Default::default()
        };
        (dir, auth)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn helper_timeout_is_bounded_and_failure_output_is_not_returned() {
        let (_dir, mut auth) = fixture_helper("exec sleep 30");
        let start = Instant::now();
        assert_eq!(
            prepare_auth(&mut auth, Duration::from_millis(50)).await,
            Err("auth-helper-timeout")
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        let (_dir, mut auth) =
            fixture_helper("echo fixture-secret >&2; echo fixture-secret; exit 1");
        assert_eq!(
            prepare_auth(&mut auth, Duration::from_secs(2)).await,
            Err("auth-helper-failed")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn helper_output_cap_and_exec_info_are_enforced() {
        let (_dir, mut auth) = fixture_helper("head -c 1048577 /dev/zero");
        assert_eq!(
            prepare_auth(&mut auth, Duration::from_secs(2)).await,
            Err("auth-helper-failed")
        );
        let (_dir, mut auth) = fixture_helper(
            r#"case "$KUBERNETES_EXEC_INFO" in *'"interactive":false'*) ;; *) exit 1 ;; esac
printf '%s' '{"kind":"ExecCredential","apiVersion":"client.authentication.k8s.io/v1","status":{"token":"fixture-auth-token"}}'"#,
        );
        assert_eq!(
            prepare_auth(&mut auth, Duration::from_secs(2)).await,
            Ok("auth-helper-ready")
        );
        assert!(auth.exec.is_none() && auth.token.is_some());
    }
}
