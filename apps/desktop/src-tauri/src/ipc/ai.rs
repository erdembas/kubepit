//! Assistant IPC: keychain/disk work stays off the webview thread; stream
//! lifetime belongs to the window that started it, including pending consent.
use super::{blocking, ipc_err, IpcResult};
use crate::app_state::emit_settings_changed;
use crate::AppState;
use kubepit_core::ai::*;
use kubepit_core::history::{AiLogDetail, AiLogFilter, AiLogPage};
use kubepit_core::types::Settings;
use tauri::{ipc::Channel, State};

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> IpcResult<AiStatus> {
    let core = state.core.clone();
    blocking(move || Ok(core.ai_status())).await
}
#[tauri::command]
pub async fn ai_local_agents(state: State<'_, AppState>) -> IpcResult<Vec<AiLocalAgent>> {
    let core = state.core.clone();
    blocking(move || Ok(core.ai_local_agents())).await
}
#[tauri::command]
pub async fn ai_agent_catalog(
    kind: AiProviderKind,
    refresh: bool,
    state: State<'_, AppState>,
) -> IpcResult<AiAgentCatalog> {
    state
        .core
        .ai_agent_catalog(kind, refresh)
        .await
        .map_err(ipc_err)
}
#[tauri::command]
pub async fn ai_key_set(
    provider_id: String,
    key: String,
    state: State<'_, AppState>,
) -> IpcResult<AiStatus> {
    let core = state.core.clone();
    blocking(move || core.ai_key_set(&provider_id, &key)).await
}
#[tauri::command]
pub async fn ai_key_delete(provider_id: String, state: State<'_, AppState>) -> IpcResult<AiStatus> {
    let core = state.core.clone();
    blocking(move || core.ai_key_delete(&provider_id)).await
}
#[tauri::command]
pub async fn ai_models(
    provider_id: String,
    state: State<'_, AppState>,
) -> IpcResult<Vec<AiModelInfo>> {
    state.core.ai_models(&provider_id).await.map_err(ipc_err)
}
#[tauri::command]
pub async fn ai_cluster_set(
    cluster_id: String,
    enabled: bool,
    acknowledge_production: bool,
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> IpcResult<Settings> {
    let core = state.core.clone();
    let saved =
        blocking(move || core.ai_cluster_set(&cluster_id, enabled, acknowledge_production)).await?;
    emit_settings_changed(&app, window.label(), &saved);
    Ok(saved)
}
#[tauri::command]
pub async fn ai_preview(request: AiRequest, state: State<'_, AppState>) -> IpcResult<AiPreview> {
    let core = state.core.clone();
    blocking(move || core.ai_preview(request)).await
}
#[tauri::command]
pub async fn ai_send(
    preview_id: String,
    on_event: Channel<AiEvent>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> IpcResult<String> {
    if state.window_ai.is_closed(window.label()) {
        return Err("window is closed".into());
    }
    // Keychain access is blocking, but ai_send must spawn on the async runtime.
    // Tokio's blocking pool inherits its runtime handle for TaskRegistry::spawn.
    let core = state.core.clone();
    let run_id =
        blocking(move || core.ai_send(&preview_id, move |event| on_event.send(event).is_ok()))
            .await?;
    state
        .window_ai
        .retain_live(|id| state.core.ai_run_active(id));
    if !state.window_ai.register(window.label(), &run_id) {
        state.core.ai_cancel(&run_id);
    }
    Ok(run_id)
}
#[tauri::command]
pub async fn ai_tool_decision(
    run_id: String,
    call_id: String,
    decision: AiToolDecision,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    state
        .core
        .ai_tool_decision(&run_id, &call_id, decision)
        .map_err(ipc_err)
}
#[tauri::command]
pub async fn ai_cancel(run_id: String, state: State<'_, AppState>) -> IpcResult<bool> {
    state.window_ai.forget(&run_id);
    Ok(state.core.ai_cancel(&run_id))
}
#[tauri::command]
pub async fn ai_session_end(session_id: String, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.ai_session_end(&session_id);
    Ok(())
}
#[tauri::command]
pub async fn ai_log_list(filter: AiLogFilter, state: State<'_, AppState>) -> IpcResult<AiLogPage> {
    let core = state.core.clone();
    blocking(move || core.ai_log_list(&filter)).await
}
#[tauri::command]
pub async fn ai_log_get(id: i64, state: State<'_, AppState>) -> IpcResult<AiLogDetail> {
    let core = state.core.clone();
    blocking(move || core.ai_log_get(id)).await
}
#[tauri::command]
pub async fn ai_log_export(filter: AiLogFilter, state: State<'_, AppState>) -> IpcResult<String> {
    let core = state.core.clone();
    blocking(move || core.ai_log_export(&filter)).await
}
