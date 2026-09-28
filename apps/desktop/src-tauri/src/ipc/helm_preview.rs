//! Helm values schemas (`values.schema.json`) and the upgrade preview.
//! Nothing here changes a cluster: previews are dry runs, so they also
//! work on read-only clusters.

use kubepit_core::helm_preview::HelmUpgradePreview;
use kubepit_core::types::HelmUpgradeRequest;
use serde_json::Value;
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

/// The schema the running revision was installed with (`null` = none).
#[tauri::command]
pub async fn helm_release_values_schema(
    cluster_id: String,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> IpcResult<Option<Value>> {
    let core = state.core.clone();
    core.helm_release_values_schema(&cluster_id, &namespace, &name)
        .await
        .map_err(ipc_err)
}

/// The schema of a repository / OCI chart version (`null` = none).
#[tauri::command]
pub async fn helm_chart_values_schema(
    chart_ref: String,
    version: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<Option<Value>> {
    let core = state.core.clone();
    core.helm_chart_values_schema(&chart_ref, version.as_deref())
        .await
        .map_err(ipc_err)
}

/// Dry-run upgrade split into object changes (optionally diffed against
/// the live objects with a server-side dry run).
#[tauri::command]
pub async fn helm_upgrade_preview(
    cluster_id: String,
    namespace: String,
    name: String,
    request: HelmUpgradeRequest,
    live: bool,
    state: State<'_, AppState>,
) -> IpcResult<HelmUpgradePreview> {
    let core = state.core.clone();
    core.helm_upgrade_preview(&cluster_id, &namespace, &name, &request, live)
        .await
        .map_err(ipc_err)
}
