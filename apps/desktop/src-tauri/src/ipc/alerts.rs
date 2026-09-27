//! Alerts: the notification center's commands and the `alerts://new` event.
//!
//! Several app windows may be open, and each listens to `alerts://new`, but
//! exactly one of them must post the OS notification. The event therefore
//! names the `notifier` window (`main` while it exists, otherwise the first
//! window by label) and tells whether any Kubepit window is focused, so the
//! UI can honour "only when Kubepit is in the background".

use kubepit_core::alerts::{Alert, AlertEvent};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use super::IpcResult;
use crate::AppState;

/// `alerts://new`
pub const EVENT_ALERTS_NEW: &str = "alerts://new";
/// `alerts://changed` (alerts marked read or cleared; payload `null`)
pub const EVENT_ALERTS_CHANGED: &str = "alerts://changed";

/// Payload of `alerts://new`.
#[derive(Debug, Clone, Serialize)]
pub struct AlertNotice<'a> {
    pub alert: &'a Alert,
    /// A new entry rather than a merged repeat (only fresh ones notify).
    pub fresh: bool,
    /// Label of the window that posts the OS notification.
    pub notifier: Option<String>,
    /// Whether any Kubepit window has focus.
    pub app_focused: bool,
}

/// `main` while it is open, otherwise the first window by label, so every
/// window agrees on one notifier.
pub(crate) fn pick_notifier<'a>(labels: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut first: Option<&str> = None;
    for label in labels {
        if label == "main" {
            return Some(label.to_string());
        }
        if first.is_none_or(|f| label < f) {
            first = Some(label);
        }
    }
    first.map(str::to_string)
}

/// Emit `alerts://new` to every window.
pub(crate) fn emit_alert(app: &tauri::AppHandle, event: &AlertEvent) {
    let windows = app.webview_windows();
    let notifier = pick_notifier(windows.keys().map(String::as_str));
    let app_focused = windows.values().any(|w| w.is_focused().unwrap_or(false));
    let notice = AlertNotice {
        alert: &event.alert,
        fresh: event.fresh,
        notifier,
        app_focused,
    };
    let _ = app.emit(EVENT_ALERTS_NEW, notice);
}

pub(crate) fn emit_alerts_changed(app: &tauri::AppHandle) {
    let _ = app.emit(EVENT_ALERTS_CHANGED, ());
}

/// Every alert, newest activity first.
#[tauri::command]
pub async fn alerts_list(state: State<'_, AppState>) -> IpcResult<Vec<Alert>> {
    Ok(state.core.alerts_list())
}

/// `ids: null` marks everything read.
#[tauri::command]
pub async fn alerts_mark_read(
    ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    state.core.alerts_mark_read(ids);
    Ok(())
}

/// `ids: null` clears everything.
#[tauri::command]
pub async fn alerts_clear(ids: Option<Vec<String>>, state: State<'_, AppState>) -> IpcResult<()> {
    state.core.alerts_clear(ids);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_window_is_the_notifier() {
        assert_eq!(
            pick_notifier(["win-b", "main", "win-a"]),
            Some("main".into())
        );
        assert_eq!(pick_notifier(["win-b", "win-a"]), Some("win-a".into()));
        assert_eq!(pick_notifier(Vec::<&str>::new()), None);
    }
}
