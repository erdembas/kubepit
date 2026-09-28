//! The `workload-history` strategy: KubeFit's recommendation logic, fed by
//! the whole history of a workload across its pod incarnations (owner
//! metrics pool a rollout into one workload; see spec §6.6).
//!
//! - CPU request = the p95 of the 5-minute rates (the maximum over the pods'
//!   own p95s) + headroom (default 20 %), at least the minimum, rounded up
//!   to whole millicores.
//! - Memory request = the maximum working set + headroom (default 20 %), at
//!   least the minimum, rounded up to whole MiB. After an OOM kill the base
//!   is never below the current memory limit: the working set peaks at the
//!   limit just before the kill, and 5-minute samples miss that peak.
//! - No churn: the current value stays unless the change is at least 10 %
//!   and 10 m / 16 MiB, or the current value is below the observed peak.
//! - A container without a memory limit gets one at the (floored) peak +
//!   `memory_limit_headroom_percent`, never below the new request, flagged
//!   `memory-limit-added`. Existing limits are left to
//!   [`super::strategy::finalize`], which raises them proportionally when a
//!   new request exceeds them; CPU limits are never invented.
//! - Confidence: metrics-server is low; 72 hours or more of history is
//!   high, anything shorter medium (`short-history`). Evidence caps
//!   (coverage, HPA, OOM, throttling, identity) come from the shared
//!   [`super::strategy::apply_evidence`].

use super::math::{settle, MIB, MIN_CPU_CHANGE, MIN_MEMORY_CHANGE};
use super::percentile::{
    WARN_MEMORY_LIMIT_ADDED, WARN_METRICS_SERVER_ONLY, WARN_NO_USAGE, WARN_SHORT_HISTORY,
};
use super::strategy::{ContainerInput, RecommendationStrategy, StrategyOutput};
use super::types::{
    Confidence, RecommendationWarning, ResourceValues, RightsizingSettings, RightsizingSource,
    RightsizingStrategyInfo,
};

pub const WORKLOAD_HISTORY_ID: &str = "workload-history";

/// Hours of history from which a recommendation is high confidence.
const HIGH_CONFIDENCE_HOURS: f64 = 72.0;

pub struct WorkloadHistory;

impl WorkloadHistory {
    /// CPU and memory headroom 20 %, the rest as [`RightsizingSettings::default`].
    pub fn defaults() -> RightsizingSettings {
        RightsizingSettings {
            cpu_headroom_percent: 20.0,
            memory_headroom_percent: 20.0,
            ..RightsizingSettings::default()
        }
    }
}

/// Whole millicores, rounded up (tolerating float noise).
fn whole_millicores(value: f64) -> f64 {
    (value - 1e-9).ceil().max(0.0)
}

/// Whole MiB, rounded up (tolerating float noise).
fn whole_mib(bytes: f64) -> f64 {
    (bytes / MIB - 1e-9).ceil().max(0.0) * MIB
}

impl RecommendationStrategy for WorkloadHistory {
    fn info(&self) -> RightsizingStrategyInfo {
        RightsizingStrategyInfo {
            id: WORKLOAD_HISTORY_ID.to_string(),
            name: "Workload history".to_string(),
            defaults: Self::defaults(),
            settings_keys: [
                "cpu_headroom_percent",
                "memory_headroom_percent",
                "memory_limit_headroom_percent",
                "days",
                "min_hours",
                "min_coverage",
                "throttle_threshold_percent",
            ]
            .map(String::from)
            .to_vec(),
        }
    }

    fn recommend(&self, input: &ContainerInput<'_>) -> StrategyOutput {
        let current = input.current;
        let Some(u) = input.usage else {
            return StrategyOutput {
                recommended: ResourceValues::default(),
                confidence: Confidence::Low,
                warnings: vec![RecommendationWarning::new(WARN_NO_USAGE)],
            };
        };
        let s = input.settings;
        let cpu = whole_millicores(
            s.min_cpu_millicores
                .max(u.cpu_p95 * (1.0 + s.cpu_headroom_percent / 100.0)),
        );
        let oom_killed = input.evidence.is_some_and(|e| e.oom_killed);
        let memory_base = match current.memory_limit {
            Some(limit) if oom_killed => u.memory_max.max(limit),
            _ => u.memory_max,
        };
        let memory = whole_mib(
            s.min_memory_bytes
                .max(memory_base * (1.0 + s.memory_headroom_percent / 100.0)),
        );
        let cpu = settle(current.cpu_request, cpu, MIN_CPU_CHANGE, u.cpu_p95);
        let memory = settle(
            current.memory_request,
            memory,
            MIN_MEMORY_CHANGE,
            memory_base,
        );
        let memory_limit = current.memory_limit.is_none().then(|| {
            memory.max(whole_mib(
                memory_base * (1.0 + s.memory_limit_headroom_percent / 100.0),
            ))
        });

        let confidence = match input.source {
            RightsizingSource::Prometheus if u.hours >= HIGH_CONFIDENCE_HOURS => Confidence::High,
            RightsizingSource::Prometheus => Confidence::Medium,
            _ => Confidence::Low,
        };
        let mut warnings = Vec::new();
        match input.source {
            RightsizingSource::Prometheus if confidence != Confidence::High => {
                warnings.push(RecommendationWarning::new(WARN_SHORT_HISTORY))
            }
            RightsizingSource::Prometheus => {}
            _ => warnings.push(RecommendationWarning::new(WARN_METRICS_SERVER_ONLY)),
        }
        if memory_limit.is_some() {
            warnings.push(RecommendationWarning::new(WARN_MEMORY_LIMIT_ADDED));
        }
        StrategyOutput {
            recommended: ResourceValues {
                cpu_request: Some(cpu),
                cpu_limit: None,
                memory_request: Some(memory),
                memory_limit,
            },
            confidence,
            warnings,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rightsizing::math::{GIB, MIB};
    use crate::rightsizing::strategy::{recommend, ContainerInput};
    use crate::rightsizing::types::{
        Change, Confidence, ContainerRecommendation, ResourceValues, RightsizingSource,
        UsageEvidence, UsageStats,
    };

    /// Both requests, and a memory limit of `mem`.
    fn current(cpu: f64, mem: f64) -> ResourceValues {
        ResourceValues {
            cpu_request: Some(cpu),
            cpu_limit: None,
            memory_request: Some(mem),
            memory_limit: Some(mem),
        }
    }

    /// The two requests, no limits.
    fn requests_only(cpu: f64, mem: f64) -> ResourceValues {
        ResourceValues {
            cpu_request: Some(cpu),
            memory_request: Some(mem),
            ..Default::default()
        }
    }

    /// A CPU request and a memory limit of `mem`, no memory request.
    fn limits(mem: f64) -> ResourceValues {
        ResourceValues {
            cpu_request: Some(1000.0),
            memory_limit: Some(mem),
            ..Default::default()
        }
    }

    fn usage(cpu_p95: f64, memory_max: f64, hours: f64) -> UsageStats {
        UsageStats {
            cpu_p95,
            cpu_max: cpu_p95 * 1.5,
            memory_max,
            hours,
            ..Default::default()
        }
    }

    fn run_full(
        current: ResourceValues,
        usage: Option<UsageStats>,
        source: RightsizingSource,
        evidence: Option<&UsageEvidence>,
    ) -> ContainerRecommendation {
        let settings = WorkloadHistory::defaults();
        recommend(
            &WorkloadHistory,
            &ContainerInput {
                name: "app",
                current,
                usage,
                source,
                settings: &settings,
                evidence,
                hpa: None,
            },
        )
    }

    fn run(current: ResourceValues, usage: UsageStats) -> ContainerRecommendation {
        run_full(current, Some(usage), RightsizingSource::Prometheus, None)
    }

    fn run_oom(current: ResourceValues, usage: UsageStats) -> ContainerRecommendation {
        let evidence = UsageEvidence {
            observed_hours: usage.hours,
            cpu_coverage: Some(1.0),
            memory_coverage: Some(1.0),
            oom_killed: true,
            ..Default::default()
        };
        run_full(
            current,
            Some(usage),
            RightsizingSource::Prometheus,
            Some(&evidence),
        )
    }

    fn codes(r: &ContainerRecommendation) -> Vec<&str> {
        r.warnings.iter().map(|w| w.code.as_str()).collect()
    }

    #[test]
    fn kubefit_fixture_numbers() {
        let r = run(
            current(1000.0, 256.0 * MIB),
            usage(100.0, 100.0 * MIB, 168.0),
        );
        assert_eq!(
            (r.recommended.cpu_request, r.recommended.memory_request),
            (Some(120.0), Some(120.0 * MIB))
        );
        assert_eq!(r.cpu, Change::Decrease);
        assert_eq!(
            r.recommended.memory_limit,
            Some(256.0 * MIB),
            "limits never lowered"
        );
    }

    #[test]
    fn minimums_and_whole_units() {
        assert_eq!(
            run(current(500.0, GIB), usage(1.0, MIB, 168.0))
                .recommended
                .cpu_request,
            Some(10.0)
        );
        assert_eq!(
            run(current(500.0, GIB), usage(1.0, MIB, 168.0))
                .recommended
                .memory_request,
            Some(32.0 * MIB)
        );
        assert_eq!(
            run(current(1000.0, GIB), usage(101.3, 100.0 * MIB + 1.0, 168.0))
                .recommended
                .cpu_request,
            Some(122.0)
        );
        assert_eq!(
            run(current(1000.0, GIB), usage(101.3, 100.0 * MIB + 1.0, 168.0))
                .recommended
                .memory_request,
            Some(121.0 * MIB)
        );
    }

    #[test]
    fn containers_without_a_memory_limit_get_one() {
        let r = run(
            requests_only(1000.0, 256.0 * MIB),
            usage(100.0, 100.0 * MIB, 168.0),
        );
        assert_eq!(r.memory_limit, Change::Set);
        assert_eq!(r.recommended.memory_limit, Some(140.0 * MIB)); // 100 MiB × 1.4
        assert!(codes(&r).contains(&"memory-limit-added"));
        assert_eq!(
            r.cpu_limit,
            Change::Unchanged,
            "CPU limits are never invented"
        );
        // Never below the new request (zero limit headroom).
        let settings = RightsizingSettings {
            memory_limit_headroom_percent: 0.0,
            ..WorkloadHistory::defaults()
        };
        let r = recommend(
            &WorkloadHistory,
            &ContainerInput {
                name: "app",
                current: requests_only(1000.0, 256.0 * MIB),
                usage: Some(usage(100.0, 100.0 * MIB, 168.0)),
                source: RightsizingSource::Prometheus,
                settings: &settings,
                evidence: None,
                hpa: None,
            },
        );
        assert_eq!(r.recommended.memory_limit, r.recommended.memory_request);
        // An existing limit is left alone (and raised by finalize only if exceeded).
        let r = run(
            current(1000.0, 256.0 * MIB),
            usage(100.0, 100.0 * MIB, 168.0),
        );
        assert!(!codes(&r).contains(&"memory-limit-added"));
    }

    #[test]
    fn oom_floor_uses_the_current_limit() {
        let r = run_oom(limits(256.0 * MIB), usage(100.0, 200.0 * MIB, 168.0));
        // 256 MiB × 1.2 → 307.2 → 308
        assert_eq!(r.recommended.memory_request, Some(308.0 * MIB));
        assert!(r.memory_limit_raised);
        assert!(codes(&r).contains(&"oom-killed"));
        // Without the OOM kill the peak decides: 200 MiB × 1.2 = 240 MiB.
        let r = run(limits(256.0 * MIB), usage(100.0, 200.0 * MIB, 168.0));
        assert_eq!(r.recommended.memory_request, Some(240.0 * MIB));
    }

    #[test]
    fn confidence_tiers_and_no_churn() {
        assert_eq!(
            run(current(1000.0, GIB), usage(100.0, 200.0 * MIB, 168.0)).confidence,
            Confidence::High
        );
        let short = run(current(1000.0, GIB), usage(100.0, 200.0 * MIB, 48.0));
        assert_eq!(short.confidence, Confidence::Medium);
        assert!(codes(&short).contains(&"short-history"));
        assert_eq!(
            run(current(125.0, GIB), usage(100.0, 200.0 * MIB, 168.0)).cpu,
            Change::Unchanged
        );
        let ms = run_full(
            current(1000.0, GIB),
            Some(usage(100.0, 200.0 * MIB, 1.0)),
            RightsizingSource::MetricsServer,
            None,
        );
        assert_eq!(ms.confidence, Confidence::Low);
        assert!(codes(&ms).contains(&"metrics-server-only"));
        // Without usage nothing changes.
        let none = run_full(
            current(1000.0, GIB),
            None,
            RightsizingSource::Prometheus,
            None,
        );
        assert!(!none.changed());
        assert_eq!(
            (none.confidence, codes(&none)),
            (Confidence::Low, vec!["no-usage"])
        );
    }

    #[test]
    fn info_lists_its_defaults_and_keys() {
        let info = WorkloadHistory.info();
        assert_eq!(
            (info.id.as_str(), info.name.as_str()),
            (WORKLOAD_HISTORY_ID, "Workload history")
        );
        assert_eq!(
            (
                info.defaults.cpu_headroom_percent,
                info.defaults.memory_headroom_percent
            ),
            (20.0, 20.0)
        );
        assert!(info.settings_keys.iter().any(|k| k == "min_coverage"));
    }
}
