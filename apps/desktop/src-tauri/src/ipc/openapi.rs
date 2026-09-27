//! OpenAPI v3 schemas for schema-aware YAML editing and the API explorer.
//! Read-only, so they also work on clusters marked read-only.

use kubepit_core::openapi::OpenApiIndex;
use serde_json::Value;
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

/// `/openapi/v3`, cached per connection; `refresh` re-reads it.
#[tauri::command]
pub async fn openapi_v3_index(
    cluster_id: String,
    refresh: bool,
    state: State<'_, AppState>,
) -> IpcResult<OpenApiIndex> {
    let core = state.core.clone();
    core.openapi_v3_index(&cluster_id, refresh)
        .await
        .map_err(ipc_err)
}

/// `components.schemas` of one group-version (`v1`, `apps/v1`).
#[tauri::command]
pub async fn openapi_v3_document(
    cluster_id: String,
    api_version: String,
    state: State<'_, AppState>,
) -> IpcResult<Value> {
    let core = state.core.clone();
    core.openapi_v3_document(&cluster_id, &api_version)
        .await
        .map_err(ipc_err)
}
