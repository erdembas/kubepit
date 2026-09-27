//! Transition detection: (previous state, new object) → findings.
//!
//! The monitor deserialises only the fields detection needs into the slim
//! types below (serde skips `spec`, `managedFields`, labels, …), keeps a
//! compact snapshot per object, and asks [`Watched::findings`] what changed.
//! Everything here is pure, so each reason is unit-tested without a cluster.
//!
//! `old: None` means "not seen before": a pod or Job created after the
//! baseline, where any failure is new. Nodes are the exception: a node that
//! joins starts NotReady, so an unseen node never alerts.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::fmt::Debug;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use k8s_openapi::{ClusterResourceScope, NamespaceResourceScope};
use kube::runtime::watcher::Event;
use kube::Resource;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};

use super::model::{AlertObjectRef, AlertReason, WatchedKind};

/// One detected transition, before dedupe and filtering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub reason: AlertReason,
    pub container: Option<String>,
    pub condition: Option<String>,
    pub message: String,
}

impl Finding {
    fn new(reason: AlertReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            container: None,
            condition: None,
            message: message.into(),
        }
    }

    fn container(mut self, name: &str) -> Self {
        self.container = Some(name.to_string());
        self
    }

    fn condition(mut self, name: &str) -> Self {
        self.condition = Some(name.to_string());
        self
    }
}

/// `reason: message`, skipping empty parts.
fn join(reason: Option<&str>, message: Option<&str>) -> String {
    match (
        reason.filter(|s| !s.is_empty()),
        message.filter(|s| !s.is_empty()),
    ) {
        (Some(r), Some(m)) => format!("{r}: {m}"),
        (Some(r), None) => r.to_string(),
        (None, Some(m)) => m.to_string(),
        (None, None) => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Slim resources
// ---------------------------------------------------------------------------

/// Metadata without managedFields, labels or annotations: only what the
/// watcher (resourceVersion) and the alerts (identity) need.
fn slim_meta<'de, D: Deserializer<'de>>(d: D) -> Result<ObjectMeta, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fields {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        uid: Option<String>,
        #[serde(default)]
        resource_version: Option<String>,
    }
    let f = Option::<Fields>::deserialize(d)?;
    Ok(f.map(|f| ObjectMeta {
        name: f.name,
        namespace: f.namespace,
        uid: f.uid,
        resource_version: f.resource_version,
        ..Default::default()
    })
    .unwrap_or_default())
}

macro_rules! slim_resource {
    ($ty:ident, $kind:literal, $group:literal, $version:literal, $plural:literal, $scope:ty) => {
        impl Resource for $ty {
            type DynamicType = ();
            type Scope = $scope;
            fn kind(_: &()) -> Cow<'_, str> {
                Cow::Borrowed($kind)
            }
            fn group(_: &()) -> Cow<'_, str> {
                Cow::Borrowed($group)
            }
            fn version(_: &()) -> Cow<'_, str> {
                Cow::Borrowed($version)
            }
            fn plural(_: &()) -> Cow<'_, str> {
                Cow::Borrowed($plural)
            }
            fn meta(&self) -> &ObjectMeta {
                &self.metadata
            }
            fn meta_mut(&mut self) -> &mut ObjectMeta {
                &mut self.metadata
            }
        }
    };
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    #[serde(rename = "type", default)]
    pub type_: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Waiting {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terminated {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub exit_code: i32,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default, rename = "containerID")]
    pub container_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ContainerStateSlim {
    #[serde(default)]
    pub waiting: Option<Waiting>,
    #[serde(default)]
    pub terminated: Option<Terminated>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStatusSlim {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub state: Option<ContainerStateSlim>,
    #[serde(default)]
    pub last_state: Option<ContainerStateSlim>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodStatusSlim {
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub container_statuses: Vec<ContainerStatusSlim>,
    #[serde(default)]
    pub init_container_statuses: Vec<ContainerStatusSlim>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SlimPod {
    #[serde(default, deserialize_with = "slim_meta")]
    pub metadata: ObjectMeta,
    #[serde(default)]
    pub status: Option<PodStatusSlim>,
}
slim_resource!(SlimPod, "Pod", "", "v1", "pods", NamespaceResourceScope);

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConditionsStatus {
    #[serde(default)]
    pub conditions: Vec<Condition>,
}

impl ConditionsStatus {
    fn get(&self, type_: &str) -> Option<&Condition> {
        self.conditions.iter().find(|c| c.type_ == type_)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SlimJob {
    #[serde(default, deserialize_with = "slim_meta")]
    pub metadata: ObjectMeta,
    #[serde(default)]
    pub status: Option<ConditionsStatus>,
}
slim_resource!(
    SlimJob,
    "Job",
    "batch",
    "v1",
    "jobs",
    NamespaceResourceScope
);

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SlimNode {
    #[serde(default, deserialize_with = "slim_meta")]
    pub metadata: ObjectMeta,
    #[serde(default)]
    pub status: Option<ConditionsStatus>,
}
slim_resource!(SlimNode, "Node", "", "v1", "nodes", ClusterResourceScope);

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SlimDeployment {
    #[serde(default, deserialize_with = "slim_meta")]
    pub metadata: ObjectMeta,
    #[serde(default)]
    pub status: Option<ConditionsStatus>,
}
slim_resource!(
    SlimDeployment,
    "Deployment",
    "apps",
    "v1",
    "deployments",
    NamespaceResourceScope
);

// ---------------------------------------------------------------------------
// Detection per kind
// ---------------------------------------------------------------------------

/// A kind the monitor watches: its compact snapshot and its transitions.
pub trait Watched:
    Resource<DynamicType = ()> + Clone + DeserializeOwned + Debug + Send + Sync + 'static
{
    type Snap: Send + Sync + 'static;
    const KIND: WatchedKind;

    fn snapshot(&self) -> Self::Snap;
    fn findings(old: Option<&Self::Snap>, new: &Self) -> Vec<Finding>;
}

/// Identity of a container termination, stable when it moves from
/// `state.terminated` to `lastState.terminated` on restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermId {
    pub reason: String,
    pub finished_at: Option<String>,
    pub container_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerSnap {
    pub name: String,
    pub waiting: Option<String>,
    pub last_termination: Option<TermId>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PodSnap {
    pub evicted: bool,
    pub containers: Vec<ContainerSnap>,
}

const IMAGE_PULL: [&str; 2] = ["ImagePullBackOff", "ErrImagePull"];

fn latest_termination(c: &ContainerStatusSlim) -> Option<&Terminated> {
    c.state
        .as_ref()
        .and_then(|s| s.terminated.as_ref())
        .or_else(|| c.last_state.as_ref().and_then(|s| s.terminated.as_ref()))
}

fn term_id(t: &Terminated) -> TermId {
    TermId {
        reason: t.reason.clone().unwrap_or_default(),
        finished_at: t.finished_at.clone(),
        container_id: t.container_id.clone(),
    }
}

fn waiting(c: &ContainerStatusSlim) -> Option<&Waiting> {
    c.state.as_ref().and_then(|s| s.waiting.as_ref())
}

fn all_containers(status: &PodStatusSlim) -> impl Iterator<Item = &ContainerStatusSlim> {
    status
        .init_container_statuses
        .iter()
        .chain(status.container_statuses.iter())
}

fn is_evicted(status: &PodStatusSlim) -> bool {
    status.phase.as_deref() == Some("Failed") && status.reason.as_deref() == Some("Evicted")
}

impl Watched for SlimPod {
    type Snap = PodSnap;
    const KIND: WatchedKind = WatchedKind::Pods;

    fn snapshot(&self) -> PodSnap {
        let Some(status) = &self.status else {
            return PodSnap::default();
        };
        PodSnap {
            evicted: is_evicted(status),
            containers: all_containers(status)
                .map(|c| ContainerSnap {
                    name: c.name.clone(),
                    waiting: waiting(c).and_then(|w| w.reason.clone()),
                    last_termination: latest_termination(c).map(term_id),
                })
                .collect(),
        }
    }

    fn findings(old: Option<&PodSnap>, new: &SlimPod) -> Vec<Finding> {
        let Some(status) = &new.status else {
            return Vec::new();
        };
        let empty = PodSnap::default();
        let old = old.unwrap_or(&empty);
        let mut out = Vec::new();
        for c in all_containers(status) {
            let before = old.containers.iter().find(|o| o.name == c.name);
            let was_waiting = before.and_then(|b| b.waiting.as_deref());
            if let Some(w) = waiting(c) {
                let reason = w.reason.as_deref().unwrap_or_default();
                if reason == "CrashLoopBackOff" && was_waiting != Some("CrashLoopBackOff") {
                    out.push(
                        Finding::new(
                            AlertReason::CrashLoopBackOff,
                            w.message.clone().unwrap_or_default(),
                        )
                        .container(&c.name),
                    );
                }
                let pulling = |r: Option<&str>| r.is_some_and(|r| IMAGE_PULL.contains(&r));
                if pulling(Some(reason)) && !pulling(was_waiting) {
                    out.push(
                        Finding::new(
                            AlertReason::ImagePullBackOff,
                            join(Some(reason), w.message.as_deref()),
                        )
                        .container(&c.name),
                    );
                }
            }
            if let Some(t) = latest_termination(c) {
                let id = term_id(t);
                let seen = before.and_then(|b| b.last_termination.as_ref()) == Some(&id);
                if id.reason == "OOMKilled" && !seen {
                    let message = match t.message.as_deref().filter(|m| !m.is_empty()) {
                        Some(m) => format!("exit code {}: {m}", t.exit_code),
                        None => format!("exit code {}", t.exit_code),
                    };
                    out.push(Finding::new(AlertReason::OomKilled, message).container(&c.name));
                }
            }
        }
        if is_evicted(status) && !old.evicted {
            out.push(Finding::new(
                AlertReason::Evicted,
                status.message.clone().unwrap_or_default(),
            ));
        }
        out
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobSnap {
    pub failed: bool,
}

fn job_failed(job: &SlimJob) -> Option<&Condition> {
    job.status
        .as_ref()
        .and_then(|s| s.get("Failed"))
        .filter(|c| c.status == "True")
}

impl Watched for SlimJob {
    type Snap = JobSnap;
    const KIND: WatchedKind = WatchedKind::Jobs;

    fn snapshot(&self) -> JobSnap {
        JobSnap {
            failed: job_failed(self).is_some(),
        }
    }

    fn findings(old: Option<&JobSnap>, new: &SlimJob) -> Vec<Finding> {
        match job_failed(new) {
            Some(c) if !old.is_some_and(|o| o.failed) => vec![Finding::new(
                AlertReason::JobFailed,
                join(c.reason.as_deref(), c.message.as_deref()),
            )],
            _ => Vec::new(),
        }
    }
}

/// Node conditions that alert when they turn `True`.
pub const PRESSURE_CONDITIONS: [&str; 3] = ["MemoryPressure", "DiskPressure", "PIDPressure"];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeSnap {
    pub ready: bool,
    pub pressures: BTreeSet<String>,
}

impl Watched for SlimNode {
    type Snap = NodeSnap;
    const KIND: WatchedKind = WatchedKind::Nodes;

    fn snapshot(&self) -> NodeSnap {
        let Some(status) = &self.status else {
            return NodeSnap::default();
        };
        NodeSnap {
            ready: status.get("Ready").is_some_and(|c| c.status == "True"),
            pressures: PRESSURE_CONDITIONS
                .iter()
                .filter(|t| status.get(t).is_some_and(|c| c.status == "True"))
                .map(|t| t.to_string())
                .collect(),
        }
    }

    fn findings(old: Option<&NodeSnap>, new: &SlimNode) -> Vec<Finding> {
        let (Some(old), Some(status)) = (old, &new.status) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if let Some(ready) = status.get("Ready") {
            // A missing Ready condition is not a transition we can judge.
            if old.ready && ready.status != "True" {
                let status_text = format!("Ready={}", ready.status);
                let detail = join(ready.reason.as_deref(), ready.message.as_deref());
                let message = if detail.is_empty() {
                    status_text
                } else {
                    format!("{status_text} · {detail}")
                };
                out.push(Finding::new(AlertReason::NodeNotReady, message));
            }
        }
        for t in PRESSURE_CONDITIONS {
            let Some(c) = status.get(t).filter(|c| c.status == "True") else {
                continue;
            };
            if !old.pressures.contains(t) {
                out.push(
                    Finding::new(
                        AlertReason::NodePressure,
                        join(c.reason.as_deref(), c.message.as_deref()),
                    )
                    .condition(t),
                );
            }
        }
        out
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeploymentSnap {
    pub deadline_exceeded: bool,
}

fn deadline_exceeded(d: &SlimDeployment) -> Option<&Condition> {
    d.status
        .as_ref()
        .and_then(|s| s.get("Progressing"))
        .filter(|c| c.reason.as_deref() == Some("ProgressDeadlineExceeded"))
}

impl Watched for SlimDeployment {
    type Snap = DeploymentSnap;
    const KIND: WatchedKind = WatchedKind::Deployments;

    fn snapshot(&self) -> DeploymentSnap {
        DeploymentSnap {
            deadline_exceeded: deadline_exceeded(self).is_some(),
        }
    }

    fn findings(old: Option<&DeploymentSnap>, new: &SlimDeployment) -> Vec<Finding> {
        match deadline_exceeded(new) {
            Some(c) if !old.is_some_and(|o| o.deadline_exceeded) => vec![Finding::new(
                AlertReason::ProgressDeadlineExceeded,
                c.message.clone().unwrap_or_default(),
            )],
            _ => Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Watch event folding
// ---------------------------------------------------------------------------

pub fn object_ref<K: Watched>(obj: &K) -> AlertObjectRef {
    let meta = obj.meta();
    AlertObjectRef {
        group: K::group(&()).into_owned(),
        version: K::version(&()).into_owned(),
        kind: K::kind(&()).into_owned(),
        namespace: meta.namespace.clone(),
        name: meta.name.clone().unwrap_or_default(),
    }
}

fn key_of<K: Watched>(obj: &K) -> String {
    let meta = obj.meta();
    match meta.uid.as_deref() {
        Some(uid) if !uid.is_empty() => uid.to_string(),
        _ => format!(
            "{}/{}",
            meta.namespace.as_deref().unwrap_or(""),
            meta.name.as_deref().unwrap_or("")
        ),
    }
}

/// Snapshots of one watcher's objects. The first list only establishes the
/// baseline; a re-list after a desync compares against what was known, so
/// transitions that happened during the gap are still reported once.
pub struct Tracker<K: Watched> {
    snaps: HashMap<String, K::Snap>,
    relist: Option<HashMap<String, K::Snap>>,
    synced: bool,
}

impl<K: Watched> Default for Tracker<K> {
    fn default() -> Self {
        Self {
            snaps: HashMap::new(),
            relist: None,
            synced: false,
        }
    }
}

impl<K: Watched> Tracker<K> {
    /// Whether the first list completed.
    pub fn synced(&self) -> bool {
        self.synced
    }

    pub fn len(&self) -> usize {
        self.snaps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.snaps.is_empty()
    }

    fn observe(&mut self, obj: &K) -> Vec<Finding> {
        let key = key_of(obj);
        let findings = K::findings(self.snaps.get(&key), obj);
        self.snaps.insert(key, obj.snapshot());
        findings
    }

    /// Fold one watcher event; returns the transitions it revealed.
    pub fn on_event(&mut self, event: Event<K>) -> Vec<(AlertObjectRef, Finding)> {
        let with_ref = |obj: &K, findings: Vec<Finding>| {
            let object = object_ref(obj);
            findings
                .into_iter()
                .map(|f| (object.clone(), f))
                .collect::<Vec<_>>()
        };
        match event {
            Event::Init => {
                if self.synced {
                    self.relist = Some(HashMap::new());
                }
                Vec::new()
            }
            Event::InitApply(obj) => {
                let key = key_of(&obj);
                if let Some(fresh) = self.relist.as_mut() {
                    let findings = K::findings(self.snaps.get(&key), &obj);
                    fresh.insert(key, obj.snapshot());
                    return with_ref(&obj, findings);
                }
                if !self.synced {
                    // Baseline: remember, never alert.
                    self.snaps.insert(key, obj.snapshot());
                    return Vec::new();
                }
                let findings = self.observe(&obj);
                with_ref(&obj, findings)
            }
            Event::InitDone => {
                if let Some(fresh) = self.relist.take() {
                    self.snaps = fresh;
                }
                self.synced = true;
                Vec::new()
            }
            Event::Apply(obj) => {
                let findings = self.observe(&obj);
                with_ref(&obj, findings)
            }
            Event::Delete(obj) => {
                self.snaps.remove(&key_of(&obj));
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn pod(containers: Value) -> SlimPod {
        serde_json::from_value(json!({
            "metadata": {"name": "web-1", "namespace": "shop", "uid": "u-web-1",
                         "resourceVersion": "5", "managedFields": [{"manager": "kubelet"}],
                         "labels": {"app": "web"}},
            "spec": {"containers": [{"name": "app", "image": "web:1"}]},
            "status": {"phase": "Running", "containerStatuses": containers}
        }))
        .unwrap()
    }

    fn running(name: &str) -> Value {
        json!({"name": name, "restartCount": 0, "state": {"running": {"startedAt": "2024-01-01T00:00:00Z"}}})
    }

    fn waiting_in(name: &str, reason: &str) -> Value {
        json!({"name": name, "restartCount": 3,
               "state": {"waiting": {"reason": reason, "message": format!("{reason} message")}}})
    }

    fn oom(name: &str, finished: &str, in_last_state: bool) -> Value {
        let term = json!({"terminated": {"reason": "OOMKilled", "exitCode": 137,
                                         "finishedAt": finished, "containerID": "containerd://abc"}});
        if in_last_state {
            json!({"name": name, "restartCount": 1, "state": {"running": {}}, "lastState": term})
        } else {
            json!({"name": name, "restartCount": 0, "state": term})
        }
    }

    fn reasons(findings: &[Finding]) -> Vec<AlertReason> {
        findings.iter().map(|f| f.reason).collect()
    }

    fn step<K: Watched>(old: &K, new: &K) -> Vec<Finding> {
        K::findings(Some(&old.snapshot()), new)
    }

    #[test]
    fn slim_pod_keeps_only_what_detection_needs() {
        let p = pod(json!([running("app")]));
        assert_eq!(p.metadata.name.as_deref(), Some("web-1"));
        assert_eq!(p.metadata.resource_version.as_deref(), Some("5"));
        assert!(p.metadata.managed_fields.is_none());
        assert!(p.metadata.labels.is_none());
        assert_eq!(
            object_ref(&p),
            AlertObjectRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Pod".into(),
                namespace: Some("shop".into()),
                name: "web-1".into(),
            }
        );
    }

    #[test]
    fn crash_loop_fires_on_entry_only() {
        let ok = pod(json!([running("app")]));
        let crashing = pod(json!([waiting_in("app", "CrashLoopBackOff")]));
        let found = step(&ok, &crashing);
        assert_eq!(reasons(&found), vec![AlertReason::CrashLoopBackOff]);
        assert_eq!(found[0].container.as_deref(), Some("app"));
        assert_eq!(found[0].message, "CrashLoopBackOff message");
        assert!(
            step(&crashing, &crashing).is_empty(),
            "still crashing is no transition"
        );
        // Back-off → running → back-off again is a new crash.
        assert_eq!(
            reasons(&step(&ok, &crashing)),
            vec![AlertReason::CrashLoopBackOff]
        );
    }

    #[test]
    fn image_pull_flapping_between_reasons_fires_once() {
        let ok = pod(json!([running("app")]));
        let err = pod(json!([waiting_in("app", "ErrImagePull")]));
        let backoff = pod(json!([waiting_in("app", "ImagePullBackOff")]));
        let found = step(&ok, &err);
        assert_eq!(reasons(&found), vec![AlertReason::ImagePullBackOff]);
        assert_eq!(found[0].message, "ErrImagePull: ErrImagePull message");
        assert!(step(&err, &backoff).is_empty());
        assert!(step(&backoff, &err).is_empty());
        let creating = pod(json!([waiting_in("app", "ContainerCreating")]));
        assert_eq!(
            reasons(&step(&creating, &backoff)),
            vec![AlertReason::ImagePullBackOff]
        );
    }

    #[test]
    fn oom_kill_fires_once_per_termination() {
        let ok = pod(json!([running("app")]));
        let killed = pod(json!([oom("app", "2024-01-01T10:00:00Z", false)]));
        let restarted = pod(json!([oom("app", "2024-01-01T10:00:00Z", true)]));
        let found = step(&ok, &killed);
        assert_eq!(reasons(&found), vec![AlertReason::OomKilled]);
        assert_eq!(found[0].message, "exit code 137");
        assert!(
            step(&killed, &restarted).is_empty(),
            "the same termination moving to lastState is not new"
        );
        let again = pod(json!([oom("app", "2024-01-01T10:05:00Z", true)]));
        assert_eq!(
            reasons(&step(&restarted, &again)),
            vec![AlertReason::OomKilled]
        );
        // Other termination reasons are not OOM kills.
        let mut error = oom("app", "2024-01-01T11:00:00Z", true);
        error["lastState"]["terminated"]["reason"] = json!("Error");
        assert!(step(&again, &pod(json!([error]))).is_empty());
    }

    #[test]
    fn init_containers_are_watched_too() {
        let mut p = pod(json!([]));
        p.status.as_mut().unwrap().init_container_statuses =
            serde_json::from_value(json!([waiting_in("migrate", "CrashLoopBackOff")])).unwrap();
        let found = SlimPod::findings(Some(&pod(json!([])).snapshot()), &p);
        assert_eq!(found[0].container.as_deref(), Some("migrate"));
    }

    #[test]
    fn eviction_fires_on_the_failed_phase() {
        let ok = pod(json!([running("app")]));
        let evicted: SlimPod = serde_json::from_value(json!({
            "metadata": {"name": "web-1", "namespace": "shop", "uid": "u-web-1"},
            "status": {"phase": "Failed", "reason": "Evicted",
                       "message": "The node was low on resource: memory."}
        }))
        .unwrap();
        let found = step(&ok, &evicted);
        assert_eq!(reasons(&found), vec![AlertReason::Evicted]);
        assert_eq!(found[0].message, "The node was low on resource: memory.");
        assert!(step(&evicted, &evicted).is_empty());
    }

    #[test]
    fn a_pod_seen_for_the_first_time_reports_existing_failures() {
        let crashing = pod(json!([waiting_in("app", "CrashLoopBackOff")]));
        assert_eq!(
            reasons(&SlimPod::findings(None, &crashing)),
            vec![AlertReason::CrashLoopBackOff]
        );
        assert!(SlimPod::findings(None, &pod(json!([running("app")]))).is_empty());
    }

    fn with_conditions<K: DeserializeOwned>(name: &str, conditions: Value) -> K {
        serde_json::from_value(json!({
            "metadata": {"name": name, "namespace": "batch", "uid": format!("u-{name}")},
            "status": {"conditions": conditions}
        }))
        .unwrap()
    }

    #[test]
    fn job_failure_fires_once() {
        let running: SlimJob = with_conditions("nightly", json!([]));
        let failed: SlimJob = with_conditions(
            "nightly",
            json!([{"type": "Failed", "status": "True", "reason": "BackoffLimitExceeded",
                    "message": "Job has reached the specified backoff limit"}]),
        );
        let found = step(&running, &failed);
        assert_eq!(reasons(&found), vec![AlertReason::JobFailed]);
        assert_eq!(
            found[0].message,
            "BackoffLimitExceeded: Job has reached the specified backoff limit"
        );
        assert!(step(&failed, &failed).is_empty());
        let complete: SlimJob =
            with_conditions("nightly", json!([{"type": "Complete", "status": "True"}]));
        assert!(step(&running, &complete).is_empty());
    }

    fn node(ready: &str, pressures: &[&str]) -> SlimNode {
        let mut conditions = vec![json!({"type": "Ready", "status": ready,
                                         "reason": if ready == "True" { "KubeletReady" } else { "NodeStatusUnknown" },
                                         "message": if ready == "True" { "kubelet is posting ready status" } else { "Kubelet stopped posting node status." }})];
        for t in PRESSURE_CONDITIONS {
            let on = pressures.contains(&t);
            conditions.push(json!({"type": t, "status": if on { "True" } else { "False" },
                                   "reason": format!("Kubelet{}{t}", if on { "Has" } else { "HasNo" })}));
        }
        serde_json::from_value(json!({
            "metadata": {"name": "n1", "uid": "u-n1"},
            "status": {"conditions": conditions}
        }))
        .unwrap()
    }

    #[test]
    fn node_not_ready_and_new_pressure() {
        let healthy = node("True", &[]);
        let unknown = node("Unknown", &[]);
        let found = step(&healthy, &unknown);
        assert_eq!(reasons(&found), vec![AlertReason::NodeNotReady]);
        assert_eq!(
            found[0].message,
            "Ready=Unknown · NodeStatusUnknown: Kubelet stopped posting node status."
        );
        assert!(
            step(&unknown, &node("False", &[])).is_empty(),
            "already not ready"
        );

        let disk = node("True", &["DiskPressure"]);
        let found = step(&healthy, &disk);
        assert_eq!(reasons(&found), vec![AlertReason::NodePressure]);
        assert_eq!(found[0].condition.as_deref(), Some("DiskPressure"));
        let both = node("True", &["DiskPressure", "MemoryPressure"]);
        let found = step(&disk, &both);
        assert_eq!(found.len(), 1, "only the new pressure");
        assert_eq!(found[0].condition.as_deref(), Some("MemoryPressure"));
        // A node seen for the first time (joining, NotReady) never alerts.
        assert!(SlimNode::findings(None, &node("False", &["DiskPressure"])).is_empty());
    }

    #[test]
    fn deployment_progress_deadline() {
        let progressing: SlimDeployment = with_conditions(
            "web",
            json!([{"type": "Progressing", "status": "True", "reason": "ReplicaSetUpdated"}]),
        );
        let stuck: SlimDeployment = with_conditions(
            "web",
            json!([{"type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded",
                    "message": "ReplicaSet \"web-7d4\" has timed out progressing."}]),
        );
        let found = step(&progressing, &stuck);
        assert_eq!(reasons(&found), vec![AlertReason::ProgressDeadlineExceeded]);
        assert_eq!(
            found[0].message,
            "ReplicaSet \"web-7d4\" has timed out progressing."
        );
        assert!(step(&stuck, &stuck).is_empty());
    }

    #[test]
    fn baseline_never_fires_and_relist_catches_gaps() {
        let ok = pod(json!([running("app")]));
        let crashing = pod(json!([waiting_in("app", "CrashLoopBackOff")]));
        let mut other = crashing.clone();
        other.metadata.name = Some("api-0".into());
        other.metadata.uid = Some("u-api-0".into());

        let mut t = Tracker::<SlimPod>::default();
        assert!(t.on_event(Event::Init).is_empty());
        assert!(
            t.on_event(Event::InitApply(other.clone())).is_empty(),
            "a pod already crashing at connect is the baseline"
        );
        assert!(t.on_event(Event::InitApply(ok.clone())).is_empty());
        assert!(t.on_event(Event::InitDone).is_empty());
        assert!(t.synced());
        assert_eq!(t.len(), 2);

        let hits = t.on_event(Event::Apply(crashing.clone()));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.name, "web-1");
        assert!(t.on_event(Event::Apply(other.clone())).is_empty());

        // web-1 recovers, then the watch desyncs; during the gap it crashes
        // again and api-0 is deleted. The re-list reports web-1 once.
        t.on_event(Event::Apply(ok.clone()));
        t.on_event(Event::Init);
        let hits = t.on_event(Event::InitApply(crashing.clone()));
        assert_eq!(hits.len(), 1);
        t.on_event(Event::InitDone);
        assert_eq!(t.len(), 1, "api-0 vanished during the gap");
        assert!(t.on_event(Event::Apply(crashing)).is_empty());

        t.on_event(Event::Delete(ok));
        assert!(t.is_empty());
    }
}
