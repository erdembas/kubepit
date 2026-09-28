//! App-level commands: info, settings, workspace snapshot, reveal in Finder.

use kubepit_core::types::{AppInfo, Settings};
use serde_json::Value;
use tauri::{Emitter, State};

use super::{blocking, IpcResult};
use crate::app_state::{emit_settings_changed, WorkspaceChanged, EVENT_WORKSPACE_CHANGED};
use crate::AppState;

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> IpcResult<AppInfo> {
    let core = state.core.clone();
    Ok(core.app_info(env!("CARGO_PKG_VERSION")).await)
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> IpcResult<Settings> {
    Ok(state.core.settings())
}

/// Saves the settings, then tells every window (`settings://changed`).
#[tauri::command]
pub async fn settings_set(
    settings: Settings,
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> IpcResult<Settings> {
    let core = state.core.clone();
    let saved = blocking(move || core.set_settings(settings)).await?;
    emit_settings_changed(&app, window.label(), &saved);
    Ok(saved)
}

/// `null` when the frontend never saved a snapshot.
#[tauri::command]
pub async fn workspace_load(state: State<'_, AppState>) -> IpcResult<Option<Value>> {
    let core = state.core.clone();
    blocking(move || core.workspace_load()).await
}

/// Saves the snapshot, then tells the other windows (`workspace://changed`).
#[tauri::command]
pub async fn workspace_save(
    snapshot: Value,
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let core = state.core.clone();
    let saved = snapshot.clone();
    blocking(move || core.workspace_save(&saved)).await?;
    let changed = WorkspaceChanged {
        source: window.label().to_string(),
        snapshot,
    };
    let _ = app.emit(EVENT_WORKSPACE_CHANGED, changed);
    Ok(())
}

/// Show `path` selected in Finder / Explorer / the file manager.
#[tauri::command]
pub async fn reveal_path(path: String) -> IpcResult<()> {
    let target = kubepit_core::paths::expand_tilde(&path);
    if !target.exists() {
        return Err(format!("{} does not exist", target.display()));
    }
    tauri_plugin_opener::reveal_item_in_dir(&target)
        .map_err(|e| format!("cannot reveal {}: {e}", target.display()))
}
