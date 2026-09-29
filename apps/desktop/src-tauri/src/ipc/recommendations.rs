//! Recommendations: stored, scheduled right-sizing scans. Everything here
//! only reads the cluster (a scan lists workloads and queries Prometheus
//! through the service proxy) or local state (`history.db`, settings);
//! applying a recommendation stays the audited `rightsizing_apply`.
//! SQLite reads run on the blocking pool.

use kubepit_core::prometheus::usage_history::WorkloadUsageHistory;
use kubepit_core::recommendations::{
    ClusterRecommendationSummary, RecommendationExportFormat, RecommendationLatest,
    RecommendationRun, RecommendationScanStatus, RecommendationTrendPoint,
};
use kubepit_core::rightsizing::WorkloadRef;
use tauri::State;

use super::{blocking, ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn recommendations_status(
    cluster_id: String,
    state: State<'_, AppState>,
) -> IpcResult<RecommendationScanStatus> {
    let core = state.core.clone();
    blocking(move || Ok(core.recommendations_status(&cluster_id))).await
}

/// "Scan now": queued in the background; progress arrives as
/// `recommendations://scan`.
#[tauri::command]
pub async fn recommendations_scan(
    cluster_id: String,
    state: State<'_, AppState>,
) -> IpcResult<RecommendationScanStatus> {
    let core = state.core.clone();
    core.recommendations_scan(&cluster_id)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn recommendations_latest(
    cluster_id: String,
    run_id: Option<i64>,
    state: State<'_, AppState>,
) -> IpcResult<RecommendationLatest> {
    let core = state.core.clone();
    blocking(move || core.recommendations_latest(&cluster_id, run_id)).await
}

#[tauri::command]
pub async fn recommendations_runs(
    cluster_id: String,
    limit: u32,
    state: State<'_, AppState>,
) -> IpcResult<Vec<RecommendationRun>> {
    let core = state.core.clone();
    blocking(move || core.recommendations_runs(&cluster_id, limit)).await
}

#[tauri::command]
pub async fn recommendations_trend(
    cluster_id: String,
    workload: WorkloadRef,
    state: State<'_, AppState>,
) -> IpcResult<Vec<RecommendationTrendPoint>> {
    let core = state.core.clone();
    blocking(move || core.recommendations_trend(&cluster_id, &workload)).await
}

/// Range queries for the usage charts of one container (Prometheus only).
#[tauri::command]
pub async fn recommendations_usage_history(
    cluster_id: String,
    workload: WorkloadRef,
    container: String,
    pods: Vec<String>,
    days: Option<u32>,
    state: State<'_, AppState>,
) -> IpcResult<WorkloadUsageHistory> {
    let core = state.core.clone();
    core.recommendations_usage_history(&cluster_id, &workload, &container, &pods, days)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn recommendations_fleet(
    state: State<'_, AppState>,
) -> IpcResult<Vec<ClusterRecommendationSummary>> {
    let core = state.core.clone();
    blocking(move || core.recommendations_fleet()).await
}

#[tauri::command]
pub async fn recommendations_export(
    cluster_id: String,
    run_id: Option<i64>,
    workloads: Vec<WorkloadRef>,
    format: RecommendationExportFormat,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    blocking(move || core.recommendations_export(&cluster_id, run_id, &workloads, format)).await
}
