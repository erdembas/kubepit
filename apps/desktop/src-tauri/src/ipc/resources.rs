//! Generic resources, watches, workload actions and node maintenance.

use kubepit_core::types::{
    ApplyMode, DeleteOptions, Gvk, KubeObject, PatchType, ResourceList, WatchBatch,
};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn resource_list(
    cluster_id: String,
    gvk: Gvk,
    namespace: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<ResourceList> {
    let core = state.core.clone();
    core.resource_list(
        &cluster_id,
        &gvk,
        namespace.as_deref(),
        label_selector.as_deref(),
        field_selector.as_deref(),
    )
    .await
    .map_err(ipc_err)
}

/// Starts a batched watch; batches arrive on `on_event` until
/// `resource_unwatch` or until the webview drops the channel.
#[tauri::command]
pub async fn resource_watch(
    cluster_id: String,
    gvk: Gvk,
    namespaces: Vec<String>,
    on_event: Channel<WatchBatch>,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    core.resource_watch(&cluster_id, &gvk, namespaces, move |batch| {
        on_event.send(batch).is_ok()
    })
    .await
    .map_err(ipc_err)
}

#[tauri::command]
pub async fn resource_unwatch(watch_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.resource_unwatch(&watch_id);
    Ok(())
}

#[tauri::command]
pub async fn resource_get(
    cluster_id: String,
    gvk: Gvk,
    namespace: Option<String>,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<KubeObject> {
    let core = state.core.clone();
    core.resource_get(&cluster_id, &gvk, namespace.as_deref(), &name)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn resource_get_yaml(
    cluster_id: String,
    gvk: Gvk,
    namespace: Option<String>,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    core.resource_get_yaml(&cluster_id, &gvk, namespace.as_deref(), &name)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn resource_apply_yaml(
    cluster_id: String,
    yaml: String,
    mode: ApplyMode,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Vec<KubeObject>> {
    let core = state.core.clone();
    core.resource_apply_yaml(&cluster_id, &yaml, mode, namespace.as_deref())
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn resource_delete(
    cluster_id: String,
    gvk: Gvk,
    namespace: Option<String>,
    name: String,
    options: Option<DeleteOptions>,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.resource_delete(
        &cluster_id,
        &gvk,
        namespace.as_deref(),
        &name,
        options.unwrap_or_default(),
    )
    .await
    .map_err(ipc_err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Mirrors the IPC contract one-to-one.
pub async fn resource_patch(
    cluster_id: String,
    gvk: Gvk,
    namespace: Option<String>,
    name: String,
    patch: Value,
    patch_type: PatchType,
    state: State<'_, AppState>,
) -> IpcResult<KubeObject> {
    let core = state.core.clone();
    core.resource_patch(
        &cluster_id,
        &gvk,
        namespace.as_deref(),
        &name,
        patch,
        patch_type,
    )
    .await
    .map_err(ipc_err)
}

#[tauri::command]
pub async fn resource_scale(
    cluster_id: String,
    gvk: Gvk,
    namespace: String,
    name: String,
    replicas: i64,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.resource_scale(&cluster_id, &gvk, &namespace, &name, replicas)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn resource_restart(
    cluster_id: String,
    gvk: Gvk,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.resource_restart(&cluster_id, &gvk, &namespace, &name)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn resource_events(
    cluster_id: String,
    namespace: Option<String>,
    uid: String,
    state: State<'_, AppState>,
) -> IpcResult<Vec<KubeObject>> {
    let core = state.core.clone();
    core.resource_events(&cluster_id, namespace.as_deref(), &uid)
        .await
        .map_err(ipc_err)
}

/// Returns the name of the created Job.
#[tauri::command]
pub async fn cronjob_trigger(
    cluster_id: String,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    let core = state.core.clone();
    core.cronjob_trigger(&cluster_id, &namespace, &name)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn node_cordon(
    cluster_id: String,
    name: String,
    unschedulable: bool,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.node_cordon(&cluster_id, &name, unschedulable)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn node_drain(
    cluster_id: String,
    name: String,
    force: bool,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    core.node_drain(&cluster_id, &name, force)
        .await
        .map_err(ipc_err)
}
