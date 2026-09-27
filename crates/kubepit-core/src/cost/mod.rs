//! Cost insight: what a cluster costs per month and where the money goes.
//!
//! Best available source wins, per cluster (`ClusterDef.cost.source`):
//!
//! 1. **OpenCost** (`/allocation/compute`) or **Kubecost**
//!    (`/model/allocation`), found among the cluster's services
//!    ([`detect`]) or configured, queried through the API server's service
//!    proxy ([`proxy`], built on the Prometheus transport) — real
//!    allocations with idle, network and volumes, and a daily trend
//!    ([`allocation`]);
//! 2. otherwise an **estimate** ([`estimate`]): requests (or usage, when
//!    higher and known) × a price model ([`pricing`]: the cluster's own, or
//!    the defaults of the detected platform), idle from node capacity, usage
//!    and a requests trend from Prometheus when available.
//!
//! Detection is cached per connection like Prometheus' (negative answers
//! are rechecked after [`RECHECK_AFTER`]); reports for [`REPORT_TTL`].
//! Everything only reads, so it works on read-only clusters.

pub mod allocation;
pub mod detect;
pub mod estimate;
pub mod lists;
pub mod pricing;
pub mod proxy;
pub mod types;

pub use types::*;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use k8s_openapi::api::core::v1::{Node, PersistentVolumeClaim, Pod};
use kube::Client;
use parking_lot::Mutex;

use crate::app::Kubepit;
use crate::error::ApiError;
use crate::objects::now_millis;
use crate::prometheus::detect::list_services;
use crate::types::{
    ClusterDef, PrometheusMetric, PrometheusRange, PrometheusState, PrometheusTarget,
};
use estimate::{EstimateInput, PodUsage, UsageMap};

/// Hours in a month of the run rates (365 × 24 / 12).
pub const HOURS_PER_MONTH: f64 = 730.0;
/// How long "no cost API" is trusted before detecting again.
pub const RECHECK_AFTER: Duration = Duration::from_secs(5 * 60);
/// How long a report is served from the cache.
pub const REPORT_TTL: Duration = Duration::from_secs(5 * 60);
const DAY_MS: i64 = 86_400_000;

#[derive(Clone)]
struct StatusEntry {
    connected_at: Option<i64>,
    config: CostConfig,
    platform: Option<String>,
    status: CostStatus,
    at: Instant,
}

#[derive(Clone)]
struct ReportEntry {
    connected_at: Option<i64>,
    config: CostConfig,
    report: CostReport,
    at: Instant,
}

/// Detection results, reports and proxy clients per cluster.
#[derive(Default)]
pub struct CostState {
    statuses: Mutex<HashMap<String, StatusEntry>>,
    reports: Mutex<HashMap<String, ReportEntry>>,
    clients: Mutex<HashMap<String, (Option<i64>, Client)>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl CostState {
    fn lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks
            .lock()
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    /// Drop everything of a cluster (disconnect, removal).
    pub fn forget(&self, cluster_id: &str) {
        self.statuses.lock().remove(cluster_id);
        self.clients.lock().remove(cluster_id);
        let prefix = format!("{cluster_id}|");
        self.reports.lock().retain(|k, _| !k.starts_with(&prefix));
    }

    fn invalidate(&self, cluster_id: &str) {
        self.statuses.lock().remove(cluster_id);
    }
}

/// Whether a status entry may be reused.
fn status_fresh(
    entry: &StatusEntry,
    connected_at: Option<i64>,
    config: &CostConfig,
    platform: &Option<String>,
    now: Instant,
) -> bool {
    let positive = entry.status.source != CostSourceKind::Estimate || entry.status.configured;
    entry.connected_at == connected_at
        && &entry.config == config
        && &entry.platform == platform
        && (positive || now.duration_since(entry.at) < RECHECK_AFTER)
}

/// The proxy could not reach the service (gone, no endpoints, forbidden).
fn is_proxy_failure(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause.downcast_ref::<ApiError>().is_some_and(|api| {
            api.reason == crate::prometheus::proxy::PROXY_REASON
                && matches!(api.code, 404 | 502 | 503)
        })
    })
}

fn source_of(kind: CostApiKind) -> CostSourceKind {
    match kind {
        CostApiKind::Opencost => CostSourceKind::Opencost,
        CostApiKind::Kubecost => CostSourceKind::Kubecost,
    }
}

async fn probe(client: &Client, service: &CostService) -> Result<()> {
    let path = proxy::allocation_path(service, &allocation::probe_params());
    let body = proxy::get_json(client, &path, proxy::PROBE_TIMEOUT).await?;
    allocation::parse_sets(&body).map(|_| ())
}

/// Services detection looks at (cluster-wide, or where cost tools live).
async fn cost_candidates(client: &Client, cluster: &ClusterDef) -> Result<Vec<CostService>> {
    let mut namespaces: Vec<String> = detect::FALLBACK_NAMESPACES
        .iter()
        .map(|s| s.to_string())
        .collect();
    for ns in &cluster.accessible_namespaces {
        if !namespaces.contains(ns) {
            namespaces.push(ns.clone());
        }
    }
    let services = list_services(client, &namespaces).await?;
    Ok(detect::rank(&services)
        .into_iter()
        .map(|c| c.service)
        .collect())
}

/// Hourly-step range of `window` ending now (for the requests trend).
fn trend_range(window: CostWindow, end: i64) -> PrometheusRange {
    let days = i64::from(window.days());
    let step = if days > 7 { 3 * 3600 } else { 3600 };
    PrometheusRange {
        start: (end - days * DAY_MS).div_euclid(DAY_MS) * DAY_MS,
        end,
        step: Some(step),
    }
}

impl Kubepit {
    /// The retry-free proxy client of the cluster's current connection.
    async fn cost_client(&self, cluster: &ClusterDef) -> Result<Client> {
        self.client(&cluster.id).await?;
        let connected_at = self.cluster_status(&cluster.id).connected_at;
        let cached = self
            .cost
            .clients
            .lock()
            .get(&cluster.id)
            .filter(|(at, _)| *at == connected_at)
            .map(|(_, c)| c.clone());
        if let Some(client) = cached {
            return Ok(client);
        }
        let client = proxy::proxy_client(cluster).await?;
        self.cost
            .clients
            .lock()
            .insert(cluster.id.clone(), (connected_at, client.clone()));
        Ok(client)
    }

    /// `cost_status`: which source this cluster's costs come from, the
    /// effective price model and whether Prometheus backs estimates.
    pub async fn cost_status(&self, cluster_id: &str, refresh: bool) -> Result<CostStatus> {
        let cluster = self.cluster_def(cluster_id)?;
        let pool = self.client(cluster_id).await?;
        let conn = self.cluster_status(cluster_id);
        let lock = self.cost.lock(&format!("{cluster_id}#status"));
        let _serialised = lock.lock().await;
        if !refresh {
            if let Some(entry) = self.cost.statuses.lock().get(cluster_id) {
                if status_fresh(
                    entry,
                    conn.connected_at,
                    &cluster.cost,
                    &conn.platform,
                    Instant::now(),
                ) {
                    return Ok(entry.status.clone());
                }
            }
        }
        let platform = CostPlatform::from_label(conn.platform.as_deref());
        let (pricing, pricing_custom) = cluster.cost.effective_pricing(platform);
        let prometheus = self
            .prometheus_status(cluster_id, false)
            .await
            .is_ok_and(|s| s.state == PrometheusState::Available);
        let mut status = CostStatus {
            source: CostSourceKind::Estimate,
            service: None,
            configured: false,
            error: None,
            candidates: Vec::new(),
            platform,
            platform_label: conn.platform.clone(),
            pricing,
            pricing_custom,
            prometheus,
            checked_at: now_millis(),
        };
        match &cluster.cost.source {
            CostSourceConfig::Estimate => status.configured = true,
            config @ (CostSourceConfig::Opencost { .. } | CostSourceConfig::Kubecost { .. }) => {
                let service = config.service().expect("service mode");
                status.configured = true;
                let client = self.cost_client(&cluster).await?;
                match probe(&client, &service).await {
                    Ok(()) => status.source = source_of(service.kind),
                    Err(e) => status.error = Some(format!("{e:#}")),
                }
                status.service = Some(service);
            }
            CostSourceConfig::Auto => match cost_candidates(&pool, &cluster).await {
                Ok(candidates) if !candidates.is_empty() => {
                    let client = self.cost_client(&cluster).await?;
                    let probes = futures::future::join_all(
                        candidates
                            .iter()
                            .take(detect::MAX_PROBES)
                            .map(|s| probe(&client, s)),
                    )
                    .await;
                    match probes.iter().position(Result::is_ok) {
                        Some(i) => {
                            status.source = source_of(candidates[i].kind);
                            status.service = Some(candidates[i].clone());
                        }
                        None => {
                            status.service = Some(candidates[0].clone());
                            status.error = probes
                                .into_iter()
                                .find_map(Result::err)
                                .map(|e| format!("{e:#}"));
                        }
                    }
                    status.candidates = candidates;
                }
                Ok(_) => {}
                Err(e) => status.error = Some(format!("could not list services: {e:#}")),
            },
        }
        if let (Some(service), true) = (&status.service, status.source != CostSourceKind::Estimate)
        {
            tracing::info!(
                cluster = %cluster.name,
                "cost API: {}/{}:{}",
                service.namespace,
                service.service,
                service.port
            );
        }
        self.cost.statuses.lock().insert(
            cluster_id.to_string(),
            StatusEntry {
                connected_at: conn.connected_at,
                config: cluster.cost.clone(),
                platform: conn.platform.clone(),
                status: status.clone(),
                at: Instant::now(),
            },
        );
        Ok(status)
    }

    /// `cost_report`: totals, breakdown and trend over a window.
    pub async fn cost_report(&self, cluster_id: &str, query: &CostQuery) -> Result<CostReport> {
        let cluster = self.cluster_def(cluster_id)?;
        self.client(cluster_id).await?;
        let connected_at = self.cluster_status(cluster_id).connected_at;
        let label = match query.aggregate {
            CostAggregate::Label => {
                let label = query.label.as_deref().map(str::trim).unwrap_or_default();
                if label.is_empty() {
                    bail!("choose a label key to group costs by");
                }
                Some(label.to_string())
            }
            _ => None,
        };
        let key = format!(
            "{cluster_id}|{}|{:?}|{}",
            query.window.as_param(),
            query.aggregate,
            label.as_deref().unwrap_or_default()
        );
        let lock = self.cost.lock(&key);
        let _serialised = lock.lock().await;
        if !query.refresh {
            if let Some(entry) = self.cost.reports.lock().get(&key) {
                if entry.connected_at == connected_at
                    && entry.config == cluster.cost
                    && entry.at.elapsed() < REPORT_TTL
                {
                    return Ok(entry.report.clone());
                }
            }
        }
        let status = self.cost_status(cluster_id, query.refresh).await?;
        let report = match (&status.service, status.source) {
            (Some(service), CostSourceKind::Opencost | CostSourceKind::Kubecost) => {
                match self
                    .cost_api_report(&cluster, service, &status, query, label.as_deref())
                    .await
                {
                    Ok(report) => report,
                    Err(e) => {
                        if is_proxy_failure(&e) {
                            self.cost.invalidate(cluster_id);
                        }
                        let detail = format!("{e:#}");
                        let fallback = CostStatus {
                            source: CostSourceKind::Estimate,
                            error: Some(detail.clone()),
                            ..status.clone()
                        };
                        let mut report = self
                            .cost_estimate_report(&cluster, fallback, query, label.as_deref())
                            .await?;
                        report.notes.insert(
                            0,
                            CostNote {
                                kind: CostNoteKind::ApiFailed,
                                detail: Some(detail),
                            },
                        );
                        report
                    }
                }
            }
            _ => {
                self.cost_estimate_report(&cluster, status, query, label.as_deref())
                    .await?
            }
        };
        self.cost.reports.lock().insert(
            key,
            ReportEntry {
                connected_at,
                config: cluster.cost.clone(),
                report: report.clone(),
                at: Instant::now(),
            },
        );
        Ok(report)
    }

    /// `cost_summary`: the 7-day namespace report's totals (dashboard).
    pub async fn cost_summary(&self, cluster_id: &str) -> Result<CostSummary> {
        let report = self.cost_report(cluster_id, &CostQuery::default()).await?;
        Ok(CostSummary {
            source: report.status.source,
            currency: report.currency,
            total: report.totals.total,
            allocated: report.totals.allocated,
            idle: report.totals.idle,
            efficiency: report.totals.efficiency,
            computed_at: report.computed_at,
        })
    }

    async fn cost_api_report(
        &self,
        cluster: &ClusterDef,
        service: &CostService,
        status: &CostStatus,
        query: &CostQuery,
        label: Option<&str>,
    ) -> Result<CostReport> {
        let client = self.cost_client(cluster).await?;
        let breakdown_path = proxy::allocation_path(
            service,
            &allocation::breakdown_params(query.window, query.aggregate, label)?,
        );
        let trend_path = proxy::allocation_path(service, &allocation::trend_params(query.window));
        let (breakdown, trend) = futures::future::join(
            proxy::get_json(&client, &breakdown_path, proxy::QUERY_TIMEOUT),
            proxy::get_json(&client, &trend_path, proxy::QUERY_TIMEOUT),
        )
        .await;
        let sets = allocation::parse_sets(&breakdown?)?;
        let (totals, items) = allocation::breakdown(&sets, query.aggregate, label);
        let mut notes = Vec::new();
        let trend = match trend.and_then(|body| allocation::parse_sets(&body)) {
            Ok(sets) => allocation::trend(&sets),
            Err(e) => {
                notes.push(CostNote {
                    kind: CostNoteKind::TrendFailed,
                    detail: Some(format!("{e:#}")),
                });
                Vec::new()
            }
        };
        let end = now_millis();
        Ok(CostReport {
            status: status.clone(),
            window: query.window,
            aggregate: query.aggregate,
            label: label.map(str::to_string),
            currency: status.pricing.currency.clone(),
            start: end - i64::from(query.window.days()) * DAY_MS,
            end,
            totals,
            items,
            trend_basis: if trend.is_empty() {
                CostTrendBasis::None
            } else {
                CostTrendBasis::Total
            },
            trend,
            usage: CostUsageSource::CostApi,
            notes,
            computed_at: end,
        })
    }

    async fn cost_estimate_report(
        &self,
        cluster: &ClusterDef,
        status: CostStatus,
        query: &CostQuery,
        label: Option<&str>,
    ) -> Result<CostReport> {
        let client = self.client(&cluster.id).await?;
        let accessible = &cluster.accessible_namespaces;
        let (pods, nodes, pvcs) = futures::future::join3(
            lists::namespaced::<Pod>(&client, &[], accessible),
            lists::cluster::<Node>(&client),
            lists::namespaced::<PersistentVolumeClaim>(&client, &[], accessible),
        )
        .await;
        let pods = pods?.ok_or_else(|| {
            anyhow!("pods cannot be listed on this cluster, so costs cannot be estimated")
        })?;
        let mut notes = Vec::new();
        let nodes = match nodes {
            Ok(Some(nodes)) => Some(nodes),
            other => {
                notes.push(CostNote {
                    kind: CostNoteKind::NodesUnavailable,
                    detail: other.err().map(|e| format!("{e:#}")),
                });
                None
            }
        };
        let pvcs = match pvcs {
            Ok(Some(pvcs)) => Some(pvcs),
            other => {
                notes.push(CostNote {
                    kind: CostNoteKind::VolumesUnavailable,
                    detail: other.err().map(|e| format!("{e:#}")),
                });
                None
            }
        };

        let window_secs = u64::from(query.window.days()) * 86_400;
        let mut usage_source = CostUsageSource::None;
        let mut usage: Option<UsageMap> = None;
        if status.prometheus {
            match self.prometheus_pod_usage(&cluster.id, window_secs).await {
                Ok(map) => {
                    usage = Some(map);
                    usage_source = CostUsageSource::Prometheus;
                }
                Err(e) => notes.push(CostNote {
                    kind: CostNoteKind::UsageFailed,
                    detail: Some(format!("{e:#}")),
                }),
            }
        }
        if usage.is_none() {
            if let Ok(metrics) = self.metrics_pods(&cluster.id, None).await {
                if metrics.available {
                    usage = Some(
                        metrics
                            .items
                            .iter()
                            .map(|m| {
                                (
                                    (m.namespace.clone(), m.name.clone()),
                                    PodUsage {
                                        cpu_cores: m.cpu_millicores / 1000.0,
                                        memory_bytes: m.memory_bytes,
                                    },
                                )
                            })
                            .collect(),
                    );
                    usage_source = CostUsageSource::MetricsServer;
                }
            }
        }

        let (totals, items) = estimate::estimate(&EstimateInput {
            pods: &pods,
            nodes: nodes.as_deref(),
            pvcs: pvcs.as_deref(),
            usage: usage.as_ref(),
            pricing: &status.pricing,
            aggregate: query.aggregate,
            label,
        });

        let end = now_millis();
        let mut trend = Vec::new();
        if status.prometheus {
            let range = trend_range(query.window, end);
            match self
                .prometheus_metrics(
                    &cluster.id,
                    &PrometheusTarget::Cluster,
                    &[
                        PrometheusMetric::CpuRequests,
                        PrometheusMetric::MemoryRequests,
                    ],
                    &range,
                )
                .await
            {
                Ok(result) => {
                    let points = |metric: PrometheusMetric| {
                        result
                            .series
                            .iter()
                            .find(|s| s.metric == metric)
                            .map(|s| s.points.clone())
                            .unwrap_or_default()
                    };
                    trend = estimate::requests_trend(
                        &points(PrometheusMetric::CpuRequests),
                        &points(PrometheusMetric::MemoryRequests),
                        &status.pricing,
                    );
                }
                Err(e) => notes.push(CostNote {
                    kind: CostNoteKind::TrendFailed,
                    detail: Some(format!("{e:#}")),
                }),
            }
        }
        Ok(CostReport {
            currency: status.pricing.currency.clone(),
            status,
            window: query.window,
            aggregate: query.aggregate,
            label: label.map(str::to_string),
            start: end - i64::from(query.window.days()) * DAY_MS,
            end,
            totals,
            items,
            trend_basis: if trend.is_empty() {
                CostTrendBasis::None
            } else {
                CostTrendBasis::Requests
            },
            trend,
            usage: usage_source,
            notes,
            computed_at: end,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(source: CostSourceKind, configured: bool) -> CostStatus {
        CostStatus {
            source,
            service: None,
            configured,
            error: None,
            candidates: Vec::new(),
            platform: CostPlatform::Generic,
            platform_label: None,
            pricing: CostPlatform::Generic.default_pricing(),
            pricing_custom: false,
            prometheus: false,
            checked_at: 0,
        }
    }

    #[test]
    fn detection_cache_rechecks_estimates_and_follows_the_connection() {
        let now = Instant::now();
        let entry = |source, configured| StatusEntry {
            connected_at: Some(1),
            config: CostConfig::default(),
            platform: Some("EKS".into()),
            status: status(source, configured),
            at: now,
        };
        let config = CostConfig::default();
        let eks = Some("EKS".to_string());
        let found = entry(CostSourceKind::Opencost, false);
        assert!(status_fresh(
            &found,
            Some(1),
            &config,
            &eks,
            now + RECHECK_AFTER * 4
        ));
        assert!(
            !status_fresh(&found, Some(2), &config, &eks, now),
            "reconnected"
        );
        let gke = Some("GKE".to_string());
        assert!(
            !status_fresh(&found, Some(1), &config, &gke, now),
            "platform changed"
        );
        let estimate_mode = CostConfig {
            source: CostSourceConfig::Estimate,
            pricing: None,
        };
        assert!(
            !status_fresh(&found, Some(1), &estimate_mode, &eks, now),
            "setting changed"
        );
        let missing = entry(CostSourceKind::Estimate, false);
        assert!(status_fresh(&missing, Some(1), &config, &eks, now));
        assert!(
            !status_fresh(
                &missing,
                Some(1),
                &config,
                &eks,
                now + RECHECK_AFTER + Duration::from_secs(1)
            ),
            "no cost API: detect again later"
        );
        let chosen = entry(CostSourceKind::Estimate, true);
        assert!(status_fresh(
            &chosen,
            Some(1),
            &config,
            &eks,
            now + RECHECK_AFTER * 4
        ));
    }

    #[test]
    fn trend_ranges_start_at_midnight_with_hourly_steps() {
        let end = 1_790_000_123_456;
        let week = trend_range(CostWindow::Week, end);
        assert_eq!(week.start % DAY_MS, 0);
        assert!(end - week.start >= 7 * DAY_MS);
        assert_eq!(week.step, Some(3600));
        assert_eq!(trend_range(CostWindow::Month, end).step, Some(3 * 3600));
    }
}
