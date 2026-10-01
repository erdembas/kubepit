use kubepit_core::connection_doctor::ConnectionDoctorReport;
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

/// Read-only probes and access self-reviews; no pooled connection is created.
#[tauri::command]
pub async fn connection_doctor_run(
    cluster_id: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<ConnectionDoctorReport> {
    state
        .core
        .connection_doctor_run(&cluster_id, namespace.as_deref())
        .await
        .map_err(ipc_err)
}
