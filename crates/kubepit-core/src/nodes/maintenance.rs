//! Reviewed node maintenance. Plans are server-owned, bounded and ephemeral;
//! progress never accepts client-supplied namespaces, selectors or Pod UIDs.
use crate::{
    error::{api_code, kube_error},
    Kubepit,
};
use anyhow::{anyhow, bail, Context, Result};
use futures::{stream, StreamExt};
use k8s_openapi::{
    api::{
        authorization::v1::{
            ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
        },
        core::v1::{Node, PersistentVolume, PersistentVolumeClaim, Pod},
        policy::v1::PodDisruptionBudget,
    },
    apimachinery::pkg::apis::meta::v1::LabelSelector,
};
use kube::{
    api::{ListParams, Patch, PatchParams, PostParams},
    Api, Client,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    hash::{Hash, Hasher},
    sync::OnceLock,
    time::{Duration, Instant},
};

const POD_LIMIT: u32 = 500;
const NAMESPACE_LIMIT: usize = 20;
const PEER_LIMIT: u32 = 1000;
const PLAN_TTL: Duration = Duration::from_secs(1800);
const REVIEW_TTL: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeMaintenanceOwner {
    pub uid: String,
    pub kind: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceVolume {
    pub kind: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenancePod {
    pub namespace: String,
    pub name: String,
    pub uid: String,
    pub action: String,
    pub phase: String,
    pub ready: bool,
    pub terminating: bool,
    pub owner: Option<NodeMaintenanceOwner>,
    pub volumes: Vec<NodeMaintenanceVolume>,
    pub pdbs: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenancePdb {
    pub namespace: String,
    pub name: String,
    pub uid: String,
    pub selector: String,
    pub matched_pods: Vec<String>,
    pub disruptions_allowed: Option<i32>,
    pub required_disruptions: u32,
    pub unhealthy_policy: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceWorkload {
    pub namespace: String,
    pub owner: NodeMaintenanceOwner,
    pub baseline_uids: Vec<String>,
    pub expected_replacements: u32,
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenancePlan {
    pub plan_id: String,
    pub node_name: String,
    pub node_uid: String,
    pub fingerprint: String,
    pub checked_at: i64,
    pub unschedulable: bool,
    pub read_only: bool,
    pub inventory_complete: bool,
    pub pdbs_complete: bool,
    pub pods: Vec<NodeMaintenancePod>,
    pub pdbs: Vec<NodeMaintenancePdb>,
    pub workloads: Vec<NodeMaintenanceWorkload>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceDrainRequest {
    pub plan_id: String,
    pub name: String,
    pub node_uid: String,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceEviction {
    pub namespace: String,
    pub name: String,
    pub uid: String,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceReceipt {
    pub plan_id: String,
    pub started_at: i64,
    pub node_cordoned: bool,
    pub evictions: Vec<NodeMaintenanceEviction>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceSourceProgress {
    pub namespace: String,
    pub name: String,
    pub uid: String,
    pub state: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceReplacement {
    pub name: String,
    pub uid: String,
    pub node: String,
    pub ready: bool,
    pub phase: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceWorkloadProgress {
    pub namespace: String,
    pub owner: NodeMaintenanceOwner,
    pub expected_replacements: u32,
    pub replacements: Vec<NodeMaintenanceReplacement>,
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMaintenanceProgress {
    pub checked_at: i64,
    pub node_uid_matches: bool,
    pub node_cordoned: Option<bool>,
    pub sources: Vec<NodeMaintenanceSourceProgress>,
    pub workloads: Vec<NodeMaintenanceWorkloadProgress>,
    pub warnings: Vec<String>,
}

#[derive(Clone)]
struct CachedPlan {
    cluster_id: String,
    created: Instant,
    started: bool,
    plan: NodeMaintenancePlan,
}
static PLANS: OnceLock<Mutex<BTreeMap<String, CachedPlan>>> = OnceLock::new();
fn plans() -> &'static Mutex<BTreeMap<String, CachedPlan>> {
    PLANS.get_or_init(Mutex::default)
}
fn cached(cluster_id: &str, id: &str) -> Result<CachedPlan> {
    if id.len() > 64 {
        bail!("node-maintenance:plan-expired");
    }
    let mut cache = plans().lock();
    cache.retain(|_, entry| entry.created.elapsed() < PLAN_TTL);
    cache
        .get(id)
        .filter(|entry| entry.cluster_id == cluster_id)
        .cloned()
        .context("node-maintenance:plan-expired")
}
fn save_plan(cluster_id: &str, plan: NodeMaintenancePlan) {
    let mut cache = plans().lock();
    cache.retain(|_, entry| entry.created.elapsed() < PLAN_TTL);
    if cache.len() >= 32 {
        if let Some(id) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(id, _)| id.clone())
        {
            cache.remove(&id);
        }
    }
    cache.insert(
        plan.plan_id.clone(),
        CachedPlan {
            cluster_id: cluster_id.into(),
            created: Instant::now(),
            started: false,
            plan,
        },
    );
}
fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.".contains(&b))
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.as_bytes()[name.len() - 1].is_ascii_alphanumeric()
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn owner(pod: &Pod) -> Option<NodeMaintenanceOwner> {
    pod.metadata
        .owner_references
        .as_ref()?
        .iter()
        .find(|r| r.controller == Some(true))
        .map(|r| NodeMaintenanceOwner {
            uid: r.uid.clone(),
            kind: r.kind.clone(),
            name: r.name.clone(),
        })
}
fn ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|conditions| {
            conditions
                .iter()
                .any(|c| c.type_ == "Ready" && c.status == "True")
        })
}
fn phase(pod: &Pod) -> String {
    pod.status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_default()
}
fn warning(error: &anyhow::Error) -> String {
    if api_code(error) == Some(403) {
        "forbidden"
    } else if error.to_string().contains("timeout") {
        "timeout"
    } else {
        "unavailable"
    }
    .into()
}
async fn bounded<T>(
    future: impl std::future::Future<Output = std::result::Result<T, kube::Error>>,
) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .map_err(|_| anyhow!("node-maintenance:timeout"))?
        .map_err(kube_error)
}

/// policy/v1: a missing selector selects none; an empty selector selects all.
fn selector_matches(
    selector: Option<&LabelSelector>,
    labels: &BTreeMap<String, String>,
) -> Option<bool> {
    let Some(selector) = selector else {
        return Some(false);
    };
    if selector
        .match_labels
        .as_ref()
        .is_some_and(|entries| entries.iter().any(|(k, v)| labels.get(k) != Some(v)))
    {
        return Some(false);
    }
    for expression in selector.match_expressions.iter().flatten() {
        let found = labels.get(&expression.key);
        let values = expression.values.as_deref().unwrap_or_default();
        let matches = match expression.operator.as_str() {
            "In" if !values.is_empty() => found.is_some_and(|value| values.contains(value)),
            "NotIn" if !values.is_empty() => found.is_none_or(|value| !values.contains(value)),
            "Exists" if values.is_empty() => found.is_some(),
            "DoesNotExist" if values.is_empty() => found.is_none(),
            _ => return None,
        };
        if !matches {
            return Some(false);
        }
    }
    Some(true)
}

fn pod_summary(pod: &Pod) -> NodeMaintenancePod {
    let owner = owner(pod);
    let phase = phase(pod);
    let action = if pod
        .metadata
        .annotations
        .as_ref()
        .is_some_and(|a| a.contains_key(super::MIRROR_ANNOTATION))
    {
        "mirror"
    } else if owner.as_ref().is_some_and(|o| o.kind == "DaemonSet") {
        "daemonset"
    } else if owner.is_none() && !matches!(phase.as_str(), "Succeeded" | "Failed") {
        "unmanaged"
    } else {
        "evict"
    };
    let volumes = pod
        .spec
        .as_ref()
        .and_then(|s| s.volumes.as_ref())
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let kind = if v.empty_dir.is_some() {
                "empty-dir"
            } else if v.host_path.is_some() {
                "host-path"
            } else {
                return None;
            };
            Some(NodeMaintenanceVolume {
                kind: kind.into(),
                name: v.name.clone(),
            })
        })
        .collect();
    NodeMaintenancePod {
        namespace: pod.metadata.namespace.clone().unwrap_or_default(),
        name: pod.metadata.name.clone().unwrap_or_default(),
        uid: pod.metadata.uid.clone().unwrap_or_default(),
        action: action.into(),
        phase,
        ready: ready(pod),
        terminating: pod.metadata.deletion_timestamp.is_some(),
        owner,
        volumes,
        pdbs: Vec::new(),
    }
}

fn required_disruption(pod: &NodeMaintenancePod, pdb: &PodDisruptionBudget) -> bool {
    if pod.terminating || matches!(pod.phase.as_str(), "Pending" | "Succeeded" | "Failed") {
        return false;
    }
    if pod.phase == "Running" && !pod.ready {
        let policy = pdb
            .spec
            .as_ref()
            .and_then(|s| s.unhealthy_pod_eviction_policy.as_deref())
            .unwrap_or("IfHealthyBudget");
        if policy == "AlwaysAllow" {
            return false;
        }
        if pdb.status.as_ref().is_some_and(|s| {
            s.current_healthy
                .zip(s.desired_healthy)
                .is_some_and(|(current, desired)| current >= desired && desired > 0)
        }) {
            return false;
        }
    }
    true
}

fn fingerprint(plan: &NodeMaintenancePlan) -> String {
    // This detects stale reviewed data; it is not an authorization token.
    // Server-owned random plan IDs bind all subsequent requests to the plan.
    let data = json!({"node": plan.node_uid, "cordoned":plan.unschedulable, "pods":plan.pods, "pdbs":plan.pdbs, "workloads":plan.workloads, "inventory":plan.inventory_complete, "pdb_inventory":plan.pdbs_complete, "warnings":plan.warnings});
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    data.to_string().hash(&mut hash);
    format!("{:016x}", hash.finish())
}

async fn namespace_pods(
    client: Client,
    namespaces: BTreeSet<String>,
) -> BTreeMap<String, Result<(Vec<Pod>, bool)>> {
    stream::iter(namespaces.into_iter().take(NAMESPACE_LIMIT))
        .map(|namespace| {
            let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
            async move {
                let result = bounded(api.list(&ListParams::default().limit(PEER_LIMIT)))
                    .await
                    .map(|list| {
                        let complete = list.metadata.continue_.as_deref().is_none_or(str::is_empty);
                        (list.items, complete)
                    });
                (namespace, result)
            }
        })
        .buffer_unordered(8)
        .collect()
        .await
}

async fn build_plan(
    client: Client,
    node_name: &str,
    read_only: bool,
) -> Result<(NodeMaintenancePlan, Node)> {
    let nodes: Api<Node> = Api::all(client.clone());
    let all_pods: Api<Pod> = Api::all(client.clone());
    let pod_params = ListParams::default()
        .fields(&format!("spec.nodeName={node_name}"))
        .limit(POD_LIMIT);
    let (node, list) = tokio::try_join!(
        bounded(nodes.get(node_name)),
        bounded(all_pods.list(&pod_params))
    )?;
    let node_uid = node
        .metadata
        .uid
        .clone()
        .filter(|uid| !uid.is_empty())
        .context("node-maintenance:missing-identity")?;
    let mut raw_pods = list.items;
    raw_pods.sort_by_key(|pod| (pod.metadata.namespace.clone(), pod.metadata.name.clone()));
    let mut plan = NodeMaintenancePlan {
        plan_id: uuid::Uuid::new_v4().to_string(),
        node_name: node_name.into(),
        node_uid,
        fingerprint: String::new(),
        checked_at: now(),
        unschedulable: node
            .spec
            .as_ref()
            .and_then(|s| s.unschedulable)
            .unwrap_or(false),
        read_only,
        inventory_complete: list.metadata.continue_.as_deref().is_none_or(str::is_empty),
        pdbs_complete: true,
        pods: raw_pods.iter().map(pod_summary).collect(),
        pdbs: Vec::new(),
        workloads: Vec::new(),
        warnings: Vec::new(),
    };
    if plan
        .pods
        .iter()
        .any(|p| p.uid.is_empty() || p.namespace.is_empty() || p.name.is_empty())
    {
        plan.inventory_complete = false;
        plan.warnings.push("pod-identity".into());
    }
    if !plan.inventory_complete {
        plan.warnings.push("pods-partial".into());
    }
    let namespaces: BTreeSet<String> = plan
        .pods
        .iter()
        .filter(|p| p.action == "evict")
        .map(|p| p.namespace.clone())
        .collect();
    if namespaces.len() > NAMESPACE_LIMIT {
        plan.warnings.push("namespace-limit".into());
    }
    let pdb_api: Api<PodDisruptionBudget> = Api::all(client.clone());
    let pdb_params = ListParams::default().limit(1000);
    let (pdb_result, peers) = tokio::join!(
        bounded(pdb_api.list(&pdb_params)),
        namespace_pods(client.clone(), namespaces)
    );
    match pdb_result {
        Ok(list) => {
            plan.pdbs_complete = list.metadata.continue_.as_deref().is_none_or(str::is_empty);
            for pdb in list.items {
                let ns = pdb.metadata.namespace.clone().unwrap_or_default();
                let spec = pdb.spec.as_ref();
                let mut matched = Vec::new();
                let mut required = 0;
                for (raw, pod) in raw_pods
                    .iter()
                    .zip(plan.pods.iter_mut())
                    .filter(|(_, p)| p.namespace == ns && p.action == "evict")
                {
                    match selector_matches(
                        spec.and_then(|s| s.selector.as_ref()),
                        &raw.metadata.labels.clone().unwrap_or_default(),
                    ) {
                        Some(true) => {
                            matched.push(pod.uid.clone());
                            required += u32::from(required_disruption(pod, &pdb));
                            pod.pdbs.push(format!(
                                "{}/{}",
                                ns,
                                pdb.metadata.name.as_deref().unwrap_or_default()
                            ));
                        }
                        None => {
                            plan.pdbs_complete = false;
                        }
                        _ => {}
                    }
                }
                if matched.is_empty() {
                    continue;
                }
                let fresh = pdb.status.as_ref().is_some_and(|s| {
                    s.observed_generation
                        .zip(pdb.metadata.generation)
                        .is_some_and(|(observed, generation)| observed >= generation)
                });
                let allowed = fresh
                    .then(|| pdb.status.as_ref().and_then(|s| s.disruptions_allowed))
                    .flatten();
                plan.pdbs.push(NodeMaintenancePdb {
                    namespace: ns,
                    name: pdb.metadata.name.clone().unwrap_or_default(),
                    uid: pdb.metadata.uid.clone().unwrap_or_default(),
                    selector: serde_json::to_string(&spec.and_then(|s| s.selector.as_ref()))
                        .unwrap_or_default(),
                    matched_pods: matched,
                    disruptions_allowed: allowed,
                    required_disruptions: required,
                    unhealthy_policy: spec
                        .and_then(|s| s.unhealthy_pod_eviction_policy.clone())
                        .unwrap_or_else(|| "IfHealthyBudget".into()),
                });
            }
        }
        Err(error) => {
            plan.pdbs_complete = false;
            plan.warnings.push(format!("pdbs-{}", warning(&error)));
        }
    }
    if !plan.pdbs_complete {
        plan.warnings.push("pdbs-partial".into());
    }
    plan.pdbs
        .sort_by_key(|p| (p.namespace.clone(), p.name.clone()));
    for pod in &mut plan.pods {
        pod.pdbs.sort();
        if pod.pdbs.len() > 1 {
            plan.warnings.push("overlapping-pdbs".into());
        }
    }
    for pod in plan
        .pods
        .iter()
        .filter(|p| p.action == "evict" && !matches!(p.phase.as_str(), "Succeeded" | "Failed"))
    {
        let Some(owner) = &pod.owner else {
            continue;
        };
        if let Some(group) = plan
            .workloads
            .iter_mut()
            .find(|w| w.namespace == pod.namespace && w.owner.uid == owner.uid)
        {
            group.expected_replacements += 1;
            continue;
        }
        let peer_result = peers.get(&pod.namespace);
        let (mut baseline, complete) = match peer_result {
            Some(Ok((pods, complete))) => (
                pods.iter()
                    .filter(|p| self::owner(p).is_some_and(|o| o.uid == owner.uid))
                    .filter_map(|p| p.metadata.uid.clone())
                    .collect::<Vec<_>>(),
                *complete,
            ),
            _ => (Vec::new(), false),
        };
        baseline.sort();
        baseline.dedup();
        if !complete {
            plan.warnings.push("workloads-partial".into());
        }
        plan.workloads.push(NodeMaintenanceWorkload {
            namespace: pod.namespace.clone(),
            owner: owner.clone(),
            baseline_uids: baseline,
            expected_replacements: 1,
            complete,
        });
    }
    // Resolve only claims actually used by affected Pods, with a hard cap.
    let claims: BTreeSet<(String, String)> = raw_pods
        .iter()
        .zip(&plan.pods)
        .filter(|(_, p)| p.action == "evict")
        .flat_map(|(pod, summary)| {
            pod.spec
                .as_ref()
                .and_then(|s| s.volumes.as_ref())
                .into_iter()
                .flatten()
                .filter_map(|v| {
                    v.persistent_volume_claim
                        .as_ref()
                        .map(|claim| (summary.namespace.clone(), claim.claim_name.clone()))
                })
        })
        .collect();
    let storage_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let resolved: BTreeMap<(String, String), String> =
        stream::iter(claims.iter().take(64).cloned())
            .map(|(ns, name)| {
                let client = client.clone();
                async move {
                    let api: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), &ns);
                    let work = async {
                        let claim = bounded(api.get(&name)).await?;
                        let volume = claim.spec.and_then(|s| s.volume_name).context("unbound")?;
                        let api: Api<PersistentVolume> = Api::all(client);
                        let volume = bounded(api.get(&volume)).await?;
                        Ok::<_, anyhow::Error>(
                            volume
                                .spec
                                .is_some_and(|s| s.local.is_some() || s.host_path.is_some()),
                        )
                    };
                    let result = tokio::time::timeout_at(storage_deadline, work)
                        .await
                        .unwrap_or_else(|_| Err(anyhow!("node-maintenance:timeout")));
                    (
                        (ns, name),
                        match result {
                            Ok(true) => "local-pv",
                            Ok(false) => "",
                            Err(_) => "persistent-volume-unknown",
                        }
                        .into(),
                    )
                }
            })
            .buffer_unordered(8)
            .collect()
            .await;
    for (raw, summary) in raw_pods.iter().zip(&mut plan.pods) {
        if summary.action != "evict" {
            continue;
        }
        for claim in raw
            .spec
            .as_ref()
            .and_then(|s| s.volumes.as_ref())
            .into_iter()
            .flatten()
            .filter_map(|v| v.persistent_volume_claim.as_ref())
        {
            let kind = resolved
                .get(&(summary.namespace.clone(), claim.claim_name.clone()))
                .map(String::as_str)
                .unwrap_or("persistent-volume-unknown");
            if !kind.is_empty() {
                summary.volumes.push(NodeMaintenanceVolume {
                    kind: kind.into(),
                    name: claim.claim_name.clone(),
                });
            }
        }
        summary
            .volumes
            .sort_by_key(|v| (v.kind.clone(), v.name.clone()));
    }
    plan.warnings.sort();
    plan.warnings.dedup();
    plan.fingerprint = fingerprint(&plan);
    Ok((plan, node))
}

async fn permission(
    client: Client,
    resource: &str,
    verb: &str,
    namespace: Option<String>,
    name: Option<String>,
    subresource: Option<String>,
) -> Result<()> {
    let api: Api<SelfSubjectAccessReview> = Api::all(client);
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                group: Some(String::new()),
                resource: Some(resource.into()),
                verb: Some(verb.into()),
                namespace,
                name,
                subresource,
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let result = bounded(api.create(&PostParams::default(), &review)).await?;
    if !result.status.is_some_and(|s| s.allowed) {
        bail!("node-maintenance:permission-denied");
    }
    Ok(())
}

impl Kubepit {
    pub async fn node_maintenance_preflight(
        &self,
        cluster_id: &str,
        name: &str,
    ) -> Result<NodeMaintenancePlan> {
        if !name_valid(name) {
            bail!("node-maintenance:invalid-node");
        }
        let cluster = self.cluster_def(cluster_id)?;
        let client = self
            .pool
            .connected_client(cluster_id)
            .context("node-maintenance:disconnected")?;
        let (plan, _) = tokio::time::timeout(
            Duration::from_secs(35),
            build_plan(client, name, cluster.read_only),
        )
        .await
        .map_err(|_| anyhow!("node-maintenance:timeout"))??;
        save_plan(cluster_id, plan.clone());
        Ok(plan)
    }

    pub(crate) async fn node_maintenance_drain_unaudited(
        &self,
        cluster_id: &str,
        request: &NodeMaintenanceDrainRequest,
    ) -> Result<NodeMaintenanceReceipt> {
        self.ensure_writable(cluster_id, "drain")?;
        let saved = cached(cluster_id, &request.plan_id)?;
        if saved.started
            || saved.created.elapsed() > REVIEW_TTL
            || request.name != saved.plan.node_name
            || request.node_uid != saved.plan.node_uid
            || request.fingerprint != saved.plan.fingerprint
        {
            bail!("node-maintenance:stale-plan");
        }
        self.pool
            .connected_client(cluster_id)
            .context("node-maintenance:disconnected")?;
        // Default kube clients retry HTTP 429 internally. For reviewed
        // mutations that hides PDB rejections and can silently resubmit
        // evictions. Use this cluster's explicit credentials with retries
        // disabled; revalidate and authorize with the same resulting client.
        // This never auto-connects or changes the shared connection pool.
        let revalidation_deadline = tokio::time::Instant::now() + Duration::from_secs(35);
        let client = tokio::time::timeout(Duration::from_secs(10), async {
            let cluster = self.cluster_def(cluster_id)?;
            let kubeconfig = self.cluster_kubeconfig_async(&cluster).await?;
            let mut config = kube::Config::from_custom_kubeconfig(
                kubeconfig,
                &kube::config::KubeConfigOptions {
                    context: Some(cluster.context),
                    ..Default::default()
                },
            )
            .await?;
            config.default_retry = false;
            Client::try_from(config).map_err(kube_error)
        })
        .await
        .map_err(|_| anyhow!("node-maintenance:timeout"))??;
        let (fresh, node) = tokio::time::timeout_at(
            revalidation_deadline,
            build_plan(client.clone(), &request.name, false),
        )
        .await
        .map_err(|_| anyhow!("node-maintenance:timeout"))??;
        if fresh.fingerprint != request.fingerprint || fresh.node_uid != request.node_uid {
            bail!("node-maintenance:stale-plan");
        }
        if !fresh.inventory_complete {
            bail!("node-maintenance:incomplete-inventory");
        }
        if fresh.pods.iter().any(|p| p.action == "unmanaged") {
            bail!("node-maintenance:unmanaged-pods");
        }
        permission(
            client.clone(),
            "nodes",
            "patch",
            None,
            Some(request.name.clone()),
            None,
        )
        .await?;
        let namespaces: BTreeSet<String> = fresh
            .pods
            .iter()
            .filter(|p| p.action == "evict")
            .map(|p| p.namespace.clone())
            .collect();
        if namespaces.len() > NAMESPACE_LIMIT {
            bail!("node-maintenance:incomplete-inventory");
        }
        // Check all needed namespaces before the first mutation, without
        // requiring a cluster-wide eviction grant for scoped credentials.
        let permission_checks = async {
            let decisions: Vec<(String, Result<()>)> = stream::iter(namespaces)
                .map(|ns| {
                    let client = client.clone();
                    async move {
                        let decision = permission(
                            client,
                            "pods",
                            "create",
                            Some(ns.clone()),
                            None,
                            Some("eviction".into()),
                        )
                        .await;
                        (ns, decision)
                    }
                })
                .buffer_unordered(8)
                .collect()
                .await;
            for (ns, decision) in decisions {
                if let Err(error) = decision {
                    if error.to_string() != "node-maintenance:permission-denied" {
                        return Err(error);
                    }
                    // Named subresource grants can allow every reviewed Pod
                    // while denying a namespace-wide capability check.
                    let targets: Vec<(String, String)> = fresh
                        .pods
                        .iter()
                        .filter(|pod| pod.action == "evict" && pod.namespace == ns)
                        .map(|pod| (pod.namespace.clone(), pod.name.clone()))
                        .collect();
                    let named: Vec<Result<()>> = stream::iter(targets)
                        .map(|(namespace, name)| {
                            permission(
                                client.clone(),
                                "pods",
                                "create",
                                Some(namespace),
                                Some(name),
                                Some("eviction".into()),
                            )
                        })
                        .buffer_unordered(8)
                        .collect()
                        .await;
                    for result in named {
                        result?;
                    }
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(30), permission_checks)
            .await
            .map_err(|_| anyhow!("node-maintenance:timeout"))??;
        self.ensure_writable(cluster_id, "drain")?;
        {
            let mut cache = plans().lock();
            let entry = cache
                .get_mut(&request.plan_id)
                .context("node-maintenance:plan-expired")?;
            if entry.started {
                bail!("node-maintenance:stale-plan");
            }
            entry.started = true;
        }
        let nodes: Api<Node> = Api::all(client.clone());
        let version = node
            .metadata
            .resource_version
            .context("node-maintenance:missing-identity")?;
        let patch: json_patch::Patch = serde_json::from_value(json!([
            {"op":"test","path":"/metadata/uid","value":request.node_uid},
            {"op":"test","path":"/metadata/resourceVersion","value":version},
            {"op":"add","path":"/spec/unschedulable","value":true}
        ]))?;
        bounded(nodes.patch(
            &request.name,
            &PatchParams::default(),
            &Patch::<Node>::Json(patch),
        ))
        .await?;
        let started_at = now();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let evictions = stream::iter(fresh.pods.into_iter().filter(|p| p.action == "evict"))
            .map(|pod| {
                let client = client.clone();
                async move {
                    let mut item = NodeMaintenanceEviction {
                        namespace: pod.namespace.clone(),
                        name: pod.name.clone(),
                        uid: pod.uid.clone(),
                        status: "failed".into(),
                        error: None,
                    };
                    if tokio::time::Instant::now() >= deadline {
                        item.status = "not-attempted".into();
                        return item;
                    }
                    if let Err(error) = self.ensure_writable(cluster_id, "drain") {
                        item.error = Some(error.to_string());
                        return item;
                    }
                    let api: Api<Pod> = Api::namespaced(client, &pod.namespace);
                    // kube 4.2's eviction helper serializes `delete_options`,
                    // which is not the Kubernetes wire field. Use the explicit
                    // subresource body so the reviewed Pod UID is enforced.
                    let eviction_body = json!({
                        "apiVersion": "policy/v1",
                        "kind": "Eviction",
                        "metadata": {"name": pod.name, "namespace": pod.namespace},
                        "deleteOptions": {"preconditions": {"uid": pod.uid}}
                    });
                    let eviction = tokio::time::timeout_at(
                        deadline,
                        bounded(api.create_subresource::<_, serde_json::Value>(
                            "eviction",
                            &pod.name,
                            &PostParams::default(),
                            &eviction_body,
                        )),
                    )
                    .await
                    .unwrap_or_else(|_| Err(anyhow!("node-maintenance:timeout")));
                    match eviction {
                        Ok(_) => item.status = "accepted".into(),
                        Err(error) if api_code(&error) == Some(404) => {
                            item.status = "already-gone".into()
                        }
                        Err(error) => {
                            item.status = if api_code(&error) == Some(429) {
                                "pdb-blocked"
                            } else if error.to_string().contains("node-maintenance:timeout") {
                                "timeout"
                            } else {
                                "failed"
                            }
                            .into();
                            item.error = Some(error.to_string().chars().take(2048).collect());
                        }
                    }
                    item
                }
            })
            .buffered(8)
            .collect()
            .await;
        Ok(NodeMaintenanceReceipt {
            plan_id: request.plan_id.clone(),
            started_at,
            node_cordoned: true,
            evictions,
        })
    }

    pub async fn node_maintenance_progress(
        &self,
        cluster_id: &str,
        plan_id: &str,
    ) -> Result<NodeMaintenanceProgress> {
        let saved = cached(cluster_id, plan_id)?;
        if !saved.started {
            bail!("node-maintenance:not-started");
        }
        let client = self
            .pool
            .connected_client(cluster_id)
            .context("node-maintenance:disconnected")?;
        let node_api: Api<Node> = Api::all(client.clone());
        let namespaces = saved
            .plan
            .pods
            .iter()
            .filter(|p| p.action == "evict")
            .map(|p| p.namespace.clone())
            .collect();
        let (node, peers) = tokio::join!(
            bounded(node_api.get(&saved.plan.node_name)),
            namespace_pods(client, namespaces)
        );
        let mut warnings = Vec::new();
        let node_uid_matches = node
            .as_ref()
            .is_ok_and(|n| n.metadata.uid.as_deref() == Some(&saved.plan.node_uid));
        let node_cordoned = node.as_ref().ok().filter(|_| node_uid_matches).map(|n| {
            n.spec
                .as_ref()
                .and_then(|s| s.unschedulable)
                .unwrap_or(false)
        });
        if !node_uid_matches {
            warnings.push("node-unverified".into());
        }
        let sources = saved
            .plan
            .pods
            .iter()
            .filter(|p| p.action == "evict")
            .map(|source| {
                let state = match peers.get(&source.namespace) {
                    Some(Ok((pods, complete))) => match pods
                        .iter()
                        .find(|p| p.metadata.uid.as_deref() == Some(&source.uid))
                    {
                        Some(p) if p.metadata.deletion_timestamp.is_some() => "terminating",
                        Some(_) => "present",
                        None if *complete => "gone",
                        None => "unknown",
                    },
                    _ => "unknown",
                };
                NodeMaintenanceSourceProgress {
                    namespace: source.namespace.clone(),
                    name: source.name.clone(),
                    uid: source.uid.clone(),
                    state: state.into(),
                }
            })
            .collect();
        let workloads = saved
            .plan
            .workloads
            .iter()
            .map(|workload| {
                let mut replacements = Vec::new();
                let complete = match peers.get(&workload.namespace) {
                    Some(Ok((pods, complete))) => {
                        if workload.complete {
                            replacements = pods
                                .iter()
                                .filter(|pod| {
                                    owner(pod).is_some_and(|o| o.uid == workload.owner.uid)
                                        && pod.metadata.uid.as_ref().is_some_and(|uid| {
                                            !workload.baseline_uids.contains(uid)
                                        })
                                        && pod.metadata.deletion_timestamp.is_none()
                                })
                                .map(|pod| NodeMaintenanceReplacement {
                                    name: pod.metadata.name.clone().unwrap_or_default(),
                                    uid: pod.metadata.uid.clone().unwrap_or_default(),
                                    node: pod
                                        .spec
                                        .as_ref()
                                        .and_then(|s| s.node_name.clone())
                                        .unwrap_or_default(),
                                    ready: ready(pod),
                                    phase: phase(pod),
                                })
                                .take(500)
                                .collect();
                        }
                        *complete && workload.complete
                    }
                    _ => false,
                };
                if !complete {
                    warnings.push("workloads-partial".into());
                }
                NodeMaintenanceWorkloadProgress {
                    namespace: workload.namespace.clone(),
                    owner: workload.owner.clone(),
                    expected_replacements: workload.expected_replacements,
                    replacements,
                    complete,
                }
            })
            .collect();
        warnings.sort();
        warnings.dedup();
        Ok(NodeMaintenanceProgress {
            checked_at: now(),
            node_uid_matches,
            node_cordoned,
            sources,
            workloads,
            warnings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_v1_selectors_and_shared_budget_are_evaluated() {
        let labels = BTreeMap::from([("app".into(), "api".into())]);
        assert_eq!(selector_matches(None, &labels), Some(false));
        assert_eq!(
            selector_matches(Some(&LabelSelector::default()), &labels),
            Some(true)
        );
        let selector: LabelSelector = serde_json::from_value(json!({"matchExpressions":[{"key":"tier","operator":"NotIn","values":["batch"]},{"key":"app","operator":"Exists"}]})).unwrap();
        assert_eq!(selector_matches(Some(&selector), &labels), Some(true));
        let invalid: LabelSelector = serde_json::from_value(
            json!({"matchExpressions":[{"key":"app","operator":"Unknown"}]}),
        )
        .unwrap();
        assert_eq!(selector_matches(Some(&invalid), &labels), None);
        let pdb: PodDisruptionBudget = serde_json::from_value(json!({"spec":{"unhealthyPodEvictionPolicy":"AlwaysAllow"},"status":{"currentHealthy":1,"desiredHealthy":1,"disruptionsAllowed":0,"expectedPods":2}})).unwrap();
        let raw: Pod = serde_json::from_value(json!({"metadata":{"name":"p","namespace":"ns","uid":"uid"},"status":{"phase":"Running"}})).unwrap();
        let mut pod = pod_summary(&raw);
        assert!(!required_disruption(&pod, &pdb));
        pod.ready = true;
        assert!(required_disruption(&pod, &pdb));
        assert_eq!(
            [pod.clone(), pod]
                .iter()
                .filter(|p| required_disruption(p, &pdb))
                .count(),
            2
        );
    }
}
