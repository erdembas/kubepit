use std::sync::Arc;

use kubepit_core::types::{ClusterDef, ClusterStatus, PortForward};
use kubepit_core::{EventSink, Kubepit};
use serde::Serialize;
use tauri::Emitter;

use crate::terminal::TerminalManager;
use crate::windows::WindowTerminals;

/// `cluster://status`
pub const EVENT_CLUSTER_STATUS: &str = "cluster://status";
/// `cluster://list`
pub const EVENT_CLUSTER_LIST: &str = "cluster://list";
/// `portforward://changed`
pub const EVENT_PORT_FORWARDS: &str = "portforward://changed";
/// `terminal://exit`
pub const EVENT_TERMINAL_EXIT: &str = "terminal://exit";
/// `workspace://changed`
pub const EVENT_WORKSPACE_CHANGED: &str = "workspace://changed";

/// Payload of `terminal://exit`.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalExit<'a> {
    pub id: &'a str,
    pub code: Option<i32>,
}

/// [`EventSink`] on top of Tauri's global event bus.
pub struct TauriEventSink {
    app: tauri::AppHandle,
}

impl TauriEventSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn cluster_status(&self, status: &ClusterStatus) {
        let _ = self.app.emit(EVENT_CLUSTER_STATUS, status);
    }

    fn cluster_list(&self, clusters: &[ClusterDef]) {
        let _ = self.app.emit(EVENT_CLUSTER_LIST, clusters);
    }

    fn port_forwards(&self, forwards: &[PortForward]) {
        let _ = self.app.emit(EVENT_PORT_FORWARDS, forwards);
    }
}

/// Payload of `workspace://changed`: a window saved the workspace snapshot.
/// Every window receives it; the one named by `source` ignores it.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceChanged {
    pub source: String,
    pub snapshot: serde_json::Value,
}

/// Shared Tauri-managed state.
pub struct AppState {
    pub core: Arc<Kubepit>,
    pub terminals: TerminalManager,
    pub window_terminals: WindowTerminals,
}
