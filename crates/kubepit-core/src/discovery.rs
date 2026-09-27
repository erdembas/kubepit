//! API discovery: which resource types a cluster serves.
//!
//! kube's high-level `Discovery` drops `shortNames` and `categories`, which
//! the resource picker needs (`po`, `deploy`, `all`), so this module walks
//! the legacy discovery endpoints directly: `/api/v1` plus the preferred
//! version of every group in `/apis`. Group documents are fetched
//! concurrently and a failing group (typically an aggregated API such as
//! `metrics.k8s.io` whose backing service is down) is skipped instead of
//! failing the whole list.
//!
//! Results are cached per connection and invalidated on reconnect.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use futures::{stream, StreamExt};
use k8s_openapi::api::core::v1::Namespace;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::APIResourceList;
use kube::api::{Api, ListParams};
use kube::core::GroupVersionKind;
use kube::Client;

use crate::app::Kubepit;
use crate::error::{is_forbidden, kube_error};
use crate::kubeconfig;
use crate::types::ApiResourceInfo;

/// Concurrent group-document requests during discovery.
const DISCOVERY_CONCURRENCY: usize = 16;

/// Convert one discovery document into UI descriptors, dropping
/// subresources (`pods/log`, `deployments/scale`, …).
pub fn to_infos(group: &str, version: &str, list: &APIResourceList) -> Vec<ApiResourceInfo> {
    let api_version = if group.is_empty() {
        version.to_string()
    } else {
        format!("{group}/{version}")
    };
    list.resources
        .iter()
        .filter(|r| !r.name.contains('/'))
        .map(|r| ApiResourceInfo {
            group: group.to_string(),
            version: version.to_string(),
            kind: r.kind.clone(),
            plural: r.name.clone(),
            namespaced: r.namespaced,
            api_version: api_version.clone(),
            verbs: r.verbs.clone(),
            short_names: r.short_names.clone().unwrap_or_default(),
            categories: r.categories.clone().unwrap_or_default(),
        })
        .collect()
}

/// Walk `/api` and `/apis` (preferred versions only).
pub async fn discover(client: &Client) -> Result<Vec<ApiResourceInfo>> {
    let core = client
        .list_core_api_resources("v1")
        .await
        .map_err(kube_error)?;
    let mut out = to_infos("", "v1", &core);

    let groups = client.list_api_groups().await.map_err(kube_error)?;
    let targets: Vec<(String, String, String)> = groups
        .groups
        .iter()
        .filter_map(|g| {
            let preferred = g
                .preferred_version
                .as_ref()
                .or_else(|| g.versions.first())?;
            Some((
                g.name.clone(),
                preferred.version.clone(),
                preferred.group_version.clone(),
            ))
        })
        .collect();

    let docs: Vec<_> = stream::iter(targets)
        .map(|(group, version, group_version)| {
            let client = client.clone();
            async move {
                let result = client.list_api_group_resources(&group_version).await;
                (group, version, result)
            }
        })
        .buffer_unordered(DISCOVERY_CONCURRENCY)
        .collect()
        .await;

    for (group, version, result) in docs {
        match result {
            Ok(list) => out.extend(to_infos(&group, &version, &list)),
            Err(e) => tracing::debug!("skipping API group {group}/{version}: {e}"),
        }
    }
    out.sort_by(|a, b| a.group.cmp(&b.group).then_with(|| a.kind.cmp(&b.kind)));
    Ok(out)
}

impl Kubepit {
    /// `api_resources`: cached per connection.
    pub async fn api_resources(&self, cluster_id: &str) -> Result<Vec<ApiResourceInfo>> {
        Ok(self
            .api_resources_cached(cluster_id)
            .await?
            .as_ref()
            .clone())
    }

    pub(crate) async fn api_resources_cached(
        &self,
        cluster_id: &str,
    ) -> Result<Arc<Vec<ApiResourceInfo>>> {
        let client = self.client(cluster_id).await?;
        if let Some(cached) = self.pool.resources(cluster_id) {
            return Ok(cached);
        }
        let resources = Arc::new(discover(&client).await?);
        self.pool.set_resources(cluster_id, resources.clone());
        Ok(resources)
    }

    /// Resolve `apiVersion` + `kind` (from a YAML document) to a resource
    /// descriptor. Uses the cached discovery for preferred versions and
    /// falls back to a pinned lookup for non-preferred ones (e.g.
    /// `autoscaling/v1` when `v2` is preferred).
    pub(crate) async fn resolve_kind(
        &self,
        cluster_id: &str,
        api_version: &str,
        kind: &str,
    ) -> Result<ApiResourceInfo> {
        let resources = self.api_resources_cached(cluster_id).await?;
        if let Some(found) = resources
            .iter()
            .find(|r| r.api_version == api_version && r.kind == kind)
        {
            return Ok(found.clone());
        }
        let (group, version) = match api_version.split_once('/') {
            Some((g, v)) => (g.to_string(), v.to_string()),
            None => (String::new(), api_version.to_string()),
        };
        let client = self.client(cluster_id).await?;
        let gvk = GroupVersionKind::gvk(&group, &version, kind);
        let (ar, caps) = kube::discovery::pinned_kind(&client, &gvk)
            .await
            .map_err(|e| anyhow!("{api_version} {kind} is not served by this cluster: {e}"))?;
        Ok(ApiResourceInfo {
            group: ar.group,
            version: ar.version,
            kind: ar.kind,
            plural: ar.plural,
            namespaced: caps.scope == kube::discovery::Scope::Namespaced,
            api_version: ar.api_version,
            verbs: caps.operations,
            short_names: Vec::new(),
            categories: Vec::new(),
        })
    }

    /// `namespace_names`: every namespace, or — when RBAC forbids listing
    /// namespaces — the cluster's configured `accessible_namespaces`, then
    /// its `default_namespace`, then the kubeconfig context namespace.
    pub async fn namespace_names(&self, cluster_id: &str) -> Result<Vec<String>> {
        let cluster = self.cluster_def(cluster_id)?;
        let client = self.client(cluster_id).await?;
        let api: Api<Namespace> = Api::all(client);
        match api.list_metadata(&ListParams::default()).await {
            Ok(list) => {
                let mut names: Vec<String> = list
                    .items
                    .into_iter()
                    .filter_map(|n| n.metadata.name)
                    .collect();
                names.sort();
                Ok(names)
            }
            Err(e) => {
                let err = kube_error(e);
                if !is_forbidden(&err) {
                    return Err(err.context("failed to list namespaces"));
                }
                if !cluster.accessible_namespaces.is_empty() {
                    return Ok(cluster.accessible_namespaces.clone());
                }
                if let Some(ns) = cluster.default_namespace.clone().filter(|n| !n.is_empty()) {
                    return Ok(vec![ns]);
                }
                let context_ns = kubeconfig::load(std::path::Path::new(&cluster.kubeconfig_path))
                    .ok()
                    .and_then(|kc| kubeconfig::namespace_for_context(&kc, &cluster.context));
                Ok(vec![context_ns.unwrap_or_else(|| "default".to_string())])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subresources_are_dropped_and_fields_mapped() {
        let list: APIResourceList = serde_json::from_value(json!({
            "groupVersion": "apps/v1",
            "resources": [
                {"name": "deployments", "singularName": "deployment", "namespaced": true,
                 "kind": "Deployment", "verbs": ["get", "list", "watch", "patch"],
                 "shortNames": ["deploy"], "categories": ["all"]},
                {"name": "deployments/scale", "singularName": "", "namespaced": true,
                 "kind": "Scale", "verbs": ["get", "patch"]},
                {"name": "controllerrevisions", "singularName": "controllerrevision",
                 "namespaced": true, "kind": "ControllerRevision", "verbs": ["get"]}
            ]
        }))
        .unwrap();
        let infos = to_infos("apps", "v1", &list);
        assert_eq!(infos.len(), 2);
        let deploy = &infos[0];
        assert_eq!(deploy.api_version, "apps/v1");
        assert_eq!(deploy.plural, "deployments");
        assert_eq!(deploy.short_names, vec!["deploy"]);
        assert_eq!(deploy.categories, vec!["all"]);
        assert!(deploy.namespaced);
        assert!(infos[1].short_names.is_empty());
    }

    #[test]
    fn core_group_api_version_is_bare() {
        let list: APIResourceList = serde_json::from_value(json!({
            "groupVersion": "v1",
            "resources": [{"name": "nodes", "singularName": "node", "namespaced": false,
                           "kind": "Node", "verbs": ["list"]}]
        }))
        .unwrap();
        let infos = to_infos("", "v1", &list);
        assert_eq!(infos[0].api_version, "v1");
        assert!(!infos[0].namespaced);
    }
}
