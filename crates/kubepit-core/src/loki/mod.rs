//! Loki as the source of historical logs (pods that are gone, time ranges
//! older than the kubelet keeps).
//!
//! - [`detect`] finds Loki's query API among the cluster's services (the
//!   grafana/loki chart's gateway, the microservices query frontend, the
//!   simple scalable read path, a single binary) or uses the service set in
//!   `ClusterDef.loki`; the answer is cached per connection ([`LokiCache`],
//!   the same cache as Prometheus').
//! - Every request goes through the API server's service proxy with the
//!   cluster's own retry-free client ([`crate::service_proxy`]), like
//!   Prometheus: no port-forward, RBAC applies (`services/proxy`).
//! - [`request`] builds `query_range` / `labels` / `label values` requests;
//!   [`parse`] reads streams (nanosecond timestamps) and metric matrices.
//!
//! Everything here only reads (GETs through the proxy), so it is allowed on
//! read-only clusters. LogQL is written by the user or built in the UI; the
//! backend validates bounds and forwards it verbatim.

pub mod detect;
pub mod parse;
pub mod request;

use std::time::Instant;

use anyhow::{bail, Result};
use kube::Client;

use crate::app::Kubepit;
use crate::objects::now_millis;
use crate::service_proxy::{
    self, all_forbidden, is_proxy_failure, is_proxy_forbidden, valid_name, DetectCache,
    DetectedStatus,
};
use crate::types::{
    ClusterDef, LokiConfig, LokiKind, LokiQuery, LokiQueryResult, LokiService, LokiSource,
    LokiState, LokiStatus,
};
use detect::MAX_PROBES;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// `[\x21-\x7e]{1,150}` without `|` (Loki's tenant id rules; `|` separates
/// federated tenants, which a single header value would not express).
fn valid_tenant(value: &str) -> bool {
    value.len() <= 150
        && value
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b'|')
}

impl LokiConfig {
    /// Trimmed and validated, as stored in `clusters.json`.
    pub fn normalized(self) -> Result<Self> {
        match self {
            LokiConfig::Service {
                namespace,
                service,
                port,
                scheme,
                path_prefix,
                tenant,
            } => {
                let namespace = namespace.trim().to_string();
                let service = service.trim().to_string();
                let tenant = tenant.trim().to_string();
                if !valid_name(&namespace) {
                    bail!("Loki: enter the namespace of the service");
                }
                if !valid_name(&service) {
                    bail!("Loki: enter the name of the service");
                }
                if port == 0 {
                    bail!("Loki: enter the service port");
                }
                if !valid_tenant(&tenant) {
                    bail!("Loki: the tenant may only contain printable ASCII characters except '|' (at most 150)");
                }
                Ok(LokiConfig::Service {
                    namespace,
                    service,
                    port,
                    scheme,
                    path_prefix: service_proxy::normalize_prefix(&path_prefix)?,
                    tenant,
                })
            }
            other => Ok(other),
        }
    }

    /// The configured service (`mode: service`).
    pub fn service(&self) -> Option<LokiService> {
        match self {
            LokiConfig::Service {
                namespace,
                service,
                port,
                scheme,
                path_prefix,
                ..
            } => Some(LokiService {
                kind: LokiKind::Custom,
                namespace: namespace.clone(),
                service: service.clone(),
                port: *port,
                scheme: *scheme,
                path_prefix: path_prefix.clone(),
            }),
            _ => None,
        }
    }

    /// `X-Scope-OrgID` to send (`""` = none).
    pub fn tenant(&self) -> &str {
        match self {
            LokiConfig::Service { tenant, .. } => tenant,
            _ => "",
        }
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Detection results per cluster (see [`DetectCache`]).
pub type LokiCache = DetectCache<LokiConfig, LokiStatus>;

impl DetectedStatus for LokiStatus {
    fn is_available(&self) -> bool {
        self.state == LokiState::Available
    }
}

fn status(state: LokiState) -> LokiStatus {
    LokiStatus {
        state,
        service: None,
        source: None,
        error: None,
        candidates: Vec::new(),
        checked_at: now_millis(),
    }
}

/// Run detection (or probe the configured service). Never fails: problems
/// become `not-found` / `unreachable` / `forbidden` with an explanation.
/// Any candidate answering wins; `forbidden` needs every probed candidate
/// refused by the API server (no `get` on `services/proxy`).
async fn detect_status(client: &Client, cluster: &ClusterDef) -> LokiStatus {
    match &cluster.loki {
        LokiConfig::Off => status(LokiState::Off),
        config @ LokiConfig::Service { .. } => {
            let service = config.service().expect("service mode");
            let result = detect::probe(client, &service, config.tenant()).await;
            LokiStatus {
                state: match &result {
                    Ok(()) => LokiState::Available,
                    Err(e) if is_proxy_forbidden(e) => LokiState::Forbidden,
                    Err(_) => LokiState::Unreachable,
                },
                error: result.err().map(|e| format!("{e:#}")),
                service: Some(service),
                source: Some(LokiSource::Configured),
                ..status(LokiState::Available)
            }
        }
        LokiConfig::Auto => {
            let services = match detect::list_services(client, &cluster.accessible_namespaces).await
            {
                Ok(services) => services,
                Err(e) => {
                    return LokiStatus {
                        error: Some(format!("could not list services: {e:#}")),
                        ..status(LokiState::NotFound)
                    }
                }
            };
            let candidates: Vec<LokiService> = detect::rank(&services)
                .into_iter()
                .map(|c| c.service)
                .collect();
            if candidates.is_empty() {
                return status(LokiState::NotFound);
            }
            // Probe the best few at once; the best-ranked one that answers wins.
            let probes = futures::future::join_all(
                candidates
                    .iter()
                    .take(MAX_PROBES)
                    .map(|service| detect::probe(client, service, "")),
            )
            .await;
            let winner = probes.iter().position(Result::is_ok);
            let forbidden = all_forbidden(&probes);
            let error = probes
                .into_iter()
                .find_map(Result::err)
                .map(|e| format!("{e:#}"));
            match winner {
                Some(i) => LokiStatus {
                    service: Some(candidates[i].clone()),
                    source: Some(LokiSource::Detected),
                    candidates,
                    ..status(LokiState::Available)
                },
                None => LokiStatus {
                    service: Some(candidates[0].clone()),
                    source: Some(LokiSource::Detected),
                    error,
                    candidates,
                    ..status(if forbidden {
                        LokiState::Forbidden
                    } else {
                        LokiState::Unreachable
                    })
                },
            }
        }
    }
}

impl Kubepit {
    /// `loki_status`: the cached detection result of this connection, or a
    /// fresh detection (`refresh`, first call, expired negative answer).
    pub async fn loki_status(&self, cluster_id: &str, refresh: bool) -> Result<LokiStatus> {
        let cluster = self.cluster_def(cluster_id)?;
        if cluster.loki == LokiConfig::Off {
            return Ok(status(LokiState::Off));
        }
        let (client, connected_at) = self.service_proxy_client(&cluster).await?;
        let lock = self.loki.detect_lock(cluster_id);
        let _serialised = lock.lock().await;
        if !refresh {
            if let Some(cached) =
                self.loki
                    .get_at(cluster_id, connected_at, &cluster.loki, Instant::now())
            {
                return Ok(cached);
            }
        }
        let result = detect_status(&client, &cluster).await;
        if let (LokiState::Available, Some(service)) = (result.state, &result.service) {
            tracing::info!(
                cluster = %cluster.name,
                "Loki: {}/{}:{}",
                service.namespace,
                service.service,
                service.port
            );
        }
        self.loki.put(
            cluster_id,
            connected_at,
            cluster.loki.clone(),
            result.clone(),
        );
        Ok(result)
    }

    /// The service to query, a client for it and the tenant, or why there
    /// is none.
    async fn loki_service(&self, cluster_id: &str) -> Result<(LokiService, Client, String)> {
        let status = self.loki_status(cluster_id, false).await?;
        match (status.state, status.service) {
            (LokiState::Available, Some(service)) => {
                let cluster = self.cluster_def(cluster_id)?;
                let (client, _) = self.service_proxy_client(&cluster).await?;
                Ok((service, client, cluster.loki.tenant().to_string()))
            }
            (LokiState::Off, _) => bail!("Loki is turned off for this cluster"),
            (LokiState::Unreachable, Some(service)) => bail!(
                "Loki at {}/{} is not reachable{}",
                service.namespace,
                service.service,
                status.error.map(|e| format!(": {e}")).unwrap_or_default()
            ),
            (LokiState::Forbidden, Some(service)) => bail!(
                "Loki at {}/{} needs get on services/proxy in namespace {}{}",
                service.namespace,
                service.service,
                service.namespace,
                status.error.map(|e| format!(": {e}")).unwrap_or_default()
            ),
            _ => bail!("no Loki was found on this cluster"),
        }
    }

    /// GET through the proxy; a vanished service marks the detection stale.
    async fn loki_get(
        &self,
        cluster_id: &str,
        client: &Client,
        path: &str,
        tenant: &str,
        timeout: std::time::Duration,
    ) -> Result<String> {
        request::get_json(client, path, tenant, timeout)
            .await
            .inspect_err(|e| {
                if is_proxy_failure(e) {
                    self.loki.invalidate(cluster_id);
                }
            })
    }

    /// `loki_query_range`: a LogQL range query (log lines or a metric
    /// query's series). Read-only.
    pub async fn loki_query_range(
        &self,
        cluster_id: &str,
        query: &LokiQuery,
    ) -> Result<LokiQueryResult> {
        let params = request::query_range_params(query)?;
        let limit = request::effective_limit(query);
        let (service, client, tenant) = self.loki_service(cluster_id).await?;
        let path =
            service_proxy::proxy_path(&service.endpoint(), request::QUERY_RANGE_PATH, &params);
        let body = self
            .loki_get(cluster_id, &client, &path, &tenant, request::QUERY_TIMEOUT)
            .await?;
        let data = parse::parse_query(&body, query.direction, limit as usize)?;
        Ok(LokiQueryResult {
            service,
            limit_reached: data.lines.len() >= limit as usize,
            result_type: data.result_type,
            streams: data.streams,
            lines: data.lines,
            series: data.series,
            limit,
            warnings: data.warnings,
        })
    }

    /// `loki_labels`: label names seen in `[start, end]` (ns), optionally
    /// only those of streams matching `query` (a stream selector).
    pub async fn loki_labels(
        &self,
        cluster_id: &str,
        start: &str,
        end: &str,
        query: Option<&str>,
    ) -> Result<Vec<String>> {
        let (start, end) = request::range_ns(start, end)?;
        let (service, client, tenant) = self.loki_service(cluster_id).await?;
        let params = request::labels_params(start, end, query);
        let path = service_proxy::proxy_path(&service.endpoint(), request::LABELS_PATH, &params);
        let body = self
            .loki_get(cluster_id, &client, &path, &tenant, request::LABELS_TIMEOUT)
            .await?;
        parse::parse_labels(&body)
    }

    /// `loki_label_values`: values of `label` in `[start, end]` (ns),
    /// optionally only those of streams matching `query`.
    pub async fn loki_label_values(
        &self,
        cluster_id: &str,
        label: &str,
        start: &str,
        end: &str,
        query: Option<&str>,
    ) -> Result<Vec<String>> {
        let endpoint = request::label_values_path(label)?;
        let (start, end) = request::range_ns(start, end)?;
        let (service, client, tenant) = self.loki_service(cluster_id).await?;
        let params = request::labels_params(start, end, query);
        let path = service_proxy::proxy_path(&service.endpoint(), &endpoint, &params);
        let body = self
            .loki_get(cluster_id, &client, &path, &tenant, request::LABELS_TIMEOUT)
            .await?;
        parse::parse_labels(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PromScheme;

    fn service_config(prefix: &str, tenant: &str) -> LokiConfig {
        LokiConfig::Service {
            namespace: " loki ".into(),
            service: "loki-gateway ".into(),
            port: 80,
            scheme: PromScheme::Http,
            path_prefix: prefix.into(),
            tenant: tenant.into(),
        }
    }

    #[test]
    fn config_roundtrips_the_ts_union() {
        let auto: LokiConfig = serde_json::from_str(r#"{"mode":"auto"}"#).unwrap();
        assert_eq!(auto, LokiConfig::Auto);
        let svc: LokiConfig =
            serde_json::from_str(r#"{"mode":"service","namespace":"l","service":"g","port":80}"#)
                .unwrap();
        assert_eq!(
            svc,
            LokiConfig::Service {
                namespace: "l".into(),
                service: "g".into(),
                port: 80,
                scheme: PromScheme::Http,
                path_prefix: String::new(),
                tenant: String::new(),
            }
        );
        assert_eq!(
            serde_json::to_value(LokiConfig::Off).unwrap(),
            serde_json::json!({"mode": "off"})
        );
        // Older clusters.json files have no `loki` field.
        let def: ClusterDef = serde_json::from_value(serde_json::json!({
            "id": "c", "name": "c", "context": "x", "kubeconfig_path": "/k"
        }))
        .unwrap();
        assert_eq!(def.loki, LokiConfig::Auto);
    }

    #[test]
    fn service_config_is_trimmed_and_validated() {
        let normalized = service_config(" /loki/ ", " team-a ").normalized().unwrap();
        assert_eq!(
            normalized,
            LokiConfig::Service {
                namespace: "loki".into(),
                service: "loki-gateway".into(),
                port: 80,
                scheme: PromScheme::Http,
                path_prefix: "/loki".into(),
                tenant: "team-a".into(),
            }
        );
        assert_eq!(normalized.tenant(), "team-a");
        let service = normalized.service().unwrap();
        assert_eq!(service.kind, LokiKind::Custom);
        assert_eq!(service.path_prefix, "/loki");
        assert!(service_config("/../x", "").normalized().is_err());
        assert!(service_config("", "a|b").normalized().is_err());
        assert!(service_config("", "has space").normalized().is_err());
        assert!(service_config("", &"t".repeat(151)).normalized().is_err());
        let bad_port = LokiConfig::Service {
            namespace: "l".into(),
            service: "g".into(),
            port: 0,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
            tenant: String::new(),
        };
        assert!(bad_port.normalized().is_err());
        assert_eq!(LokiConfig::Off.normalized().unwrap(), LokiConfig::Off);
        assert!(LokiConfig::Auto.service().is_none());
        assert_eq!(LokiConfig::Auto.tenant(), "");
    }

    #[test]
    fn cache_keeps_positive_answers_for_the_connection() {
        let cache = LokiCache::default();
        let now = Instant::now();
        cache.put("c", Some(1), LokiConfig::Auto, status(LokiState::Available));
        assert!(cache.get_at("c", Some(1), &LokiConfig::Auto, now).is_some());
        assert!(cache.get_at("c", Some(2), &LokiConfig::Auto, now).is_none());
        assert!(cache.get_at("c", Some(1), &LokiConfig::Off, now).is_none());
        cache.invalidate("c");
        assert!(cache.get_at("c", Some(1), &LokiConfig::Auto, now).is_none());
        cache.put("c", Some(1), LokiConfig::Auto, status(LokiState::NotFound));
        let later = Instant::now() + service_proxy::RECHECK_AFTER * 2;
        assert!(cache
            .get_at("c", Some(1), &LokiConfig::Auto, later)
            .is_none());
        cache.forget("c");
        assert!(cache
            .get_at("c", Some(1), &LokiConfig::Auto, Instant::now())
            .is_none());
    }
}
