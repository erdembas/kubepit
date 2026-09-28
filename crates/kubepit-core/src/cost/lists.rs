//! Paged lists for estimates and right-sizing: cluster-wide when allowed,
//! else per namespace (the requested ones, or the cluster's accessible
//! namespaces when RBAC forbids the cluster-wide list).

use anyhow::Result;
use k8s_openapi::{ClusterResourceScope, NamespaceResourceScope};
use kube::api::{Api, ListParams};
use kube::Client;
use serde::de::DeserializeOwned;

use crate::error::{api_code, kube_error};

/// Objects per list page.
const PAGE_SIZE: u32 = 500;
/// Pages read from one list (20 000 objects).
const MAX_PAGES: usize = 40;

async fn pages<K>(api: Api<K>) -> Result<Vec<K>>
where
    K: kube::Resource + Clone + DeserializeOwned + std::fmt::Debug,
{
    let mut out = Vec::new();
    let mut params = ListParams::default().limit(PAGE_SIZE);
    for _ in 0..MAX_PAGES {
        let page = api.list(&params).await.map_err(kube_error)?;
        out.extend(page.items);
        match page.metadata.continue_.filter(|c| !c.is_empty()) {
            Some(token) => params = params.continue_token(&token),
            None => break,
        }
    }
    Ok(out)
}

/// Namespaced objects in `namespaces` (all when empty). `Ok(None)` when the
/// cluster-wide list is forbidden and no namespaces are known to try.
pub async fn namespaced<K>(
    client: &Client,
    namespaces: &[String],
    accessible: &[String],
) -> Result<Option<Vec<K>>>
where
    K: kube::Resource<Scope = NamespaceResourceScope> + Clone + DeserializeOwned + std::fmt::Debug,
    K::DynamicType: Default,
{
    let per_namespace = |list: &[String]| {
        let client = client.clone();
        let list = list.to_vec();
        async move {
            let results = futures::future::join_all(
                list.iter()
                    .map(|ns| pages(Api::<K>::namespaced(client.clone(), ns))),
            )
            .await;
            // Missing or forbidden namespaces simply contribute nothing.
            results
                .into_iter()
                .filter_map(Result::ok)
                .flatten()
                .collect::<Vec<K>>()
        }
    };
    if !namespaces.is_empty() {
        return Ok(Some(per_namespace(namespaces).await));
    }
    match pages(Api::<K>::all(client.clone())).await {
        Ok(items) => Ok(Some(items)),
        Err(err) if api_code(&err) == Some(403) => {
            if accessible.is_empty() {
                Ok(None)
            } else {
                Ok(Some(per_namespace(accessible).await))
            }
        }
        Err(err) => Err(err),
    }
}

/// Cluster-scoped objects; `Ok(None)` when forbidden.
pub async fn cluster<K>(client: &Client) -> Result<Option<Vec<K>>>
where
    K: kube::Resource<Scope = ClusterResourceScope> + Clone + DeserializeOwned + std::fmt::Debug,
    K::DynamicType: Default,
{
    match pages(Api::<K>::all(client.clone())).await {
        Ok(items) => Ok(Some(items)),
        Err(err) if matches!(api_code(&err), Some(403 | 404)) => Ok(None),
        Err(err) => Err(err),
    }
}
