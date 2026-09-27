//! Logs & debug: merged workload logs, log export, ephemeral debug
//! containers and the container file browser.

use kubepit_core::types::{
    PodDebugRequest, PodDirListing, PodFileContent, PodFsTransfer, WorkloadLogBatch,
    WorkloadLogOptions,
};
use tauri::ipc::Channel;
use tauri::State;

use super::{blocking, ipc_err, IpcResult};
use crate::AppState;

/// Streams batches on `on_event`; the last batch has `done: true`.
#[tauri::command]
pub async fn workload_logs_stream(
    cluster_id: String,
    namespace: String,
    selector: String,
    options: WorkloadLogOptions,
    on_event: Channel<WorkloadLogBatch>,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    core.workload_logs_stream(&cluster_id, &namespace, &selector, options, move |batch| {
        on_event.send(batch).is_ok()
    })
    .await
    .map_err(ipc_err)
}

#[tauri::command]
pub async fn workload_logs_stop(stream_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.workload_logs_stop(&stream_id);
    Ok(())
}

/// Write `contents` to a path the user picked in a save dialog (log export).
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> IpcResult<()> {
    blocking(move || {
        let target = kubepit_core::paths::expand_tilde(&path);
        std::fs::write(&target, contents)
            .map_err(|e| anyhow::anyhow!("cannot write {}: {e}", target.display()))
    })
    .await
}

/// Adds an ephemeral debug container and resolves to its name once it runs.
#[tauri::command]
pub async fn pod_debug(
    cluster_id: String,
    namespace: String,
    pod: String,
    request: PodDebugRequest,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    core.pod_debug(&cluster_id, &namespace, &pod, request)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn pod_fs_list(
    cluster_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    path: String,
    state: State<'_, AppState>,
) -> IpcResult<PodDirListing> {
    let core = state.core.clone();
    core.pod_fs_list(&cluster_id, &namespace, &pod, container.as_deref(), &path)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn pod_fs_read(
    cluster_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    path: String,
    max_bytes: Option<u64>,
    state: State<'_, AppState>,
) -> IpcResult<PodFileContent> {
    let core = state.core.clone();
    core.pod_fs_read(
        &cluster_id,
        &namespace,
        &pod,
        container.as_deref(),
        &path,
        max_bytes,
    )
    .await
    .map_err(ipc_err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pod_fs_download(
    cluster_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> IpcResult<PodFsTransfer> {
    let core = state.core.clone();
    core.pod_fs_download(
        &cluster_id,
        &namespace,
        &pod,
        container.as_deref(),
        &remote_path,
        &local_path,
    )
    .await
    .map_err(ipc_err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pod_fs_upload(
    cluster_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    local_path: String,
    remote_dir: String,
    state: State<'_, AppState>,
) -> IpcResult<PodFsTransfer> {
    let core = state.core.clone();
    core.pod_fs_upload(
        &cluster_id,
        &namespace,
        &pod,
        container.as_deref(),
        &local_path,
        &remote_dir,
    )
    .await
    .map_err(ipc_err)
}
