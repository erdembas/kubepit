//! Folding per-pod statistics into per-(workload, container) usage and evidence.
//!
//! A batch ([`StatsBatch`]) holds statistics per pod *name* and container.
//! Pod names resolve to live workloads through kube-state-metrics owners
//! ([`OwnerIndex::resolve`]), or by the names their kind generates
//! ([`PodMatcher`]) when there are no owner series. Then, for every
//! container of the workload's live pod template (injected sidecars and
//! containers renamed since cannot be patched, so they are skipped):
//!
//! - [`UsageStats`]: the maxima over pods of the per-pod CPU p95, CPU max and
//!   memory max (a pod missing either the p95 or the memory max adds
//!   nothing to them; without any such pod there is no usage), and
//!   sample-weighted CPU / memory averages;
//! - [`UsageEvidence`]: observed hours (the union of the pods' running
//!   spans within the window), coverage (samples ÷ running samples), sample
//!   counts, pods, duty (average running pods), throttling ratio (with
//!   enough CFS periods), OOM kills, whether the batch was partial, and how
//!   the pods were attributed.
//!
//! An ambiguous pod name contributes nothing; every live candidate is
//! flagged instead ([`WorkloadExtras::identity`], even without evidence).
//! A pod whose ReplicaSet or Job has no owner series because
//! `replicaset_owners` / `job_owners` failed or answered nothing for its
//! namespace ([`OwnerIndex::missing_parent_series`]) is matched by name
//! instead, and its workload's rows are partial.

use std::collections::{BTreeSet, HashMap, HashSet};

use super::ownership::Owner;
use super::types::{EvidenceIdentity, HpaInfo, UsageEvidence, UsageStats};
use super::{PodMatcher, Workload};
use crate::prometheus::workload_stats::{PodContainerStats, PodSpan, StatsBatch, STEP_SECS};

/// Pod names kept per workload (the evidence still counts every pod).
pub const MAX_POD_NAMES: usize = 50;
/// CFS periods below which a throttling ratio means nothing.
pub const MIN_THROTTLE_PERIODS: f64 = 600.0;

/// The usage of one container and how it was observed (`None` = not from
/// a Prometheus batch).
#[derive(Debug, Clone, PartialEq)]
pub struct ContainerUsage {
    pub stats: UsageStats,
    pub evidence: Option<UsageEvidence>,
}

/// Usage per `(workload index, container)`.
pub type WorkloadUsage = HashMap<(usize, String), ContainerUsage>;

/// Workload-level facts of the fold.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorkloadExtras {
    /// Pod names, sorted, at most [`MAX_POD_NAMES`].
    pub pods: Vec<String>,
    pub pods_truncated: bool,
    /// The HPA scaling the workload.
    pub hpa: Option<HpaInfo>,
    /// How the workload's pods were attributed; `Ambiguous` even when no
    /// clean pod is left (and so no container has evidence).
    pub identity: EvidenceIdentity,
}

/// A live HPA and the workload its `spec.scaleTargetRef` names.
#[derive(Debug, Clone, PartialEq)]
pub struct HpaTarget {
    pub namespace: String,
    pub kind: String,
    pub name: String,
    pub info: HpaInfo,
}

pub struct FoldInput<'a> {
    /// Live workloads (rows exist only for these).
    pub workloads: &'a [Workload],
    pub batch: &'a StatsBatch,
    pub hpas: &'a [HpaTarget],
    /// The window, in epoch seconds.
    pub start_secs: i64,
    pub end_secs: i64,
    pub days: u32,
    /// Namespaces whose batch was partial.
    pub partial_namespaces: &'a HashSet<String>,
}

/// Pods that could not be attributed, for the scan notes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FoldReport {
    pub unowned_pods: u32,
    pub unsupported_pods: u32,
    pub ambiguous_pods: u32,
    /// No owner series: pods were matched by name.
    pub name_matched: bool,
}

pub struct Folded {
    pub usage: WorkloadUsage,
    /// One per workload, in the order of `FoldInput::workloads`.
    pub extras: Vec<WorkloadExtras>,
    pub report: FoldReport,
}

/// Hours covered by the union of `spans` within `[start, end]`; each span
/// covers `[first, last + 5 min]` (the last step it was seen at).
pub fn union_hours(spans: &[PodSpan], start_secs: i64, end_secs: i64) -> f64 {
    let mut intervals: Vec<(i64, i64)> = spans
        .iter()
        .map(|s| {
            (
                s.first_secs.max(start_secs),
                s.last_secs.saturating_add(STEP_SECS).min(end_secs),
            )
        })
        .filter(|(from, to)| to > from)
        .collect();
    intervals.sort_unstable();
    let mut total = 0i64;
    let mut current: Option<(i64, i64)> = None;
    for (from, to) in intervals {
        current = match current {
            Some((a, b)) if from <= b => Some((a, b.max(to))),
            Some((a, b)) => {
                total += b - a;
                Some((from, to))
            }
            None => Some((from, to)),
        };
    }
    if let Some((a, b)) = current {
        total += b - a;
    }
    total as f64 / 3600.0
}

/// `Σ value·weight / Σ weight` over the pods that have a value.
fn weighted(
    list: &[&PodContainerStats],
    pick: fn(&PodContainerStats) -> (Option<f64>, f64),
) -> Option<f64> {
    let (sum, weight) = list
        .iter()
        .filter_map(|s| {
            let (value, weight) = pick(s);
            Some((value? * weight, weight))
        })
        .fold((0.0, 0.0), |(s, w), (v, x)| (s + v, w + x));
    (weight > 0.0).then(|| sum / weight)
}

fn max_of(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(f64::NEG_INFINITY, f64::max)
}

/// Usage and evidence of every template container of every live workload.
pub fn fold(input: &FoldInput<'_>) -> Folded {
    let workloads = input.workloads;
    let batch = input.batch;
    let mut report = FoldReport::default();

    // Every pod name of the batch, once.
    let pod_names: BTreeSet<(&str, &str)> = batch
        .containers
        .keys()
        .map(|(ns, pod, _)| (ns.as_str(), pod.as_str()))
        .chain(
            batch
                .spans
                .keys()
                .map(|(ns, pod)| (ns.as_str(), pod.as_str())),
        )
        .collect();

    // Pod name → workload index.
    let mut assigned: HashMap<(&str, &str), usize> = HashMap::new();
    let mut ambiguous = vec![false; workloads.len()];
    // Pods matched by name because their ReplicaSet / Job owners are missing.
    let mut by_name = vec![false; workloads.len()];
    let matcher = PodMatcher::new(workloads);
    if batch.owners.is_empty() {
        report.name_matched = true;
        for (ns, pod) in pod_names {
            if let Some(i) = matcher.find(ns, pod) {
                assigned.insert((ns, pod), i);
            }
        }
    } else {
        let live: HashMap<(&str, &str, &str), usize> = workloads
            .iter()
            .enumerate()
            .map(|(i, w)| ((w.namespace.as_str(), w.kind.as_str(), w.name.as_str()), i))
            .collect();
        for (ns, pod) in pod_names {
            match batch.owners.resolve(ns, pod) {
                Owner::Workload { kind, name } => {
                    // Owners that no longer exist get no row.
                    if let Some(&i) = live.get(&(ns, kind.as_str(), name.as_str())) {
                        assigned.insert((ns, pod), i);
                    }
                }
                Owner::Unowned => {
                    // The pod's ReplicaSet / Job has no owner series because
                    // that query failed or answered nothing here: fall back
                    // to its name (a partial row) instead of dropping it.
                    let fallback = batch
                        .owners
                        .missing_parent_series(ns, pod)
                        .then(|| matcher.find(ns, pod))
                        .flatten();
                    match fallback {
                        Some(i) => {
                            assigned.insert((ns, pod), i);
                            by_name[i] = true;
                        }
                        None => report.unowned_pods += 1,
                    }
                }
                Owner::Unsupported(_) => report.unsupported_pods += 1,
                Owner::Ambiguous(candidates) => {
                    report.ambiguous_pods += 1;
                    for (kind, name) in &candidates {
                        if let Some(&i) = live.get(&(ns, kind.as_str(), name.as_str())) {
                            ambiguous[i] = true;
                        }
                    }
                }
            }
        }
    }
    let identity_of = |i: usize| {
        if ambiguous[i] {
            EvidenceIdentity::Ambiguous
        } else if report.name_matched || by_name[i] {
            EvidenceIdentity::NameMatch
        } else {
            EvidenceIdentity::OwnerMetrics
        }
    };

    let mut pods_of: Vec<BTreeSet<&str>> = vec![BTreeSet::new(); workloads.len()];
    let mut spans_of: Vec<Vec<PodSpan>> = vec![Vec::new(); workloads.len()];
    for (&(ns, pod), &i) in &assigned {
        pods_of[i].insert(pod);
        if let Some(span) = batch.spans.get(&(ns.to_string(), pod.to_string())) {
            spans_of[i].push(*span);
        }
    }
    // Sorted, so sums (and stored results) do not depend on hash order.
    let mut entries: Vec<_> = batch.containers.iter().collect();
    entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
    let mut per_container: HashMap<(usize, &str), Vec<&PodContainerStats>> = HashMap::new();
    for ((ns, pod, container), s) in entries {
        let Some(&i) = assigned.get(&(ns.as_str(), pod.as_str())) else {
            continue;
        };
        if workloads[i]
            .containers
            .iter()
            .any(|(name, _)| name == container)
        {
            per_container
                .entry((i, container.as_str()))
                .or_default()
                .push(s);
        }
    }

    let max_hours = f64::from(input.days) * 24.0;
    let window_secs = (input.end_secs - input.start_secs) as f64;
    let mut usage = WorkloadUsage::new();
    let mut extras = Vec::with_capacity(workloads.len());
    for (i, w) in workloads.iter().enumerate() {
        let lists: Vec<(&str, &[&PodContainerStats])> = w
            .containers
            .iter()
            .filter_map(|(name, _)| {
                let list = per_container.get(&(i, name.as_str()))?;
                Some((name.as_str(), list.as_slice()))
            })
            .collect();
        // One figure for every container: the running spans of the pods, or
        // (without Q9 / Q10) the best container's samples per replica.
        let observed_hours = if spans_of[i].is_empty() {
            let samples = lists
                .iter()
                .map(|(_, list)| list.iter().map(|s| s.memory_samples).sum::<f64>())
                .fold(0.0, f64::max);
            (samples * STEP_SECS as f64 / 3600.0 / f64::from(w.replicas.max(1))).min(max_hours)
        } else {
            union_hours(&spans_of[i], input.start_secs, input.end_secs)
        };
        for (container, list) in lists {
            let peaks: Vec<(f64, f64, f64)> = list
                .iter()
                .filter_map(|s| {
                    let (p95, memory) = (s.cpu_p95?, s.memory_max?);
                    Some((p95, s.cpu_max.unwrap_or(p95).max(p95), memory))
                })
                .collect();
            if peaks.is_empty() {
                continue;
            }
            let sum =
                |pick: fn(&PodContainerStats) -> f64| list.iter().map(|s| pick(s)).sum::<f64>();
            let (cpu_samples, memory_samples, running) = (
                sum(|s| s.cpu_samples),
                sum(|s| s.memory_samples),
                sum(|s| s.running),
            );
            let coverage = |samples: f64| (running > 0.0).then(|| (samples / running).min(1.0));
            let periods = sum(|s| s.periods);
            let evidence = UsageEvidence {
                observed_hours,
                cpu_coverage: coverage(cpu_samples),
                memory_coverage: coverage(memory_samples),
                cpu_samples,
                memory_samples,
                pods: u32::try_from(pods_of[i].len()).unwrap_or(u32::MAX),
                duty: (running > 0.0 && window_secs > 0.0)
                    .then(|| running * STEP_SECS as f64 / window_secs),
                throttle_ratio: (periods >= MIN_THROTTLE_PERIODS)
                    .then(|| sum(|s| s.throttled) / periods),
                oom_killed: list.iter().any(|s| s.oom),
                partial: by_name[i] || input.partial_namespaces.contains(&w.namespace),
                identity: identity_of(i),
            };
            let stats = UsageStats {
                cpu_p95: max_of(peaks.iter().map(|p| p.0)),
                cpu_max: max_of(peaks.iter().map(|p| p.1)),
                memory_max: max_of(peaks.iter().map(|p| p.2)),
                hours: observed_hours,
                cpu_avg: weighted(list, |s| (s.cpu_avg, s.cpu_samples)),
                memory_avg: weighted(list, |s| (s.memory_avg, s.memory_samples)),
            };
            usage.insert(
                (i, container.to_string()),
                ContainerUsage {
                    stats,
                    evidence: Some(evidence),
                },
            );
        }
        extras.push(WorkloadExtras {
            pods: pods_of[i]
                .iter()
                .take(MAX_POD_NAMES)
                .map(|p| p.to_string())
                .collect(),
            pods_truncated: pods_of[i].len() > MAX_POD_NAMES,
            hpa: input
                .hpas
                .iter()
                .find(|h| h.namespace == w.namespace && h.kind == w.kind && h.name == w.name)
                .map(|h| h.info.clone()),
            identity: identity_of(i),
        });
    }
    Folded {
        usage,
        extras,
        report,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prometheus::parse::PromData;
    use crate::prometheus::workload_stats::{PodContainerStats, StatQuery};
    use crate::rightsizing::ownership::OwnerIndex;
    use crate::rightsizing::types::{HpaMetric, HpaResource, ResourceValues};
    use crate::types::PromQuerySeries;

    const MIB: f64 = 1024.0 * 1024.0;
    const END: i64 = 1_700_000_100;
    const START: i64 = END - 86_400;
    const HALF: i64 = 43_200;

    fn workload(kind: &str, ns: &str, name: &str, replicas: u32, containers: &[&str]) -> Workload {
        Workload {
            kind: kind.into(),
            namespace: ns.into(),
            name: name.into(),
            uid: format!("uid-{name}"),
            replicas,
            containers: containers
                .iter()
                .map(|c| (c.to_string(), ResourceValues::default()))
                .collect(),
        }
    }

    /// `samples` CPU and memory samples, `running` running samples.
    fn stats(p95: f64, memory: f64, samples: f64, running: f64) -> PodContainerStats {
        PodContainerStats {
            cpu_p95: Some(p95),
            cpu_max: Some(p95 * 2.0),
            cpu_avg: Some(p95 / 2.0),
            cpu_samples: samples,
            memory_max: Some(memory),
            memory_avg: Some(memory / 2.0),
            memory_samples: samples,
            running,
            ..Default::default()
        }
    }

    fn series(labels: &[(&str, &str)]) -> PromQuerySeries {
        PromQuerySeries {
            labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            points: vec![(END * 1000, 1.0)],
        }
    }

    fn data(series: Vec<PromQuerySeries>) -> PromData {
        PromData {
            result_type: "vector".into(),
            series,
            warnings: Vec::new(),
        }
    }

    /// Owner indexes of `(ns, pod, kind, owner)` and `(ns, replicaset, deployment)`.
    fn owners(pods: &[(&str, &str, &str, &str)], replicasets: &[(&str, &str, &str)]) -> OwnerIndex {
        owners_with_jobs(pods, replicasets, &[])
    }

    /// … and `(ns, job, cronjob)`.
    fn owners_with_jobs(
        pods: &[(&str, &str, &str, &str)],
        replicasets: &[(&str, &str, &str)],
        jobs: &[(&str, &str, &str)],
    ) -> OwnerIndex {
        OwnerIndex::from_data(
            &data(
                pods.iter()
                    .map(|(ns, pod, kind, owner)| {
                        series(&[
                            ("namespace", ns),
                            ("pod", pod),
                            ("owner_kind", kind),
                            ("owner_name", owner),
                        ])
                    })
                    .collect(),
            ),
            &data(
                replicasets
                    .iter()
                    .map(|(ns, rs, deployment)| {
                        series(&[
                            ("namespace", ns),
                            ("replicaset", rs),
                            ("owner_kind", "Deployment"),
                            ("owner_name", deployment),
                        ])
                    })
                    .collect(),
            ),
            &data(
                jobs.iter()
                    .map(|(ns, job, cronjob)| {
                        series(&[
                            ("namespace", ns),
                            ("job_name", job),
                            ("owner_kind", "CronJob"),
                            ("owner_name", cronjob),
                        ])
                    })
                    .collect(),
            ),
        )
    }

    #[derive(Default)]
    struct Fixture {
        workloads: Vec<Workload>,
        batch: StatsBatch,
        hpas: Vec<HpaTarget>,
        partial: HashSet<String>,
        days: u32,
    }

    impl Fixture {
        fn put(&mut self, ns: &str, pod: &str, container: &str, s: PodContainerStats) {
            self.batch
                .containers
                .insert((ns.into(), pod.into(), container.into()), s);
        }

        fn span(&mut self, ns: &str, pod: &str, first_secs: i64, last_secs: i64) {
            self.batch.spans.insert(
                (ns.into(), pod.into()),
                PodSpan {
                    first_secs,
                    last_secs,
                },
            );
        }

        fn fold(&self) -> Folded {
            fold(&FoldInput {
                workloads: &self.workloads,
                batch: &self.batch,
                hpas: &self.hpas,
                start_secs: START,
                end_secs: END,
                days: if self.days == 0 { 1 } else { self.days },
                partial_namespaces: &self.partial,
            })
        }
    }

    /// KubeFit's rollout fixture over one day: `api-old` runs the first
    /// half, `api-new` the second, each with 144 samples.
    fn rollout() -> Fixture {
        let mut f = Fixture {
            workloads: vec![workload("Deployment", "apps", "api", 1, &["api"])],
            ..Default::default()
        };
        f.put(
            "apps",
            "api-old",
            "api",
            stats(100.0, 100.0 * MIB, 144.0, 144.0),
        );
        f.put(
            "apps",
            "api-new",
            "api",
            stats(100.0, 100.0 * MIB, 144.0, 144.0),
        );
        f.span("apps", "api-old", START, START + HALF - 300);
        f.span("apps", "api-new", START + HALF, END - 300);
        f.batch.owners = owners(
            &[
                ("apps", "api-old", "ReplicaSet", "api-5d8f7"),
                ("apps", "api-new", "ReplicaSet", "api-6c9d4"),
            ],
            &[("apps", "api-5d8f7", "api"), ("apps", "api-6c9d4", "api")],
        );
        f
    }

    #[test]
    fn rollout_pods_fold_into_one_deployment() {
        let f = rollout().fold();
        assert_eq!(f.usage.len(), 1);
        let u = &f.usage[&(0, "api".into())];
        assert_eq!((u.stats.cpu_p95, u.stats.memory_max), (100.0, 100.0 * MIB));
        assert_eq!(u.stats.cpu_max, 200.0);
        assert_eq!(
            (u.stats.cpu_avg, u.stats.memory_avg),
            (Some(50.0), Some(50.0 * MIB)),
            "sample-weighted averages"
        );
        assert_eq!(u.stats.hours, 24.0);
        let e = u.evidence.as_ref().unwrap();
        assert_eq!(
            (e.cpu_samples, e.cpu_coverage, e.observed_hours),
            (288.0, Some(1.0), 24.0)
        );
        assert_eq!((e.memory_samples, e.memory_coverage), (288.0, Some(1.0)));
        assert_eq!(e.pods, 2);
        assert_eq!(e.identity, EvidenceIdentity::OwnerMetrics);
        assert!(!e.partial && !e.oom_killed);
        assert_eq!(f.extras.len(), 1);
        assert_eq!(f.extras[0].pods, vec!["api-new", "api-old"]);
        assert!(!f.extras[0].pods_truncated);
        assert_eq!(f.extras[0].identity, EvidenceIdentity::OwnerMetrics);
        assert_eq!(f.report, FoldReport::default());
    }

    #[test]
    fn statefulset_pods_recreated_under_the_same_name_stay_one_row() {
        let mut f = Fixture {
            workloads: vec![workload("StatefulSet", "apps", "db", 1, &["postgres"])],
            ..Default::default()
        };
        // db-0 was recreated mid-window: one pod name, one owner (listed twice).
        f.put(
            "apps",
            "db-0",
            "postgres",
            stats(40.0, 300.0 * MIB, 280.0, 288.0),
        );
        f.span("apps", "db-0", START, END - 300);
        f.batch.owners = owners(
            &[
                ("apps", "db-0", "StatefulSet", "db"),
                ("apps", "db-0", "StatefulSet", "db"),
            ],
            &[],
        );
        let folded = f.fold();
        assert_eq!(folded.usage.len(), 1);
        let e = folded.usage[&(0, "postgres".into())]
            .evidence
            .clone()
            .unwrap();
        assert_eq!(e.identity, EvidenceIdentity::OwnerMetrics);
        assert_eq!(e.pods, 1);
        assert_eq!(e.cpu_coverage, Some(280.0 / 288.0));
        assert_eq!(folded.extras[0].pods, vec!["db-0"]);
        assert_eq!(folded.report.ambiguous_pods, 0);
    }

    #[test]
    fn ambiguous_pod_names_flag_candidates_and_contribute_nothing() {
        let mut f = Fixture {
            workloads: vec![
                workload("Deployment", "apps", "app", 1, &["app"]),
                workload("StatefulSet", "apps", "app-old-set", 1, &["app"]),
            ],
            ..Default::default()
        };
        f.put(
            "apps",
            "app-new",
            "app",
            stats(100.0, 100.0 * MIB, 144.0, 144.0),
        );
        f.put(
            "apps",
            "app-old",
            "app",
            stats(999.0, 999.0 * MIB, 144.0, 144.0),
        );
        f.put("apps", "bare", "app", stats(1.0, MIB, 1.0, 1.0));
        f.put(
            "kube-system",
            "etcd-node1",
            "etcd",
            stats(1.0, MIB, 1.0, 1.0),
        );
        f.put("apps", "gone-5d8f7-aaaaa", "app", stats(1.0, MIB, 1.0, 1.0));
        f.batch.owners = owners(
            &[
                ("apps", "app-new", "ReplicaSet", "app-5d8f7"),
                // The name app-old was used by two owners within the window.
                ("apps", "app-old", "ReplicaSet", "app-6c9d4"),
                ("apps", "app-old", "StatefulSet", "app-old-set"),
                ("apps", "bare", "<none>", "<none>"),
                ("kube-system", "etcd-node1", "Node", "node1"),
                // Owned by a Deployment that no longer exists: no row, not counted.
                ("apps", "gone-5d8f7-aaaaa", "ReplicaSet", "gone-5d8f7"),
            ],
            &[
                ("apps", "app-5d8f7", "app"),
                ("apps", "app-6c9d4", "app"),
                ("apps", "gone-5d8f7", "gone"),
            ],
        );
        let f = f.fold();
        let app = &f.usage[&(0, "app".into())];
        assert_eq!(
            app.evidence.as_ref().unwrap().identity,
            EvidenceIdentity::Ambiguous
        );
        assert_eq!(
            app.stats.cpu_p95, 100.0,
            "the ambiguous pod contributes nothing"
        );
        assert_eq!(app.evidence.as_ref().unwrap().cpu_samples, 144.0);
        assert_eq!(f.extras[0].pods, vec!["app-new"]);
        // The other candidate has no clean pod left: no usage at all, but
        // it is still flagged.
        assert!(!f.usage.contains_key(&(1, "app".into())));
        assert!(f.extras[1].pods.is_empty());
        assert_eq!(f.extras[0].identity, EvidenceIdentity::Ambiguous);
        assert_eq!(f.extras[1].identity, EvidenceIdentity::Ambiguous);
        assert_eq!(f.report.ambiguous_pods, 1);
        assert_eq!(
            f.report,
            FoldReport {
                unowned_pods: 1,
                unsupported_pods: 1,
                ambiguous_pods: 1,
                name_matched: false,
            }
        );
    }

    #[test]
    fn template_containers_decide_what_is_recommended() {
        let mut f = Fixture {
            workloads: vec![workload("Deployment", "apps", "web", 2, &["app", "worker"])],
            ..Default::default()
        };
        f.put(
            "apps",
            "web-7d9f8-x2x9z",
            "app",
            stats(120.0, 200.0 * MIB, 288.0, 288.0),
        );
        // A pod without a memory maximum contributes nothing to the maxima.
        f.put(
            "apps",
            "web-7d9f8-bbbbb",
            "app",
            PodContainerStats {
                memory_max: None,
                ..stats(999.0, 0.0, 288.0, 288.0)
            },
        );
        // An injected sidecar: not in the template, cannot be patched.
        f.put(
            "apps",
            "web-7d9f8-x2x9z",
            "istio-proxy",
            stats(50.0, 64.0 * MIB, 288.0, 288.0),
        );
        // A template container with running samples only: no usage values.
        f.put(
            "apps",
            "web-7d9f8-x2x9z",
            "worker",
            PodContainerStats {
                running: 288.0,
                ..Default::default()
            },
        );
        f.batch.owners = owners(
            &[
                ("apps", "web-7d9f8-x2x9z", "ReplicaSet", "web-7d9f8"),
                ("apps", "web-7d9f8-bbbbb", "ReplicaSet", "web-7d9f8"),
            ],
            &[("apps", "web-7d9f8", "web")],
        );
        let f = f.fold();
        assert!(!f.usage.contains_key(&(0, "istio-proxy".into())));
        assert!(!f.usage.contains_key(&(0, "worker".into())));
        let app = &f.usage[&(0, "app".into())];
        assert_eq!(app.stats.cpu_p95, 120.0);
        assert_eq!(app.stats.memory_max, 200.0 * MIB);
        // Evidence still counts every pod's samples.
        let e = app.evidence.as_ref().unwrap();
        assert_eq!((e.cpu_samples, e.pods), (576.0, 2));
    }

    #[test]
    fn union_hours_merges_overlapping_spans() {
        let spans = [
            PodSpan {
                first_secs: 0,
                last_secs: 3600,
            },
            PodSpan {
                first_secs: 1800,
                last_secs: 7200,
            },
            PodSpan {
                first_secs: 10_000,
                last_secs: 10_300,
            },
        ];
        assert_eq!(union_hours(&spans, 0, 86_400), 2.25);
        // Clipped to the window.
        assert_eq!(union_hours(&spans, 1800, 7200), 1.5);
        assert_eq!(union_hours(&[], 0, 86_400), 0.0);
    }

    #[test]
    fn throttle_ratio_needs_enough_periods_and_duty_averages_running_pods() {
        let mut f = Fixture {
            workloads: vec![
                workload("Deployment", "apps", "api", 1, &["api"]),
                workload("Deployment", "batch", "few", 1, &["few"]),
            ],
            partial: HashSet::from(["apps".to_string()]),
            ..Default::default()
        };
        f.put(
            "apps",
            "api-5d8f7-aaaaa",
            "api",
            PodContainerStats {
                throttled: 30.0,
                periods: 600.0,
                ..stats(100.0, 100.0 * MIB, 144.0, 144.0)
            },
        );
        f.put(
            "apps",
            "api-5d8f7-bbbbb",
            "api",
            PodContainerStats {
                throttled: 20.0,
                periods: 400.0,
                oom: true,
                ..stats(100.0, 100.0 * MIB, 144.0, 144.0)
            },
        );
        f.put(
            "batch",
            "few-6c9d4-ccccc",
            "few",
            PodContainerStats {
                throttled: 100.0,
                periods: 500.0,
                ..stats(100.0, 100.0 * MIB, 12.0, 12.0)
            },
        );
        f.batch.owners = owners(
            &[
                ("apps", "api-5d8f7-aaaaa", "ReplicaSet", "api-5d8f7"),
                ("apps", "api-5d8f7-bbbbb", "ReplicaSet", "api-5d8f7"),
                ("batch", "few-6c9d4-ccccc", "ReplicaSet", "few-6c9d4"),
            ],
            &[("apps", "api-5d8f7", "api"), ("batch", "few-6c9d4", "few")],
        );
        let folded = f.fold();
        let e = folded.usage[&(0, "api".into())].evidence.clone().unwrap();
        let few = folded.usage[&(1, "few".into())].evidence.clone().unwrap();
        assert_eq!(e.throttle_ratio, Some(0.05)); // 50 / 1000
        assert_eq!(few.throttle_ratio, None); // 500 periods
        assert_eq!(e.duty, Some(1.0)); // 288 running × 300 / 86 400
        assert_eq!(few.duty, Some(12.0 * 300.0 / 86_400.0));
        assert!(e.oom_killed && !few.oom_killed);
        assert!(
            e.partial && !few.partial,
            "the namespace's batch was partial"
        );
    }

    #[test]
    fn name_matching_is_the_fallback_without_owner_metrics() {
        let mut f = Fixture {
            workloads: vec![
                workload("Deployment", "apps", "web", 2, &["app"]),
                workload("StatefulSet", "apps", "db", 1, &["db"]),
            ],
            days: 7,
            ..Default::default()
        };
        f.put(
            "apps",
            "web-7d9f8c6b5-x2x9z",
            "app",
            stats(100.0, 100.0 * MIB, 288.0, 0.0),
        );
        f.put(
            "apps",
            "web-7d9f8c6b5-abcde",
            "app",
            stats(150.0, 90.0 * MIB, 288.0, 0.0),
        );
        f.put(
            "apps",
            "unrelated-x",
            "app",
            stats(999.0, 999.0 * MIB, 288.0, 0.0),
        );
        f.put("apps", "db-0", "db", stats(10.0, 10.0 * MIB, 4032.0, 0.0));
        let f = f.fold();
        assert!(f.report.name_matched);
        assert_eq!(f.extras[0].identity, EvidenceIdentity::NameMatch);
        let web = &f.usage[&(0, "app".into())];
        let e = web.evidence.as_ref().unwrap();
        assert_eq!(e.identity, EvidenceIdentity::NameMatch);
        assert_eq!(web.stats.cpu_p95, 150.0);
        assert_eq!(
            f.extras[0].pods,
            vec!["web-7d9f8c6b5-abcde", "web-7d9f8c6b5-x2x9z"]
        );
        // Without running data: no coverage, no duty; hours from samples
        // (576 × 300 s over 2 replicas).
        assert_eq!((e.cpu_coverage, e.duty), (None, None));
        assert!(!e.partial, "matching every pod by name is not partial data");
        assert_eq!((e.observed_hours, web.stats.hours), (24.0, 24.0));
        // … capped at the window (4032 samples = 336 h > 7 days).
        let db = &f.usage[&(1, "db".into())];
        assert_eq!(db.stats.hours, 168.0);
        assert_eq!(db.evidence.as_ref().unwrap().observed_hours, 168.0);
    }

    #[test]
    fn hpa_attaches_by_scale_target() {
        let mut f = rollout();
        f.workloads
            .push(workload("StatefulSet", "apps", "api", 1, &["api"]));
        let info = |name: &str| HpaInfo {
            name: name.into(),
            min_replicas: Some(2),
            max_replicas: 10,
            metrics: vec![HpaMetric {
                resource: HpaResource::Cpu,
                target_utilization: Some(70),
            }],
        };
        f.hpas = vec![
            HpaTarget {
                namespace: "other".into(),
                kind: "Deployment".into(),
                name: "api".into(),
                info: info("elsewhere"),
            },
            HpaTarget {
                namespace: "apps".into(),
                kind: "Deployment".into(),
                name: "api".into(),
                info: info("api"),
            },
        ];
        let f = f.fold();
        assert_eq!(f.extras[0].hpa.as_ref().unwrap().name, "api");
        assert_eq!(f.extras[0].hpa, Some(info("api")));
        assert_eq!(f.extras[1].hpa, None, "same name, another kind");
    }

    #[test]
    fn missing_replicaset_owners_fall_back_to_name_matching() {
        // pod_owners answered, replicaset_owners failed (or an allowlist drops it).
        let mut f = Fixture {
            workloads: vec![
                workload("Deployment", "apps", "api", 2, &["api"]),
                workload("StatefulSet", "apps", "db", 1, &["db"]),
            ],
            ..Default::default()
        };
        f.batch.failed = vec![StatQuery::ReplicasetOwners];
        f.put(
            "apps",
            "api-5d8f7-aaaaa",
            "api",
            stats(100.0, 100.0 * MIB, 288.0, 288.0),
        );
        f.put(
            "apps",
            "api-5d8f7-bbbbb",
            "api",
            stats(80.0, 90.0 * MIB, 288.0, 288.0),
        );
        f.put("apps", "db-0", "db", stats(10.0, 10.0 * MIB, 288.0, 288.0));
        // An orphan whose name matches no live workload stays unowned.
        f.put("apps", "loose-7c8d9-ccccc", "x", stats(1.0, MIB, 1.0, 1.0));
        f.batch.owners = owners(
            &[
                ("apps", "api-5d8f7-aaaaa", "ReplicaSet", "api-5d8f7"),
                ("apps", "api-5d8f7-bbbbb", "ReplicaSet", "api-5d8f7"),
                ("apps", "db-0", "StatefulSet", "db"),
                ("apps", "loose-7c8d9-ccccc", "ReplicaSet", "loose-7c8d9"),
            ],
            &[],
        );
        let f = f.fold();
        let api = &f.usage[&(0, "api".into())];
        assert_eq!(api.stats.cpu_p95, 100.0);
        let e = api.evidence.as_ref().unwrap();
        assert_eq!(
            (e.identity, e.partial, e.pods),
            (EvidenceIdentity::NameMatch, true, 2)
        );
        assert_eq!(f.extras[0].identity, EvidenceIdentity::NameMatch);
        assert_eq!(f.extras[0].pods, vec!["api-5d8f7-aaaaa", "api-5d8f7-bbbbb"]);
        // Pods with a direct owner keep their owner-metrics identity.
        let db = f.usage[&(1, "db".into())].evidence.clone().unwrap();
        assert_eq!(
            (db.identity, db.partial),
            (EvidenceIdentity::OwnerMetrics, false)
        );
        assert_eq!(
            f.report,
            FoldReport {
                unowned_pods: 1,
                ..Default::default()
            }
        );
    }

    #[test]
    fn missing_job_owners_fall_back_to_name_matching() {
        // job_owners answered nothing for the namespace (no failure recorded).
        let mut f = Fixture {
            workloads: vec![
                workload("CronJob", "apps", "nightly", 1, &["job"]),
                workload("CronJob", "batch", "report", 1, &["job"]),
            ],
            ..Default::default()
        };
        f.put(
            "apps",
            "nightly-28765432-abcde",
            "job",
            stats(500.0, 200.0 * MIB, 24.0, 24.0),
        );
        f.put("apps", "manual-kq8xz", "job", stats(1.0, MIB, 1.0, 1.0));
        f.put(
            "batch",
            "report-28765432-fghij",
            "job",
            stats(50.0, 20.0 * MIB, 12.0, 12.0),
        );
        f.put("batch", "adhoc-x1y2z", "job", stats(1.0, MIB, 1.0, 1.0));
        f.batch.owners = owners_with_jobs(
            &[
                ("apps", "nightly-28765432-abcde", "Job", "nightly-28765432"),
                ("apps", "manual-kq8xz", "Job", "manual"),
                ("batch", "report-28765432-fghij", "Job", "report-28765432"),
                ("batch", "adhoc-x1y2z", "Job", "adhoc"),
            ],
            &[],
            // Job owners answered for "batch" only.
            &[("batch", "report-28765432", "report")],
        );
        let f = f.fold();
        let nightly = f.usage[&(0, "job".into())].evidence.clone().unwrap();
        assert_eq!(
            (nightly.identity, nightly.partial),
            (EvidenceIdentity::NameMatch, true)
        );
        assert_eq!(f.extras[0].pods, vec!["nightly-28765432-abcde"]);
        let report = f.usage[&(1, "job".into())].evidence.clone().unwrap();
        assert_eq!(
            (report.identity, report.partial),
            (EvidenceIdentity::OwnerMetrics, false)
        );
        // manual matches no live CronJob; adhoc is a standalone Job where job
        // owners did answer.
        assert_eq!(f.report.unowned_pods, 2);
    }

    #[test]
    fn pod_names_are_sorted_and_capped() {
        let mut f = Fixture {
            workloads: vec![workload("DaemonSet", "ops", "agent", 60, &["agent"])],
            ..Default::default()
        };
        let mut pods = Vec::new();
        for i in (0..60).rev() {
            let pod = format!("agent-{i:05}");
            f.put("ops", &pod, "agent", stats(10.0, 10.0 * MIB, 288.0, 288.0));
            pods.push(("ops", pod, "DaemonSet", "agent"));
        }
        let refs: Vec<(&str, &str, &str, &str)> = pods
            .iter()
            .map(|(ns, pod, kind, owner)| (*ns, pod.as_str(), *kind, *owner))
            .collect();
        f.batch.owners = owners(&refs, &[]);
        let f = f.fold();
        assert_eq!(f.extras[0].pods.len(), MAX_POD_NAMES);
        assert_eq!(f.extras[0].pods[0], "agent-00000");
        assert!(f.extras[0].pods_truncated);
        assert_eq!(
            f.usage[&(0, "agent".into())]
                .evidence
                .as_ref()
                .unwrap()
                .pods,
            60
        );
    }
}
