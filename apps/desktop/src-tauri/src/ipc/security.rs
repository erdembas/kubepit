//! Security: the Pod Security Standards enforce dry run. It only ever sends
//! `dryRun=All`, so it also works on clusters marked read-only.

use kubepit_core::pod_security::PodSecurityDryRun;
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

/// Warnings the API server returns for enforcing `level` at `version` on
/// `namespace`, parsed into violating pods. Nothing is persisted.
#[tauri::command]
pub async fn pod_security_dry_run(
    cluster_id: String,
    namespace: String,
    level: String,
    version: String,
    state: State<'_, AppState>,
) -> IpcResult<PodSecurityDryRun> {
    let core = state.core.clone();
    core.pod_security_dry_run(&cluster_id, &namespace, &level, &version)
        .await
        .map_err(ipc_err)
}
