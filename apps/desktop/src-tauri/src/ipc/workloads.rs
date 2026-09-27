//! Workload operations: rollout history and undo, set image, and the
//! server-side dry run behind "Review changes".

use kubepit_core::types::{
    ApplyMode, ContainerImage, DryRunResult, Gvk, KubeObject, RolloutRevision,
};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn rollout_history(
    cluster_id: String,
    gvk: Gvk,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<Vec<RolloutRevision>> {
    let core = state.core.clone();
    core.rollout_history(&cluster_id, &gvk, &namespace, &name)
        .await
        .map_err(ipc_err)
}

/// `revision: 0` rolls back to the previous revision.
#[tauri::command]
pub async fn rollout_undo(
    cluster_id: String,
    gvk: Gvk,
    namespace: String,
    name: String,
    revision: i64,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.rollout_undo(&cluster_id, &gvk, &namespace, &name, revision)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn resource_set_image(
    cluster_id: String,
    gvk: Gvk,
    namespace: Option<String>,
    name: String,
    images: Vec<ContainerImage>,
    state: State<'_, AppState>,
) -> IpcResult<KubeObject> {
    let core = state.core.clone();
    core.resource_set_image(&cluster_id, &gvk, namespace.as_deref(), &name, images)
        .await
        .map_err(ipc_err)
}

/// Allowed on read-only clusters: a dry run never persists anything.
#[tauri::command]
pub async fn resource_dry_run_yaml(
    cluster_id: String,
    yaml: String,
    mode: ApplyMode,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<DryRunResult>> {
    let core = state.core.clone();
    core.resource_dry_run_yaml(&cluster_id, &yaml, mode, namespace.as_deref())
        .await
        .map_err(ipc_err)
}
