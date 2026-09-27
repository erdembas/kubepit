//! App-level commands: info, settings, workspace snapshot, reveal in Finder.

use kubepit_core::types::{AppInfo, Settings};
use serde_json::Value;
use tauri::State;

use super::{blocking, IpcResult};
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

#[tauri::command]
pub async fn settings_set(settings: Settings, state: State<'_, AppState>) -> IpcResult<Settings> {
    let core = state.core.clone();
    blocking(move || core.set_settings(settings)).await
}

/// `null` when the frontend never saved a snapshot.
#[tauri::command]
pub async fn workspace_load(state: State<'_, AppState>) -> IpcResult<Option<Value>> {
    let core = state.core.clone();
    blocking(move || core.workspace_load()).await
}

#[tauri::command]
pub async fn workspace_save(snapshot: Value, state: State<'_, AppState>) -> IpcResult<()> {
    let core = state.core.clone();
    blocking(move || core.workspace_save(&snapshot)).await
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
