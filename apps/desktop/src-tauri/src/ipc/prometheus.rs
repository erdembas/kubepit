//! Prometheus metrics: detection status, preset series, ad-hoc PromQL.
//! All read-only (GETs through the API server's service proxy).

use kubepit_core::types::{
    PromQueryResult, PrometheusMetric, PrometheusMetricsResult, PrometheusPvcUsageResult,
    PrometheusRange, PrometheusStatus, PrometheusTarget,
};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn prometheus_status(
    cluster_id: String,
    refresh: bool,
    state: State<'_, AppState>,
) -> IpcResult<PrometheusStatus> {
    let core = state.core.clone();
    core.prometheus_status(&cluster_id, refresh)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn prometheus_metrics(
    cluster_id: String,
    target: PrometheusTarget,
    metrics: Vec<PrometheusMetric>,
    range: PrometheusRange,
    state: State<'_, AppState>,
) -> IpcResult<PrometheusMetricsResult> {
    let core = state.core.clone();
    core.prometheus_metrics(&cluster_id, &target, &metrics, &range)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn prometheus_query_range(
    cluster_id: String,
    query: String,
    range: PrometheusRange,
    state: State<'_, AppState>,
) -> IpcResult<PromQueryResult> {
    let core = state.core.clone();
    core.prometheus_query_range(&cluster_id, &query, &range)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn prometheus_pvc_usage(
    cluster_id: String,
    state: State<'_, AppState>,
) -> IpcResult<PrometheusPvcUsageResult> {
    let core = state.core.clone();
    core.prometheus_pvc_usage(&cluster_id)
        .await
        .map_err(ipc_err)
}
