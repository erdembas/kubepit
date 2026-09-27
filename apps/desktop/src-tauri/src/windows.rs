//! App windows.
//!
//! The first window is `main` (from `tauri.conf.json`); `window_open` adds
//! more (`win-*`), all sharing this process's backend: connections, watches'
//! cluster clients, port forwards and the PTY manager. Streams are per
//! window because their channels belong to the webview that asked. PTYs
//! outlive their channel, so [`WindowTerminals`] remembers which window
//! created each terminal and closing a window destroys them.

use std::collections::{HashMap, HashSet};

use parking_lot::Mutex;
use tauri::Manager;

use crate::ipc::IpcResult;
use crate::AppState;

/// Offset of a new window from the one that opened it (cascade).
const CASCADE: f64 = 28.0;

/// Terminal ids by the window that created them.
#[derive(Default)]
pub struct WindowTerminals {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    owners: HashMap<String, String>,
    closed: HashSet<String>,
}

impl WindowTerminals {
    /// Records that `window` owns `terminal`; false when the window already closed.
    pub fn register(&self, window: &str, terminal: &str) -> bool {
        let mut inner = self.inner.lock();
        if inner.closed.contains(window) {
            return false;
        }
        inner
            .owners
            .insert(terminal.to_string(), window.to_string());
        true
    }

    pub fn is_closed(&self, window: &str) -> bool {
        self.inner.lock().closed.contains(window)
    }

    /// Marks `window` closed and hands back the terminals it owned.
    pub fn close_window(&self, window: &str) -> Vec<String> {
        let mut inner = self.inner.lock();
        inner.closed.insert(window.to_string());
        let ids: Vec<String> = inner
            .owners
            .iter()
            .filter(|(_, owner)| owner.as_str() == window)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            inner.owners.remove(id);
        }
        ids
    }
}

/// Window labels the frontend may request: `win-` plus a short token.
fn valid_label(label: &str) -> bool {
    label.len() <= 48
        && label.starts_with("win-")
        && label.len() > 4
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Open another app window labelled `label`, the size of the calling
/// window and cascaded from it. The frontend hands the new window its
/// starting state (see `lib/windowSeed.ts`) before calling this.
#[tauri::command]
pub async fn window_open(
    label: String,
    app: tauri::AppHandle,
    window: tauri::Window,
) -> IpcResult<()> {
    if !valid_label(&label) {
        return Err(format!("invalid window label {label:?}"));
    }
    if app.get_webview_window(&label).is_some() {
        return Err(format!("window {label} already exists"));
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .map(|s| s.to_logical::<f64>(scale))
        .unwrap_or(tauri::LogicalSize::new(1600.0, 1000.0));
    let origin = window
        .outer_position()
        .map(|p| p.to_logical::<f64>(scale))
        .unwrap_or(tauri::LogicalPosition::new(0.0, 0.0));

    let builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
            .title("Kubepit")
            .inner_size(size.width, size.height)
            .min_inner_size(1024.0, 680.0)
            .position(origin.x + CASCADE, origin.y + CASCADE)
            .resizable(true)
            .decorations(true)
            // Same as `dragDropEnabled: false` on `main`: HTML5 drag and drop
            // (tabs, sidebar) needs the webview to keep drag events.
            .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0));
    builder
        .build()
        .map_err(|e| format!("cannot open window: {e}"))?;
    Ok(())
}

/// A window went away: end the terminals it created.
pub(crate) fn on_window_destroyed(window: &tauri::Window) {
    let Some(state) = window.try_state::<AppState>() else {
        return;
    };
    let ids = state.window_terminals.close_window(window.label());
    if ids.is_empty() {
        return;
    }
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for id in ids {
            let _ = terminals.destroy(&id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_restricted() {
        assert!(valid_label("win-3fa9c2d1"));
        assert!(!valid_label("main"));
        assert!(!valid_label("win-"));
        assert!(!valid_label("win-../x"));
        assert!(!valid_label(&format!("win-{}", "a".repeat(60))));
    }

    #[test]
    fn closing_a_window_hands_back_only_its_terminals() {
        let registry = WindowTerminals::default();
        assert!(registry.register("main", "t1"));
        assert!(registry.register("win-a", "t2"));
        assert!(registry.register("win-a", "t3"));
        let mut closed = registry.close_window("win-a");
        closed.sort();
        assert_eq!(closed, ["t2", "t3"]);
        assert!(registry.is_closed("win-a"));
        assert!(
            !registry.register("win-a", "t4"),
            "a closed window cannot own new terminals"
        );
        assert_eq!(registry.close_window("main"), ["t1"]);
    }
}
