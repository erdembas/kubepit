//! Serde mirrors of the cost types in `apps/desktop/src/types/index.ts`.
//!
//! Every amount of money in a [`CostReport`] is a monthly run rate
//! ([`super::HOURS_PER_MONTH`] hours) in the report's currency, except the
//! trend points, which are the cost of one day.

use serde::{Deserialize, Serialize};

use crate::types::PromScheme;

// ---------------------------------------------------------------------------
// Configuration (`ClusterDef.cost`)
// ---------------------------------------------------------------------------

/// Per-cluster cost setting.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CostConfig {
    /// Where costs come from (auto-detect by default).
    #[serde(default)]
    pub source: CostSourceConfig,
    /// Price model of estimates; `None` = the defaults of the detected platform.
    #[serde(default)]
    pub pricing: Option<CostPricing>,
}

/// Which cost source a cluster uses. Internally tagged on `mode`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum CostSourceConfig {
    /// OpenCost or Kubecost when one is found, else an estimate.
    #[default]
    Auto,
    /// This OpenCost service.
    Opencost {
        namespace: String,
        service: String,
        port: u16,
        #[serde(default)]
        scheme: PromScheme,
        #[serde(default)]
        path_prefix: String,
    },
    /// This Kubecost cost-analyzer service.
    Kubecost {
        namespace: String,
        service: String,
        port: u16,
        #[serde(default)]
        scheme: PromScheme,
        #[serde(default)]
        path_prefix: String,
    },
    /// Never query a cost API; estimate from requests.
    Estimate,
}

/// Price model of estimates. Prices are before `discount_percent`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostPricing {
    /// ISO 4217 code, e.g. `USD`.
    pub currency: String,
    /// Per vCPU and hour.
    pub cpu_hour: f64,
    /// Per GiB of memory and hour.
    pub memory_gib_hour: f64,
    /// Per GPU and hour (`None` = GPUs are not priced).
    #[serde(default)]
    pub gpu_hour: Option<f64>,
    /// Per GiB of persistent volume and month (`None` = volumes are not priced).
    #[serde(default)]
    pub storage_gib_month: Option<f64>,
    /// Committed-use / negotiated discount on every price, 0–100.
    #[serde(default)]
    pub discount_percent: f64,
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostSourceKind {
    Opencost,
    Kubecost,
    Estimate,
}

/// Which product serves a cost allocation API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostApiKind {
    Opencost,
    Kubecost,
}

/// A cost allocation API reached through the API server's service proxy.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CostService {
    pub kind: CostApiKind,
    pub namespace: String,
    pub service: String,
    pub port: u16,
    #[serde(default)]
    pub scheme: PromScheme,
    /// `""` or `/prefix` (no trailing slash).
    #[serde(default)]
    pub path_prefix: String,
}

/// Platform whose list prices the default price model follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostPlatform {
    Eks,
    Gke,
    Aks,
    /// On-prem or anything else: a generic estimate.
    Generic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostStatus {
    pub source: CostSourceKind,
    /// The cost API in use (`opencost` / `kubecost`), or the one that failed.
    pub service: Option<CostService>,
    /// The source comes from the cluster setting rather than detection.
    pub configured: bool,
    /// Why a found or configured cost API is not used.
    pub error: Option<String>,
    /// Every probed cost API was refused by the API server (no `get` on
    /// `services/proxy`); costs are estimated and `error` says why.
    #[serde(default)]
    pub forbidden: bool,
    /// Cost APIs detection considered, best first.
    pub candidates: Vec<CostService>,
    pub platform: CostPlatform,
    /// Detected distribution (`EKS`, `GKE`, …) as shown in the UI.
    pub platform_label: Option<String>,
    /// The effective price model of estimates.
    pub pricing: CostPricing,
    /// `pricing` comes from the cluster setting (not the platform defaults).
    pub pricing_custom: bool,
    /// Prometheus answers, so estimates get usage and a trend.
    pub prometheus: bool,
    /// Epoch ms of the check.
    pub checked_at: i64,
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CostWindow {
    #[default]
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
}

impl CostWindow {
    pub fn days(self) -> u32 {
        match self {
            CostWindow::Week => 7,
            CostWindow::Month => 30,
        }
    }

    pub fn as_param(self) -> &'static str {
        match self {
            CostWindow::Week => "7d",
            CostWindow::Month => "30d",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostAggregate {
    #[default]
    Namespace,
    Workload,
    Label,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CostQuery {
    #[serde(default)]
    pub window: CostWindow,
    #[serde(default)]
    pub aggregate: CostAggregate,
    /// Label key of `aggregate: label` (e.g. `team`).
    #[serde(default)]
    pub label: Option<String>,
    /// Bypass the report cache.
    #[serde(default)]
    pub refresh: bool,
}

/// Where the usage (efficiency) numbers of a report come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CostUsageSource {
    /// The cost API's own usage averages.
    CostApi,
    /// Averages over the window from Prometheus.
    Prometheus,
    /// The current metrics-server snapshot.
    MetricsServer,
    None,
}

/// What the trend adds up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostTrendBasis {
    /// Everything the cost API allocates, idle included.
    Total,
    /// Requests × prices (estimates with Prometheus).
    Requests,
    /// No trend available.
    None,
}

/// Rows that are not a real group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostSpecial {
    /// Capacity nobody requested.
    Idle,
    /// Costs without the grouping property (no label, no controller, unmounted volumes).
    Unallocated,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CostTotals {
    pub total: f64,
    pub allocated: f64,
    /// `None` when capacity is unknown (nodes cannot be listed).
    pub idle: Option<f64>,
    pub cpu: f64,
    pub memory: f64,
    pub gpu: f64,
    pub storage: f64,
    /// Network, load balancers, shared and external costs (cost APIs only).
    pub other: f64,
    /// Cost-weighted usage ÷ requests of the allocated workloads.
    pub efficiency: Option<f64>,
    pub cpu_efficiency: Option<f64>,
    pub memory_efficiency: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CostItem {
    /// Unique within the report.
    pub key: String,
    /// Namespace, workload name or label value (`special` rows: the marker).
    pub name: String,
    pub namespace: Option<String>,
    /// Workload kind (`Deployment`, …) of `aggregate: workload`.
    pub kind: Option<String>,
    pub pods: u32,
    pub cpu_request_cores: f64,
    pub cpu_usage_cores: Option<f64>,
    pub memory_request_bytes: f64,
    pub memory_usage_bytes: Option<f64>,
    pub gpus: f64,
    pub storage_bytes: f64,
    pub cpu_cost: f64,
    pub memory_cost: f64,
    pub gpu_cost: f64,
    pub storage_cost: f64,
    pub other_cost: f64,
    pub total_cost: f64,
    pub efficiency: Option<f64>,
    pub special: Option<CostSpecial>,
}

/// Cost of one day (epoch ms of its start, UTC).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CostTrendPoint {
    pub ts: i64,
    pub total: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostReport {
    pub status: CostStatus,
    pub window: CostWindow,
    pub aggregate: CostAggregate,
    pub label: Option<String>,
    pub currency: String,
    /// Epoch ms of the window the numbers describe.
    pub start: i64,
    pub end: i64,
    pub totals: CostTotals,
    /// Most expensive first.
    pub items: Vec<CostItem>,
    pub trend: Vec<CostTrendPoint>,
    pub trend_basis: CostTrendBasis,
    pub usage: CostUsageSource,
    /// Conditions worth telling the user (translated by the UI).
    pub notes: Vec<CostNote>,
    pub computed_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CostNoteKind {
    /// The cost API failed; the report is an estimate.
    ApiFailed,
    /// Nodes cannot be listed: capacity and idle are unknown.
    NodesUnavailable,
    /// Claims cannot be listed: storage is not priced.
    VolumesUnavailable,
    /// Usage could not be read (efficiency missing).
    UsageFailed,
    /// The trend could not be read.
    TrendFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostNote {
    pub kind: CostNoteKind,
    /// The underlying error, verbatim.
    pub detail: Option<String>,
}

/// Compact numbers for the dashboard (7-day window, by namespace).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostSummary {
    pub source: CostSourceKind,
    pub currency: String,
    pub total: f64,
    pub allocated: f64,
    pub idle: Option<f64>,
    pub efficiency: Option<f64>,
    pub computed_at: i64,
}
