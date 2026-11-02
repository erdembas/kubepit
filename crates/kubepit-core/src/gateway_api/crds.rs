//! The Gateway API release install manifest.
//!
//! `gateway_api_crds_manifest` downloads
//! `https://github.com/kubernetes-sigs/gateway-api/releases/download/{version}/{channel}-install.yaml`
//! (~1–2 MB) so the UI can review it and apply it through the audited
//! `resource_apply_yaml`; nothing here talks to a cluster. The download is
//! bounded: https only, at most [`MAX_REDIRECTS`] redirects and only to
//! GitHub's release hosts ([`check_redirect`]), [`DOWNLOAD_TIMEOUT`] overall,
//! [`MAX_MANIFEST_BYTES`] of body. The text is then checked by
//! [`validate_manifest`]: only Gateway API CustomResourceDefinitions and
//! ValidatingAdmissionPolicies (and their bindings) may be in it, so a
//! tampered or unexpected asset cannot smuggle workloads or RBAC into the
//! apply.

use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde::Deserialize;

use super::{size_limit, GatewayApiChannel, GatewayApiCrdsManifest};

/// Release assets are downloaded from here.
const RELEASES: &str = "https://github.com/kubernetes-sigs/gateway-api/releases/download";
/// Hosts a download may be redirected to (GitHub serves release assets from
/// `release-assets.githubusercontent.com`, older ones from
/// `objects.githubusercontent.com`).
const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];
/// Redirects followed at most.
pub const MAX_REDIRECTS: usize = 5;
/// Upper bound for connecting to GitHub (each hop).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound for the whole download, redirects and body included.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// Largest manifest accepted (the experimental channel is ~1.6 MB today).
pub const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
/// The oldest supported release: v1.0 still installed a webhook Deployment.
const MIN_VERSION: (u64, u64, u64) = (1, 1, 0);
/// API groups of Gateway API CRDs (`x-k8s.io`: experimental resources).
const CRD_GROUPS: [&str; 2] = ["gateway.networking.k8s.io", "gateway.networking.x-k8s.io"];

/// Check `version` (`v1.3.0`, `v1.4.0-rc.1`; v1.1.0 or later).
pub fn validate_version(version: &str) -> Result<()> {
    // `[0-9]`, not `\d`: the latter matches every Unicode digit.
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-rc\.[0-9]+)?$")
            .expect("valid version pattern")
    });
    let invalid = || {
        anyhow!(
            "{version:?} is not a Gateway API release version (for example v1.3.0 or v1.4.0-rc.1)"
        )
    };
    let parts = PATTERN.captures(version).ok_or_else(invalid)?;
    let number = |i: usize| parts[i].parse::<u64>().map_err(|_| invalid());
    if (number(1)?, number(2)?, number(3)?) < MIN_VERSION {
        bail!(
            "Gateway API {version} is not supported: use v1.1.0 or later (v1.0 still installed a webhook)"
        );
    }
    Ok(())
}

/// The release asset URL of `channel` in `version` (already validated).
pub fn manifest_url(channel: GatewayApiChannel, version: &str) -> String {
    format!("{RELEASES}/{version}/{}-install.yaml", channel.as_str())
}

/// Whether the redirect to `url`, hop number `hop` of the chain (1 for the
/// first), may be followed: https on the default port, a GitHub release
/// host, at most [`MAX_REDIRECTS`] hops. The reason is safe to show (the
/// host only, never the signed asset URL).
pub fn check_redirect(url: &reqwest::Url, hop: usize) -> std::result::Result<(), String> {
    if hop > MAX_REDIRECTS {
        return Err(format!("more than {MAX_REDIRECTS} redirects"));
    }
    if url.scheme() != "https" {
        return Err(format!("a redirect to a non-https URL ({}:)", url.scheme()));
    }
    let host = url.host_str().unwrap_or_default();
    if !ALLOWED_HOSTS.contains(&host) {
        return Err(format!("a redirect to an unexpected host \"{host}\""));
    }
    if url.port().is_some_and(|port| port != 443) {
        return Err(format!("a redirect to an unexpected port of {host}"));
    }
    Ok(())
}

/// The download client: the app's ring-based rustls stack with the system
/// roots, https only, [`check_redirect`] for every hop, no retries, no
/// `Referer`. System proxies apply (the target is public).
fn http_client() -> Result<reqwest::Client> {
    let redirects = reqwest::redirect::Policy::custom(|attempt| {
        // `previous` starts with the original URL, so its length is the
        // number of this hop.
        match check_redirect(attempt.url(), attempt.previous().len()) {
            Ok(()) => attempt.follow(),
            Err(why) => attempt.error(why),
        }
    });
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(redirects)
        .https_only(true)
        .retry(reqwest::retry::never())
        .referer(false)
        .user_agent(concat!("kubepit/", env!("CARGO_PKG_VERSION")))
        .tls_backend_preconfigured(crate::ai::provider::tls_config())
        .build()
        .context("could not set up the HTTP client")
}

/// A reqwest error without its URL (a redirect's may carry a signed query).
fn network_error(err: reqwest::Error) -> anyhow::Error {
    anyhow::Error::new(err.without_url())
}

/// The body of the answer for `asset` of `version`, at most `max` bytes. A
/// 404 means the release has no such asset; any other non-2xx is an error
/// with its status.
async fn read_manifest(
    mut response: reqwest::Response,
    version: &str,
    asset: &str,
    max: u64,
) -> Result<Vec<u8>> {
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        bail!("Gateway API release {version} has no {asset} (HTTP 404); check the version");
    }
    if !status.is_success() {
        bail!("GitHub answered HTTP {status} for {asset} of Gateway API {version}");
    }
    let too_large = || {
        anyhow!(
            "{asset} of Gateway API {version} is larger than {}",
            size_limit(max)
        )
    };
    if response.content_length().is_some_and(|len| len > max) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(network_error)
        .with_context(|| format!("the download of {asset} failed"))?
    {
        if (body.len() + chunk.len()) as u64 > max {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// `gateway_api_crds_manifest`: download, then [`validate_manifest`].
pub async fn download(channel: GatewayApiChannel, version: &str) -> Result<GatewayApiCrdsManifest> {
    let version = version.trim();
    validate_version(version)?;
    let url = manifest_url(channel, version);
    let asset = format!("{}-install.yaml", channel.as_str());
    let client = http_client()?;
    let fetch = async {
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(network_error)
            .with_context(|| format!("could not download {url}"))?;
        read_manifest(response, version, &asset, MAX_MANIFEST_BYTES).await
    };
    let body = tokio::time::timeout(DOWNLOAD_TIMEOUT, fetch)
        .await
        .map_err(|_| {
            anyhow!(
                "the download of {url} did not finish within {}s",
                DOWNLOAD_TIMEOUT.as_secs()
            )
        })??;
    let yaml = String::from_utf8(body)
        .map_err(|_| anyhow!("{asset} of Gateway API {version} is not UTF-8 text"))?;
    let (crds, others) = validate_manifest(&yaml)
        .with_context(|| format!("{asset} of Gateway API {version} was refused"))?;
    Ok(GatewayApiCrdsManifest {
        version: version.to_string(),
        channel,
        url,
        bytes: yaml.len() as u64,
        yaml,
        crds,
        others,
    })
}

/// Check every document of an install manifest and list them: CRD names
/// and the other documents as `Kind name`, both in document order. Allowed
/// are `apiextensions.k8s.io/v1` CustomResourceDefinitions of a Gateway API
/// group and `admissionregistration.k8s.io/v1` ValidatingAdmissionPolicies
/// and their bindings; empty documents are skipped. Anything else fails,
/// naming the document; so does a manifest without a CRD.
pub fn validate_manifest(yaml: &str) -> Result<(Vec<String>, Vec<String>)> {
    let mut crds = Vec::new();
    let mut others = Vec::new();
    for (index, document) in serde_yaml::Deserializer::from_str(yaml).enumerate() {
        let n = index + 1;
        let value = serde_yaml::Value::deserialize(document)
            .with_context(|| format!("document {n} is not valid YAML"))?;
        if value.is_null() {
            continue;
        }
        let text = |path: &[&str]| {
            path.iter()
                .try_fold(&value, |node, key| node.get(key))
                .and_then(serde_yaml::Value::as_str)
                .unwrap_or_default()
        };
        let (api_version, kind, name) = (
            text(&["apiVersion"]),
            text(&["kind"]),
            text(&["metadata", "name"]),
        );
        let what = match (kind, name) {
            ("", _) => format!("document {n} (no kind)"),
            (kind, "") => format!("document {n} ({kind} without a name)"),
            (kind, name) => format!("document {n} ({kind} {name})"),
        };
        match (api_version, kind) {
            ("apiextensions.k8s.io/v1", "CustomResourceDefinition") => {
                let group = text(&["spec", "group"]);
                if name.is_empty() {
                    bail!("{what} has no metadata.name");
                }
                if !CRD_GROUPS.contains(&group) {
                    bail!("{what} is not a Gateway API CRD (group \"{group}\")");
                }
                crds.push(name.to_string());
            }
            (
                "admissionregistration.k8s.io/v1",
                "ValidatingAdmissionPolicy" | "ValidatingAdmissionPolicyBinding",
            ) => {
                if name.is_empty() {
                    bail!("{what} has no metadata.name");
                }
                others.push(format!("{kind} {name}"));
            }
            _ => bail!(
                "{what} is not allowed: a Gateway API CRD manifest may only hold \
                 CustomResourceDefinitions and ValidatingAdmissionPolicies"
            ),
        }
    }
    if crds.is_empty() {
        bail!("the manifest holds no Gateway API CustomResourceDefinition");
    }
    Ok((crds, others))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape of a real `experimental-install.yaml` (trimmed specs).
    const MANIFEST: &str = "\
# Copyright 2025 The Kubernetes Authors.
#
# Gateway API Experimental channel install
#
---
#
# config/crd/experimental/gateway.networking.k8s.io_gatewayclasses.yaml
#
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  annotations:
    gateway.networking.k8s.io/bundle-version: v1.3.0
    gateway.networking.k8s.io/channel: experimental
  creationTimestamp: null
  name: gatewayclasses.gateway.networking.k8s.io
spec:
  group: gateway.networking.k8s.io
  names:
    kind: GatewayClass
    plural: gatewayclasses
  scope: Cluster
---
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: httproutes.gateway.networking.k8s.io
spec:
  group: gateway.networking.k8s.io
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: xlistenersets.gateway.networking.x-k8s.io
spec:
  group: gateway.networking.x-k8s.io
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: safe-upgrades.gateway.networking.k8s.io
spec:
  failurePolicy: Fail
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: safe-upgrades.gateway.networking.k8s.io
spec:
  policyName: safe-upgrades.gateway.networking.k8s.io
---
";

    #[test]
    fn versions_are_release_tags_from_v1_1() {
        for ok in ["v1.1.0", "v1.3.0", "v1.4.0-rc.1", "v1.10.2", "v2.0.0"] {
            validate_version(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        for bad in [
            "1.3.0",
            "v1.3",
            "v1.3.0-beta.1",
            "v1.3.0-rc",
            "v1.3.0 ",
            "v1.3.0\n",
            "v1.3.0/../../x",
            "v١.٣.٠",
            "v99999999999999999999999.0.0",
            "",
        ] {
            let err = validate_version(bad).unwrap_err().to_string();
            assert!(
                err.contains("is not a Gateway API release version"),
                "{bad}: {err}"
            );
        }
        for old in ["v1.0.0", "v0.8.1", "v1.0.1-rc.2"] {
            let err = validate_version(old).unwrap_err().to_string();
            assert!(err.contains("v1.1.0 or later"), "{old}: {err}");
        }
    }

    #[test]
    fn urls_name_the_channel_asset() {
        assert_eq!(
            manifest_url(GatewayApiChannel::Standard, "v1.3.0"),
            "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.3.0/standard-install.yaml"
        );
        assert!(manifest_url(GatewayApiChannel::Experimental, "v1.4.0-rc.1")
            .ends_with("/v1.4.0-rc.1/experimental-install.yaml"));
    }

    #[test]
    fn redirects_stay_on_github_release_hosts() {
        let url = |s: &str| reqwest::Url::parse(s).unwrap();
        for ok in [
            "https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x",
            "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1",
            "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.3.0/x",
            "https://github.com:443/a",
        ] {
            assert_eq!(check_redirect(&url(ok), 1), Ok(()), "{ok}");
        }
        let ok = url("https://release-assets.githubusercontent.com/a");
        assert_eq!(check_redirect(&ok, MAX_REDIRECTS), Ok(()));
        let err = check_redirect(&ok, MAX_REDIRECTS + 1).unwrap_err();
        assert!(err.contains("more than 5 redirects"), "{err}");

        let err = check_redirect(&url("http://release-assets.githubusercontent.com/a"), 1);
        assert!(err.unwrap_err().contains("non-https"));
        for host in [
            "https://example.com/a",
            "https://github.com.example.com/a",
            "https://raw.githubusercontent.com/a",
            "https://127.0.0.1/a",
        ] {
            let err = check_redirect(&url(host), 1).unwrap_err();
            assert!(err.contains("unexpected host"), "{host}: {err}");
            assert!(!err.contains("/a"), "no path in {err}");
        }
        let err = check_redirect(&url("https://github.com:8443/a"), 1).unwrap_err();
        assert!(err.contains("unexpected port"), "{err}");
    }

    #[test]
    fn manifests_list_crds_and_policies_in_order() {
        let (crds, others) = validate_manifest(MANIFEST).unwrap();
        assert_eq!(
            crds,
            [
                "gatewayclasses.gateway.networking.k8s.io",
                "httproutes.gateway.networking.k8s.io",
                "xlistenersets.gateway.networking.x-k8s.io",
            ]
        );
        assert_eq!(
            others,
            [
                "ValidatingAdmissionPolicy safe-upgrades.gateway.networking.k8s.io",
                "ValidatingAdmissionPolicyBinding safe-upgrades.gateway.networking.k8s.io",
            ]
        );
    }

    #[test]
    fn anything_else_in_a_manifest_is_refused() {
        let with = |extra: &str| format!("{MANIFEST}{extra}");
        let refused = [
            (
                "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: gateway-api-admission-server\n  namespace: gateway-system\n",
                "(Deployment gateway-api-admission-server) is not allowed",
            ),
            (
                "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: gateway-system\n",
                "(Namespace gateway-system) is not allowed",
            ),
            (
                "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: admin\n",
                "(ClusterRoleBinding admin) is not allowed",
            ),
            (
                "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: widgets.example.com\nspec:\n  group: example.com\n",
                "(CustomResourceDefinition widgets.example.com) is not a Gateway API CRD (group \"example.com\")",
            ),
            (
                "apiVersion: apiextensions.k8s.io/v1beta1\nkind: CustomResourceDefinition\nmetadata:\n  name: gateways.gateway.networking.k8s.io\nspec:\n  group: gateway.networking.k8s.io\n",
                "is not allowed",
            ),
            (
                "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nspec:\n  group: gateway.networking.k8s.io\n",
                "(CustomResourceDefinition without a name) has no metadata.name",
            ),
            (
                "apiVersion: admissionregistration.k8s.io/v1\nkind: MutatingWebhookConfiguration\nmetadata:\n  name: hook\n",
                "(MutatingWebhookConfiguration hook) is not allowed",
            ),
            ("just a string\n", "(no kind) is not allowed"),
            ("- a\n- b\n", "(no kind) is not allowed"),
        ];
        for (extra, expected) in refused {
            let err = format!("{:#}", validate_manifest(&with(extra)).unwrap_err());
            assert!(err.contains(expected), "{extra}: {err}");
        }
        let err = format!("{:#}", validate_manifest(&with("a: [b\n")).unwrap_err());
        assert!(err.contains("is not valid YAML"), "{err}");
        // Documents are numbered from 1, empty ones included.
        let err =
            validate_manifest("---\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n")
                .unwrap_err()
                .to_string();
        assert!(
            err.starts_with("document 2 (ConfigMap x) is not allowed"),
            "{err}"
        );
    }

    #[test]
    fn a_manifest_needs_a_crd() {
        for yaml in [
            "",
            "---\n---\n",
            "# only comments\n",
            "apiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingAdmissionPolicy\nmetadata:\n  name: p\n",
        ] {
            let err = validate_manifest(yaml).unwrap_err().to_string();
            assert!(err.contains("no Gateway API CustomResourceDefinition"), "{yaml:?}: {err}");
        }
    }

    fn response(status: u16, body: reqwest::Body) -> reqwest::Response {
        reqwest::Response::from(http::Response::builder().status(status).body(body).unwrap())
    }

    /// A body of `chunks` without a `Content-Length`.
    fn streamed(chunks: Vec<&'static str>) -> reqwest::Body {
        reqwest::Body::wrap_stream(futures::stream::iter(
            chunks.into_iter().map(Ok::<_, std::io::Error>),
        ))
    }

    #[tokio::test]
    async fn answers_are_read_within_the_cap() {
        let read = |r| read_manifest(r, "v1.3.0", "standard-install.yaml", 16);
        let body = read(response(200, "0123456789abcdef".into()))
            .await
            .unwrap();
        assert_eq!(body, b"0123456789abcdef");
        let body = read(response(200, streamed(vec!["01234567", "89abcdef"])))
            .await
            .unwrap();
        assert_eq!(body.len(), 16);

        // Too large: by Content-Length up front, or while streaming.
        let err = read(response(200, "0123456789abcdefg".into()))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("standard-install.yaml of Gateway API v1.3.0 is larger than 16 bytes"),
            "{err}"
        );
        let err = read(response(200, streamed(vec!["01234567", "89abcdef", "!"])))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("is larger than 16 bytes"), "{err}");
        assert_eq!(size_limit(MAX_MANIFEST_BYTES), "8 MiB");
    }

    #[tokio::test]
    async fn missing_assets_and_failures_are_errors() {
        let read = |r| read_manifest(r, "v1.9.9", "experimental-install.yaml", 1024);
        let err = read(response(404, "Not Found".into()))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "Gateway API release v1.9.9 has no experimental-install.yaml (HTTP 404); check the version"
        );
        let err = read(response(503, "".into()))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("GitHub answered HTTP 503"), "{err}");
    }
}
