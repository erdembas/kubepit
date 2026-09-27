//! metrics-server usage.

use kubepit_core::types::{MetricsResult, NodeMetric, PodMetric};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn metrics_nodes(
    cluster_id: String,
    state: State<'_, AppState>,
) -> IpcResult<MetricsResult<NodeMetric>> {
    let core = state.core.clone();
    core.metrics_nodes(&cluster_id).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn metrics_pods(
    cluster_id: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<MetricsResult<PodMetric>> {
    let core = state.core.clone();
    core.metrics_pods(&cluster_id, namespace.as_deref())
        .await
        .map_err(ipc_err)
}
