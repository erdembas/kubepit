//! Port forwarding. State changes are also emitted on `portforward://changed`.

use kubepit_core::types::{PortForward, PortForwardRequest};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn port_forward_start(
    request: PortForwardRequest,
    state: State<'_, AppState>,
) -> IpcResult<PortForward> {
    let core = state.core.clone();
    core.port_forward_start(request).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn port_forward_stop(id: String, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.port_forward_stop(&id);
    Ok(())
}

#[tauri::command]
pub async fn port_forward_list(state: State<'_, AppState>) -> IpcResult<Vec<PortForward>> {
    Ok(state.core.port_forward_list())
}
