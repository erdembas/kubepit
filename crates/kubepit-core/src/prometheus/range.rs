//! Time ranges of range queries: automatic step, rate windows, alignment.
//!
//! Charts want about [`TARGET_POINTS`] points whatever the range (the
//! metrics-server history has 240 over an hour), on round steps so axis
//! ticks and consecutive refreshes line up. Prometheus rejects queries
//! above [`MAX_POINTS`] points per series, so explicit steps are raised to
//! stay under it.

use anyhow::{bail, Result};

use crate::types::PrometheusRange;

/// Points per series an automatic step aims for.
pub const TARGET_POINTS: u64 = 240;
/// Prometheus' own limit (`exceeded maximum resolution of 11,000 points`).
pub const MAX_POINTS: u64 = 11_000;
/// Smallest automatic step: one common scrape interval.
pub const MIN_STEP_SECS: u64 = 15;
/// Scrape interval assumed for rate windows (kube-prometheus-stack: 30 s).
pub const SCRAPE_SECS: u64 = 30;
/// Longest range a query may cover.
pub const MAX_RANGE_SECS: u64 = 400 * 86_400;

/// Round steps, in seconds.
const NICE_STEPS: [u64; 14] = [
    15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400,
];

/// The smallest round step giving at most [`TARGET_POINTS`] points.
pub fn auto_step(range_secs: u64) -> u64 {
    let raw = range_secs.div_ceil(TARGET_POINTS).max(MIN_STEP_SECS);
    NICE_STEPS
        .iter()
        .copied()
        .find(|&step| step >= raw)
        .unwrap_or_else(|| raw.div_ceil(86_400) * 86_400)
}

/// `requested` (or the automatic step), raised so the range stays under
/// [`MAX_POINTS`] points.
pub fn effective_step(range_secs: u64, requested: Option<u64>) -> u64 {
    let step = requested
        .filter(|&s| s > 0)
        .unwrap_or_else(|| auto_step(range_secs));
    step.max(range_secs.div_ceil(MAX_POINTS)).max(1)
}

/// Window of `rate()` / `increase()`: at least four scrapes, and at least
/// one step plus a scrape so no sample falls between two evaluations
/// (Grafana's `$__rate_interval`).
pub fn rate_window(step_secs: u64) -> u64 {
    (step_secs + SCRAPE_SECS).max(4 * SCRAPE_SECS)
}

/// A validated query range in seconds: start aligned down to the step so
/// consecutive refreshes evaluate at the same timestamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub start_secs: i64,
    pub end_secs: i64,
    pub step_secs: u64,
}

impl Window {
    pub fn new(range: &PrometheusRange) -> Result<Self> {
        if range.end <= range.start {
            bail!("the time range is empty (end must be after start)");
        }
        let start = range.start.div_euclid(1000);
        let end = range.end.div_euclid(1000).max(start + 1);
        let span = (end - start) as u64;
        if span > MAX_RANGE_SECS {
            bail!("the time range is too long (at most 400 days)");
        }
        let step = effective_step(span, range.step);
        let aligned = start.div_euclid(step as i64) * step as i64;
        Ok(Self {
            start_secs: aligned,
            end_secs: end,
            step_secs: step,
        })
    }

    pub fn start_ms(&self) -> i64 {
        self.start_secs * 1000
    }

    pub fn end_ms(&self) -> i64 {
        self.end_secs * 1000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600;
    const DAY: u64 = 86_400;

    #[test]
    fn auto_step_picks_round_steps_near_240_points() {
        assert_eq!(auto_step(HOUR), 15);
        assert_eq!(auto_step(6 * HOUR), 120);
        assert_eq!(auto_step(24 * HOUR), 600);
        assert_eq!(auto_step(7 * DAY), 3_600);
        assert_eq!(auto_step(30 * DAY), 10_800);
        // Tiny ranges never go below one scrape interval.
        assert_eq!(auto_step(60), 15);
        assert_eq!(auto_step(0), 15);
        // Beyond the table: whole days.
        assert_eq!(auto_step(400 * DAY), 2 * DAY);
        for range in [HOUR, 6 * HOUR, 24 * HOUR, 7 * DAY] {
            assert!(range / auto_step(range) <= TARGET_POINTS);
        }
    }

    #[test]
    fn explicit_steps_are_kept_unless_they_exceed_the_point_limit() {
        assert_eq!(effective_step(HOUR, Some(5)), 5);
        assert_eq!(effective_step(HOUR, None), 15);
        assert_eq!(effective_step(HOUR, Some(0)), 15, "0 = automatic");
        // 7 days at 1 s would be 604 800 points.
        let step = effective_step(7 * DAY, Some(1));
        assert_eq!(step, (7 * DAY).div_ceil(MAX_POINTS));
        assert!(7 * DAY / step <= MAX_POINTS);
    }

    #[test]
    fn rate_window_covers_four_scrapes_and_one_step() {
        assert_eq!(rate_window(15), 120);
        assert_eq!(rate_window(120), 150);
        assert_eq!(rate_window(3_600), 3_630);
    }

    #[test]
    fn window_aligns_start_and_validates() {
        let w = Window::new(&PrometheusRange {
            start: 1_700_000_007_500,
            end: 1_700_003_607_500,
            step: None,
        })
        .unwrap();
        assert_eq!(w.step_secs, 15);
        assert_eq!(w.start_secs % 15, 0);
        assert!(w.start_secs <= 1_700_000_007);
        assert_eq!(w.end_secs, 1_700_003_607);
        assert_eq!(w.start_ms(), w.start_secs * 1000);

        let empty = PrometheusRange {
            start: 10,
            end: 10,
            step: None,
        };
        assert!(Window::new(&empty).is_err());
        let huge = PrometheusRange {
            start: 0,
            end: (MAX_RANGE_SECS as i64 + 10) * 1000,
            step: None,
        };
        assert!(Window::new(&huge).is_err());
    }
}
