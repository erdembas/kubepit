//! Kubeconfig discovery, cluster registry, connections, discovery, overview.

use std::collections::HashMap;
use std::path::PathBuf;

use kubepit_core::kubeconfig;
use kubepit_core::types::{
    ApiResourceInfo, ClusterDef, ClusterInput, ClusterOverview, ClusterStatus, KubeconfigSource,
};
use tauri::State;

use super::{blocking, ipc_err, IpcResult};
use crate::AppState;

// -- Kubeconfig discovery ----------------------------------------------------

#[tauri::command]
pub async fn kubeconfig_discover(state: State<'_, AppState>) -> IpcResult<Vec<KubeconfigSource>> {
    let sync_paths = state.core.settings().kubeconfig_sync_paths;
    blocking(move || Ok(kubeconfig::discover(&sync_paths))).await
}

#[tauri::command]
pub async fn kubeconfig_parse_file(path: String) -> IpcResult<KubeconfigSource> {
    blocking(move || {
        let path: PathBuf = kubepit_core::paths::expand_tilde(&path);
        Ok(kubeconfig::parse_file(&path))
    })
    .await
}

#[tauri::command]
pub async fn kubeconfig_parse_text(text: String) -> IpcResult<KubeconfigSource> {
    blocking(move || Ok(kubeconfig::parse_text(&text))).await
}

// -- Registry -------------------------------------------------------------------

#[tauri::command]
pub async fn cluster_list(state: State<'_, AppState>) -> IpcResult<Vec<ClusterDef>> {
    Ok(state.core.cluster_list())
}

#[tauri::command]
pub async fn cluster_add(
    inputs: Vec<ClusterInput>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<ClusterDef>> {
    let core = state.core.clone();
    blocking(move || core.cluster_add(inputs)).await
}

#[tauri::command]
pub async fn cluster_update(
    cluster: ClusterDef,
    state: State<'_, AppState>,
) -> IpcResult<ClusterDef> {
    let core = state.core.clone();
    blocking(move || core.cluster_update(cluster)).await
}

#[tauri::command]
pub async fn cluster_remove(id: String, state: State<'_, AppState>) -> IpcResult<()> {
    let core = state.core.clone();
    core.cluster_remove(&id).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn cluster_export_kubeconfig(
    id: String,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    blocking(move || core.cluster_export_kubeconfig(&id)).await
}

// -- Connections ----------------------------------------------------------------

/// A failed connect resolves with `state: "error"` (also emitted on
/// `cluster://status`) rather than rejecting.
#[tauri::command]
pub async fn cluster_connect(id: String, state: State<'_, AppState>) -> IpcResult<ClusterStatus> {
    let core = state.core.clone();
    core.cluster_connect(&id).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn cluster_disconnect(id: String, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.cluster_disconnect(&id);
    Ok(())
}

#[tauri::command]
pub async fn cluster_statuses(
    state: State<'_, AppState>,
) -> IpcResult<HashMap<String, ClusterStatus>> {
    Ok(state.core.cluster_statuses())
}

#[tauri::command]
pub async fn cluster_overview(
    cluster_id: String,
    state: State<'_, AppState>,
) -> IpcResult<ClusterOverview> {
    let core = state.core.clone();
    core.cluster_overview(&cluster_id).await.map_err(ipc_err)
}

// -- Discovery ------------------------------------------------------------------

#[tauri::command]
pub async fn api_resources(
    cluster_id: String,
    state: State<'_, AppState>,
) -> IpcResult<Vec<ApiResourceInfo>> {
    let core = state.core.clone();
    core.api_resources(&cluster_id).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn namespace_names(
    cluster_id: String,
    state: State<'_, AppState>,
) -> IpcResult<Vec<String>> {
    let core = state.core.clone();
    core.namespace_names(&cluster_id).await.map_err(ipc_err)
}
