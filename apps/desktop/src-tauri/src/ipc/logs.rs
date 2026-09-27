//! Pod log streaming.

use kubepit_core::types::{LogChunk, LogOptions};
use tauri::ipc::Channel;
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

/// Streams log chunks on `on_chunk`; the last chunk has `done: true`.
#[tauri::command]
pub async fn pod_logs_stream(
    cluster_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    options: LogOptions,
    on_chunk: Channel<LogChunk>,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    core.pod_logs_stream(
        &cluster_id,
        &namespace,
        &pod,
        container,
        options,
        move |chunk| on_chunk.send(chunk).is_ok(),
    )
    .await
    .map_err(ipc_err)
}

#[tauri::command]
pub async fn pod_logs_stop(stream_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.pod_logs_stop(&stream_id);
    Ok(())
}
