use kubepit_core::network_diagnostics::{NetworkDiagnosticsReport, NetworkDiagnosticsRequest};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn network_diagnostics_run(
    cluster_id: String,
    request: NetworkDiagnosticsRequest,
    state: State<'_, AppState>,
) -> IpcResult<NetworkDiagnosticsReport> {
    state
        .core
        .network_diagnostics_run(&cluster_id, &request)
        .await
        .map_err(ipc_err)
}
