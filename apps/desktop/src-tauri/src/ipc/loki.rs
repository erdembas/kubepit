//! Loki historical logs: detection status, LogQL range queries, labels and
//! label values for the query builder. All read-only (GETs through the API
//! server's service proxy).

use kubepit_core::types::{LokiQuery, LokiQueryResult, LokiStatus};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn loki_status(
    cluster_id: String,
    refresh: bool,
    state: State<'_, AppState>,
) -> IpcResult<LokiStatus> {
    let core = state.core.clone();
    core.loki_status(&cluster_id, refresh)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn loki_query_range(
    cluster_id: String,
    query: LokiQuery,
    state: State<'_, AppState>,
) -> IpcResult<LokiQueryResult> {
    let core = state.core.clone();
    core.loki_query_range(&cluster_id, &query)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn loki_labels(
    cluster_id: String,
    start: String,
    end: String,
    query: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<String>> {
    let core = state.core.clone();
    core.loki_labels(&cluster_id, &start, &end, query.as_deref())
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn loki_label_values(
    cluster_id: String,
    label: String,
    start: String,
    end: String,
    query: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<String>> {
    let core = state.core.clone();
    core.loki_label_values(&cluster_id, &label, &start, &end, query.as_deref())
        .await
        .map_err(ipc_err)
}
