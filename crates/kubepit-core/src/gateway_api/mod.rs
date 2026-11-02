//! Gateway API support beyond the generic resource views.
//!
//! - **CRD manifests** ([`crds`]): `gateway_api_crds_manifest` downloads the
//!   official release install manifest (`standard` or `experimental`
//!   channel) from GitHub and checks that it holds nothing but Gateway API
//!   CustomResourceDefinitions and their ValidatingAdmissionPolicies. It
//!   never touches a cluster: the UI applies the text through the audited,
//!   read-only-guarded `resource_apply_yaml` (server-side apply).
//! - **Envoy admin** ([`envoy_admin`]): `envoy_admin` reads one fixed admin
//!   endpoint of an Envoy proxy pod. Envoy Gateway binds the admin listener
//!   to `127.0.0.1:19000` inside the pod, which the API server's
//!   `pods/proxy` cannot reach, so the request goes over an in-process
//!   `pods/portforward` stream (no local listener), like the Prometheus
//!   tunnel. Only GETs of fixed paths are sent, so Envoy's mutating admin
//!   endpoints stay unreachable; the command is allowed on `read_only`
//!   clusters, like port forwards.

pub mod crds;
pub mod envoy_admin;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::app::Kubepit;

/// A Gateway API release channel (`{channel}-install.yaml`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewayApiChannel {
    Standard,
    Experimental,
}

impl GatewayApiChannel {
    /// The channel name used in release asset names.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Experimental => "experimental",
        }
    }
}

/// `gateway_api_crds_manifest`: a validated release install manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayApiCrdsManifest {
    /// The release, e.g. `v1.3.0`.
    pub version: String,
    pub channel: GatewayApiChannel,
    /// The GitHub release asset URL that was requested (before redirects,
    /// whose signed URLs are not kept).
    pub url: String,
    /// The manifest text as downloaded.
    pub yaml: String,
    pub bytes: u64,
    /// CRD `metadata.name` values, in document order.
    pub crds: Vec<String>,
    /// The other documents as `Kind name`, e.g. `ValidatingAdmissionPolicy
    /// safe-upgrades.gateway.networking.k8s.io`.
    pub others: Vec<String>,
}

/// The Envoy admin endpoints `envoy_admin` can read (fixed GET paths, see
/// [`envoy_admin::admin_path`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvoyAdminEndpoint {
    ServerInfo,
    ConfigDump,
    Clusters,
    Listeners,
    Stats,
    Ready,
    Certs,
}

/// `envoy_admin`: one admin answer. A non-2xx `status` is an answer, not
/// an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvoyAdminResponse {
    pub endpoint: EnvoyAdminEndpoint,
    pub namespace: String,
    pub pod: String,
    pub port: u16,
    pub status: u16,
    /// The body as text (invalid UTF-8 replaced).
    pub body: String,
    /// Size of the body as received.
    pub bytes: u64,
}

/// A byte limit for messages: `8 MiB` for whole MiB, else `512 bytes`.
pub(crate) fn size_limit(bytes: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if bytes >= MIB && bytes.is_multiple_of(MIB) {
        format!("{} MiB", bytes / MIB)
    } else {
        format!("{bytes} bytes")
    }
}

impl Kubepit {
    /// `gateway_api_crds_manifest`: download and check the install manifest
    /// of `version` (no cluster is involved).
    pub async fn gateway_api_crds_manifest(
        &self,
        channel: GatewayApiChannel,
        version: &str,
    ) -> Result<GatewayApiCrdsManifest> {
        crds::download(channel, version).await
    }

    /// `envoy_admin`: GET one admin endpoint of the Envoy in `namespace/pod`
    /// (admin `port`, default [`envoy_admin::DEFAULT_PORT`]) over a
    /// port-forward. `filter` narrows `stats` (an Envoy regex) and is
    /// ignored for the other endpoints. Read-only, so no `ensure_writable`.
    pub async fn envoy_admin(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        port: Option<u16>,
        endpoint: EnvoyAdminEndpoint,
        filter: Option<&str>,
    ) -> Result<EnvoyAdminResponse> {
        let port = envoy_admin::validate_target(namespace, pod, port)?;
        let path = envoy_admin::admin_path(endpoint, filter)?;
        let client = self.client(cluster_id).await?;
        let answer = envoy_admin::admin_get(&client, namespace, pod, port, &path).await?;
        Ok(EnvoyAdminResponse {
            endpoint,
            namespace: namespace.to_string(),
            pod: pod.to_string(),
            port,
            status: answer.status,
            bytes: answer.body.len() as u64,
            body: String::from_utf8_lossy(&answer.body).into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn enums_match_contract_strings() {
        assert_eq!(
            serde_json::to_value(GatewayApiChannel::Experimental).unwrap(),
            "experimental"
        );
        assert_eq!(
            serde_json::from_value::<GatewayApiChannel>(json!("standard")).unwrap(),
            GatewayApiChannel::Standard
        );
        assert_eq!(
            serde_json::to_value(EnvoyAdminEndpoint::ServerInfo).unwrap(),
            "server_info"
        );
        assert_eq!(
            serde_json::from_value::<EnvoyAdminEndpoint>(json!("config_dump")).unwrap(),
            EnvoyAdminEndpoint::ConfigDump
        );
    }

    #[test]
    fn responses_serialize_flat_contract_shapes() {
        let answer = EnvoyAdminResponse {
            endpoint: EnvoyAdminEndpoint::Stats,
            namespace: "envoy-gateway-system".into(),
            pod: "envoy-default-eg-5c9b7f-abcde".into(),
            port: 19000,
            status: 503,
            body: "{}".into(),
            bytes: 2,
        };
        let v = serde_json::to_value(answer).unwrap();
        assert_eq!(v["endpoint"], "stats");
        assert_eq!(v["status"], 503);
        assert_eq!(v["port"], 19000);
        let manifest = GatewayApiCrdsManifest {
            version: "v1.3.0".into(),
            channel: GatewayApiChannel::Standard,
            url: crds::manifest_url(GatewayApiChannel::Standard, "v1.3.0"),
            yaml: String::new(),
            bytes: 0,
            crds: vec!["gateways.gateway.networking.k8s.io".into()],
            others: vec![],
        };
        let v = serde_json::to_value(manifest).unwrap();
        assert_eq!(v["channel"], "standard");
        assert_eq!(v["crds"][0], "gateways.gateway.networking.k8s.io");
        assert!(v["others"].as_array().unwrap().is_empty());
    }
}
