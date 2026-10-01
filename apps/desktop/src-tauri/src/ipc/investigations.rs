//! Local investigations: only capture reads Kubernetes. Every other command
//! works offline and performs bounded local I/O on the blocking pool.

use super::{blocking, IpcResult};
use crate::AppState;
use kubepit_core::investigations::{
    Investigation, InvestigationCaptureRequest, InvestigationSummary,
};
use tauri::State;

#[tauri::command]
pub async fn investigations_list(
    cluster_id: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<InvestigationSummary>> {
    let core = state.core.clone();
    blocking(move || core.investigations_list(cluster_id.as_deref())).await
}

#[tauri::command]
pub async fn investigation_get(id: String, state: State<'_, AppState>) -> IpcResult<Investigation> {
    let core = state.core.clone();
    blocking(move || core.investigation_get(&id)).await
}

#[tauri::command]
pub async fn investigation_capture(
    cluster_id: String,
    request: InvestigationCaptureRequest,
    state: State<'_, AppState>,
) -> IpcResult<Investigation> {
    let core = state.core.clone();
    let runtime = tauri::async_runtime::handle();
    // Capture awaits bounded Kubernetes reads and then redacts/atomically
    // writes the local store. Keep the filesystem work off the IPC executor.
    blocking(move || runtime.block_on(core.investigation_capture(&cluster_id, request))).await
}

#[tauri::command]
pub async fn investigation_update(
    id: String,
    title: String,
    notes: String,
    state: State<'_, AppState>,
) -> IpcResult<Investigation> {
    let core = state.core.clone();
    blocking(move || core.investigation_update(&id, &title, &notes)).await
}

#[tauri::command]
pub async fn investigation_delete(id: String, state: State<'_, AppState>) -> IpcResult<()> {
    let core = state.core.clone();
    blocking(move || core.investigation_delete(&id)).await
}

#[tauri::command]
pub async fn investigation_export(
    id: String,
    evidence_ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    blocking(move || core.investigation_export(&id, evidence_ids.as_deref())).await
}

#[tauri::command]
pub async fn investigation_import(
    bundle: String,
    state: State<'_, AppState>,
) -> IpcResult<Investigation> {
    let core = state.core.clone();
    blocking(move || core.investigation_import(&bundle)).await
}
