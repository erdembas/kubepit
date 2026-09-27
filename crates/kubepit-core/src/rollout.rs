//! Rollout history and rollback for Deployments, StatefulSets and DaemonSets.
//!
//! History mirrors `kubectl rollout history`:
//! - a Deployment keeps one ReplicaSet per pod template; its revision is the
//!   ReplicaSet's `deployment.kubernetes.io/revision` annotation;
//! - StatefulSets and DaemonSets keep ControllerRevisions whose `data` is a
//!   strategic merge patch that replaces `spec.template`.
//!
//! Owned objects are listed with the workload's selector and then filtered
//! by controller ownerReference uid, so a selector that also matches other
//! workloads never leaks their revisions in.
//!
//! Undo mirrors `kubectl rollout undo --to-revision` (revision `0` means the
//! previous one): a Deployment gets the ReplicaSet's template back (minus
//! `pod-template-hash`) together with the change-cause recorded on it; a
//! StatefulSet / DaemonSet gets the ControllerRevision `data` applied as a
//! strategic merge patch. Unlike kubectl, the Deployment's other annotations
//! are merged rather than replaced, so annotations added since that revision
//! (GitOps tracking ids, owners) survive a rollback.
//!
//! The planners (history building, template extraction, undo patches) are
//! pure functions so they can be unit-tested without a cluster.

use anyhow::{anyhow, bail, Context, Result};
use kube::api::{Api, ApiResource, DynamicObject, ListParams, Patch, PatchParams};
use serde_json::{json, Map, Value};

use crate::app::Kubepit;
use crate::error::kube_error;
use crate::objects::api_resource;
use crate::types::{ContainerImage, Gvk, RolloutRevision};

/// Revision counter the Deployment controller stamps on Deployments and ReplicaSets.
pub const REVISION_ANNOTATION: &str = "deployment.kubernetes.io/revision";
/// Human-readable reason for a rollout, shown by `kubectl rollout history`.
pub const CHANGE_CAUSE_ANNOTATION: &str = "kubernetes.io/change-cause";
const POD_TEMPLATE_HASH_LABEL: &str = "pod-template-hash";
const CONTROLLER_REVISION_HASH_LABEL: &str = "controller-revision-hash";

/// Deployment annotations owned by the controller (or kubectl); never copied
/// back from a ReplicaSet on rollback (kubectl's `annotationsToSkip`).
const DEPLOYMENT_OWNED_ANNOTATIONS: &[&str] = &[
    "kubectl.kubernetes.io/last-applied-configuration",
    REVISION_ANNOTATION,
    "deployment.kubernetes.io/revision-history",
    "deployment.kubernetes.io/desired-replicas",
    "deployment.kubernetes.io/max-replicas",
    "deprecated.deployment.rollback.to",
];

/// The workload kinds with a rollout history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RolloutKind {
    Deployment,
    StatefulSet,
    DaemonSet,
}

impl RolloutKind {
    pub fn of(gvk: &Gvk) -> Result<Self> {
        match (gvk.group.as_str(), gvk.kind.as_str()) {
            ("apps", "Deployment") => Ok(Self::Deployment),
            ("apps", "StatefulSet") => Ok(Self::StatefulSet),
            ("apps", "DaemonSet") => Ok(Self::DaemonSet),
            _ => bail!(
                "{} has no rollout history (only Deployments, StatefulSets and DaemonSets do)",
                gvk.kind
            ),
        }
    }

    /// The kind of object that records one revision.
    fn revision_resource(self) -> ApiResource {
        let (kind, plural) = match self {
            Self::Deployment => ("ReplicaSet", "replicasets"),
            Self::StatefulSet | Self::DaemonSet => ("ControllerRevision", "controllerrevisions"),
        };
        ApiResource {
            group: "apps".into(),
            version: "v1".into(),
            api_version: "apps/v1".into(),
            kind: kind.into(),
            plural: plural.into(),
        }
    }
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn annotation<'a>(obj: &'a Value, key: &str) -> Option<&'a str> {
    obj.pointer("/metadata/annotations")
        .and_then(|a| a.get(key))
        .and_then(Value::as_str)
}

/// A `metav1.LabelSelector` as a `labelSelector` query (`None` selects
/// everything). Malformed expressions are skipped: the selector only narrows
/// the list, ownership is decided by uid afterwards.
pub fn label_selector(selector: &Value) -> Option<String> {
    let mut terms = Vec::new();
    if let Some(labels) = selector.get("matchLabels").and_then(Value::as_object) {
        for (key, value) in labels {
            terms.push(format!("{key}={}", value.as_str().unwrap_or_default()));
        }
    }
    for expr in selector
        .get("matchExpressions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(key) = expr.get("key").and_then(Value::as_str) else {
            continue;
        };
        let values: Vec<&str> = expr
            .get("values")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        match expr.get("operator").and_then(Value::as_str) {
            Some("In") if !values.is_empty() => {
                terms.push(format!("{key} in ({})", values.join(",")));
            }
            Some("NotIn") if !values.is_empty() => {
                terms.push(format!("{key} notin ({})", values.join(",")));
            }
            Some("Exists") => terms.push(key.to_string()),
            Some("DoesNotExist") => terms.push(format!("!{key}")),
            _ => {}
        }
    }
    (!terms.is_empty()).then(|| terms.join(","))
}

/// True when `obj` has a *controller* ownerReference with `uid`.
pub fn controlled_by(obj: &Value, uid: &str) -> bool {
    !uid.is_empty()
        && obj
            .pointer("/metadata/ownerReferences")
            .and_then(Value::as_array)
            .is_some_and(|refs| {
                refs.iter().any(|r| {
                    r.get("uid").and_then(Value::as_str) == Some(uid)
                        && r.get("controller").and_then(Value::as_bool) == Some(true)
                })
            })
}

/// Images of a pod template: app containers first, then init containers.
pub fn template_images(template: &Value) -> Vec<ContainerImage> {
    let spec = template.get("spec");
    let mut out = Vec::new();
    for (key, init) in [("containers", false), ("initContainers", true)] {
        for c in spec
            .and_then(|s| s.get(key))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            out.push(ContainerImage {
                container: str_at(c, "/name").unwrap_or_default().to_string(),
                image: str_at(c, "/image").unwrap_or_default().to_string(),
                init,
            });
        }
    }
    out
}

fn strip_label(template: &mut Value, label: &str) {
    if let Some(labels) = template
        .pointer_mut("/metadata/labels")
        .and_then(Value::as_object_mut)
    {
        labels.remove(label);
    }
}

/// A ReplicaSet's pod template without the `pod-template-hash` label.
pub fn replica_set_template(rs: &Value) -> Value {
    let mut template = rs
        .pointer("/spec/template")
        .cloned()
        .unwrap_or_else(|| json!({}));
    strip_label(&mut template, POD_TEMPLATE_HASH_LABEL);
    template
}

/// The pod template a ControllerRevision restores (`data.spec.template`
/// without the `$patch: replace` directive and the revision hash label).
pub fn controller_revision_template(revision: &Value) -> Value {
    let mut template = revision
        .pointer("/data/spec/template")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(map) = template.as_object_mut() {
        map.remove("$patch");
    }
    strip_label(&mut template, CONTROLLER_REVISION_HASH_LABEL);
    template
}

fn revision_entry(obj: &Value, revision: i64, template: Value) -> RolloutRevision {
    RolloutRevision {
        revision,
        name: str_at(obj, "/metadata/name")
            .unwrap_or_default()
            .to_string(),
        created: str_at(obj, "/metadata/creationTimestamp").map(str::to_string),
        change_cause: annotation(obj, CHANGE_CAUSE_ANNOTATION)
            .filter(|c| !c.trim().is_empty())
            .map(str::to_string),
        images: template_images(&template),
        template,
        replicas: None,
        ready_replicas: None,
        current: false,
    }
}

/// Newest first; exactly one entry (when any) is marked current: the first
/// match of `is_current`, else the highest revision.
fn finish(
    mut out: Vec<RolloutRevision>,
    is_current: impl Fn(&RolloutRevision) -> bool,
) -> Vec<RolloutRevision> {
    out.sort_by(|a, b| {
        b.revision
            .cmp(&a.revision)
            .then_with(|| a.name.cmp(&b.name))
    });
    let current = out
        .iter()
        .position(is_current)
        .or((!out.is_empty()).then_some(0));
    if let Some(index) = current {
        out[index].current = true;
    }
    out
}

/// History of a Deployment from the ReplicaSets in its namespace.
pub fn deployment_history(deployment: &Value, replica_sets: &[Value]) -> Vec<RolloutRevision> {
    let uid = str_at(deployment, "/metadata/uid").unwrap_or_default();
    let current: Option<i64> =
        annotation(deployment, REVISION_ANNOTATION).and_then(|r| r.trim().parse().ok());
    let out = replica_sets
        .iter()
        .filter(|rs| controlled_by(rs, uid))
        .filter_map(|rs| {
            let revision: i64 = annotation(rs, REVISION_ANNOTATION)?.trim().parse().ok()?;
            let mut entry = revision_entry(rs, revision, replica_set_template(rs));
            let count = |p: &str| rs.pointer(p).and_then(Value::as_i64).unwrap_or(0);
            entry.replicas = Some(count("/status/replicas"));
            entry.ready_replicas = Some(count("/status/readyReplicas"));
            Some(entry)
        })
        .collect();
    finish(out, |r| Some(r.revision) == current)
}

/// History of a StatefulSet or DaemonSet from the ControllerRevisions in its
/// namespace. The current revision is the StatefulSet's `updateRevision`,
/// else the one whose template equals the live `spec.template`, else the
/// newest.
pub fn controller_history(workload: &Value, revisions: &[Value]) -> Vec<RolloutRevision> {
    let uid = str_at(workload, "/metadata/uid").unwrap_or_default();
    let out: Vec<RolloutRevision> = revisions
        .iter()
        .filter(|cr| controlled_by(cr, uid))
        .filter_map(|cr| {
            let revision = cr.get("revision").and_then(Value::as_i64)?;
            Some(revision_entry(
                cr,
                revision,
                controller_revision_template(cr),
            ))
        })
        .collect();
    let update_revision = str_at(workload, "/status/updateRevision");
    if let Some(name) = update_revision.filter(|n| out.iter().any(|r| r.name == *n)) {
        return finish(out, |r| r.name == name);
    }
    let mut live = workload
        .pointer("/spec/template")
        .cloned()
        .unwrap_or(Value::Null);
    strip_label(&mut live, CONTROLLER_REVISION_HASH_LABEL);
    finish(out, |r| r.template == live)
}

/// History for `kind` from the workload and the objects listed for it.
pub fn build_history(kind: RolloutKind, workload: &Value, owned: &[Value]) -> Vec<RolloutRevision> {
    match kind {
        RolloutKind::Deployment => deployment_history(workload, owned),
        RolloutKind::StatefulSet | RolloutKind::DaemonSet => controller_history(workload, owned),
    }
}

/// The revision `kubectl rollout undo --to-revision=<revision>` would roll
/// back to (`0` = the newest revision older than the current one). Refuses
/// the current revision and revisions whose template already matches it.
pub fn undo_target(history: &[RolloutRevision], revision: i64) -> Result<&RolloutRevision> {
    let current = history.iter().find(|r| r.current);
    let target = if revision == 0 {
        history
            .iter()
            .filter(|r| !r.current && current.is_none_or(|c| r.revision < c.revision))
            .max_by_key(|r| r.revision)
            .ok_or_else(|| anyhow!("there is no previous revision to roll back to"))?
    } else {
        history
            .iter()
            .find(|r| r.revision == revision)
            .ok_or_else(|| anyhow!("revision {revision} not found in the rollout history"))?
    };
    if target.current {
        bail!(
            "revision {} is already the current revision",
            target.revision
        );
    }
    if current.is_some_and(|c| c.template == target.template) {
        bail!(
            "the current pod template already matches revision {}",
            target.revision
        );
    }
    Ok(target)
}

/// RFC 6902 patch rolling a Deployment back to `replica_set`'s template.
/// The template is *replaced* (a merge would keep labels and env entries
/// added since); annotations are merged, taking the ReplicaSet's
/// change-cause (or dropping the current one when it had none).
pub fn deployment_undo_patch(deployment: &Value, replica_set: &Value) -> Result<Value> {
    if replica_set.pointer("/spec/template").is_none() {
        bail!("ReplicaSet has no pod template");
    }
    let template = replica_set_template(replica_set);
    let mut annotations: Map<String, Value> = deployment
        .pointer("/metadata/annotations")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let restored = replica_set
        .pointer("/metadata/annotations")
        .and_then(Value::as_object);
    for (key, value) in restored.into_iter().flatten() {
        if !DEPLOYMENT_OWNED_ANNOTATIONS.contains(&key.as_str()) {
            annotations.insert(key.clone(), value.clone());
        }
    }
    if annotation(replica_set, CHANGE_CAUSE_ANNOTATION).is_none() {
        annotations.remove(CHANGE_CAUSE_ANNOTATION);
    }
    Ok(json!([
        {"op": "replace", "path": "/spec/template", "value": template},
        {"op": "add", "path": "/metadata/annotations", "value": annotations},
    ]))
}

/// Strategic merge patch rolling a StatefulSet / DaemonSet back to a
/// ControllerRevision: its `data`, plus that revision's change-cause.
pub fn controller_revision_undo_patch(revision: &Value) -> Result<Value> {
    let mut patch = revision
        .get("data")
        .filter(|d| d.is_object())
        .cloned()
        .context("ControllerRevision has no data")?;
    let cause = annotation(revision, CHANGE_CAUSE_ANNOTATION)
        .map(|c| Value::String(c.to_string()))
        .unwrap_or(Value::Null);
    let root = patch
        .as_object_mut()
        .context("invalid ControllerRevision data")?;
    let meta = root
        .entry("metadata")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("invalid ControllerRevision data")?;
    let annotations = meta
        .entry("annotations")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("invalid ControllerRevision data")?;
    annotations.insert(CHANGE_CAUSE_ANNOTATION.to_string(), cause);
    Ok(patch)
}

/// The workload (raw JSON) plus every revision object listed for it.
async fn rollout_objects(
    client: kube::Client,
    gvk: &Gvk,
    kind: RolloutKind,
    namespace: &str,
    name: &str,
) -> Result<(Value, Vec<Value>)> {
    if namespace.is_empty() {
        bail!("a namespace is required for {} objects", gvk.kind);
    }
    let workloads: Api<DynamicObject> =
        Api::namespaced_with(client.clone(), namespace, &api_resource(gvk));
    let workload = workloads
        .get(name)
        .await
        .map_err(kube_error)
        .with_context(|| format!("failed to get {} {name}", gvk.kind))?;
    let workload = serde_json::to_value(workload)?;
    let owned_resource = kind.revision_resource();
    let owned: Api<DynamicObject> = Api::namespaced_with(client, namespace, &owned_resource);
    let mut params = ListParams::default();
    if let Some(selector) = workload.pointer("/spec/selector").and_then(label_selector) {
        params = params.labels(&selector);
    }
    let list = owned
        .list(&params)
        .await
        .map_err(kube_error)
        .with_context(|| {
            format!(
                "failed to list {} of {} {name}",
                owned_resource.plural, gvk.kind
            )
        })?;
    let owned = list
        .items
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((workload, owned))
}

impl Kubepit {
    /// `rollout_history`: every revision of a Deployment, StatefulSet or
    /// DaemonSet, newest first.
    pub async fn rollout_history(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: &str,
        name: &str,
    ) -> Result<Vec<RolloutRevision>> {
        let kind = RolloutKind::of(gvk)?;
        let client = self.client(cluster_id).await?;
        let (workload, owned) = rollout_objects(client, gvk, kind, namespace, name).await?;
        Ok(build_history(kind, &workload, &owned))
    }

    /// `rollout_undo`: roll back to `revision` (`0` = previous), see the
    /// module docs. Paused Deployments are refused like kubectl does: the
    /// rollback would not roll out until resumed.
    pub(crate) async fn rollout_undo_unaudited(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: &str,
        name: &str,
        revision: i64,
    ) -> Result<()> {
        self.ensure_writable(cluster_id, "rollback")?;
        let kind = RolloutKind::of(gvk)?;
        let client = self.client(cluster_id).await?;
        let (workload, owned) = rollout_objects(client.clone(), gvk, kind, namespace, name).await?;
        if kind == RolloutKind::Deployment
            && workload.pointer("/spec/paused").and_then(Value::as_bool) == Some(true)
        {
            bail!("Deployment {name} is paused; resume the rollout before rolling back");
        }
        let history = build_history(kind, &workload, &owned);
        let target = undo_target(&history, revision)
            .with_context(|| format!("cannot roll back {} {name}", gvk.kind))?;
        let source = owned
            .iter()
            .find(|o| str_at(o, "/metadata/name") == Some(target.name.as_str()))
            .context("the revision object disappeared")?;
        let api: Api<DynamicObject> = Api::namespaced_with(client, namespace, &api_resource(gvk));
        let params = PatchParams::default();
        let result = match kind {
            RolloutKind::Deployment => {
                let ops: json_patch::Patch =
                    serde_json::from_value(deployment_undo_patch(&workload, source)?)?;
                api.patch(name, &params, &Patch::<()>::Json(ops)).await
            }
            RolloutKind::StatefulSet | RolloutKind::DaemonSet => {
                let patch = controller_revision_undo_patch(source)?;
                api.patch(name, &params, &Patch::Strategic(&patch)).await
            }
        };
        result.map_err(kube_error).with_context(|| {
            format!(
                "failed to roll back {} {name} to revision {}",
                gvk.kind, target.revision
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gvk(group: &str, kind: &str) -> Gvk {
        Gvk {
            group: group.into(),
            version: "v1".into(),
            kind: kind.into(),
            plural: format!("{}s", kind.to_lowercase()),
            namespaced: true,
        }
    }

    fn template(image: &str, hash_label: (&str, &str)) -> Value {
        json!({
            "metadata": {"labels": {"app": "web", hash_label.0: hash_label.1}},
            "spec": {
                "initContainers": [{"name": "migrate", "image": "busybox:1.36"}],
                "containers": [{"name": "web", "image": image}, {"name": "envoy", "image": "envoy:v1.32"}]
            }
        })
    }

    fn deployment(revision: &str) -> Value {
        json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": "web", "namespace": "shop", "uid": "dep-uid",
                         "annotations": {REVISION_ANNOTATION: revision, "team": "shop",
                                         CHANGE_CAUSE_ANNOTATION: "kubepit set image deployment/web web=nginx:1.27"}},
            "spec": {"selector": {"matchLabels": {"app": "web"}}, "template": template("nginx:1.27", ("x", "y"))}
        })
    }

    fn replica_set(name: &str, revision: &str, image: &str, owner: &str) -> Value {
        json!({
            "metadata": {"name": name, "namespace": "shop", "creationTimestamp": "2024-05-01T10:00:00Z",
                         "annotations": {REVISION_ANNOTATION: revision, CHANGE_CAUSE_ANNOTATION: format!("deploy {image}"),
                                         "deployment.kubernetes.io/desired-replicas": "3"},
                         "ownerReferences": [{"uid": owner, "controller": true, "kind": "Deployment", "name": "web"}]},
            "spec": {"template": template(image, (POD_TEMPLATE_HASH_LABEL, "abc123"))},
            "status": {"replicas": 3, "readyReplicas": 2}
        })
    }

    fn controller_revision(name: &str, revision: i64, image: &str, owner: &str) -> Value {
        let mut t = template(image, (CONTROLLER_REVISION_HASH_LABEL, "h1"));
        t["$patch"] = json!("replace");
        json!({
            "apiVersion": "apps/v1", "kind": "ControllerRevision",
            "metadata": {"name": name, "namespace": "shop",
                         "ownerReferences": [{"uid": owner, "controller": true}]},
            "revision": revision,
            "data": {"spec": {"template": t}}
        })
    }

    #[test]
    fn only_apps_workloads_have_history() {
        assert_eq!(
            RolloutKind::of(&gvk("apps", "Deployment")).unwrap(),
            RolloutKind::Deployment
        );
        assert_eq!(
            RolloutKind::of(&gvk("apps", "DaemonSet")).unwrap(),
            RolloutKind::DaemonSet
        );
        assert!(RolloutKind::of(&gvk("apps", "ReplicaSet")).is_err());
        assert!(RolloutKind::of(&gvk("example.com", "Deployment")).is_err());
    }

    #[test]
    fn selectors_become_label_queries() {
        let selector = json!({
            "matchLabels": {"app": "web", "tier": "front"},
            "matchExpressions": [
                {"key": "env", "operator": "In", "values": ["prod", "staging"]},
                {"key": "canary", "operator": "DoesNotExist"},
                {"key": "zone", "operator": "NotIn", "values": ["a"]},
                {"key": "team", "operator": "Exists"},
                {"key": "broken", "operator": "In", "values": []},
                {"operator": "Exists"}
            ]
        });
        assert_eq!(
            label_selector(&selector).unwrap(),
            "app=web,tier=front,env in (prod,staging),!canary,zone notin (a),team"
        );
        assert_eq!(label_selector(&json!({})), None);
    }

    #[test]
    fn deployment_history_is_owned_newest_first_and_marks_current() {
        let sets = vec![
            replica_set("web-1", "1", "nginx:1.25", "dep-uid"),
            replica_set("web-3", "3", "nginx:1.27", "dep-uid"),
            replica_set("web-2", "2", "nginx:1.26", "dep-uid"),
            replica_set("other", "9", "nginx:9", "someone-else"),
            json!({"metadata": {"name": "no-revision", "ownerReferences": [{"uid": "dep-uid", "controller": true}]}}),
        ];
        let history = deployment_history(&deployment("2"), &sets);
        let revisions: Vec<i64> = history.iter().map(|r| r.revision).collect();
        assert_eq!(revisions, vec![3, 2, 1]);
        let current: Vec<&str> = history
            .iter()
            .filter(|r| r.current)
            .map(|r| r.name.as_str())
            .collect();
        assert_eq!(current, vec!["web-2"]);
        let newest = &history[0];
        assert_eq!(newest.change_cause.as_deref(), Some("deploy nginx:1.27"));
        assert_eq!(newest.created.as_deref(), Some("2024-05-01T10:00:00Z"));
        assert_eq!((newest.replicas, newest.ready_replicas), (Some(3), Some(2)));
        assert!(newest.template["metadata"]["labels"]
            .get(POD_TEMPLATE_HASH_LABEL)
            .is_none());
        assert_eq!(newest.template["metadata"]["labels"]["app"], "web");
        let images: Vec<(&str, &str, bool)> = newest
            .images
            .iter()
            .map(|i| (i.container.as_str(), i.image.as_str(), i.init))
            .collect();
        assert_eq!(
            images,
            vec![
                ("web", "nginx:1.27", false),
                ("envoy", "envoy:v1.32", false),
                ("migrate", "busybox:1.36", true)
            ]
        );
        // Without a revision annotation the newest ReplicaSet is current.
        let mut dep = deployment("1");
        dep["metadata"]["annotations"]
            .as_object_mut()
            .unwrap()
            .remove(REVISION_ANNOTATION);
        assert!(deployment_history(&dep, &sets)[0].current);
    }

    #[test]
    fn controller_history_strips_patch_directive_and_finds_current() {
        let sts = json!({
            "metadata": {"name": "db", "uid": "sts-uid"},
            "spec": {"template": template("postgres:16", ("a", "b"))},
            "status": {"updateRevision": "db-2"}
        });
        let revisions = vec![
            controller_revision("db-1", 1, "postgres:15", "sts-uid"),
            controller_revision("db-3", 3, "postgres:17", "sts-uid"),
            controller_revision("db-2", 2, "postgres:16", "sts-uid"),
            controller_revision("x-1", 7, "postgres:16", "other"),
        ];
        let history = controller_history(&sts, &revisions);
        assert_eq!(
            history.iter().map(|r| r.revision).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        assert!(history[1].current && !history[0].current);
        assert!(history[0].template.get("$patch").is_none());
        assert!(history[0].template["metadata"]["labels"]
            .get(CONTROLLER_REVISION_HASH_LABEL)
            .is_none());
        assert_eq!(history[0].replicas, None);
        assert_eq!(history[2].images[0].image, "postgres:15");

        // DaemonSets have no updateRevision: match the live template.
        let mut ds = sts.clone();
        ds["status"] = json!({});
        ds["spec"]["template"] = template("postgres:15", ("a", "b"));
        ds["spec"]["template"]["metadata"]["labels"] = json!({"app": "web"});
        let history = controller_history(&ds, &revisions);
        assert_eq!(
            history.iter().find(|r| r.current).map(|r| r.revision),
            Some(1)
        );
        // Nothing matches → the newest.
        ds["spec"]["template"] = json!({});
        assert!(controller_history(&ds, &revisions)[0].current);
        assert!(controller_history(&ds, &[]).is_empty());
    }

    #[test]
    fn undo_target_follows_kubectl_semantics() {
        let sets = vec![
            replica_set("web-1", "1", "nginx:1.25", "dep-uid"),
            replica_set("web-2", "2", "nginx:1.26", "dep-uid"),
            replica_set("web-3", "3", "nginx:1.27", "dep-uid"),
        ];
        let history = deployment_history(&deployment("3"), &sets);
        assert_eq!(undo_target(&history, 0).unwrap().revision, 2);
        assert_eq!(undo_target(&history, 1).unwrap().name, "web-1");
        let err = undo_target(&history, 3).unwrap_err().to_string();
        assert!(err.contains("already the current revision"), "{err}");
        let err = undo_target(&history, 7).unwrap_err().to_string();
        assert!(err.contains("revision 7 not found"), "{err}");
        let single = deployment_history(&deployment("1"), &sets[..1]);
        let err = undo_target(&single, 0).unwrap_err().to_string();
        assert!(err.contains("no previous revision"), "{err}");
        // Same template as the current one → nothing to roll back.
        let dup = vec![
            replica_set("web-1", "1", "nginx:1.27", "dep-uid"),
            replica_set("web-3", "3", "nginx:1.27", "dep-uid"),
        ];
        let history = deployment_history(&deployment("3"), &dup);
        let err = undo_target(&history, 1).unwrap_err().to_string();
        assert!(err.contains("already matches revision 1"), "{err}");
    }

    #[test]
    fn deployment_undo_replaces_template_and_restores_change_cause() {
        let dep = deployment("3");
        let rs = replica_set("web-1", "1", "nginx:1.25", "dep-uid");
        let patch = deployment_undo_patch(&dep, &rs).unwrap();
        assert_eq!(patch[0]["op"], "replace");
        assert_eq!(patch[0]["path"], "/spec/template");
        let t = &patch[0]["value"];
        assert_eq!(t["spec"]["containers"][0]["image"], "nginx:1.25");
        assert!(t["metadata"]["labels"]
            .get(POD_TEMPLATE_HASH_LABEL)
            .is_none());
        assert_eq!(patch[1]["op"], "add");
        assert_eq!(patch[1]["path"], "/metadata/annotations");
        let a = &patch[1]["value"];
        assert_eq!(a[CHANGE_CAUSE_ANNOTATION], "deploy nginx:1.25");
        assert_eq!(
            a[REVISION_ANNOTATION], "3",
            "controller-owned annotations stay"
        );
        assert!(a.get("deployment.kubernetes.io/desired-replicas").is_none());
        assert_eq!(a["team"], "shop", "unrelated annotations survive");
        // The patch parses as RFC 6902.
        serde_json::from_value::<json_patch::Patch>(patch).unwrap();

        // A revision without change-cause drops the current one.
        let mut bare = rs.clone();
        bare["metadata"]["annotations"]
            .as_object_mut()
            .unwrap()
            .remove(CHANGE_CAUSE_ANNOTATION);
        let patch = deployment_undo_patch(&dep, &bare).unwrap();
        assert!(patch[1]["value"].get(CHANGE_CAUSE_ANNOTATION).is_none());
        assert!(deployment_undo_patch(&dep, &json!({"metadata": {}})).is_err());
    }

    #[test]
    fn controller_revision_undo_applies_data_with_change_cause() {
        let mut cr = controller_revision("db-1", 1, "postgres:15", "sts-uid");
        let patch = controller_revision_undo_patch(&cr).unwrap();
        assert_eq!(patch["spec"]["template"]["$patch"], "replace");
        assert_eq!(
            patch["spec"]["template"]["spec"]["containers"][0]["image"],
            "postgres:15"
        );
        assert_eq!(
            patch["metadata"]["annotations"][CHANGE_CAUSE_ANNOTATION],
            Value::Null
        );
        cr["metadata"]["annotations"] = json!({CHANGE_CAUSE_ANNOTATION: "upgrade to 15"});
        let patch = controller_revision_undo_patch(&cr).unwrap();
        assert_eq!(
            patch["metadata"]["annotations"][CHANGE_CAUSE_ANNOTATION],
            "upgrade to 15"
        );
        assert!(controller_revision_undo_patch(&json!({"metadata": {}})).is_err());
    }
}
