//! Upgrade readiness: deprecated and removed API usage for a target
//! Kubernetes version. Read-only, so it also works on read-only clusters.

use kubepit_core::upgrade::{UpgradeReport, UpgradeScanOptions};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn upgrade_readiness_scan(
    cluster_id: String,
    options: UpgradeScanOptions,
    state: State<'_, AppState>,
) -> IpcResult<UpgradeReport> {
    let core = state.core.clone();
    core.upgrade_readiness_scan(&cluster_id, &options)
        .await
        .map_err(ipc_err)
}
