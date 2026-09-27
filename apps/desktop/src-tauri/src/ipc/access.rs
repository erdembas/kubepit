//! RBAC self-reviews. Read-only (reviews create no objects), so they also
//! work on clusters marked read-only.

use kubepit_core::types::{AccessCheck, AccessDecision, AccessRules, WhoAmI};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

/// One decision per check, in order; a failed check carries `error`.
#[tauri::command]
pub async fn access_review(
    cluster_id: String,
    checks: Vec<AccessCheck>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<AccessDecision>> {
    let core = state.core.clone();
    core.access_review(&cluster_id, checks)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn access_rules(
    cluster_id: String,
    namespace: String,
    state: State<'_, AppState>,
) -> IpcResult<AccessRules> {
    let core = state.core.clone();
    core.access_rules(&cluster_id, &namespace)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn access_whoami(cluster_id: String, state: State<'_, AppState>) -> IpcResult<WhoAmI> {
    let core = state.core.clone();
    core.access_whoami(&cluster_id).await.map_err(ipc_err)
}
