use super::{ipc_err, IpcResult};
use crate::AppState;
use kubepit_core::namespace_cleanup::{
    NamespaceCleanupPlan, NamespaceCleanupRequest, NamespaceCleanupResult,
};
use tauri::State;

#[tauri::command]
pub async fn namespace_cleanup_preview(
    cluster_id: String,
    namespace: String,
    state: State<'_, AppState>,
) -> IpcResult<NamespaceCleanupPlan> {
    state
        .core
        .namespace_cleanup_preview(&cluster_id, &namespace)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn namespace_cleanup_run(
    cluster_id: String,
    request: NamespaceCleanupRequest,
    state: State<'_, AppState>,
) -> IpcResult<NamespaceCleanupResult> {
    state
        .core
        .namespace_cleanup_run(&cluster_id, &request)
        .await
        .map_err(ipc_err)
}
