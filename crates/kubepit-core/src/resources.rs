//! Generic resource operations over `DynamicObject`.
//!
//! Every kind — built-in or CRD — goes through the same code path, addressed
//! by a [`Gvk`] from discovery. Mutations check the cluster's `read_only`
//! flag first. Objects sent to the UI have `managedFields` stripped.

use anyhow::{anyhow, bail, Context, Result};
use kube::api::{
    Api, ApiResource, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams,
    PropagationPolicy,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::app::Kubepit;
use crate::error::{api_code, kube_error};
use crate::objects::{
    api_resource, api_resource_from_info, dynamic_api, sort_events_newest_first,
    strip_managed_fields, to_kube_object,
};
use crate::types::{
    ApplyMode, DeleteOptions, DeletePropagation, Gvk, KubeObject, PatchType, ResourceList,
};

/// Field manager recorded for server-side apply.
pub const FIELD_MANAGER: &str = "kubepit";
/// Annotation `kubectl rollout restart` uses.
pub const RESTARTED_AT_ANNOTATION: &str = "kubectl.kubernetes.io/restartedAt";

/// Split multi-document YAML into objects. Empty documents are skipped and
/// `kind: List` documents are expanded into their items.
pub fn parse_documents(yaml: &str) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for (index, document) in serde_yaml::Deserializer::from_str(yaml).enumerate() {
        let value = Value::deserialize(document)
            .with_context(|| format!("document {} is not valid YAML", index + 1))?;
        match value {
            Value::Null => continue,
            Value::Object(ref map) if map.is_empty() => continue,
            Value::Object(ref map) => {
                let is_list = map.get("kind").and_then(Value::as_str) == Some("List");
                match (is_list, map.get("items").and_then(Value::as_array)) {
                    (true, Some(items)) => {
                        out.extend(items.iter().filter(|i| i.is_object()).cloned())
                    }
                    _ => out.push(value),
                }
            }
            _ => bail!("document {} is not a Kubernetes object", index + 1),
        }
    }
    Ok(out)
}

/// Remove fields the server owns so a copied object can be applied/created.
pub fn strip_server_fields(doc: &mut Value, keep_resource_version: bool, keep_status: bool) {
    if let Some(meta) = doc.get_mut("metadata").and_then(Value::as_object_mut) {
        for key in [
            "uid",
            "creationTimestamp",
            "generation",
            "selfLink",
            "managedFields",
        ] {
            meta.remove(key);
        }
        if !keep_resource_version {
            meta.remove("resourceVersion");
        }
    }
    if !keep_status {
        if let Some(map) = doc.as_object_mut() {
            map.remove("status");
        }
    }
}

fn str_field<'a>(doc: &'a Value, pointer: &str) -> Option<&'a str> {
    doc.pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// `<cronjob>-manual-<suffix>`, truncated so the Job name (which also becomes
/// the `job-name` label value) stays within 63 characters.
pub fn manual_job_name(cronjob: &str, suffix: &str) -> String {
    let max_prefix = 63 - "-manual-".len() - suffix.len();
    let prefix: String = cronjob.chars().take(max_prefix).collect();
    format!("{}-manual-{suffix}", prefix.trim_end_matches(['-', '.']))
}

/// Five random `[a-z0-9]` characters.
pub fn random_suffix() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(5)
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

/// Build the Job `kubectl create job --from=cronjob/<name>` would create.
pub fn build_manual_job(cronjob: &Value, job_name: &str) -> Result<Value> {
    let name = str_field(cronjob, "/metadata/name").context("CronJob has no name")?;
    let uid = str_field(cronjob, "/metadata/uid").context("CronJob has no uid")?;
    let namespace = str_field(cronjob, "/metadata/namespace").unwrap_or("default");
    let api_version = str_field(cronjob, "/apiVersion").unwrap_or("batch/v1");
    let template = cronjob
        .pointer("/spec/jobTemplate")
        .context("CronJob has no spec.jobTemplate")?;
    let spec = template
        .get("spec")
        .cloned()
        .context("CronJob has no spec.jobTemplate.spec")?;

    let mut annotations: Map<String, Value> = template
        .pointer("/metadata/annotations")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    annotations.insert(
        "cronjob.kubernetes.io/instantiate".into(),
        Value::String("manual".into()),
    );
    let mut metadata = json!({
        "name": job_name,
        "namespace": namespace,
        "annotations": annotations,
        "ownerReferences": [{
            "apiVersion": api_version,
            "kind": "CronJob",
            "name": name,
            "uid": uid,
            "controller": true,
            "blockOwnerDeletion": true
        }]
    });
    if let Some(labels) = template
        .pointer("/metadata/labels")
        .filter(|l| l.is_object())
    {
        metadata["labels"] = labels.clone();
    }
    Ok(json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": metadata,
        "spec": spec
    }))
}

fn batch_resource(kind: &str, plural: &str) -> ApiResource {
    ApiResource {
        group: "batch".into(),
        version: "v1".into(),
        api_version: "batch/v1".into(),
        kind: kind.into(),
        plural: plural.into(),
    }
}

fn events_resource() -> ApiResource {
    ApiResource {
        group: String::new(),
        version: "v1".into(),
        api_version: "v1".into(),
        kind: "Event".into(),
        plural: "events".into(),
    }
}

/// Where one manifest document goes (see [`Kubepit::document_target`]).
pub(crate) struct DocTarget {
    pub api: Api<DynamicObject>,
    pub ar: ApiResource,
    /// `None` for `generateName` objects.
    pub name: Option<String>,
    pub namespace: Option<String>,
}

/// Api scoped for a *named* object: namespaced kinds need a namespace.
pub(crate) fn object_api(
    client: kube::Client,
    gvk: &Gvk,
    namespace: Option<&str>,
) -> Result<(Api<DynamicObject>, ApiResource)> {
    let ar = api_resource(gvk);
    let namespace = namespace.filter(|ns| !ns.is_empty());
    if gvk.namespaced && namespace.is_none() {
        bail!("a namespace is required for {} objects", gvk.kind);
    }
    Ok((dynamic_api(client, &ar, gvk.namespaced, namespace), ar))
}

impl Kubepit {
    /// `resource_list`. `namespace: None` lists across all namespaces.
    pub async fn resource_list(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        label_selector: Option<&str>,
        field_selector: Option<&str>,
    ) -> Result<ResourceList> {
        let client = self.client(cluster_id).await?;
        let ar = api_resource(gvk);
        let api = dynamic_api(client, &ar, gvk.namespaced, namespace);
        let mut lp = ListParams::default();
        if let Some(labels) = label_selector.filter(|s| !s.trim().is_empty()) {
            lp = lp.labels(labels);
        }
        if let Some(fields) = field_selector.filter(|s| !s.trim().is_empty()) {
            lp = lp.fields(fields);
        }
        let list = api
            .list(&lp)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to list {}", gvk.plural))?;
        Ok(ResourceList {
            resource_version: list.metadata.resource_version.unwrap_or_default(),
            items: list
                .items
                .into_iter()
                .map(|o| to_kube_object(o, &ar))
                .collect(),
        })
    }

    /// `resource_get`.
    pub async fn resource_get(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<KubeObject> {
        let client = self.client(cluster_id).await?;
        let (api, ar) = object_api(client, gvk, namespace)?;
        let obj = api
            .get(name)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to get {} {name}", gvk.kind))?;
        Ok(to_kube_object(obj, &ar))
    }

    /// `resource_get_yaml`: the object as YAML (managedFields stripped,
    /// resourceVersion kept so a later `replace` detects conflicts).
    pub async fn resource_get_yaml(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<String> {
        let value = self.resource_get(cluster_id, gvk, namespace, name).await?;
        serde_yaml::to_string(&value).context("failed to render YAML")
    }

    /// `resource_apply_yaml`: apply every document in order.
    ///
    /// - `apply`: server-side apply as field manager `kubepit` with force.
    /// - `replace`: PUT; requires `metadata.resourceVersion` so concurrent
    ///   edits are rejected with a conflict instead of silently overwritten.
    /// - `create`: POST.
    ///
    /// `namespace` fills namespaced objects that omit `metadata.namespace`.
    pub(crate) async fn resource_apply_yaml_unaudited(
        &self,
        cluster_id: &str,
        yaml: &str,
        mode: ApplyMode,
        namespace: Option<&str>,
    ) -> Result<Vec<KubeObject>> {
        let action = match mode {
            ApplyMode::Apply => "apply",
            ApplyMode::Replace => "replace",
            ApplyMode::Create => "create",
        };
        self.ensure_writable(cluster_id, action)?;
        let docs = parse_documents(yaml)?;
        if docs.is_empty() {
            bail!("the YAML contains no objects");
        }
        let client = self.client(cluster_id).await?;
        let total = docs.len();
        let mut results = Vec::with_capacity(total);
        for (index, mut doc) in docs.into_iter().enumerate() {
            let position = index + 1;
            let result = match self
                .document_target(&client, cluster_id, &mut doc, namespace)
                .await
            {
                Ok(target) => self.apply_document(&target, &mut doc, mode, false).await,
                Err(e) => Err(e),
            };
            match result {
                Ok(obj) => results.push(obj),
                Err(e) => {
                    let label = format!(
                        "{} {}",
                        str_field(&doc, "/kind").unwrap_or("object"),
                        str_field(&doc, "/metadata/name")
                            .or_else(|| str_field(&doc, "/metadata/generateName"))
                            .unwrap_or("?")
                    );
                    let done = if index > 0 {
                        format!(" ({index} of {total} documents were applied before the failure)")
                    } else {
                        String::new()
                    };
                    return Err(e.context(format!("document {position} ({label}){done}")));
                }
            }
        }
        Ok(results)
    }

    /// Resolve a document's kind through discovery and settle its namespace:
    /// namespaced objects keep theirs, else get `namespace`, else `default`;
    /// cluster-scoped objects lose any namespace they carry.
    pub(crate) async fn document_target(
        &self,
        client: &kube::Client,
        cluster_id: &str,
        doc: &mut Value,
        namespace: Option<&str>,
    ) -> Result<DocTarget> {
        let api_version = str_field(doc, "/apiVersion")
            .context("missing apiVersion")?
            .to_string();
        let kind = str_field(doc, "/kind").context("missing kind")?.to_string();
        let info = self.resolve_kind(cluster_id, &api_version, &kind).await?;
        let ar = api_resource_from_info(&info);

        let meta = doc
            .as_object_mut()
            .context("object must be a mapping")?
            .entry("metadata")
            .or_insert_with(|| Value::Object(Map::new()));
        let meta = meta.as_object_mut().context("metadata must be a mapping")?;
        let target_ns = if info.namespaced {
            let ns = meta
                .get("namespace")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| namespace.filter(|s| !s.is_empty()).map(str::to_string))
                .unwrap_or_else(|| "default".to_string());
            meta.insert("namespace".into(), Value::String(ns.clone()));
            Some(ns)
        } else {
            meta.remove("namespace");
            None
        };
        let api = dynamic_api(client.clone(), &ar, info.namespaced, target_ns.as_deref());
        let name = str_field(doc, "/metadata/name").map(str::to_string);
        Ok(DocTarget {
            api,
            ar,
            name,
            namespace: target_ns,
        })
    }

    /// Send one document to its target. With `dry_run` the server admits,
    /// validates and defaults the request (`dryRun=All`) without persisting it.
    pub(crate) async fn apply_document(
        &self,
        target: &DocTarget,
        doc: &mut Value,
        mode: ApplyMode,
        dry_run: bool,
    ) -> Result<KubeObject> {
        let api = &target.api;
        let name = target.name.clone();
        let post = PostParams {
            dry_run,
            ..PostParams::default()
        };
        let result = match mode {
            ApplyMode::Apply => {
                let name = name.context("missing metadata.name")?;
                strip_server_fields(doc, false, false);
                let mut params = PatchParams::apply(FIELD_MANAGER).force();
                params.dry_run = dry_run;
                api.patch(&name, &params, &Patch::Apply(&*doc)).await
            }
            ApplyMode::Replace => {
                let name = name.context("missing metadata.name")?;
                if str_field(doc, "/metadata/resourceVersion").is_none() {
                    bail!(
                        "replace requires metadata.resourceVersion (reload the object and edit it again)"
                    );
                }
                strip_managed_fields(doc);
                let obj: DynamicObject =
                    serde_json::from_value(doc.clone()).context("invalid object")?;
                api.replace(&name, &post, &obj).await
            }
            ApplyMode::Create => {
                if name.is_none() && str_field(doc, "/metadata/generateName").is_none() {
                    bail!("missing metadata.name (or metadata.generateName)");
                }
                strip_server_fields(doc, false, true);
                let obj: DynamicObject =
                    serde_json::from_value(doc.clone()).context("invalid object")?;
                api.create(&post, &obj).await
            }
        };
        Ok(to_kube_object(result.map_err(kube_error)?, &target.ar))
    }

    /// `resource_delete` (audited in `history/audited.rs`).
    pub(crate) async fn resource_delete_unaudited(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
        options: DeleteOptions,
    ) -> Result<()> {
        self.ensure_writable(cluster_id, "delete")?;
        let client = self.client(cluster_id).await?;
        let (api, _) = object_api(client, gvk, namespace)?;
        let params = DeleteParams {
            propagation_policy: options.propagation.map(|p| match p {
                DeletePropagation::Background => PropagationPolicy::Background,
                DeletePropagation::Foreground => PropagationPolicy::Foreground,
                DeletePropagation::Orphan => PropagationPolicy::Orphan,
            }),
            grace_period_seconds: options
                .grace_period_seconds
                .map(|s| s.clamp(0, i64::from(u32::MAX)) as u32),
            ..DeleteParams::default()
        };
        api.delete(name, &params)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to delete {} {name}", gvk.kind))?;
        Ok(())
    }

    /// `resource_patch` (merge / RFC 6902 json / strategic).
    pub(crate) async fn resource_patch_unaudited(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
        patch: Value,
        patch_type: PatchType,
    ) -> Result<KubeObject> {
        self.ensure_writable(cluster_id, "patch")?;
        let client = self.client(cluster_id).await?;
        let (api, ar) = object_api(client, gvk, namespace)?;
        let params = PatchParams::default();
        let result = match patch_type {
            PatchType::Merge => api.patch(name, &params, &Patch::Merge(&patch)).await,
            PatchType::Strategic => api.patch(name, &params, &Patch::Strategic(&patch)).await,
            PatchType::Json => {
                let ops: json_patch::Patch = serde_json::from_value(patch)
                    .context("invalid JSON patch (expected an array of RFC 6902 operations)")?;
                api.patch(name, &params, &Patch::<()>::Json(ops)).await
            }
        };
        let obj = result
            .map_err(kube_error)
            .with_context(|| format!("failed to patch {} {name}", gvk.kind))?;
        Ok(to_kube_object(obj, &ar))
    }

    /// `resource_scale`: through the `scale` subresource when served, else a
    /// merge patch of `spec.replicas`.
    pub(crate) async fn resource_scale_unaudited(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: &str,
        name: &str,
        replicas: i64,
    ) -> Result<()> {
        self.ensure_writable(cluster_id, "scale")?;
        let replicas = i32::try_from(replicas)
            .ok()
            .filter(|r| *r >= 0)
            .ok_or_else(|| anyhow!("invalid replica count {replicas}"))?;
        let client = self.client(cluster_id).await?;
        let (api, _) = object_api(client, gvk, Some(namespace))?;
        let patch = json!({ "spec": { "replicas": replicas } });
        let params = PatchParams::default();
        match api.patch_scale(name, &params, &Patch::Merge(&patch)).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let err = kube_error(e);
                if matches!(api_code(&err), Some(404 | 405 | 415)) {
                    api.patch(name, &params, &Patch::Merge(&patch))
                        .await
                        .map_err(kube_error)
                        .with_context(|| format!("failed to scale {} {name}", gvk.kind))?;
                    Ok(())
                } else {
                    Err(err.context(format!("failed to scale {} {name}", gvk.kind)))
                }
            }
        }
    }

    /// `resource_restart`: `kubectl rollout restart` — bump the pod template
    /// annotation so the controller rolls every pod.
    pub(crate) async fn resource_restart_unaudited(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: &str,
        name: &str,
    ) -> Result<()> {
        self.ensure_writable(cluster_id, "restart")?;
        let client = self.client(cluster_id).await?;
        let (api, _) = object_api(client, gvk, Some(namespace))?;
        let current = api.get(name).await.map_err(kube_error)?;
        if current.data.pointer("/spec/template").is_none() {
            bail!("{} {name} has no pod template to restart", gvk.kind);
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let patch = json!({
            "spec": { "template": { "metadata": { "annotations": {
                RESTARTED_AT_ANNOTATION: now
            } } } }
        });
        api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to restart {} {name}", gvk.kind))?;
        Ok(())
    }

    /// `resource_events`: Events whose `involvedObject.uid` matches, newest
    /// first.
    pub async fn resource_events(
        &self,
        cluster_id: &str,
        namespace: Option<&str>,
        uid: &str,
    ) -> Result<Vec<KubeObject>> {
        let client = self.client(cluster_id).await?;
        let ar = events_resource();
        let api = dynamic_api(client, &ar, true, namespace);
        let list = api
            .list(&ListParams::default().fields(&format!("involvedObject.uid={uid}")))
            .await
            .map_err(kube_error)
            .context("failed to list events")?;
        let mut events: Vec<Value> = list
            .items
            .into_iter()
            .map(|e| to_kube_object(e, &ar))
            .collect();
        sort_events_newest_first(&mut events);
        Ok(events)
    }

    /// `cronjob_trigger`: create a Job from the CronJob's template (like
    /// `kubectl create job --from=cronjob/<name>`); returns the Job name.
    pub(crate) async fn cronjob_trigger_unaudited(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
    ) -> Result<String> {
        self.ensure_writable(cluster_id, "triggering a CronJob")?;
        let client = self.client(cluster_id).await?;
        let cronjobs: Api<DynamicObject> = Api::namespaced_with(
            client.clone(),
            namespace,
            &batch_resource("CronJob", "cronjobs"),
        );
        let cronjob = cronjobs
            .get(name)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to read CronJob {name}"))?;
        let cronjob = serde_json::to_value(cronjob)?;
        let job_name = manual_job_name(name, &random_suffix());
        let job: DynamicObject = serde_json::from_value(build_manual_job(&cronjob, &job_name)?)?;
        let jobs: Api<DynamicObject> =
            Api::namespaced_with(client, namespace, &batch_resource("Job", "jobs"));
        jobs.create(&PostParams::default(), &job)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to create Job {job_name}"))?;
        Ok(job_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_document_yaml_skips_empty_and_expands_lists() {
        let yaml = r#"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: a
data:
  key: "1"
---
# just a comment
---
apiVersion: v1
kind: List
items:
- apiVersion: v1
  kind: Service
  metadata: {name: b}
- apiVersion: apps/v1
  kind: Deployment
  metadata: {name: c}
---
"#;
        let docs = parse_documents(yaml).unwrap();
        let names: Vec<_> = docs
            .iter()
            .map(|d| d["metadata"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["a", "b", "c"]);
        assert_eq!(docs[0]["data"]["key"], "1");
    }

    #[test]
    fn invalid_documents_are_reported_with_position() {
        let err = parse_documents("a: 1\n---\n- just\n- a list\n").unwrap_err();
        assert!(err.to_string().contains("document 2"), "{err}");
        let err = parse_documents("kind: [unclosed").unwrap_err();
        assert!(err.to_string().contains("document 1"), "{err}");
        assert!(parse_documents("").unwrap().is_empty());
    }

    #[test]
    fn server_fields_are_stripped() {
        let mut doc = json!({
            "metadata": {"name": "x", "uid": "u", "resourceVersion": "5",
                         "creationTimestamp": "t", "generation": 2, "managedFields": []},
            "status": {"ready": true}
        });
        let mut replace = doc.clone();
        strip_server_fields(&mut doc, false, false);
        assert_eq!(doc, json!({"metadata": {"name": "x"}}));
        strip_server_fields(&mut replace, true, true);
        assert_eq!(replace["metadata"]["resourceVersion"], "5");
        assert!(replace.get("status").is_some());
        assert!(replace["metadata"].get("uid").is_none());
    }

    #[test]
    fn manual_job_names_fit_label_limits() {
        assert_eq!(manual_job_name("backup", "ab12c"), "backup-manual-ab12c");
        let long = "a".repeat(80);
        let name = manual_job_name(&long, "zzzzz");
        assert_eq!(name.len(), 63);
        assert!(name.ends_with("-manual-zzzzz"));
        let suffix = random_suffix();
        assert_eq!(suffix.len(), 5);
        assert!(suffix
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    }

    #[test]
    fn manual_job_copies_template_and_owner() {
        let cronjob = json!({
            "apiVersion": "batch/v1",
            "kind": "CronJob",
            "metadata": {"name": "backup", "namespace": "ops", "uid": "cj-uid"},
            "spec": {
                "schedule": "0 * * * *",
                "jobTemplate": {
                    "metadata": {"labels": {"app": "backup"}, "annotations": {"team": "ops"}},
                    "spec": {"template": {"spec": {"containers": [{"name": "b", "image": "busybox"}],
                                                   "restartPolicy": "OnFailure"}}}
                }
            }
        });
        let job = build_manual_job(&cronjob, "backup-manual-abcde").unwrap();
        assert_eq!(job["kind"], "Job");
        assert_eq!(job["metadata"]["name"], "backup-manual-abcde");
        assert_eq!(job["metadata"]["namespace"], "ops");
        assert_eq!(job["metadata"]["labels"]["app"], "backup");
        assert_eq!(job["metadata"]["annotations"]["team"], "ops");
        assert_eq!(
            job["metadata"]["annotations"]["cronjob.kubernetes.io/instantiate"],
            "manual"
        );
        let owner = &job["metadata"]["ownerReferences"][0];
        assert_eq!(owner["kind"], "CronJob");
        assert_eq!(owner["uid"], "cj-uid");
        assert_eq!(owner["controller"], true);
        assert_eq!(
            job["spec"]["template"]["spec"]["containers"][0]["image"],
            "busybox"
        );
        assert!(build_manual_job(&json!({"metadata": {"name": "x", "uid": "u"}}), "j").is_err());
    }
}
