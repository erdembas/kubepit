//! The default strategy: percentile + headroom.
//!
//! - CPU request = p95 of the 5-minute rates + headroom (default 15 %). CPU
//!   is compressible, so the p95 is the peak that matters.
//! - Memory request = maximum working set + headroom (default 20 %); memory
//!   is not compressible, so the maximum is the peak.
//! - Memory limit: the maximum + a larger headroom (default 40 %), never
//!   below the new request. A container without a limit gets one (flagged
//!   `memory-limit-added`: it bounds a leak before it takes the node down);
//!   an existing limit tighter than that is raised to it; limits are never
//!   lowered (a lower limit saves nothing and risks OOM kills). A limit the
//!   new request exceeds is left to [`super::strategy::finalize`], which
//!   raises it proportionally.
//! - CPU limits are left alone (raised with the request when needed).
//! - Minimums, rounding up, never below the observed peak, and no churn on
//!   small differences ([`super::math`]).
//! - Confidence: Prometheus history of at least 3 days is high, 12 hours
//!   medium, anything else (and the metrics-server hour) low.

use super::math::{
    cpu_request, memory_limit, memory_request, settle, MIN_CPU_CHANGE, MIN_MEMORY_CHANGE,
};
use super::strategy::{
    ContainerInput, RecommendationStrategy, StrategyOutput, DEFAULT_STRATEGY_ID,
};
use super::types::{
    Confidence, RecommendationWarning, ResourceValues, RightsizingSource, RightsizingStrategyInfo,
};

pub const WARN_NO_USAGE: &str = "no-usage";
pub const WARN_SHORT_HISTORY: &str = "short-history";
pub const WARN_METRICS_SERVER_ONLY: &str = "metrics-server-only";
pub const WARN_MEMORY_NEAR_LIMIT: &str = "memory-near-limit";
pub const WARN_CPU_BURSTS: &str = "cpu-bursts";
pub const WARN_MEMORY_LIMIT_ADDED: &str = "memory-limit-added";

/// How much to trust `hours` of history from `source`.
pub fn confidence(source: RightsizingSource, hours: f64) -> Confidence {
    match source {
        RightsizingSource::Prometheus if hours >= 72.0 => Confidence::High,
        RightsizingSource::Prometheus if hours >= 12.0 => Confidence::Medium,
        _ => Confidence::Low,
    }
}

pub struct PercentileHeadroom;

impl RecommendationStrategy for PercentileHeadroom {
    fn info(&self) -> RightsizingStrategyInfo {
        RightsizingStrategyInfo {
            id: DEFAULT_STRATEGY_ID.to_string(),
            name: "Percentile + headroom".to_string(),
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
        let settings = input.settings;
        let cpu = settle(
            current.cpu_request,
            cpu_request(u.cpu_p95, settings),
            MIN_CPU_CHANGE,
            u.cpu_p95,
        );
        let memory = settle(
            current.memory_request,
            memory_request(u.memory_max, settings),
            MIN_MEMORY_CHANGE,
            u.memory_max,
        );
        let limit = memory_limit(u.memory_max, memory, settings);
        let memory_limit = match current.memory_limit {
            // Too tight for the peak + limit headroom: raise it; never lower it.
            Some(l) if memory <= l => {
                Some(settle(Some(l), limit, MIN_MEMORY_CHANGE, u.memory_max).max(l))
            }
            // None yet: propose one (peak + limit headroom, at least the request).
            None => Some(limit),
            // The new request exceeds it: raised proportionally by `finalize`.
            Some(_) => None,
        };

        let confidence = confidence(input.source, u.hours);
        let mut warnings = Vec::new();
        match input.source {
            RightsizingSource::MetricsServer => {
                warnings.push(RecommendationWarning::new(WARN_METRICS_SERVER_ONLY))
            }
            RightsizingSource::Prometheus if confidence != Confidence::High => {
                warnings.push(RecommendationWarning::new(WARN_SHORT_HISTORY))
            }
            _ => {}
        }
        if current
            .memory_limit
            .is_some_and(|l| u.memory_max >= 0.9 * l)
        {
            warnings.push(RecommendationWarning::new(WARN_MEMORY_NEAR_LIMIT));
        }
        if current.memory_limit.is_none() {
            warnings.push(RecommendationWarning::new(WARN_MEMORY_LIMIT_ADDED));
        }
        if u.cpu_max > 2.0 * cpu && u.cpu_max > cpu + 250.0 {
            warnings.push(RecommendationWarning::new(WARN_CPU_BURSTS));
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
    use crate::rightsizing::strategy::{recommend, WARN_MEMORY_LIMIT_RAISED};
    use crate::rightsizing::types::{
        Change, ContainerRecommendation, RightsizingSettings, UsageStats,
    };

    fn usage(cpu_p95: f64, memory_max: f64) -> UsageStats {
        UsageStats {
            cpu_p95,
            cpu_max: cpu_p95 * 1.5,
            memory_max,
            hours: 168.0,
            cpu_avg: None,
            memory_avg: None,
        }
    }

    fn run(
        current: ResourceValues,
        usage: Option<UsageStats>,
        source: RightsizingSource,
    ) -> ContainerRecommendation {
        let settings = RightsizingSettings::default();
        recommend(
            &PercentileHeadroom,
            &ContainerInput {
                name: "app",
                current,
                usage,
                source,
                settings: &settings,
            },
        )
    }

    fn codes(r: &ContainerRecommendation) -> Vec<&str> {
        r.warnings.iter().map(|w| w.code.as_str()).collect()
    }

    #[test]
    fn over_provisioned_containers_shrink() {
        let current = ResourceValues {
            cpu_request: Some(1000.0),
            cpu_limit: None,
            memory_request: Some(2.0 * GIB),
            memory_limit: Some(2.0 * GIB),
        };
        let r = run(
            current,
            Some(usage(120.0, 300.0 * MIB)),
            RightsizingSource::Prometheus,
        );
        assert_eq!(r.cpu, Change::Decrease);
        assert_eq!(r.recommended.cpu_request, Some(140.0));
        assert_eq!(r.memory, Change::Decrease);
        assert_eq!(r.recommended.memory_request, Some(368.0 * MIB));
        assert_eq!(
            r.memory_limit,
            Change::Unchanged,
            "limits are never lowered"
        );
        assert_eq!(r.recommended.memory_limit, Some(2.0 * GIB));
        assert_eq!(r.cpu_limit, Change::Unchanged);
        assert_eq!(r.confidence, Confidence::High);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        assert!(r.changed());
    }

    #[test]
    fn under_provisioned_containers_grow_and_limits_rise_proportionally() {
        let current = ResourceValues {
            cpu_request: Some(100.0),
            cpu_limit: Some(200.0),
            memory_request: Some(128.0 * MIB),
            memory_limit: Some(256.0 * MIB),
        };
        let r = run(
            current,
            Some(usage(400.0, 250.0 * MIB)),
            RightsizingSource::Prometheus,
        );
        assert_eq!(r.cpu, Change::Increase);
        assert_eq!(r.recommended.cpu_request, Some(460.0));
        // Limit ÷ request was 2: 460m → 920m.
        assert_eq!(r.recommended.cpu_limit, Some(920.0));
        assert!(r.cpu_limit_raised);
        assert_eq!(r.memory, Change::Increase);
        assert_eq!(r.recommended.memory_request, Some(304.0 * MIB));
        // 304 MiB exceeds the 256 MiB limit: × 2 → 608 MiB.
        assert_eq!(r.recommended.memory_limit, Some(608.0 * MIB));
        assert!(r.memory_limit_raised);
        assert!(codes(&r).contains(&WARN_MEMORY_LIMIT_RAISED));
        assert!(
            codes(&r).contains(&WARN_MEMORY_NEAR_LIMIT),
            "250 of 256 MiB"
        );
    }

    #[test]
    fn small_differences_keep_current_values_unless_below_the_peak() {
        let current = ResourceValues {
            cpu_request: Some(240.0),
            cpu_limit: None,
            memory_request: Some(320.0 * MIB),
            memory_limit: None,
        };
        let r = run(
            current,
            Some(usage(200.0, 260.0 * MIB)),
            RightsizingSource::Prometheus,
        );
        assert_eq!(r.cpu, Change::Unchanged, "230m vs 240m");
        assert_eq!(r.recommended.cpu_request, Some(240.0));
        assert_eq!(r.memory, Change::Unchanged);
        // No limit yet: one is proposed at peak + 40 % (260 MiB → 368 MiB).
        assert_eq!(r.memory_limit, Change::Set);
        assert_eq!(r.recommended.memory_limit, Some(368.0 * MIB));
        assert!(codes(&r).contains(&WARN_MEMORY_LIMIT_ADDED));
        assert!(r.changed(), "adding a limit is a change");
        // A limit tighter than peak + 40 % is raised: 260 MiB → 368 MiB.
        let tight = ResourceValues {
            memory_limit: Some(330.0 * MIB),
            ..current
        };
        let r = run(
            tight,
            Some(usage(200.0, 260.0 * MIB)),
            RightsizingSource::Prometheus,
        );
        assert_eq!(r.memory_limit, Change::Increase);
        assert_eq!(r.recommended.memory_limit, Some(368.0 * MIB));
        assert!(
            !r.memory_limit_raised,
            "headroom, not the proportional raise"
        );
        // A tiny request below the observed p95 always changes, however small the step.
        let tiny = ResourceValues {
            cpu_request: Some(5.0),
            memory_request: Some(20.0 * MIB),
            ..Default::default()
        };
        let r = run(
            tiny,
            Some(usage(9.0, 24.0 * MIB)),
            RightsizingSource::Prometheus,
        );
        assert_eq!(r.cpu, Change::Increase);
        assert!(r.recommended.cpu_request.unwrap() >= 9.0);
        assert_eq!(r.memory, Change::Increase);
        assert!(r.recommended.memory_request.unwrap() >= 24.0 * MIB);
        // Without usage nothing changes.
        let r = run(current, None, RightsizingSource::Prometheus);
        assert!(!r.changed());
        assert_eq!(r.recommended, current);
        assert_eq!(codes(&r), vec![WARN_NO_USAGE]);
    }

    #[test]
    fn confidence_and_history_warnings() {
        assert_eq!(
            confidence(RightsizingSource::Prometheus, 168.0),
            Confidence::High
        );
        assert_eq!(
            confidence(RightsizingSource::Prometheus, 24.0),
            Confidence::Medium
        );
        assert_eq!(
            confidence(RightsizingSource::Prometheus, 2.0),
            Confidence::Low
        );
        assert_eq!(
            confidence(RightsizingSource::MetricsServer, 1000.0),
            Confidence::Low
        );
        let current = ResourceValues {
            cpu_request: Some(500.0),
            memory_request: Some(GIB),
            ..Default::default()
        };
        let short = UsageStats {
            hours: 20.0,
            ..usage(100.0, 200.0 * MIB)
        };
        let r = run(current, Some(short), RightsizingSource::Prometheus);
        assert_eq!(r.confidence, Confidence::Medium);
        assert_eq!(codes(&r), vec![WARN_SHORT_HISTORY, WARN_MEMORY_LIMIT_ADDED]);
        let r = run(current, Some(short), RightsizingSource::MetricsServer);
        assert_eq!(r.confidence, Confidence::Low);
        assert_eq!(
            codes(&r),
            vec![WARN_METRICS_SERVER_ONLY, WARN_MEMORY_LIMIT_ADDED]
        );
        let bursty = UsageStats {
            cpu_max: 2000.0,
            ..usage(100.0, 200.0 * MIB)
        };
        let r = run(current, Some(bursty), RightsizingSource::Prometheus);
        assert!(codes(&r).contains(&WARN_CPU_BURSTS));
    }
}
