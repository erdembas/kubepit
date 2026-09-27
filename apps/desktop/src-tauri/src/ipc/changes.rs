//! Change timeline: the in-memory change journal of a connected cluster.

use kubepit_core::change_journal::{ChangeDetail, ChangeFilter, ChangePage};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn changes_list(
    cluster_id: String,
    filter: ChangeFilter,
    state: State<'_, AppState>,
) -> IpcResult<ChangePage> {
    state
        .core
        .changes_list(&cluster_id, &filter)
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn changes_get(
    cluster_id: String,
    id: u64,
    state: State<'_, AppState>,
) -> IpcResult<ChangeDetail> {
    state.core.changes_get(&cluster_id, id).map_err(ipc_err)
}
