//! Helm values schemas and the upgrade preview.
//!
//! **Values schema.** A chart may ship `values.schema.json` (JSON Schema);
//! helm validates the merged values against it on install and upgrade.
//! Installed releases carry it inside the decoded release (`chart.schema`,
//! base64 of the JSON bytes, like every `[]byte` in helm's release JSON);
//! repository charts are pulled (`helm pull --untar`) into a private temp
//! directory that is removed right away, cached for five minutes like
//! `helm show`. No schema is not an error: the UI then shows no markers.
//!
//! **Upgrade preview** (what the helm-diff plugin shows): the dry-run
//! upgrade renders the next manifest, both manifests are split into
//! objects, matched by group, kind, namespace and name, and reported as
//! added / changed / removed / unchanged with their before and after
//! documents. Optionally every rendered object is also sent through the
//! server-side dry run of `dry_run.rs` (server-side apply, `dryRun=All`) to
//! diff it against the live object. Both only read, so they are allowed on
//! read-only clusters; the upgrade itself still is not.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use futures::{stream, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app::Kubepit;
use crate::helm::{fetch_release, list_revisions};
use crate::helm_charts::{
    normalize_version, validate_chart_ref, validate_namespace, validate_release_name,
};
use crate::tools;
use crate::types::{ApplyMode, DryRunResult, HelmInstallResult, HelmUpgradeRequest};

const PULL_TIMEOUT: Duration = Duration::from_secs(120);
const SCHEMA_CACHE_TTL: Duration = Duration::from_secs(300);
const SCHEMA_CACHE_CAPACITY: usize = 32;
/// Larger schemas are ignored (they would not help an editor anyway).
const MAX_SCHEMA_BYTES: u64 = 8 * 1024 * 1024;
/// Rendered objects sent through the live dry run, at most.
const MAX_LIVE_OBJECTS: usize = 300;
const LIVE_CONCURRENCY: usize = 8;

// ---------------------------------------------------------------------------
// Values schema
// ---------------------------------------------------------------------------

/// `chart.schema` of a decoded release: `None` when the chart has none.
pub fn release_values_schema(release: &Value) -> Result<Option<Value>> {
    let schema = match release.pointer("/chart/schema") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(encoded)) => {
            let compact: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
            if compact.is_empty() {
                return Ok(None);
            }
            let bytes = BASE64
                .decode(compact)
                .context("the chart schema is not base64")?;
            if bytes.trim_ascii().is_empty() {
                return Ok(None);
            }
            serde_json::from_slice::<Value>(&bytes)
                .context("the chart's values.schema.json is not valid JSON")?
        }
        // Tolerate a release written with the schema inline.
        Some(other) => other.clone(),
    };
    Ok(schema.is_object().then_some(schema))
}

/// Parse a `values.schema.json` file's content.
pub fn parse_schema_file(bytes: &[u8]) -> Result<Option<Value>> {
    if bytes.trim_ascii().is_empty() {
        return Ok(None);
    }
    let schema: Value = serde_json::from_slice(bytes)
        .context("the chart's values.schema.json is not valid JSON")?;
    Ok(schema.is_object().then_some(schema))
}

/// The top-level chart's schema in a `helm pull --untar` destination (the
/// only directory in it is the chart; subcharts live below it).
fn find_pulled_schema(destination: &Path) -> Result<Option<Value>> {
    let mut charts: Vec<PathBuf> = std::fs::read_dir(destination)
        .with_context(|| format!("cannot read {}", destination.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    charts.sort();
    let Some(chart) = charts.first() else {
        bail!("helm pull did not unpack a chart");
    };
    let file = chart.join("values.schema.json");
    let Ok(meta) = std::fs::metadata(&file) else {
        return Ok(None);
    };
    if meta.len() > MAX_SCHEMA_BYTES {
        return Ok(None);
    }
    let bytes = std::fs::read(&file).with_context(|| format!("cannot read {}", file.display()))?;
    parse_schema_file(&bytes)
}

struct CachedSchema {
    at: Instant,
    schema: Option<Value>,
}

static SCHEMA_CACHE: LazyLock<Mutex<HashMap<String, CachedSchema>>> =
    LazyLock::new(Default::default);

fn cached_schema(key: &str) -> Option<Option<Value>> {
    SCHEMA_CACHE
        .lock()
        .get(key)
        .filter(|c| c.at.elapsed() < SCHEMA_CACHE_TTL)
        .map(|c| c.schema.clone())
}

fn cache_schema(key: String, schema: Option<Value>) {
    let mut cache = SCHEMA_CACHE.lock();
    cache.retain(|_, c| c.at.elapsed() < SCHEMA_CACHE_TTL);
    if cache.len() >= SCHEMA_CACHE_CAPACITY {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, c)| c.at)
            .map(|(k, _)| k.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        key,
        CachedSchema {
            at: Instant::now(),
            schema,
        },
    );
}

/// Forget pulled schemas (repositories changed).
pub fn clear_schema_cache() {
    SCHEMA_CACHE.lock().clear();
}

/// A private scratch directory, removed with everything in it when dropped.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn create(parent: &Path) -> Result<Self> {
        let dir = parent.join(format!("helm-pull-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        Ok(Self(dir))
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Manifest splitting and matching
// ---------------------------------------------------------------------------

/// One object of a rendered manifest.
#[derive(Debug, Clone, PartialEq)]
pub struct ManifestObject {
    /// Template that rendered it (helm's `# Source:` comment).
    pub source: Option<String>,
    pub value: Value,
}

fn is_separator(line: &str) -> bool {
    line.strip_prefix("---").is_some_and(|rest| {
        let rest = rest.trim_start();
        rest.is_empty() || rest.starts_with('#')
    })
}

fn source_comment(chunk: &str) -> Option<String> {
    chunk.lines().find_map(|l| {
        l.trim()
            .strip_prefix("# Source:")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

/// Split a rendered multi-document manifest into objects. Empty documents,
/// comments and documents that do not parse or have no `kind` are skipped;
/// a `kind: List` contributes its items.
pub fn split_manifest(manifest: &str) -> Vec<ManifestObject> {
    let mut chunks: Vec<String> = vec![String::new()];
    for line in manifest.lines() {
        if is_separator(line) {
            chunks.push(String::new());
        } else {
            let chunk = chunks.last_mut().expect("at least one chunk");
            chunk.push_str(line);
            chunk.push('\n');
        }
    }
    let mut out = Vec::new();
    for chunk in chunks {
        if chunk.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_yaml::from_str::<Value>(&chunk) else {
            continue;
        };
        let source = source_comment(&chunk);
        let Value::Object(map) = &value else {
            continue;
        };
        match (
            map.get("kind").and_then(Value::as_str),
            map.get("items").and_then(Value::as_array),
        ) {
            (Some("List"), Some(items)) => out.extend(
                items
                    .iter()
                    .filter(|i| i.get("kind").and_then(Value::as_str).is_some())
                    .map(|i| ManifestObject {
                        source: source.clone(),
                        value: i.clone(),
                    }),
            ),
            (Some(_), _) => out.push(ManifestObject { source, value }),
            _ => {}
        }
    }
    out
}

/// Kinds without a namespace (built-ins plus common add-ons); everything
/// else is assumed to live in the release namespace when it names none.
const CLUSTER_SCOPED: &[&str] = &[
    "APIService",
    "CertificateSigningRequest",
    "ClusterIssuer",
    "ClusterRole",
    "ClusterRoleBinding",
    "CSIDriver",
    "CSINode",
    "CustomResourceDefinition",
    "FlowSchema",
    "IngressClass",
    "MutatingAdmissionPolicy",
    "MutatingAdmissionPolicyBinding",
    "MutatingWebhookConfiguration",
    "Namespace",
    "Node",
    "PersistentVolume",
    "PodSecurityPolicy",
    "PriorityClass",
    "PriorityLevelConfiguration",
    "RuntimeClass",
    "StorageClass",
    "ValidatingAdmissionPolicy",
    "ValidatingAdmissionPolicyBinding",
    "ValidatingWebhookConfiguration",
    "VolumeAttachment",
];

pub fn is_cluster_scoped(kind: &str) -> bool {
    CLUSTER_SCOPED.contains(&kind)
}

fn text(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Identity of a rendered object: the API group (not the version, so an
/// `apiVersion` bump is a change, not a remove + add), kind, namespace
/// (defaulted to the release namespace for namespaced kinds) and name.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ObjectIdentity {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

impl ObjectIdentity {
    pub fn of(value: &Value, release_namespace: &str) -> Self {
        let api_version = text(value, "/apiVersion");
        let group = api_version
            .split_once('/')
            .map(|(g, _)| g.to_string())
            .unwrap_or_default();
        let kind = text(value, "/kind");
        let namespace = Some(text(value, "/metadata/namespace"))
            .filter(|ns| !ns.is_empty())
            .or_else(|| (!is_cluster_scoped(&kind)).then(|| release_namespace.to_string()));
        Self {
            group,
            kind,
            namespace,
            name: text(value, "/metadata/name"),
        }
    }

    pub fn key(&self) -> String {
        format!(
            "{}/{}/{}/{}",
            self.group,
            self.kind,
            self.namespace.as_deref().unwrap_or(""),
            self.name
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HelmPreviewChange {
    Added,
    Changed,
    Removed,
    Unchanged,
}

/// One object of an upgrade preview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelmPreviewObject {
    /// Stable identity (`group/kind/namespace/name`).
    pub key: String,
    /// The rendered `apiVersion` (the current one for removed objects).
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    /// Template of the new (or, for removed objects, the old) render.
    pub source: Option<String>,
    pub change: HelmPreviewChange,
    /// As rendered by the running revision.
    pub before: Option<Value>,
    /// As rendered by the upgrade.
    pub after: Option<Value>,
    /// Server-side dry run against the live object (when requested).
    pub live: Option<DryRunResult>,
}

/// `helm_upgrade_preview`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelmUpgradePreview {
    /// The dry-run upgrade (rendered manifest, notes, values).
    pub result: HelmInstallResult,
    /// Revision the preview compares against.
    pub current_revision: i64,
    pub objects: Vec<HelmPreviewObject>,
    /// Rendered objects were also dry-run against the live cluster.
    pub live_checked: bool,
    /// More objects than the live dry run covers; the rest have `live: null`.
    pub live_truncated: bool,
}

/// Object-level changes between the running and the rendered manifest.
pub fn diff_manifests(
    before: &str,
    after: &str,
    release_namespace: &str,
) -> Vec<HelmPreviewObject> {
    let mut old: HashMap<String, (ObjectIdentity, ManifestObject)> = HashMap::new();
    for object in split_manifest(before) {
        let id = ObjectIdentity::of(&object.value, release_namespace);
        old.insert(id.key(), (id, object));
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for object in split_manifest(after) {
        let id = ObjectIdentity::of(&object.value, release_namespace);
        let key = id.key();
        if !seen.insert(key.clone()) {
            continue;
        }
        let previous = old.remove(&key);
        let change = match &previous {
            None => HelmPreviewChange::Added,
            Some((_, prev)) if prev.value == object.value => HelmPreviewChange::Unchanged,
            Some(_) => HelmPreviewChange::Changed,
        };
        out.push(HelmPreviewObject {
            key,
            api_version: text(&object.value, "/apiVersion"),
            kind: id.kind,
            namespace: id.namespace,
            name: id.name,
            source: object
                .source
                .or_else(|| previous.as_ref().and_then(|(_, p)| p.source.clone())),
            change,
            before: previous.map(|(_, p)| p.value),
            after: Some(object.value),
            live: None,
        });
    }
    for (key, (id, object)) in old {
        out.push(HelmPreviewObject {
            key,
            api_version: text(&object.value, "/apiVersion"),
            kind: id.kind,
            namespace: id.namespace,
            name: id.name,
            source: object.source,
            change: HelmPreviewChange::Removed,
            before: Some(object.value),
            after: None,
            live: None,
        });
    }
    out.sort_by(|a, b| {
        a.change
            .cmp(&b.change)
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.namespace.cmp(&b.namespace))
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

impl Kubepit {
    /// The newest stored revision of a release, decoded.
    pub(crate) async fn helm_latest_release(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Value> {
        validate_release_name(name)?;
        validate_namespace(namespace)?;
        let client = self.client(cluster_id).await?;
        let newest = list_revisions(&client, Some(namespace), Some(name))
            .await?
            .into_iter()
            .max_by_key(|r| r.revision);
        let Some(newest) = newest else {
            bail!("helm release {name} not found in namespace {namespace}");
        };
        fetch_release(&client, &newest).await
    }

    /// `helm_release_values_schema`: the `values.schema.json` the running
    /// revision was installed with (`None` = the chart has none).
    pub async fn helm_release_values_schema(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<Value>> {
        let release = self
            .helm_latest_release(cluster_id, namespace, name)
            .await?;
        release_values_schema(&release)
    }

    /// `helm_chart_values_schema`: `values.schema.json` of a repository or
    /// OCI chart version (`None` = newest stable), pulled into a private
    /// temp directory and cached for a few minutes.
    pub async fn helm_chart_values_schema(
        &self,
        chart_ref: &str,
        version: Option<&str>,
    ) -> Result<Option<Value>> {
        validate_chart_ref(chart_ref)?;
        let version = normalize_version(version)?;
        let helm = tools::require_helm(self.settings().helm_path.as_deref())?;
        let key = format!(
            "{}|{chart_ref}|{}",
            helm.display(),
            version.as_deref().unwrap_or("")
        );
        if let Some(hit) = cached_schema(&key) {
            return Ok(hit);
        }
        let scratch = ScratchDir::create(&self.paths().run_dir())?;
        let mut args = vec![
            "pull".to_string(),
            chart_ref.to_string(),
            "--untar".to_string(),
            format!("--destination={}", scratch.0.to_string_lossy()),
        ];
        if let Some(v) = &version {
            args.push(format!("--version={v}"));
        }
        let out = tools::run(&helm, &args, PULL_TIMEOUT).await?;
        if !out.success {
            let detail = if out.stderr.trim().is_empty() {
                out.stdout.trim()
            } else {
                out.stderr.trim()
            };
            bail!(
                "helm pull failed: {}",
                detail.strip_prefix("Error: ").unwrap_or(detail)
            );
        }
        let schema = find_pulled_schema(&scratch.0)?;
        drop(scratch);
        cache_schema(key, schema.clone());
        Ok(schema)
    }

    /// `helm_upgrade_preview`: the dry-run upgrade split into object
    /// changes against the running revision, optionally dry-run against
    /// the live objects too. Never changes the cluster.
    pub async fn helm_upgrade_preview(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
        request: &HelmUpgradeRequest,
        live: bool,
    ) -> Result<HelmUpgradePreview> {
        let current = self
            .helm_latest_release(cluster_id, namespace, name)
            .await?;
        let current_manifest = text(&current, "/manifest");
        let current_revision = current.get("version").and_then(Value::as_i64).unwrap_or(0);
        let dry = HelmUpgradeRequest {
            dry_run: true,
            ..request.clone()
        };
        let result = self.helm_upgrade(cluster_id, namespace, name, &dry).await?;
        let mut objects = diff_manifests(&current_manifest, &result.manifest, namespace);
        let mut live_truncated = false;
        if live {
            let client = self.client(cluster_id).await?;
            let targets: Vec<usize> = objects
                .iter()
                .enumerate()
                .filter(|(_, o)| o.after.is_some())
                .map(|(i, _)| i)
                .collect();
            live_truncated = targets.len() > MAX_LIVE_OBJECTS;
            let docs: Vec<(usize, Value)> = targets
                .into_iter()
                .take(MAX_LIVE_OBJECTS)
                .filter_map(|i| objects[i].after.clone().map(|doc| (i, doc)))
                .collect();
            let results: Vec<(usize, DryRunResult)> = stream::iter(docs)
                .map(|(i, mut doc)| {
                    let client = client.clone();
                    async move {
                        let result = self
                            .dry_run_document(
                                &client,
                                cluster_id,
                                &mut doc,
                                ApplyMode::Apply,
                                Some(namespace),
                            )
                            .await;
                        (i, result)
                    }
                })
                .buffered(LIVE_CONCURRENCY)
                .collect()
                .await;
            for (i, result) in results {
                objects[i].live = Some(result);
            }
        }
        Ok(HelmUpgradePreview {
            result,
            current_revision,
            objects,
            live_checked: live,
            live_truncated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_is_read_from_the_decoded_release() {
        let schema = json!({"$schema": "http://json-schema.org/draft-07/schema#",
                            "type": "object", "properties": {"replicaCount": {"type": "integer"}}});
        let encoded = BASE64.encode(serde_json::to_vec(&schema).unwrap());
        let release =
            json!({"name": "web", "chart": {"metadata": {"name": "nginx"}, "schema": encoded}});
        assert_eq!(
            release_values_schema(&release).unwrap(),
            Some(schema.clone())
        );
        // Charts without a schema: missing, null or empty.
        for chart in [json!({}), json!({"schema": null}), json!({"schema": ""})] {
            let release = json!({"chart": chart});
            assert_eq!(release_values_schema(&release).unwrap(), None);
        }
        let inline = json!({"chart": {"schema": schema}});
        assert!(release_values_schema(&inline).unwrap().is_some());
        let garbage = json!({"chart": {"schema": BASE64.encode("{not json")}});
        assert!(release_values_schema(&garbage).is_err());
        let not_object = json!({"chart": {"schema": BASE64.encode("true")}});
        assert_eq!(release_values_schema(&not_object).unwrap(), None);
        assert_eq!(parse_schema_file(b"  \n").unwrap(), None);
    }

    #[test]
    fn pulled_charts_are_searched_for_a_schema() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("nginx/charts/common")).unwrap();
        assert_eq!(find_pulled_schema(dir.path()).unwrap(), None);
        std::fs::write(
            dir.path().join("nginx/values.schema.json"),
            r#"{"type":"object","required":["image"]}"#,
        )
        .unwrap();
        let schema = find_pulled_schema(dir.path()).unwrap().unwrap();
        assert_eq!(schema["required"][0], "image");
        let empty = tempfile::tempdir().unwrap();
        assert!(find_pulled_schema(empty.path()).is_err());
    }

    const BEFORE: &str = "---
# Source: web/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  ports:
  - port: 80
---
# Source: web/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
---
# Source: web/templates/ingress.yaml
apiVersion: networking.k8s.io/v1beta1
kind: Ingress
metadata:
  name: web
---
# Source: web/templates/pdb.yaml
apiVersion: policy/v1beta1
kind: PodDisruptionBudget
metadata:
  name: web
---
# Source: web/templates/role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: web-reader
";

    const AFTER: &str = "---
# Source: web/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  ports:
  - port: 80
---
# Source: web/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
--- # the new ingress
# Source: web/templates/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
---
# Source: web/templates/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web
---
# Source: web/templates/empty.yaml
---
apiVersion: v1
kind: List
items:
- apiVersion: v1
  kind: ConfigMap
  metadata:
    name: extra
---
: not yaml [
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: web-reader
";

    #[test]
    fn manifests_split_into_objects() {
        let objects = split_manifest(AFTER);
        let kinds: Vec<&str> = objects
            .iter()
            .map(|o| o.value["kind"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "Service",
                "Deployment",
                "Ingress",
                "HorizontalPodAutoscaler",
                "ConfigMap",
                "ClusterRole"
            ]
        );
        assert_eq!(
            objects[2].source.as_deref(),
            Some("web/templates/ingress.yaml")
        );
        assert_eq!(objects[4].source, None);
        assert!(split_manifest("").is_empty());
        assert!(split_manifest("# only a comment\n---\n").is_empty());
    }

    #[test]
    fn objects_match_by_group_kind_namespace_and_name() {
        let id = ObjectIdentity::of(
            &json!({"apiVersion": "apps/v1", "kind": "Deployment",
                                            "metadata": {"name": "web"}}),
            "shop",
        );
        assert_eq!(id.key(), "apps/Deployment/shop/web");
        let cluster = ObjectIdentity::of(
            &json!({"apiVersion": "rbac.authorization.k8s.io/v1",
                                                 "kind": "ClusterRole", "metadata": {"name": "r"}}),
            "shop",
        );
        assert_eq!(cluster.namespace, None);

        let changes = diff_manifests(BEFORE, AFTER, "shop");
        let summary: Vec<(HelmPreviewChange, &str)> =
            changes.iter().map(|c| (c.change, c.key.as_str())).collect();
        assert_eq!(
            summary,
            vec![
                (HelmPreviewChange::Added, "/ConfigMap/shop/extra"),
                (
                    HelmPreviewChange::Added,
                    "autoscaling/HorizontalPodAutoscaler/shop/web"
                ),
                // Same object: only the default namespace was made explicit before.
                (HelmPreviewChange::Changed, "apps/Deployment/shop/web"),
                // An apiVersion bump within a group is a change, not remove + add.
                (
                    HelmPreviewChange::Changed,
                    "networking.k8s.io/Ingress/shop/web"
                ),
                (
                    HelmPreviewChange::Removed,
                    "policy/PodDisruptionBudget/shop/web"
                ),
                (
                    HelmPreviewChange::Unchanged,
                    "rbac.authorization.k8s.io/ClusterRole//web-reader"
                ),
                (HelmPreviewChange::Unchanged, "/Service/shop/web"),
            ]
        );
        let ingress = &changes[3];
        assert_eq!(ingress.api_version, "networking.k8s.io/v1");
        assert_eq!(
            ingress.before.as_ref().unwrap()["apiVersion"],
            "networking.k8s.io/v1beta1"
        );
        let removed = &changes[4];
        assert!(removed.after.is_none());
        assert_eq!(removed.source.as_deref(), Some("web/templates/pdb.yaml"));
        assert_eq!(
            changes[2].after.as_ref().unwrap()["spec"]["replicas"],
            json!(3)
        );
        // Identical manifests: everything unchanged.
        assert!(diff_manifests(AFTER, AFTER, "shop")
            .iter()
            .all(|c| c.change == HelmPreviewChange::Unchanged));
        // A first render against nothing: everything added.
        assert!(diff_manifests("", AFTER, "shop")
            .iter()
            .all(|c| c.change == HelmPreviewChange::Added));
    }
}
