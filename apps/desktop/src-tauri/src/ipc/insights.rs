//! Insights: kubeconfig client certificate expiry for the cluster card.

use kubepit_core::client_cert::ClientCertificate;
use tauri::State;

use super::{blocking, IpcResult};
use crate::AppState;

/// Reads the cluster's kubeconfig only; never contacts the cluster.
#[tauri::command]
pub async fn cluster_client_certificate(
    id: String,
    state: State<'_, AppState>,
) -> IpcResult<Option<ClientCertificate>> {
    let core = state.core.clone();
    blocking(move || core.cluster_client_certificate(&id)).await
}
