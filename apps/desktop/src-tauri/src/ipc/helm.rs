//! Helm releases (read natively, mutations through the helm CLI).

use kubepit_core::types::{HelmRelease, HelmReleaseDetail};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn helm_releases(
    cluster_id: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<HelmRelease>> {
    let core = state.core.clone();
    core.helm_releases(&cluster_id, namespace.as_deref())
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_release_detail(
    cluster_id: String,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<HelmReleaseDetail> {
    let core = state.core.clone();
    core.helm_release_detail(&cluster_id, &namespace, &name)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_rollback(
    cluster_id: String,
    namespace: String,
    name: String,
    revision: i64,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.helm_rollback(&cluster_id, &namespace, &name, revision)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_uninstall(
    cluster_id: String,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.helm_uninstall(&cluster_id, &namespace, &name)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_upgrade_values(
    cluster_id: String,
    namespace: String,
    name: String,
    values: String,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.helm_upgrade_values(&cluster_id, &namespace, &name, &values)
        .await
        .map_err(ipc_err)
}
