//! The collection pipeline behind `rightsizing_report` and background
//! scans, the same for every [`RecommendationStrategy`]:
//!
//! 1. **Scope.** The workloads (every namespace the user can read, falling
//!    back to the accessible namespaces, or one workload) and the
//!    `autoscaling/v2` HPAs. HPAs that cannot be listed add the
//!    `hpa-unavailable` note.
//! 2. **Batches.** One batch of the 16 statistics queries
//!    ([`workload_stats`](crate::prometheus::workload_stats)) over the
//!    namespaces of the workloads (a pod regex for one workload), all at one
//!    aligned window end. A batch whose required query fails is split in
//!    halves, down to single namespaces, within [`MAX_BATCHES`]: a single
//!    namespace that still fails gets `namespace-failed`, namespaces left
//!    over `query-budget-exceeded`. Refining queries that failed or warned
//!    make the batch partial (`partial-data`, naming them). A proxy or
//!    tunnel failure, or a shared Prometheus answering for another cluster,
//!    aborts the collection; so does no batch succeeding at all (the
//!    first error).
//! 3. **Fold** the batches into per-container usage and evidence
//!    ([`evidence::fold`]); without owner series pods match by name
//!    (`ownership-unavailable`).
//! 4. **Recommend.** The strategy is resolved ([`strategy::resolve`]:
//!    automatic = `workload-history` when owner metrics resolved pods) and
//!    runs with the request's settings, else its effective ones
//!    ([`effective_settings`]). The window is collected for the strategy
//!    owner metrics would pick; if the resolved one's window differs (a
//!    per-strategy override), it is collected again at that window.
//!
//! `progress` reports answered queries against `16 × planned batches` (the
//! total grows when a batch splits). Everything goes through the one
//! Prometheus transport (tenant, tunnel, cluster-label selector).
//!
//! **Contract of an aborted collection.** When Prometheus was available
//! but its usage could not be used, [`RightsizingOutcome::source_abort`]
//! says why, typed ([`SourceAbortKind`]: proxy, tunnel, label mismatch
//! with the detail `cluster-label-mismatch`, all batches failed). The
//! report is then the metrics-server (else none) fallback with a
//! `prometheus-failed` note carrying the same detail. The live
//! `rightsizing_report` shows that report; background scans fail on any
//! `source_abort` (keeping the last good result) and never parse notes.

use std::collections::{BTreeSet, HashSet, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{anyhow, Context, Result};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use kube::Client;
use serde::{Deserialize, Serialize};

use super::evidence::{fold, FoldInput, HpaTarget, WorkloadExtras, WorkloadUsage};
use super::strategy::{self, RecommendationStrategy};
use super::types::{
    HpaInfo, HpaMetric, HpaResource, RightsizingNote, RightsizingNoteKind, RightsizingReport,
    RightsizingRequest, RightsizingSettings, RightsizingSource,
};
use super::{
    recommend_workload, sort_recommendations, workload_from_value, workloads_in_scope, Workload,
};
use crate::app::Kubepit;
use crate::cost::lists;
use crate::cost::CostPlatform;
use crate::error::kube_error;
use crate::objects::now_millis;
use crate::prometheus::promql::workload_pod_regex;
use crate::prometheus::usage::MAX_NAMESPACE_MATCHERS;
use crate::prometheus::workload_stats::{
    window_end, BatchFailure, StatQuery, StatScope, StatsBatch,
};
use crate::recommendations::types::effective_settings;
use crate::resources::object_api;
use crate::types::PrometheusState;

/// Batches one collection may run (at most 512 queries).
pub const MAX_BATCHES: usize = 32;

/// How far a collection is.
#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug, PartialEq)]
pub struct ScanProgress {
    /// Answered queries.
    pub completed: u32,
    /// `16 × planned batches`; grows when a batch splits.
    pub total: u32,
    /// Live workloads in scope.
    pub workloads: u32,
}

/// The sorted namespaces in two halves (the first the smaller one).
pub fn split(namespaces: &[String]) -> (Vec<String>, Vec<String>) {
    let mut sorted = namespaces.to_vec();
    sorted.sort();
    sorted.dedup();
    let second = sorted.split_off(sorted.len() / 2);
    (sorted, second)
}

/// The halves of a failed batch, halved further while a part names more
/// namespaces than a selector holds (it would be cluster-wide again).
fn split_down(namespaces: &[String]) -> Vec<Vec<String>> {
    let (a, b) = split(namespaces);
    [a, b]
        .into_iter()
        .filter(|part| !part.is_empty())
        .flat_map(|part| {
            if part.len() > MAX_NAMESPACE_MATCHERS {
                split_down(&part)
            } else {
                vec![part]
            }
        })
        .collect()
}

/// Answered queries against planned ones, reported to the caller.
struct Progress<'a> {
    report: &'a (dyn Fn(ScanProgress) + Send + Sync),
    completed: AtomicU32,
    total: AtomicU32,
    workloads: u32,
}

impl Progress<'_> {
    fn emit(&self) {
        (self.report)(ScanProgress {
            completed: self.completed.load(Ordering::SeqCst),
            total: self.total.load(Ordering::SeqCst),
            workloads: self.workloads,
        });
    }

    fn plan(&self, batches: usize) {
        let queries = u32::try_from(batches * StatQuery::ALL.len()).unwrap_or(u32::MAX);
        self.total.fetch_add(queries, Ordering::SeqCst);
    }

    fn answered(&self) {
        self.completed.fetch_add(1, Ordering::SeqCst);
        self.emit();
    }
}

/// What one collection covers.
struct Plan<'a> {
    workloads: &'a [Workload],
    hpas: &'a [HpaTarget],
    /// Namespaces of the workloads (the first batch).
    namespaces: &'a [String],
    /// Pod-name regex of a single-workload request.
    pod_regex: Option<&'a str>,
    /// Label names of a shared Prometheus (`prometheus_access`), so Q11
    /// keeps them and its answer can be checked.
    cluster_labels: Vec<String>,
}

/// The usage of one collection.
struct Collected {
    usage: WorkloadUsage,
    extras: Vec<WorkloadExtras>,
    /// Owner series resolved pods (automatic strategy choice).
    owner_metrics: bool,
    end_secs: i64,
    notes: Vec<RightsizingNote>,
}

/// Why the Prometheus usage of a report could not be used.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceAbortKind {
    /// The service proxy lost Prometheus (or it is not available).
    Proxy,
    /// The authenticated tunnel could not be set up.
    Tunnel,
    /// A shared Prometheus answered for another cluster.
    LabelMismatch,
    /// No batch succeeded (every one failed, was left over or unverified).
    AllBatchesFailed,
}

/// A collection that was abandoned, and why (see the module docs).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SourceAbort {
    pub kind: SourceAbortKind,
    /// The error (`cluster-label-mismatch` for a label mismatch).
    pub detail: String,
}

impl SourceAbort {
    fn of(failure: BatchFailure) -> Self {
        let kind = match &failure {
            BatchFailure::Tunnel(_) => SourceAbortKind::Tunnel,
            BatchFailure::LabelMismatch => SourceAbortKind::LabelMismatch,
            BatchFailure::Proxy(_) => SourceAbortKind::Proxy,
            BatchFailure::Splittable { .. } | BatchFailure::Unverified => {
                SourceAbortKind::AllBatchesFailed
            }
        };
        Self {
            kind,
            detail: failure.to_string(),
        }
    }
}

/// `compute_rightsizing`: the report, and why Prometheus was abandoned
/// when it was (the report is then a fallback).
#[derive(Debug, Clone, PartialEq)]
pub struct RightsizingOutcome {
    pub report: RightsizingReport,
    pub source_abort: Option<SourceAbort>,
}

fn note(kind: RightsizingNoteKind, detail: Option<String>) -> RightsizingNote {
    RightsizingNote { kind, detail }
}

/// Add the answers of another batch (split batches cover disjoint namespaces).
fn absorb(into: &mut StatsBatch, batch: StatsBatch) {
    into.containers.extend(batch.containers);
    into.spans.extend(batch.spans);
    into.owners.merge(batch.owners);
    for warning in batch.warnings {
        if !into.warnings.contains(&warning) {
            into.warnings.push(warning);
        }
    }
    for q in batch.failed {
        if !into.failed.contains(&q) {
            into.failed.push(q);
        }
    }
}

/// The HPA target of an `autoscaling/v2` object. Without metrics an HPA
/// scales on 80 % CPU (the Kubernetes default).
fn hpa_target(hpa: &HorizontalPodAutoscaler) -> Option<HpaTarget> {
    let namespace = hpa.metadata.namespace.clone()?;
    let name = hpa.metadata.name.clone()?;
    let spec = &hpa.spec;
    let mut metrics: Vec<HpaMetric> = spec
        .metrics
        .iter()
        .flatten()
        .map(|m| match (m.type_.as_str(), &m.resource) {
            ("Resource", Some(resource)) => HpaMetric {
                resource: match resource.name.as_str() {
                    "cpu" => HpaResource::Cpu,
                    "memory" => HpaResource::Memory,
                    _ => HpaResource::Other,
                },
                target_utilization: (resource.target.type_ == "Utilization")
                    .then_some(resource.target.average_utilization)
                    .flatten()
                    .and_then(|v| u32::try_from(v).ok()),
            },
            _ => HpaMetric {
                resource: HpaResource::Other,
                target_utilization: None,
            },
        })
        .collect();
    if metrics.is_empty() {
        metrics.push(HpaMetric {
            resource: HpaResource::Cpu,
            target_utilization: Some(80),
        });
    }
    Some(HpaTarget {
        namespace,
        kind: spec.scale_target_ref.kind.clone(),
        name: spec.scale_target_ref.name.clone(),
        info: HpaInfo {
            name,
            min_replicas: spec.min_replicas.and_then(|v| u32::try_from(v).ok()),
            max_replicas: u32::try_from(spec.max_replicas).unwrap_or(0),
            metrics,
        },
    })
}

/// The HPAs of `namespaces` (all when empty), or the note why there are none.
async fn hpas_in_scope(
    client: &Client,
    namespaces: &[String],
    accessible: &[String],
) -> (Vec<HpaTarget>, Option<RightsizingNote>) {
    match lists::namespaced::<HorizontalPodAutoscaler>(client, namespaces, accessible).await {
        Ok(Some(list)) => (list.iter().filter_map(hpa_target).collect(), None),
        Ok(None) => (
            Vec::new(),
            Some(note(RightsizingNoteKind::HpaUnavailable, None)),
        ),
        Err(e) => (
            Vec::new(),
            Some(note(
                RightsizingNoteKind::HpaUnavailable,
                Some(format!("{e:#}")),
            )),
        ),
    }
}

/// Extras of the fallback sources: the HPA only.
fn hpa_extras(workloads: &[Workload], hpas: &[HpaTarget]) -> Vec<WorkloadExtras> {
    workloads
        .iter()
        .map(|w| WorkloadExtras {
            hpa: hpas
                .iter()
                .find(|h| h.namespace == w.namespace && h.kind == w.kind && h.name == w.name)
                .map(|h| h.info.clone()),
            ..WorkloadExtras::default()
        })
        .collect()
}

impl Kubepit {
    /// The workloads a request covers: one (read at its own path) or every
    /// workload in scope.
    async fn requested_workloads(
        &self,
        client: &Client,
        accessible: &[String],
        request: &RightsizingRequest,
    ) -> Result<Vec<Workload>> {
        let Some(target) = &request.workload else {
            return workloads_in_scope(client, &request.namespaces, accessible).await;
        };
        let (gvk, _) = super::supported(&target.kind)?;
        let (api, _) = object_api(client.clone(), &gvk, Some(&target.namespace))?;
        let obj = api
            .get(&target.name)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to get {} {}", target.kind, target.name))?;
        let value = serde_json::to_value(obj)?;
        Ok(vec![workload_from_value(&target.kind, &value).ok_or_else(
            || anyhow!("{} {} has no pod template", target.kind, target.name),
        )?])
    }

    /// The batches of `plan` at `days`, folded (see the module docs).
    async fn collect_usage(
        &self,
        cluster_id: &str,
        plan: &Plan<'_>,
        days: u32,
        progress: &Progress<'_>,
    ) -> std::result::Result<Collected, SourceAbort> {
        let end_secs = window_end(now_millis());
        let on_answer = || progress.answered();
        let mut queue = VecDeque::from([plan.namespaces.to_vec()]);
        let mut planned = 1usize;
        progress.plan(1);
        progress.emit();
        let mut merged = StatsBatch::default();
        let mut succeeded = false;
        let mut partial: HashSet<String> = HashSet::new();
        let (mut failed, mut left_over) = (Vec::new(), Vec::new());
        let mut first_error: Option<String> = None;
        while let Some(scope_namespaces) = queue.pop_front() {
            let scope = StatScope {
                namespaces: scope_namespaces.clone(),
                pod_regex: plan.pod_regex.map(str::to_string),
                days,
                end_secs,
                // The batch takes them from the source it resolves (the
                // same access settings), so both always agree.
                cluster_labels: plan.cluster_labels.clone(),
            };
            match self
                .prometheus_stats_batch(cluster_id, &scope, &on_answer)
                .await
            {
                Ok(batch) => {
                    succeeded = true;
                    if !batch.warnings.is_empty() || !batch.failed.is_empty() {
                        partial.extend(scope_namespaces);
                    }
                    absorb(&mut merged, batch);
                }
                Err(
                    e @ (BatchFailure::Proxy(_)
                    | BatchFailure::Tunnel(_)
                    | BatchFailure::LabelMismatch),
                ) => return Err(SourceAbort::of(e)),
                Err(e @ BatchFailure::Unverified) => {
                    // Not this cluster's for sure: unused, and smaller
                    // scopes would not prove more.
                    first_error.get_or_insert_with(|| e.to_string());
                    failed.extend(scope_namespaces);
                }
                Err(e @ BatchFailure::Splittable { .. }) => {
                    first_error.get_or_insert_with(|| e.to_string());
                    if scope_namespaces.len() <= 1 {
                        failed.extend(scope_namespaces);
                        continue;
                    }
                    let parts = split_down(&scope_namespaces);
                    if planned + parts.len() > MAX_BATCHES {
                        left_over.extend(scope_namespaces);
                        continue;
                    }
                    planned += parts.len();
                    progress.plan(parts.len());
                    queue.extend(parts);
                }
            }
        }
        if !succeeded {
            return Err(SourceAbort {
                kind: SourceAbortKind::AllBatchesFailed,
                detail: first_error.unwrap_or_else(|| "no usage batch succeeded".into()),
            });
        }

        let mut notes = Vec::new();
        let listed = |mut names: Vec<String>| {
            names.sort();
            names.dedup();
            names.join(", ")
        };
        if !failed.is_empty() {
            notes.push(note(
                RightsizingNoteKind::NamespaceFailed,
                Some(listed(failed)),
            ));
        }
        if !left_over.is_empty() {
            notes.push(note(
                RightsizingNoteKind::QueryBudgetExceeded,
                Some(listed(left_over)),
            ));
        }
        if !partial.is_empty() {
            let queries: BTreeSet<StatQuery> = merged.failed.iter().copied().collect();
            let names: Vec<&str> = queries.iter().map(|q| q.name()).collect();
            notes.push(note(
                RightsizingNoteKind::PartialData,
                (!names.is_empty()).then(|| names.join(", ")),
            ));
        }
        let folded = fold(&FoldInput {
            workloads: plan.workloads,
            batch: &merged,
            hpas: plan.hpas,
            start_secs: end_secs - i64::from(days) * 86_400,
            end_secs,
            days,
            partial_namespaces: &partial,
        });
        if folded.report.name_matched {
            notes.push(note(RightsizingNoteKind::OwnershipUnavailable, None));
        }
        Ok(Collected {
            usage: folded.usage,
            extras: folded.extras,
            owner_metrics: !merged.owners.is_empty(),
            end_secs,
            notes,
        })
    }

    /// Recommendations for the workloads a request covers, from Prometheus
    /// (the collection pipeline), else the last metrics-server hour, else
    /// nothing, and why Prometheus was abandoned when it was (see the
    /// module docs). `progress` follows the Prometheus queries.
    pub async fn compute_rightsizing(
        &self,
        cluster_id: &str,
        request: &RightsizingRequest,
        progress: &(dyn Fn(ScanProgress) + Send + Sync),
    ) -> Result<RightsizingOutcome> {
        let cluster = self.cluster_def(cluster_id)?;
        let client = self.client(cluster_id).await?;
        // The request's strategy (an unknown one is an error), else the
        // saved one (an unknown one is ignored), else automatic.
        let saved = self.settings().recommendations;
        let requested = request
            .strategy
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(saved.saved_strategy());
        // The request's own settings, else the strategy's effective ones.
        let own = request
            .settings
            .clone()
            .map(RightsizingSettings::normalized);
        let settings_of = |s: &dyn RecommendationStrategy| {
            own.clone().unwrap_or_else(|| effective_settings(&saved, s))
        };
        // The window is collected for the strategy owner metrics would pick.
        let (likely, _) = strategy::resolve(requested, true)?;

        let workloads = self
            .requested_workloads(&client, &cluster.accessible_namespaces, request)
            .await?;
        let hpa_scope: Vec<String> = match &request.workload {
            Some(target) => vec![target.namespace.clone()],
            None => request.namespaces.clone(),
        };
        let (hpas, hpa_note) =
            hpas_in_scope(&client, &hpa_scope, &cluster.accessible_namespaces).await;
        let platform =
            CostPlatform::from_label(self.cluster_status(cluster_id).platform.as_deref());
        let (pricing, _) = cluster.cost.effective_pricing(platform);
        let mut namespaces: Vec<String> = workloads.iter().map(|w| w.namespace.clone()).collect();
        namespaces.sort();
        namespaces.dedup();
        let pod_regex = request
            .workload
            .as_ref()
            .map(|t| workload_pod_regex(&t.kind, &t.name));
        let mut notes: Vec<RightsizingNote> = hpa_note.into_iter().collect();
        let plan = Plan {
            workloads: &workloads,
            hpas: &hpas,
            namespaces: &namespaces,
            pod_regex: pod_regex.as_deref(),
            cluster_labels: cluster
                .prometheus_access
                .cluster_labels
                .keys()
                .cloned()
                .collect(),
        };
        let progress = Progress {
            report: progress,
            completed: AtomicU32::new(0),
            total: AtomicU32::new(0),
            workloads: u32::try_from(workloads.len()).unwrap_or(u32::MAX),
        };

        let prometheus = !workloads.is_empty()
            && self
                .prometheus_status(cluster_id, false)
                .await
                .is_ok_and(|s| s.state == PrometheusState::Available);
        let mut collected: Option<(Collected, u32)> = None;
        let mut source_abort: Option<SourceAbort> = None;
        if prometheus {
            let mut days = settings_of(likely).days;
            let mut again = true;
            loop {
                match self.collect_usage(cluster_id, &plan, days, &progress).await {
                    Ok(c) => {
                        let (resolved, _) = strategy::resolve(requested, c.owner_metrics)?;
                        let wanted = settings_of(resolved).days;
                        if wanted != days && std::mem::take(&mut again) {
                            days = wanted;
                            continue;
                        }
                        collected = Some((c, days));
                    }
                    Err(abort) => {
                        notes.push(note(
                            RightsizingNoteKind::PrometheusFailed,
                            Some(abort.detail.clone()),
                        ));
                        source_abort = Some(abort);
                    }
                }
                break;
            }
        }

        let now = now_millis();
        let (source, window_secs, window_end_ms, usage, extras, owner_metrics) = match collected {
            Some((c, days)) => {
                notes.extend(c.notes);
                (
                    RightsizingSource::Prometheus,
                    u64::from(days) * 86_400,
                    c.end_secs * 1000,
                    c.usage,
                    c.extras,
                    c.owner_metrics,
                )
            }
            None => {
                let mut result = None;
                if !workloads.is_empty() {
                    match self
                        .metrics_server_usage(
                            cluster_id,
                            &client,
                            &workloads,
                            &namespaces,
                            &cluster.accessible_namespaces,
                        )
                        .await
                    {
                        Ok(Some(usage)) => result = Some(usage),
                        Ok(None) => notes.push(note(RightsizingNoteKind::NoUsage, None)),
                        Err(e) => notes.push(note(
                            RightsizingNoteKind::PodsUnavailable,
                            Some(format!("{e:#}")),
                        )),
                    }
                }
                let extras = hpa_extras(&workloads, &hpas);
                match result {
                    Some(usage) => (
                        RightsizingSource::MetricsServer,
                        3_600,
                        now,
                        usage,
                        extras,
                        false,
                    ),
                    None => (
                        RightsizingSource::None,
                        0,
                        now,
                        WorkloadUsage::new(),
                        extras,
                        false,
                    ),
                }
            }
        };
        let (strategy, strategy_auto) = strategy::resolve(requested, owner_metrics)?;
        let settings = settings_of(strategy);
        let mut list: Vec<_> = workloads
            .iter()
            .zip(&extras)
            .enumerate()
            .map(|(i, (w, extras))| {
                recommend_workload(w, &usage, i, extras, source, &settings, &pricing, strategy)
            })
            .collect();
        sort_recommendations(&mut list);
        let report = RightsizingReport {
            strategy: strategy.info().id,
            strategies: strategy::strategies(),
            source,
            window_secs,
            settings,
            currency: pricing.currency.clone(),
            pricing,
            workloads: list,
            notes,
            computed_at: now,
            strategy_auto,
            window_end: window_end_ms,
        };
        Ok(RightsizingOutcome {
            report,
            source_abort,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::autoscaling::v2::{
        CrossVersionObjectReference, HorizontalPodAutoscalerSpec, MetricSpec, MetricTarget,
        ResourceMetricSource,
    };
    use kube::api::ObjectMeta;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn batches_split_in_sorted_halves() {
        assert_eq!(
            split(&names(&["c", "a", "b"])),
            (names(&["a"]), names(&["b", "c"]))
        );
        assert_eq!(split(&names(&["b", "a"])), (names(&["a"]), names(&["b"])));
        assert_eq!(split(&names(&["a", "a"])), (vec![], names(&["a"])));
        // A half larger than a selector holds would query the whole cluster
        // again: it is halved on the spot.
        let many: Vec<String> = (0..100).map(|i| format!("ns{i:03}")).collect();
        let parts = split_down(&many);
        assert_eq!(parts.len(), 4);
        assert!(parts.iter().all(|p| p.len() == 25));
        assert_eq!(parts.concat(), many);
        assert_eq!(split_down(&names(&["a", "b", "c"])).len(), 2);
    }

    fn autoscaler(metrics: Option<Vec<MetricSpec>>) -> HorizontalPodAutoscaler {
        HorizontalPodAutoscaler {
            metadata: ObjectMeta {
                name: Some("api".into()),
                namespace: Some("shop".into()),
                ..Default::default()
            },
            spec: HorizontalPodAutoscalerSpec {
                scale_target_ref: CrossVersionObjectReference {
                    api_version: Some("apps/v1".into()),
                    kind: "Deployment".into(),
                    name: "web".into(),
                },
                min_replicas: Some(2),
                max_replicas: 6,
                metrics,
                behavior: None,
            },
            status: None,
        }
    }

    fn resource(name: &str, target: &str, utilization: Option<i32>) -> MetricSpec {
        MetricSpec {
            type_: "Resource".into(),
            resource: Some(ResourceMetricSource {
                name: name.into(),
                target: MetricTarget {
                    type_: target.into(),
                    average_utilization: utilization,
                    ..Default::default()
                },
            }),
            ..Default::default()
        }
    }

    #[test]
    fn hpas_name_their_scale_target_and_metrics() {
        let target = hpa_target(&autoscaler(Some(vec![
            resource("cpu", "Utilization", Some(70)),
            resource("memory", "AverageValue", None),
            MetricSpec {
                type_: "External".into(),
                ..Default::default()
            },
        ])))
        .unwrap();
        assert_eq!(
            (
                target.namespace.as_str(),
                target.kind.as_str(),
                target.name.as_str()
            ),
            ("shop", "Deployment", "web")
        );
        assert_eq!(
            target.info,
            HpaInfo {
                name: "api".into(),
                min_replicas: Some(2),
                max_replicas: 6,
                metrics: vec![
                    HpaMetric {
                        resource: HpaResource::Cpu,
                        target_utilization: Some(70)
                    },
                    HpaMetric {
                        resource: HpaResource::Memory,
                        target_utilization: None
                    },
                    HpaMetric {
                        resource: HpaResource::Other,
                        target_utilization: None
                    },
                ],
            }
        );
        // No metrics: Kubernetes scales on 80 % CPU.
        assert_eq!(
            hpa_target(&autoscaler(None)).unwrap().info.metrics,
            vec![HpaMetric {
                resource: HpaResource::Cpu,
                target_utilization: Some(80)
            }]
        );
    }
}
