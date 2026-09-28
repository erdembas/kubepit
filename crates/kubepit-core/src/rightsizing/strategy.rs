//! Recommendation strategies: the only place recommendation math lives.
//!
//! A strategy turns one container's usage statistics plus its current
//! requests / limits into recommended values, a confidence and warnings
//! ([`RecommendationStrategy::recommend`]). Everything around it is shared
//! and strategy-independent:
//!
//! - fetching usage ([`crate::prometheus::usage`], the metrics-server
//!   fallback in [`super`]) produces [`UsageStats`] before any strategy runs;
//! - [`finalize`] fills values the strategy left alone, raises limits that
//!   a new request would exceed — proportionally, keeping the current
//!   limit ÷ request ratio — and derives the change kinds;
//! - the report, the patch ([`super::patch`]), the apply flow and the UI
//!   only see [`ContainerRecommendation`]s.
//!
//! Adding a strategy = implementing the trait and listing it in
//! [`STRATEGIES`]; the UI offers every strategy the report lists.

use anyhow::{bail, Result};

use super::math::{change_of, round_up_cpu, round_up_memory};
use super::percentile::PercentileHeadroom;
use super::types::{
    Change, Confidence, ContainerRecommendation, EvidenceIdentity, HpaInfo, HpaResource,
    RecommendationWarning, ResourceValues, RightsizingSettings, RightsizingSource,
    RightsizingStrategyInfo, UsageEvidence, UsageStats,
};
use super::workload_history::{WorkloadHistory, WORKLOAD_HISTORY_ID};

/// Id of the strategy used when a request names none.
pub const DEFAULT_STRATEGY_ID: &str = "percentile-headroom";

/// Warning codes [`finalize`] adds.
pub const WARN_CPU_LIMIT_RAISED: &str = "cpu-limit-raised";
pub const WARN_MEMORY_LIMIT_RAISED: &str = "memory-limit-raised";

/// Warning codes [`apply_evidence`] adds (spec §6.7), with their caps.
/// A pod name belonged to more than one owner (cap: low).
pub const WARN_IDENTITY_UNCLEAR: &str = "identity-unclear";
/// Fewer observed hours than `min_hours` (detail: whole hours; cap: low).
pub const WARN_INSUFFICIENT_HISTORY: &str = "insufficient-history";
/// CPU or memory coverage below `min_coverage` (detail: whole %; cap: low).
pub const WARN_LOW_COVERAGE: &str = "low-coverage";
/// Part of the usage queries failed or warned (cap: medium).
pub const WARN_PARTIAL_DATA: &str = "partial-data";
/// An HPA scales the workload (detail: its name; cap: medium).
pub const WARN_HPA_TARGET: &str = "hpa-target";
/// The HPA scales on the utilization of a request that changes
/// (detail: `cpu 70%`; cap: medium).
pub const WARN_HPA_UTILIZATION: &str = "hpa-utilization";
/// A pod was OOM-killed within the window (cap: medium).
pub const WARN_OOM_KILLED: &str = "oom-killed";
/// Throttled CFS periods at or above the threshold (detail: % with one
/// decimal; cap: medium).
pub const WARN_CPU_THROTTLED: &str = "cpu-throttled";
/// Pods were tied to the workload by name (cap: medium).
pub const WARN_IDENTITY_BY_NAME: &str = "identity-by-name";

/// What a strategy sees of one container.
#[derive(Debug, Clone, Copy)]
pub struct ContainerInput<'a> {
    pub name: &'a str,
    /// Requests and limits of the pod template (`None` = not set).
    pub current: ResourceValues,
    /// Worst-replica usage over the history window (`None` = no data).
    pub usage: Option<UsageStats>,
    /// Where the usage came from (how much to trust it).
    pub source: RightsizingSource,
    pub settings: &'a RightsizingSettings,
    /// How far the usage can be trusted (`None` = no evidence collected).
    pub evidence: Option<&'a UsageEvidence>,
    /// The HPA that scales the workload.
    pub hpa: Option<&'a HpaInfo>,
}

/// What a strategy recommends for one container.
#[derive(Debug, Clone, PartialEq)]
pub struct StrategyOutput {
    /// New values; `None` = leave the current value as it is. Limits may be
    /// left alone: [`finalize`] raises any the new requests would exceed.
    pub recommended: ResourceValues,
    pub confidence: Confidence,
    pub warnings: Vec<RecommendationWarning>,
}

/// A way to turn usage into requests and limits.
pub trait RecommendationStrategy: Send + Sync {
    fn info(&self) -> RightsizingStrategyInfo;
    fn recommend(&self, input: &ContainerInput<'_>) -> StrategyOutput;
}

/// Every strategy the backend offers; the first is the default.
pub static STRATEGIES: &[&dyn RecommendationStrategy] = &[&PercentileHeadroom, &WorkloadHistory];

pub fn strategies() -> Vec<RightsizingStrategyInfo> {
    STRATEGIES.iter().map(|s| s.info()).collect()
}

/// The strategy `id` names (`None` = the default).
pub fn strategy(id: Option<&str>) -> Result<&'static dyn RecommendationStrategy> {
    let id = id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_STRATEGY_ID);
    match STRATEGIES.iter().find(|s| s.info().id == id) {
        Some(s) => Ok(*s),
        None => bail!("unknown right-sizing strategy \"{id}\""),
    }
}

/// The strategy for a request (spec §6.10). A named strategy is used as it
/// is; with none (`None` or blank) it is chosen automatically:
/// `workload-history` when the collection resolved pods through
/// kube-state-metrics owner metrics, else `percentile-headroom`. The bool
/// is true when the choice was automatic.
pub fn resolve(
    requested: Option<&str>,
    owner_metrics: bool,
) -> Result<(&'static dyn RecommendationStrategy, bool)> {
    match requested.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => Ok((strategy(Some(id))?, false)),
        None if owner_metrics => Ok((strategy(Some(WORKLOAD_HISTORY_ID))?, true)),
        None => Ok((strategy(None)?, true)),
    }
}

/// Raise a limit below its request, keeping the current limit ÷ request
/// ratio (a missing request defaults to the limit, so the ratio is then 1).
fn raise(
    current_request: Option<f64>,
    current_limit: Option<f64>,
    request: Option<f64>,
    limit: &mut Option<f64>,
    round: fn(f64) -> f64,
) -> bool {
    let (Some(r), Some(l)) = (request, *limit) else {
        return false;
    };
    if r <= l {
        return false;
    }
    let ratio = match (current_request.or(current_limit), current_limit) {
        (Some(cr), Some(cl)) if cr > 0.0 => (cl / cr).max(1.0),
        _ => 1.0,
    };
    *limit = Some(round(r * ratio).max(r));
    true
}

/// Raise the CPU / memory limits of `recommended` that its requests exceed
/// (the API server rejects requests above limits). Returns which rose.
pub fn raise_limits(current: &ResourceValues, recommended: &mut ResourceValues) -> (bool, bool) {
    let cpu = raise(
        current.cpu_request,
        current.cpu_limit,
        recommended.cpu_request,
        &mut recommended.cpu_limit,
        round_up_cpu,
    );
    let memory = raise(
        current.memory_request,
        current.memory_limit,
        recommended.memory_request,
        &mut recommended.memory_limit,
        round_up_memory,
    );
    (cpu, memory)
}

/// The container recommendation of a strategy's output: values it left
/// alone stay, limits follow their requests, changes are derived.
pub fn finalize(input: &ContainerInput<'_>, output: StrategyOutput) -> ContainerRecommendation {
    let current = input.current;
    let mut recommended = ResourceValues {
        cpu_request: output.recommended.cpu_request.or(current.cpu_request),
        cpu_limit: output.recommended.cpu_limit.or(current.cpu_limit),
        memory_request: output.recommended.memory_request.or(current.memory_request),
        memory_limit: output.recommended.memory_limit.or(current.memory_limit),
    };
    let (cpu_limit_raised, memory_limit_raised) = raise_limits(&current, &mut recommended);
    let mut warnings = output.warnings;
    if cpu_limit_raised {
        warnings.push(RecommendationWarning::new(WARN_CPU_LIMIT_RAISED));
    }
    if memory_limit_raised {
        warnings.push(RecommendationWarning::new(WARN_MEMORY_LIMIT_RAISED));
    }
    ContainerRecommendation {
        name: input.name.to_string(),
        current,
        cpu: change_of(current.cpu_request, recommended.cpu_request),
        cpu_limit: change_of(current.cpu_limit, recommended.cpu_limit),
        memory: change_of(current.memory_request, recommended.memory_request),
        memory_limit: change_of(current.memory_limit, recommended.memory_limit),
        recommended,
        usage: input.usage,
        confidence: output.confidence,
        warnings,
        cpu_limit_raised,
        memory_limit_raised,
        evidence: input.evidence.cloned(),
    }
}

/// The shared evidence step (spec §6.7), run after every strategy and before
/// [`finalize`]: risk signals of the usage evidence and the HPA become
/// warnings and cap the confidence (the final confidence is the minimum of
/// the strategy's and every cap that applies). Values are never changed:
/// a recommendation is always computed, risk only decides how much
/// confirmation applying it needs.
pub fn apply_evidence(input: &ContainerInput<'_>, output: StrategyOutput) -> StrategyOutput {
    let StrategyOutput {
        recommended,
        mut confidence,
        mut warnings,
    } = output;
    let mut flag = |warning: RecommendationWarning, cap: Confidence| {
        warnings.push(warning);
        confidence = confidence.min(cap);
    };
    let settings = input.settings;
    if let Some(e) = input.evidence {
        if e.identity == EvidenceIdentity::Ambiguous {
            flag(
                RecommendationWarning::new(WARN_IDENTITY_UNCLEAR),
                Confidence::Low,
            );
        }
        if e.observed_hours < settings.min_hours {
            flag(
                RecommendationWarning::with_detail(
                    WARN_INSUFFICIENT_HISTORY,
                    format!("{}", e.observed_hours.max(0.0).floor()),
                ),
                Confidence::Low,
            );
        }
        let lowest = [e.cpu_coverage, e.memory_coverage]
            .into_iter()
            .flatten()
            .filter(|c| *c < settings.min_coverage)
            .reduce(f64::min);
        if let Some(coverage) = lowest {
            flag(
                RecommendationWarning::with_detail(
                    WARN_LOW_COVERAGE,
                    format!("{:.0}%", coverage.max(0.0) * 100.0),
                ),
                Confidence::Low,
            );
        }
        if e.partial {
            flag(
                RecommendationWarning::new(WARN_PARTIAL_DATA),
                Confidence::Medium,
            );
        }
    }
    if let Some(hpa) = input.hpa {
        flag(
            RecommendationWarning::with_detail(WARN_HPA_TARGET, hpa.name.clone()),
            Confidence::Medium,
        );
        let current = input.current;
        let targets: Vec<String> = hpa
            .metrics
            .iter()
            .filter_map(|m| {
                let target = m.target_utilization?;
                let (name, before, after) = match m.resource {
                    HpaResource::Cpu => ("cpu", current.cpu_request, recommended.cpu_request),
                    HpaResource::Memory => {
                        ("memory", current.memory_request, recommended.memory_request)
                    }
                    HpaResource::Other => return None,
                };
                (change_of(before, after) != Change::Unchanged).then(|| format!("{name} {target}%"))
            })
            .collect();
        if !targets.is_empty() {
            flag(
                RecommendationWarning::with_detail(WARN_HPA_UTILIZATION, targets.join(", ")),
                Confidence::Medium,
            );
        }
    }
    if let Some(e) = input.evidence {
        if e.oom_killed {
            flag(
                RecommendationWarning::new(WARN_OOM_KILLED),
                Confidence::Medium,
            );
        }
        if let Some(ratio) = e
            .throttle_ratio
            .filter(|r| *r >= settings.throttle_threshold_percent / 100.0)
        {
            flag(
                RecommendationWarning::with_detail(
                    WARN_CPU_THROTTLED,
                    format!("{:.1}%", ratio * 100.0),
                ),
                Confidence::Medium,
            );
        }
        if e.identity == EvidenceIdentity::NameMatch {
            flag(
                RecommendationWarning::new(WARN_IDENTITY_BY_NAME),
                Confidence::Medium,
            );
        }
    }
    StrategyOutput {
        recommended,
        confidence,
        warnings,
    }
}

/// Run `strategy` on one container, apply the evidence step and finalize.
pub fn recommend(
    strategy: &dyn RecommendationStrategy,
    input: &ContainerInput<'_>,
) -> ContainerRecommendation {
    finalize(input, apply_evidence(input, strategy.recommend(input)))
}

impl ContainerRecommendation {
    pub fn changed(&self) -> bool {
        [self.cpu, self.memory, self.memory_limit, self.cpu_limit]
            .iter()
            .any(|c| *c != Change::Unchanged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rightsizing::math::{GIB, MIB};
    use crate::rightsizing::types::{Change, EvidenceIdentity, HpaMetric, HpaResource};

    /// A test strategy that asks for fixed requests and nothing else.
    struct Fixed(f64, f64);

    impl RecommendationStrategy for Fixed {
        fn info(&self) -> RightsizingStrategyInfo {
            RightsizingStrategyInfo {
                id: "fixed".into(),
                name: "Fixed".into(),
                defaults: RightsizingSettings::default(),
                settings_keys: Vec::new(),
            }
        }
        fn recommend(&self, _input: &ContainerInput<'_>) -> StrategyOutput {
            StrategyOutput {
                recommended: ResourceValues {
                    cpu_request: Some(self.0),
                    memory_request: Some(self.1),
                    ..Default::default()
                },
                confidence: Confidence::Medium,
                warnings: vec![RecommendationWarning::with_detail("custom", "a caveat")],
            }
        }
    }

    fn input(current: ResourceValues) -> (RightsizingSettings, ResourceValues) {
        (RightsizingSettings::default(), current)
    }

    #[test]
    fn registry_offers_the_default_first() {
        let list = strategies();
        assert_eq!(list[0].id, DEFAULT_STRATEGY_ID);
        assert_eq!(strategy(None).unwrap().info().id, DEFAULT_STRATEGY_ID);
        assert_eq!(strategy(Some(" ")).unwrap().info().id, DEFAULT_STRATEGY_ID);
        assert!(strategy(Some("nope")).is_err());
    }

    #[test]
    fn resolution_prefers_workload_history_with_owner_metrics() {
        use crate::rightsizing::workload_history::WORKLOAD_HISTORY_ID;
        assert_eq!(
            resolve(None, true).map(|(s, a)| (s.info().id, a)).unwrap(),
            (WORKLOAD_HISTORY_ID.into(), true)
        );
        assert_eq!(
            resolve(None, false).map(|(s, a)| (s.info().id, a)).unwrap(),
            (DEFAULT_STRATEGY_ID.into(), true)
        );
        assert_eq!(
            resolve(Some(" "), true).unwrap().0.info().id,
            WORKLOAD_HISTORY_ID
        );
        assert!(!resolve(Some("percentile-headroom"), true).unwrap().1);
        assert_eq!(
            resolve(Some("workload-history"), false)
                .map(|(s, a)| (s.info().id, a))
                .unwrap(),
            (WORKLOAD_HISTORY_ID.into(), false)
        );
        assert!(resolve(Some("nope"), true).is_err());
        assert!(strategies().iter().any(|s| s.id == WORKLOAD_HISTORY_ID));
    }

    #[test]
    fn limits_rise_proportionally_with_their_requests() {
        let (settings, current) = input(ResourceValues {
            cpu_request: Some(100.0),
            cpu_limit: Some(200.0),
            memory_request: Some(128.0 * MIB),
            memory_limit: Some(192.0 * MIB),
        });
        let rec = recommend(
            &Fixed(460.0, 300.0 * MIB),
            &ContainerInput {
                name: "app",
                current,
                usage: None,
                source: RightsizingSource::Prometheus,
                settings: &settings,
                evidence: None,
                hpa: None,
            },
        );
        // CPU: ratio 2 → 920m. Memory: ratio 1.5 → 450 MiB → 464 MiB (16 MiB steps).
        assert_eq!(rec.recommended.cpu_limit, Some(920.0));
        assert_eq!(rec.recommended.memory_limit, Some(464.0 * MIB));
        assert!(rec.cpu_limit_raised && rec.memory_limit_raised);
        assert_eq!(rec.cpu_limit, Change::Increase);
        assert_eq!(rec.memory_limit, Change::Increase);
        let codes: Vec<&str> = rec.warnings.iter().map(|w| w.code.as_str()).collect();
        assert_eq!(
            codes,
            vec!["custom", WARN_CPU_LIMIT_RAISED, WARN_MEMORY_LIMIT_RAISED]
        );
        assert_eq!(rec.confidence, Confidence::Medium);
    }

    #[test]
    fn limits_that_still_hold_or_do_not_exist_stay() {
        let (settings, current) = input(ResourceValues {
            cpu_request: None,
            cpu_limit: Some(500.0),
            memory_request: Some(128.0 * MIB),
            memory_limit: None,
        });
        let low = recommend(
            &Fixed(200.0, 256.0 * MIB),
            &ContainerInput {
                name: "app",
                current,
                usage: None,
                source: RightsizingSource::Prometheus,
                settings: &settings,
                evidence: None,
                hpa: None,
            },
        );
        assert_eq!(low.recommended.cpu_limit, Some(500.0));
        assert!(!low.cpu_limit_raised && !low.memory_limit_raised);
        assert_eq!(low.recommended.memory_limit, None, "no limit is invented");
        assert_eq!(low.cpu, Change::Set);
        assert_eq!(low.memory, Change::Increase);
        // A missing request defaults to the limit: ratio 1.
        let high = recommend(
            &Fixed(730.0, 64.0 * MIB),
            &ContainerInput {
                name: "app",
                current,
                usage: None,
                source: RightsizingSource::Prometheus,
                settings: &settings,
                evidence: None,
                hpa: None,
            },
        );
        assert_eq!(high.recommended.cpu_limit, Some(730.0));
        assert!(high.cpu_limit_raised);
    }

    /// A test strategy that is sure of itself: fixed requests, high confidence.
    struct Sure;

    impl RecommendationStrategy for Sure {
        fn info(&self) -> RightsizingStrategyInfo {
            RightsizingStrategyInfo {
                id: "sure".into(),
                name: "Sure".into(),
                defaults: RightsizingSettings::default(),
                settings_keys: Vec::new(),
            }
        }
        fn recommend(&self, _input: &ContainerInput<'_>) -> StrategyOutput {
            StrategyOutput {
                recommended: ResourceValues {
                    cpu_request: Some(200.0),
                    memory_request: Some(256.0 * MIB),
                    ..Default::default()
                },
                confidence: Confidence::High,
                warnings: Vec::new(),
            }
        }
    }

    /// Evidence that raises no flag: a week observed, full coverage.
    fn clean_evidence() -> UsageEvidence {
        UsageEvidence {
            observed_hours: 168.0,
            cpu_coverage: Some(1.0),
            memory_coverage: Some(1.0),
            cpu_samples: 2016.0,
            memory_samples: 2016.0,
            pods: 2,
            duty: Some(2.0),
            ..Default::default()
        }
    }

    fn hpa(name: &str, target: Option<u32>) -> HpaInfo {
        HpaInfo {
            name: name.into(),
            min_replicas: Some(1),
            max_replicas: 5,
            metrics: vec![HpaMetric {
                resource: HpaResource::Cpu,
                target_utilization: target,
            }],
        }
    }

    fn run_with(modify: fn(&mut UsageEvidence, &mut Option<HpaInfo>)) -> ContainerRecommendation {
        let settings = RightsizingSettings::default();
        let mut evidence = clean_evidence();
        let mut hpa = None;
        modify(&mut evidence, &mut hpa);
        recommend(
            &Sure,
            &ContainerInput {
                name: "app",
                current: ResourceValues {
                    cpu_request: Some(1000.0),
                    memory_request: Some(GIB),
                    ..Default::default()
                },
                usage: Some(UsageStats {
                    cpu_p95: 150.0,
                    cpu_max: 300.0,
                    memory_max: 200.0 * MIB,
                    hours: 168.0,
                    ..Default::default()
                }),
                source: RightsizingSource::Prometheus,
                settings: &settings,
                evidence: Some(&evidence),
                hpa: hpa.as_ref(),
            },
        )
    }

    fn codes(rec: &ContainerRecommendation) -> Vec<&str> {
        rec.warnings.iter().map(|w| w.code.as_str()).collect()
    }

    fn detail<'a>(rec: &'a ContainerRecommendation, code: &str) -> Option<&'a str> {
        rec.warnings
            .iter()
            .find(|w| w.code == code)
            .and_then(|w| w.detail.as_deref())
    }

    #[test]
    fn evidence_caps_confidence_and_adds_flags() {
        type Modify = fn(&mut UsageEvidence, &mut Option<HpaInfo>);
        let cases: &[(Modify, &str, Confidence)] = &[
            (
                |e, _| e.identity = EvidenceIdentity::Ambiguous,
                WARN_IDENTITY_UNCLEAR,
                Confidence::Low,
            ),
            (
                |e, _| e.observed_hours = 10.0,
                WARN_INSUFFICIENT_HISTORY,
                Confidence::Low,
            ),
            (
                |e, _| e.cpu_coverage = Some(0.5),
                WARN_LOW_COVERAGE,
                Confidence::Low,
            ),
            (
                |e, _| e.partial = true,
                WARN_PARTIAL_DATA,
                Confidence::Medium,
            ),
            (
                |_, h| *h = Some(hpa("api", None)),
                WARN_HPA_TARGET,
                Confidence::Medium,
            ),
            (
                |_, h| *h = Some(hpa("api", Some(70))),
                WARN_HPA_UTILIZATION,
                Confidence::Medium,
            ),
            (
                |e, _| e.oom_killed = true,
                WARN_OOM_KILLED,
                Confidence::Medium,
            ),
            (
                |e, _| e.throttle_ratio = Some(0.08),
                WARN_CPU_THROTTLED,
                Confidence::Medium,
            ),
            (
                |e, _| e.identity = EvidenceIdentity::NameMatch,
                WARN_IDENTITY_BY_NAME,
                Confidence::Medium,
            ),
        ];
        for (modify, code, cap) in cases {
            let rec = run_with(*modify);
            assert!(codes(&rec).contains(code), "{code}: {:?}", rec.warnings);
            assert_eq!(rec.confidence, *cap, "{code}");
        }
        // Clean evidence adds nothing and keeps the strategy's confidence.
        let clean = run_with(|_, _| {});
        assert!(clean.warnings.is_empty(), "{:?}", clean.warnings);
        assert_eq!(clean.confidence, Confidence::High);
        // Details are data: whole hours, whole %, one decimal, the HPA name.
        assert_eq!(
            detail(
                &run_with(|e, _| e.observed_hours = 10.4),
                WARN_INSUFFICIENT_HISTORY
            ),
            Some("10")
        );
        assert_eq!(
            detail(
                &run_with(|e, _| e.memory_coverage = Some(0.456)),
                WARN_LOW_COVERAGE
            ),
            Some("46%")
        );
        assert_eq!(
            detail(
                &run_with(|e, _| e.throttle_ratio = Some(0.0834)),
                WARN_CPU_THROTTLED
            ),
            Some("8.3%")
        );
        let scaled = run_with(|_, h| *h = Some(hpa("api", Some(70))));
        assert_eq!(detail(&scaled, WARN_HPA_TARGET), Some("api"));
        assert_eq!(detail(&scaled, WARN_HPA_UTILIZATION), Some("cpu 70%"));
        // Below the threshold, or with too few periods (None), no throttling flag.
        assert!(
            !codes(&run_with(|e, _| e.throttle_ratio = Some(0.049))).contains(&WARN_CPU_THROTTLED)
        );
        // The cap is the minimum of every cap that applies.
        let both = run_with(|e, _| {
            e.partial = true;
            e.identity = EvidenceIdentity::Ambiguous;
        });
        assert_eq!(both.confidence, Confidence::Low);
        assert_eq!(codes(&both), vec![WARN_IDENTITY_UNCLEAR, WARN_PARTIAL_DATA]);
    }

    #[test]
    fn hpa_utilization_needs_a_changing_request() {
        let settings = RightsizingSettings::default();
        let evidence = clean_evidence();
        let memory_target = HpaInfo {
            metrics: vec![HpaMetric {
                resource: HpaResource::Memory,
                target_utilization: Some(80),
            }],
            ..hpa("api", None)
        };
        let input = ContainerInput {
            name: "app",
            // The memory request stays at 256 MiB: the utilization target keeps its meaning.
            current: ResourceValues {
                cpu_request: Some(1000.0),
                memory_request: Some(256.0 * MIB),
                ..Default::default()
            },
            usage: None,
            source: RightsizingSource::Prometheus,
            settings: &settings,
            evidence: Some(&evidence),
            hpa: Some(&memory_target),
        };
        let rec = recommend(&Sure, &input);
        assert!(codes(&rec).contains(&WARN_HPA_TARGET));
        assert!(!codes(&rec).contains(&WARN_HPA_UTILIZATION));
    }

    #[test]
    fn evidence_never_changes_values() {
        let clean = run_with(|_, _| {});
        let flagged = run_with(|e, h| {
            e.identity = EvidenceIdentity::Ambiguous;
            e.observed_hours = 3.0;
            e.cpu_coverage = Some(0.2);
            e.partial = true;
            e.oom_killed = true;
            e.throttle_ratio = Some(0.3);
            *h = Some(hpa("api", Some(60)));
        });
        assert_eq!(flagged.recommended, clean.recommended);
        assert_eq!(flagged.evidence.as_ref().map(|e| e.oom_killed), Some(true));
        assert_eq!(flagged.confidence, Confidence::Low);
    }
}
