use super::{ipc_err, IpcResult};
use crate::AppState;
use kubepit_core::nodes::{
    NodeMaintenanceDrainRequest, NodeMaintenancePlan, NodeMaintenanceProgress,
    NodeMaintenanceReceipt,
};
use tauri::State;

#[tauri::command]
pub async fn node_maintenance_preflight(
    cluster_id: String,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<NodeMaintenancePlan> {
    state
        .core
        .node_maintenance_preflight(&cluster_id, &name)
        .await
        .map_err(ipc_err)
}
#[tauri::command]
pub async fn node_maintenance_drain(
    cluster_id: String,
    request: NodeMaintenanceDrainRequest,
    state: State<'_, AppState>,
) -> IpcResult<NodeMaintenanceReceipt> {
    state
        .core
        .node_maintenance_drain(&cluster_id, &request)
        .await
        .map_err(ipc_err)
}
#[tauri::command]
pub async fn node_maintenance_progress(
    cluster_id: String,
    plan_id: String,
    state: State<'_, AppState>,
) -> IpcResult<NodeMaintenanceProgress> {
    state
        .core
        .node_maintenance_progress(&cluster_id, &plan_id)
        .await
        .map_err(ipc_err)
}
