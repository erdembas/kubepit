//! Serde mirrors of the right-sizing types in `apps/desktop/src/types/index.ts`.
//!
//! CPU values are millicores, memory values bytes; `None` means "not set"
//! (current values) or "leave as is" (changes).

use serde::{Deserialize, Serialize};

use crate::cost::CostPricing;

/// Headroom, minimums, the history window and the evidence thresholds of
/// recommendations. Every field has a default, so settings saved by an
/// older build keep loading.
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
    /// Observed hours below which a recommendation is `insufficient-history`
    /// (1–720, at most `days × 24`).
    pub min_hours: f64,
    /// Share of running samples with usage below which a recommendation is
    /// `low-coverage` (0.1–1).
    pub min_coverage: f64,
    /// Throttled CFS periods ÷ periods, in %, from which a container is
    /// `cpu-throttled` (1–50).
    pub throttle_threshold_percent: f64,
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
            min_hours: 24.0,
            min_coverage: 0.9,
            throttle_threshold_percent: 5.0,
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
    /// `None` = the effective settings of the strategy.
    #[serde(default)]
    pub settings: Option<RightsizingSettings>,
    /// Recommendation strategy id (`None` = the default strategy).
    #[serde(default)]
    pub strategy: Option<String>,
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
    /// Sample-weighted average CPU over the pods (millicores).
    #[serde(default)]
    pub cpu_avg: Option<f64>,
    /// Sample-weighted average working set over the pods (bytes).
    #[serde(default)]
    pub memory_avg: Option<f64>,
}

/// How the pods behind a container's usage were tied to its workload.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceIdentity {
    /// kube-state-metrics owner series (a rollout counts as one workload).
    #[default]
    OwnerMetrics,
    /// Pod name patterns (no owner metrics).
    NameMatch,
    /// A pod name belonged to more than one owner within the window.
    Ambiguous,
}

/// How far the usage behind a recommendation can be trusted: history
/// length, coverage and risk signals. Strategy-independent; the shared
/// evidence step turns it into warnings and confidence caps.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageEvidence {
    /// Hours in which at least one pod of the workload ran.
    pub observed_hours: f64,
    /// CPU samples ÷ running samples (`None` without running samples).
    pub cpu_coverage: Option<f64>,
    /// Memory samples ÷ running samples (`None` without running samples).
    pub memory_coverage: Option<f64>,
    pub cpu_samples: f64,
    pub memory_samples: f64,
    /// Pod names behind the numbers.
    pub pods: u32,
    /// Average running pods over the window (a CronJob's duty cycle).
    pub duty: Option<f64>,
    /// Throttled CFS periods ÷ periods (`None` with too few periods).
    pub throttle_ratio: Option<f64>,
    /// A pod was OOM-killed within the window.
    pub oom_killed: bool,
    /// Part of the usage queries failed or warned.
    pub partial: bool,
    pub identity: EvidenceIdentity,
}

/// The resource an HPA metric scales on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HpaResource {
    Cpu,
    Memory,
    /// Pods, object, external or container metrics.
    Other,
}

/// One metric of an HPA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HpaMetric {
    pub resource: HpaResource,
    /// Target average utilization in % of the request, when the target is one.
    pub target_utilization: Option<u32>,
}

/// The HorizontalPodAutoscaler that scales a workload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HpaInfo {
    pub name: String,
    pub min_replicas: Option<u32>,
    pub max_replicas: u32,
    pub metrics: Vec<HpaMetric>,
}

/// Quick-focus groups of the recommendations list (KubeFit semantics).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationLens {
    /// A container's CPU request decreases.
    CpuReduction,
    /// A container's memory request decreases.
    MemoryReduction,
    /// A container's CPU or memory request increases or is set.
    Increase,
    /// A template container has no CPU or memory request.
    RequestUnset,
    /// No usage data for the workload or one of its containers.
    MissingData,
    /// Changed, but not with high confidence.
    NeedsReview,
    /// A limit rises with its request.
    LimitRaised,
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
    /// The strategy's confidence in this container's numbers.
    pub confidence: Confidence,
    /// Caveats of the strategy and of the limit adjustment.
    pub warnings: Vec<RecommendationWarning>,
    /// The CPU limit rose with the request (current limit ÷ request ratio kept).
    pub cpu_limit_raised: bool,
    /// The memory limit rose with the request (current limit ÷ request ratio kept).
    pub memory_limit_raised: bool,
    /// How far the usage can be trusted (`None` = no evidence: the
    /// metrics-server hour, name-matched presets or rows of older builds).
    #[serde(default)]
    pub evidence: Option<UsageEvidence>,
}

/// A caveat of a recommendation. `code` is a stable kebab-case id the UI
/// translates (unknown codes of newer strategies fall back to `detail`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecommendationWarning {
    pub code: String,
    pub detail: Option<String>,
}

impl RecommendationWarning {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            detail: None,
        }
    }

    pub fn with_detail(code: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            detail: Some(detail.into()),
        }
    }
}

/// A recommendation strategy the backend offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RightsizingStrategyInfo {
    /// Stable id (`percentile-headroom`).
    pub id: String,
    /// Display name in English (product names stay as they are).
    pub name: String,
    /// The strategy's own defaults.
    pub defaults: RightsizingSettings,
    /// The settings the strategy reads (the UI renders only these fields).
    pub settings_keys: Vec<String>,
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
    /// Pod names behind the usage, sorted (at most 50).
    #[serde(default)]
    pub pods: Vec<String>,
    /// More pods than `pods` lists.
    #[serde(default)]
    pub pods_truncated: bool,
    /// The HPA that scales this workload.
    #[serde(default)]
    pub hpa: Option<HpaInfo>,
    /// Quick-focus groups this workload belongs to.
    #[serde(default)]
    pub lenses: Vec<RecommendationLens>,
    /// Replicas behind totals and monthly amounts: `replicas`, or a
    /// CronJob's observed duty cycle.
    #[serde(default)]
    pub cost_replicas: f64,
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
    /// Id of the strategy that produced the recommendations.
    pub strategy: String,
    /// Every strategy the backend offers.
    pub strategies: Vec<RightsizingStrategyInfo>,
    pub computed_at: i64,
    /// The strategy was chosen automatically (none was requested).
    #[serde(default)]
    pub strategy_auto: bool,
    /// End of the usage window (ms).
    #[serde(default)]
    pub window_end: i64,
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
    /// No kube-state-metrics owner series: pods are matched by name.
    OwnershipUnavailable,
    /// Part of the usage queries failed or warned (detail: the queries).
    PartialData,
    /// Namespaces whose usage could not be queried (detail: the namespaces).
    NamespaceFailed,
    /// The query budget ran out before every namespace was covered.
    QueryBudgetExceeded,
    /// HorizontalPodAutoscalers could not be listed.
    HpaUnavailable,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A `WorkloadRecommendation` as serialized before the evidence contract:
    /// no pods / pods_truncated / hpa / lenses / cost_replicas, no container
    /// evidence, usage without cpu_avg / memory_avg.
    const OLD_WORKLOAD: &str = r#"{
        "kind": "Deployment", "namespace": "shop", "name": "web", "uid": "u1",
        "replicas": 2, "confidence": "high", "verdict": "over", "coverage_hours": 168.0,
        "containers": [{
            "name": "app",
            "current": {"cpu_request": 1000.0, "cpu_limit": null, "memory_request": 1073741824.0, "memory_limit": null},
            "recommended": {"cpu_request": 140.0, "cpu_limit": null, "memory_request": 385875968.0, "memory_limit": null},
            "usage": {"cpu_p95": 120.0, "cpu_max": 300.0, "memory_max": 314572800.0, "hours": 168.0},
            "cpu": "decrease", "memory": "decrease", "memory_limit": "unchanged", "cpu_limit": "unchanged",
            "confidence": "high", "warnings": [], "cpu_limit_raised": false, "memory_limit_raised": false
        }],
        "monthly_delta": -12.5, "monthly_current": 30.0, "changed": true
    }"#;

    #[test]
    fn contract_defaults_normalize_and_old_json_reads() {
        let s = RightsizingSettings::default();
        assert_eq!(
            (s.min_hours, s.min_coverage, s.throttle_threshold_percent),
            (24.0, 0.9, 5.0)
        );
        let n = RightsizingSettings {
            days: 2,
            min_hours: 999.0,
            min_coverage: 0.0,
            throttle_threshold_percent: 90.0,
            ..s.clone()
        }
        .normalized();
        assert_eq!(
            (n.min_hours, n.min_coverage, n.throttle_threshold_percent),
            (48.0, 0.1, 50.0)
        );
        let req: RightsizingRequest = serde_json::from_str(r#"{"namespaces":[]}"#).unwrap();
        assert!(req.settings.is_none());
        let old: WorkloadRecommendation = serde_json::from_str(OLD_WORKLOAD).unwrap();
        assert!(old.pods.is_empty() && old.lenses.is_empty() && old.hpa.is_none());
        assert!(old.containers[0].evidence.is_none());
        assert_eq!(old.containers[0].usage.unwrap().cpu_avg, None);
        assert_eq!(
            serde_json::to_value(EvidenceIdentity::NameMatch).unwrap(),
            json!("name-match")
        );
        assert_eq!(
            serde_json::to_value(RecommendationLens::LimitRaised).unwrap(),
            json!("limit-raised")
        );
    }
}
