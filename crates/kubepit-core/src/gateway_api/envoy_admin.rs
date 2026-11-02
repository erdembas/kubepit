//! Read-only Envoy admin requests over an in-process port-forward.
//!
//! Envoy Gateway binds each proxy's admin listener to `127.0.0.1:19000`
//! inside the pod, out of reach of the API server's `pods/proxy`, so
//! [`admin_get`] opens `pods/portforward` to the pod and port (the user's
//! RBAC; no local listener, so no other local process can use it), sends
//! exactly one HTTP/1.1 GET over the stream ([`request_over`]) and closes
//! the forward. The path is one of a fixed set ([`admin_path`]), so Envoy's
//! mutating admin endpoints (`/quitquitquit`, `/drain_listeners`,
//! `/logging`, `/reset_counters`, `/healthcheck/fail`, `/runtime_modify`,
//! all POST) cannot be reached. Every HTTP status is an answer; transport
//! failures, timeouts and answers above [`MAX_BODY_BYTES`] are errors.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use http_body_util::{BodyExt, Empty, LengthLimitError, Limited};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use kube::Client;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{size_limit, EnvoyAdminEndpoint};
use crate::error::kube_error;
use crate::service_proxy::encode_component;

/// Envoy Gateway's admin port.
pub const DEFAULT_PORT: u16 = 19000;
/// Upper bound for opening the port-forward.
pub const SETUP_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound for the request and the whole answer.
pub const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest answer accepted (`/config_dump` of a big gateway is a few MB).
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// Longest `stats` filter.
pub const MAX_FILTER_CHARS: usize = 256;

/// One admin answer: the status and the raw body.
#[derive(Debug)]
pub(crate) struct AdminAnswer {
    pub status: u16,
    pub body: Bytes,
}

impl EnvoyAdminEndpoint {
    /// The fixed GET path of the endpoint (JSON where Envoy offers it).
    pub fn path(self) -> &'static str {
        match self {
            Self::ServerInfo => "/server_info",
            Self::ConfigDump => "/config_dump",
            Self::Clusters => "/clusters?format=json",
            Self::Listeners => "/listeners?format=json",
            Self::Stats => "/stats?format=json",
            Self::Ready => "/ready",
            Self::Certs => "/certs",
        }
    }
}

/// The request path of `endpoint`. `filter` (an Envoy stats regex) is
/// appended, percent-encoded, for `stats` only; blank means none. It may
/// hold at most [`MAX_FILTER_CHARS`] characters and no control characters.
pub fn admin_path(endpoint: EnvoyAdminEndpoint, filter: Option<&str>) -> Result<String> {
    let path = endpoint.path();
    let filter = filter.map(str::trim).unwrap_or_default();
    if endpoint != EnvoyAdminEndpoint::Stats || filter.is_empty() {
        return Ok(path.to_string());
    }
    if filter.chars().count() > MAX_FILTER_CHARS {
        bail!("the stats filter is longer than {MAX_FILTER_CHARS} characters");
    }
    if filter.chars().any(char::is_control) {
        bail!("the stats filter must be a single line without control characters");
    }
    Ok(format!("{path}&filter={}", encode_component(filter)))
}

/// A DNS-1123 label (namespace names).
fn dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

/// A DNS-1123 subdomain (pod names): dot-separated labels, at most 253
/// characters.
fn dns_subdomain(value: &str) -> bool {
    value.len() <= 253 && value.split('.').all(dns_label)
}

/// Check the target pod and return the admin port (default
/// [`DEFAULT_PORT`]).
pub fn validate_target(namespace: &str, pod: &str, port: Option<u16>) -> Result<u16> {
    if !dns_label(namespace) {
        bail!("invalid namespace {namespace:?}");
    }
    if !dns_subdomain(pod) {
        bail!("invalid pod name {pod:?}");
    }
    match port.unwrap_or(DEFAULT_PORT) {
        0 => bail!("the admin port must be between 1 and 65535"),
        port => Ok(port),
    }
}

/// One HTTP/1.1 GET of `path` over `stream` with `Host: 127.0.0.1:{port}`
/// and `Accept: application/json`, within `timeout`, reading at most
/// `max_body` bytes of the answer.
pub(crate) async fn request_over<S>(
    stream: S,
    port: u16,
    path: &str,
    timeout: Duration,
    max_body: usize,
) -> Result<AdminAnswer>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let request = http::Request::get(path)
        .header(http::header::HOST, format!("127.0.0.1:{port}"))
        .header(http::header::ACCEPT, "application/json")
        .body(Empty::<Bytes>::new())
        .map_err(|e| anyhow!("invalid Envoy admin request: {e}"))?;
    let failed = |e: hyper::Error| anyhow!("request to the Envoy admin API failed: {e}");
    let exchange = async {
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(failed)?;
        let driver = tokio::spawn(connection);
        let answer = async {
            let response = sender.send_request(request).await.map_err(failed)?;
            let status = response.status().as_u16();
            let body = Limited::new(response.into_body(), max_body)
                .collect()
                .await
                .map_err(|e| {
                    if e.downcast_ref::<LengthLimitError>().is_some() {
                        anyhow!(
                            "the Envoy admin answer is larger than {}",
                            size_limit(max_body as u64)
                        )
                    } else {
                        anyhow!("reading the Envoy admin answer failed: {e}")
                    }
                })?
                .to_bytes();
            Ok::<_, anyhow::Error>(AdminAnswer { status, body })
        }
        .await;
        driver.abort();
        answer
    };
    tokio::time::timeout(timeout, exchange).await.map_err(|_| {
        anyhow!(
            "the Envoy admin API did not answer within {}s",
            timeout.as_secs()
        )
    })?
}

/// GET `path` from the Envoy admin listener on `port` of `namespace/pod`
/// over a port-forward, opened within [`SETUP_TIMEOUT`] and closed after
/// the answer. When the exchange fails, the pod side's forward error (for
/// example "connection refused": nothing listens on that port) is named.
pub(crate) async fn admin_get(
    client: &Client,
    namespace: &str,
    pod: &str,
    port: u16,
    path: &str,
) -> Result<AdminAnswer> {
    let target = format!("pod {namespace}/{pod}:{port}");
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let mut forwarder = tokio::time::timeout(SETUP_TIMEOUT, pods.portforward(pod, &[port]))
        .await
        .map_err(|_| anyhow!("port-forward to {target} timed out"))?
        .map_err(kube_error)
        .with_context(|| format!("port-forward to {target} failed"))?;
    let Some(stream) = forwarder.take_stream(port) else {
        forwarder.abort();
        bail!("port-forward stream to {target} is unavailable");
    };
    let pod_error = forwarder.take_error(port);
    let result = match request_over(stream, port, path, EXCHANGE_TIMEOUT, MAX_BODY_BYTES).await {
        Err(e) => {
            let detail = match pod_error {
                Some(rx) => tokio::time::timeout(Duration::from_millis(200), rx)
                    .await
                    .ok()
                    .flatten(),
                None => None,
            };
            Err(match detail {
                Some(detail) => e.context(format!("port-forward to {target}: {detail}")),
                None => e.context(format!("over the port-forward to {target}")),
            })
        }
        ok => ok,
    };
    forwarder.abort();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const ALL: [EnvoyAdminEndpoint; 7] = [
        EnvoyAdminEndpoint::ServerInfo,
        EnvoyAdminEndpoint::ConfigDump,
        EnvoyAdminEndpoint::Clusters,
        EnvoyAdminEndpoint::Listeners,
        EnvoyAdminEndpoint::Stats,
        EnvoyAdminEndpoint::Ready,
        EnvoyAdminEndpoint::Certs,
    ];

    #[test]
    fn endpoints_map_to_fixed_read_only_paths() {
        let paths: Vec<String> = ALL.iter().map(|e| admin_path(*e, None).unwrap()).collect();
        assert_eq!(
            paths,
            [
                "/server_info",
                "/config_dump",
                "/clusters?format=json",
                "/listeners?format=json",
                "/stats?format=json",
                "/ready",
                "/certs",
            ]
        );
        for mutating in [
            "/quitquitquit",
            "/drain_listeners",
            "/logging",
            "/reset_counters",
            "/healthcheck",
            "/runtime_modify",
        ] {
            assert!(paths.iter().all(|p| !p.starts_with(mutating)), "{mutating}");
        }
    }

    #[test]
    fn stats_filters_are_encoded_and_bounded() {
        let stats = |filter: &str| admin_path(EnvoyAdminEndpoint::Stats, Some(filter));
        assert_eq!(
            stats(r"^cluster\..*upstream_rq$").unwrap(),
            "/stats?format=json&filter=%5Ecluster%5C..%2Aupstream_rq%24"
        );
        // No other parameter can be smuggled in.
        assert_eq!(
            stats("http&usedonly=1#x").unwrap(),
            "/stats?format=json&filter=http%26usedonly%3D1%23x"
        );
        assert_eq!(
            stats("  listener  ").unwrap(),
            "/stats?format=json&filter=listener"
        );
        assert_eq!(stats("   ").unwrap(), "/stats?format=json");
        assert!(stats(&"a".repeat(MAX_FILTER_CHARS)).is_ok());
        let err = stats(&"a".repeat(MAX_FILTER_CHARS + 1)).unwrap_err();
        assert!(err.to_string().contains("longer than 256"), "{err}");
        for bad in ["a\nb", "a\rb", "a\u{0}b", "a\tb"] {
            let err = stats(bad).unwrap_err();
            assert!(
                err.to_string().contains("control characters"),
                "{bad:?}: {err}"
            );
        }
        // Other endpoints ignore the filter, even an invalid one.
        assert_eq!(
            admin_path(EnvoyAdminEndpoint::ConfigDump, Some("a\nb")).unwrap(),
            "/config_dump"
        );
    }

    #[test]
    fn targets_are_validated() {
        let pod = "envoy-default-eg-e41e7b31-6c8b7d9d5-x7k2p";
        assert_eq!(
            validate_target("envoy-gateway-system", pod, None).unwrap(),
            DEFAULT_PORT
        );
        assert_eq!(validate_target("ns", "a.b", Some(15000)).unwrap(), 15000);
        assert_eq!(validate_target("ns", "a", Some(65535)).unwrap(), 65535);
        let err = validate_target("ns", pod, Some(0)).unwrap_err();
        assert!(err.to_string().contains("between 1 and 65535"), "{err}");
        let (long_namespace, long_pod) = ("a".repeat(64), "a".repeat(254));
        for namespace in [
            "",
            "Envoy",
            "-a",
            "a-",
            "a.b",
            "a/b",
            long_namespace.as_str(),
        ] {
            let err = validate_target(namespace, pod, None).unwrap_err();
            assert!(err.to_string().contains("invalid namespace"), "{namespace}");
        }
        for name in [
            "",
            "a/b",
            "../x",
            "a..b",
            ".a",
            "a b",
            "A",
            long_pod.as_str(),
        ] {
            let err = validate_target("ns", name, None).unwrap_err();
            assert!(err.to_string().contains("invalid pod name"), "{name}");
        }
        let long = [
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61),
        ]
        .join(".");
        assert_eq!(long.len(), 253);
        assert!(validate_target("ns", &long, None).is_ok());
    }

    /// Read one request head from `server`, answer `reply`, return the head.
    async fn serve_once(mut server: tokio::io::DuplexStream, reply: Vec<u8>) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if server.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            head.push(byte[0]);
        }
        // The client may hang up early (a capped body).
        let _ = server.write_all(&reply).await;
        let _ = server.flush().await;
        String::from_utf8(head).unwrap()
    }

    fn reply(status: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    async fn get(path: &str, answer: Vec<u8>, max_body: usize) -> (Result<AdminAnswer>, String) {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let served = tokio::spawn(serve_once(server, answer));
        let result = request_over(client, 19000, path, Duration::from_secs(5), max_body).await;
        (result, served.await.unwrap())
    }

    #[tokio::test]
    async fn one_get_with_the_loopback_host() {
        let path = admin_path(EnvoyAdminEndpoint::Stats, Some("http")).unwrap();
        let (answer, head) = get(&path, reply("200 OK", r#"{"stats":[]}"#), 1024).await;
        let answer = answer.unwrap();
        assert!(
            head.starts_with("GET /stats?format=json&filter=http HTTP/1.1\r\n"),
            "{head}"
        );
        assert!(head.contains("host: 127.0.0.1:19000\r\n"), "{head}");
        assert!(head.contains("accept: application/json\r\n"), "{head}");
        assert_eq!(answer.status, 200);
        assert_eq!(&answer.body[..], br#"{"stats":[]}"#);
    }

    #[tokio::test]
    async fn non_2xx_statuses_are_answers() {
        let (answer, _) = get("/ready", reply("503 Service Unavailable", "DRAINING"), 1024).await;
        let answer = answer.unwrap();
        assert_eq!(answer.status, 503);
        assert_eq!(&answer.body[..], b"DRAINING");
    }

    #[tokio::test]
    async fn bodies_are_capped() {
        let body = "x".repeat(64);
        let (answer, _) = get("/config_dump", reply("200 OK", &body), 64).await;
        assert_eq!(answer.unwrap().body.len(), 64);
        let (answer, _) = get("/config_dump", reply("200 OK", &body), 16).await;
        let err = answer.unwrap_err().to_string();
        assert!(
            err.contains("the Envoy admin answer is larger than 16 bytes"),
            "{err}"
        );
        // Without a Content-Length too (chunked).
        let chunked = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n{}\r\n10\r\n{}\r\n0\r\n\r\n",
            "a".repeat(16),
            "b".repeat(16)
        );
        let (answer, _) = get("/config_dump", chunked.into_bytes(), 20).await;
        let err = answer.unwrap_err().to_string();
        assert!(err.contains("larger than 20 bytes"), "{err}");
        assert_eq!(size_limit(MAX_BODY_BYTES as u64), "32 MiB");
    }

    #[tokio::test]
    async fn silent_admins_time_out() {
        let (client, _server) = tokio::io::duplex(1024);
        let err = request_over(client, 19000, "/ready", Duration::from_millis(100), 1024)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("did not answer within"), "{err}");
    }

    #[tokio::test]
    async fn a_closed_stream_is_an_error() {
        let (client, server) = tokio::io::duplex(1024);
        drop(server);
        let err = request_over(client, 19000, "/ready", Duration::from_secs(5), 1024)
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("request to the Envoy admin API failed"),
            "{err}"
        );
    }
}
