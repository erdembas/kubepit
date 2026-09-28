//! Prometheus as an optional, richer metrics source (like Lens/Freelens).
//!
//! - [`detect`] finds a Prometheus-compatible API among the cluster's
//!   services (kube-prometheus-stack, the prometheus-community chart,
//!   Thanos, VictoriaMetrics, Mimir, OpenShift) or uses the service set in
//!   `ClusterDef.prometheus`; the answer is cached per connection
//!   ([`PrometheusCache`]).
//! - [`proxy`] sends every request through the API server's service proxy
//!   with the cluster's own client: no port-forward, RBAC applies.
//! - [`access`] holds the settings of a shared or secured source (tenant,
//!   cluster labels, Secret-backed credentials); [`matchers`] injects the
//!   cluster-label selector into every preset. `Kubepit::prometheus_send`
//!   (after `prometheus_source`) is the one transport every caller uses;
//!   with credentials it goes through an in-process port-forward tunnel
//!   (`tunnel`) instead of the service proxy, which does not forward
//!   `Authorization`.
//! - [`promql`] holds the preset queries (cluster, node, namespace,
//!   workload, pod, container, PVC × CPU, memory, network, filesystem,
//!   volumes, restarts), so the UI never builds PromQL; [`range`] picks the
//!   step and rate window; [`parse`] reads the API's JSON.
//! - [`usage`] and [`workload_stats`] hold the instant queries of cost
//!   estimates and right-sizing (16 per-pod-container statistics per batch,
//!   evaluated at an aligned window end); [`usage_history`] the range
//!   queries of one container's usage for the recommendation charts.
//!
//! Everything here only reads (GETs through the proxy), so it is allowed on
//! read-only clusters. Charts fall back to the metrics-server history when
//! the status is anything but `available`.

pub mod access;
pub mod detect;
pub mod matchers;
pub mod parse;
pub mod promql;
pub mod proxy;
pub mod range;
pub(crate) mod tunnel;
// Usage statistics for cost estimates and right-sizing.
pub mod usage;
// Per-container usage history (recommendation charts).
pub mod usage_history;
// Server-side workload statistics (right-sizing collection).
pub mod workload_stats;

use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use kube::Client;

use crate::app::Kubepit;
use crate::objects::now_millis;
use crate::service_proxy::{
    all_forbidden, is_proxy_failure, is_proxy_forbidden, valid_name, with_query, DetectCache,
    DetectedStatus,
};
use crate::types::{
    ClusterDef, PromQueryResult, PrometheusConfig, PrometheusKind, PrometheusMetric,
    PrometheusMetricsResult, PrometheusRange, PrometheusSeries, PrometheusService,
    PrometheusSource, PrometheusState, PrometheusStatus, PrometheusTarget,
};
use access::PrometheusAccess;
use detect::MAX_PROBES;
use parse::PromData;
use range::Window;
use tunnel::TunnelCache;

pub use crate::service_proxy::RECHECK_AFTER;
/// Series one ad-hoc query returns at most.
pub const MAX_QUERY_SERIES: usize = 200;
/// Points one ad-hoc query returns at most (over all series).
pub const MAX_QUERY_POINTS: usize = 250_000;
/// Longest accepted PromQL expression.
pub const MAX_QUERY_LEN: usize = 16 * 1024;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

pub use crate::service_proxy::normalize_prefix;

impl PrometheusConfig {
    /// Trimmed and validated, as stored in `clusters.json`.
    pub fn normalized(self) -> Result<Self> {
        match self {
            PrometheusConfig::Service {
                namespace,
                service,
                port,
                scheme,
                path_prefix,
            } => {
                let namespace = namespace.trim().to_string();
                let service = service.trim().to_string();
                if !valid_name(&namespace) {
                    bail!("Prometheus: enter the namespace of the service");
                }
                if !valid_name(&service) {
                    bail!("Prometheus: enter the name of the service");
                }
                if port == 0 {
                    bail!("Prometheus: enter the service port");
                }
                Ok(PrometheusConfig::Service {
                    namespace,
                    service,
                    port,
                    scheme,
                    path_prefix: normalize_prefix(&path_prefix)?,
                })
            }
            other => Ok(other),
        }
    }

    /// The configured service (`mode: service`).
    pub fn service(&self) -> Option<PrometheusService> {
        match self {
            PrometheusConfig::Service {
                namespace,
                service,
                port,
                scheme,
                path_prefix,
            } => Some(PrometheusService {
                kind: PrometheusKind::Custom,
                namespace: namespace.clone(),
                service: service.clone(),
                port: *port,
                scheme: *scheme,
                path_prefix: path_prefix.clone(),
            }),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Detection cache
// ---------------------------------------------------------------------------

/// Detection results per cluster (see [`DetectCache`]), keyed by the
/// source setting and its access settings (a new tenant or credentials
/// probe again).
pub type PrometheusCache = DetectCache<(PrometheusConfig, PrometheusAccess), PrometheusStatus>;

impl DetectedStatus for PrometheusStatus {
    fn is_available(&self) -> bool {
        self.state == PrometheusState::Available
    }
}

fn status(state: PrometheusState) -> PrometheusStatus {
    PrometheusStatus {
        state,
        service: None,
        source: None,
        error: None,
        candidates: Vec::new(),
        checked_at: now_millis(),
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// Who wrote a query: Kubepit (presets get the cluster-label selector) or
/// the user (the PromQL tab; sent as typed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Preset,
    User,
}

/// How requests reach one cluster's Prometheus: the service, the cluster's
/// access settings and, for the tunnel, where its Secret values are cached.
pub(crate) struct Link<'a> {
    pub client: &'a Client,
    pub service: &'a PrometheusService,
    pub access: &'a PrometheusAccess,
    /// `service` is the one the cluster settings name
    /// ([`access::credentials_allowed`]); credentials go nowhere else.
    pub credentials_allowed: bool,
    pub tunnels: &'a TunnelCache,
    pub cluster_id: &'a str,
    pub connected_at: Option<i64>,
    /// The cluster's tunnel epoch when the source was resolved
    /// ([`TunnelCache::epoch`]): requests of a command that outlived a
    /// disconnect or an access change do not cache Secret values.
    pub tunnel_epoch: u64,
}

impl Link<'_> {
    /// One GET of `endpoint` (`/api/v1/query`) with `params` as they are,
    /// with `X-Scope-OrgID` when a tenant is set: through the service proxy,
    /// or through the port-forward tunnel when credentials are configured.
    pub(crate) async fn get(
        &self,
        endpoint: &str,
        params: &[(&str, String)],
        timeout: Duration,
    ) -> Result<PromData> {
        if self.access.auth.is_some() {
            // Defence in depth: validation already refuses credentials
            // without a chosen service (an older clusters.json may not).
            if !self.credentials_allowed {
                bail!(access::CREDENTIALS_NEED_A_SERVICE);
            }
            // Setup failures (the Secret, the pod, the port-forward, TLS)
            // are tunnel failures; a query timing out over an established
            // tunnel is not (see `tunnel`).
            let secrets = self
                .tunnels
                .secrets(
                    self.cluster_id,
                    self.connected_at,
                    self.client,
                    self.access,
                    self.tunnel_epoch,
                )
                .await
                .map_err(tunnel::tunnel_failure)?;
            let path = with_query(&format!("{}{endpoint}", self.service.path_prefix), params);
            let response = tunnel::tunnel_get(
                self.client,
                self.service,
                self.access,
                &secrets,
                &path,
                timeout,
            )
            .await?;
            return proxy::answer(response);
        }
        let tenant = self.access.tenant.trim();
        let headers: &[(&str, &str)] = if tenant.is_empty() {
            &[]
        } else {
            &[("X-Scope-OrgID", tenant)]
        };
        let path = proxy::proxy_path(self.service, endpoint, params);
        proxy::get(self.client, &path, headers, timeout).await
    }
}

/// The Prometheus of one cluster connection, resolved once per command.
pub(crate) struct Source<'a> {
    pub cluster_id: String,
    pub client: Client,
    pub connected_at: Option<i64>,
    pub service: PrometheusService,
    pub access: PrometheusAccess,
    pub tunnels: &'a TunnelCache,
    /// See [`Link::credentials_allowed`].
    pub credentials_allowed: bool,
    /// See [`Link::tunnel_epoch`].
    pub tunnel_epoch: u64,
}

impl Source<'_> {
    pub(crate) fn link(&self) -> Link<'_> {
        Link {
            client: &self.client,
            service: &self.service,
            access: &self.access,
            credentials_allowed: self.credentials_allowed,
            tunnels: self.tunnels,
            cluster_id: &self.cluster_id,
            connected_at: self.connected_at,
            tunnel_epoch: self.tunnel_epoch,
        }
    }

    /// `query` as it is sent: presets get the cluster-label selector.
    pub(crate) fn query(&self, query: &str, origin: Origin) -> String {
        match origin {
            Origin::Preset => matchers::with_matchers(query, &self.access.matchers()),
            Origin::User => query.to_string(),
        }
    }
}

fn range_params(query: &str, window: &Window) -> Vec<(&'static str, String)> {
    vec![
        ("query", query.to_string()),
        ("start", window.start_secs.to_string()),
        ("end", window.end_secs.to_string()),
        ("step", window.step_secs.to_string()),
    ]
}

/// Run detection (or probe the configured service). Never fails: problems
/// become `not-found` / `unreachable` / `forbidden` with an explanation.
/// Any candidate answering wins; `forbidden` needs every probed candidate
/// refused by the API server (no `get` on `services/proxy`).
async fn detect_status(
    client: &Client,
    cluster: &ClusterDef,
    tunnels: &TunnelCache,
    connected_at: Option<i64>,
) -> PrometheusStatus {
    let tunnel_epoch = tunnels.epoch(&cluster.id);
    let link = |service| Link {
        client,
        service,
        access: &cluster.prometheus_access,
        // Detected candidates never qualify: only the configured service.
        credentials_allowed: access::credentials_allowed(&cluster.prometheus, service),
        tunnels,
        cluster_id: &cluster.id,
        connected_at,
        tunnel_epoch,
    };
    match &cluster.prometheus {
        PrometheusConfig::Off => status(PrometheusState::Off),
        config @ PrometheusConfig::Service { .. } => {
            let service = config.service().expect("service mode");
            let result = detect::probe(&link(&service)).await;
            PrometheusStatus {
                state: match &result {
                    Ok(()) => PrometheusState::Available,
                    Err(e) if is_proxy_forbidden(e) => PrometheusState::Forbidden,
                    Err(_) => PrometheusState::Unreachable,
                },
                error: result.err().map(|e| format!("{e:#}")),
                service: Some(service),
                source: Some(PrometheusSource::Configured),
                ..status(PrometheusState::Available)
            }
        }
        PrometheusConfig::Auto => {
            let services = match detect::list_services(client, &cluster.accessible_namespaces).await
            {
                Ok(services) => services,
                Err(e) => {
                    return PrometheusStatus {
                        error: Some(format!("could not list services: {e:#}")),
                        ..status(PrometheusState::NotFound)
                    }
                }
            };
            let candidates: Vec<PrometheusService> = detect::rank(&services)
                .into_iter()
                .map(|c| c.service)
                .collect();
            if candidates.is_empty() {
                return status(PrometheusState::NotFound);
            }
            // Probe the best few at once; the best-ranked one that answers wins.
            let probes = futures::future::join_all(
                candidates
                    .iter()
                    .take(MAX_PROBES)
                    .map(|service| async move { detect::probe(&link(service)).await }),
            )
            .await;
            let winner = probes.iter().position(Result::is_ok);
            let forbidden = all_forbidden(&probes);
            let error = probes
                .into_iter()
                .find_map(Result::err)
                .map(|e| format!("{e:#}"));
            match winner {
                Some(i) => PrometheusStatus {
                    service: Some(candidates[i].clone()),
                    source: Some(PrometheusSource::Detected),
                    candidates,
                    ..status(PrometheusState::Available)
                },
                None => PrometheusStatus {
                    service: Some(candidates[0].clone()),
                    source: Some(PrometheusSource::Detected),
                    error,
                    candidates,
                    ..status(if forbidden {
                        PrometheusState::Forbidden
                    } else {
                        PrometheusState::Unreachable
                    })
                },
            }
        }
    }
}

impl Kubepit {
    /// The Prometheus client of the cluster's current connection (connecting
    /// on demand, like every command).
    async fn prometheus_client(&self, cluster: &ClusterDef) -> Result<(Client, Option<i64>)> {
        self.service_proxy_client(cluster).await
    }

    /// `prometheus_status`: the cached detection result of this connection,
    /// or a fresh detection (`refresh`, first call, expired negative answer).
    pub async fn prometheus_status(
        &self,
        cluster_id: &str,
        refresh: bool,
    ) -> Result<PrometheusStatus> {
        let cluster = self.cluster_def(cluster_id)?;
        if cluster.prometheus == PrometheusConfig::Off {
            return Ok(status(PrometheusState::Off));
        }
        let (client, connected_at) = self.prometheus_client(&cluster).await?;
        let lock = self.prometheus.detect_lock(cluster_id);
        let _serialised = lock.lock().await;
        let key = (
            cluster.prometheus.clone(),
            cluster.prometheus_access.clone(),
        );
        if !refresh {
            if let Some(cached) =
                self.prometheus
                    .get_at(cluster_id, connected_at, &key, Instant::now())
            {
                return Ok(cached);
            }
        }
        let result = detect_status(&client, &cluster, &self.prometheus_tunnels, connected_at).await;
        if let (PrometheusState::Available, Some(service)) = (result.state, &result.service) {
            tracing::info!(
                cluster = %cluster.name,
                "Prometheus: {}/{}:{}",
                service.namespace,
                service.service,
                service.port
            );
        }
        self.prometheus
            .put(cluster_id, connected_at, key, result.clone());
        Ok(result)
    }

    /// The service to query, a client for it and the access settings, or
    /// why there is none.
    pub(crate) async fn prometheus_source(&self, cluster_id: &str) -> Result<Source<'_>> {
        // Before anything else: a forget while this command runs (even
        // during detection) keeps its Secret reads out of the cache.
        let tunnel_epoch = self.prometheus_tunnels.epoch(cluster_id);
        let status = self.prometheus_status(cluster_id, false).await?;
        match (status.state, status.service) {
            (PrometheusState::Available, Some(service)) => {
                let cluster = self.cluster_def(cluster_id)?;
                let (client, connected_at) = self.prometheus_client(&cluster).await?;
                Ok(Source {
                    cluster_id: cluster_id.to_string(),
                    client,
                    connected_at,
                    credentials_allowed: access::credentials_allowed(&cluster.prometheus, &service),
                    service,
                    access: cluster.prometheus_access,
                    tunnels: &self.prometheus_tunnels,
                    tunnel_epoch,
                })
            }
            (PrometheusState::Off, _) => bail!("Prometheus is turned off for this cluster"),
            (PrometheusState::Unreachable, Some(service)) => bail!(
                "Prometheus at {}/{} is not reachable{}",
                service.namespace,
                service.service,
                status.error.map(|e| format!(": {e}")).unwrap_or_default()
            ),
            (PrometheusState::Forbidden, Some(service)) => bail!(
                "Prometheus at {}/{} needs get on services/proxy in namespace {}{}",
                service.namespace,
                service.service,
                service.namespace,
                status.error.map(|e| format!(": {e}")).unwrap_or_default()
            ),
            _ => bail!("no Prometheus was found on this cluster"),
        }
    }

    /// The one Prometheus transport: one request to `source` (resolved once
    /// per command by `prometheus_source`). Every request carries the tenant
    /// and goes through the proxy or, with credentials, the tunnel; the query
    /// of a preset gets the cluster-label selector; a proxy or tunnel failure
    /// (the service vanished, no ready pod, unreadable credentials) makes the
    /// next status request detect again.
    pub(crate) async fn prometheus_send(
        &self,
        source: &Source<'_>,
        endpoint: &str,
        params: Vec<(&str, String)>,
        origin: Origin,
        timeout: Duration,
    ) -> Result<PromData> {
        let params: Vec<(&str, String)> = params
            .into_iter()
            .map(|(key, value)| match key {
                "query" => (key, source.query(&value, origin)),
                _ => (key, value),
            })
            .collect();
        source
            .link()
            .get(endpoint, &params, timeout)
            .await
            .inspect_err(|e| {
                if is_proxy_failure(e) || tunnel::is_tunnel_failure(e) {
                    self.prometheus.invalidate(&source.cluster_id);
                }
            })
    }

    /// `prometheus_metrics`: preset series of `target` over `range`.
    /// `metrics` empty = every metric that applies to the target. Series
    /// fail individually; only when every one fails is the call an error.
    pub async fn prometheus_metrics(
        &self,
        cluster_id: &str,
        target: &PrometheusTarget,
        metrics: &[PrometheusMetric],
        range: &PrometheusRange,
    ) -> Result<PrometheusMetricsResult> {
        let window = Window::new(range)?;
        let source = self.prometheus_source(cluster_id).await?;
        let rate = range::rate_window(window.step_secs);
        let mut wanted: Vec<PrometheusMetric> = if metrics.is_empty() {
            promql::default_metrics(target)
        } else {
            metrics.to_vec()
        };
        let mut seen = std::collections::HashSet::new();
        wanted.retain(|m| seen.insert(*m));
        let queries: Vec<(PrometheusMetric, String)> = wanted
            .into_iter()
            .filter_map(|m| promql::preset(target, m, rate).map(|q| (m, q)))
            .collect();
        let results = futures::future::join_all(queries.iter().map(|(_, q)| {
            self.prometheus_send(
                &source,
                "/api/v1/query_range",
                range_params(q, &window),
                Origin::Preset,
                proxy::QUERY_TIMEOUT,
            )
        }))
        .await;

        let mut first_error: Option<anyhow::Error> = None;
        let mut series = Vec::with_capacity(queries.len());
        for ((metric, query), result) in queries.into_iter().zip(results) {
            let (points, error) = match result {
                Ok(data) => (parse::sum_series(&data.series), None),
                Err(e) => {
                    let message = format!("{e:#}");
                    first_error.get_or_insert(e);
                    (Vec::new(), Some(message))
                }
            };
            series.push(PrometheusSeries {
                metric,
                // What was sent, so a PromQL tab opened from it matches.
                query: source.query(&query, Origin::Preset),
                points,
                error,
            });
        }
        if let Some(err) = first_error {
            if series.iter().all(|s| s.error.is_some()) {
                return Err(err);
            }
        }
        Ok(PrometheusMetricsResult {
            service: source.service,
            step_secs: window.step_secs,
            rate_window_secs: rate,
            start: window.start_ms(),
            end: window.end_ms(),
            series,
        })
    }

    /// `prometheus_query_range`: an ad-hoc PromQL range query (PromQL tab),
    /// sent as typed.
    pub async fn prometheus_query_range(
        &self,
        cluster_id: &str,
        query: &str,
        range: &PrometheusRange,
    ) -> Result<PromQueryResult> {
        self.prometheus_range(cluster_id, query, range, Origin::User)
            .await
    }

    /// A range query of `origin` (upgrade readiness sends a preset).
    pub(crate) async fn prometheus_range(
        &self,
        cluster_id: &str,
        query: &str,
        range: &PrometheusRange,
        origin: Origin,
    ) -> Result<PromQueryResult> {
        let query = query.trim();
        if query.is_empty() {
            bail!("enter a PromQL expression");
        }
        if query.len() > MAX_QUERY_LEN {
            bail!(
                "the query is too long (at most {} KiB)",
                MAX_QUERY_LEN / 1024
            );
        }
        let window = Window::new(range)?;
        let source = self.prometheus_source(cluster_id).await?;
        let data = self
            .prometheus_send(
                &source,
                "/api/v1/query_range",
                range_params(query, &window),
                origin,
                proxy::QUERY_TIMEOUT,
            )
            .await?;
        let total = data.series.len();
        let mut points = 0usize;
        let series: Vec<_> = data
            .series
            .into_iter()
            .take(MAX_QUERY_SERIES)
            .take_while(|s| {
                points += s.points.len();
                points <= MAX_QUERY_POINTS
            })
            .collect();
        Ok(PromQueryResult {
            service: source.service,
            step_secs: window.step_secs,
            start: window.start_ms(),
            end: window.end_ms(),
            result_type: data.result_type,
            truncated: series.len() < total,
            series,
            warnings: data.warnings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PromScheme;

    fn service_config(prefix: &str) -> PrometheusConfig {
        PrometheusConfig::Service {
            namespace: " monitoring ".into(),
            service: "prometheus-server ".into(),
            port: 80,
            scheme: PromScheme::Http,
            path_prefix: prefix.into(),
        }
    }

    #[test]
    fn config_roundtrips_the_ts_union() {
        let auto: PrometheusConfig = serde_json::from_str(r#"{"mode":"auto"}"#).unwrap();
        assert_eq!(auto, PrometheusConfig::Auto);
        let svc: PrometheusConfig =
            serde_json::from_str(r#"{"mode":"service","namespace":"m","service":"p","port":9090}"#)
                .unwrap();
        assert_eq!(
            svc,
            PrometheusConfig::Service {
                namespace: "m".into(),
                service: "p".into(),
                port: 9090,
                scheme: PromScheme::Http,
                path_prefix: String::new(),
            }
        );
        assert_eq!(
            serde_json::to_value(PrometheusConfig::Off).unwrap(),
            serde_json::json!({"mode": "off"})
        );
        // Older clusters.json files have no `prometheus` field.
        let def: ClusterDef = serde_json::from_value(serde_json::json!({
            "id": "c", "name": "c", "context": "x", "kubeconfig_path": "/k"
        }))
        .unwrap();
        assert_eq!(def.prometheus, PrometheusConfig::Auto);
    }

    #[test]
    fn service_config_is_trimmed_and_validated() {
        let normalized = service_config(" /prometheus/ ").normalized().unwrap();
        assert_eq!(
            normalized,
            PrometheusConfig::Service {
                namespace: "monitoring".into(),
                service: "prometheus-server".into(),
                port: 80,
                scheme: PromScheme::Http,
                path_prefix: "/prometheus".into(),
            }
        );
        let service = normalized.service().unwrap();
        assert_eq!(service.kind, PrometheusKind::Custom);
        assert_eq!(service.path_prefix, "/prometheus");

        assert!(service_config("/../api").normalized().is_err());
        assert!(service_config("/a//b").normalized().is_err());
        assert!(service_config("/a?b").normalized().is_err());
        assert_eq!(
            normalize_prefix("select/0/prometheus").unwrap(),
            "/select/0/prometheus"
        );
        assert_eq!(normalize_prefix("  ").unwrap(), "");
        let bad_port = PrometheusConfig::Service {
            namespace: "m".into(),
            service: "p".into(),
            port: 0,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        assert!(bad_port.normalized().is_err());
        let bad_name = PrometheusConfig::Service {
            namespace: "Monitoring!".into(),
            service: "p".into(),
            port: 1,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        assert!(bad_name.normalized().is_err());
        assert_eq!(
            PrometheusConfig::Off.normalized().unwrap(),
            PrometheusConfig::Off
        );
        assert!(PrometheusConfig::Auto.service().is_none());
    }

    #[test]
    fn cache_is_per_connection_and_config_and_negative_answers_expire() {
        let cache = PrometheusCache::default();
        let now = Instant::now();
        let auto = (PrometheusConfig::Auto, PrometheusAccess::default());
        assert!(cache.get_at("c", Some(1), &auto, now).is_none());

        cache.put(
            "c",
            Some(1),
            auto.clone(),
            status(PrometheusState::Available),
        );
        assert!(cache.get_at("c", Some(1), &auto, now).is_some());
        assert!(
            cache.get_at("c", Some(2), &auto, now).is_none(),
            "reconnected"
        );
        assert!(
            cache
                .get_at(
                    "c",
                    Some(1),
                    &(PrometheusConfig::Off, PrometheusAccess::default()),
                    now
                )
                .is_none(),
            "setting changed"
        );
        let tenant = PrometheusAccess {
            tenant: "team-a".into(),
            ..Default::default()
        };
        assert!(
            cache
                .get_at("c", Some(1), &(PrometheusConfig::Auto, tenant), now)
                .is_none(),
            "access settings changed"
        );
        let later = now + RECHECK_AFTER * 3;
        assert!(
            cache.get_at("c", Some(1), &auto, later).is_some(),
            "positive answers stay"
        );
        cache.invalidate("c");
        assert!(cache.get_at("c", Some(1), &auto, now).is_none(), "stale");

        cache.put(
            "c",
            Some(1),
            auto.clone(),
            status(PrometheusState::NotFound),
        );
        let now = Instant::now();
        assert!(cache.get_at("c", Some(1), &auto, now).is_some());
        assert!(
            cache
                .get_at(
                    "c",
                    Some(1),
                    &auto,
                    now + RECHECK_AFTER + Duration::from_secs(1)
                )
                .is_none(),
            "negative answers are rechecked"
        );
    }

    #[test]
    fn proxy_failures_are_told_apart_from_query_errors() {
        let proxy_err: anyhow::Error = proxy::http_error(
            503,
            r#"{"kind":"Status","message":"no endpoints available for service \"p\"","code":503}"#,
        )
        .into();
        assert!(is_proxy_failure(&proxy_err));
        let prom_err: anyhow::Error = proxy::http_error(
            503,
            r#"{"status":"error","errorType":"unavailable","error":"too busy"}"#,
        )
        .into();
        assert!(!is_proxy_failure(&prom_err));
        let bad_query: anyhow::Error = proxy::http_error(400, "nope").into();
        assert!(!is_proxy_failure(&bad_query));
    }
}
