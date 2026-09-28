//! Strategy-independent building blocks: percentiles, rounding, headroom,
//! the no-churn rule, sample statistics, cost of requests, the
//! over / under verdict and the workload recommendation built from its
//! containers ([`workload_recommendation`]). Strategies
//! ([`super::strategy`]) combine them.
//!
//! - Values round *up* to sane steps (5 m / 10 m / 50 m / 100 m, 8 / 16 / 64 /
//!   256 MiB) and never below the minimums or the observed peak.
//! - Small differences (under 10 % or under 10 m / 16 MiB) keep the current
//!   value, so recommendations do not churn — unless the current value is
//!   below the observed peak.

use super::strategy::WARN_OOM_KILLED;
use super::summary::lenses_of;
use super::types::{
    Change, Confidence, ContainerRecommendation, HpaInfo, RightsizingSettings, UsageStats, Verdict,
    WorkloadRecommendation,
};
use crate::cost::CostPricing;

pub const MIB: f64 = 1024.0 * 1024.0;
pub const GIB: f64 = 1024.0 * MIB;
/// Relative change below which the current value is kept.
pub const MIN_RELATIVE_CHANGE: f64 = 0.10;
pub const MIN_CPU_CHANGE: f64 = 10.0;
pub const MIN_MEMORY_CHANGE: f64 = 16.0 * MIB;

impl RightsizingSettings {
    /// Clamped to sane ranges: headroom 0–300 %, 1–30 days, minimum history
    /// 1–720 hours (at most the window), minimum coverage 0.1–1, throttling
    /// threshold 1–50 %.
    pub fn normalized(self) -> Self {
        let pct = |v: f64, default: f64| {
            if v.is_finite() {
                v.clamp(0.0, 300.0)
            } else {
                default
            }
        };
        let defaults = RightsizingSettings::default();
        let min = |v: f64, default: f64| {
            if v.is_finite() && v >= 0.0 {
                v
            } else {
                default
            }
        };
        let clamp = |v: f64, lo: f64, hi: f64, default: f64| {
            if v.is_finite() {
                v.clamp(lo, hi)
            } else {
                default.clamp(lo, hi)
            }
        };
        let days = self.days.clamp(1, 30);
        let max_hours = (f64::from(days) * 24.0).min(720.0);
        Self {
            cpu_headroom_percent: pct(self.cpu_headroom_percent, defaults.cpu_headroom_percent),
            memory_headroom_percent: pct(
                self.memory_headroom_percent,
                defaults.memory_headroom_percent,
            ),
            memory_limit_headroom_percent: pct(
                self.memory_limit_headroom_percent,
                defaults.memory_limit_headroom_percent,
            ),
            min_cpu_millicores: min(self.min_cpu_millicores, defaults.min_cpu_millicores),
            min_memory_bytes: min(self.min_memory_bytes, defaults.min_memory_bytes),
            days,
            min_hours: clamp(self.min_hours, 1.0, max_hours, defaults.min_hours),
            min_coverage: clamp(self.min_coverage, 0.1, 1.0, defaults.min_coverage),
            throttle_threshold_percent: clamp(
                self.throttle_threshold_percent,
                1.0,
                50.0,
                defaults.throttle_threshold_percent,
            ),
        }
    }
}

/// `p`-th percentile (0–100) with linear interpolation between ranks;
/// non-finite values are ignored. `None` without values.
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = (p.clamp(0.0, 100.0) / 100.0) * (sorted.len() - 1) as f64;
    let (lo, hi) = (rank.floor() as usize, rank.ceil() as usize);
    let frac = rank - lo as f64;
    Some(sorted[lo] + (sorted[hi] - sorted[lo]) * frac)
}

fn round_up(value: f64, step: f64) -> f64 {
    // Tolerate float noise so exact steps stay exact.
    ((value / step) - 1e-9).ceil().max(0.0) * step
}

/// Millicores rounded up: 5 m steps to 100 m, 10 m to 1 core, 50 m to 4 cores, then 100 m.
pub fn round_up_cpu(millicores: f64) -> f64 {
    let m = millicores.max(0.0);
    let step = if m <= 100.0 {
        5.0
    } else if m <= 1000.0 {
        10.0
    } else if m <= 4000.0 {
        50.0
    } else {
        100.0
    };
    round_up(m, step)
}

/// Bytes rounded up: 8 MiB steps to 256 MiB, 16 MiB to 1 GiB, 64 MiB to 4 GiB, then 256 MiB.
pub fn round_up_memory(bytes: f64) -> f64 {
    let b = bytes.max(0.0);
    let step = if b <= 256.0 * MIB {
        8.0 * MIB
    } else if b <= GIB {
        16.0 * MIB
    } else if b <= 4.0 * GIB {
        64.0 * MIB
    } else {
        256.0 * MIB
    };
    round_up(b, step)
}

pub fn with_headroom(value: f64, percent: f64) -> f64 {
    value.max(0.0) * (1.0 + percent / 100.0)
}

/// CPU request for a p95 usage + headroom (never below it or the minimum).
pub fn cpu_request(p95: f64, settings: &RightsizingSettings) -> f64 {
    round_up_cpu(with_headroom(p95, settings.cpu_headroom_percent))
        .max(round_up_cpu(settings.min_cpu_millicores))
        .max(round_up_cpu(p95))
}

/// Memory request for a maximum working set + headroom (never below it).
pub fn memory_request(max: f64, settings: &RightsizingSettings) -> f64 {
    round_up_memory(with_headroom(max, settings.memory_headroom_percent))
        .max(round_up_memory(settings.min_memory_bytes))
        .max(round_up_memory(max))
}

/// Memory limit: maximum + limit headroom, never below the request.
pub fn memory_limit(max: f64, request: f64, settings: &RightsizingSettings) -> f64 {
    round_up_memory(with_headroom(max, settings.memory_limit_headroom_percent))
        .max(request)
        .max(round_up_memory(max))
}

fn significant(current: f64, next: f64, absolute: f64) -> bool {
    let delta = (next - current).abs();
    delta >= absolute && (current <= 0.0 || delta / current >= MIN_RELATIVE_CHANGE)
}

/// `next`, or `current` when the difference is too small to matter and
/// `current` is not below `floor` (the observed peak).
pub fn settle(current: Option<f64>, next: f64, absolute: f64, floor: f64) -> f64 {
    match current {
        Some(c) if c >= floor && !significant(c, next, absolute) => c,
        _ => next,
    }
}

/// How a value moves from `current` to `next` (`None` = left as is).
pub fn change_of(current: Option<f64>, next: Option<f64>) -> Change {
    match (current, next) {
        (_, None) => Change::Unchanged,
        (None, Some(_)) => Change::Set,
        (Some(c), Some(n)) if (n - c).abs() < 1e-6 => Change::Unchanged,
        (Some(c), Some(n)) if n > c => Change::Increase,
        _ => Change::Decrease,
    }
}

/// Replicas behind a workload's monthly amounts and totals: its replicas,
/// or for a CronJob the largest duty cycle (average running pods over the
/// window) of its containers, one without evidence. A nightly job thus
/// does not cost like an always-on replica.
pub fn cost_replicas(kind: &str, replicas: u32, containers: &[ContainerRecommendation]) -> f64 {
    if kind != "CronJob" {
        return f64::from(replicas);
    }
    containers
        .iter()
        .filter_map(|c| c.evidence.as_ref()?.duty)
        .filter(|d| d.is_finite())
        .reduce(f64::max)
        .unwrap_or(1.0)
}

/// Requests of `replicas` (cost replicas, possibly fractional) per month.
pub fn monthly_requests(
    containers: &[ContainerRecommendation],
    replicas: f64,
    pricing: &CostPricing,
    recommended: bool,
) -> f64 {
    containers
        .iter()
        .map(|c| {
            let v = if recommended {
                c.recommended
            } else {
                c.current
            };
            pricing.cpu_monthly(v.cpu_request.unwrap_or(0.0) / 1000.0)
                + pricing.memory_monthly(v.memory_request.unwrap_or(0.0))
        })
        .sum::<f64>()
        * replicas
}

/// Over- or under-provisioned, from the containers' usage and requests.
/// An OOM kill (the `oom-killed` warning) always means under-provisioned.
pub fn verdict(containers: &[ContainerRecommendation], current: f64, recommended: f64) -> Verdict {
    let oom_killed = containers
        .iter()
        .any(|c| c.warnings.iter().any(|w| w.code == WARN_OOM_KILLED));
    if oom_killed {
        return Verdict::Under;
    }
    if containers.iter().all(|c| c.usage.is_none()) {
        return Verdict::NoData;
    }
    let under = containers.iter().any(|c| {
        let Some(u) = c.usage else { return false };
        let memory_above = c.current.memory_request.is_some_and(|r| u.memory_max > r);
        let near_limit = c
            .current
            .memory_limit
            .is_some_and(|l| u.memory_max >= 0.9 * l);
        let cpu_above = c
            .current
            .cpu_request
            .is_some_and(|r| u.cpu_p95 > r * (1.0 + MIN_RELATIVE_CHANGE));
        let unset = c.current.cpu_request.is_none() || c.current.memory_request.is_none();
        memory_above || near_limit || cpu_above || unset
    });
    if under {
        Verdict::Under
    } else if current > 0.0 && recommended <= current * (1.0 - MIN_RELATIVE_CHANGE) {
        Verdict::Over
    } else {
        Verdict::Balanced
    }
}

/// What a workload recommendation holds besides what follows from its
/// containers: identity, replicas and the workload-level facts of the
/// collection.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorkloadFacts {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub uid: String,
    pub replicas: u32,
    /// Pod names behind the usage, sorted (at most 50).
    pub pods: Vec<String>,
    pub pods_truncated: bool,
    pub hpa: Option<HpaInfo>,
}

/// The recommendation of a workload from its container recommendations
/// (spec §6.9), shared by fresh reports and re-evaluated stored ones:
/// cost replicas, monthly amounts, the verdict, the weakest confidence of
/// the containers with usage, the history behind it and the lenses.
pub fn workload_recommendation(
    facts: WorkloadFacts,
    containers: Vec<ContainerRecommendation>,
    pricing: &CostPricing,
) -> WorkloadRecommendation {
    let cost_replicas = cost_replicas(&facts.kind, facts.replicas, &containers);
    let monthly_current = monthly_requests(&containers, cost_replicas, pricing, false);
    let monthly_recommended = monthly_requests(&containers, cost_replicas, pricing, true);
    // The weakest container with data decides.
    let confidence = containers
        .iter()
        .filter(|c| c.usage.is_some())
        .map(|c| c.confidence)
        .min()
        .unwrap_or(Confidence::Low);
    let mut rec = WorkloadRecommendation {
        kind: facts.kind,
        namespace: facts.namespace,
        name: facts.name,
        uid: facts.uid,
        replicas: facts.replicas,
        confidence,
        verdict: verdict(&containers, monthly_current, monthly_recommended),
        coverage_hours: containers
            .iter()
            .filter_map(|c| c.usage.map(|u| u.hours))
            .fold(0.0, f64::max),
        changed: containers.iter().any(ContainerRecommendation::changed),
        monthly_delta: monthly_recommended - monthly_current,
        monthly_current,
        containers,
        pods: facts.pods,
        pods_truncated: facts.pods_truncated,
        hpa: facts.hpa,
        lenses: Vec::new(),
        cost_replicas,
    };
    rec.lenses = lenses_of(&rec);
    rec
}

/// Statistics of a series of samples (metrics-server history).
pub fn stats_from_samples(cpu: &[f64], memory: &[f64], interval_secs: f64) -> Option<UsageStats> {
    let cpu_p95 = percentile(cpu, 95.0)?;
    let cpu_max = cpu
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .fold(0.0, f64::max);
    let memory_max = memory
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .fold(0.0, f64::max);
    Some(UsageStats {
        cpu_p95,
        cpu_max,
        memory_max,
        hours: cpu.len() as f64 * interval_secs / 3600.0,
        cpu_avg: None,
        memory_avg: None,
    })
}

/// Worst replica wins: the largest p95, maximum and memory of `stats`;
/// hours add up (the caller divides by the replica count). Averages are
/// not combined (the metrics-server path has none): they are `None`.
pub fn combine(stats: &[UsageStats]) -> Option<UsageStats> {
    let mut iter = stats.iter();
    let first = UsageStats {
        cpu_avg: None,
        memory_avg: None,
        ..*iter.next()?
    };
    Some(iter.fold(first, |acc, s| UsageStats {
        cpu_p95: acc.cpu_p95.max(s.cpu_p95),
        cpu_max: acc.cpu_max.max(s.cpu_max),
        memory_max: acc.memory_max.max(s.memory_max),
        hours: acc.hours + s.hours,
        cpu_avg: None,
        memory_avg: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rightsizing::strategy::{recommend, DEFAULT_STRATEGY_ID};
    use crate::rightsizing::strategy::{strategy, ContainerInput};
    use crate::rightsizing::types::{RecommendationWarning, ResourceValues, RightsizingSource};

    fn settings() -> RightsizingSettings {
        RightsizingSettings::default()
    }

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

    fn rec(current: ResourceValues, usage: Option<UsageStats>) -> ContainerRecommendation {
        let s = settings();
        recommend(
            strategy(Some(DEFAULT_STRATEGY_ID)).unwrap(),
            &ContainerInput {
                name: "app",
                current,
                usage,
                source: RightsizingSource::Prometheus,
                settings: &s,
                evidence: None,
                hpa: None,
            },
        )
    }

    #[test]
    fn percentiles_interpolate_and_ignore_gaps() {
        let values: Vec<f64> = (1..=100).map(f64::from).collect();
        assert!((percentile(&values, 95.0).unwrap() - 95.05).abs() < 1e-9);
        assert_eq!(percentile(&values, 0.0), Some(1.0));
        assert_eq!(percentile(&values, 100.0), Some(100.0));
        assert_eq!(percentile(&[5.0], 95.0), Some(5.0));
        assert_eq!(percentile(&[3.0, f64::NAN, 1.0, 2.0], 50.0), Some(2.0));
        assert_eq!(percentile(&[], 95.0), None);
        assert_eq!(percentile(&[f64::NAN], 95.0), None);
    }

    #[test]
    fn rounding_goes_up_to_sane_steps() {
        assert_eq!(round_up_cpu(0.0), 0.0);
        assert_eq!(round_up_cpu(11.0), 15.0);
        assert_eq!(round_up_cpu(100.0), 100.0);
        assert_eq!(round_up_cpu(101.0), 110.0);
        assert_eq!(round_up_cpu(999.0), 1000.0);
        assert_eq!(round_up_cpu(1001.0), 1050.0);
        assert_eq!(round_up_cpu(4321.0), 4400.0);
        assert_eq!(round_up_memory(1.0), 8.0 * MIB);
        assert_eq!(round_up_memory(200.0 * MIB), 200.0 * MIB);
        assert_eq!(round_up_memory(300.0 * MIB), 304.0 * MIB);
        assert_eq!(round_up_memory(1.5 * GIB), 1.5 * GIB);
        assert_eq!(round_up_memory(1.51 * GIB), 1.5 * GIB + 64.0 * MIB);
        assert_eq!(round_up_memory(5.1 * GIB), 5.25 * GIB);
    }

    #[test]
    fn headroom_minimums_and_never_below_the_peak() {
        let s = settings();
        // 200m p95 + 15 % = 230m.
        assert_eq!(cpu_request(200.0, &s), 230.0);
        // 256 MiB + 20 % = 307.2 MiB → 320 MiB.
        assert_eq!(memory_request(256.0 * MIB, &s), 320.0 * MIB);
        // Limit: 256 MiB + 40 % = 358.4 MiB → 368 MiB.
        assert_eq!(memory_limit(256.0 * MIB, 320.0 * MIB, &s), 368.0 * MIB);
        // Minimums.
        assert_eq!(cpu_request(1.0, &s), 10.0);
        assert_eq!(memory_request(1.0 * MIB, &s), 32.0 * MIB);
        // Zero headroom and no minimums still never go below the peak.
        let bare = RightsizingSettings {
            cpu_headroom_percent: 0.0,
            memory_headroom_percent: 0.0,
            memory_limit_headroom_percent: 0.0,
            min_cpu_millicores: 0.0,
            min_memory_bytes: 0.0,
            ..settings()
        };
        for peak in [0.3, 7.0, 99.9, 333.3, 1234.5, 9999.0] {
            assert!(cpu_request(peak, &bare) >= peak, "{peak}");
        }
        for peak in [1.0, 100.0 * MIB + 1.0, 3.3 * GIB, 17.7 * GIB] {
            assert!(memory_request(peak, &bare) >= peak);
            assert!(memory_limit(peak, 0.0, &bare) >= peak);
        }
        // The limit never drops below the request.
        assert_eq!(memory_limit(100.0 * MIB, 512.0 * MIB, &s), 512.0 * MIB);
    }

    #[test]
    fn no_churn_unless_below_the_peak_and_change_kinds() {
        assert_eq!(settle(Some(240.0), 230.0, MIN_CPU_CHANGE, 200.0), 240.0);
        assert_eq!(settle(Some(1000.0), 140.0, MIN_CPU_CHANGE, 120.0), 140.0);
        assert_eq!(settle(None, 140.0, MIN_CPU_CHANGE, 120.0), 140.0);
        // Below the peak: always move, however small the step.
        assert_eq!(settle(Some(5.0), 15.0, MIN_CPU_CHANGE, 9.0), 15.0);
        assert_eq!(change_of(Some(1.0), Some(2.0)), Change::Increase);
        assert_eq!(change_of(Some(2.0), Some(1.0)), Change::Decrease);
        assert_eq!(change_of(Some(2.0), Some(2.0)), Change::Unchanged);
        assert_eq!(change_of(None, Some(2.0)), Change::Set);
        assert_eq!(change_of(Some(2.0), None), Change::Unchanged);
        assert_eq!(change_of(None, None), Change::Unchanged);
    }

    #[test]
    fn verdicts_and_costs() {
        let pricing = CostPricing {
            currency: "USD".into(),
            cpu_hour: 0.04,
            memory_gib_hour: 0.005,
            gpu_hour: None,
            storage_gib_month: None,
            discount_percent: 0.0,
        };
        let over = rec(
            ResourceValues {
                cpu_request: Some(1000.0),
                memory_request: Some(GIB),
                ..Default::default()
            },
            Some(usage(100.0, 200.0 * MIB)),
        );
        let containers = vec![over];
        let current = monthly_requests(&containers, 3.0, &pricing, false);
        assert!((current - 3.0 * (0.04 + 0.005) * 730.0).abs() < 1e-9);
        let recommended = monthly_requests(&containers, 3.0, &pricing, true);
        assert!(recommended < current);
        assert_eq!(verdict(&containers, current, recommended), Verdict::Over);

        let under = rec(
            ResourceValues {
                cpu_request: Some(100.0),
                memory_request: Some(128.0 * MIB),
                ..Default::default()
            },
            Some(usage(90.0, 200.0 * MIB)),
        );
        assert_eq!(verdict(&[under], 1.0, 2.0), Verdict::Under);
        let none = rec(ResourceValues::default(), None);
        assert_eq!(verdict(&[none], 0.0, 0.0), Verdict::NoData);
    }

    #[test]
    fn oom_makes_the_verdict_under() {
        let mut oom_container = rec(
            ResourceValues {
                cpu_request: Some(1000.0),
                memory_request: Some(GIB),
                ..Default::default()
            },
            Some(usage(100.0, 200.0 * MIB)),
        );
        // Without the OOM kill the halved requests make it over-provisioned.
        assert_eq!(
            verdict(std::slice::from_ref(&oom_container), 10.0, 5.0),
            Verdict::Over
        );
        oom_container
            .warnings
            .push(RecommendationWarning::new(WARN_OOM_KILLED));
        assert_eq!(verdict(&[oom_container], 10.0, 5.0), Verdict::Under);
    }

    #[test]
    fn sample_statistics_and_replica_merging() {
        let cpu: Vec<f64> = (0..240)
            .map(|i| if i % 20 == 0 { 500.0 } else { 100.0 })
            .collect();
        let mem = vec![100.0 * MIB, 180.0 * MIB, 150.0 * MIB];
        let s = stats_from_samples(&cpu, &mem, 15.0).unwrap();
        assert_eq!(s.cpu_max, 500.0);
        assert!(s.cpu_p95 >= 100.0 && s.cpu_p95 <= 500.0);
        assert_eq!(s.memory_max, 180.0 * MIB);
        assert_eq!(s.hours, 1.0);
        assert!(stats_from_samples(&[], &mem, 15.0).is_none());
        let merged = combine(&[
            s,
            UsageStats {
                cpu_p95: 900.0,
                cpu_max: 900.0,
                memory_max: 1.0,
                hours: 0.5,
                cpu_avg: None,
                memory_avg: None,
            },
        ])
        .unwrap();
        assert_eq!(merged.cpu_p95, 900.0);
        assert_eq!(merged.memory_max, 180.0 * MIB);
        assert_eq!(merged.hours, 1.5);
        assert!(combine(&[]).is_none());
        let clamped = RightsizingSettings {
            cpu_headroom_percent: f64::NAN,
            days: 90,
            ..settings()
        }
        .normalized();
        assert_eq!(clamped.cpu_headroom_percent, 15.0);
        assert_eq!(clamped.days, 30);
    }
}
