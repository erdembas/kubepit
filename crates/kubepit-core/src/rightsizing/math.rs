//! Recommendation math: percentiles, headroom, minimums and rounding.
//!
//! - CPU request = p95 of the usage + headroom (default 15 %). CPU is
//!   compressible, so the p95 of 5-minute rates is the peak that matters.
//! - Memory request = maximum working set + headroom (default 20 %); memory
//!   limit = maximum + a larger headroom (default 40 %), never below the
//!   request. Memory is not compressible, so the maximum is the peak.
//! - Values round *up* to sane steps (5 m / 10 m / 50 m / 100 m, 8 / 16 / 64 /
//!   256 MiB), never go below the minimums, and never below the observed
//!   peak — neither the recommendation nor a current value that is kept.
//! - Small differences (under 10 % or under 10 m / 16 MiB) keep the current
//!   value, so recommendations do not churn.
//! - A CPU limit below the new request is raised to it (the API server
//!   rejects requests above limits); CPU limits are otherwise left alone.

use super::types::{
    Change, Confidence, ContainerRecommendation, ResourceValues, RightsizingSettings,
    RightsizingSource, UsageStats, Verdict,
};
use crate::cost::CostPricing;

const MIB: f64 = 1024.0 * 1024.0;
const GIB: f64 = 1024.0 * MIB;
/// Relative change below which the current value is kept.
pub const MIN_RELATIVE_CHANGE: f64 = 0.10;
pub const MIN_CPU_CHANGE: f64 = 10.0;
pub const MIN_MEMORY_CHANGE: f64 = 16.0 * MIB;

impl RightsizingSettings {
    /// Clamped to sane ranges (headroom 0–300 %, 1–30 days).
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
            days: self.days.clamp(1, 30),
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

fn with_headroom(value: f64, percent: f64) -> f64 {
    value.max(0.0) * (1.0 + percent / 100.0)
}

/// Recommended CPU request for a p95 usage (never below it).
pub fn cpu_request(p95: f64, settings: &RightsizingSettings) -> f64 {
    round_up_cpu(with_headroom(p95, settings.cpu_headroom_percent))
        .max(round_up_cpu(settings.min_cpu_millicores))
        .max(round_up_cpu(p95))
}

/// Recommended memory request for a maximum working set (never below it).
pub fn memory_request(max: f64, settings: &RightsizingSettings) -> f64 {
    round_up_memory(with_headroom(max, settings.memory_headroom_percent))
        .max(round_up_memory(settings.min_memory_bytes))
        .max(round_up_memory(max))
}

/// Recommended memory limit: maximum + limit headroom, never below the request.
pub fn memory_limit(max: f64, request: f64, settings: &RightsizingSettings) -> f64 {
    round_up_memory(with_headroom(max, settings.memory_limit_headroom_percent))
        .max(request)
        .max(round_up_memory(max))
}

fn significant(current: f64, next: f64, absolute: f64) -> bool {
    let delta = (next - current).abs();
    delta >= absolute && (current <= 0.0 || delta / current >= MIN_RELATIVE_CHANGE)
}

/// Keep `current` unless the difference matters or it is below `floor`.
fn settle(current: Option<f64>, next: f64, absolute: f64, floor: f64) -> (Option<f64>, Change) {
    match current {
        None => (Some(next), Change::Set),
        Some(c) if c >= floor && !significant(c, next, absolute) => (Some(c), Change::Unchanged),
        Some(c) if next > c => (Some(next), Change::Increase),
        Some(c) if next < c => (Some(next), Change::Decrease),
        Some(c) => (Some(c), Change::Unchanged),
    }
}

/// The recommendation for one container (unchanged without usage).
pub fn recommend_container(
    name: &str,
    current: ResourceValues,
    usage: Option<UsageStats>,
    settings: &RightsizingSettings,
) -> ContainerRecommendation {
    let Some(u) = usage else {
        return ContainerRecommendation {
            name: name.to_string(),
            current,
            recommended: current,
            usage: None,
            cpu: Change::Unchanged,
            memory: Change::Unchanged,
            memory_limit: Change::Unchanged,
            cpu_limit: Change::Unchanged,
        };
    };
    let (cpu_req, cpu) = settle(
        current.cpu_request,
        cpu_request(u.cpu_p95, settings),
        MIN_CPU_CHANGE,
        u.cpu_p95,
    );
    let (mem_req, memory) = settle(
        current.memory_request,
        memory_request(u.memory_max, settings),
        MIN_MEMORY_CHANGE,
        u.memory_max,
    );
    let mem_req_value = mem_req.unwrap_or_default();
    let limit_next = memory_limit(u.memory_max, mem_req_value, settings);
    let (mut mem_lim, mut memory_limit_change) = settle(
        current.memory_limit,
        limit_next,
        MIN_MEMORY_CHANGE,
        u.memory_max,
    );
    // A kept limit must still hold the (new) request.
    if mem_lim.is_some_and(|l| l < mem_req_value) {
        mem_lim = Some(limit_next);
        memory_limit_change = Change::Increase;
    }
    let cpu_req_value = cpu_req.unwrap_or_default();
    let (cpu_lim, cpu_limit) = match current.cpu_limit {
        Some(l) if l < cpu_req_value => (Some(cpu_req_value), Change::Increase),
        other => (other, Change::Unchanged),
    };
    ContainerRecommendation {
        name: name.to_string(),
        current,
        recommended: ResourceValues {
            cpu_request: cpu_req,
            cpu_limit: cpu_lim,
            memory_request: mem_req,
            memory_limit: mem_lim,
        },
        usage: Some(u),
        cpu,
        memory,
        memory_limit: memory_limit_change,
        cpu_limit,
    }
}

impl ContainerRecommendation {
    pub fn changed(&self) -> bool {
        [self.cpu, self.memory, self.memory_limit, self.cpu_limit]
            .iter()
            .any(|c| *c != Change::Unchanged)
    }
}

/// How much to trust recommendations from `source` backed by `hours` of history.
pub fn confidence(source: RightsizingSource, hours: f64) -> Confidence {
    match source {
        RightsizingSource::Prometheus if hours >= 72.0 => Confidence::High,
        RightsizingSource::Prometheus if hours >= 12.0 => Confidence::Medium,
        _ => Confidence::Low,
    }
}

/// Requests of all replicas per month.
pub fn monthly_requests(
    containers: &[ContainerRecommendation],
    replicas: u32,
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
        * f64::from(replicas)
}

/// Over- or under-provisioned, from the containers' usage and requests.
pub fn verdict(containers: &[ContainerRecommendation], current: f64, recommended: f64) -> Verdict {
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
    })
}

/// Worst replica wins: the largest p95, maximum and memory of `stats`;
/// hours add up (the caller divides by the replica count).
pub fn combine(stats: &[UsageStats]) -> Option<UsageStats> {
    let mut iter = stats.iter();
    let first = *iter.next()?;
    Some(iter.fold(first, |acc, s| UsageStats {
        cpu_p95: acc.cpu_p95.max(s.cpu_p95),
        cpu_max: acc.cpu_max.max(s.cpu_max),
        memory_max: acc.memory_max.max(s.memory_max),
        hours: acc.hours + s.hours,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> RightsizingSettings {
        RightsizingSettings::default()
    }

    fn usage(cpu_p95: f64, memory_max: f64) -> UsageStats {
        UsageStats {
            cpu_p95,
            cpu_max: cpu_p95 * 1.5,
            memory_max,
            hours: 168.0,
        }
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
            days: 7,
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
    fn over_provisioned_containers_shrink() {
        let current = ResourceValues {
            cpu_request: Some(1000.0),
            cpu_limit: None,
            memory_request: Some(2.0 * GIB),
            memory_limit: Some(2.0 * GIB),
        };
        let r = recommend_container("app", current, Some(usage(120.0, 300.0 * MIB)), &settings());
        assert_eq!(r.cpu, Change::Decrease);
        assert_eq!(r.recommended.cpu_request, Some(140.0));
        assert_eq!(r.memory, Change::Decrease);
        assert_eq!(r.recommended.memory_request, Some(368.0 * MIB));
        assert_eq!(r.memory_limit, Change::Decrease);
        assert_eq!(r.recommended.memory_limit, Some(432.0 * MIB));
        assert_eq!(r.cpu_limit, Change::Unchanged);
        assert!(r.changed());
    }

    #[test]
    fn under_provisioned_containers_grow_and_limits_follow() {
        let current = ResourceValues {
            cpu_request: Some(100.0),
            cpu_limit: Some(200.0),
            memory_request: Some(128.0 * MIB),
            memory_limit: Some(256.0 * MIB),
        };
        let r = recommend_container("app", current, Some(usage(400.0, 250.0 * MIB)), &settings());
        assert_eq!(r.cpu, Change::Increase);
        assert_eq!(r.recommended.cpu_request, Some(460.0));
        assert_eq!(
            r.cpu_limit,
            Change::Increase,
            "a limit below the request is raised"
        );
        assert_eq!(r.recommended.cpu_limit, Some(460.0));
        assert_eq!(r.memory, Change::Increase);
        assert_eq!(r.recommended.memory_request, Some(304.0 * MIB));
        assert_eq!(r.memory_limit, Change::Increase);
        assert!(r.recommended.memory_limit.unwrap() >= r.recommended.memory_request.unwrap());
    }

    #[test]
    fn small_differences_keep_current_values_unless_below_the_peak() {
        let current = ResourceValues {
            cpu_request: Some(240.0),
            cpu_limit: None,
            memory_request: Some(320.0 * MIB),
            memory_limit: None,
        };
        let r = recommend_container("app", current, Some(usage(200.0, 260.0 * MIB)), &settings());
        assert_eq!(r.cpu, Change::Unchanged, "230m vs 240m");
        assert_eq!(r.recommended.cpu_request, Some(240.0));
        assert_eq!(r.memory, Change::Unchanged);
        assert_eq!(r.memory_limit, Change::Set, "a missing limit is proposed");
        // A tiny request below the observed p95 always changes, however small the step.
        let tiny = ResourceValues {
            cpu_request: Some(5.0),
            memory_request: Some(20.0 * MIB),
            ..Default::default()
        };
        let r = recommend_container("app", tiny, Some(usage(9.0, 24.0 * MIB)), &settings());
        assert_eq!(r.cpu, Change::Increase);
        assert!(r.recommended.cpu_request.unwrap() >= 9.0);
        assert_eq!(r.memory, Change::Increase);
        assert!(r.recommended.memory_request.unwrap() >= 24.0 * MIB);
        // Without usage nothing changes.
        let r = recommend_container("app", current, None, &settings());
        assert!(!r.changed());
        assert_eq!(r.recommended, current);
    }

    #[test]
    fn verdicts_confidence_and_costs() {
        let pricing = CostPricing {
            currency: "USD".into(),
            cpu_hour: 0.04,
            memory_gib_hour: 0.005,
            gpu_hour: None,
            storage_gib_month: None,
            discount_percent: 0.0,
        };
        let over = recommend_container(
            "app",
            ResourceValues {
                cpu_request: Some(1000.0),
                memory_request: Some(GIB),
                ..Default::default()
            },
            Some(usage(100.0, 200.0 * MIB)),
            &settings(),
        );
        let containers = vec![over];
        let current = monthly_requests(&containers, 3, &pricing, false);
        assert!((current - 3.0 * (0.04 + 0.005) * 730.0).abs() < 1e-9);
        let recommended = monthly_requests(&containers, 3, &pricing, true);
        assert!(recommended < current);
        assert_eq!(verdict(&containers, current, recommended), Verdict::Over);

        let under = recommend_container(
            "app",
            ResourceValues {
                cpu_request: Some(100.0),
                memory_request: Some(128.0 * MIB),
                ..Default::default()
            },
            Some(usage(90.0, 200.0 * MIB)),
            &settings(),
        );
        assert_eq!(verdict(&[under], 1.0, 2.0), Verdict::Under);
        let none = recommend_container("app", ResourceValues::default(), None, &settings());
        assert_eq!(verdict(&[none], 0.0, 0.0), Verdict::NoData);

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
