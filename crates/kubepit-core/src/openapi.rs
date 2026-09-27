//! The cluster's own OpenAPI v3 schemas, for schema-aware YAML editing and
//! the API explorer (builtins and CRDs alike).
//!
//! `/openapi/v3` lists one document per group-version, each with a
//! `serverRelativeURL` carrying a content hash (`?hash=…`). Documents are
//! fetched on demand through that URL and cached per connection, keyed by
//! the hash, so an unchanged group-version is never downloaded twice while
//! a changed one (a CRD installed or upgraded) is. The index itself is
//! re-read after [`INDEX_TTL`] or on request. Everything is dropped when the
//! cluster disconnects, and a reconnect (new `connected_at`) starts empty.
//!
//! Documents are reduced to `components.schemas`: `paths` is by far the
//! largest part of a document and the UI never needs it.
//!
//! Read-only: allowed on clusters marked `read_only`.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use kube::Client;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::app::Kubepit;
use crate::error::{api_code, kube_error};

/// How long a fetched index is trusted before it is read again.
pub const INDEX_TTL: Duration = Duration::from_secs(60);

const INDEX_PATH: &str = "/openapi/v3";

/// `/openapi/v3`: the group-versions whose schemas the cluster publishes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenApiIndex {
    /// Changes whenever any group-version document changes.
    pub hash: String,
    /// Sorted by group (core first), then version.
    pub group_versions: Vec<OpenApiGroupVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenApiGroupVersion {
    /// `""` for the core group.
    pub group: String,
    pub version: String,
    /// `v1`, `apps/v1`.
    pub api_version: String,
    /// Index key: `api/v1`, `apis/apps/v1`.
    pub path: String,
    /// Content hash of the document, when the server publishes one.
    pub hash: Option<String>,
    /// Where the document is served (`/openapi/v3/apis/apps/v1?hash=…`).
    #[serde(skip)]
    pub url: String,
}

/// Map an index key to its group and version; `None` for entries that are
/// not group-version documents (`version`, `apis`, `apis/apps`, `.well-known/…`).
pub fn group_version_of(path: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        ["api", version] if !version.is_empty() => Some((String::new(), version.to_string())),
        ["apis", group, version] if !group.is_empty() && !version.is_empty() => {
            Some((group.to_string(), version.to_string()))
        }
        _ => None,
    }
}

fn hash_param(url: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("hash="))
        .filter(|h| !h.is_empty())
        .map(str::to_string)
}

/// Parse the `/openapi/v3` discovery document.
pub fn parse_index(body: &Value) -> Result<OpenApiIndex> {
    let paths = body
        .get("paths")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("the OpenAPI v3 index has no paths"))?;
    let mut group_versions: Vec<OpenApiGroupVersion> = paths
        .iter()
        .filter_map(|(path, entry)| {
            let (group, version) = group_version_of(path)?;
            let url = entry
                .get("serverRelativeURL")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{INDEX_PATH}/{path}"));
            Some(OpenApiGroupVersion {
                api_version: if group.is_empty() {
                    version.clone()
                } else {
                    format!("{group}/{version}")
                },
                group,
                version,
                path: path.clone(),
                hash: hash_param(&url),
                url,
            })
        })
        .collect();
    group_versions.sort_by(|a, b| {
        (!a.group.is_empty(), &a.group, &a.version).cmp(&(
            !b.group.is_empty(),
            &b.group,
            &b.version,
        ))
    });
    let mut hasher = DefaultHasher::new();
    for gv in &group_versions {
        gv.path.hash(&mut hasher);
        gv.hash.hash(&mut hasher);
    }
    Ok(OpenApiIndex {
        hash: format!("{:016x}", hasher.finish()),
        group_versions,
    })
}

/// Keep only `components.schemas` of a group-version document.
pub fn trim_document(mut doc: Value) -> Value {
    let schemas = doc
        .pointer_mut("/components/schemas")
        .map(Value::take)
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()));
    json!({ "components": { "schemas": schemas } })
}

struct CachedDoc {
    hash: Option<String>,
    doc: Arc<Value>,
}

#[derive(Default)]
struct ClusterSchemas {
    /// `connected_at` of the connection the entries belong to.
    connection: Option<i64>,
    index: Option<(Instant, Arc<OpenApiIndex>)>,
    /// Keyed by index path (`apis/apps/v1`).
    docs: HashMap<String, CachedDoc>,
}

/// In-memory OpenAPI v3 cache, one entry per connected cluster.
#[derive(Default)]
pub struct OpenApiCache {
    clusters: Mutex<HashMap<String, ClusterSchemas>>,
}

impl OpenApiCache {
    /// The cluster's entry, reset when it belongs to an older connection.
    fn with<T>(
        &self,
        cluster_id: &str,
        connection: Option<i64>,
        f: impl FnOnce(&mut ClusterSchemas) -> T,
    ) -> T {
        let mut clusters = self.clusters.lock();
        let entry = clusters.entry(cluster_id.to_string()).or_default();
        if entry.connection != connection {
            *entry = ClusterSchemas {
                connection,
                ..ClusterSchemas::default()
            };
        }
        f(entry)
    }

    fn index(&self, cluster_id: &str, connection: Option<i64>) -> Option<Arc<OpenApiIndex>> {
        self.with(cluster_id, connection, |c| {
            c.index
                .as_ref()
                .filter(|(at, _)| at.elapsed() < INDEX_TTL)
                .map(|(_, index)| index.clone())
        })
    }

    fn set_index(&self, cluster_id: &str, connection: Option<i64>, index: Arc<OpenApiIndex>) {
        self.with(cluster_id, connection, |c| {
            // Documents whose hash moved on are stale, and without a hash
            // there is no telling: keep only the provably unchanged ones.
            c.docs.retain(|path, doc| {
                doc.hash.is_some()
                    && index
                        .group_versions
                        .iter()
                        .any(|gv| &gv.path == path && gv.hash == doc.hash)
            });
            c.index = Some((Instant::now(), index));
        });
    }

    fn doc(
        &self,
        cluster_id: &str,
        connection: Option<i64>,
        gv: &OpenApiGroupVersion,
    ) -> Option<Arc<Value>> {
        self.with(cluster_id, connection, |c| {
            c.docs
                .get(&gv.path)
                .filter(|d| d.hash == gv.hash)
                .map(|d| d.doc.clone())
        })
    }

    fn set_doc(
        &self,
        cluster_id: &str,
        connection: Option<i64>,
        gv: &OpenApiGroupVersion,
        doc: Arc<Value>,
    ) {
        self.with(cluster_id, connection, |c| {
            c.docs.insert(
                gv.path.clone(),
                CachedDoc {
                    hash: gv.hash.clone(),
                    doc,
                },
            );
        });
    }

    /// Drop everything cached for a cluster (disconnect, removal).
    pub fn forget(&self, cluster_id: &str) {
        self.clusters.lock().remove(cluster_id);
    }
}

async fn get_json(client: &Client, url: &str) -> Result<Value> {
    let request = http::Request::get(url)
        .header(http::header::ACCEPT, "application/json")
        .body(Vec::new())
        .map_err(|e| anyhow!("failed to build the request for {url}: {e}"))?;
    client.request::<Value>(request).await.map_err(kube_error)
}

impl Kubepit {
    fn connection_key(&self, cluster_id: &str) -> Option<i64> {
        self.cluster_status(cluster_id).connected_at
    }

    /// `openapi_v3_index`: cached for [`INDEX_TTL`] unless `refresh`.
    pub async fn openapi_v3_index(&self, cluster_id: &str, refresh: bool) -> Result<OpenApiIndex> {
        Ok(self
            .openapi_index_cached(cluster_id, refresh)
            .await?
            .as_ref()
            .clone())
    }

    async fn openapi_index_cached(
        &self,
        cluster_id: &str,
        refresh: bool,
    ) -> Result<Arc<OpenApiIndex>> {
        let client = self.client(cluster_id).await?;
        let connection = self.connection_key(cluster_id);
        if !refresh {
            if let Some(index) = self.openapi.index(cluster_id, connection) {
                return Ok(index);
            }
        }
        let body = get_json(&client, INDEX_PATH).await.map_err(|e| {
            if api_code(&e) == Some(404) {
                anyhow!(
                    "this cluster does not publish OpenAPI v3 schemas (Kubernetes 1.27 or newer)"
                )
            } else {
                e.context("failed to read the OpenAPI v3 index")
            }
        })?;
        let index = Arc::new(parse_index(&body)?);
        self.openapi
            .set_index(cluster_id, connection, index.clone());
        Ok(index)
    }

    /// `openapi_v3_document`: the `components.schemas` of one group-version
    /// (`v1`, `apps/v1`), cached per connection by the document hash.
    pub async fn openapi_v3_document(&self, cluster_id: &str, api_version: &str) -> Result<Value> {
        let api_version = api_version.trim();
        let find = |index: &OpenApiIndex| {
            index
                .group_versions
                .iter()
                .find(|gv| gv.api_version == api_version)
                .cloned()
        };
        let mut index = self.openapi_index_cached(cluster_id, false).await?;
        let gv = match find(&index) {
            Some(gv) => gv,
            None => {
                // Maybe served since the index was read (a CRD just installed).
                index = self.openapi_index_cached(cluster_id, true).await?;
                find(&index).ok_or_else(|| {
                    anyhow!("{api_version} has no OpenAPI v3 document on this cluster")
                })?
            }
        };
        let connection = self.connection_key(cluster_id);
        if let Some(doc) = self.openapi.doc(cluster_id, connection, &gv) {
            return Ok(doc.as_ref().clone());
        }
        let client = self.client(cluster_id).await?;
        let body = get_json(&client, &gv.url)
            .await
            .with_context(|| format!("failed to read the OpenAPI v3 document of {api_version}"))?;
        let doc = Arc::new(trim_document(body));
        self.openapi
            .set_doc(cluster_id, connection, &gv, doc.clone());
        Ok(doc.as_ref().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_keeps_group_versions_with_hashes() {
        let body = json!({"paths": {
            ".well-known/openid-configuration": {"serverRelativeURL": "/openapi/v3/.well-known/openid-configuration?hash=AA"},
            "api": {"serverRelativeURL": "/openapi/v3/api?hash=BB"},
            "api/v1": {"serverRelativeURL": "/openapi/v3/api/v1?hash=CC"},
            "apis": {"serverRelativeURL": "/openapi/v3/apis?hash=DD"},
            "apis/apps": {"serverRelativeURL": "/openapi/v3/apis/apps?hash=EE"},
            "apis/apps/v1": {"serverRelativeURL": "/openapi/v3/apis/apps/v1?hash=FF"},
            "apis/cert-manager.io/v1": {"serverRelativeURL": "/openapi/v3/apis/cert-manager.io/v1?hash=GG&x=1"},
            "apis/batch/v1": {},
            "openid/v1/jwks": {"serverRelativeURL": "/openapi/v3/openid/v1/jwks?hash=HH"},
            "version": {"serverRelativeURL": "/openapi/v3/version?hash=II"}
        }});
        let index = parse_index(&body).unwrap();
        let versions: Vec<&str> = index
            .group_versions
            .iter()
            .map(|gv| gv.api_version.as_str())
            .collect();
        assert_eq!(
            versions,
            ["v1", "apps/v1", "batch/v1", "cert-manager.io/v1"]
        );
        let core = &index.group_versions[0];
        assert_eq!(core.group, "");
        assert_eq!(core.path, "api/v1");
        assert_eq!(core.hash.as_deref(), Some("CC"));
        assert_eq!(core.url, "/openapi/v3/api/v1?hash=CC");
        let batch = &index.group_versions[2];
        assert_eq!(batch.hash, None);
        assert_eq!(batch.url, "/openapi/v3/apis/batch/v1");
        assert_eq!(index.group_versions[3].hash.as_deref(), Some("GG"));
    }

    #[test]
    fn index_hash_follows_document_hashes() {
        let a = parse_index(
            &json!({"paths": {"api/v1": {"serverRelativeURL": "/openapi/v3/api/v1?hash=1"}}}),
        )
        .unwrap();
        let b = parse_index(
            &json!({"paths": {"api/v1": {"serverRelativeURL": "/openapi/v3/api/v1?hash=1"}}}),
        )
        .unwrap();
        let c = parse_index(
            &json!({"paths": {"api/v1": {"serverRelativeURL": "/openapi/v3/api/v1?hash=2"}}}),
        )
        .unwrap();
        assert_eq!(a.hash, b.hash);
        assert_ne!(a.hash, c.hash);
    }

    #[test]
    fn index_without_paths_is_an_error() {
        assert!(parse_index(&json!({"kind": "Status"})).is_err());
    }

    #[test]
    fn documents_keep_only_schemas() {
        let doc = json!({
            "openapi": "3.0.0",
            "paths": {"/api/v1/pods": {"get": {}}},
            "components": {"schemas": {"io.k8s.api.core.v1.Pod": {"type": "object"}},
                           "securitySchemes": {}}
        });
        assert_eq!(
            trim_document(doc),
            json!({"components": {"schemas": {"io.k8s.api.core.v1.Pod": {"type": "object"}}}})
        );
        assert_eq!(
            trim_document(json!({"paths": {}})),
            json!({"components": {"schemas": {}}})
        );
    }

    #[test]
    fn group_versions_are_recognised() {
        assert_eq!(
            group_version_of("api/v1"),
            Some((String::new(), "v1".into()))
        );
        assert_eq!(
            group_version_of("apis/apps/v1"),
            Some(("apps".into(), "v1".into()))
        );
        assert_eq!(group_version_of("apis/apps"), None);
        assert_eq!(group_version_of("api"), None);
        assert_eq!(group_version_of("openid/v1/jwks"), None);
    }
}
