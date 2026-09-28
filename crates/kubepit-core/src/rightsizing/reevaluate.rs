//! Re-evaluation of stored reports (spec §10.3 `recommendations_latest`):
//! a stored scan is shown with the current strategy and settings without
//! querying the cluster again.
//!
//! Every container's inputs are stored with the report: its current
//! values, its usage and evidence, the report's source and the workload's
//! HPA. [`reevaluate`] runs them through a strategy and the shared evidence
//! step again, then recomputes what depends on the output (verdict,
//! confidence, monthly amounts, `cost_replicas`, lenses, order). What was
//! observed stays: the window, `computed_at` and the notes.

use super::math;
use super::sort_recommendations;
use super::strategy::{self, ContainerInput, RecommendationStrategy};
use super::types::{
    ContainerRecommendation, RightsizingReport, RightsizingSettings, RightsizingSource,
    WorkloadRecommendation,
};
use crate::cost::CostPricing;

fn reevaluate_workload(
    stored: &WorkloadRecommendation,
    source: RightsizingSource,
    strategy: &dyn RecommendationStrategy,
    settings: &RightsizingSettings,
    pricing: &CostPricing,
) -> WorkloadRecommendation {
    let containers: Vec<ContainerRecommendation> = stored
        .containers
        .iter()
        .map(|c| {
            let input = ContainerInput {
                name: &c.name,
                current: c.current,
                usage: c.usage,
                source,
                settings,
                evidence: c.evidence.as_ref(),
                hpa: stored.hpa.as_ref(),
            };
            strategy::recommend(strategy, &input)
        })
        .collect();
    let facts = math::WorkloadFacts {
        kind: stored.kind.clone(),
        namespace: stored.namespace.clone(),
        name: stored.name.clone(),
        uid: stored.uid.clone(),
        replicas: stored.replicas,
        pods: stored.pods.clone(),
        pods_truncated: stored.pods_truncated,
        hpa: stored.hpa.clone(),
    };
    math::workload_recommendation(facts, containers, pricing)
}

/// `stored` recomputed with `strategy` (`auto`: chosen automatically),
/// `settings` and `pricing` from the stored inputs; the window,
/// `computed_at` and the notes are kept.
pub fn reevaluate(
    stored: &RightsizingReport,
    strategy: &dyn RecommendationStrategy,
    auto: bool,
    settings: &RightsizingSettings,
    pricing: &CostPricing,
) -> RightsizingReport {
    let mut workloads: Vec<WorkloadRecommendation> = stored
        .workloads
        .iter()
        .map(|w| reevaluate_workload(w, stored.source, strategy, settings, pricing))
        .collect();
    sort_recommendations(&mut workloads);
    RightsizingReport {
        source: stored.source,
        window_secs: stored.window_secs,
        settings: settings.clone(),
        currency: pricing.currency.clone(),
        pricing: pricing.clone(),
        workloads,
        notes: stored.notes.clone(),
        strategy: strategy.info().id,
        strategies: strategy::strategies(),
        computed_at: stored.computed_at,
        strategy_auto: auto,
        window_end: stored.window_end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::CostPricing;
    use crate::rightsizing::evidence::{ContainerUsage, WorkloadUsage};
    use crate::rightsizing::math::{GIB, MIB};
    use crate::rightsizing::percentile::PercentileHeadroom;
    use crate::rightsizing::strategy::{
        RecommendationStrategy, WARN_HPA_TARGET, WARN_HPA_UTILIZATION,
    };
    use crate::rightsizing::workload_history::WorkloadHistory;
    use crate::rightsizing::{
        recommend_workload, strategy, Confidence, EvidenceIdentity, HpaInfo, HpaMetric,
        HpaResource, ResourceValues, RightsizingNote, RightsizingNoteKind, RightsizingReport,
        RightsizingSettings, RightsizingSource, UsageEvidence, UsageStats, Workload,
        WorkloadRecommendation,
    };

    fn pricing() -> CostPricing {
        CostPricing {
            currency: "EUR".into(),
            cpu_hour: 0.04,
            memory_gib_hour: 0.005,
            gpu_hour: None,
            storage_gib_month: None,
            discount_percent: 0.0,
        }
    }

    fn evidence(duty: Option<f64>) -> UsageEvidence {
        UsageEvidence {
            observed_hours: 168.0,
            cpu_coverage: Some(1.0),
            memory_coverage: Some(1.0),
            cpu_samples: 2016.0,
            memory_samples: 2016.0,
            pods: 3,
            duty,
            throttle_ratio: None,
            oom_killed: false,
            partial: false,
            identity: EvidenceIdentity::OwnerMetrics,
        }
    }

    /// `kind shop/name` with one `app` container of 1 core / 1 GiB and its
    /// recommendation from 168 hours of usage (p95 `p95` m, 300 MiB).
    fn stored_workload(
        kind: &str,
        name: &str,
        p95: f64,
        duty: Option<f64>,
    ) -> WorkloadRecommendation {
        let w = Workload {
            kind: kind.into(),
            namespace: "shop".into(),
            name: name.into(),
            uid: format!("uid-{name}"),
            replicas: 3,
            containers: vec![(
                "app".into(),
                ResourceValues {
                    cpu_request: Some(1000.0),
                    cpu_limit: None,
                    memory_request: Some(GIB),
                    memory_limit: Some(GIB),
                },
            )],
        };
        let usage: WorkloadUsage = [(
            (0, "app".to_string()),
            ContainerUsage {
                stats: UsageStats {
                    cpu_p95: p95,
                    cpu_max: p95 * 2.0,
                    memory_max: 300.0 * MIB,
                    hours: 168.0,
                    cpu_avg: Some(p95 / 2.0),
                    memory_avg: Some(250.0 * MIB),
                },
                evidence: Some(evidence(duty)),
            },
        )]
        .into();
        let mut rec = recommend_workload(
            &w,
            &usage,
            0,
            RightsizingSource::Prometheus,
            &WorkloadHistory::defaults(),
            &pricing(),
            &WorkloadHistory,
        );
        rec.pods = vec![format!("{name}-a"), format!("{name}-b")];
        rec
    }

    /// A row as an older build stored it: no evidence, lenses or cost replicas.
    fn legacy() -> WorkloadRecommendation {
        serde_json::from_str(
            r#"{"kind":"Deployment","namespace":"shop","name":"legacy","uid":"u1",
            "replicas":2,"confidence":"high","verdict":"over","coverage_hours":168.0,
            "containers":[{"name":"app",
                "current":{"cpu_request":300.0,"cpu_limit":null,"memory_request":536870912.0,"memory_limit":null},
                "recommended":{"cpu_request":140.0,"cpu_limit":null,"memory_request":385875968.0,"memory_limit":null},
                "usage":{"cpu_p95":120.0,"cpu_max":300.0,"memory_max":314572800.0,"hours":168.0},
                "cpu":"decrease","memory":"decrease","memory_limit":"unchanged","cpu_limit":"unchanged",
                "confidence":"high","warnings":[],"cpu_limit_raised":false,"memory_limit_raised":false}],
            "monthly_delta":-1.5,"monthly_current":3.0,"changed":true}"#,
        )
        .unwrap()
    }

    fn stored() -> RightsizingReport {
        let mut web = stored_workload("Deployment", "web", 200.0, None);
        web.hpa = Some(HpaInfo {
            name: "web".into(),
            min_replicas: Some(2),
            max_replicas: 6,
            metrics: vec![HpaMetric {
                resource: HpaResource::Cpu,
                target_utilization: Some(70),
            }],
        });
        RightsizingReport {
            source: RightsizingSource::Prometheus,
            window_secs: 7 * 86_400,
            settings: WorkloadHistory::defaults(),
            currency: "USD".into(),
            pricing: CostPricing {
                currency: "USD".into(),
                ..pricing()
            },
            workloads: vec![
                web,
                legacy(),
                stored_workload("CronJob", "nightly", 150.0, Some(0.25)),
            ],
            notes: vec![RightsizingNote {
                kind: RightsizingNoteKind::PartialData,
                detail: Some("Q15".into()),
            }],
            strategy: "workload-history".into(),
            strategies: strategy::strategies(),
            computed_at: 1_234,
            strategy_auto: true,
            window_end: 5_678,
        }
    }

    fn find<'a>(report: &'a RightsizingReport, name: &str) -> &'a WorkloadRecommendation {
        report.workloads.iter().find(|w| w.name == name).unwrap()
    }

    #[test]
    fn reevaluation_uses_the_stored_inputs() {
        let stored = stored();
        let settings = RightsizingSettings {
            cpu_headroom_percent: 50.0,
            ..WorkloadHistory::defaults()
        };
        let again = reevaluate(&stored, &WorkloadHistory, true, &settings, &pricing());
        assert_eq!(again.workloads[0].name, "web", "the largest saving first");
        let (before, after) = (
            &stored.workloads[0].containers[0],
            &again.workloads[0].containers[0],
        );
        assert!(after.recommended.cpu_request > before.recommended.cpu_request);
        assert_eq!(after.recommended.cpu_request, Some(300.0));
        assert_eq!(after.usage, before.usage);
        assert_eq!(after.evidence, before.evidence);
        assert_eq!(again.window_end, stored.window_end);
        assert_eq!(again.window_secs, stored.window_secs);
        assert_eq!(again.computed_at, stored.computed_at);
        assert_eq!(again.notes, stored.notes);
        assert_eq!(again.settings, settings);
        assert_eq!(
            (again.strategy.as_str(), again.strategy_auto),
            ("workload-history", true)
        );
        assert_eq!(
            (again.currency.as_str(), again.pricing.currency.as_str()),
            ("EUR", "EUR")
        );

        // The stored HPA feeds the evidence step.
        let web = find(&again, "web");
        let codes: Vec<&str> = web.containers[0]
            .warnings
            .iter()
            .map(|w| w.code.as_str())
            .collect();
        assert!(codes.contains(&WARN_HPA_TARGET) && codes.contains(&WARN_HPA_UTILIZATION));
        assert_eq!(web.confidence, Confidence::Medium);
        assert_eq!((web.pods.len(), web.hpa.is_some()), (2, true));
        assert_eq!(web.lenses, crate::rightsizing::summary::lenses_of(web));
        assert!(web.monthly_delta < 0.0 && web.monthly_current > 0.0);
    }

    #[test]
    fn reevaluation_recomputes_cost_replicas_and_money() {
        let stored = stored();
        let defaults = PercentileHeadroom.info().defaults;
        let again = reevaluate(&stored, &PercentileHeadroom, false, &defaults, &pricing());
        assert_eq!(
            (again.strategy.as_str(), again.strategy_auto),
            ("percentile-headroom", false)
        );

        // An older row gets cost replicas and lenses.
        let legacy = find(&again, "legacy");
        assert_eq!(legacy.cost_replicas, 2.0);
        assert!(!legacy.lenses.is_empty());
        let per_replica =
            crate::rightsizing::math::monthly_requests(&legacy.containers, 1.0, &pricing(), false);
        assert!((legacy.monthly_current - per_replica * 2.0).abs() < 1e-9);

        // A CronJob costs its duty cycle, not its replicas.
        let nightly = find(&again, "nightly");
        assert_eq!(nightly.cost_replicas, 0.25);
        let per_replica =
            crate::rightsizing::math::monthly_requests(&nightly.containers, 1.0, &pricing(), false);
        assert!((nightly.monthly_current - per_replica * 0.25).abs() < 1e-9);
    }
}
