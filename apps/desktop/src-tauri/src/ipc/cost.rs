//! Cost insight and right-sizing: cost source status, cost reports and
//! request recommendations (read-only), and applying a recommendation
//! (dry run allowed on read-only clusters, apply refused there).

use kubepit_core::cost::{CostQuery, CostReport, CostStatus, CostSummary};
use kubepit_core::rightsizing::{
    ContainerResourceChange, RightsizingReport, RightsizingRequest, WorkloadRef,
};
use kubepit_core::types::DryRunResult;
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn cost_status(
    cluster_id: String,
    refresh: bool,
    state: State<'_, AppState>,
) -> IpcResult<CostStatus> {
    let core = state.core.clone();
    core.cost_status(&cluster_id, refresh)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn cost_report(
    cluster_id: String,
    query: CostQuery,
    state: State<'_, AppState>,
) -> IpcResult<CostReport> {
    let core = state.core.clone();
    core.cost_report(&cluster_id, &query).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn cost_summary(
    cluster_id: String,
    state: State<'_, AppState>,
) -> IpcResult<CostSummary> {
    let core = state.core.clone();
    core.cost_summary(&cluster_id).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn rightsizing_report(
    cluster_id: String,
    request: RightsizingRequest,
    state: State<'_, AppState>,
) -> IpcResult<RightsizingReport> {
    let core = state.core.clone();
    core.rightsizing_report(&cluster_id, &request)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn rightsizing_apply(
    cluster_id: String,
    target: WorkloadRef,
    changes: Vec<ContainerResourceChange>,
    dry_run: bool,
    state: State<'_, AppState>,
) -> IpcResult<DryRunResult> {
    let core = state.core.clone();
    core.rightsizing_apply(&cluster_id, &target, &changes, dry_run)
        .await
        .map_err(ipc_err)
}
