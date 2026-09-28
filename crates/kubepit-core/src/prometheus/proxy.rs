//! Requests to a Prometheus API through the API server's service proxy:
//!
//! ```text
//! /api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy{prefix}/api/v1/query_range?…
//! ```
//!
//! The cluster's own `kube::Client` sends them, so no port-forward is
//! needed, credentials never leave the kubeconfig and RBAC applies (the
//! user needs `get` on `services/proxy`). The transport is shared with the
//! other in-cluster integrations ([`crate::service_proxy`]); this file adds
//! the Prometheus envelope and error bodies.

use std::time::Duration;

use anyhow::Result;
use kube::Client;

use super::parse::{error_message, parse_response, PromData};
use crate::error::ApiError;
use crate::service_proxy::{self, Endpoint};
use crate::types::PrometheusService;

pub use crate::service_proxy::{encode_component, PROXY_REASON};

/// Upper bound for one range query.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
/// Upper bound for the detection probe of one candidate.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
/// `ApiError::reason` of errors Prometheus itself returned (bad query, …).
pub const PROMETHEUS_REASON: &str = "Prometheus";

impl PrometheusService {
    /// Where the service proxy sends requests for this service.
    pub fn endpoint(&self) -> Endpoint<'_> {
        Endpoint {
            namespace: &self.namespace,
            service: &self.service,
            port: self.port,
            scheme: self.scheme,
            path_prefix: &self.path_prefix,
        }
    }
}

/// `/api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy{prefix}`.
pub fn proxy_base(service: &PrometheusService) -> String {
    service_proxy::proxy_base(&service.endpoint())
}

/// Full request path of `endpoint` (`/api/v1/query_range`) with `params`.
pub fn proxy_path(
    service: &PrometheusService,
    endpoint: &str,
    params: &[(&str, String)],
) -> String {
    service_proxy::proxy_path(&service.endpoint(), endpoint, params)
}

/// GET `path` with extra `headers` (the tenant) and parse the Prometheus
/// envelope. Non-2xx answers become an [`ApiError`] carrying the status
/// code and the most useful message: the Prometheus error, the API server's
/// `Status` message, or the body.
pub async fn get(
    client: &Client,
    path: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<PromData> {
    let response = service_proxy::get(client, path, headers, timeout, "Prometheus").await?;
    if response.is_success() {
        return parse_response(&response.body);
    }
    Err(http_error(response.status, &response.body).into())
}

/// The error of a non-2xx answer.
pub fn http_error(code: u16, body: &str) -> ApiError {
    if let Some(message) = error_message(body) {
        return ApiError {
            code,
            reason: PROMETHEUS_REASON.to_string(),
            message,
        };
    }
    service_proxy::proxy_error(code, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service_proxy::MAX_ERROR_BODY;
    use crate::types::{PromScheme, PrometheusKind};

    fn service(scheme: PromScheme, prefix: &str) -> PrometheusService {
        PrometheusService {
            kind: PrometheusKind::Prometheus,
            namespace: "monitoring".into(),
            service: "prometheus-server".into(),
            port: 80,
            scheme,
            path_prefix: prefix.into(),
        }
    }

    #[test]
    fn proxy_paths_follow_the_service_proxy_scheme() {
        assert_eq!(
            proxy_base(&service(PromScheme::Http, "")),
            "/api/v1/namespaces/monitoring/services/http:prometheus-server:80/proxy"
        );
        assert_eq!(
            proxy_base(&service(PromScheme::Https, "/select/0/prometheus/")),
            "/api/v1/namespaces/monitoring/services/https:prometheus-server:80/proxy/select/0/prometheus"
        );
        let path = proxy_path(
            &service(PromScheme::Http, "/prometheus"),
            "/api/v1/query_range",
            &[
                (
                    "query",
                    r#"sum(rate(x{pod=~"a|b"}[2m])) * 1000"#.to_string(),
                ),
                ("start", "1700000000".to_string()),
                ("step", "15".to_string()),
            ],
        );
        assert_eq!(
            path,
            "/api/v1/namespaces/monitoring/services/http:prometheus-server:80/proxy/prometheus\
             /api/v1/query_range?query=sum%28rate%28x%7Bpod%3D~%22a%7Cb%22%7D%5B2m%5D%29%29%20%2A%201000\
             &start=1700000000&step=15"
        );
        assert_eq!(
            proxy_path(&service(PromScheme::Http, ""), "/api/v1/query", &[]),
            "/api/v1/namespaces/monitoring/services/http:prometheus-server:80/proxy/api/v1/query"
        );
    }

    #[test]
    fn encoding_keeps_unreserved_and_escapes_utf8() {
        assert_eq!(encode_component("a-Z_0.9~"), "a-Z_0.9~");
        assert_eq!(encode_component("a b&c=d/e"), "a%20b%26c%3Dd%2Fe");
        assert_eq!(encode_component("ç"), "%C3%A7");
    }

    #[test]
    fn http_errors_prefer_prometheus_then_status_messages() {
        let prom = http_error(
            400,
            r#"{"status":"error","errorType":"bad_data","error":"parse error"}"#,
        );
        assert_eq!(prom.code, 400);
        assert_eq!(prom.message, "bad_data: parse error");

        let status = http_error(
            503,
            r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"no endpoints available for service \"prometheus-server\"","code":503}"#,
        );
        assert_eq!(
            status.message,
            "no endpoints available for service \"prometheus-server\""
        );
        let forbidden = http_error(
            403,
            r#"{"kind":"Status","message":"services \"x:9090\" is forbidden: User \"dev\" cannot get resource \"services/proxy\"","code":403}"#,
        );
        assert!(forbidden.message.contains("services/proxy"));

        assert_eq!(http_error(502, "").message, "HTTP 502");
        let long = "x".repeat(1000);
        assert_eq!(
            http_error(500, &long).message.len(),
            "HTTP 500: ".len() + MAX_ERROR_BODY
        );
    }
}
