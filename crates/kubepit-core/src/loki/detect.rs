//! Finding Loki's query API in a cluster.
//!
//! 1. List services (cluster-wide; when RBAC forbids that, per namespace in
//!    [`FALLBACK_NAMESPACES`] plus the cluster's accessible namespaces).
//! 2. Classify them by name and labels ([`classify`]) and rank them: the
//!    grafana/loki chart's gateway first (it routes every read), then the
//!    microservices query frontend, the simple scalable read path, a single
//!    binary and finally a bare querier. Write path, caches, canaries,
//!    headless and memberlist services never qualify.
//! 3. Probe the best [`MAX_PROBES`] candidates with a labels request over
//!    the last five minutes; the best-ranked one that answers wins.

use anyhow::Result;
use kube::Client;

use super::request::{self, PROBE_TIMEOUT};
use crate::service_proxy::{self, ServiceInfo};
use crate::types::{LokiKind, LokiService, PromScheme};

/// Candidates probed before giving up.
pub const MAX_PROBES: usize = 4;

/// Where logging stacks usually live, for clusters that forbid listing
/// services cluster-wide.
pub const FALLBACK_NAMESPACES: &[&str] = &[
    "loki",
    "logging",
    "monitoring",
    "observability",
    "grafana",
    "loki-stack",
];

/// A ranked service. Higher scores are probed first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub score: i32,
    pub service: LokiService,
}

/// Parts of a Loki installation that do not serve queries (or are not
/// Loki at all but share the prefix).
const NOT_QUERY_PATH: &[&str] = &[
    "headless",
    "memberlist",
    "canary",
    "-write",
    "-backend",
    "ingester",
    "distributor",
    "compactor",
    "index-gateway",
    "ruler",
    "query-scheduler",
    "chunks-cache",
    "results-cache",
    "bloom",
    "exporter",
    "promtail",
    "alloy",
    "fluent",
    "grafana-agent",
    "minio",
    "discovery",
];

/// The kind and base score of a service, if it looks like a Loki read API.
fn rule_for(svc: &ServiceInfo) -> Option<(LokiKind, i32)> {
    let name = svc.name.as_str();
    let app_name = svc.label("app.kubernetes.io/name");
    let component = svc.label("app.kubernetes.io/component");
    let app = svc.label("app");
    let loki_app = matches!(app_name, "loki" | "loki-distributed") || app == "loki";
    if NOT_QUERY_PATH.iter().any(|n| name.contains(n)) {
        return None;
    }
    if name == "loki-gateway"
        || name.ends_with("-loki-gateway")
        || (loki_app && component == "gateway")
    {
        return Some((LokiKind::Gateway, 100));
    }
    if (name.contains("loki") && name.contains("query-frontend"))
        || (loki_app && component == "query-frontend")
    {
        return Some((LokiKind::QueryFrontend, 90));
    }
    if name == "loki-read" || name.ends_with("-loki-read") || (loki_app && component == "read") {
        return Some((LokiKind::Read, 85));
    }
    if name == "loki"
        || name.ends_with("-loki")
        || (loki_app && matches!(component, "" | "single-binary"))
    {
        return Some((LokiKind::Loki, 80));
    }
    if (name.contains("loki") && name.contains("querier")) || (loki_app && component == "querier") {
        return Some((LokiKind::Querier, 60));
    }
    None
}

/// Namespaces logging stacks conventionally use win ties.
fn namespace_bonus(namespace: &str) -> i32 {
    match namespace {
        "loki" | "logging" | "monitoring" | "observability" => 3,
        _ => 0,
    }
}

/// The candidate `svc` is, if it looks like Loki's query API.
pub fn classify(svc: &ServiceInfo) -> Option<Candidate> {
    let (kind, score) = rule_for(svc)?;
    let port = match kind {
        // nginx listens on 80 (`http-metrics` in newer charts, `http` before).
        LokiKind::Gateway => svc.pick_port(&["http-metrics", "http", "http-web"], &[80, 8080])?,
        _ => svc.pick_port(&["http-metrics", "http"], &[3100])?,
    };
    Some(Candidate {
        score: score + namespace_bonus(&svc.namespace),
        service: LokiService {
            kind,
            namespace: svc.namespace.clone(),
            service: svc.name.clone(),
            port,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        },
    })
}

/// Candidates among `services`, best first (ties: namespace, then name).
pub fn rank(services: &[ServiceInfo]) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = services.iter().filter_map(classify).collect();
    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.service.namespace.cmp(&b.service.namespace))
            .then_with(|| a.service.service.cmp(&b.service.service))
    });
    out.dedup_by(|a, b| a.service == b.service);
    out
}

/// Every service the user may list (see [`service_proxy::list_services`]).
pub async fn list_services(client: &Client, namespaces: &[String]) -> Result<Vec<ServiceInfo>> {
    service_proxy::list_services(client, FALLBACK_NAMESPACES, namespaces).await
}

/// Does `service` answer Loki queries? `Err` explains why not.
pub async fn probe(client: &Client, service: &LokiService, tenant: &str) -> Result<()> {
    let now = request::now_ns();
    let params = request::labels_params(now - 5 * 60 * 1_000_000_000, now, None);
    let path = service_proxy::proxy_path(&service.endpoint(), request::LABELS_PATH, &params);
    request::get_json(client, &path, tenant, PROBE_TIMEOUT)
        .await
        .and_then(|body| super::parse::parse_labels(&body))
        .map(|_| ())
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

    fn names(candidates: &[Candidate]) -> Vec<String> {
        candidates
            .iter()
            .map(|c| {
                format!(
                    "{}/{}:{}",
                    c.service.namespace, c.service.service, c.service.port
                )
            })
            .collect()
    }

    #[test]
    fn simple_scalable_chart_prefers_the_gateway_then_read() {
        let ranked = rank(&[
            svc("loki", "loki-write", &[], &[("http-metrics", 3100)]),
            svc(
                "loki",
                "loki-write-headless",
                &[],
                &[("http-metrics", 3100)],
            ),
            svc("loki", "loki-backend", &[], &[("http-metrics", 3100)]),
            svc(
                "loki",
                "loki-read",
                &[
                    ("app.kubernetes.io/name", "loki"),
                    ("app.kubernetes.io/component", "read"),
                ],
                &[("http-metrics", 3100), ("grpc", 9095)],
            ),
            svc("loki", "loki-read-headless", &[], &[("http-metrics", 3100)]),
            svc(
                "loki",
                "loki-gateway",
                &[("app.kubernetes.io/component", "gateway")],
                &[("http-metrics", 80)],
            ),
            svc("loki", "loki-memberlist", &[], &[("tcp", 7946)]),
            svc("loki", "loki-canary", &[], &[("http-metrics", 3500)]),
            svc(
                "loki",
                "loki-chunks-cache",
                &[],
                &[("memcached-client", 11211)],
            ),
            svc("monitoring", "promtail", &[], &[("http-metrics", 3101)]),
        ]);
        assert_eq!(
            names(&ranked),
            vec!["loki/loki-gateway:80", "loki/loki-read:3100"]
        );
        assert_eq!(ranked[0].service.kind, LokiKind::Gateway);
        assert_eq!(ranked[1].service.kind, LokiKind::Read);
    }

    #[test]
    fn distributed_single_binary_and_querier() {
        let ranked = rank(&[
            svc(
                "logging",
                "loki-distributed-querier",
                &[],
                &[("http", 3100), ("grpc", 9095)],
            ),
            svc(
                "logging",
                "loki-distributed-query-frontend",
                &[],
                &[("http", 3100), ("grpc", 9095)],
            ),
            svc(
                "logging",
                "loki-distributed-query-frontend-headless",
                &[],
                &[("http", 3100)],
            ),
            svc("zz", "loki", &[("app", "loki")], &[("http-metrics", 3100)]),
            svc("default", "kubernetes", &[], &[("https", 443)]),
        ]);
        assert_eq!(
            names(&ranked),
            vec![
                "logging/loki-distributed-query-frontend:3100",
                "zz/loki:3100",
                "logging/loki-distributed-querier:3100",
            ]
        );
        assert_eq!(ranked[0].service.kind, LokiKind::QueryFrontend);
        assert_eq!(ranked[1].service.kind, LokiKind::Loki);
        assert_eq!(ranked[2].service.kind, LokiKind::Querier);
    }

    #[test]
    fn labels_ports_and_namespace_ties() {
        // A renamed single binary found by its labels, on its named port.
        let ranked = rank(&[svc(
            "obs",
            "logs",
            &[("app.kubernetes.io/name", "loki")],
            &[("grpc", 9095), ("http-metrics", 3100)],
        )]);
        assert_eq!(names(&ranked), vec!["obs/logs:3100"]);
        // Ties go to conventional namespaces.
        let ranked = rank(&[
            svc("zzz", "loki-gateway", &[], &[("http", 80)]),
            svc("loki", "loki-gateway", &[], &[("http", 80)]),
        ]);
        assert_eq!(ranked[0].service.namespace, "loki");
        // Gateways without a named port fall back to 80.
        let ranked = rank(&[svc("loki", "loki-gateway", &[], &[("", 8080), ("", 80)])]);
        assert_eq!(ranked[0].service.port, 80);
        assert!(rank(&[svc("loki", "loki", &[], &[])]).is_empty(), "no port");
        assert!(rank(&[]).is_empty());
    }
}
