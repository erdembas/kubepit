//! Lenses, risk scores and run summaries of right-sizing reports (spec
//! §6.9), computed in Rust so the UI, stored scans and exports agree.
//!
//! - [`lenses_of`]: the quick-focus groups of a workload (KubeFit's lens
//!   semantics mapped onto Kubepit's change kinds).
//! - [`risk_score`]: how urgently an under-provisioned workload needs
//!   attention; OOM kills first, then usage ÷ request.
//! - [`one_click_eligible`]: the backend half of the one-click apply rule
//!   (high confidence, a change, no raised limit); the UI adds the cluster
//!   conditions (not production, writable, RBAC).
//! - [`summarize`]: the totals, counts and spotlight of one run.

use std::cmp::Ordering;
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::strategy::WARN_OOM_KILLED;
use super::types::{
    Change, Confidence, ContainerRecommendation, RecommendationLens, RightsizingReport, Verdict,
    WorkloadRecommendation,
};

/// Entries per kind (under-provisioned, savings) in [`RecommendationSummary::top`].
pub const TOP_PER_KIND: usize = 5;

/// Current vs. recommended requests (× `cost_replicas`) of one resource.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResourceTotals {
    /// Σ current requests × cost replicas over comparable containers
    /// (millicores or bytes).
    pub current: f64,
    /// Σ recommended requests × cost replicas over the same containers.
    pub recommended: f64,
    /// Containers with a current request and usage behind the recommendation.
    pub comparable: u32,
    /// Containers without a current request.
    pub unset: u32,
}

/// A workload of the review spotlight.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SummaryEntry {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub verdict: Verdict,
    pub confidence: Confidence,
    pub monthly_delta: f64,
    /// Recommended − current CPU requests × cost replicas (millicores).
    pub cpu_delta: f64,
    /// Recommended − current memory requests × cost replicas (bytes).
    pub memory_delta: f64,
}

/// Totals, counts and the spotlight of one successful run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RecommendationSummary {
    pub workloads: u32,
    pub containers: u32,
    pub namespaces: u32,
    pub over: u32,
    pub under: u32,
    pub balanced: u32,
    pub no_data: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub changed: u32,
    /// High-confidence changed workloads without a raised limit.
    pub one_click: u32,
    pub cpu: ResourceTotals,
    pub memory: ResourceTotals,
    /// Σ current requests per month, in `currency`.
    pub monthly_current: f64,
    /// Σ savings of changed workloads per month (a positive number).
    pub monthly_savings: f64,
    /// Σ increases of changed workloads per month.
    pub monthly_increases: f64,
    pub currency: String,
    /// At most [`TOP_PER_KIND`] under-provisioned workloads (confidence ≥
    /// medium) by risk, then at most as many high-confidence over-provisioned
    /// ones by saving.
    pub top: Vec<SummaryEntry>,
}

fn has_warning(c: &ContainerRecommendation, code: &str) -> bool {
    c.warnings.iter().any(|w| w.code == code)
}

fn is_increase(change: Change) -> bool {
    matches!(change, Change::Increase | Change::Set)
}

/// The lenses of a workload, in declaration order (spec §6.9).
pub fn lenses_of(rec: &WorkloadRecommendation) -> Vec<RecommendationLens> {
    let any = |f: &dyn Fn(&ContainerRecommendation) -> bool| rec.containers.iter().any(f);
    let rules: [(RecommendationLens, bool); 7] = [
        (
            RecommendationLens::CpuReduction,
            any(&|c| c.cpu == Change::Decrease),
        ),
        (
            RecommendationLens::MemoryReduction,
            any(&|c| c.memory == Change::Decrease),
        ),
        (
            RecommendationLens::Increase,
            any(&|c| is_increase(c.cpu) || is_increase(c.memory)),
        ),
        (
            RecommendationLens::RequestUnset,
            any(&|c| c.current.cpu_request.is_none() || c.current.memory_request.is_none()),
        ),
        (
            RecommendationLens::MissingData,
            rec.verdict == Verdict::NoData || any(&|c| c.usage.is_none()),
        ),
        (
            RecommendationLens::NeedsReview,
            rec.changed && rec.confidence != Confidence::High,
        ),
        (
            RecommendationLens::LimitRaised,
            any(&|c| c.cpu_limit_raised || c.memory_limit_raised),
        ),
    ];
    rules
        .into_iter()
        .filter_map(|(lens, applies)| applies.then_some(lens))
        .collect()
}

/// How urgently a workload needs more resources: `+∞` when a container was
/// OOM-killed, else the largest `memory_max ÷ memory request` or
/// `cpu_p95 ÷ cpu request` over the containers with usage (a missing
/// request counts as 2); 0 without usage.
pub fn risk_score(rec: &WorkloadRecommendation) -> f64 {
    let ratio = |used: f64, request: Option<f64>| match request {
        Some(r) if r > 0.0 => used / r,
        _ => 2.0,
    };
    rec.containers
        .iter()
        .map(|c| {
            if has_warning(c, WARN_OOM_KILLED) {
                return f64::INFINITY;
            }
            let Some(u) = c.usage else { return 0.0 };
            ratio(u.memory_max, c.current.memory_request)
                .max(ratio(u.cpu_p95, c.current.cpu_request))
        })
        .fold(0.0, f64::max)
}

/// High confidence, at least one change and no limit raised with its
/// request: the backend half of the one-click apply rule.
pub fn one_click_eligible(rec: &WorkloadRecommendation) -> bool {
    rec.confidence == Confidence::High
        && rec.changed
        && !rec
            .containers
            .iter()
            .any(|c| c.cpu_limit_raised || c.memory_limit_raised)
}

/// Adds one container's request to `totals` (comparable only with a
/// current request and usage behind the recommendation). Returns the
/// recommended − current delta × `replicas` it added.
fn add(
    totals: &mut ResourceTotals,
    current: Option<f64>,
    recommended: Option<f64>,
    has_usage: bool,
    replicas: f64,
) -> f64 {
    let Some(cur) = current else {
        totals.unset += 1;
        return 0.0;
    };
    if !has_usage {
        return 0.0;
    }
    let next = recommended.unwrap_or(cur);
    totals.current += cur * replicas;
    totals.recommended += next * replicas;
    totals.comparable += 1;
    (next - cur) * replicas
}

fn by_name(a: &WorkloadRecommendation, b: &WorkloadRecommendation) -> Ordering {
    a.namespace
        .cmp(&b.namespace)
        .then_with(|| a.name.cmp(&b.name))
}

/// The summary of one report (spec §6.9).
pub fn summarize(report: &RightsizingReport) -> RecommendationSummary {
    let mut s = RecommendationSummary {
        currency: report.currency.clone(),
        ..Default::default()
    };
    let mut namespaces = BTreeSet::new();
    let mut deltas = Vec::with_capacity(report.workloads.len());
    for w in &report.workloads {
        s.workloads += 1;
        namespaces.insert(w.namespace.as_str());
        match w.verdict {
            Verdict::Over => s.over += 1,
            Verdict::Under => s.under += 1,
            Verdict::Balanced => s.balanced += 1,
            Verdict::NoData => s.no_data += 1,
        }
        match w.confidence {
            Confidence::High => s.high += 1,
            Confidence::Medium => s.medium += 1,
            Confidence::Low => s.low += 1,
        }
        if w.changed {
            s.changed += 1;
            if w.monthly_delta < 0.0 {
                s.monthly_savings -= w.monthly_delta;
            } else {
                s.monthly_increases += w.monthly_delta;
            }
        }
        if one_click_eligible(w) {
            s.one_click += 1;
        }
        s.monthly_current += w.monthly_current;
        let (mut cpu_delta, mut memory_delta) = (0.0, 0.0);
        for c in &w.containers {
            s.containers += 1;
            let has_usage = c.usage.is_some();
            cpu_delta += add(
                &mut s.cpu,
                c.current.cpu_request,
                c.recommended.cpu_request,
                has_usage,
                w.cost_replicas,
            );
            memory_delta += add(
                &mut s.memory,
                c.current.memory_request,
                c.recommended.memory_request,
                has_usage,
                w.cost_replicas,
            );
        }
        deltas.push((cpu_delta, memory_delta));
    }
    s.namespaces = u32::try_from(namespaces.len()).unwrap_or(u32::MAX);

    let entry = |i: usize| {
        let w = &report.workloads[i];
        SummaryEntry {
            kind: w.kind.clone(),
            namespace: w.namespace.clone(),
            name: w.name.clone(),
            verdict: w.verdict,
            confidence: w.confidence,
            monthly_delta: w.monthly_delta,
            cpu_delta: deltas[i].0,
            memory_delta: deltas[i].1,
        }
    };
    let workloads = &report.workloads;
    let mut under: Vec<(usize, f64)> = workloads
        .iter()
        .enumerate()
        .filter(|(_, w)| w.verdict == Verdict::Under && w.confidence >= Confidence::Medium)
        .map(|(i, w)| (i, risk_score(w)))
        .collect();
    under.sort_by(|(a, ra), (b, rb)| {
        rb.partial_cmp(ra)
            .unwrap_or(Ordering::Equal)
            .then_with(|| by_name(&workloads[*a], &workloads[*b]))
    });
    let mut over: Vec<usize> = workloads
        .iter()
        .enumerate()
        .filter(|(_, w)| w.verdict == Verdict::Over && w.confidence == Confidence::High)
        .map(|(i, _)| i)
        .collect();
    over.sort_by(|a, b| {
        let (wa, wb) = (&workloads[*a], &workloads[*b]);
        wa.monthly_delta
            .partial_cmp(&wb.monthly_delta)
            .unwrap_or(Ordering::Equal)
            .then_with(|| by_name(wa, wb))
    });
    s.top = under
        .into_iter()
        .map(|(i, _)| i)
        .take(TOP_PER_KIND)
        .chain(over.into_iter().take(TOP_PER_KIND))
        .map(entry)
        .collect();
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::CostPricing;
    use crate::rightsizing::math::{change_of, GIB, MIB};
    use crate::rightsizing::types::{
        RecommendationWarning, ResourceValues, RightsizingSettings, RightsizingSource, UsageStats,
    };

    type Pair = (Option<f64>, Option<f64>);

    /// A container: current (cpu, memory) requests, recommended ones
    /// (`None` = unchanged) and usage (cpu p95, memory max).
    fn container(cur: Pair, rec: Pair, usage: Option<(f64, f64)>) -> ContainerRecommendation {
        let current = ResourceValues {
            cpu_request: cur.0,
            memory_request: cur.1,
            ..Default::default()
        };
        let recommended = ResourceValues {
            cpu_request: rec.0.or(cur.0),
            memory_request: rec.1.or(cur.1),
            ..Default::default()
        };
        ContainerRecommendation {
            name: "app".into(),
            current,
            recommended,
            usage: usage.map(|(cpu_p95, memory_max)| UsageStats {
                cpu_p95,
                cpu_max: cpu_p95,
                memory_max,
                hours: 168.0,
                ..Default::default()
            }),
            cpu: change_of(current.cpu_request, recommended.cpu_request),
            memory: change_of(current.memory_request, recommended.memory_request),
            memory_limit: Change::Unchanged,
            cpu_limit: Change::Unchanged,
            confidence: Confidence::High,
            warnings: Vec::new(),
            cpu_limit_raised: false,
            memory_limit_raised: false,
            evidence: None,
        }
    }

    /// `(kind, namespace, name)` and the rest of a workload recommendation.
    fn workload(
        (kind, namespace, name): (&str, &str, &str),
        verdict: Verdict,
        confidence: Confidence,
        cost_replicas: f64,
        containers: Vec<ContainerRecommendation>,
        monthly_delta: f64,
    ) -> WorkloadRecommendation {
        WorkloadRecommendation {
            kind: kind.into(),
            namespace: namespace.into(),
            name: name.into(),
            uid: String::new(),
            replicas: cost_replicas.ceil() as u32,
            confidence,
            verdict,
            coverage_hours: 168.0,
            changed: containers.iter().any(ContainerRecommendation::changed),
            monthly_delta,
            monthly_current: 40.0,
            containers,
            pods: Vec::new(),
            pods_truncated: false,
            hpa: None,
            lenses: Vec::new(),
            cost_replicas,
        }
    }

    fn deployment(
        name: &str,
        verdict: Verdict,
        confidence: Confidence,
        c: ContainerRecommendation,
    ) -> WorkloadRecommendation {
        workload(
            ("Deployment", "shop", name),
            verdict,
            confidence,
            1.0,
            vec![c],
            0.0,
        )
    }

    fn shrinking() -> WorkloadRecommendation {
        deployment(
            "shrink",
            Verdict::Over,
            Confidence::High,
            container(
                (Some(1000.0), Some(GIB)),
                (Some(200.0), Some(256.0 * MIB)),
                Some((150.0, 200.0 * MIB)),
            ),
        )
    }

    fn growing_with_raise() -> WorkloadRecommendation {
        let mut c = container(
            (Some(100.0), Some(128.0 * MIB)),
            (Some(400.0), Some(256.0 * MIB)),
            Some((350.0, 220.0 * MIB)),
        );
        c.cpu_limit_raised = true;
        c.cpu_limit = Change::Increase;
        deployment("grow", Verdict::Under, Confidence::Medium, c)
    }

    fn unset_request() -> WorkloadRecommendation {
        deployment(
            "unset",
            Verdict::Under,
            Confidence::High,
            container(
                (None, Some(256.0 * MIB)),
                (Some(100.0), None),
                Some((80.0, 200.0 * MIB)),
            ),
        )
    }

    fn no_usage() -> WorkloadRecommendation {
        deployment(
            "quiet",
            Verdict::NoData,
            Confidence::Low,
            container((Some(100.0), Some(128.0 * MIB)), (None, None), None),
        )
    }

    fn medium_changed() -> WorkloadRecommendation {
        WorkloadRecommendation {
            confidence: Confidence::Medium,
            ..shrinking()
        }
    }

    fn unchanged_high() -> WorkloadRecommendation {
        deployment(
            "steady",
            Verdict::Balanced,
            Confidence::High,
            container(
                (Some(100.0), Some(128.0 * MIB)),
                (None, None),
                Some((90.0, 110.0 * MIB)),
            ),
        )
    }

    fn oom() -> WorkloadRecommendation {
        let mut c = container(
            (Some(1000.0), Some(GIB)),
            (None, None),
            Some((10.0, 10.0 * MIB)),
        );
        c.warnings.push(RecommendationWarning::new(WARN_OOM_KILLED));
        deployment("oom", Verdict::Under, Confidence::Medium, c)
    }

    fn memory_twice_request() -> WorkloadRecommendation {
        deployment(
            "twice",
            Verdict::Under,
            Confidence::Medium,
            container(
                (Some(1000.0), Some(128.0 * MIB)),
                (None, Some(320.0 * MIB)),
                Some((100.0, 256.0 * MIB)),
            ),
        )
    }

    fn web_3_replicas() -> WorkloadRecommendation {
        workload(
            ("Deployment", "shop", "web"),
            Verdict::Over,
            Confidence::High,
            3.0,
            vec![container(
                (Some(1000.0), Some(GIB)),
                (Some(200.0), Some(256.0 * MIB)),
                Some((150.0, 200.0 * MIB)),
            )],
            -30.0,
        )
    }

    fn nightly_quarter_duty() -> WorkloadRecommendation {
        workload(
            ("CronJob", "batch", "nightly"),
            Verdict::Over,
            Confidence::Medium,
            0.25,
            vec![container(
                (Some(500.0), Some(512.0 * MIB)),
                (Some(300.0), None),
                Some((200.0, 300.0 * MIB)),
            )],
            -1.0,
        )
    }

    fn hot_under() -> WorkloadRecommendation {
        workload(
            ("Deployment", "shop", "hot"),
            Verdict::Under,
            Confidence::Medium,
            1.0,
            vec![container(
                (Some(200.0), Some(256.0 * MIB)),
                (Some(500.0), Some(512.0 * MIB)),
                Some((450.0, 400.0 * MIB)),
            )],
            5.0,
        )
    }

    fn report_of(workloads: Vec<WorkloadRecommendation>) -> RightsizingReport {
        RightsizingReport {
            source: RightsizingSource::Prometheus,
            window_secs: 7 * 86_400,
            settings: RightsizingSettings::default(),
            currency: "USD".into(),
            pricing: CostPricing {
                currency: "USD".into(),
                cpu_hour: 0.04,
                memory_gib_hour: 0.005,
                gpu_hour: None,
                storage_gib_month: None,
                discount_percent: 0.0,
            },
            workloads,
            notes: Vec::new(),
            strategy: "workload-history".into(),
            strategies: Vec::new(),
            computed_at: 0,
            strategy_auto: true,
            window_end: 0,
        }
    }

    #[test]
    fn lenses_follow_kubefit_semantics() {
        assert_eq!(
            lenses_of(&shrinking()),
            vec![
                RecommendationLens::CpuReduction,
                RecommendationLens::MemoryReduction
            ]
        );
        let grow = lenses_of(&growing_with_raise());
        assert!(grow.contains(&RecommendationLens::LimitRaised));
        assert!(grow.contains(&RecommendationLens::Increase));
        let unset = lenses_of(&unset_request());
        assert!(unset.contains(&RecommendationLens::RequestUnset));
        assert!(
            unset.contains(&RecommendationLens::Increase),
            "set counts as an increase"
        );
        assert!(lenses_of(&no_usage()).contains(&RecommendationLens::MissingData));
        assert!(lenses_of(&medium_changed()).contains(&RecommendationLens::NeedsReview));
        assert!(!lenses_of(&unchanged_high()).contains(&RecommendationLens::NeedsReview));
        assert!(lenses_of(&unchanged_high()).is_empty());
        // Unchanged and not high: nothing to review.
        assert!(!lenses_of(&no_usage()).contains(&RecommendationLens::NeedsReview));
    }

    #[test]
    fn risk_orders_oom_first_then_ratio() {
        assert!(risk_score(&oom()) > risk_score(&memory_twice_request()));
        assert_eq!(risk_score(&oom()), f64::INFINITY);
        assert_eq!(risk_score(&memory_twice_request()), 2.0);
        // A missing request counts as 2; no usage scores nothing.
        assert_eq!(risk_score(&unset_request()), 2.0);
        assert_eq!(risk_score(&no_usage()), 0.0);
    }

    #[test]
    fn one_click_needs_high_confidence_a_change_and_no_raised_limit() {
        assert!(one_click_eligible(&shrinking()));
        assert!(!one_click_eligible(&medium_changed()));
        assert!(!one_click_eligible(&unchanged_high()));
        let mut raised = shrinking();
        raised.containers[0].memory_limit_raised = true;
        assert!(!one_click_eligible(&raised));
    }

    #[test]
    fn summary_totals_use_cost_replicas_and_pick_the_top() {
        let s = summarize(&report_of(vec![
            web_3_replicas(),
            nightly_quarter_duty(),
            hot_under(),
        ]));
        assert_eq!(s.cpu.current, 3.0 * 1000.0 + 0.25 * 500.0 + 200.0);
        assert_eq!((s.top[0].name.as_str(), s.one_click), ("hot", 1));
        assert_eq!(s.cpu.recommended, 3.0 * 200.0 + 0.25 * 300.0 + 500.0);
        assert_eq!(
            s.memory.current,
            3.0 * GIB + 0.25 * 512.0 * MIB + 256.0 * MIB
        );
        assert_eq!((s.cpu.comparable, s.cpu.unset), (3, 0));
        assert_eq!((s.workloads, s.containers, s.namespaces), (3, 3, 2));
        assert_eq!((s.over, s.under, s.balanced, s.no_data), (2, 1, 0, 0));
        assert_eq!((s.high, s.medium, s.low, s.changed), (1, 2, 0, 3));
        assert_eq!((s.monthly_savings, s.monthly_increases), (31.0, 5.0));
        assert_eq!(s.monthly_current, 120.0);
        assert_eq!(s.currency, "USD");
        // Under first (confidence ≥ medium), then high-confidence savings;
        // the medium-confidence nightly job is not a spotlight saving.
        let names: Vec<&str> = s.top.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["hot", "web"]);
        let web = &s.top[1];
        assert_eq!(
            (web.cpu_delta, web.monthly_delta),
            (3.0 * (200.0 - 1000.0), -30.0)
        );
        assert_eq!(web.memory_delta, 3.0 * (256.0 * MIB - GIB));
    }

    #[test]
    fn summary_counts_unset_requests_and_skips_containers_without_usage() {
        let s = summarize(&report_of(vec![unset_request(), no_usage()]));
        // The unset CPU request is not comparable; the container without usage is not either.
        assert_eq!((s.cpu.comparable, s.cpu.unset), (0, 1));
        assert_eq!((s.memory.comparable, s.memory.unset), (1, 0));
        assert_eq!(s.memory.current, 256.0 * MIB);
        assert_eq!(s.no_data, 1);
    }

    #[test]
    fn top_is_capped_and_ties_break_by_namespace_then_name() {
        let under = |ns: &str, name: &str| {
            workload(
                ("Deployment", ns, name),
                Verdict::Under,
                Confidence::Medium,
                1.0,
                vec![container(
                    (Some(100.0), Some(128.0 * MIB)),
                    (None, Some(320.0 * MIB)),
                    Some((50.0, 256.0 * MIB)),
                )],
                1.0,
            )
        };
        let mut list: Vec<WorkloadRecommendation> = ["f", "e", "d", "c", "b", "a"]
            .iter()
            .map(|n| under("b-ns", n))
            .collect();
        list.push(under("a-ns", "z"));
        // Low confidence never reaches the spotlight.
        list.push(WorkloadRecommendation {
            confidence: Confidence::Low,
            ..oom()
        });
        let s = summarize(&report_of(list));
        let names: Vec<&str> = s.top.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["z", "a", "b", "c", "d"]);
        assert_eq!(TOP_PER_KIND, 5);
    }
}
