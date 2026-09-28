//! Upgrade readiness: what breaks when a cluster moves to a newer
//! Kubernetes minor because an API version stops being served.
//!
//! The deprecated-API table (`upgrade/deprecated_apis.json`) is shared with
//! the UI (schema-aware editor markers, the Manifests tab, the demo
//! backend). A scan against a target version (default: the next minor)
//! collects, concurrently:
//!
//! - **Live objects** of every kind in the table (metadata-only lists, so
//!   `managedFields` and annotations come without specs): the
//!   `kubectl.kubernetes.io/last-applied-configuration` apiVersion and each
//!   `managedFields[].apiVersion` — the object itself survives an upgrade
//!   (it is stored at the storage version), but whoever still writes it
//!   through the old version (a pipeline, a controller) breaks.
//! - **Helm releases**: the stored manifest of each release's newest
//!   revision, decoded natively (`helm.rs`). Helm rebuilds those objects on
//!   every upgrade, so a removed apiVersion there blocks upgrading the
//!   release until the manifest is fixed.
//! - **CRDs** still serving versions they mark `deprecated`, and aggregated
//!   **API services** that register a group-version of the table.
//! - Optionally **`apiserver_requested_deprecated_apis`** through the
//!   Prometheus integration: clients that requested deprecated APIs since
//!   the API server started.
//!
//! Removed in the target (or earlier) = blocker, deprecated by then =
//! warning. Everything only reads, so read-only clusters are scanned too.
//! Kinds that are forbidden cluster-wide fall back to the cluster's
//! `accessible_namespaces`; what stays unreadable is reported as skipped.

pub mod deprecations;
pub mod scan;

use std::collections::HashMap;

use anyhow::{anyhow, bail, Result};
use futures::{stream, StreamExt};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{DynamicObject, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app::Kubepit;
use crate::error::{is_forbidden, is_not_found, kube_error};
use crate::helm::{fetch_release, list_revisions, RevisionRef};
use crate::objects::{api_resource_from_info, dynamic_api};
use crate::prometheus::Origin;
use crate::types::{ApiResourceInfo, PrometheusConfig, PrometheusRange};
use deprecations::{parse_target, Minor};
use scan::Versions;

/// Objects listed per kind at most (metadata only).
const MAX_OBJECTS_PER_KIND: usize = 20_000;
const PAGE_SIZE: u32 = 500;
const LIST_CONCURRENCY: usize = 4;
const HELM_CONCURRENCY: usize = 8;
/// Over the last hour; the gauge stays 1 once an API was requested.
pub(crate) const METRIC_QUERY: &str =
    "max by (group, version, resource, subresource, removed_release) \
                            (apiserver_requested_deprecated_apis)";
const METRIC_WINDOW_MS: i64 = 3_600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpgradeSeverity {
    /// Not served by the target version.
    Blocker,
    /// Deprecated by the target version, still served.
    Warning,
}

/// Where a finding comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpgradeSource {
    LastApplied,
    ManagedFields,
    HelmRelease,
    Crd,
    ApiService,
    Metrics,
}

/// The object a finding points at (served `apiVersion`, for navigation;
/// for Helm findings the rendered one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeObjectRef {
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeHelmRef {
    pub namespace: String,
    pub name: String,
    pub revision: i64,
    pub chart: String,
    pub chart_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeFinding {
    /// Stable within a report (source + identity).
    pub id: String,
    pub severity: UpgradeSeverity,
    pub source: UpgradeSource,
    /// The deprecated `apiVersion` that was found.
    pub api_version: String,
    /// Its kind (for metric findings of unknown APIs: the resource).
    pub kind: String,
    pub deprecated_in: Option<String>,
    pub removed_in: Option<String>,
    pub replacement: Option<String>,
    pub replacement_kind: Option<String>,
    /// Note codes the UI explains.
    pub notes: Vec<String>,
    /// Not served by the cluster's current version either.
    pub already_removed: bool,
    pub object: Option<UpgradeObjectRef>,
    pub helm: Option<UpgradeHelmRef>,
    /// `managedFields` managers that wrote through `api_version`.
    pub managers: Vec<String>,
    /// Raw context: the template (Helm), the CRD's deprecation warning,
    /// the requested resource (metrics), the backing service (API services).
    pub detail: Option<String>,
}

/// Something the scan could not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeSkipped {
    /// A kind, `HelmReleases`, …
    pub what: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpgradeMetricsState {
    /// The metric was queried.
    Used,
    /// Asked for, but Prometheus (or the metric) is not available.
    Unavailable,
    /// Not asked for, or Prometheus is turned off for the cluster.
    Skipped,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeScanOptions {
    /// `1.32`; `None` = the minor after the cluster's version.
    #[serde(default)]
    pub target_version: Option<String>,
    /// Also query `apiserver_requested_deprecated_apis` through Prometheus.
    #[serde(default)]
    pub metrics: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeReport {
    pub cluster_id: String,
    /// The API server's `gitVersion`.
    pub server_git_version: String,
    /// Its minor (`1.31`).
    pub server_version: String,
    pub target_version: String,
    /// The minor after `server_version` (the default target).
    pub next_version: String,
    /// When the deprecated-API table was last reviewed.
    pub table_updated: String,
    /// The newest minor the table was checked through; a newer target may
    /// remove APIs the table does not list yet.
    pub table_checked_through: String,
    /// Epoch milliseconds.
    pub scanned_at: i64,
    pub objects_scanned: u64,
    pub kinds_scanned: u32,
    pub helm_releases_scanned: u32,
    pub crds_scanned: u32,
    pub metrics: UpgradeMetricsState,
    pub metrics_error: Option<String>,
    pub skipped: Vec<UpgradeSkipped>,
    /// Some kind had more objects than the scan reads.
    pub truncated: bool,
    pub findings: Vec<UpgradeFinding>,
}

#[derive(Default)]
struct Part {
    findings: Vec<UpgradeFinding>,
    skipped: Vec<UpgradeSkipped>,
    scanned: u64,
    units: u32,
    truncated: bool,
}

fn skip(what: &str, err: &anyhow::Error) -> UpgradeSkipped {
    UpgradeSkipped {
        what: what.to_string(),
        reason: format!("{err:#}"),
    }
}

/// Every object's metadata of one resource (paged), capped.
async fn list_metadata(
    client: &Client,
    info: &ApiResourceInfo,
    namespace: Option<&str>,
    cap: usize,
) -> Result<(Vec<ObjectMeta>, bool)> {
    let ar = api_resource_from_info(info);
    let api = dynamic_api(client.clone(), &ar, info.namespaced, namespace);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut lp = ListParams::default().limit(PAGE_SIZE);
        if let Some(token) = token.as_deref() {
            lp = lp.continue_token(token);
        }
        let page = api.list_metadata(&lp).await.map_err(kube_error)?;
        for item in page.items {
            if out.len() >= cap {
                return Ok((out, true));
            }
            out.push(item.metadata);
        }
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            return Ok((out, false));
        }
    }
}

/// Full objects of one resource (paged; CRDs and API services are few).
async fn list_objects(client: &Client, info: &ApiResourceInfo) -> Result<Vec<Value>> {
    let ar = api_resource_from_info(info);
    let api = dynamic_api(client.clone(), &ar, false, None);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut lp = ListParams::default().limit(100);
        if let Some(token) = token.as_deref() {
            lp = lp.continue_token(token);
        }
        let page = api.list(&lp).await.map_err(kube_error)?;
        out.extend(
            page.items
                .into_iter()
                .map(|o: DynamicObject| serde_json::to_value(o).unwrap_or(Value::Null)),
        );
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            return Ok(out);
        }
    }
}

async fn scan_kind(
    client: &Client,
    info: &ApiResourceInfo,
    namespaces: &[String],
    versions: Versions,
) -> Part {
    let mut part = Part {
        units: 1,
        ..Part::default()
    };
    let record = |part: &mut Part, metas: Vec<ObjectMeta>, truncated: bool| {
        part.scanned += metas.len() as u64;
        part.truncated |= truncated;
        for meta in &metas {
            part.findings
                .extend(scan::object_findings(info, meta, versions));
        }
    };
    match list_metadata(client, info, None, MAX_OBJECTS_PER_KIND).await {
        Ok((metas, truncated)) => record(&mut part, metas, truncated),
        Err(e) if is_not_found(&e) => part.units = 0,
        Err(e) if is_forbidden(&e) && info.namespaced && !namespaces.is_empty() => {
            let mut denied = Vec::new();
            for ns in namespaces {
                match list_metadata(client, info, Some(ns), MAX_OBJECTS_PER_KIND).await {
                    Ok((metas, truncated)) => record(&mut part, metas, truncated),
                    Err(e) if is_not_found(&e) => {}
                    Err(e) => denied.push((ns.clone(), e)),
                }
            }
            if denied.len() == namespaces.len() {
                if let Some((_, e)) = denied.first() {
                    part.skipped.push(skip(&info.kind, e));
                }
            }
        }
        Err(e) => part.skipped.push(skip(&info.kind, &e)),
    }
    part
}

async fn scan_objects(
    client: &Client,
    resources: &[ApiResourceInfo],
    namespaces: &[String],
    versions: Versions,
) -> Part {
    let targets = scan::scan_targets(resources);
    // Owned inputs per future: borrowed closures here make the command's
    // future not `Send` (higher-ranked lifetime inference).
    let parts: Vec<Part> = stream::iter(targets)
        .map(|info| {
            let client = client.clone();
            let namespaces = namespaces.to_vec();
            async move { scan_kind(&client, &info, &namespaces, versions).await }
        })
        .buffer_unordered(LIST_CONCURRENCY)
        .collect()
        .await;
    parts.into_iter().fold(Part::default(), |mut acc, p| {
        acc.findings.extend(p.findings);
        acc.skipped.extend(p.skipped);
        acc.scanned += p.scanned;
        acc.units += p.units;
        acc.truncated |= p.truncated;
        acc
    })
}

async fn scan_helm(client: &Client, namespaces: &[String], versions: Versions) -> Part {
    const WHAT: &str = "HelmReleases";
    let mut part = Part::default();
    let revisions = match list_revisions(client, None, None).await {
        Ok(revs) => revs,
        Err(e) if is_forbidden(&e) && !namespaces.is_empty() => {
            let mut revs = Vec::new();
            let mut denied = 0;
            for ns in namespaces {
                match list_revisions(client, Some(ns), None).await {
                    Ok(found) => revs.extend(found),
                    Err(_) => denied += 1,
                }
            }
            if denied == namespaces.len() {
                part.skipped.push(skip(WHAT, &e));
            }
            revs
        }
        Err(e) => {
            part.skipped.push(skip(WHAT, &e));
            return part;
        }
    };
    let mut latest: HashMap<(String, String), RevisionRef> = HashMap::new();
    for rev in revisions {
        let key = (rev.namespace.clone(), rev.release.clone());
        if latest.get(&key).is_none_or(|r| r.revision < rev.revision) {
            latest.insert(key, rev);
        }
    }
    let decoded: Vec<(RevisionRef, Result<Value>)> = stream::iter(latest.into_values())
        .map(|rev| {
            let client = client.clone();
            async move {
                let result = fetch_release(&client, &rev).await;
                (rev, result)
            }
        })
        .buffer_unordered(HELM_CONCURRENCY)
        .collect()
        .await;
    for (rev, release) in decoded {
        match release {
            Ok(release) => {
                part.units += 1;
                part.findings
                    .extend(scan::helm_findings(&release, &rev.namespace, versions));
            }
            Err(e) => part.skipped.push(skip(
                &format!("HelmRelease {}/{}", rev.namespace, rev.release),
                &e,
            )),
        }
    }
    part
}

async fn scan_apis(client: &Client, resources: &[ApiResourceInfo], versions: Versions) -> Part {
    let mut part = Part::default();
    let find = |group: &str, kind: &str| {
        resources
            .iter()
            .find(|r| r.group == group && r.kind == kind)
            .cloned()
    };
    if let Some(info) = find("apiextensions.k8s.io", "CustomResourceDefinition") {
        match list_objects(client, &info).await {
            Ok(crds) => {
                part.units = crds.len() as u32;
                for crd in &crds {
                    part.findings.extend(scan::crd_findings(crd));
                }
            }
            Err(e) => part.skipped.push(skip(&info.kind, &e)),
        }
    }
    if let Some(info) = find("apiregistration.k8s.io", "APIService") {
        match list_objects(client, &info).await {
            Ok(services) => {
                for svc in &services {
                    part.findings
                        .extend(scan::apiservice_findings(svc, versions));
                }
            }
            Err(e) => part.skipped.push(skip(&info.kind, &e)),
        }
    }
    part
}

impl Kubepit {
    async fn scan_metrics(
        &self,
        cluster_id: &str,
        versions: Versions,
    ) -> (UpgradeMetricsState, Option<String>, Vec<UpgradeFinding>) {
        let now = crate::objects::now_millis();
        let range = PrometheusRange {
            start: now - METRIC_WINDOW_MS,
            end: now,
            step: None,
        };
        match self
            .prometheus_range(cluster_id, METRIC_QUERY, &range, Origin::Preset)
            .await
        {
            Ok(result) => (
                UpgradeMetricsState::Used,
                None,
                scan::metric_findings(&result.series, versions),
            ),
            Err(e) => (
                UpgradeMetricsState::Unavailable,
                Some(format!("{e:#}")),
                Vec::new(),
            ),
        }
    }

    /// `upgrade_readiness_scan`: deprecated and removed API usage for an
    /// upgrade to `options.target_version` (default: the next minor).
    pub async fn upgrade_readiness_scan(
        &self,
        cluster_id: &str,
        options: &UpgradeScanOptions,
    ) -> Result<UpgradeReport> {
        let cluster = self.cluster_def(cluster_id)?;
        let client = self.client(cluster_id).await?;
        let git_version = match self.cluster_status(cluster_id).version {
            Some(v) if !v.is_empty() => v,
            _ => {
                client
                    .apiserver_version()
                    .await
                    .map_err(kube_error)?
                    .git_version
            }
        };
        let current = Minor::parse(&git_version)
            .ok_or_else(|| anyhow!("cannot read the cluster version \"{git_version}\""))?;
        let target = match options
            .target_version
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            Some(raw) => parse_target(raw)?,
            None => current.next(),
        };
        if target < current {
            bail!("the target version {target} is older than the cluster ({current})");
        }
        let versions = Versions { current, target };
        let resources = self.api_resources_cached(cluster_id).await?;
        let namespaces = cluster.accessible_namespaces.clone();
        let want_metrics = options.metrics && cluster.prometheus != PrometheusConfig::Off;

        let (objects, helm, apis, metrics) = tokio::join!(
            scan_objects(&client, &resources, &namespaces, versions),
            scan_helm(&client, &namespaces, versions),
            scan_apis(&client, &resources, versions),
            async {
                if want_metrics {
                    self.scan_metrics(cluster_id, versions).await
                } else {
                    (UpgradeMetricsState::Skipped, None, Vec::new())
                }
            }
        );
        let (metrics_state, metrics_error, metric_findings) = metrics;
        let mut findings = Vec::new();
        let mut skipped = Vec::new();
        for part in [&objects, &helm, &apis] {
            findings.extend(part.findings.iter().cloned());
            skipped.extend(part.skipped.iter().cloned());
        }
        findings.extend(metric_findings);
        scan::sort_findings(&mut findings);
        findings.dedup_by(|a, b| a.id == b.id);
        Ok(UpgradeReport {
            cluster_id: cluster_id.to_string(),
            server_git_version: git_version,
            server_version: current.to_string(),
            target_version: target.to_string(),
            next_version: current.next().to_string(),
            table_updated: deprecations::table_updated().to_string(),
            table_checked_through: deprecations::table_checked_through().to_string(),
            scanned_at: crate::objects::now_millis(),
            objects_scanned: objects.scanned,
            kinds_scanned: objects.units,
            helm_releases_scanned: helm.units,
            crds_scanned: apis.units,
            metrics: metrics_state,
            metrics_error,
            skipped,
            truncated: objects.truncated,
            findings,
        })
    }
}
