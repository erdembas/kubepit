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
    Confidence, ContainerRecommendation, HpaInfo, RecommendationWarning, ResourceValues,
    RightsizingSettings, RightsizingSource, RightsizingStrategyInfo, UsageEvidence, UsageStats,
};

/// Id of the strategy used when a request names none.
pub const DEFAULT_STRATEGY_ID: &str = "percentile-headroom";

/// Warning codes [`finalize`] adds.
pub const WARN_CPU_LIMIT_RAISED: &str = "cpu-limit-raised";
pub const WARN_MEMORY_LIMIT_RAISED: &str = "memory-limit-raised";

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
pub static STRATEGIES: &[&dyn RecommendationStrategy] = &[&PercentileHeadroom];

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

/// Run `strategy` on one container and finalize its output.
pub fn recommend(
    strategy: &dyn RecommendationStrategy,
    input: &ContainerInput<'_>,
) -> ContainerRecommendation {
    finalize(input, strategy.recommend(input))
}

impl ContainerRecommendation {
    pub fn changed(&self) -> bool {
        use super::types::Change;
        [self.cpu, self.memory, self.memory_limit, self.cpu_limit]
            .iter()
            .any(|c| *c != Change::Unchanged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rightsizing::math::MIB;
    use crate::rightsizing::types::Change;

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
}
