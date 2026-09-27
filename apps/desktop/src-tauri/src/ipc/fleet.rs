//! Fleet: metrics history and fleet-wide search.

use std::collections::HashMap;

use kubepit_core::types::{FleetSearchEvent, FleetSearchQuery, MetricsHistoryQuery, MetricsSeries};
use tauri::ipc::Channel;
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn metrics_history(
    cluster_id: String,
    query: MetricsHistoryQuery,
    state: State<'_, AppState>,
) -> IpcResult<MetricsSeries> {
    state
        .core
        .metrics_history(&cluster_id, &query)
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn metrics_history_fleet(
    state: State<'_, AppState>,
) -> IpcResult<HashMap<String, MetricsSeries>> {
    Ok(state.core.metrics_history_fleet())
}

/// Streams results on `on_event`; resolves to the search id right away.
#[tauri::command]
pub async fn fleet_search(
    query: FleetSearchQuery,
    on_event: Channel<FleetSearchEvent>,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    state
        .core
        .fleet_search(query, move |event| on_event.send(event).is_ok())
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn fleet_search_cancel(search_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.fleet_search_cancel(&search_id);
    Ok(())
}
