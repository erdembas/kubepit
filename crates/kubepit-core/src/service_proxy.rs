//! Requests to in-cluster HTTP APIs (Prometheus, Loki) through the API
//! server's service proxy:
//!
//! ```text
//! /api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy{prefix}{endpoint}?…
//! ```
//!
//! The cluster's own credentials are used, so no port-forward is needed,
//! credentials never leave the kubeconfig and RBAC applies (the user needs
//! `get` on `services/proxy`). This module holds what every such
//! integration shares: path building, the GET transport with a timeout, the
//! error of a proxy answer, a retry-free client per connection, service
//! listing for detection and the validation of hand-configured services.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use k8s_openapi::api::core::v1::Service;
use kube::api::{Api, ListParams};
use kube::client::Body;
use kube::config::KubeConfigOptions;
use kube::Client;
use parking_lot::Mutex;

use crate::app::Kubepit;
use crate::error::{api_code, kube_error, ApiError};
use crate::kubeconfig;
use crate::types::{ClusterDef, PromScheme};

/// `ApiError::reason` of errors from the proxy path (API server, service).
pub const PROXY_REASON: &str = "ServiceProxy";
/// Longest error body quoted in a message.
pub const MAX_ERROR_BODY: usize = 300;

/// The service a request goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Endpoint<'a> {
    pub namespace: &'a str,
    pub service: &'a str,
    pub port: u16,
    pub scheme: PromScheme,
    /// `""` or `/prefix` (no trailing slash needed).
    pub path_prefix: &'a str,
}

/// Percent-encode everything but RFC 3986 unreserved characters.
pub fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `/api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy{prefix}`.
pub fn proxy_base(endpoint: &Endpoint<'_>) -> String {
    let scheme = match endpoint.scheme {
        PromScheme::Http => "http",
        PromScheme::Https => "https",
    };
    format!(
        "/api/v1/namespaces/{}/services/{scheme}:{}:{}/proxy{}",
        encode_component(endpoint.namespace),
        encode_component(endpoint.service),
        endpoint.port,
        endpoint.path_prefix.trim_end_matches('/'),
    )
}

/// Full request path of `path` (`/api/v1/query_range`) with `params`.
pub fn proxy_path(endpoint: &Endpoint<'_>, path: &str, params: &[(&str, String)]) -> String {
    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", encode_component(k), encode_component(v)))
        .collect::<Vec<_>>()
        .join("&");
    let base = proxy_base(endpoint);
    if query.is_empty() {
        format!("{base}{path}")
    } else {
        format!("{base}{path}?{query}")
    }
}

/// Status and body of an answer (any status code).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawResponse {
    pub status: u16,
    pub body: String,
}

impl RawResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The GET request of `path` with extra `headers` (`what` names the service
/// in errors, e.g. "Prometheus").
pub fn get_request(
    path: &str,
    headers: &[(&str, &str)],
    what: &str,
) -> Result<http::Request<Body>> {
    let mut builder = http::Request::get(path).header(http::header::ACCEPT, "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder
        .body(Body::from(Vec::new()))
        .map_err(|e| anyhow!("invalid {what} request: {e}"))
}

/// GET `path` within `timeout`. Every status code is an answer; only
/// transport failures and timeouts are errors.
pub async fn get(
    client: &Client,
    path: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
    what: &str,
) -> Result<RawResponse> {
    let request = get_request(path, headers, what)?;
    let exchange = async {
        let response = client.send(request).await?;
        let status = response.status();
        let bytes = response.into_body().collect_bytes().await?;
        Ok::<_, kube::Error>((status, bytes))
    };
    let (status, bytes) = tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| anyhow!("{what} did not answer within {}s", timeout.as_secs()))?
        .map_err(|e| anyhow!("request to {what} failed: {e}"))?;
    Ok(RawResponse {
        status: status.as_u16(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// The `message` of a Kubernetes `Status` body (proxy errors).
pub fn status_message(body: &str) -> Option<String> {
    let status: serde_json::Value = serde_json::from_str(body).ok()?;
    if status.get("kind")?.as_str()? != "Status" {
        return None;
    }
    let message = status.get("message")?.as_str()?;
    (!message.is_empty()).then(|| message.to_string())
}

/// `HTTP {code}: {body…}` (shortened), or `HTTP {code}` for an empty body.
pub fn short_body(code: u16, body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        format!("HTTP {code}")
    } else {
        let short: String = body.chars().take(MAX_ERROR_BODY).collect();
        format!("HTTP {code}: {short}")
    }
}

/// The error of a non-2xx answer that did not come from the service's own
/// API: the API server's `Status` message, or the (shortened) body.
pub fn proxy_error(code: u16, body: &str) -> ApiError {
    ApiError {
        code,
        reason: PROXY_REASON.to_string(),
        message: status_message(body).unwrap_or_else(|| short_body(code, body)),
    }
}

/// The proxy could not reach the service (gone, no endpoints), as opposed
/// to the service rejecting a query.
pub fn is_proxy_failure(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<ApiError>()
            .is_some_and(|api| api.reason == PROXY_REASON && matches!(api.code, 404 | 502 | 503))
    })
}

/// The API server refused the proxy request itself: the user may not `get`
/// `services/proxy` in the service's namespace (a 403 on the proxy path, as
/// opposed to a plain Kubernetes 403 or the service's own answer).
pub fn is_proxy_forbidden(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<ApiError>()
            .is_some_and(|api| api.reason == PROXY_REASON && api.code == 403)
    })
}

/// Detection outcome of probing several candidates (see the state rule of
/// Prometheus, Loki and cost): `true` when every probe failed with
/// [`is_proxy_forbidden`]. Mixed failures (one 403, one unreachable or timed
/// out) are not "forbidden"; neither is an empty probe list.
pub fn all_forbidden<'a, T: 'a>(probes: impl IntoIterator<Item = &'a Result<T>>) -> bool {
    let mut any = false;
    for probe in probes {
        match probe {
            Err(e) if is_proxy_forbidden(e) => any = true,
            _ => return false,
        }
    }
    any
}

// ---------------------------------------------------------------------------
// Detection cache
// ---------------------------------------------------------------------------

/// How long a negative answer (not found, unreachable) is trusted, so a
/// service installed while Kubepit runs is picked up.
pub const RECHECK_AFTER: Duration = Duration::from_secs(5 * 60);

/// A detection result the cache can tell positive from negative.
pub trait DetectedStatus: Clone {
    fn is_available(&self) -> bool;
}

struct CacheEntry<C, S> {
    /// `ClusterStatus.connected_at` of the connection it belongs to.
    connected_at: Option<i64>,
    config: C,
    status: S,
    at: Instant,
    stale: bool,
}

/// Detection results per cluster. An entry is valid for the connection it
/// was made on and the configuration (`C`) it was made with; negative
/// answers expire after [`RECHECK_AFTER`], and a service that disappears
/// (proxy 404/503) marks its entry stale.
pub struct DetectCache<C, S> {
    entries: Mutex<HashMap<String, CacheEntry<C, S>>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl<C, S> Default for DetectCache<C, S> {
    fn default() -> Self {
        Self {
            entries: Mutex::default(),
            locks: Mutex::default(),
        }
    }
}

impl<C: Clone + PartialEq, S: DetectedStatus> DetectCache<C, S> {
    /// Serialises detections of one cluster.
    pub fn detect_lock(&self, cluster_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks
            .lock()
            .entry(cluster_id.to_string())
            .or_default()
            .clone()
    }

    pub fn get_at(
        &self,
        cluster_id: &str,
        connected_at: Option<i64>,
        config: &C,
        now: Instant,
    ) -> Option<S> {
        let entries = self.entries.lock();
        let entry = entries.get(cluster_id)?;
        let fresh = entry.status.is_available() || now.duration_since(entry.at) < RECHECK_AFTER;
        (entry.connected_at == connected_at && &entry.config == config && !entry.stale && fresh)
            .then(|| entry.status.clone())
    }

    pub fn put(&self, cluster_id: &str, connected_at: Option<i64>, config: C, status: S) {
        self.entries.lock().insert(
            cluster_id.to_string(),
            CacheEntry {
                connected_at,
                config,
                status,
                at: Instant::now(),
                stale: false,
            },
        );
    }

    /// Drop everything of a cluster (disconnect, removal).
    pub fn forget(&self, cluster_id: &str) {
        self.entries.lock().remove(cluster_id);
    }

    /// Detect again on the next status request.
    pub fn invalidate(&self, cluster_id: &str) {
        if let Some(entry) = self.entries.lock().get_mut(cluster_id) {
            entry.stale = true;
        }
    }
}

// ---------------------------------------------------------------------------
// Hand-configured services
// ---------------------------------------------------------------------------

/// A DNS-1123 style namespace or service name.
pub fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

/// `""` or `/a/b` (no trailing slash); only path characters, no `..`.
pub fn normalize_prefix(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || "/-_.~".contains(c);
    if !trimmed.chars().all(allowed) {
        bail!("the path prefix may only contain letters, digits, '/', '-', '_', '.' and '~'");
    }
    if trimmed
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        bail!("the path prefix must not contain empty, '.' or '..' segments");
    }
    Ok(format!("/{trimmed}"))
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/// A client for `cluster` like the pool's, but without kube's default retry
/// policy: through the service proxy a 503 ("no endpoints available") or a
/// busy service is an answer, not a reason to back off for minutes.
pub async fn proxy_client(cluster: &ClusterDef) -> Result<Client> {
    let path = Path::new(&cluster.kubeconfig_path);
    let kc = kubeconfig::load(path)
        .with_context(|| format!("failed to read kubeconfig {}", path.display()))?;
    let single = kubeconfig::single_context(&kc, &cluster.context)?;
    let options = KubeConfigOptions {
        context: Some(cluster.context.clone()),
        ..Default::default()
    };
    let mut config = kube::Config::from_custom_kubeconfig(single, &options)
        .await
        .map_err(|e| {
            anyhow!(
                "invalid kubeconfig for context \"{}\": {e}",
                cluster.context
            )
        })?;
    config.default_retry = false;
    Client::try_from(config).map_err(kube_error)
}

/// Retry-free clients ([`proxy_client`]), one per cluster connection
/// (`ClusterStatus.connected_at`), shared by every service-proxy
/// integration.
#[derive(Default)]
pub struct ProxyClients {
    clients: Mutex<HashMap<String, (Option<i64>, Client)>>,
}

impl ProxyClients {
    /// The client of this connection, built on first use.
    pub async fn get(&self, cluster: &ClusterDef, connected_at: Option<i64>) -> Result<Client> {
        let cached = self
            .clients
            .lock()
            .get(&cluster.id)
            .filter(|(at, _)| *at == connected_at)
            .map(|(_, client)| client.clone());
        if let Some(client) = cached {
            return Ok(client);
        }
        let client = proxy_client(cluster).await?;
        self.clients
            .lock()
            .insert(cluster.id.clone(), (connected_at, client.clone()));
        Ok(client)
    }

    /// Drop the client of a cluster (disconnect, removal).
    pub fn forget(&self, cluster_id: &str) {
        self.clients.lock().remove(cluster_id);
    }
}

impl Kubepit {
    /// The retry-free client of the cluster's current connection (connecting
    /// on demand, like every command) and that connection's `connected_at`.
    pub(crate) async fn service_proxy_client(
        &self,
        cluster: &ClusterDef,
    ) -> Result<(Client, Option<i64>)> {
        self.client(&cluster.id).await?;
        let connected_at = self.cluster_status(&cluster.id).connected_at;
        let client = self.proxy_clients.get(cluster, connected_at).await?;
        Ok((client, connected_at))
    }
}

// ---------------------------------------------------------------------------
// Service listing for detection
// ---------------------------------------------------------------------------

/// Services per list page.
const PAGE_SIZE: u32 = 500;
/// Pages read from a cluster-wide list (enough for 5 000 services).
const MAX_PAGES: usize = 10;

/// What detection needs to know about a service.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServiceInfo {
    pub namespace: String,
    pub name: String,
    pub labels: BTreeMap<String, String>,
    /// `(name, port)` of every TCP port.
    pub ports: Vec<(Option<String>, u16)>,
}

impl ServiceInfo {
    pub fn from_service(svc: &Service) -> Option<Self> {
        let ports = svc
            .spec
            .as_ref()?
            .ports
            .as_ref()?
            .iter()
            .filter(|p| p.protocol.as_deref().unwrap_or("TCP") == "TCP")
            .filter_map(|p| Some((p.name.clone(), u16::try_from(p.port).ok()?)))
            .collect();
        Some(Self {
            namespace: svc.metadata.namespace.clone()?,
            name: svc.metadata.name.clone()?,
            labels: svc.metadata.labels.clone().unwrap_or_default(),
            ports,
        })
    }

    /// A label value, `""` when missing.
    pub fn label(&self, key: &str) -> &str {
        self.labels.get(key).map(String::as_str).unwrap_or_default()
    }

    /// The first port named like one of `names` (in that order), else the
    /// first port numbered like one of `numbers`, else the first port.
    pub fn pick_port(&self, names: &[&str], numbers: &[u16]) -> Option<u16> {
        let by_name = names.iter().find_map(|wanted| {
            self.ports
                .iter()
                .find(|(name, _)| name.as_deref() == Some(*wanted))
                .map(|(_, port)| *port)
        });
        let by_number = || {
            numbers
                .iter()
                .find(|wanted| self.ports.iter().any(|(_, p)| p == *wanted))
                .copied()
        };
        by_name
            .or_else(by_number)
            .or_else(|| self.ports.first().map(|(_, p)| *p))
    }
}

/// Every service the user may list: cluster-wide, or — when the cluster-wide
/// list is forbidden — per namespace in `fallback` plus `namespaces` (the
/// cluster's accessible namespaces).
pub async fn list_services(
    client: &Client,
    fallback: &[&str],
    namespaces: &[String],
) -> Result<Vec<ServiceInfo>> {
    match list_pages(Api::<Service>::all(client.clone())).await {
        Ok(services) => Ok(services),
        Err(err) if api_code(&err) == Some(403) => {
            let mut wanted: Vec<String> = fallback.iter().map(|s| s.to_string()).collect();
            for ns in namespaces {
                if !wanted.contains(ns) {
                    wanted.push(ns.clone());
                }
            }
            let lists = futures::future::join_all(
                wanted
                    .iter()
                    .map(|ns| list_pages(Api::<Service>::namespaced(client.clone(), ns))),
            )
            .await;
            // Missing or forbidden namespaces simply contribute nothing.
            Ok(lists.into_iter().filter_map(Result::ok).flatten().collect())
        }
        Err(err) => Err(err),
    }
}

async fn list_pages(api: Api<Service>) -> Result<Vec<ServiceInfo>> {
    let mut out = Vec::new();
    let mut params = ListParams::default().limit(PAGE_SIZE);
    for _ in 0..MAX_PAGES {
        let page = api.list(&params).await.map_err(kube_error)?;
        out.extend(page.items.iter().filter_map(ServiceInfo::from_service));
        match page.metadata.continue_.filter(|c| !c.is_empty()) {
            Some(token) => params = params.continue_token(&token),
            None => break,
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint<'a>(scheme: PromScheme, prefix: &'a str) -> Endpoint<'a> {
        Endpoint {
            namespace: "loki",
            service: "loki-gateway",
            port: 80,
            scheme,
            path_prefix: prefix,
        }
    }

    #[test]
    fn paths_follow_the_service_proxy_scheme() {
        assert_eq!(
            proxy_base(&endpoint(PromScheme::Http, "")),
            "/api/v1/namespaces/loki/services/http:loki-gateway:80/proxy"
        );
        assert_eq!(
            proxy_path(
                &endpoint(PromScheme::Https, "/a/"),
                "/loki/api/v1/labels",
                &[("start", "1".into())]
            ),
            "/api/v1/namespaces/loki/services/https:loki-gateway:80/proxy/a/loki/api/v1/labels?start=1"
        );
        assert_eq!(
            proxy_path(&endpoint(PromScheme::Http, ""), "/ready", &[]),
            "/api/v1/namespaces/loki/services/http:loki-gateway:80/proxy/ready"
        );
    }

    #[test]
    fn requests_carry_accept_and_extra_headers() {
        let req = get_request("/x", &[("X-Scope-OrgID", "team-a")], "Loki").unwrap();
        assert_eq!(req.method(), http::Method::GET);
        assert_eq!(req.headers()["accept"], "application/json");
        assert_eq!(req.headers()["x-scope-orgid"], "team-a");
        assert!(get_request("/x", &[("bad header", "v")], "Loki")
            .unwrap_err()
            .to_string()
            .contains("invalid Loki request"));
    }

    #[test]
    fn proxy_errors_use_the_status_message_or_the_body() {
        let err = proxy_error(
            503,
            r#"{"kind":"Status","message":"no endpoints available for service \"loki\"","code":503}"#,
        );
        assert_eq!(err.reason, PROXY_REASON);
        assert_eq!(err.message, "no endpoints available for service \"loki\"");
        assert_eq!(proxy_error(502, "  ").message, "HTTP 502");
        assert_eq!(
            proxy_error(500, &"y".repeat(900)).message.len(),
            "HTTP 500: ".len() + MAX_ERROR_BODY
        );
        let gone: anyhow::Error = proxy_error(404, "").into();
        assert!(is_proxy_failure(&gone));
        let bad: anyhow::Error = proxy_error(400, "").into();
        assert!(!is_proxy_failure(&bad));
    }

    #[test]
    fn is_proxy_forbidden_matches_only_proxy_403() {
        let forbidden: anyhow::Error = proxy_error(
            403,
            r#"{"kind":"Status","message":"services \"http:loki:80\" is forbidden: User \"dev\" cannot get resource \"services/proxy\"","code":403}"#,
        )
        .into();
        assert!(is_proxy_forbidden(&forbidden));
        assert!(is_proxy_forbidden(&forbidden.context("probe failed")));
        assert!(!is_proxy_failure(&proxy_error(403, "").into()));
        let gone: anyhow::Error = proxy_error(503, "").into();
        assert!(!is_proxy_forbidden(&gone));
        let kube: anyhow::Error = ApiError {
            code: 403,
            reason: "Forbidden".into(),
            message: "services is forbidden".into(),
        }
        .into();
        assert!(!is_proxy_forbidden(&kube));
    }

    #[test]
    fn all_forbidden_needs_every_probe_refused() {
        let refused = || -> Result<()> { Err(proxy_error(403, "").into()) };
        let gone = || -> Result<()> { Err(proxy_error(503, "").into()) };
        assert!(all_forbidden(&[refused(), refused()]));
        assert!(!all_forbidden(&[refused(), gone()]));
        assert!(!all_forbidden(&[refused(), Ok(())]));
        assert!(!all_forbidden(&Vec::<Result<()>>::new()));
    }

    #[test]
    fn ports_are_picked_by_name_then_number() {
        let info = ServiceInfo {
            ports: vec![
                (Some("grpc".into()), 9095),
                (Some("http-metrics".into()), 3100),
                (None, 8080),
            ],
            ..Default::default()
        };
        assert_eq!(info.pick_port(&["http", "http-metrics"], &[80]), Some(3100));
        assert_eq!(info.pick_port(&["web"], &[8080]), Some(8080));
        assert_eq!(info.pick_port(&["web"], &[1]), Some(9095));
        assert_eq!(ServiceInfo::default().pick_port(&["web"], &[1]), None);
    }

    #[test]
    fn prefixes_and_names_are_validated() {
        assert_eq!(normalize_prefix(" /loki/ ").unwrap(), "/loki");
        assert_eq!(normalize_prefix("").unwrap(), "");
        assert!(normalize_prefix("/../x").is_err());
        assert!(normalize_prefix("/a?b").is_err());
        assert!(valid_name("loki-gateway"));
        assert!(!valid_name("Loki"));
        assert!(!valid_name(""));
    }
}
