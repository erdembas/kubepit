//! Requests to OpenCost / Kubecost through the API server's service proxy.
//!
//! Paths are built with the Prometheus transport's public helpers
//! ([`crate::prometheus::proxy::proxy_path`]) — a cost service is addressed
//! exactly like a Prometheus one — but the answers are plain JSON instead of
//! the Prometheus envelope, so the GET lives here. Like the Prometheus
//! transport it uses a client without kube's default retry policy: through
//! the proxy a 503 ("no endpoints available") is an answer, not a reason to
//! back off for minutes.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use kube::client::Body;
use kube::config::KubeConfigOptions;
use kube::Client;
use serde_json::Value;

use super::types::{CostApiKind, CostService};
use crate::error::kube_error;
use crate::kubeconfig;
use crate::prometheus::proxy::{http_error, proxy_path};
use crate::types::{ClusterDef, PrometheusKind, PrometheusService};

/// Upper bound for one allocation query (30-day windows can be slow).
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(45);
/// Upper bound for the detection probe of one candidate.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// The service as the Prometheus transport addresses it.
fn as_proxy_service(service: &CostService) -> PrometheusService {
    PrometheusService {
        kind: PrometheusKind::Custom,
        namespace: service.namespace.clone(),
        service: service.service.clone(),
        port: service.port,
        scheme: service.scheme,
        path_prefix: service.path_prefix.clone(),
    }
}

/// The allocation endpoint of the product.
pub fn allocation_endpoint(kind: CostApiKind) -> &'static str {
    match kind {
        CostApiKind::Opencost => "/allocation/compute",
        CostApiKind::Kubecost => "/model/allocation",
    }
}

/// Full proxy path of an allocation query with `params`.
pub fn allocation_path(service: &CostService, params: &[(&str, String)]) -> String {
    proxy_path(
        &as_proxy_service(service),
        allocation_endpoint(service.kind),
        params,
    )
}

/// A client for `cluster` like the pool's, without the default retry policy.
pub async fn proxy_client(cluster: &ClusterDef) -> Result<Client> {
    let path = Path::new(&cluster.kubeconfig_path);
    let kc = kubeconfig::load(path)
        .with_context(|| format!("failed to read kubeconfig {}", path.display()))?;
    let single = kubeconfig::single_context(&kc, &cluster.context)?;
    let options = KubeConfigOptions {
        context: Some(cluster.context.clone()),
        ..Default::default()
    };
    let mut config = kube::Config::from_custom_kubeconfig(single, &options)
        .await
        .map_err(|e| {
            anyhow!(
                "invalid kubeconfig for context \"{}\": {e}",
                cluster.context
            )
        })?;
    config.default_retry = false;
    Client::try_from(config).map_err(kube_error)
}

/// GET `path` and parse the JSON body. Non-2xx answers become an
/// [`crate::error::ApiError`] with the most useful message.
pub async fn get_json(client: &Client, path: &str, timeout: Duration) -> Result<Value> {
    let request = http::Request::get(path)
        .header(http::header::ACCEPT, "application/json")
        .body(Body::from(Vec::new()))
        .map_err(|e| anyhow!("invalid cost API request: {e}"))?;
    let exchange = async {
        let response = client.send(request).await?;
        let status = response.status();
        let bytes = response.into_body().collect_bytes().await?;
        Ok::<_, kube::Error>((status, bytes))
    };
    let (status, bytes) = tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| anyhow!("the cost API did not answer within {}s", timeout.as_secs()))?
        .map_err(|e| anyhow!("request to the cost API failed: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    if !status.is_success() {
        return Err(http_error(status.as_u16(), &text).into());
    }
    serde_json::from_str(&text)
        .map_err(|_| anyhow!("the service did not answer like a cost allocation API"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PromScheme;

    #[test]
    fn allocation_paths_go_through_the_service_proxy() {
        let open = CostService {
            kind: CostApiKind::Opencost,
            namespace: "opencost".into(),
            service: "opencost".into(),
            port: 9003,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        assert_eq!(
            allocation_path(
                &open,
                &[("window", "7d".into()), ("aggregate", "namespace".into())]
            ),
            "/api/v1/namespaces/opencost/services/http:opencost:9003/proxy/allocation/compute\
             ?window=7d&aggregate=namespace"
        );
        let kube = CostService {
            kind: CostApiKind::Kubecost,
            namespace: "kubecost".into(),
            service: "kubecost-cost-analyzer".into(),
            port: 9090,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        assert_eq!(
            allocation_path(&kube, &[("aggregate", "label:team".into())]),
            "/api/v1/namespaces/kubecost/services/http:kubecost-cost-analyzer:9090/proxy\
             /model/allocation?aggregate=label%3Ateam"
        );
    }
}
