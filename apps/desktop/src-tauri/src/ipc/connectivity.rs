//! Connectivity: saved port forwards, restarts and local port checks,
//! per-cluster proxy info, and where managed kubeconfigs are kept (OS
//! credential store). Saved forwards are also emitted on
//! `portforward://saved`; kubeconfig file changes on `kubeconfig://changed`;
//! a storage switch on `settings://changed`.

use kubepit_core::portforward::local_port_status;
use kubepit_core::types::{
    ClusterProxyInfo, LocalPortStatus, PortForward, SavedPortForward, SavedPortForwardInput,
    Settings,
};
use tauri::State;

use super::{blocking, ipc_err, IpcResult};
use crate::app_state::emit_settings_changed;
use crate::AppState;

#[tauri::command]
pub async fn port_forward_saved_list(
    state: State<'_, AppState>,
) -> IpcResult<Vec<SavedPortForward>> {
    Ok(state.core.port_forward_saved_list())
}

#[tauri::command]
pub async fn port_forward_save(
    input: SavedPortForwardInput,
    state: State<'_, AppState>,
) -> IpcResult<SavedPortForward> {
    let core = state.core.clone();
    blocking(move || core.port_forward_save(input)).await
}

#[tauri::command]
pub async fn port_forward_saved_update(
    saved: SavedPortForward,
    state: State<'_, AppState>,
) -> IpcResult<SavedPortForward> {
    let core = state.core.clone();
    blocking(move || core.port_forward_saved_update(saved)).await
}

#[tauri::command]
pub async fn port_forward_unsave(id: String, state: State<'_, AppState>) -> IpcResult<()> {
    let core = state.core.clone();
    blocking(move || core.port_forward_unsave(&id)).await
}

#[tauri::command]
pub async fn port_forward_saved_start(
    id: String,
    state: State<'_, AppState>,
) -> IpcResult<PortForward> {
    let core = state.core.clone();
    core.port_forward_saved_start(&id).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn port_forward_restart(
    id: String,
    state: State<'_, AppState>,
) -> IpcResult<PortForward> {
    let core = state.core.clone();
    core.port_forward_restart(&id).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn port_forward_local_port(port: u16) -> IpcResult<LocalPortStatus> {
    Ok(local_port_status(port).await)
}

/// May read the OS credential store (keychain mode), hence the blocking pool.
#[tauri::command]
pub async fn cluster_proxy_info(
    id: String,
    state: State<'_, AppState>,
) -> IpcResult<ClusterProxyInfo> {
    let core = state.core.clone();
    blocking(move || core.cluster_proxy_info(&id)).await
}

/// Migrates every managed kubeconfig; the OS may ask to unlock the store.
/// The saved settings go to every window (`settings://changed`).
#[tauri::command]
pub async fn kubeconfig_storage_set(
    keychain: bool,
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> IpcResult<Settings> {
    let core = state.core.clone();
    let saved = blocking(move || core.kubeconfig_storage_set(keychain)).await?;
    emit_settings_changed(&app, window.label(), &saved);
    Ok(saved)
}
