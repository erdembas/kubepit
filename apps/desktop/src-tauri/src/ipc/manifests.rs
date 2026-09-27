//! Local manifests: render folders (plain, Kustomize, Helm), remember recent
//! sources, and diff / apply the rendered documents per cluster.

use kubepit_core::types::{
    DryRunResult, ManifestApplyResult, ManifestRecent, ManifestRender, ManifestSource,
};
use tauri::State;

use super::{blocking, ipc_err, IpcResult};
use crate::AppState;

/// Local only: reads files or runs `kubectl kustomize` / `helm template`.
#[tauri::command]
pub async fn manifests_render(
    source: ManifestSource,
    state: State<'_, AppState>,
) -> IpcResult<ManifestRender> {
    let core = state.core.clone();
    core.manifests_render(&source).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn manifests_fingerprint(
    source: ManifestSource,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    blocking(move || core.manifests_fingerprint(&source)).await
}

#[tauri::command]
pub async fn manifests_recent_list(state: State<'_, AppState>) -> IpcResult<Vec<ManifestRecent>> {
    let core = state.core.clone();
    blocking(move || Ok(core.manifests_recent_list())).await
}

#[tauri::command]
pub async fn manifests_recent_remove(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<ManifestRecent>> {
    let core = state.core.clone();
    blocking(move || core.manifests_recent_remove(&paths)).await
}

/// Allowed on read-only clusters: a dry run never persists anything.
#[tauri::command]
pub async fn manifests_dry_run(
    cluster_id: String,
    documents: Vec<String>,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<DryRunResult>> {
    let core = state.core.clone();
    core.manifests_dry_run(&cluster_id, &documents, namespace.as_deref())
        .await
        .map_err(ipc_err)
}

/// Refused on read-only clusters.
#[tauri::command]
pub async fn manifests_apply(
    cluster_id: String,
    documents: Vec<String>,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<ManifestApplyResult>> {
    let core = state.core.clone();
    core.manifests_apply(&cluster_id, &documents, namespace.as_deref())
        .await
        .map_err(ipc_err)
}
