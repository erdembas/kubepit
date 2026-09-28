//! Access settings of a shared or secured Prometheus
//! (`ClusterDef.prometheus_access`), for both `auto` and `service` modes:
//!
//! - `tenant`: the `X-Scope-OrgID` of a multi-tenant Prometheus, Thanos or
//!   Mimir, sent with every request;
//! - `cluster_labels`: a selector (`cluster="prod-eu"`) injected into every
//!   query Kubepit builds, so a Prometheus that holds several clusters only
//!   answers for this one (see [`super::matchers`]);
//! - `auth`: a *reference* to a Kubernetes Secret holding a bearer token or
//!   basic-auth credentials. The API server's service proxy does not forward
//!   `Authorization`, so authenticated requests go through an in-process
//!   port-forward tunnel instead (see [`super::tunnel`]). The values are read
//!   on demand and never stored, logged or returned;
//! - `tls`: how the tunnel trusts an `https` service (a CA from a ConfigMap
//!   or Secret key, else the system roots, or no verification at all).

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::promql::quote;
use crate::service_proxy::valid_name;
use crate::types::{PrometheusConfig, PrometheusService};

/// Labels Kubepit's own queries select or group by. A cluster label with one
/// of these names would change what the presets mean.
pub const RESERVED_LABELS: [&str; 13] = [
    "__name__",
    "namespace",
    "pod",
    "container",
    "resource",
    "uid",
    "owner_name",
    "owner_kind",
    "job",
    "instance",
    "replicaset",
    "job_name",
    "reason",
];
/// Longest accepted tenant (`X-Scope-OrgID`, visible ASCII).
pub const MAX_TENANT_LEN: usize = 200;

/// `ClusterDef.prometheus_access`. The default (no tenant, no labels, no
/// auth) is today's behaviour: the service proxy, queries unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrometheusAccess {
    /// `X-Scope-OrgID`; `""` = none.
    #[serde(default)]
    pub tenant: String,
    /// Selector added to every Kubepit-built query, e.g. `{"cluster": "prod-eu"}`.
    #[serde(default)]
    pub cluster_labels: BTreeMap<String, String>,
    /// Credentials from a Secret; set = requests go through the tunnel.
    #[serde(default)]
    pub auth: Option<PrometheusAuth>,
    /// Trust of an `https` service reached through the tunnel.
    #[serde(default)]
    pub tls: Option<TunnelTls>,
}

/// Where the credentials of an authenticated Prometheus live. Tagged `type`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PrometheusAuth {
    /// `Authorization: Bearer <token>`.
    Bearer {
        namespace: String,
        secret: String,
        token_key: String,
    },
    /// `Authorization: Basic base64(<username>:<password>)`.
    Basic {
        namespace: String,
        secret: String,
        username_key: String,
        password_key: String,
    },
}

/// TLS of an `https` service reached through the tunnel.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelTls {
    /// PEM CA bundle; `None` = the system roots.
    #[serde(default)]
    pub ca: Option<KeyRef>,
    /// Accept any certificate (the cluster editor warns about it).
    #[serde(default)]
    pub insecure_skip_verify: bool,
}

/// One key of a ConfigMap or Secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyRef {
    pub kind: KeyRefKind,
    pub namespace: String,
    pub name: String,
    pub key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyRefKind {
    ConfigMap,
    Secret,
}

/// A Prometheus label name: `^[a-zA-Z_][a-zA-Z0-9_]*$`.
pub fn valid_label_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A ConfigMap or Secret data key (Kubernetes' key rules: letters, digits,
/// `-`, `_` and `.`, at most 253, not `.` or `..`).
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 253
        && key != "."
        && key != ".."
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn secret_ref(namespace: String, secret: String) -> Result<(String, String)> {
    let (namespace, secret) = (namespace.trim().to_string(), secret.trim().to_string());
    if !valid_name(&namespace) {
        bail!("Prometheus: enter the namespace of the credentials Secret");
    }
    if !valid_name(&secret) {
        bail!("Prometheus: enter the name of the credentials Secret");
    }
    Ok((namespace, secret))
}

fn data_key(value: String, what: &str) -> Result<String> {
    let value = value.trim().to_string();
    if !valid_key(&value) {
        bail!("Prometheus: enter the {what} (letters, digits, '-', '_' and '.')");
    }
    Ok(value)
}

impl PrometheusAccess {
    /// Trimmed and validated, as stored in `clusters.json`.
    pub fn normalized(self) -> Result<Self> {
        // A header value (`X-Scope-OrgID`): visible ASCII, so every request
        // can carry it.
        let tenant = self.tenant.trim().to_string();
        if tenant.len() > MAX_TENANT_LEN || !tenant.chars().all(|c| c.is_ascii_graphic()) {
            bail!(
                "Prometheus: the tenant must be at most {MAX_TENANT_LEN} visible ASCII characters \
                 (no spaces)"
            );
        }
        let mut cluster_labels = BTreeMap::new();
        for (name, value) in self.cluster_labels {
            let (name, value) = (name.trim().to_string(), value.trim().to_string());
            if !valid_label_name(&name) {
                bail!(
                    "Prometheus: \"{name}\" is not a label name (letters, digits and '_', \
                     not starting with a digit)"
                );
            }
            if RESERVED_LABELS.contains(&name.as_str()) {
                bail!(
                    "Prometheus: the label {name} is used by Kubepit's own queries; choose another"
                );
            }
            if value.is_empty() || value.chars().any(char::is_control) {
                bail!("Prometheus: enter a one-line value for the label {name}");
            }
            if cluster_labels.insert(name.clone(), value).is_some() {
                bail!("Prometheus: the label {name} is set twice");
            }
        }
        let auth = self.auth.map(PrometheusAuth::normalized).transpose()?;
        let tls = self
            .tls
            .map(TunnelTls::normalized)
            .transpose()?
            .filter(|tls| *tls != TunnelTls::default());
        Ok(Self {
            tenant,
            cluster_labels,
            auth,
            tls,
        })
    }

    /// `k="v"` pairs of the cluster labels, sorted by key, joined by `,`
    /// (`""` without labels).
    pub fn matchers(&self) -> String {
        self.cluster_labels
            .iter()
            .map(|(name, value)| format!("{name}={}", quote(value)))
            .collect::<Vec<_>>()
            .join(",")
    }
}

impl PrometheusAuth {
    fn normalized(self) -> Result<Self> {
        Ok(match self {
            PrometheusAuth::Bearer {
                namespace,
                secret,
                token_key,
            } => {
                let (namespace, secret) = secret_ref(namespace, secret)?;
                PrometheusAuth::Bearer {
                    namespace,
                    secret,
                    token_key: data_key(token_key, "Secret key of the token")?,
                }
            }
            PrometheusAuth::Basic {
                namespace,
                secret,
                username_key,
                password_key,
            } => {
                let (namespace, secret) = secret_ref(namespace, secret)?;
                PrometheusAuth::Basic {
                    namespace,
                    secret,
                    username_key: data_key(username_key, "Secret key of the username")?,
                    password_key: data_key(password_key, "Secret key of the password")?,
                }
            }
        })
    }
}

impl TunnelTls {
    fn normalized(self) -> Result<Self> {
        let ca = self
            .ca
            .map(|ca| -> Result<KeyRef> {
                let namespace = ca.namespace.trim().to_string();
                let name = ca.name.trim().to_string();
                if !valid_name(&namespace) || !valid_name(&name) {
                    bail!("Prometheus: enter the namespace and name of the CA ConfigMap or Secret");
                }
                Ok(KeyRef {
                    kind: ca.kind,
                    namespace,
                    name,
                    key: data_key(ca.key, "key of the CA certificate")?,
                })
            })
            .transpose()?;
        Ok(Self {
            ca,
            insecure_skip_verify: self.insecure_skip_verify,
        })
    }
}

/// Error when credentials would go to a service nobody chose.
pub const CREDENTIALS_NEED_A_SERVICE: &str = "Prometheus credentials are only sent to a service \
     chosen in the cluster settings, never to a detected one: choose the service, or remove the \
     credentials";

impl PrometheusAccess {
    /// Credentials (and the tunnel) need an explicitly chosen service:
    /// detection ranks services from a cluster-wide list, so anyone who may
    /// create a Service named like a Prometheus could otherwise receive them.
    pub fn ensure_source(&self, config: &PrometheusConfig) -> Result<()> {
        if self.auth.is_some() && !matches!(config, PrometheusConfig::Service { .. }) {
            bail!(CREDENTIALS_NEED_A_SERVICE);
        }
        Ok(())
    }
}

/// May credentials go to `service`? Only when it is the service `config`
/// names (never a detected candidate).
pub fn credentials_allowed(config: &PrometheusConfig, service: &PrometheusService) -> bool {
    config.service().as_ref() == Some(service)
}

/// Two selectors that can never match the same series: some shared label
/// has different values.
pub fn provably_disjoint(a: &PrometheusAccess, b: &PrometheusAccess) -> bool {
    a.cluster_labels.iter().any(|(name, value)| {
        b.cluster_labels
            .get(name)
            .is_some_and(|other| other != value)
    })
}

/// Would two clusters read each other's data? True when both query the same
/// hand-configured service with the same tenant, both declare cluster
/// labels (a shared source), and the labels are not [`provably_disjoint`].
///
/// A detected service is only known once connected, and a service name
/// alone does not make a source shared (every cluster has its own
/// `monitoring/prometheus-operated` behind its own API server), so clusters
/// without labels are not compared.
pub fn overlapping_sources(
    a: (&PrometheusConfig, &PrometheusAccess),
    b: (&PrometheusConfig, &PrometheusAccess),
) -> bool {
    matches!(a.0, PrometheusConfig::Service { .. })
        && a.0 == b.0
        && a.1.tenant == b.1.tenant
        && !a.1.cluster_labels.is_empty()
        && !b.1.cluster_labels.is_empty()
        && !provably_disjoint(a.1, b.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PromScheme;

    fn access(labels: &[(&str, &str)]) -> PrometheusAccess {
        PrometheusAccess {
            cluster_labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..Default::default()
        }
    }

    fn bearer(namespace: &str, secret: &str, key: &str) -> PrometheusAuth {
        PrometheusAuth::Bearer {
            namespace: namespace.into(),
            secret: secret.into(),
            token_key: key.into(),
        }
    }

    #[test]
    fn access_is_validated() {
        assert!(access(&[("pod", "x")]).normalized().is_err());
        assert!(access(&[("9bad", "x")]).normalized().is_err());
        assert!(PrometheusAccess {
            tenant: "a\nb".into(),
            ..Default::default()
        }
        .normalized()
        .is_err());
        assert_eq!(
            access(&[("region", "eu"), ("cluster", "prod")]).matchers(),
            r#"cluster="prod",region="eu""#
        );

        // Every reserved key, empty values, bad names and long tenants.
        for key in RESERVED_LABELS {
            assert!(access(&[(key, "x")]).normalized().is_err(), "{key}");
        }
        assert!(access(&[("cluster", "  ")]).normalized().is_err());
        assert!(access(&[("clus-ter", "a")]).normalized().is_err());
        assert!(access(&[("", "a")]).normalized().is_err());
        assert!(PrometheusAccess {
            tenant: "t".repeat(MAX_TENANT_LEN + 1),
            ..Default::default()
        }
        .normalized()
        .is_err());
        assert!(PrometheusAccess {
            tenant: "a\rb".into(),
            ..Default::default()
        }
        .normalized()
        .is_err());
        // `X-Scope-OrgID` is a header value: visible ASCII only, or every
        // request would fail to build.
        for tenant in ["tenánt", "team a", "team\u{a0}a", "チーム"] {
            let access = PrometheusAccess {
                tenant: tenant.into(),
                ..Default::default()
            };
            assert!(access.normalized().is_err(), "{tenant:?}");
        }
        let visible = PrometheusAccess {
            tenant: "team-a|b_1.{x}".into(),
            ..Default::default()
        };
        let normalized = visible.normalized().unwrap();
        assert!(http::HeaderValue::from_str(&normalized.tenant).is_ok());

        // Trimmed; values are quoted like every other PromQL string.
        let ok = PrometheusAccess {
            tenant: " team-a ".into(),
            cluster_labels: [(" _cluster_2 ".to_string(), " prod \"eu\" ".to_string())]
                .into_iter()
                .collect(),
            ..Default::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(ok.tenant, "team-a");
        assert_eq!(ok.matchers(), r#"_cluster_2="prod \"eu\"""#);
        assert_eq!(access(&[]).matchers(), "");
        assert_eq!(
            PrometheusAccess::default().normalized().unwrap(),
            PrometheusAccess::default()
        );
    }

    #[test]
    fn credentials_need_a_chosen_service() {
        let svc = PrometheusConfig::Service {
            namespace: "monitoring".into(),
            service: "thanos-query".into(),
            port: 9090,
            scheme: PromScheme::Https,
            path_prefix: String::new(),
        };
        let secured = PrometheusAccess {
            auth: Some(bearer("monitoring", "prom-auth", "token")),
            ..Default::default()
        };
        assert!(secured.ensure_source(&svc).is_ok());
        for config in [PrometheusConfig::Auto, PrometheusConfig::Off] {
            let err = secured.ensure_source(&config).unwrap_err().to_string();
            assert!(err.contains("chosen in the cluster settings"), "{err}");
        }
        // Tenant and labels work with detection.
        let shared = PrometheusAccess {
            tenant: "team-a".into(),
            ..access(&[("cluster", "prod")])
        };
        assert!(shared.ensure_source(&PrometheusConfig::Auto).is_ok());

        // At runtime: only the configured service itself.
        let configured = svc.service().unwrap();
        assert!(credentials_allowed(&svc, &configured));
        let detected = PrometheusService {
            kind: crate::types::PrometheusKind::PrometheusOperator,
            service: "prometheus-operated".into(),
            ..configured.clone()
        };
        assert!(!credentials_allowed(&svc, &detected));
        assert!(!credentials_allowed(&PrometheusConfig::Auto, &detected));
        assert!(!credentials_allowed(&PrometheusConfig::Auto, &configured));
    }

    #[test]
    fn secret_references_are_validated() {
        let with = |auth: PrometheusAuth| PrometheusAccess {
            auth: Some(auth),
            ..Default::default()
        };
        let ok = with(bearer(" monitoring ", " prom-auth ", " token "))
            .normalized()
            .unwrap();
        assert_eq!(ok.auth, Some(bearer("monitoring", "prom-auth", "token")));
        // Secret keys follow Kubernetes' key rules (upper case, `_` and `.` allowed).
        assert!(with(bearer("m", "s", "BEARER_TOKEN.txt"))
            .normalized()
            .is_ok());
        assert!(with(bearer("Monitoring", "s", "t")).normalized().is_err());
        assert!(with(bearer("m", "", "t")).normalized().is_err());
        assert!(with(bearer("m", "s", "")).normalized().is_err());
        assert!(with(bearer("m", "s", "a/b")).normalized().is_err());
        assert!(with(bearer("m", "s", "..")).normalized().is_err());
        let basic = PrometheusAuth::Basic {
            namespace: "m".into(),
            secret: "s".into(),
            username_key: "username".into(),
            password_key: "pass word".into(),
        };
        assert!(with(basic).normalized().is_err());

        let tls = |ca: Option<KeyRef>, skip: bool| PrometheusAccess {
            tls: Some(TunnelTls {
                ca,
                insecure_skip_verify: skip,
            }),
            ..Default::default()
        };
        let ca = KeyRef {
            kind: KeyRefKind::ConfigMap,
            namespace: "monitoring".into(),
            name: "prom-ca".into(),
            key: "ca.crt".into(),
        };
        assert_eq!(
            tls(Some(ca.clone()), false).normalized().unwrap().tls,
            Some(TunnelTls {
                ca: Some(ca.clone()),
                insecure_skip_verify: false
            })
        );
        assert_eq!(
            tls(None, false).normalized().unwrap().tls,
            None,
            "an empty TLS block is dropped"
        );
        let bad_ca = KeyRef {
            name: "Bad Name".into(),
            ..ca
        };
        assert!(tls(Some(bad_ca), false).normalized().is_err());
    }

    #[test]
    fn serde_matches_the_ts_contract() {
        let access: PrometheusAccess = serde_json::from_value(serde_json::json!({
            "tenant": "team-a",
            "cluster_labels": {"cluster": "prod"},
            "auth": {"type": "basic", "namespace": "m", "secret": "s",
                     "username_key": "u", "password_key": "p"},
            "tls": {"ca": {"kind": "Secret", "namespace": "m", "name": "ca", "key": "ca.crt"},
                    "insecure_skip_verify": false}
        }))
        .unwrap();
        assert!(matches!(access.auth, Some(PrometheusAuth::Basic { .. })));
        assert_eq!(access.tls.unwrap().ca.unwrap().kind, KeyRefKind::Secret);
        assert_eq!(
            serde_json::to_value(bearer("m", "s", "t")).unwrap(),
            serde_json::json!({"type": "bearer", "namespace": "m", "secret": "s", "token_key": "t"})
        );
        // Older clusters.json files have no access settings.
        let empty: PrometheusAccess = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, PrometheusAccess::default());
    }

    #[test]
    fn shared_sources_need_disjoint_selectors() {
        assert!(provably_disjoint(
            &access(&[("cluster", "a")]),
            &access(&[("cluster", "b")])
        ));
        assert!(!provably_disjoint(
            &access(&[("cluster", "a")]),
            &access(&[("region", "eu")])
        ));
        assert!(!provably_disjoint(
            &access(&[("cluster", "a")]),
            &access(&[("cluster", "a"), ("region", "eu")])
        ));
        assert!(!provably_disjoint(
            &access(&[]),
            &access(&[("cluster", "a")])
        ));

        let svc = PrometheusConfig::Service {
            namespace: "monitoring".into(),
            service: "thanos-query".into(),
            port: 9090,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        let other_svc = PrometheusConfig::Service {
            namespace: "monitoring".into(),
            service: "mimir".into(),
            port: 9090,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        let (a, eu, b) = (
            access(&[("cluster", "a")]),
            access(&[("region", "eu")]),
            access(&[("cluster", "b")]),
        );
        assert!(overlapping_sources((&svc, &a), (&svc, &eu)));
        assert!(!overlapping_sources((&svc, &a), (&svc, &b)), "disjoint");
        assert!(
            !overlapping_sources((&svc, &a), (&other_svc, &eu)),
            "another service"
        );
        let tenant_b = PrometheusAccess {
            tenant: "b".into(),
            ..eu.clone()
        };
        assert!(
            !overlapping_sources((&svc, &a), (&svc, &tenant_b)),
            "another tenant"
        );
        // Detected services are only known once connected; clusters without
        // labels do not declare a shared source (a service name is per cluster).
        let auto = PrometheusConfig::Auto;
        assert!(!overlapping_sources((&auto, &a), (&auto, &eu)));
        assert!(!overlapping_sources((&svc, &a), (&svc, &access(&[]))));
    }
}
