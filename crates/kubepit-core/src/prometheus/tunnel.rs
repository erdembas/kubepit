//! Authenticated Prometheus through an in-process port-forward tunnel.
//!
//! The API server's service proxy does not forward `Authorization`, so a
//! cluster whose `prometheus_access.auth` is set reaches its Prometheus over
//! `pods/portforward` instead:
//!
//! 1. the credentials are read from the referenced Secret (`get secrets`,
//!    the user's RBAC; one read per cluster at a time, given up after
//!    [`SETUP_TIMEOUT`]) and kept in memory for at most five minutes per
//!    connection and settings ([`TunnelCache`]); they are never logged,
//!    stored, returned to the UI or quoted in errors (errors name the Secret
//!    and key only);
//! 2. a ready pod behind the service is resolved per request
//!    ([`crate::portforward::resolve_target`], so restarts are survived) and
//!    a port-forward stream is opened to it — no local listener, so no other
//!    local process can use the tunnel;
//! 3. `https` services get TLS over that stream with the server name
//!    `<service>.<namespace>.svc`, trusting a CA from a ConfigMap or Secret
//!    key, else the system roots, or nothing (`insecure_skip_verify`);
//! 4. one HTTP/1.1 GET with `Authorization` and the tenant goes over it
//!    ([`request_over`]).
//!
//! Steps 1–3 failing is a [`TunnelFailure`]: the tunnel cannot be set up,
//! so like a service-proxy failure it aborts a scan and re-detects
//! Prometheus. The exchange of step 4 failing (the query timeout, a
//! closed connection) is a plain error, like the same failure behind the
//! service proxy: a heavy statistics query stays splittable.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use k8s_openapi::api::core::v1::{ConfigMap, Pod, Secret};
use k8s_openapi::ByteString;
use kube::api::Api;
use kube::Client;
use parking_lot::Mutex;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio::io::{AsyncRead, AsyncWrite};

use super::access::{KeyRef, KeyRefKind, PrometheusAccess, PrometheusAuth};
use crate::error::kube_error;
use crate::portforward::resolve_target;
use crate::service_proxy::RawResponse;
use crate::types::{PortForwardKind, PortForwardRequest, PromScheme, PrometheusService};

/// How long Secret values stay in memory.
pub const SECRETS_TTL: Duration = Duration::from_secs(5 * 60);
/// Upper bound for reading the Secret, resolving the pod, opening the
/// port-forward and the TLS handshake.
pub const SETUP_TIMEOUT: Duration = Duration::from_secs(15);

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// The finished `Authorization` value (`Bearer …` / `Basic …`). Never
/// printed, logged, stored or returned.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Credentials(pub(crate) String);

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credentials(<redacted>)")
    }
}

/// A text value of `data[key]` (trimmed), or an error naming the object
/// and the key, never the value.
fn text_value(data: &BTreeMap<String, ByteString>, what: &str, key: &str) -> Result<String> {
    let bytes = data
        .get(key)
        .ok_or_else(|| anyhow!("{what} has no key \"{key}\""))?;
    let text = std::str::from_utf8(&bytes.0)
        .map_err(|_| anyhow!("key \"{key}\" of {what} is not text"))?
        .trim()
        .to_string();
    if text.is_empty() {
        bail!("key \"{key}\" of {what} is empty");
    }
    if text.chars().any(char::is_control) {
        bail!("key \"{key}\" of {what} is not a single line");
    }
    Ok(text)
}

/// The `Authorization` value of `auth` from the Secret's `data`.
fn credentials_from(
    auth: &PrometheusAuth,
    data: &BTreeMap<String, ByteString>,
) -> Result<Credentials> {
    Ok(match auth {
        PrometheusAuth::Bearer {
            namespace,
            secret,
            token_key,
        } => {
            let what = format!("Secret {namespace}/{secret}");
            Credentials(format!("Bearer {}", text_value(data, &what, token_key)?))
        }
        PrometheusAuth::Basic {
            namespace,
            secret,
            username_key,
            password_key,
        } => {
            let what = format!("Secret {namespace}/{secret}");
            let user = text_value(data, &what, username_key)?;
            let password = text_value(data, &what, password_key)?;
            let pair =
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
            Credentials(format!("Basic {pair}"))
        }
    })
}

/// Why `kind namespace/name` could not be read. The API server's own
/// message is kept (it never holds data); a body that could not be decoded
/// is not quoted.
fn read_error(err: kube::Error, kind: &str, namespace: &str, name: &str) -> anyhow::Error {
    let why = match &err {
        kube::Error::SerdeError(_) => "the answer could not be decoded".to_string(),
        _ => format!("{:#}", kube_error(err)),
    };
    anyhow!("could not read {kind} {namespace}/{name}: {why}")
}

/// Read the credentials `auth` points to.
pub(crate) async fn read_credentials(
    client: &Client,
    auth: &PrometheusAuth,
) -> Result<Credentials> {
    let (namespace, name) = match auth {
        PrometheusAuth::Bearer {
            namespace, secret, ..
        }
        | PrometheusAuth::Basic {
            namespace, secret, ..
        } => (namespace.as_str(), secret.as_str()),
    };
    let secret = Api::<Secret>::namespaced(client.clone(), namespace)
        .get(name)
        .await
        .map_err(|e| read_error(e, "Secret", namespace, name))?;
    credentials_from(auth, &secret.data.unwrap_or_default())
}

/// The PEM bundle a [`KeyRef`] points to.
async fn read_ca(client: &Client, key: &KeyRef) -> Result<Vec<u8>> {
    let (namespace, name) = (key.namespace.as_str(), key.name.as_str());
    let data: BTreeMap<String, ByteString> = match key.kind {
        KeyRefKind::Secret => Api::<Secret>::namespaced(client.clone(), namespace)
            .get(name)
            .await
            .map_err(|e| read_error(e, "Secret", namespace, name))?
            .data
            .unwrap_or_default(),
        KeyRefKind::ConfigMap => {
            let map = Api::<ConfigMap>::namespaced(client.clone(), namespace)
                .get(name)
                .await
                .map_err(|e| read_error(e, "ConfigMap", namespace, name))?;
            let mut data = map.binary_data.unwrap_or_default();
            for (k, v) in map.data.unwrap_or_default() {
                data.insert(k, ByteString(v.into_bytes()));
            }
            data
        }
    };
    let kind = match key.kind {
        KeyRefKind::Secret => "Secret",
        KeyRefKind::ConfigMap => "ConfigMap",
    };
    data.get(&key.key)
        .map(|v| v.0.clone())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow!("{kind} {namespace}/{name} has no key \"{}\"", key.key))
}

/// What the tunnel reads from the cluster: the credentials and, for an
/// `https` service with a configured CA, that CA.
#[derive(Clone)]
pub(crate) struct TunnelSecrets {
    pub credentials: Credentials,
    pub ca: Option<Vec<u8>>,
}

impl fmt::Debug for TunnelSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TunnelSecrets(<redacted>)")
    }
}

struct Cached {
    connected_at: Option<i64>,
    access: PrometheusAccess,
    secrets: Arc<TunnelSecrets>,
    at: Instant,
    /// Tells this entry apart from a later one of the same cluster (expiry).
    generation: u64,
}

type Entries = Arc<Mutex<HashMap<String, Cached>>>;

/// Secret values of each cluster's tunnel, per connection and access
/// settings, for at most [`SECRETS_TTL`]: an entry is dropped when it expires
/// (a timer, even if nothing asks again), when it no longer matches, and on
/// disconnect, removal and access changes ([`TunnelCache::forget`]). A read
/// still in flight when the cluster is forgotten answers its own request but
/// is not kept (the cluster's epoch moved on).
pub struct TunnelCache {
    entries: Entries,
    /// Serialise reads per cluster, so parallel queries read the Secret once
    /// and one hung cluster does not hold up the others.
    fills: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Per cluster, bumped by [`TunnelCache::forget`]: a read that started
    /// in an older epoch is not cached. Locked after `entries`, never before.
    epochs: Mutex<HashMap<String, u64>>,
    generation: AtomicU64,
    ttl: Duration,
    setup_timeout: Duration,
}

impl Default for TunnelCache {
    fn default() -> Self {
        Self::with_limits(SECRETS_TTL, SETUP_TIMEOUT)
    }
}

/// Read what `access` needs from the cluster: the credentials and, for TLS
/// with a configured CA, that CA.
async fn read_secrets(client: &Client, access: &PrometheusAccess) -> Result<TunnelSecrets> {
    let auth = access
        .auth
        .as_ref()
        .ok_or_else(|| anyhow!("no credentials are configured"))?;
    let credentials = read_credentials(client, auth).await?;
    let ca = match access.tls.as_ref() {
        Some(tls) if !tls.insecure_skip_verify => match &tls.ca {
            Some(key) => Some(read_ca(client, key).await?),
            None => None,
        },
        _ => None,
    };
    Ok(TunnelSecrets { credentials, ca })
}

impl TunnelCache {
    /// A cache keeping values for `ttl` and giving up reading them after
    /// `setup_timeout`.
    pub(crate) fn with_limits(ttl: Duration, setup_timeout: Duration) -> Self {
        Self {
            entries: Entries::default(),
            fills: Mutex::default(),
            epochs: Mutex::default(),
            generation: AtomicU64::new(0),
            ttl,
            setup_timeout,
        }
    }

    /// The cached values when they belong to this connection and these
    /// settings and have not expired; anything else is dropped right away.
    fn get_at(
        &self,
        cluster_id: &str,
        connected_at: Option<i64>,
        access: &PrometheusAccess,
        now: Instant,
    ) -> Option<Arc<TunnelSecrets>> {
        let mut entries = self.entries.lock();
        let entry = entries.get(cluster_id)?;
        if entry.connected_at == connected_at
            && &entry.access == access
            && now.duration_since(entry.at) < self.ttl
        {
            return Some(entry.secrets.clone());
        }
        entries.remove(cluster_id);
        None
    }

    fn fill_lock(&self, cluster_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.fills
            .lock()
            .entry(cluster_id.to_string())
            .or_default()
            .clone()
    }

    /// The current epoch of `cluster_id` (see [`Self::forget`]), recorded
    /// when a command resolves its Prometheus source.
    pub(crate) fn epoch(&self, cluster_id: &str) -> u64 {
        self.epochs.lock().get(cluster_id).copied().unwrap_or(0)
    }

    /// Cache values read in `epoch`; values of an older epoch (the cluster
    /// was forgotten while they were read) are discarded.
    fn insert(
        &self,
        cluster_id: &str,
        connected_at: Option<i64>,
        access: &PrometheusAccess,
        secrets: Arc<TunnelSecrets>,
        epoch: u64,
    ) {
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        {
            let mut entries = self.entries.lock();
            if self.epoch(cluster_id) != epoch {
                return;
            }
            entries.insert(
                cluster_id.to_string(),
                Cached {
                    connected_at,
                    access: access.clone(),
                    secrets,
                    at: Instant::now(),
                    generation,
                },
            );
        }
        // Values never outlive the TTL, even when nothing asks again.
        let (entries, ttl, id) = (
            Arc::downgrade(&self.entries),
            self.ttl,
            cluster_id.to_string(),
        );
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                tokio::time::sleep(ttl).await;
                if let Some(entries) = entries.upgrade() {
                    let mut entries = entries.lock();
                    if entries.get(&id).is_some_and(|e| e.generation == generation) {
                        entries.remove(&id);
                    }
                }
            });
        }
    }

    /// The Secret values of `access`, read when not cached, within
    /// [`SETUP_TIMEOUT`] (waiting for another read of the same cluster
    /// included). `epoch` is the cluster's epoch when the caller resolved
    /// its source: a caller from before a [`Self::forget`] (disconnect,
    /// removal, access change) still gets values for its own request, but
    /// never reads or writes the cache.
    pub(crate) async fn secrets(
        &self,
        cluster_id: &str,
        connected_at: Option<i64>,
        client: &Client,
        access: &PrometheusAccess,
        epoch: u64,
    ) -> Result<Arc<TunnelSecrets>> {
        self.secrets_in(
            cluster_id,
            connected_at,
            access,
            epoch,
            read_secrets(client, access),
        )
        .await
    }

    /// [`Self::secrets`] with the read as a future, in the current epoch.
    #[cfg(test)]
    async fn secrets_with<F>(
        &self,
        cluster_id: &str,
        connected_at: Option<i64>,
        access: &PrometheusAccess,
        read: F,
    ) -> Result<Arc<TunnelSecrets>>
    where
        F: Future<Output = Result<TunnelSecrets>>,
    {
        let epoch = self.epoch(cluster_id);
        self.secrets_in(cluster_id, connected_at, access, epoch, read)
            .await
    }

    /// [`Self::secrets`] with the read as a future.
    async fn secrets_in<F>(
        &self,
        cluster_id: &str,
        connected_at: Option<i64>,
        access: &PrometheusAccess,
        epoch: u64,
        read: F,
    ) -> Result<Arc<TunnelSecrets>>
    where
        F: Future<Output = Result<TunnelSecrets>>,
    {
        // A stale caller must not even look: a mismatching lookup drops
        // the entry, which belongs to the current settings.
        let current = || epoch == self.epoch(cluster_id);
        if current() {
            if let Some(hit) = self.get_at(cluster_id, connected_at, access, Instant::now()) {
                return Ok(hit);
            }
        }
        let fill = self.fill_lock(cluster_id);
        let work = async {
            let _filling = fill.lock().await;
            if current() {
                if let Some(hit) = self.get_at(cluster_id, connected_at, access, Instant::now()) {
                    return Ok(hit);
                }
            }
            let secrets = Arc::new(read.await?);
            self.insert(cluster_id, connected_at, access, secrets.clone(), epoch);
            Ok(secrets)
        };
        tokio::time::timeout(self.setup_timeout, work)
            .await
            .map_err(|_| {
                let what = match &access.auth {
                    Some(PrometheusAuth::Bearer {
                        namespace, secret, ..
                    })
                    | Some(PrometheusAuth::Basic {
                        namespace, secret, ..
                    }) => format!("Secret {namespace}/{secret}"),
                    None => "the Prometheus credentials".to_string(),
                };
                anyhow!(
                    "{what} could not be read within {}s",
                    self.setup_timeout.as_secs_f32()
                )
            })?
    }

    /// Drop the values of a cluster (disconnect, removal, access changes),
    /// and start a new epoch so a read still in flight is not kept.
    pub fn forget(&self, cluster_id: &str) {
        {
            let mut entries = self.entries.lock();
            entries.remove(cluster_id);
            *self
                .epochs
                .lock()
                .entry(cluster_id.to_string())
                .or_default() += 1;
        }
        self.fills.lock().remove(cluster_id);
    }

    /// Whether values of `cluster_id` are held (tests).
    #[cfg(test)]
    pub(crate) fn holds(&self, cluster_id: &str) -> bool {
        self.entries.lock().contains_key(cluster_id)
    }

    /// Hold test values for `cluster_id` (tests).
    #[cfg(test)]
    pub(crate) fn seed(&self, cluster_id: &str, access: &PrometheusAccess) {
        let secrets = Arc::new(TunnelSecrets {
            credentials: Credentials("Bearer t0k".into()),
            ca: None,
        });
        self.insert(cluster_id, None, access, secrets, self.epoch(cluster_id));
    }
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

/// Accepts any certificate (`insecure_skip_verify`); signatures are still
/// checked, so the handshake itself stays sound.
#[derive(Debug)]
struct SkipVerification(Arc<CryptoProvider>);

impl ServerCertVerifier for SkipVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// The platform's trusted roots, loaded once.
fn system_roots() -> Arc<RootCertStore> {
    static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            let loaded = rustls_native_certs::load_native_certs();
            let (added, _ignored) = roots.add_parsable_certificates(loaded.certs);
            if added == 0 {
                tracing::warn!("Prometheus tunnel: no system root certificates could be loaded");
            }
            Arc::new(roots)
        })
        .clone()
}

/// The TLS client settings: skip verification, trust `ca` (PEM), or the
/// system roots.
fn client_config(skip_verify: bool, ca: Option<&[u8]>) -> Result<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| anyhow!("TLS setup failed: {e}"))?;
    if skip_verify {
        return Ok(builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipVerification(provider)))
            .with_no_client_auth());
    }
    let roots = match ca {
        Some(pem) => {
            let mut roots = RootCertStore::empty();
            let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(pem)
                .collect::<std::result::Result<_, _>>()
                .map_err(|_| anyhow!("the CA bundle is not valid PEM"))?;
            let (added, _) = roots.add_parsable_certificates(certs);
            if added == 0 {
                bail!("the CA bundle holds no usable certificate");
            }
            Arc::new(roots)
        }
        None => system_roots(),
    };
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}

/// TLS over `stream` to `server_name`.
async fn tls_connect<S>(
    stream: S,
    server_name: &str,
    skip_verify: bool,
    ca: Option<&[u8]>,
) -> Result<tokio_rustls::client::TlsStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let config = client_config(skip_verify, ca)?;
    let name = ServerName::try_from(server_name.to_string())
        .map_err(|_| anyhow!("\"{server_name}\" is not a valid TLS server name"))?;
    tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .with_context(|| format!("TLS handshake with {server_name} failed"))
}

// ---------------------------------------------------------------------------
// HTTP over the stream
// ---------------------------------------------------------------------------

/// One HTTP/1.1 GET of `path` over `stream` with `Host: host`, `Accept:
/// application/json` and `headers`, within `timeout`. Every status code is
/// an answer; only transport failures and timeouts are errors.
pub(crate) async fn request_over<S>(
    stream: S,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<RawResponse>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut builder = http::Request::get(path)
        .header(http::header::HOST, host)
        .header(http::header::ACCEPT, "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    // `http` errors describe the header, never its value.
    let request = builder
        .body(Empty::<Bytes>::new())
        .map_err(|e| anyhow!("invalid Prometheus request: {e}"))?;
    let exchange = async {
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| anyhow!("request to Prometheus failed: {e}"))?;
        let driver = tokio::spawn(connection);
        let answer = async {
            let response = sender.send_request(request).await?;
            let status = response.status().as_u16();
            let body = response.into_body().collect().await?.to_bytes();
            Ok::<_, hyper::Error>((status, body))
        }
        .await;
        driver.abort();
        let (status, body) = answer.map_err(|e| anyhow!("request to Prometheus failed: {e}"))?;
        Ok::<_, anyhow::Error>(RawResponse {
            status,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    };
    tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| anyhow!("Prometheus did not answer within {}s", timeout.as_secs()))?
}

/// A failure to set the tunnel up (credentials, pod, port-forward, TLS
/// handshake, or the pod refusing the forwarded connection), as opposed to
/// a query over an established tunnel. Like a proxy failure, it makes the
/// next status request detect again.
#[derive(Debug)]
pub(crate) struct TunnelFailure(String);

impl fmt::Display for TunnelFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TunnelFailure {}

pub(crate) fn tunnel_failure(err: anyhow::Error) -> anyhow::Error {
    anyhow::Error::new(TunnelFailure(format!("{err:#}")))
}

pub(crate) fn is_tunnel_failure(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.is::<TunnelFailure>())
}

/// One authenticated GET of `path` over `stream` (the port-forward): TLS
/// for an `https` service (a handshake failure or timeout is a
/// [`TunnelFailure`]), then the exchange, whose failures and timeout stay
/// plain errors.
async fn query_over<S>(
    stream: S,
    service: &PrometheusService,
    access: &PrometheusAccess,
    secrets: &TunnelSecrets,
    path: &str,
    timeout: Duration,
) -> Result<RawResponse>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (namespace, name) = (service.namespace.as_str(), service.service.as_str());
    let server_name = format!("{name}.{namespace}.svc");
    let host = format!("{server_name}:{}", service.port);
    let mut headers = vec![("authorization", secrets.credentials.0.as_str())];
    let tenant = access.tenant.trim();
    if !tenant.is_empty() {
        headers.push(("x-scope-orgid", tenant));
    }
    match service.scheme {
        PromScheme::Http => request_over(stream, &host, path, &headers, timeout).await,
        PromScheme::Https => {
            let skip = access.tls.as_ref().is_some_and(|t| t.insecure_skip_verify);
            let tls = tokio::time::timeout(
                SETUP_TIMEOUT,
                tls_connect(stream, &server_name, skip, secrets.ca.as_deref()),
            )
            .await
            .map_err(|_| tunnel_failure(anyhow!("TLS handshake with {server_name} timed out")))?
            .map_err(tunnel_failure)?;
            request_over(tls, &host, path, &headers, timeout).await
        }
    }
}

/// GET `path` (prefix, endpoint and query) of `service` through a
/// port-forward to a ready pod behind it, authenticated with `secrets`.
/// Setup failures are [`TunnelFailure`]s; see the module docs.
pub(crate) async fn tunnel_get(
    client: &Client,
    service: &PrometheusService,
    access: &PrometheusAccess,
    secrets: &TunnelSecrets,
    path: &str,
    timeout: Duration,
) -> Result<RawResponse> {
    let (namespace, name) = (service.namespace.as_str(), service.service.as_str());
    let target = PortForwardRequest {
        cluster_id: String::new(),
        namespace: namespace.to_string(),
        kind: PortForwardKind::Service,
        name: name.to_string(),
        remote_port: service.port,
        local_port: None,
    };
    let setup_timeout = || anyhow!("Prometheus port-forward to {namespace}/{name} timed out");
    let (pod, port) = tokio::time::timeout(SETUP_TIMEOUT, resolve_target(client, &target))
        .await
        .map_err(|_| setup_timeout())
        .and_then(|resolved| {
            resolved
                .with_context(|| format!("Prometheus port-forward to service {namespace}/{name}"))
        })
        .map_err(tunnel_failure)?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let mut forwarder = tokio::time::timeout(SETUP_TIMEOUT, pods.portforward(&pod, &[port]))
        .await
        .map_err(|_| setup_timeout())
        .and_then(|opened| {
            opened.map_err(kube_error).with_context(|| {
                format!("Prometheus port-forward to pod {namespace}/{pod}:{port} failed")
            })
        })
        .map_err(tunnel_failure)?;
    let Some(stream) = forwarder.take_stream(port) else {
        forwarder.abort();
        return Err(tunnel_failure(anyhow!(
            "Prometheus port-forward stream to pod {namespace}/{pod} is unavailable"
        )));
    };
    let pod_error = forwarder.take_error(port);
    let result = match query_over(stream, service, access, secrets, path, timeout).await {
        Err(e) if !is_tunnel_failure(&e) => {
            // The pod side may know better ("connection refused"): then the
            // forward itself failed, which is a setup failure.
            let detail = match pod_error {
                Some(rx) => tokio::time::timeout(Duration::from_millis(200), rx)
                    .await
                    .ok()
                    .flatten(),
                None => None,
            };
            Err(match detail {
                Some(detail) => tunnel_failure(e.context(format!(
                    "port-forward to pod {namespace}/{pod}:{port}: {detail}"
                ))),
                None => e.context(format!(
                    "over the port-forward to pod {namespace}/{pod}:{port}"
                )),
            })
        }
        other => other,
    };
    forwarder.abort();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const BODY: &str = r#"{"status":"success","data":{"resultType":"scalar","result":[1,"1"]}}"#;

    // A CA and a leaf for `prometheus.monitoring.svc`, generated for these
    // tests only (valid until 2126).
    const TEST_CA: &str = "-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUcGrm/jPNwgWQOXSJTbYzTPdUemcwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPS3ViZXBpdCB0ZXN0IENBMCAXDTI2MDkyODE5MDMyOVoYDzIx
MjYwOTA0MTkwMzI5WjAaMRgwFgYDVQQDDA9LdWJlcGl0IHRlc3QgQ0EwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAATlO29FsmByudm6U1EitnJhiG9gttK6/iVJ0H++
vGLRiYxkKFsxRN2mZ32nc9nlWJCn2iUYzWs3n0iu5uTcf2cXo2MwYTAdBgNVHQ4E
FgQUczeHE6CdiocU1ZmtdaBACt/fkTAwHwYDVR0jBBgwFoAUczeHE6CdiocU1Zmt
daBACt/fkTAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZI
zj0EAwIDRwAwRAIgNwYc2FNntFKXzK3ZijNmIpao6oJy9Gjhl3IoF7a3WZUCIEwj
mxsTmH/nqJpI2/M9aTu5teNju7IVn1dy24XTmwAW
-----END CERTIFICATE-----
";
    const TEST_LEAF: &str = "-----BEGIN CERTIFICATE-----
MIIB3jCCAYWgAwIBAgIUBCeL7D6elrW0QQSOP7Zkm9HDtDgwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPS3ViZXBpdCB0ZXN0IENBMCAXDTI2MDkyODE5MDMyOVoYDzIx
MjYwOTA0MTkwMzI5WjAkMSIwIAYDVQQDDBlwcm9tZXRoZXVzLm1vbml0b3Jpbmcu
c3ZjMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUHOCxticPKYfa2UFjWOynQiI
2UYcbY+hM0wUCgiCuOB7dYRnJEBG7IeTOMZYfArwGxzu5RjHrrAI7CskuHcokaOB
nDCBmTAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggr
BgEFBQcDATAkBgNVHREEHTAbghlwcm9tZXRoZXVzLm1vbml0b3Jpbmcuc3ZjMB0G
A1UdDgQWBBRIwm1xLbk+5TbCMTiyLNEg7ertpjAfBgNVHSMEGDAWgBRzN4cToJ2K
hxTVma11oEAK39+RMDAKBggqhkjOPQQDAgNHADBEAiBNbWdIba+ariNVCPyS/t2r
06JThRXCxilWJYYoKaxeywIgRJ5JIoep/cOTqKQRF/k6EHrSDN7IjeF1rNvTXBuQ
RWk=
-----END CERTIFICATE-----
";
    const TEST_LEAF_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfkO9bu5eodH3nTvF
DDkJXLABSMcBDXWUun58Wp1e69uhRANCAARQc4LG2Jw8ph9rZQWNY7KdCIjZRhxt
j6EzTBQKCIK44Ht1hGckQEbsh5M4xlh8CvAbHO7lGMeusAjsKyS4dyiR
-----END PRIVATE KEY-----
";

    fn chunked_ok() -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{BODY}\r\n0\r\n\r\n",
            BODY.len()
        )
    }

    /// Read one request head from `server`, answer `reply`, return the head.
    async fn read_request_then_write<S: AsyncRead + AsyncWrite + Unpin>(
        server: &mut S,
        reply: &str,
    ) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if server.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            head.push(byte[0]);
        }
        server.write_all(reply.as_bytes()).await.unwrap();
        server.flush().await.unwrap();
        String::from_utf8(head).unwrap()
    }

    #[tokio::test]
    async fn tunnel_requests_carry_auth_and_tenant() {
        let (client, mut server) = tokio::io::duplex(64 * 1024);
        let reply =
            tokio::spawn(async move { read_request_then_write(&mut server, &chunked_ok()).await });
        let resp = request_over(
            client,
            "prometheus.monitoring.svc:9090",
            "/api/v1/query?query=1",
            &[("authorization", "Bearer t0k"), ("x-scope-orgid", "team-a")],
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let head = reply.await.unwrap();
        assert!(
            head.contains("authorization: Bearer t0k") && head.contains("x-scope-orgid: team-a"),
            "{head}"
        );
        assert!(
            head.starts_with("GET /api/v1/query?query=1 HTTP/1.1\r\n"),
            "{head}"
        );
        assert!(
            head.contains("host: prometheus.monitoring.svc:9090"),
            "{head}"
        );
        assert!(resp.is_success() && resp.body.contains("\"status\":\"success\""));
    }

    #[tokio::test]
    async fn silent_servers_time_out() {
        let (client, _server) = tokio::io::duplex(1024);
        let err = request_over(client, "h", "/", &[], Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("did not answer"), "{err}");
    }

    fn service(scheme: PromScheme) -> PrometheusService {
        PrometheusService {
            kind: crate::types::PrometheusKind::Custom,
            namespace: "monitoring".into(),
            service: "prometheus".into(),
            port: 9090,
            scheme,
            path_prefix: String::new(),
        }
    }

    fn secrets() -> TunnelSecrets {
        TunnelSecrets {
            credentials: Credentials("Bearer t0k".into()),
            ca: None,
        }
    }

    #[tokio::test]
    async fn a_query_timeout_splits_and_a_setup_failure_aborts() {
        use crate::prometheus::workload_stats::{merge, BatchFailure, StatQuery};
        // The exchange over an established tunnel times out: a plain error,
        // so a required query of a batch makes it splittable, like behind
        // the service proxy.
        let (client, _server) = tokio::io::duplex(1024);
        let slow = query_over(
            client,
            &service(PromScheme::Http),
            &secured(""),
            &secrets(),
            "/api/v1/query",
            Duration::from_millis(100),
        )
        .await
        .unwrap_err();
        assert!(!is_tunnel_failure(&slow), "{slow:#}");
        assert!(matches!(
            merge(vec![(StatQuery::CpuP95, Err(slow))]),
            Err(BatchFailure::Splittable { .. })
        ));
        // The TLS handshake fails (the peer hangs up): the tunnel cannot be
        // set up, so the batch aborts.
        let (client, server) = tokio::io::duplex(1024);
        drop(server);
        let setup = query_over(
            client,
            &service(PromScheme::Https),
            &secured(""),
            &secrets(),
            "/api/v1/query",
            Duration::from_millis(100),
        )
        .await
        .unwrap_err();
        assert!(is_tunnel_failure(&setup), "{setup:#}");
        assert!(matches!(
            merge(vec![(StatQuery::CpuP95, Err(setup))]),
            Err(BatchFailure::Tunnel(_))
        ));
    }

    #[test]
    fn credentials_never_print() {
        assert_eq!(
            format!("{:?}", Credentials("Bearer s3cret".into())),
            "Credentials(<redacted>)"
        );
        let secrets = TunnelSecrets {
            credentials: Credentials("Bearer s3cret".into()),
            ca: None,
        };
        assert!(!format!("{secrets:?}").contains("s3cret"));
    }

    #[test]
    fn credentials_come_from_the_secret_keys() {
        let data: BTreeMap<String, ByteString> = [
            ("token", " t0k\n"),
            ("username", "admin"),
            ("password", "s3cret"),
            ("multi", "a\nb"),
            ("empty", " "),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), ByteString(v.as_bytes().to_vec())))
        .chain([("binary".to_string(), ByteString(vec![0xff, 0xfe]))])
        .collect();
        let bearer = |key: &str| PrometheusAuth::Bearer {
            namespace: "monitoring".into(),
            secret: "prom-auth".into(),
            token_key: key.into(),
        };
        assert_eq!(
            credentials_from(&bearer("token"), &data).unwrap(),
            Credentials("Bearer t0k".into())
        );
        let basic = PrometheusAuth::Basic {
            namespace: "monitoring".into(),
            secret: "prom-auth".into(),
            username_key: "username".into(),
            password_key: "password".into(),
        };
        // base64("admin:s3cret")
        assert_eq!(
            credentials_from(&basic, &data).unwrap(),
            Credentials("Basic YWRtaW46czNjcmV0".into())
        );
        for key in ["nope", "multi", "empty", "binary"] {
            let err = credentials_from(&bearer(key), &data)
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("Secret monitoring/prom-auth") && err.contains(key),
                "{err}"
            );
            assert!(!err.contains("s3cret") && !err.contains("a\nb"), "{err}");
        }
    }

    /// A TLS server for `prometheus.monitoring.svc` on `server` that answers
    /// one request.
    fn serve_tls(server: tokio::io::DuplexStream) -> tokio::task::JoinHandle<Option<String>> {
        let certs = vec![CertificateDer::from_pem_slice(TEST_LEAF.as_bytes()).unwrap()];
        let key =
            rustls::pki_types::PrivateKeyDer::from_pem_slice(TEST_LEAF_KEY.as_bytes()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        tokio::spawn(async move {
            let mut tls = acceptor.accept(server).await.ok()?;
            Some(read_request_then_write(&mut tls, &chunked_ok()).await)
        })
    }

    async fn https_get(skip_verify: bool, ca: Option<&[u8]>) -> Result<RawResponse> {
        https_get_as("prometheus.monitoring.svc", skip_verify, ca).await
    }

    /// An https GET to the test server, expecting it to be `server_name`.
    async fn https_get_as(
        server_name: &str,
        skip_verify: bool,
        ca: Option<&[u8]>,
    ) -> Result<RawResponse> {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let served = serve_tls(server);
        let result = async {
            let tls = tls_connect(client, server_name, skip_verify, ca).await?;
            request_over(
                tls,
                "prometheus.monitoring.svc:9090",
                "/api/v1/query?query=1",
                &[],
                Duration::from_secs(5),
            )
            .await
        }
        .await;
        served.abort();
        result
    }

    #[tokio::test]
    async fn https_trusts_the_configured_ca_or_skips_verification() {
        let ok = https_get(false, Some(TEST_CA.as_bytes())).await.unwrap();
        assert!(ok.is_success() && ok.body.contains("success"));
        // The leaf is not trusted by itself, nor by the system roots.
        let err = https_get(false, Some(TEST_LEAF.as_bytes()))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("TLS handshake"), "{err:#}");
        let err = https_get(false, None).await.unwrap_err();
        assert!(format!("{err:#}").contains("TLS handshake"), "{err:#}");
        // Skipping verification accepts it.
        assert!(https_get(true, None).await.unwrap().is_success());
        // A CA bundle without certificates is refused up front.
        let err = https_get(false, Some(b"not a pem")).await.unwrap_err();
        assert!(err.to_string().contains("CA bundle"), "{err}");
    }

    #[tokio::test]
    async fn a_trusted_certificate_for_another_name_is_refused() {
        // The leaf is for prometheus.monitoring.svc, signed by the trusted CA.
        let err = https_get_as(
            "thanos-query.monitoring.svc",
            false,
            Some(TEST_CA.as_bytes()),
        )
        .await
        .unwrap_err();
        let err = format!("{err:#}");
        assert!(
            err.contains("TLS handshake with thanos-query.monitoring.svc failed"),
            "{err}"
        );
        assert!(err.to_lowercase().contains("name"), "{err}");
    }

    fn secured(tenant: &str) -> PrometheusAccess {
        PrometheusAccess {
            tenant: tenant.into(),
            auth: Some(PrometheusAuth::Bearer {
                namespace: "monitoring".into(),
                secret: "prom-auth".into(),
                token_key: "token".into(),
            }),
            ..Default::default()
        }
    }

    async fn read_ok() -> Result<TunnelSecrets> {
        Ok(TunnelSecrets {
            credentials: Credentials("Bearer t0k".into()),
            ca: None,
        })
    }

    #[tokio::test]
    async fn cached_values_expire_and_stale_ones_are_dropped() {
        let cache = TunnelCache::with_limits(Duration::from_millis(80), SETUP_TIMEOUT);
        let access = secured("a");
        cache
            .secrets_with("c1", Some(1), &access, read_ok())
            .await
            .unwrap();
        assert!(cache.holds("c1"));
        let now = Instant::now();
        assert!(cache.get_at("c1", Some(1), &access, now).is_some(), "fresh");
        // Another connection or other settings drop the entry at once.
        assert!(cache.get_at("c1", Some(2), &access, now).is_none());
        assert!(!cache.holds("c1"), "another connection");
        cache
            .secrets_with("c1", Some(1), &access, read_ok())
            .await
            .unwrap();
        assert!(cache.get_at("c1", Some(1), &secured("b"), now).is_none());
        assert!(!cache.holds("c1"), "other settings");
        // Expired: dropped on the next look…
        cache
            .secrets_with("c1", Some(1), &access, read_ok())
            .await
            .unwrap();
        let later = Instant::now() + Duration::from_millis(100);
        assert!(cache.get_at("c1", Some(1), &access, later).is_none());
        assert!(!cache.holds("c1"), "expired");
        // …and by the timer when nothing looks again.
        cache
            .secrets_with("c1", Some(1), &access, read_ok())
            .await
            .unwrap();
        assert!(cache.holds("c1"));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!cache.holds("c1"), "the timer dropped it");
    }

    #[tokio::test]
    async fn forget_drops_a_cluster_only() {
        let cache = TunnelCache::default();
        let access = secured("");
        cache.seed("c1", &access);
        cache.seed("c2", &access);
        cache.forget("c1");
        assert!(!cache.holds("c1") && cache.holds("c2"));
        // A later read is a fresh one.
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let counted = || async {
            reads.fetch_add(1, Ordering::SeqCst);
            read_ok().await
        };
        cache
            .secrets_with("c1", None, &access, counted())
            .await
            .unwrap();
        cache
            .secrets_with("c1", None, &access, counted())
            .await
            .unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 1, "cached after the read");
    }

    #[tokio::test]
    async fn a_read_in_flight_during_forget_is_not_kept() {
        // Disconnect or an access change forgets the cluster while its Secret
        // is being read: the read still answers its own request, but its
        // values must not be cached for the next one.
        let cache = Arc::new(TunnelCache::default());
        let access = secured("");
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let (started, reading) = tokio::sync::oneshot::channel::<()>();
        let in_flight = {
            let (cache, access) = (cache.clone(), access.clone());
            tokio::spawn(async move {
                let read = async {
                    let _ = started.send(());
                    let _ = released.await;
                    read_ok().await
                };
                cache.secrets_with("c1", None, &access, read).await
            })
        };
        reading.await.unwrap();
        cache.forget("c1");
        release.send(()).unwrap();
        assert!(
            in_flight.await.unwrap().is_ok(),
            "its own request is answered"
        );
        assert!(!cache.holds("c1"), "a stale fill is discarded");

        // The next request reads again, and that read is kept.
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let counted = || async {
            reads.fetch_add(1, Ordering::SeqCst);
            read_ok().await
        };
        for _ in 0..2 {
            cache
                .secrets_with("c1", None, &access, counted())
                .await
                .unwrap();
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert!(cache.holds("c1"));
    }

    #[tokio::test]
    async fn a_source_from_before_forget_never_caches() {
        // A command resolved its source (and the epoch), then the cluster
        // was disconnected; the command's later requests still read the
        // Secret for themselves, but neither cache it nor drop what the
        // next connection cached.
        let cache = TunnelCache::default();
        let access = secured("");
        let resolved = cache.epoch("c1");
        cache.forget("c1");
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let counted = || async {
            reads.fetch_add(1, Ordering::SeqCst);
            read_ok().await
        };
        cache
            .secrets_in("c1", None, &access, resolved, counted())
            .await
            .unwrap();
        assert!(!cache.holds("c1"), "not cached after forget");

        let fresh = cache.epoch("c1");
        cache
            .secrets_in("c1", Some(2), &secured("new"), fresh, counted())
            .await
            .unwrap();
        cache
            .secrets_in("c1", None, &access, resolved, counted())
            .await
            .unwrap();
        assert_eq!(
            reads.load(Ordering::SeqCst),
            3,
            "the stale caller reads itself"
        );
        assert!(
            cache
                .get_at("c1", Some(2), &secured("new"), Instant::now())
                .is_some(),
            "the current entry stays"
        );
    }

    #[tokio::test]
    async fn a_hung_read_times_out_without_holding_up_other_clusters() {
        let cache = Arc::new(TunnelCache::with_limits(
            SECRETS_TTL,
            Duration::from_millis(300),
        ));
        let access = secured("");
        let hung = {
            let (cache, access) = (cache.clone(), access.clone());
            tokio::spawn(async move {
                cache
                    .secrets_with("hung", None, &access, std::future::pending())
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        // Another cluster is served while the first one hangs.
        let started = Instant::now();
        cache
            .secrets_with("ok", None, &access, read_ok())
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(200));
        let err = hung.await.unwrap().unwrap_err().to_string();
        assert!(
            err.contains("Secret monitoring/prom-auth could not be read within"),
            "{err}"
        );
        assert!(!cache.holds("hung"));
    }

    #[test]
    fn tunnel_failures_are_told_apart() {
        let failure = tunnel_failure(anyhow!("no running and ready pod"));
        assert!(is_tunnel_failure(&failure));
        assert_eq!(failure.to_string(), "no running and ready pod");
        assert!(!is_tunnel_failure(&anyhow!("bad_data: parse error")));
    }
}
