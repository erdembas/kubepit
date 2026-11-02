//! Gateway API: the release CRD manifest (a download only; the UI applies
//! it through the audited `resource_apply_yaml`) and read-only Envoy admin
//! inspection over a port-forward (allowed on read-only clusters).

use kubepit_core::gateway_api::{
    EnvoyAdminEndpoint, EnvoyAdminResponse, GatewayApiChannel, GatewayApiCrdsManifest,
};
use tauri::State;

use super::{ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn gateway_api_crds_manifest(
    channel: GatewayApiChannel,
    version: String,
    state: State<'_, AppState>,
) -> IpcResult<GatewayApiCrdsManifest> {
    state
        .core
        .gateway_api_crds_manifest(channel, &version)
        .await
        .map_err(ipc_err)
}

#[tauri::command]
pub async fn envoy_admin(
    cluster_id: String,
    namespace: String,
    pod: String,
    port: Option<u16>,
    endpoint: EnvoyAdminEndpoint,
    filter: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<EnvoyAdminResponse> {
    state
        .core
        .envoy_admin(
            &cluster_id,
            &namespace,
            &pod,
            port,
            endpoint,
            filter.as_deref(),
        )
        .await
        .map_err(ipc_err)
}
