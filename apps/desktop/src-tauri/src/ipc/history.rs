//! Persistent history: the own-action audit log and persisted events and
//! changes in `history.db`. SQLite reads run on the blocking pool.

use kubepit_core::change_journal::{ChangeDetail, ChangeFilter};
use kubepit_core::history::{
    AuditDetail, AuditFilter, AuditPage, HistoryChangePage, HistoryEventFilter, HistoryEventPage,
    HistoryKind, HistoryStatus,
};
use tauri::State;

use super::{blocking, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn history_status(state: State<'_, AppState>) -> IpcResult<HistoryStatus> {
    let core = state.core.clone();
    blocking(move || Ok(core.history_status())).await
}

#[tauri::command]
pub async fn history_audit_list(
    filter: AuditFilter,
    state: State<'_, AppState>,
) -> IpcResult<AuditPage> {
    let core = state.core.clone();
    blocking(move || core.history_audit_list(&filter)).await
}

#[tauri::command]
pub async fn history_audit_get(id: i64, state: State<'_, AppState>) -> IpcResult<AuditDetail> {
    let core = state.core.clone();
    blocking(move || core.history_audit_get(id)).await
}

#[tauri::command]
pub async fn history_audit_export(
    filter: AuditFilter,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    blocking(move || core.history_audit_export(&filter)).await
}

#[tauri::command]
pub async fn history_events_list(
    cluster_id: String,
    filter: HistoryEventFilter,
    state: State<'_, AppState>,
) -> IpcResult<HistoryEventPage> {
    let core = state.core.clone();
    blocking(move || core.history_events_list(&cluster_id, &filter)).await
}

#[tauri::command]
pub async fn history_changes_list(
    cluster_id: String,
    filter: ChangeFilter,
    state: State<'_, AppState>,
) -> IpcResult<HistoryChangePage> {
    let core = state.core.clone();
    blocking(move || core.history_changes_list(&cluster_id, &filter)).await
}

#[tauri::command]
pub async fn history_changes_get(
    cluster_id: String,
    id: u64,
    state: State<'_, AppState>,
) -> IpcResult<ChangeDetail> {
    let core = state.core.clone();
    blocking(move || core.history_changes_get(&cluster_id, id)).await
}

#[tauri::command]
pub async fn history_clear(
    kind: HistoryKind,
    cluster_id: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<HistoryStatus> {
    let core = state.core.clone();
    blocking(move || core.history_clear(kind, cluster_id.as_deref())).await
}
