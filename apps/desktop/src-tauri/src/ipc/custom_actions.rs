//! Custom actions (k9s-plugin style): definitions in `actions.json`,
//! command previews, background / open-url runs and imports. Terminal-mode
//! actions run through `terminal_create` (`TerminalSpec::CustomAction`).
//! Saving broadcasts the list on `customactions://changed`.

use kubepit_core::custom_actions::{
    CustomAction, CustomActionImport, CustomActionResult, CustomActionTarget, CustomActionsState,
    ResolvedCustomAction,
};
use tauri::{Emitter, State};

use super::{blocking, ipc_err, IpcResult};
use crate::AppState;

/// `customactions://changed` — the saved list after every save.
pub const EVENT_CUSTOM_ACTIONS_CHANGED: &str = "customactions://changed";

#[tauri::command]
pub async fn custom_actions_list(state: State<'_, AppState>) -> IpcResult<CustomActionsState> {
    Ok(state.core.custom_actions_list())
}

#[tauri::command]
pub async fn custom_actions_save(
    actions: Vec<CustomAction>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> IpcResult<Vec<CustomAction>> {
    let core = state.core.clone();
    let saved = blocking(move || core.custom_actions_save(actions)).await?;
    let _ = app.emit(EVENT_CUSTOM_ACTIONS_CHANGED, &saved);
    Ok(saved)
}

/// Reads a file the user picked (or text from a browser file input).
#[tauri::command]
pub async fn custom_actions_import(
    path: Option<String>,
    text: Option<String>,
    state: State<'_, AppState>,
) -> IpcResult<CustomActionImport> {
    let core = state.core.clone();
    blocking(move || core.custom_actions_import(path.as_deref(), text.as_deref())).await
}

/// Preview of a (possibly unsaved) definition; `cluster_id: null` uses sample values.
#[tauri::command]
pub async fn custom_action_resolve(
    action: CustomAction,
    cluster_id: Option<String>,
    target: CustomActionTarget,
    state: State<'_, AppState>,
) -> IpcResult<ResolvedCustomAction> {
    let core = state.core.clone();
    blocking(move || core.custom_action_resolve(&action, cluster_id.as_deref(), &target)).await
}

/// Background runs capture output; open-url runs return the URL to open.
#[tauri::command]
pub async fn custom_action_run(
    cluster_id: String,
    action_id: String,
    target: CustomActionTarget,
    state: State<'_, AppState>,
) -> IpcResult<CustomActionResult> {
    let core = state.core.clone();
    core.custom_action_run(&cluster_id, &action_id, &target)
        .await
        .map_err(ipc_err)
}
