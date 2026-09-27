//! Serde mirrors of the right-sizing types in `apps/desktop/src/types/index.ts`.
//!
//! CPU values are millicores, memory values bytes; `None` means "not set"
//! (current values) or "leave as is" (changes).

use serde::{Deserialize, Serialize};

use crate::cost::CostPricing;

/// Headroom, minimums and the history window of recommendations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RightsizingSettings {
    /// Added to the CPU p95.
    pub cpu_headroom_percent: f64,
    /// Added to the memory maximum for the request.
    pub memory_headroom_percent: f64,
    /// Added to the memory maximum for the limit.
    pub memory_limit_headroom_percent: f64,
    pub min_cpu_millicores: f64,
    pub min_memory_bytes: f64,
    /// Days of Prometheus history (1–30).
    pub days: u32,
}

impl Default for RightsizingSettings {
    fn default() -> Self {
        Self {
            cpu_headroom_percent: 15.0,
            memory_headroom_percent: 20.0,
            memory_limit_headroom_percent: 40.0,
            min_cpu_millicores: 10.0,
            min_memory_bytes: 32.0 * 1024.0 * 1024.0,
            days: 7,
        }
    }
}

/// A workload by kind, namespace and name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkloadRef {
    pub kind: String,
    pub namespace: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RightsizingRequest {
    /// Namespaces to cover; empty = every namespace the user can read.
    #[serde(default)]
    pub namespaces: Vec<String>,
    /// Only this workload (details panel).
    #[serde(default)]
    pub workload: Option<WorkloadRef>,
    #[serde(default)]
    pub settings: RightsizingSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RightsizingSource {
    /// Days of Prometheus history.
    Prometheus,
    /// The last hour of metrics-server samples (low confidence).
    MetricsServer,
    /// No usage data at all.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    /// Requests clearly above what the workload uses.
    Over,
    /// Usage above requests (memory above its request, or near its limit).
    Under,
    Balanced,
    /// No usage history.
    NoData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Change {
    Increase,
    Decrease,
    Unchanged,
    /// Set where nothing was set.
    Set,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ResourceValues {
    pub cpu_request: Option<f64>,
    pub cpu_limit: Option<f64>,
    pub memory_request: Option<f64>,
    pub memory_limit: Option<f64>,
}

/// Observed usage of one container (worst replica).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageStats {
    pub cpu_p95: f64,
    pub cpu_max: f64,
    pub memory_max: f64,
    /// Hours of history behind the numbers.
    pub hours: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContainerRecommendation {
    pub name: String,
    pub current: ResourceValues,
    pub recommended: ResourceValues,
    pub usage: Option<UsageStats>,
    pub cpu: Change,
    pub memory: Change,
    pub memory_limit: Change,
    pub cpu_limit: Change,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkloadRecommendation {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub uid: String,
    pub replicas: u32,
    pub confidence: Confidence,
    pub verdict: Verdict,
    /// Hours of history (per replica) behind the recommendation.
    pub coverage_hours: f64,
    pub containers: Vec<ContainerRecommendation>,
    /// Recommended − current requests per month for all replicas
    /// (negative = saving), in the report currency.
    pub monthly_delta: f64,
    /// Current requests per month for all replicas.
    pub monthly_current: f64,
    /// At least one value would change.
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RightsizingReport {
    pub source: RightsizingSource,
    /// History the numbers cover.
    pub window_secs: u64,
    pub settings: RightsizingSettings,
    pub currency: String,
    /// Price model of `monthly_delta` (the cluster's estimate prices).
    pub pricing: CostPricing,
    /// Largest saving first, then largest increase.
    pub workloads: Vec<WorkloadRecommendation>,
    /// Conditions worth telling the user (translated by the UI).
    pub notes: Vec<RightsizingNote>,
    pub computed_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RightsizingNoteKind {
    /// Prometheus failed; the metrics-server hour is used instead.
    PrometheusFailed,
    /// Neither Prometheus nor metrics-server history is available.
    NoUsage,
    /// Pods could not be listed for the metrics-server fallback.
    PodsUnavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RightsizingNote {
    pub kind: RightsizingNoteKind,
    pub detail: Option<String>,
}

/// New resource values of one container (`None` = unchanged).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContainerResourceChange {
    pub container: String,
    #[serde(default)]
    pub cpu_request: Option<f64>,
    #[serde(default)]
    pub cpu_limit: Option<f64>,
    #[serde(default)]
    pub memory_request: Option<f64>,
    #[serde(default)]
    pub memory_limit: Option<f64>,
}
