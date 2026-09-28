//! Right-sizing: CPU / memory requests (and memory limits) per container
//! from usage history, and the patch that applies them.
//!
//! - **Workloads**: Deployments, StatefulSets, DaemonSets and CronJobs in
//!   scope, with the resources of their pod template (a CronJob's job
//!   template). A CronJob counts one replica; its cost follows the
//!   observed duty cycle ([`math::cost_replicas`]).
//! - **Usage**: Prometheus when available, through the collection pipeline
//!   ([`collect`]): 16 statistics queries per batch
//!   ([`crate::prometheus::workload_stats`]), pods resolved to workloads by
//!   kube-state-metrics owners ([`ownership`]) or by the names their kind
//!   generates, folded into usage and evidence ([`evidence`]). Without
//!   Prometheus, the last hour of metrics-server samples
//!   ([`crate::metrics_history`]), split per container by the current
//!   snapshot — always low confidence.
//! - **Strategies** ([`strategy`]): the recommendation math sits behind
//!   [`strategy::RecommendationStrategy`] (usage stats + current values in,
//!   values + confidence + warnings out): [`workload_history`] when owner
//!   metrics resolved the pods, else [`percentile`] (p95 / max + headroom).
//!   Evidence flags cap the confidence ([`strategy::apply_evidence`]);
//!   limits a new request would exceed are raised proportionally for every
//!   strategy ([`strategy::finalize`]).
//! - **Apply** ([`patch`]): a strategic merge patch of the pod template's
//!   container resources (`spec.jobTemplate.spec.template` for CronJobs),
//!   dry-run first (allowed on read-only clusters), then applied (refused
//!   on read-only clusters).

pub mod collect;
pub mod evidence;
pub mod export;
pub mod math;
pub mod ownership;
pub mod patch;
pub mod percentile;
pub mod reevaluate;
pub mod strategy;
pub mod summary;
pub mod types;
pub mod workload_history;

pub use reevaluate::reevaluate;
pub use types::*;

use std::collections::HashMap;

use anyhow::{anyhow, bail, Context, Result};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::CronJob;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Patch, PatchParams};
use kube::Client;
use regex::Regex;
use serde_json::Value;

use crate::app::Kubepit;
use crate::cost::estimate::{is_active, workload_of};
use crate::cost::lists;
use crate::dry_run::dry_run_operation;
use crate::error::kube_error;
use crate::metrics_history::SAMPLE_INTERVAL;
use crate::objects::to_kube_object;
use crate::prometheus::promql::workload_pod_regex;
use crate::quantity::{parse_cpu_millicores, parse_memory_bytes};
use crate::resources::object_api;
use crate::types::{DryRunResult, Gvk, MetricsHistoryQuery, PodMetric};
use evidence::{ContainerUsage, WorkloadExtras, WorkloadUsage};

/// A workload with the resources of its pod template.
#[derive(Debug, Clone, PartialEq)]
pub struct Workload {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub uid: String,
    pub replicas: u32,
    pub containers: Vec<(String, ResourceValues)>,
}

fn resources_of(container: &Value) -> ResourceValues {
    let get = |section: &str, key: &str| {
        container
            .pointer(&format!("/resources/{section}/{key}"))
            .and_then(Value::as_str)
    };
    ResourceValues {
        cpu_request: get("requests", "cpu").and_then(parse_cpu_millicores),
        cpu_limit: get("limits", "cpu").and_then(parse_cpu_millicores),
        memory_request: get("requests", "memory").and_then(parse_memory_bytes),
        memory_limit: get("limits", "memory").and_then(parse_memory_bytes),
    }
}

/// The workload of a Deployment / StatefulSet / DaemonSet / CronJob object:
/// the containers at its [`patch::template_path`] and its replicas (a
/// DaemonSet's desired pods; one for a CronJob). `None` for other kinds.
pub fn workload_from_value(kind: &str, obj: &Value) -> Option<Workload> {
    let text = |p: &str| obj.pointer(p).and_then(Value::as_str).map(str::to_string);
    let replicas = match kind {
        "DaemonSet" => obj
            .pointer("/status/desiredNumberScheduled")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        "CronJob" => 1,
        _ => obj
            .pointer("/spec/replicas")
            .and_then(Value::as_u64)
            .unwrap_or(1),
    };
    let containers = obj
        .pointer(&format!(
            "/{}/containers",
            patch::template_path(kind)?.join("/")
        ))
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|c| Some((c.get("name")?.as_str()?.to_string(), resources_of(c))))
        .collect();
    Some(Workload {
        kind: kind.to_string(),
        namespace: text("/metadata/namespace")?,
        name: text("/metadata/name")?,
        uid: text("/metadata/uid").unwrap_or_default(),
        replicas: u32::try_from(replicas).unwrap_or(u32::MAX),
        containers,
    })
}

/// Maps pod names to workloads of the same namespace.
pub struct PodMatcher {
    by_namespace: HashMap<String, Vec<(usize, Regex, usize)>>,
}

impl PodMatcher {
    pub fn new(workloads: &[Workload]) -> Self {
        let mut by_namespace: HashMap<String, Vec<(usize, Regex, usize)>> = HashMap::new();
        for (i, w) in workloads.iter().enumerate() {
            let pattern = format!("^(?:{})$", workload_pod_regex(&w.kind, &w.name));
            if let Ok(re) = Regex::new(&pattern) {
                by_namespace
                    .entry(w.namespace.clone())
                    .or_default()
                    .push((i, re, w.name.len()));
            }
        }
        Self { by_namespace }
    }

    /// The workload a pod belongs to; the longest matching name wins, so the
    /// pods of `web-api` never count for `web`.
    pub fn find(&self, namespace: &str, pod: &str) -> Option<usize> {
        self.find_where(namespace, pod, |_| true)
    }

    /// [`find`](Self::find) among the workloads `keep` accepts (by index).
    pub fn find_where(
        &self,
        namespace: &str,
        pod: &str,
        keep: impl Fn(usize) -> bool,
    ) -> Option<usize> {
        self.by_namespace
            .get(namespace)?
            .iter()
            .filter(|(i, re, _)| keep(*i) && re.is_match(pod))
            .max_by_key(|(_, _, len)| *len)
            .map(|(i, _, _)| *i)
    }
}

/// Share of each container in a pod's usage `(cpu, memory)`, from the
/// current snapshot; an even split when unknown.
pub fn container_shares(metric: Option<&PodMetric>, containers: &[String]) -> Vec<(f64, f64)> {
    let even = 1.0 / containers.len().max(1) as f64;
    let Some(m) = metric.filter(|m| m.cpu_millicores > 0.0 || m.memory_bytes > 0.0) else {
        return vec![(even, even); containers.len()];
    };
    containers
        .iter()
        .map(|name| {
            let c = m.containers.iter().find(|c| &c.name == name);
            let share = |part: f64, total: f64| if total > 0.0 { part / total } else { even };
            match c {
                Some(c) => (
                    share(c.cpu_millicores, m.cpu_millicores),
                    share(c.memory_bytes, m.memory_bytes),
                ),
                None => (0.0, 0.0),
            }
        })
        .collect()
}

/// The recommendation of one workload: its containers through `strategy`
/// (with their evidence and the HPA of `extras`), then the shared builder
/// [`math::workload_recommendation`] with the pods, HPA and identity of
/// `extras` (money at [`math::cost_replicas`]; an ambiguous identity flags
/// every container, also those left without usage).
#[allow(clippy::too_many_arguments)]
pub fn recommend_workload(
    w: &Workload,
    usage: &WorkloadUsage,
    index: usize,
    extras: &WorkloadExtras,
    source: RightsizingSource,
    settings: &RightsizingSettings,
    pricing: &crate::cost::CostPricing,
    strategy: &dyn strategy::RecommendationStrategy,
) -> WorkloadRecommendation {
    let containers: Vec<ContainerRecommendation> = w
        .containers
        .iter()
        .map(|(name, current)| {
            let u = usage.get(&(index, name.clone()));
            let input = strategy::ContainerInput {
                name,
                current: *current,
                usage: u.map(|u| u.stats),
                source,
                settings,
                evidence: u.and_then(|u| u.evidence.as_ref()),
                hpa: extras.hpa.as_ref(),
            };
            strategy::recommend(strategy, &input)
        })
        .collect();
    let facts = math::WorkloadFacts {
        kind: w.kind.clone(),
        namespace: w.namespace.clone(),
        name: w.name.clone(),
        uid: w.uid.clone(),
        replicas: w.replicas,
        pods: extras.pods.clone(),
        pods_truncated: extras.pods_truncated,
        hpa: extras.hpa.clone(),
        identity: extras.identity,
    };
    math::workload_recommendation(facts, containers, pricing)
}

/// Changed first, then the largest saving, then the largest increase.
pub fn sort_recommendations(list: &mut [WorkloadRecommendation]) {
    list.sort_by(|a, b| {
        b.changed
            .cmp(&a.changed)
            .then_with(|| {
                a.monthly_delta
                    .partial_cmp(&b.monthly_delta)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.namespace.cmp(&b.namespace))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// The API resource of a kind right-sizing covers: `apps/v1` Deployments,
/// StatefulSets and DaemonSets, `batch/v1` CronJobs; `None` otherwise.
pub(crate) fn workload_gvk(kind: &str) -> Option<Gvk> {
    let (group, plural) = match kind {
        "Deployment" => ("apps", "deployments"),
        "StatefulSet" => ("apps", "statefulsets"),
        "DaemonSet" => ("apps", "daemonsets"),
        "CronJob" => ("batch", "cronjobs"),
        _ => return None,
    };
    Some(Gvk {
        group: group.into(),
        version: "v1".into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced: true,
    })
}

/// The error for a kind right-sizing does not cover.
const UNSUPPORTED_KIND: &str =
    "right-sizing supports Deployments, StatefulSets, DaemonSets and CronJobs";

/// The API resource and pod spec path of `kind`, or [`UNSUPPORTED_KIND`].
fn supported(kind: &str) -> Result<(Gvk, &'static [&'static str])> {
    workload_gvk(kind)
        .zip(patch::template_path(kind))
        .ok_or_else(|| anyhow!(UNSUPPORTED_KIND))
}

fn to_values<T: serde::Serialize>(items: Option<Vec<T>>) -> Vec<Value> {
    items
        .unwrap_or_default()
        .iter()
        .filter_map(|o| serde_json::to_value(o).ok())
        .collect()
}

/// Deployments, StatefulSets, DaemonSets and CronJobs of `namespaces` (all
/// when empty, falling back to `accessible` when listing cluster-wide is
/// forbidden).
async fn workloads_in_scope(
    client: &Client,
    namespaces: &[String],
    accessible: &[String],
) -> Result<Vec<Workload>> {
    let (deployments, statefulsets, daemonsets, cronjobs) = futures::future::join4(
        lists::namespaced::<Deployment>(client, namespaces, accessible),
        lists::namespaced::<StatefulSet>(client, namespaces, accessible),
        lists::namespaced::<DaemonSet>(client, namespaces, accessible),
        lists::namespaced::<CronJob>(client, namespaces, accessible),
    )
    .await;
    let deployments = deployments?.ok_or_else(|| {
        anyhow!("workloads cannot be listed cluster-wide; choose namespaces first")
    })?;
    let mut out = Vec::new();
    for (kind, values) in [
        ("Deployment", to_values(Some(deployments))),
        ("StatefulSet", to_values(statefulsets.ok().flatten())),
        ("DaemonSet", to_values(daemonsets.ok().flatten())),
        ("CronJob", to_values(cronjobs.ok().flatten())),
    ] {
        out.extend(values.iter().filter_map(|o| workload_from_value(kind, o)));
    }
    Ok(out)
}

impl Kubepit {
    /// `rightsizing_report`: recommendations for the workloads in scope,
    /// through the collection pipeline ([`collect`]).
    pub async fn rightsizing_report(
        &self,
        cluster_id: &str,
        request: &RightsizingRequest,
    ) -> Result<RightsizingReport> {
        // The live report keeps its fallback; scans read `source_abort`.
        self.compute_rightsizing(cluster_id, request, &|_| {})
            .await
            .map(|outcome| outcome.report)
    }

    /// Container usage from the last hour of metrics-server samples.
    /// `Ok(None)` when there is no history at all.
    async fn metrics_server_usage(
        &self,
        cluster_id: &str,
        client: &Client,
        workloads: &[Workload],
        namespaces: &[String],
        accessible: &[String],
    ) -> Result<Option<WorkloadUsage>> {
        let pods = lists::namespaced::<Pod>(client, namespaces, accessible)
            .await?
            .ok_or_else(|| anyhow!("pods cannot be listed"))?;
        let index: HashMap<(String, String, String), usize> = workloads
            .iter()
            .enumerate()
            .map(|(i, w)| ((w.namespace.clone(), w.kind.clone(), w.name.clone()), i))
            .collect();
        let snapshot: HashMap<(String, String), PodMetric> =
            match self.metrics_pods(cluster_id, None).await {
                Ok(m) if m.available => m
                    .items
                    .into_iter()
                    .map(|p| ((p.namespace.clone(), p.name.clone()), p))
                    .collect(),
                _ => HashMap::new(),
            };
        let interval = SAMPLE_INTERVAL.as_secs_f64();
        let mut grouped: HashMap<(usize, String), Vec<UsageStats>> = HashMap::new();
        let mut any_history = false;
        for pod in pods.iter().filter(|p| is_active(p)) {
            let (Some(ns), Some(name)) =
                (pod.metadata.namespace.clone(), pod.metadata.name.clone())
            else {
                continue;
            };
            let Some((kind, owner)) = workload_of(pod) else {
                continue;
            };
            let Some(&i) = index.get(&(ns.clone(), kind, owner)) else {
                continue;
            };
            let series = self.metrics_history(
                cluster_id,
                &MetricsHistoryQuery::Pods {
                    namespace: ns.clone(),
                    names: vec![name.clone()],
                },
            )?;
            if series.points.is_empty() {
                continue;
            }
            any_history = true;
            let names: Vec<String> = workloads[i]
                .containers
                .iter()
                .map(|(n, _)| n.clone())
                .collect();
            let shares = container_shares(snapshot.get(&(ns, name)), &names);
            for (container, (cpu_share, mem_share)) in names.iter().zip(shares) {
                let cpu: Vec<f64> = series
                    .points
                    .iter()
                    .map(|p| p.cpu_millicores * cpu_share)
                    .collect();
                let mem: Vec<f64> = series
                    .points
                    .iter()
                    .map(|p| p.memory_bytes * mem_share)
                    .collect();
                if let Some(stats) = math::stats_from_samples(&cpu, &mem, interval) {
                    grouped
                        .entry((i, container.clone()))
                        .or_default()
                        .push(stats);
                }
            }
        }
        if !any_history {
            return Ok(None);
        }
        Ok(Some(
            grouped
                .into_iter()
                .filter_map(|((i, container), list)| {
                    let mut merged = math::combine(&list)?;
                    merged.hours =
                        (merged.hours / f64::from(workloads[i].replicas.max(1))).min(1.0);
                    Some((
                        (i, container),
                        ContainerUsage {
                            stats: merged,
                            evidence: None,
                        },
                    ))
                })
                .collect(),
        ))
    }

    /// `rightsizing_apply` without the audit log (see `history/audited.rs`):
    /// patch the pod template's container resources. `dry_run` asks the API
    /// server what would happen (allowed on read-only clusters); otherwise the
    /// cluster must be writable.
    pub(crate) async fn rightsizing_apply_unaudited(
        &self,
        cluster_id: &str,
        target: &WorkloadRef,
        changes: &[ContainerResourceChange],
        dry_run: bool,
    ) -> Result<DryRunResult> {
        let (gvk, path) = supported(&target.kind)?;
        patch::validate(changes)?;
        if !dry_run {
            self.ensure_writable(cluster_id, "right-size")?;
        }
        let client = self.client(cluster_id).await?;
        let (api, ar) = object_api(client, &gvk, Some(&target.namespace))?;
        let live = api
            .get(&target.name)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to get {} {}", target.kind, target.name))?;
        let live = to_kube_object(live, &ar);
        let names = patch::live_containers(&live, path);
        if let Some(missing) = changes.iter().find(|c| !names.contains(&c.container)) {
            bail!(
                "{} {} has no container \"{}\"",
                target.kind,
                target.name,
                missing.container
            );
        }
        let body = patch::resources_patch(
            path,
            changes,
            Some(&patch::change_cause(&target.kind, &target.name)),
        );
        let params = PatchParams {
            dry_run,
            ..Default::default()
        };
        let result = api
            .patch(&target.name, &params, &Patch::Strategic(&body))
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to right-size {} {}", target.kind, target.name))?;
        let result = to_kube_object(result, &ar);
        Ok(DryRunResult {
            api_version: gvk.api_version(),
            kind: target.kind.clone(),
            name: target.name.clone(),
            namespace: Some(target.namespace.clone()),
            operation: dry_run_operation(Some(&live), &result),
            live: Some(live),
            result: Some(result),
            error: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::CostPricing;
    use crate::types::ContainerMetric;
    use evidence::WorkloadExtras;
    use serde_json::json;

    const MIB: f64 = 1024.0 * 1024.0;

    fn deployment(ns: &str, name: &str, replicas: u64) -> Value {
        json!({
            "metadata": {"name": name, "namespace": ns, "uid": format!("uid-{name}")},
            "spec": {"replicas": replicas, "template": {"spec": {"containers": [
                {"name": "app", "resources": {"requests": {"cpu": "1", "memory": "1Gi"}, "limits": {"memory": "1Gi"}}},
                {"name": "proxy", "resources": {}}
            ]}}}
        })
    }

    #[test]
    fn workloads_read_template_resources_and_replicas() {
        let w = workload_from_value("Deployment", &deployment("shop", "web", 3)).unwrap();
        assert_eq!(w.replicas, 3);
        assert_eq!(w.containers.len(), 2);
        assert_eq!(w.containers[0].1.cpu_request, Some(1000.0));
        assert_eq!(w.containers[0].1.memory_limit, Some(1024.0 * MIB));
        assert_eq!(w.containers[1].1, ResourceValues::default());
        let ds = json!({"metadata": {"name": "agent", "namespace": "ops"},
                        "spec": {"template": {"spec": {"containers": [{"name": "a"}]}}},
                        "status": {"desiredNumberScheduled": 5}});
        assert_eq!(workload_from_value("DaemonSet", &ds).unwrap().replicas, 5);
        let no_replicas = json!({"metadata": {"name": "x", "namespace": "a"},
                                 "spec": {"template": {"spec": {"containers": []}}}});
        assert_eq!(
            workload_from_value("StatefulSet", &no_replicas)
                .unwrap()
                .replicas,
            1
        );
        assert!(workload_from_value("Deployment", &json!({"metadata": {}})).is_none());
    }

    fn cronjob() -> Value {
        json!({
            "metadata": {"name": "nightly", "namespace": "apps", "uid": "uid-nightly"},
            "spec": {"schedule": "0 2 * * *", "jobTemplate": {"spec": {"template": {"spec": {
                "containers": [{"name": "job", "resources": {"requests": {"cpu": "500m", "memory": "1Gi"}}}]
            }}}}}
        })
    }

    #[test]
    fn cronjob_templates_are_read() {
        let w = workload_from_value("CronJob", &cronjob()).unwrap();
        assert_eq!(
            (w.kind.as_str(), w.namespace.as_str(), w.name.as_str()),
            ("CronJob", "apps", "nightly")
        );
        assert_eq!(
            w.replicas, 1,
            "one Job at a time; the cost uses the duty cycle"
        );
        assert_eq!(w.containers[0].0, "job");
        assert_eq!(w.containers[0].1.cpu_request, Some(500.0));
        assert_eq!(w.containers[0].1.memory_request, Some(1024.0 * MIB));
        // A CronJob's pod template is only read at the job template.
        let misplaced = json!({"metadata": {"name": "x", "namespace": "a"},
                               "spec": {"template": {"spec": {"containers": [{"name": "job"}]}}}});
        assert!(workload_from_value("CronJob", &misplaced).is_none());
    }

    #[test]
    fn workload_kinds_have_their_api_group() {
        let d = workload_gvk("Deployment").unwrap();
        assert_eq!(
            (d.api_version(), d.plural.as_str()),
            ("apps/v1".into(), "deployments")
        );
        assert_eq!(workload_gvk("StatefulSet").unwrap().plural, "statefulsets");
        assert_eq!(workload_gvk("DaemonSet").unwrap().plural, "daemonsets");
        let c = workload_gvk("CronJob").unwrap();
        assert_eq!(
            (
                c.api_version(),
                c.kind.as_str(),
                c.plural.as_str(),
                c.namespaced
            ),
            ("batch/v1".into(), "CronJob", "cronjobs", true)
        );
        assert!(workload_gvk("Job").is_none());
        assert!(workload_gvk("Pod").is_none());
    }

    #[test]
    fn cronjob_cost_follows_the_duty_cycle() {
        let pricing = CostPricing {
            currency: "USD".into(),
            cpu_hour: 0.04,
            memory_gib_hour: 0.005,
            gpu_hour: None,
            storage_gib_month: None,
            discount_percent: 0.0,
        };
        let nightly = workload_from_value("CronJob", &cronjob()).unwrap();
        let stats = UsageStats {
            cpu_p95: 120.0,
            cpu_max: 300.0,
            memory_max: 300.0 * MIB,
            hours: 96.0,
            cpu_avg: None,
            memory_avg: None,
        };
        let usage_with = |duty: Option<f64>| -> WorkloadUsage {
            [(
                (0, "job".to_string()),
                ContainerUsage {
                    stats,
                    evidence: duty.map(|d| UsageEvidence {
                        duty: Some(d),
                        ..UsageEvidence::default()
                    }),
                },
            )]
            .into()
        };
        let recommend = |w: &Workload, usage: &WorkloadUsage| {
            recommend_workload(
                w,
                usage,
                0,
                &WorkloadExtras::default(),
                RightsizingSource::Prometheus,
                &RightsizingSettings::default(),
                &pricing,
                strategy::strategy(None).unwrap(),
            )
        };
        // 72 running 5-minute slots of 288 in a day: a quarter of a replica.
        let quarter = recommend(&nightly, &usage_with(Some(0.25)));
        assert_eq!(quarter.cost_replicas, 0.25);
        let always = recommend(&nightly, &usage_with(None));
        assert_eq!(always.cost_replicas, 1.0, "without evidence: one replica");
        assert!(quarter.monthly_current > 0.0);
        assert!((quarter.monthly_current * 4.0 - always.monthly_current).abs() < 1e-9);
        assert!((quarter.monthly_delta * 4.0 - always.monthly_delta).abs() < 1e-9);

        // Other kinds keep their replicas, whatever the duty.
        let mut web = workload_from_value("Deployment", &deployment("shop", "web", 3)).unwrap();
        web.containers.truncate(1);
        web.containers[0].0 = "job".into();
        assert_eq!(recommend(&web, &usage_with(Some(0.25))).cost_replicas, 3.0);
    }

    #[test]
    fn pods_match_the_most_specific_workload() {
        let workloads = vec![
            workload_from_value("Deployment", &deployment("shop", "web", 2)).unwrap(),
            workload_from_value("Deployment", &deployment("shop", "web-api", 1)).unwrap(),
            Workload {
                kind: "StatefulSet".into(),
                namespace: "db".into(),
                name: "pg".into(),
                uid: String::new(),
                replicas: 1,
                containers: vec![],
            },
        ];
        let m = PodMatcher::new(&workloads);
        assert_eq!(m.find("shop", "web-7d9f8c6b5-x2x9z"), Some(0));
        assert_eq!(m.find("shop", "web-api-7d9f8c6b5-x2x9z"), Some(1));
        assert_eq!(m.find("db", "pg-0"), Some(2));
        assert_eq!(m.find("db", "pg-backup-0"), None);
        assert_eq!(m.find("other", "web-7d9f8c6b5-x2x9z"), None);
    }

    fn pricing() -> CostPricing {
        CostPricing {
            currency: "USD".into(),
            cpu_hour: 0.04,
            memory_gib_hour: 0.005,
            gpu_hour: None,
            storage_gib_month: None,
            discount_percent: 0.0,
        }
    }

    fn app_usage(
        p95: f64,
        memory: f64,
        hours: f64,
        evidence: Option<UsageEvidence>,
    ) -> WorkloadUsage {
        [(
            (0, "app".to_string()),
            ContainerUsage {
                stats: UsageStats {
                    cpu_p95: p95,
                    cpu_max: p95 * 2.0,
                    memory_max: memory,
                    hours,
                    cpu_avg: None,
                    memory_avg: None,
                },
                evidence,
            },
        )]
        .into()
    }

    #[test]
    fn workloads_are_recommended_and_sorted() {
        let web = workload_from_value("Deployment", &deployment("shop", "web", 2)).unwrap();
        let usage = app_usage(150.0, 200.0 * MIB, 168.0, None);
        let rec = recommend_workload(
            &web,
            &usage,
            0,
            &WorkloadExtras::default(),
            RightsizingSource::Prometheus,
            &RightsizingSettings::default(),
            &pricing(),
            strategy::strategy(None).unwrap(),
        );
        assert_eq!(rec.confidence, Confidence::High);
        assert_eq!(rec.lenses, summary::lenses_of(&rec), "lenses are set");
        assert!(rec.lenses.contains(&RecommendationLens::CpuReduction));
        assert!(rec.changed);
        assert!(rec.monthly_delta < 0.0, "a saving");
        // The proxy container has no usage: untouched (and it does not lower the confidence).
        assert_eq!(rec.containers[1].usage, None);
        assert!(!rec.containers[1].changed());
        assert_eq!(rec.verdict, Verdict::Over);
        assert_eq!(rec.cost_replicas, 2.0);
        let mut list = vec![
            WorkloadRecommendation {
                changed: false,
                monthly_delta: 0.0,
                ..rec.clone()
            },
            rec.clone(),
        ];
        sort_recommendations(&mut list);
        assert!(list[0].changed);
    }

    #[test]
    fn folded_evidence_reaches_the_strategy() {
        // An OOM kill and 10 observed hours, run through workload-history:
        // the flags cap the confidence and the OOM floor lifts the memory
        // base to the current 1 GiB limit (200 MiB + 20 % without it).
        let web = workload_from_value("Deployment", &deployment("shop", "web", 2)).unwrap();
        let evidence = UsageEvidence {
            oom_killed: true,
            observed_hours: 10.0,
            cpu_coverage: Some(1.0),
            memory_coverage: Some(1.0),
            identity: EvidenceIdentity::OwnerMetrics,
            ..UsageEvidence::default()
        };
        let recommend = |evidence: Option<UsageEvidence>| {
            recommend_workload(
                &web,
                &app_usage(100.0, 200.0 * MIB, 10.0, evidence),
                0,
                &WorkloadExtras::default(),
                RightsizingSource::Prometheus,
                &workload_history::WorkloadHistory::defaults(),
                &pricing(),
                strategy::strategy(Some("workload-history")).unwrap(),
            )
        };
        let rec = recommend(Some(evidence.clone()));
        let app = &rec.containers[0];
        let codes: Vec<&str> = app.warnings.iter().map(|w| w.code.as_str()).collect();
        assert!(codes.contains(&"oom-killed"), "{codes:?}");
        assert!(codes.contains(&"insufficient-history"), "{codes:?}");
        assert_eq!(app.evidence.as_ref(), Some(&evidence));
        assert_eq!(
            (app.confidence, rec.confidence),
            (Confidence::Low, Confidence::Low)
        );
        assert_eq!(
            app.recommended.memory_request,
            Some(1229.0 * MIB),
            "the OOM floor"
        );
        assert!(app.memory_limit_raised);
        assert_eq!(rec.verdict, Verdict::Under);

        // Without the evidence none of it happens.
        let plain = recommend(None);
        assert_eq!(
            plain.containers[0].recommended.memory_request,
            Some(240.0 * MIB)
        );
        assert!(plain.containers[0]
            .warnings
            .iter()
            .all(|w| w.code != "oom-killed"));
        assert_ne!(plain.verdict, Verdict::Under);
    }

    #[test]
    fn workload_extras_reach_the_row() {
        let web = workload_from_value("Deployment", &deployment("shop", "web", 2)).unwrap();
        let hpa = HpaInfo {
            name: "web".into(),
            min_replicas: Some(2),
            max_replicas: 6,
            metrics: vec![],
        };
        let extras = WorkloadExtras {
            pods: vec!["web-1".into(), "web-2".into()],
            pods_truncated: true,
            hpa: Some(hpa.clone()),
            identity: EvidenceIdentity::Ambiguous,
        };
        let rec = recommend_workload(
            &web,
            &app_usage(150.0, 200.0 * MIB, 168.0, None),
            0,
            &extras,
            RightsizingSource::Prometheus,
            &RightsizingSettings::default(),
            &pricing(),
            strategy::strategy(None).unwrap(),
        );
        assert_eq!(rec.pods, extras.pods);
        assert!(rec.pods_truncated);
        assert_eq!(rec.hpa, Some(hpa));
        assert!(rec.containers[0]
            .warnings
            .iter()
            .any(|w| w.code == "hpa-target"));
        // An ambiguous identity flags every container, with usage or not.
        for c in &rec.containers {
            assert!(
                c.warnings.iter().any(|w| w.code == "identity-unclear"),
                "{}: {:?}",
                c.name,
                c.warnings
            );
            assert_eq!(c.confidence, Confidence::Low);
        }
    }

    #[test]
    fn container_shares_follow_the_snapshot() {
        let names = vec!["app".to_string(), "proxy".to_string()];
        assert_eq!(container_shares(None, &names), vec![(0.5, 0.5), (0.5, 0.5)]);
        let metric = PodMetric {
            namespace: "a".into(),
            name: "p".into(),
            cpu_millicores: 100.0,
            memory_bytes: 400.0,
            containers: vec![
                ContainerMetric {
                    name: "app".into(),
                    cpu_millicores: 75.0,
                    memory_bytes: 100.0,
                },
                ContainerMetric {
                    name: "proxy".into(),
                    cpu_millicores: 25.0,
                    memory_bytes: 300.0,
                },
            ],
        };
        assert_eq!(
            container_shares(Some(&metric), &names),
            vec![(0.75, 0.25), (0.25, 0.75)]
        );
    }
}
