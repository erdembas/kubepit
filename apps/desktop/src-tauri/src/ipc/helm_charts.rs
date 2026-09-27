//! Helm charts: repositories, catalog, chart details, install / upgrade and
//! stored revisions. Repository and catalog commands are local (the user's
//! helm configuration); `helm_hub_search` queries artifacthub.io.

use kubepit_core::types::{
    HelmChartDetail, HelmChartSummary, HelmChartVersion, HelmHubChart, HelmInstallRequest,
    HelmInstallResult, HelmRepo, HelmRepoAddOptions, HelmRepoUpdateResult, HelmRevisionDetail,
    HelmSearchOptions, HelmUpgradeRequest,
};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn helm_repo_list(state: State<'_, AppState>) -> IpcResult<Vec<HelmRepo>> {
    let core = state.core.clone();
    core.helm_repo_list().await.map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_repo_add(
    name: String,
    url: String,
    options: HelmRepoAddOptions,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.helm_repo_add(&name, &url, &options)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_repo_remove(name: String, state: State<'_, AppState>) -> IpcResult<()> {
    let core = state.core.clone();
    core.helm_repo_remove(&name).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_repo_update(
    names: Vec<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<HelmRepoUpdateResult>> {
    let core = state.core.clone();
    core.helm_repo_update(&names).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_chart_search(
    query: String,
    options: HelmSearchOptions,
    state: State<'_, AppState>,
) -> IpcResult<Vec<HelmChartSummary>> {
    let core = state.core.clone();
    core.helm_chart_search(&query, options)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_chart_versions(
    chart_ref: String,
    state: State<'_, AppState>,
) -> IpcResult<Vec<HelmChartVersion>> {
    let core = state.core.clone();
    core.helm_chart_versions(&chart_ref).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_hub_search(
    query: String,
    state: State<'_, AppState>,
) -> IpcResult<Vec<HelmHubChart>> {
    let core = state.core.clone();
    core.helm_hub_search(&query).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_chart_show(
    chart_ref: String,
    version: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<HelmChartDetail> {
    let core = state.core.clone();
    core.helm_chart_show(&chart_ref, version.as_deref())
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_install(
    cluster_id: String,
    request: HelmInstallRequest,
    state: State<'_, AppState>,
) -> IpcResult<HelmInstallResult> {
    let core = state.core.clone();
    core.helm_install(&cluster_id, &request)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_upgrade(
    cluster_id: String,
    namespace: String,
    name: String,
    request: HelmUpgradeRequest,
    state: State<'_, AppState>,
) -> IpcResult<HelmInstallResult> {
    let core = state.core.clone();
    core.helm_upgrade(&cluster_id, &namespace, &name, &request)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn helm_release_revision(
    cluster_id: String,
    namespace: String,
    name: String,
    revision: i64,
    state: State<'_, AppState>,
) -> IpcResult<HelmRevisionDetail> {
    let core = state.core.clone();
    core.helm_release_revision(&cluster_id, &namespace, &name, revision)
        .await
        .map_err(ipc_err)
}
