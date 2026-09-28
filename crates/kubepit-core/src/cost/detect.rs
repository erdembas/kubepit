//! Finding OpenCost or Kubecost among a cluster's services.
//!
//! The service list comes from the Prometheus detection
//! ([`crate::prometheus::detect::list_services`]); here services are
//! classified by name, labels and ports:
//!
//! - OpenCost (`opencost` chart): service `opencost` (or `*-opencost`,
//!   `app.kubernetes.io/name=opencost`), API port 9003 (`http`); the
//!   allocation API is `/allocation/compute`.
//! - Kubecost (`cost-analyzer` chart): service `*-cost-analyzer`
//!   (`app=cost-analyzer`), frontend port 9090 (`tcp-frontend`), which
//!   proxies the cost model under `/model` (`/model/allocation`).
//!
//! OpenCost ranks first when both exist (both answer allocation queries
//! the same way). The best candidates are probed with a one-hour query.

use super::types::{CostApiKind, CostService};
use crate::prometheus::detect::ServiceInfo;
use crate::types::PromScheme;

/// Candidates probed before giving up.
pub const MAX_PROBES: usize = 3;
/// Namespaces the charts install into, for clusters that forbid listing
/// services cluster-wide.
pub const FALLBACK_NAMESPACES: &[&str] = &["opencost", "kubecost", "cost-analyzer", "monitoring"];

/// A ranked cost API. Higher scores are probed first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostCandidate {
    pub score: i32,
    pub service: CostService,
}

fn label<'a>(svc: &'a ServiceInfo, key: &str) -> &'a str {
    svc.labels.get(key).map(String::as_str).unwrap_or_default()
}

fn port(svc: &ServiceInfo, names: &[&str], numbers: &[u16]) -> Option<u16> {
    names
        .iter()
        .find_map(|wanted| {
            svc.ports
                .iter()
                .find(|(name, _)| name.as_deref() == Some(*wanted))
                .map(|(_, p)| *p)
        })
        .or_else(|| {
            numbers
                .iter()
                .find(|n| svc.ports.iter().any(|(_, p)| p == *n))
                .copied()
        })
}

/// The cost API `svc` is, if it looks like one.
pub fn classify(svc: &ServiceInfo) -> Option<CostCandidate> {
    let name = svc.name.as_str();
    let app_name = label(svc, "app.kubernetes.io/name");
    let app = label(svc, "app");
    // UI-only services and the Kubecost helpers that share the prefix.
    if name.ends_with("-ui")
        || name.contains("prometheus")
        || name.contains("grafana")
        || name.contains("network-costs")
        || name.contains("forecasting")
        || name.contains("aggregator")
    {
        return None;
    }
    let bonus = match svc.namespace.as_str() {
        "opencost" | "kubecost" => 3,
        _ => 0,
    };
    let opencost = name == "opencost" || name.ends_with("-opencost") || app_name == "opencost";
    if opencost {
        let port = port(svc, &["http", "opencost-http"], &[9003])
            .or_else(|| svc.ports.first().map(|(_, p)| *p))?;
        return Some(CostCandidate {
            score: 100 + bonus,
            service: CostService {
                kind: CostApiKind::Opencost,
                namespace: svc.namespace.clone(),
                service: svc.name.clone(),
                port,
                scheme: PromScheme::Http,
                path_prefix: String::new(),
            },
        });
    }
    let kubecost =
        name.ends_with("cost-analyzer") || app == "cost-analyzer" || app_name == "cost-analyzer";
    if kubecost {
        let port = port(svc, &["tcp-frontend", "http"], &[9090])
            .or_else(|| svc.ports.first().map(|(_, p)| *p))?;
        return Some(CostCandidate {
            score: 90 + bonus,
            service: CostService {
                kind: CostApiKind::Kubecost,
                namespace: svc.namespace.clone(),
                service: svc.name.clone(),
                port,
                scheme: PromScheme::Http,
                path_prefix: String::new(),
            },
        });
    }
    None
}

/// Candidates among `services`, best first (ties: namespace, then name).
pub fn rank(services: &[ServiceInfo]) -> Vec<CostCandidate> {
    let mut out: Vec<CostCandidate> = services.iter().filter_map(classify).collect();
    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.service.namespace.cmp(&b.service.namespace))
            .then_with(|| a.service.service.cmp(&b.service.service))
    });
    out.dedup_by(|a, b| a.service == b.service);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(
        namespace: &str,
        name: &str,
        labels: &[(&str, &str)],
        ports: &[(&str, u16)],
    ) -> ServiceInfo {
        ServiceInfo {
            namespace: namespace.into(),
            name: name.into(),
            labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ports: ports
                .iter()
                .map(|(n, p)| ((!n.is_empty()).then(|| n.to_string()), *p))
                .collect(),
        }
    }

    #[test]
    fn opencost_and_kubecost_are_found_and_ranked() {
        let ranked = rank(&[
            svc("kube-system", "kube-dns", &[], &[("dns-tcp", 53)]),
            svc(
                "kubecost",
                "kubecost-cost-analyzer",
                &[("app", "cost-analyzer")],
                &[("tcp-model", 9003), ("tcp-frontend", 9090)],
            ),
            svc(
                "kubecost",
                "kubecost-prometheus-server",
                &[],
                &[("http", 80)],
            ),
            svc("kubecost", "kubecost-grafana", &[], &[("service", 80)]),
            svc(
                "opencost",
                "opencost",
                &[("app.kubernetes.io/name", "opencost")],
                &[("http", 9003), ("http-ui", 9090)],
            ),
            svc("opencost", "opencost-ui", &[], &[("http-ui", 9090)]),
        ]);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].service.kind, CostApiKind::Opencost);
        assert_eq!(ranked[0].service.port, 9003);
        assert_eq!(ranked[1].service.kind, CostApiKind::Kubecost);
        assert_eq!(ranked[1].service.service, "kubecost-cost-analyzer");
        assert_eq!(ranked[1].service.port, 9090, "the frontend proxies /model");
    }

    #[test]
    fn renamed_releases_and_missing_ports() {
        let ranked = rank(&[
            svc("tools", "finops-opencost", &[], &[("", 9003)]),
            svc("costs", "acme-cost-analyzer", &[], &[("web", 9090)]),
            svc(
                "costs",
                "acme-cost-analyzer-network-costs",
                &[],
                &[("m", 3001)],
            ),
            svc("x", "opencost", &[], &[]),
        ]);
        assert_eq!(ranked.len(), 2, "a service without ports cannot be queried");
        assert_eq!(ranked[0].service.service, "finops-opencost");
        assert_eq!(ranked[1].service.port, 9090);
        // Conventional namespaces win ties.
        let ranked = rank(&[
            svc("zzz", "opencost", &[], &[("http", 9003)]),
            svc("opencost", "opencost", &[], &[("http", 9003)]),
        ]);
        assert_eq!(ranked[0].service.namespace, "opencost");
        assert!(rank(&[]).is_empty());
    }
}
