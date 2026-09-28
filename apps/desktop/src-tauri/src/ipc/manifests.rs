//! Local manifests: render folders (plain, Kustomize, Helm), remember recent
//! sources, and diff / apply the rendered documents per cluster.

use kubepit_core::types::{
    DryRunResult, ManifestApplyResult, ManifestRecent, ManifestRender, ManifestSource,
    ManifestsWatchEvent,
};
use tauri::ipc::Channel;
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

/// Local only: watches the source's files and streams a
/// [`ManifestsWatchEvent`] on `on_event` when their fingerprint changes.
/// Resolves to the watch id once the watcher is in place.
#[tauri::command]
pub async fn manifests_watch(
    source: ManifestSource,
    on_event: Channel<ManifestsWatchEvent>,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    blocking(move || core.manifests_watch(&source, move |event| on_event.send(event).is_ok())).await
}

#[tauri::command]
pub async fn manifests_unwatch(watch_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.manifests_unwatch(&watch_id);
    Ok(())
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
