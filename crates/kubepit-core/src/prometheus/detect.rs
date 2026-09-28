//! Finding a Prometheus-compatible API in a cluster.
//!
//! 1. List services (cluster-wide; when RBAC forbids that, per namespace in
//!    [`FALLBACK_NAMESPACES`] plus the cluster's accessible namespaces).
//! 2. Classify them by name, labels and ports ([`classify`]) and rank the
//!    candidates. In-cluster Prometheus servers come first: a Thanos, Mimir
//!    or VictoriaMetrics cluster query layer may hold several clusters'
//!    data, where the presets' `sum(...)` would add them up.
//! 3. Probe the best [`MAX_PROBES`] candidates with `query=1` through the
//!    service proxy; the first that answers wins.

use anyhow::Result;
use kube::Client;

use super::proxy::{self, PROBE_TIMEOUT};
use crate::service_proxy;
use crate::types::{PromScheme, PrometheusKind, PrometheusService};

pub use crate::service_proxy::ServiceInfo;

/// Candidates probed before giving up.
pub const MAX_PROBES: usize = 4;
/// Where monitoring stacks usually live, for clusters that forbid listing
/// services cluster-wide.
pub const FALLBACK_NAMESPACES: &[&str] = &[
    "monitoring",
    "prometheus",
    "observability",
    "kube-prometheus-stack",
    "prometheus-operator",
    "victoria-metrics",
    "thanos",
    "mimir",
    "openshift-monitoring",
];

/// A ranked service. Higher scores are probed first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub score: i32,
    pub service: PrometheusService,
}

struct Rule {
    kind: PrometheusKind,
    score: i32,
    scheme: PromScheme,
    path_prefix: &'static str,
    /// Preferred port names, then numbers.
    port_names: &'static [&'static str],
    port_numbers: &'static [u16],
}

const WEB: &[&str] = &["web", "http-web", "http"];

fn rule_for(svc: &ServiceInfo) -> Option<Rule> {
    let name = svc.name.as_str();
    let app_name = svc.label("app.kubernetes.io/name");
    let component = svc.label("app.kubernetes.io/component");
    let app = svc.label("app");
    let rule = |kind, score, port_names, port_numbers| Rule {
        kind,
        score,
        scheme: PromScheme::Http,
        path_prefix: "",
        port_names,
        port_numbers,
    };

    // Never the exporters, alertmanager, operators or adapters that share
    // the `prometheus` prefix.
    const NOT_SERVERS: &[&str] = &[
        "exporter",
        "alertmanager",
        "pushgateway",
        "operator",
        "kube-state-metrics",
        "adapter",
        "blackbox",
        "grafana",
    ];
    if NOT_SERVERS.iter().any(|n| name.contains(n)) {
        return None;
    }

    if name == "prometheus-operated" || svc.label("operated-prometheus") == "true" {
        return Some(rule(PrometheusKind::PrometheusOperator, 100, WEB, &[9090]));
    }
    if name.ends_with("-kube-prometheus-prometheus")
        || name.ends_with("-kube-prom-prometheus")
        || app == "kube-prometheus-stack-prometheus"
    {
        return Some(rule(PrometheusKind::PrometheusOperator, 95, WEB, &[9090]));
    }
    if svc.namespace == "openshift-monitoring" && name == "thanos-querier" {
        return Some(Rule {
            scheme: PromScheme::Https,
            ..rule(PrometheusKind::Openshift, 90, &["web"], &[9091])
        });
    }
    if name == "prometheus-server"
        || name.ends_with("-prometheus-server")
        || (app_name == "prometheus" && component == "server")
        || (app == "prometheus" && svc.label("component") == "server")
    {
        return Some(rule(PrometheusKind::Prometheus, 90, WEB, &[80, 9090]));
    }
    if name.starts_with("vmsingle-")
        || name.contains("victoria-metrics-single")
        || matches!(app_name, "vmsingle" | "victoria-metrics-single")
    {
        return Some(rule(
            PrometheusKind::VictoriaMetrics,
            80,
            WEB,
            &[8429, 8428],
        ));
    }
    if name.contains("thanos-query") || (app_name == "thanos" && component.starts_with("query")) {
        let frontend = name.contains("frontend") || component == "query-frontend";
        return Some(rule(
            PrometheusKind::Thanos,
            if frontend { 72 } else { 70 },
            &["http", "web"],
            &[9090, 10902],
        ));
    }
    if name.starts_with("vmselect-") || name.contains("vmselect") || app_name == "vmselect" {
        return Some(Rule {
            path_prefix: "/select/0/prometheus",
            ..rule(PrometheusKind::VictoriaMetrics, 65, &["http"], &[8481])
        });
    }
    if (name.contains("mimir") && name.contains("query-frontend"))
        || (app_name == "mimir" && component == "query-frontend")
    {
        return Some(Rule {
            path_prefix: "/prometheus",
            ..rule(
                PrometheusKind::Mimir,
                60,
                &["http-metrics", "http"],
                &[8080],
            )
        });
    }
    let has_9090 = svc.ports.iter().any(|(_, p)| *p == 9090);
    if (name == "prometheus" || name.ends_with("-prometheus")) && has_9090 {
        return Some(rule(PrometheusKind::Prometheus, 50, WEB, &[9090]));
    }
    None
}

/// Namespaces monitoring stacks conventionally use win ties.
fn namespace_bonus(namespace: &str) -> i32 {
    match namespace {
        "monitoring" | "prometheus" | "observability" | "openshift-monitoring" => 3,
        _ => 0,
    }
}

/// The candidate `svc` is, if it looks like a Prometheus-compatible API.
pub fn classify(svc: &ServiceInfo) -> Option<Candidate> {
    let rule = rule_for(svc)?;
    let port = svc.pick_port(rule.port_names, rule.port_numbers)?;
    Some(Candidate {
        score: rule.score + namespace_bonus(&svc.namespace),
        service: PrometheusService {
            kind: rule.kind,
            namespace: svc.namespace.clone(),
            service: svc.name.clone(),
            port,
            scheme: rule.scheme,
            path_prefix: rule.path_prefix.to_string(),
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

/// Every service the user may list: cluster-wide, or per namespace when
/// the cluster-wide list is forbidden.
pub async fn list_services(client: &Client, namespaces: &[String]) -> Result<Vec<ServiceInfo>> {
    service_proxy::list_services(client, FALLBACK_NAMESPACES, namespaces).await
}

/// Does `service` answer Prometheus queries? `Err` explains why not.
pub async fn probe(client: &Client, service: &PrometheusService) -> Result<()> {
    let path = proxy::proxy_path(service, "/api/v1/query", &[("query", "1".to_string())]);
    proxy::get(client, &path, PROBE_TIMEOUT).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Service;

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
    fn kube_prometheus_stack_ranks_first_and_picks_the_web_port() {
        let services = vec![
            svc("kube-system", "kube-dns", &[], &[("dns-tcp", 53)]),
            svc(
                "monitoring",
                "kps-kube-prometheus-stack-alertmanager",
                &[],
                &[("http-web", 9093)],
            ),
            svc(
                "monitoring",
                "kps-prometheus-node-exporter",
                &[],
                &[("http-metrics", 9100)],
            ),
            svc(
                "monitoring",
                "kps-kube-prometheus-stack-operator",
                &[],
                &[("https", 443)],
            ),
            svc("monitoring", "kps-grafana", &[], &[("http-web", 80)]),
            svc(
                "monitoring",
                "kps-kube-prometheus-prometheus",
                &[("app", "kube-prometheus-stack-prometheus")],
                &[("http-web", 9090), ("reloader-web", 8080)],
            ),
            svc(
                "monitoring",
                "prometheus-operated",
                &[("operated-prometheus", "true")],
                &[("web", 9090)],
            ),
            svc(
                "thanos",
                "thanos-query",
                &[],
                &[("grpc", 10901), ("http", 10902)],
            ),
            svc("vm", "vmselect-main", &[], &[("http", 8481)]),
        ];
        let ranked = rank(&services);
        assert_eq!(
            names(&ranked),
            vec![
                "monitoring/prometheus-operated:9090",
                "monitoring/kps-kube-prometheus-prometheus:9090",
                "thanos/thanos-query:10902",
                "vm/vmselect-main:8481",
            ]
        );
        assert_eq!(ranked[0].service.kind, PrometheusKind::PrometheusOperator);
        assert_eq!(ranked[3].service.path_prefix, "/select/0/prometheus");
        assert_eq!(ranked[2].service.kind, PrometheusKind::Thanos);
    }

    #[test]
    fn community_chart_victoria_mimir_and_openshift() {
        let ranked = rank(&[
            svc(
                "mimir",
                "mimir-query-frontend",
                &[],
                &[("http-metrics", 8080), ("grpc", 9095)],
            ),
            svc("obs", "vmsingle-vm", &[], &[("http", 8429)]),
            svc(
                "openshift-monitoring",
                "thanos-querier",
                &[],
                &[("web", 9091), ("tenancy", 9092)],
            ),
            svc("prometheus", "prometheus-server", &[], &[("http", 80)]),
            svc(
                "prometheus",
                "prometheus-alertmanager",
                &[],
                &[("http", 9093)],
            ),
            svc(
                "prometheus",
                "prometheus-kube-state-metrics",
                &[],
                &[("http", 8080)],
            ),
        ]);
        assert_eq!(
            names(&ranked),
            vec![
                "openshift-monitoring/thanos-querier:9091",
                "prometheus/prometheus-server:80",
                "obs/vmsingle-vm:8429",
                "mimir/mimir-query-frontend:8080",
            ]
        );
        assert_eq!(ranked[0].service.scheme, PromScheme::Https);
        assert_eq!(ranked[3].service.path_prefix, "/prometheus");
    }

    #[test]
    fn labels_identify_renamed_services_and_generic_names_need_9090() {
        let ranked = rank(&[
            svc(
                "tools",
                "metrics",
                &[
                    ("app.kubernetes.io/name", "prometheus"),
                    ("app.kubernetes.io/component", "server"),
                ],
                &[("", 9090)],
            ),
            svc("team", "prometheus", &[], &[("http", 9090)]),
            svc("team", "my-prometheus", &[], &[("http", 8080)]),
        ]);
        assert_eq!(
            names(&ranked),
            vec!["tools/metrics:9090", "team/prometheus:9090"]
        );
        // Ties go to conventional namespaces.
        let ranked = rank(&[
            svc("zzz", "prometheus-server", &[], &[("http", 80)]),
            svc("monitoring", "prometheus-server", &[], &[("http", 80)]),
        ]);
        assert_eq!(ranked[0].service.namespace, "monitoring");
        assert!(
            rank(&[svc("a", "prometheus-server", &[], &[])]).is_empty(),
            "no port"
        );
        assert!(rank(&[]).is_empty());
    }

    #[test]
    fn service_info_keeps_tcp_ports() {
        let service: Service = serde_json::from_value(serde_json::json!({
            "metadata": {"name": "prometheus-operated", "namespace": "monitoring",
                         "labels": {"operated-prometheus": "true"}},
            "spec": {"clusterIP": "None", "ports": [
                {"name": "web", "port": 9090},
                {"name": "dns", "port": 53, "protocol": "UDP"}
            ]}
        }))
        .unwrap();
        let info = ServiceInfo::from_service(&service).unwrap();
        assert_eq!(info.ports, vec![(Some("web".to_string()), 9090)]);
        assert_eq!(info.label("operated-prometheus"), "true");
    }
}
