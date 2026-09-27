//! Helm releases.
//!
//! Reading is native: Helm 3 stores every release revision in a Secret
//! (`type: helm.sh/release.v1`, labels `owner=helm,name,version,status`)
//! whose `data.release` is base64(gzip(JSON)) — and the Secret API adds its
//! own base64 layer. Listing first fetches only Secret *metadata* (labels
//! carry name + revision), then downloads just the newest revision of each
//! release, so clusters with long histories stay fast.
//!
//! Mutations (rollback, uninstall, upgrade) shell out to the `helm` binary
//! with `--kubeconfig run/<id>.kubeconfig --kube-context <ctx>` so hooks,
//! waits and chart rendering behave exactly like the user's CLI.

use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use futures::{stream, StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams};
use kube::Client;
use serde_json::{Map, Value};

use crate::app::Kubepit;
use crate::error::kube_error;
use crate::paths::atomic_write;
use crate::tools;
use crate::types::{ClusterDef, HelmRelease, HelmReleaseDetail};

const HELM_SECRET_SELECTOR: &str = "owner=helm";
const HELM_SECRET_TYPE: &str = "type=helm.sh/release.v1";
const FETCH_CONCURRENCY: usize = 8;
/// Upgrades and rollbacks may run hooks; give them room.
const HELM_MUTATION_TIMEOUT: Duration = Duration::from_secs(600);
const HELM_QUERY_TIMEOUT: Duration = Duration::from_secs(30);

/// Decode a release payload, tolerating one or two base64 layers (the raw
/// Secret API value vs. the already-decoded `ByteString`), optional gzip,
/// and plain JSON.
pub fn decode_release(raw: &[u8]) -> Result<Value> {
    let mut data = raw.to_vec();
    for _ in 0..4 {
        let trimmed = data.trim_ascii();
        if trimmed.starts_with(&[0x1f, 0x8b]) {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(trimmed)
                .read_to_end(&mut out)
                .context("helm release payload is not valid gzip")?;
            data = out;
            continue;
        }
        if trimmed.first() == Some(&b'{') {
            return serde_json::from_slice(trimmed).context("helm release payload is not JSON");
        }
        let compact: Vec<u8> = trimmed
            .iter()
            .copied()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        data = BASE64
            .decode(compact)
            .context("helm release payload is not base64")?;
    }
    bail!("unrecognised helm release encoding")
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

/// Summary row for a decoded release.
pub fn release_summary(release: &Value, fallback_namespace: &str) -> HelmRelease {
    let non_empty = |s: Option<&str>| s.filter(|s| !s.is_empty()).map(str::to_string);
    HelmRelease {
        name: str_at(release, "/name").unwrap_or_default().to_string(),
        namespace: non_empty(str_at(release, "/namespace"))
            .unwrap_or_else(|| fallback_namespace.to_string()),
        revision: release.get("version").and_then(Value::as_i64).unwrap_or(0),
        status: str_at(release, "/info/status")
            .unwrap_or("unknown")
            .to_string(),
        chart: str_at(release, "/chart/metadata/name")
            .unwrap_or_default()
            .to_string(),
        chart_version: str_at(release, "/chart/metadata/version")
            .unwrap_or_default()
            .to_string(),
        app_version: non_empty(str_at(release, "/chart/metadata/appVersion")),
        updated: non_empty(str_at(release, "/info/last_deployed")),
        description: non_empty(str_at(release, "/info/description")),
    }
}

/// Deep-merge `overlay` onto `base` the way Helm coalesces user values onto
/// chart defaults: maps merge recursively, everything else is replaced, and
/// an explicit `null` removes the key.
pub fn deep_merge(base: &Value, overlay: &Value) -> Value {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            let mut merged: Map<String, Value> = base_map.clone();
            for (key, value) in overlay_map {
                if value.is_null() {
                    merged.remove(key);
                    continue;
                }
                let next = match merged.get(key) {
                    Some(existing) => deep_merge(existing, value),
                    None => value.clone(),
                };
                merged.insert(key.clone(), next);
            }
            Value::Object(merged)
        }
        (_, overlay) => overlay.clone(),
    }
}

/// YAML for a values map; `null` / `{}` render as an empty string.
pub fn values_yaml(values: &Value) -> Result<String> {
    match values {
        Value::Null => Ok(String::new()),
        Value::Object(map) if map.is_empty() => Ok(String::new()),
        other => serde_yaml::to_string(other).context("failed to render values as YAML"),
    }
}

/// Everything a detail view needs from the newest revision.
pub fn release_detail(
    latest: &Value,
    history: Vec<HelmRelease>,
    namespace: &str,
) -> Result<HelmReleaseDetail> {
    let config = latest.get("config").cloned().unwrap_or(Value::Null);
    let defaults = latest
        .pointer("/chart/values")
        .cloned()
        .unwrap_or(Value::Null);
    let computed = match (&defaults, &config) {
        (Value::Null, c) => c.clone(),
        (d, Value::Null) => d.clone(),
        (d, c) => deep_merge(d, c),
    };
    Ok(HelmReleaseDetail {
        release: release_summary(latest, namespace),
        history,
        values_yaml: values_yaml(&config)?,
        computed_values_yaml: values_yaml(&computed)?,
        manifest: str_at(latest, "/manifest").unwrap_or_default().to_string(),
        notes: str_at(latest, "/info/notes")
            .unwrap_or_default()
            .to_string(),
    })
}

/// Pick `repo/chart` from `helm search repo -o json` output.
pub fn pick_repo_chart(search_json: &str, chart: &str, version: &str) -> Option<String> {
    let entries: Vec<Value> = serde_json::from_str(search_json).ok()?;
    entries.iter().find_map(|e| {
        let name = e.get("name")?.as_str()?;
        let (_, short) = name.split_once('/')?;
        let v = e.get("version")?.as_str()?;
        (short == chart && v.trim_start_matches('v') == version.trim_start_matches('v'))
            .then(|| name.to_string())
    })
}

/// Secret name, release name, revision — from label metadata only.
pub(crate) struct RevisionRef {
    pub(crate) secret: String,
    pub(crate) namespace: String,
    pub(crate) release: String,
    pub(crate) revision: i64,
}

pub(crate) async fn list_revisions(
    client: &Client,
    namespace: Option<&str>,
    release: Option<&str>,
) -> Result<Vec<RevisionRef>> {
    let api: Api<Secret> = match namespace.filter(|n| !n.is_empty()) {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let mut selector = HELM_SECRET_SELECTOR.to_string();
    if let Some(name) = release {
        selector.push_str(&format!(",name={name}"));
    }
    let list = api
        .list_metadata(
            &ListParams::default()
                .labels(&selector)
                .fields(HELM_SECRET_TYPE),
        )
        .await
        .map_err(kube_error)
        .context("failed to list helm release secrets")?;
    Ok(list
        .items
        .into_iter()
        .filter_map(|meta| {
            let labels = meta.metadata.labels.as_ref()?;
            Some(RevisionRef {
                secret: meta.metadata.name.clone()?,
                namespace: meta.metadata.namespace.clone().unwrap_or_default(),
                release: labels.get("name")?.clone(),
                revision: labels.get("version")?.parse().ok()?,
            })
        })
        .collect())
}

pub(crate) async fn fetch_release(client: &Client, rev: &RevisionRef) -> Result<Value> {
    let api: Api<Secret> = Api::namespaced(client.clone(), &rev.namespace);
    let secret = api
        .get(&rev.secret)
        .await
        .map_err(kube_error)
        .with_context(|| format!("failed to read secret {}/{}", rev.namespace, rev.secret))?;
    let raw = secret
        .data
        .as_ref()
        .and_then(|d| d.get("release"))
        .map(|b| b.0.clone())
        .with_context(|| format!("secret {} has no release payload", rev.secret))?;
    decode_release(&raw)
        .with_context(|| format!("cannot decode helm release in secret {}", rev.secret))
}

impl Kubepit {
    /// `helm_releases`: newest revision of every release.
    pub async fn helm_releases(
        &self,
        cluster_id: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<HelmRelease>> {
        let client = self.client(cluster_id).await?;
        let mut latest: HashMap<(String, String), RevisionRef> = HashMap::new();
        for rev in list_revisions(&client, namespace, None).await? {
            let key = (rev.namespace.clone(), rev.release.clone());
            match latest.get(&key) {
                Some(existing) if existing.revision >= rev.revision => {}
                _ => {
                    latest.insert(key, rev);
                }
            }
        }
        let mut releases: Vec<HelmRelease> = stream::iter(latest.into_values())
            .map(|rev| {
                let client = client.clone();
                async move {
                    match fetch_release(&client, &rev).await {
                        Ok(value) => Some(release_summary(&value, &rev.namespace)),
                        Err(e) => {
                            tracing::warn!(
                                "skipping helm release {}/{}: {e:#}",
                                rev.namespace,
                                rev.release
                            );
                            None
                        }
                    }
                }
            })
            .buffer_unordered(FETCH_CONCURRENCY)
            .filter_map(|r| async move { r })
            .collect()
            .await;
        releases.sort_by(|a, b| {
            a.namespace
                .cmp(&b.namespace)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(releases)
    }

    /// `helm_release_detail`.
    pub async fn helm_release_detail(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
    ) -> Result<HelmReleaseDetail> {
        let client = self.client(cluster_id).await?;
        let mut revisions = list_revisions(&client, Some(namespace), Some(name)).await?;
        if revisions.is_empty() {
            bail!("helm release {name} not found in namespace {namespace}");
        }
        revisions.sort_by_key(|r| std::cmp::Reverse(r.revision));
        let decoded: Vec<Value> = stream::iter(revisions)
            .map(|rev| {
                let client = client.clone();
                async move { fetch_release(&client, &rev).await }
            })
            .buffered(FETCH_CONCURRENCY)
            .try_collect()
            .await?;
        let history: Vec<HelmRelease> = decoded
            .iter()
            .map(|v| release_summary(v, namespace))
            .collect();
        release_detail(&decoded[0], history, namespace)
    }

    /// Run `helm <args>` against the cluster's single-context kubeconfig.
    pub(crate) async fn helm_exec(
        &self,
        cluster_id: &str,
        namespace: &str,
        action: &str,
        args: Vec<String>,
        timeout: Duration,
    ) -> Result<String> {
        let cluster = self.ensure_writable(cluster_id, action)?;
        self.helm_exec_on(&cluster, namespace, action, args, timeout)
            .await
    }

    /// [`Self::helm_exec`] without the read-only guard, for invocations that
    /// cannot change the cluster (dry runs).
    pub(crate) async fn helm_exec_on(
        &self,
        cluster: &ClusterDef,
        namespace: &str,
        action: &str,
        mut args: Vec<String>,
        timeout: Duration,
    ) -> Result<String> {
        let helm = tools::require_helm(self.settings().helm_path.as_deref())?;
        let kubeconfig = self.write_run_kubeconfig(cluster)?;
        args.extend([
            "--kubeconfig".to_string(),
            kubeconfig.to_string_lossy().to_string(),
            "--kube-context".to_string(),
            cluster.context.clone(),
            "--namespace".to_string(),
            namespace.to_string(),
        ]);
        let out = tools::run(&helm, &args, timeout).await?;
        if !out.success {
            let detail = if out.stderr.trim().is_empty() {
                out.stdout.trim()
            } else {
                out.stderr.trim()
            };
            let detail = detail.strip_prefix("Error: ").unwrap_or(detail);
            bail!("helm {action} failed: {detail}");
        }
        Ok(out.stdout)
    }

    /// `helm_rollback`.
    pub async fn helm_rollback(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
        revision: i64,
    ) -> Result<()> {
        if revision < 0 {
            bail!("invalid revision {revision}");
        }
        self.helm_exec(
            cluster_id,
            namespace,
            "rollback",
            vec!["rollback".into(), name.into(), revision.to_string()],
            HELM_MUTATION_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    /// `helm_uninstall`.
    pub async fn helm_uninstall(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
    ) -> Result<()> {
        self.helm_exec(
            cluster_id,
            namespace,
            "uninstall",
            vec!["uninstall".into(), name.into()],
            HELM_MUTATION_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    /// `helm_upgrade_values`: re-deploy the same chart version with new
    /// user values. The release secret does not record where the chart came
    /// from, so this only works when a configured helm repository serves
    /// exactly that chart version.
    pub async fn helm_upgrade_values(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
        values: &str,
    ) -> Result<()> {
        let cluster = self.ensure_writable(cluster_id, "upgrade")?;
        let parsed: serde_yaml::Value = if values.trim().is_empty() {
            serde_yaml::Value::Mapping(Default::default())
        } else {
            serde_yaml::from_str(values).context("values are not valid YAML")?
        };
        if !matches!(
            parsed,
            serde_yaml::Value::Mapping(_) | serde_yaml::Value::Null
        ) {
            bail!("values must be a YAML mapping");
        }
        let detail = self
            .helm_release_detail(cluster_id, namespace, name)
            .await?;
        let chart = detail.release.chart.clone();
        let version = detail.release.chart_version.clone();
        let helm = tools::require_helm(self.settings().helm_path.as_deref())?;

        let search_args: Vec<String> = [
            "search",
            "repo",
            &chart,
            "--version",
            &version,
            "-o",
            "json",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let chart_ref = match tools::run(&helm, &search_args, HELM_QUERY_TIMEOUT).await {
            Ok(out) if out.success => pick_repo_chart(&out.stdout, &chart, &version),
            _ => None,
        }
        .ok_or_else(|| {
            anyhow!(
                "Upgrading requires the chart to be available from a configured helm repository \
                 ({chart} {version} was not found; add its repository with `helm repo add` and `helm repo update`)"
            )
        })?;

        let values_file = self.paths().run_dir().join(format!(
            "helm-values-{}.yaml",
            uuid::Uuid::new_v4().simple()
        ));
        atomic_write(&values_file, values.as_bytes(), true)?;
        let result = self
            .helm_exec(
                &cluster.id,
                namespace,
                "upgrade",
                vec![
                    "upgrade".into(),
                    name.into(),
                    chart_ref,
                    "--version".into(),
                    version,
                    "-f".into(),
                    values_file.to_string_lossy().to_string(),
                ],
                HELM_MUTATION_TIMEOUT,
            )
            .await;
        let _ = std::fs::remove_file(&values_file);
        result.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use serde_json::json;
    use std::io::Write;

    fn release_json() -> Value {
        json!({
            "name": "web",
            "namespace": "shop",
            "version": 3,
            "info": {
                "status": "deployed",
                "first_deployed": "2024-01-01T00:00:00Z",
                "last_deployed": "2024-02-01T10:00:00.123456+01:00",
                "description": "Upgrade complete",
                "notes": "Visit http://web.local"
            },
            "chart": {
                "metadata": {"name": "nginx", "version": "15.4.2", "appVersion": "1.25.3"},
                "values": {"replicaCount": 1, "image": {"tag": "1.25", "pullPolicy": "IfNotPresent"}, "debug": true}
            },
            "config": {"replicaCount": 3, "image": {"tag": "1.26"}, "debug": null},
            "manifest": "---\nkind: Deployment\n"
        })
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(bytes).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn decodes_single_and_double_base64_payloads() {
        let json = serde_json::to_vec(&release_json()).unwrap();
        // What helm stores: base64(gzip(json)). The typed Secret API already
        // removed the transport base64, so this is what `ByteString` holds.
        let helm_payload = BASE64.encode(gzip(&json));
        let single = decode_release(helm_payload.as_bytes()).unwrap();
        assert_eq!(single["name"], "web");
        // Raw API value: one more base64 layer.
        let double = BASE64.encode(&helm_payload);
        assert_eq!(decode_release(double.as_bytes()).unwrap()["version"], 3);
        // Plain gzip and plain JSON also work.
        assert_eq!(decode_release(&gzip(&json)).unwrap()["namespace"], "shop");
        assert_eq!(
            decode_release(&json).unwrap()["chart"]["metadata"]["name"],
            "nginx"
        );
        assert!(decode_release(b"%%% not a release %%%").is_err());
    }

    #[test]
    fn summary_maps_contract_fields() {
        let r = release_summary(&release_json(), "fallback");
        assert_eq!(r.name, "web");
        assert_eq!(r.namespace, "shop");
        assert_eq!(r.revision, 3);
        assert_eq!(r.status, "deployed");
        assert_eq!(r.chart, "nginx");
        assert_eq!(r.chart_version, "15.4.2");
        assert_eq!(r.app_version.as_deref(), Some("1.25.3"));
        assert_eq!(
            r.updated.as_deref(),
            Some("2024-02-01T10:00:00.123456+01:00")
        );
        assert_eq!(r.description.as_deref(), Some("Upgrade complete"));
        let minimal = release_summary(&json!({"name": "x", "version": 1}), "ns");
        assert_eq!(minimal.namespace, "ns");
        assert_eq!(minimal.app_version, None);
    }

    #[test]
    fn detail_merges_values_like_helm() {
        let d = release_detail(&release_json(), vec![], "shop").unwrap();
        let values: serde_yaml::Value = serde_yaml::from_str(&d.values_yaml).unwrap();
        assert_eq!(values["replicaCount"], serde_yaml::Value::from(3));
        let computed: Value = serde_json::to_value(
            serde_yaml::from_str::<serde_yaml::Value>(&d.computed_values_yaml).unwrap(),
        )
        .unwrap();
        assert_eq!(computed["replicaCount"], 3);
        assert_eq!(computed["image"]["tag"], "1.26");
        assert_eq!(computed["image"]["pullPolicy"], "IfNotPresent");
        assert!(computed.get("debug").is_none(), "null removes a default");
        assert_eq!(d.notes, "Visit http://web.local");
        assert!(d.manifest.contains("Deployment"));
    }

    #[test]
    fn empty_config_renders_empty_values() {
        let mut release = release_json();
        release["config"] = json!({});
        let d = release_detail(&release, vec![], "shop").unwrap();
        assert_eq!(d.values_yaml, "");
        assert!(d.computed_values_yaml.contains("replicaCount: 1"));
    }

    #[test]
    fn repo_chart_resolution() {
        let out = r#"[{"name":"bitnami/nginx","version":"15.4.2","app_version":"1.25.3"},
                      {"name":"other/nginx-ingress","version":"15.4.2"}]"#;
        assert_eq!(
            pick_repo_chart(out, "nginx", "15.4.2").as_deref(),
            Some("bitnami/nginx")
        );
        assert_eq!(pick_repo_chart(out, "nginx", "1.0.0"), None);
        assert_eq!(pick_repo_chart("[]", "nginx", "15.4.2"), None);
        assert_eq!(pick_repo_chart("Error", "nginx", "15.4.2"), None);
    }
}
