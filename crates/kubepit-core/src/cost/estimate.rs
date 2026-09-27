//! Cost estimates from requests (plus usage when known) × a price model.
//!
//! - Each running or pending pod costs its effective requests (the larger of
//!   the containers' sum and the largest init container, like the
//!   scheduler), or its usage when that is higher and known, at the price
//!   model's hourly prices.
//! - Nodes cost their capacity; what pods do not request is idle. Without
//!   node access the total is the allocated cost and idle is unknown.
//! - Persistent volume claims cost their capacity per GiB-month and belong
//!   to the group of the (first) pod mounting them; unmounted claims are
//!   unallocated.
//!
//! Everything here is a pure function of listed objects, so it is tested
//! without a cluster.

use std::collections::{BTreeMap, HashMap};

use k8s_openapi::api::core::v1::{Container, Node, PersistentVolumeClaim, Pod};

use super::allocation::{add_opt, sort_items, totals, IDLE, UNALLOCATED};
use super::types::{CostAggregate, CostItem, CostPricing, CostSpecial, CostTotals, CostTrendPoint};
use crate::quantity::{cpu_or_zero, memory_or_zero, parse_quantity};

/// Extended resources counted as GPUs.
pub const GPU_RESOURCES: &[&str] = &["nvidia.com/gpu", "amd.com/gpu", "gpu.intel.com/i915"];

/// Average usage of one pod over the report window.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PodUsage {
    pub cpu_cores: f64,
    pub memory_bytes: f64,
}

/// Usage per `(namespace, pod)`.
pub type UsageMap = HashMap<(String, String), PodUsage>;

pub struct EstimateInput<'a> {
    pub pods: &'a [Pod],
    /// `None` when nodes cannot be listed.
    pub nodes: Option<&'a [Node]>,
    /// `None` when claims cannot be listed.
    pub pvcs: Option<&'a [PersistentVolumeClaim]>,
    pub usage: Option<&'a UsageMap>,
    pub pricing: &'a CostPricing,
    pub aggregate: CostAggregate,
    pub label: Option<&'a str>,
}

/// Requests of a pod: `(cpu cores, memory bytes, gpus)`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PodRequests {
    pub cpu_cores: f64,
    pub memory_bytes: f64,
    pub gpus: f64,
}

fn container_requests(c: &Container) -> PodRequests {
    let resources = c.resources.as_ref();
    let requests = resources.and_then(|r| r.requests.as_ref());
    let limits = resources.and_then(|r| r.limits.as_ref());
    let get = |key: &str| requests.and_then(|m| m.get(key)).map(|q| q.0.as_str());
    // Extended resources may be set as limits only (requests default to them).
    let gpus = GPU_RESOURCES
        .iter()
        .map(|key| {
            get(key)
                .or_else(|| limits.and_then(|m| m.get(*key)).map(|q| q.0.as_str()))
                .and_then(parse_quantity)
                .unwrap_or(0.0)
        })
        .sum();
    PodRequests {
        cpu_cores: cpu_or_zero(get("cpu")) / 1000.0,
        memory_bytes: memory_or_zero(get("memory")),
        gpus,
    }
}

/// Effective requests: per resource the larger of the containers' sum and
/// the largest init container, plus the pod overhead.
pub fn pod_requests(pod: &Pod) -> PodRequests {
    let Some(spec) = pod.spec.as_ref() else {
        return PodRequests::default();
    };
    let mut sum = PodRequests::default();
    for c in &spec.containers {
        let r = container_requests(c);
        sum.cpu_cores += r.cpu_cores;
        sum.memory_bytes += r.memory_bytes;
        sum.gpus += r.gpus;
    }
    for c in spec.init_containers.iter().flatten() {
        let r = container_requests(c);
        sum.cpu_cores = sum.cpu_cores.max(r.cpu_cores);
        sum.memory_bytes = sum.memory_bytes.max(r.memory_bytes);
        sum.gpus = sum.gpus.max(r.gpus);
    }
    if let Some(overhead) = spec.overhead.as_ref() {
        sum.cpu_cores += cpu_or_zero(overhead.get("cpu").map(|q| q.0.as_str())) / 1000.0;
        sum.memory_bytes += memory_or_zero(overhead.get("memory").map(|q| q.0.as_str()));
    }
    sum
}

/// Pods that hold resources (not finished).
pub fn is_active(pod: &Pod) -> bool {
    let phase = pod
        .status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .unwrap_or("Pending");
    matches!(phase, "Running" | "Pending" | "Unknown") && pod.metadata.deletion_timestamp.is_none()
}

/// The workload that owns a pod, `(kind, name)`: ReplicaSets resolve to
/// their Deployment through `pod-template-hash`, Jobs to their CronJob
/// through the scheduled-time suffix. `None` for bare pods.
pub fn workload_of(pod: &Pod) -> Option<(String, String)> {
    let owner = pod
        .metadata
        .owner_references
        .as_ref()?
        .iter()
        .find(|r| r.controller == Some(true))?;
    let labels = pod.metadata.labels.as_ref();
    match owner.kind.as_str() {
        "ReplicaSet" => {
            let hash = labels.and_then(|l| l.get("pod-template-hash"));
            match hash.and_then(|h| owner.name.strip_suffix(&format!("-{h}"))) {
                Some(deployment) if !deployment.is_empty() => {
                    Some(("Deployment".into(), deployment.to_string()))
                }
                _ => Some(("ReplicaSet".into(), owner.name.clone())),
            }
        }
        "Job" => match owner.name.rsplit_once('-') {
            Some((base, suffix))
                if !base.is_empty()
                    && suffix.len() >= 8
                    && suffix.chars().all(|c| c.is_ascii_digit()) =>
            {
                Some(("CronJob".into(), base.to_string()))
            }
            _ => Some(("Job".into(), owner.name.clone())),
        },
        kind => Some((kind.to_string(), owner.name.clone())),
    }
}

/// Group of a pod: `(key, name, namespace, kind, special)`.
fn group_of(
    pod: &Pod,
    aggregate: CostAggregate,
    label: Option<&str>,
) -> (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<CostSpecial>,
) {
    let ns = pod.metadata.namespace.clone().unwrap_or_default();
    match aggregate {
        CostAggregate::Namespace => (ns.clone(), ns.clone(), Some(ns), None, None),
        CostAggregate::Workload => match workload_of(pod) {
            Some((kind, name)) => (
                format!("{ns}/{kind}/{name}"),
                name,
                Some(ns),
                Some(kind),
                None,
            ),
            None => (
                format!("{ns}/{UNALLOCATED}"),
                UNALLOCATED.into(),
                Some(ns),
                None,
                Some(CostSpecial::Unallocated),
            ),
        },
        CostAggregate::Label => {
            let value = label.and_then(|key| {
                pod.metadata
                    .labels
                    .as_ref()
                    .and_then(|l| l.get(key.trim()))
                    .filter(|v| !v.is_empty())
            });
            match value {
                Some(v) => (v.clone(), v.clone(), None, None, None),
                None => (
                    UNALLOCATED.into(),
                    UNALLOCATED.into(),
                    None,
                    None,
                    Some(CostSpecial::Unallocated),
                ),
            }
        }
    }
}

fn claim_bytes(pvc: &PersistentVolumeClaim) -> f64 {
    let status = pvc
        .status
        .as_ref()
        .and_then(|s| s.capacity.as_ref())
        .and_then(|c| c.get("storage"))
        .map(|q| q.0.as_str());
    let spec = pvc
        .spec
        .as_ref()
        .and_then(|s| s.resources.as_ref())
        .and_then(|r| r.requests.as_ref())
        .and_then(|r| r.get("storage"))
        .map(|q| q.0.as_str());
    memory_or_zero(status.or(spec))
}

/// Capacity cost of the nodes per month: `(cpu, memory, gpu)`.
fn node_capacity_cost(nodes: &[Node], pricing: &CostPricing) -> (f64, f64, f64) {
    let mut cost = (0.0, 0.0, 0.0);
    for node in nodes {
        let Some(capacity) = node.status.as_ref().and_then(|s| s.capacity.as_ref()) else {
            continue;
        };
        let get = |key: &str| capacity.get(key).map(|q| q.0.as_str());
        cost.0 += pricing.cpu_monthly(cpu_or_zero(get("cpu")) / 1000.0);
        cost.1 += pricing.memory_monthly(memory_or_zero(get("memory")));
        let gpus: f64 = GPU_RESOURCES
            .iter()
            .filter_map(|k| get(k).and_then(parse_quantity))
            .sum();
        cost.2 += pricing.gpu_monthly(gpus);
    }
    cost
}

fn cost_efficiency(item: &CostItem, pricing: &CostPricing) -> Option<f64> {
    let (cu, mu) = (item.cpu_usage_cores?, item.memory_usage_bytes?);
    let requested = pricing.cpu_monthly(item.cpu_request_cores)
        + pricing.memory_monthly(item.memory_request_bytes);
    (requested > 0.0).then(|| (pricing.cpu_monthly(cu) + pricing.memory_monthly(mu)) / requested)
}

/// Totals and rows of an estimate.
pub fn estimate(input: &EstimateInput<'_>) -> (CostTotals, Vec<CostItem>) {
    let pricing = input.pricing;
    let mut rows: BTreeMap<String, CostItem> = BTreeMap::new();
    // Claim → group key of the first pod mounting it.
    let mut claim_owner: HashMap<(String, String), String> = HashMap::new();
    let mut compute_allocated = 0.0;

    for pod in input.pods.iter().filter(|p| is_active(p)) {
        let ns = pod.metadata.namespace.clone().unwrap_or_default();
        let name = pod.metadata.name.clone().unwrap_or_default();
        let req = pod_requests(pod);
        let usage = input
            .usage
            .and_then(|u| u.get(&(ns.clone(), name.clone())))
            .copied();
        // Pay for whichever is larger: what is reserved or what is used.
        let cpu_basis = usage.map_or(req.cpu_cores, |u| u.cpu_cores.max(req.cpu_cores));
        let mem_basis = usage.map_or(req.memory_bytes, |u| u.memory_bytes.max(req.memory_bytes));
        let cpu_cost = pricing.cpu_monthly(cpu_basis);
        let memory_cost = pricing.memory_monthly(mem_basis);
        let gpu_cost = pricing.gpu_monthly(req.gpus);
        compute_allocated += cpu_cost + memory_cost + gpu_cost;

        let (key, group_name, namespace, kind, special) =
            group_of(pod, input.aggregate, input.label);
        for volume in pod
            .spec
            .as_ref()
            .and_then(|s| s.volumes.as_ref())
            .into_iter()
            .flatten()
        {
            if let Some(claim) = volume.persistent_volume_claim.as_ref() {
                claim_owner
                    .entry((ns.clone(), claim.claim_name.clone()))
                    .or_insert_with(|| key.clone());
            }
        }
        let row = rows.entry(key.clone()).or_insert_with(|| CostItem {
            key,
            name: group_name,
            namespace,
            kind,
            special,
            cpu_usage_cores: input.usage.map(|_| 0.0),
            memory_usage_bytes: input.usage.map(|_| 0.0),
            ..Default::default()
        });
        row.pods += 1;
        row.cpu_request_cores += req.cpu_cores;
        row.memory_request_bytes += req.memory_bytes;
        row.gpus += req.gpus;
        if input.usage.is_some() {
            let u = usage.unwrap_or_default();
            row.cpu_usage_cores = add_opt(row.cpu_usage_cores, Some(u.cpu_cores));
            row.memory_usage_bytes = add_opt(row.memory_usage_bytes, Some(u.memory_bytes));
        }
        row.cpu_cost += cpu_cost;
        row.memory_cost += memory_cost;
        row.gpu_cost += gpu_cost;
        row.total_cost += cpu_cost + memory_cost + gpu_cost;
    }

    for pvc in input.pvcs.unwrap_or_default() {
        let ns = pvc.metadata.namespace.clone().unwrap_or_default();
        let name = pvc.metadata.name.clone().unwrap_or_default();
        let bytes = claim_bytes(pvc);
        let cost = pricing.storage_monthly(bytes);
        if bytes <= 0.0 {
            continue;
        }
        let key = match claim_owner.get(&(ns.clone(), name)) {
            Some(key) => key.clone(),
            None => match input.aggregate {
                CostAggregate::Namespace => ns.clone(),
                CostAggregate::Workload => format!("{ns}/{UNALLOCATED}"),
                CostAggregate::Label => UNALLOCATED.to_string(),
            },
        };
        let row = rows.entry(key.clone()).or_insert_with(|| {
            let special = match input.aggregate {
                CostAggregate::Namespace => None,
                _ => Some(CostSpecial::Unallocated),
            };
            CostItem {
                name: if special.is_some() {
                    UNALLOCATED.to_string()
                } else {
                    ns.clone()
                },
                namespace: (input.aggregate != CostAggregate::Label).then(|| ns.clone()),
                key,
                special,
                ..Default::default()
            }
        });
        row.storage_bytes += bytes;
        row.storage_cost += cost;
        row.total_cost += cost;
    }

    let mut items: Vec<CostItem> = rows.into_values().collect();
    for item in &mut items {
        item.efficiency = cost_efficiency(item, pricing);
    }
    let idle_known = input.nodes.is_some();
    if let Some(nodes) = input.nodes {
        let (cpu, memory, gpu) = node_capacity_cost(nodes, pricing);
        let capacity = cpu + memory + gpu;
        let idle = (capacity - compute_allocated).max(0.0);
        if idle > 0.0 {
            // Split idle like the capacity it comes from.
            let share = |part: f64| {
                if capacity > 0.0 {
                    idle * part / capacity
                } else {
                    0.0
                }
            };
            items.push(CostItem {
                key: IDLE.into(),
                name: IDLE.into(),
                special: Some(CostSpecial::Idle),
                cpu_cost: share(cpu),
                memory_cost: share(memory),
                gpu_cost: share(gpu),
                total_cost: idle,
                ..Default::default()
            });
        }
    }
    sort_items(&mut items);
    (totals(&items, idle_known), items)
}

const DAY_MS: i64 = 86_400_000;

/// Daily cost of the cluster's requests from Prometheus series of summed
/// CPU (millicores) and memory (bytes) requests: the mean hourly cost of
/// each UTC day × 24. Days without CPU samples are left out.
pub fn requests_trend(
    cpu: &[(i64, f64)],
    memory: &[(i64, f64)],
    pricing: &CostPricing,
) -> Vec<CostTrendPoint> {
    let memory: HashMap<i64, f64> = memory.iter().copied().collect();
    let mut days: BTreeMap<i64, (f64, usize)> = BTreeMap::new();
    for &(ts, millicores) in cpu {
        let bytes = memory.get(&ts).copied().unwrap_or(0.0);
        let hourly = (pricing.cpu_monthly(millicores / 1000.0) + pricing.memory_monthly(bytes))
            / super::HOURS_PER_MONTH;
        let day = ts.div_euclid(DAY_MS) * DAY_MS;
        let entry = days.entry(day).or_default();
        entry.0 += hourly;
        entry.1 += 1;
    }
    days.into_iter()
        .map(|(ts, (sum, n))| CostTrendPoint {
            ts,
            total: sum / n as f64 * 24.0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::pricing::GIB;
    use serde_json::json;

    fn pricing() -> CostPricing {
        CostPricing {
            currency: "USD".into(),
            cpu_hour: 0.04,
            memory_gib_hour: 0.005,
            gpu_hour: Some(1.0),
            storage_gib_month: Some(0.1),
            discount_percent: 0.0,
        }
    }

    fn pod(
        ns: &str,
        name: &str,
        owner: Option<(&str, &str)>,
        labels: Value,
        cpu: &str,
        mem: &str,
    ) -> Pod {
        let owners = owner
            .map(|(kind, n)| json!([{"apiVersion": "apps/v1", "kind": kind, "name": n, "uid": "u", "controller": true}]))
            .unwrap_or(json!([]));
        serde_json::from_value(json!({
            "metadata": {"name": name, "namespace": ns, "labels": labels, "ownerReferences": owners},
            "spec": {"containers": [{"name": "app", "resources": {"requests": {"cpu": cpu, "memory": mem}}}],
                     "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": format!("data-{name}")}}]},
            "status": {"phase": "Running"}
        }))
        .unwrap()
    }

    use serde_json::Value;

    fn node(cpu: &str, mem: &str) -> Node {
        serde_json::from_value(
            json!({"metadata": {"name": "n"}, "status": {"capacity": {"cpu": cpu, "memory": mem}}}),
        )
        .unwrap()
    }

    fn pvc(ns: &str, name: &str, size: &str) -> PersistentVolumeClaim {
        serde_json::from_value(json!({"metadata": {"name": name, "namespace": ns},
            "spec": {"resources": {"requests": {"storage": size}}},
            "status": {"capacity": {"storage": size}}}))
        .unwrap()
    }

    #[test]
    fn effective_requests_follow_the_scheduler() {
        let p: Pod = serde_json::from_value(json!({
            "metadata": {"name": "p"},
            "spec": {
                "containers": [
                    {"name": "a", "resources": {"requests": {"cpu": "250m", "memory": "256Mi"}}},
                    {"name": "b", "resources": {"requests": {"cpu": "250m"}, "limits": {"nvidia.com/gpu": "1"}}}
                ],
                "initContainers": [{"name": "i", "resources": {"requests": {"cpu": "1", "memory": "128Mi"}}}],
                "overhead": {"memory": "64Mi"}
            }
        }))
        .unwrap();
        let r = pod_requests(&p);
        assert_eq!(r.cpu_cores, 1.0, "the init container is larger");
        assert_eq!(r.memory_bytes, 320.0 * 1024.0 * 1024.0);
        assert_eq!(r.gpus, 1.0, "GPU limits imply requests");
    }

    #[test]
    fn owners_resolve_to_workloads() {
        let rs = pod(
            "shop",
            "web-7d9f8-abcde",
            Some(("ReplicaSet", "web-7d9f8")),
            json!({"pod-template-hash": "7d9f8"}),
            "100m",
            "64Mi",
        );
        assert_eq!(workload_of(&rs), Some(("Deployment".into(), "web".into())));
        let bare_rs = pod(
            "shop",
            "x-abc",
            Some(("ReplicaSet", "x")),
            json!({}),
            "1m",
            "1Mi",
        );
        assert_eq!(
            workload_of(&bare_rs),
            Some(("ReplicaSet".into(), "x".into()))
        );
        let cron = pod(
            "ops",
            "report-28730160-x2x9z",
            Some(("Job", "report-28730160")),
            json!({}),
            "1m",
            "1Mi",
        );
        assert_eq!(
            workload_of(&cron),
            Some(("CronJob".into(), "report".into()))
        );
        let job = pod(
            "ops",
            "migrate-x2x9z",
            Some(("Job", "migrate")),
            json!({}),
            "1m",
            "1Mi",
        );
        assert_eq!(workload_of(&job), Some(("Job".into(), "migrate".into())));
        let sts = pod(
            "db",
            "pg-0",
            Some(("StatefulSet", "pg")),
            json!({}),
            "1m",
            "1Mi",
        );
        assert_eq!(workload_of(&sts), Some(("StatefulSet".into(), "pg".into())));
        assert_eq!(
            workload_of(&pod("a", "b", None, json!({}), "1m", "1Mi")),
            None
        );
    }

    #[test]
    fn estimate_splits_allocated_and_idle_capacity() {
        let pods = vec![
            pod(
                "shop",
                "web-1-a",
                Some(("ReplicaSet", "web-1")),
                json!({"pod-template-hash": "1", "team": "red"}),
                "500m",
                "1Gi",
            ),
            pod(
                "shop",
                "web-1-b",
                Some(("ReplicaSet", "web-1")),
                json!({"pod-template-hash": "1", "team": "red"}),
                "500m",
                "1Gi",
            ),
            pod(
                "db",
                "pg-0",
                Some(("StatefulSet", "pg")),
                json!({"team": "blue"}),
                "1",
                "4Gi",
            ),
        ];
        let nodes = vec![node("4", "16Gi")];
        let pvcs = vec![pvc("db", "data-pg-0", "100Gi"), pvc("db", "orphan", "10Gi")];
        let p = pricing();
        let input = EstimateInput {
            pods: &pods,
            nodes: Some(&nodes),
            pvcs: Some(&pvcs),
            usage: None,
            pricing: &p,
            aggregate: CostAggregate::Namespace,
            label: None,
        };
        let (totals, items) = estimate(&input);
        let shop = items.iter().find(|i| i.key == "shop").unwrap();
        assert_eq!(shop.pods, 2);
        assert!((shop.cpu_cost - 1.0 * 0.04 * 730.0).abs() < 1e-9);
        assert!((shop.memory_cost - 2.0 * 0.005 * 730.0).abs() < 1e-9);
        let db = items.iter().find(|i| i.key == "db").unwrap();
        assert!(
            (db.storage_cost - 11.0).abs() < 1e-9,
            "mounted and unmounted claims"
        );
        let capacity = 4.0 * 0.04 * 730.0 + 16.0 * 0.005 * 730.0;
        let allocated_compute = 2.0 * 0.04 * 730.0 + 6.0 * 0.005 * 730.0;
        let idle = items
            .iter()
            .find(|i| i.special == Some(CostSpecial::Idle))
            .unwrap();
        assert!((idle.total_cost - (capacity - allocated_compute)).abs() < 1e-9);
        assert!((totals.idle.unwrap() - idle.total_cost).abs() < 1e-9);
        assert!((totals.total - (capacity + 11.0)).abs() < 1e-9);
        assert!((totals.allocated - (allocated_compute + 11.0)).abs() < 1e-9);
        assert!(totals.efficiency.is_none(), "no usage known");

        // By workload: the orphan claim is unallocated in its namespace.
        let input = EstimateInput {
            aggregate: CostAggregate::Workload,
            ..input
        };
        let (_, items) = estimate(&input);
        let web = items.iter().find(|i| i.name == "web").unwrap();
        assert_eq!(web.kind.as_deref(), Some("Deployment"));
        let pg = items.iter().find(|i| i.name == "pg").unwrap();
        assert!((pg.storage_cost - 10.0).abs() < 1e-9);
        let orphan = items
            .iter()
            .find(|i| i.key == "db/__unallocated__")
            .unwrap();
        assert_eq!(orphan.special, Some(CostSpecial::Unallocated));
        assert!((orphan.storage_cost - 1.0).abs() < 1e-9);

        // By label.
        let input = EstimateInput {
            aggregate: CostAggregate::Label,
            label: Some("team"),
            ..input
        };
        let (_, items) = estimate(&input);
        assert!(items.iter().any(|i| i.key == "red" && i.pods == 2));
        assert!(items.iter().any(|i| i.key == "blue"));
    }

    #[test]
    fn requests_trend_averages_each_day() {
        let p = pricing();
        let day0 = 1_790_000_000_000_i64.div_euclid(DAY_MS) * DAY_MS;
        let hour = 3_600_000;
        let cpu = vec![
            (day0, 1000.0),
            (day0 + hour, 3000.0),
            (day0 + DAY_MS, 2000.0),
        ];
        let mem = vec![(day0, GIB), (day0 + hour, GIB), (day0 + DAY_MS, 0.0)];
        let points = requests_trend(&cpu, &mem, &p);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].ts, day0);
        // Mean of 2 cores + 1 GiB per hour, for 24 hours.
        let expected = (2.0 * 0.04 + 0.005) * 24.0;
        assert!((points[0].total - expected).abs() < 1e-9);
        assert!((points[1].total - 2.0 * 0.04 * 24.0).abs() < 1e-9);
        assert!(requests_trend(&[], &mem, &p).is_empty());
    }

    #[test]
    fn usage_raises_the_basis_and_yields_efficiency() {
        let pods = vec![pod("a", "p", None, json!({}), "1", "1Gi")];
        let mut usage = UsageMap::new();
        usage.insert(
            ("a".into(), "p".into()),
            PodUsage {
                cpu_cores: 0.25,
                memory_bytes: 2.0 * GIB,
            },
        );
        let p = pricing();
        let input = EstimateInput {
            pods: &pods,
            nodes: None,
            pvcs: None,
            usage: Some(&usage),
            pricing: &p,
            aggregate: CostAggregate::Namespace,
            label: None,
        };
        let (totals, items) = estimate(&input);
        let a = &items[0];
        assert!(
            (a.cpu_cost - 0.04 * 730.0).abs() < 1e-9,
            "requests are higher"
        );
        assert!(
            (a.memory_cost - 2.0 * 0.005 * 730.0).abs() < 1e-9,
            "usage is higher"
        );
        let expected = (0.25 * 0.04 + 2.0 * 0.005) / (1.0 * 0.04 + 1.0 * 0.005);
        assert!((a.efficiency.unwrap() - expected).abs() < 1e-9);
        assert!(totals.idle.is_none(), "capacity unknown without nodes");
        assert_eq!(totals.total, totals.allocated);
        assert!((totals.cpu_efficiency.unwrap() - 0.25).abs() < 1e-9);
        // Finished pods hold nothing.
        let mut done = pod("a", "q", None, json!({}), "1", "1Gi");
        done.status.as_mut().unwrap().phase = Some("Succeeded".into());
        let pods = vec![done];
        let (totals, items) = estimate(&EstimateInput {
            pods: &pods,
            ..input
        });
        assert!(items.is_empty());
        assert_eq!(totals.total, 0.0);
    }
}
