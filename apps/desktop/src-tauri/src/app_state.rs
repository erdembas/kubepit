use std::sync::Arc;

use kubepit_core::alerts::AlertEvent;
use kubepit_core::types::{
    ClusterDef, ClusterStatus, KubeconfigChanged, PortForward, SavedPortForward,
};
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
/// `portforward://saved`
pub const EVENT_PORT_FORWARDS_SAVED: &str = "portforward://saved";
/// `kubeconfig://changed`
pub const EVENT_KUBECONFIG_CHANGED: &str = "kubeconfig://changed";
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

    fn alert(&self, event: &AlertEvent) {
        crate::ipc::alerts::emit_alert(&self.app, event);
    }

    fn alerts_changed(&self) {
        crate::ipc::alerts::emit_alerts_changed(&self.app);
    }

    fn saved_port_forwards(&self, saved: &[SavedPortForward]) {
        let _ = self.app.emit(EVENT_PORT_FORWARDS_SAVED, saved);
    }

    fn kubeconfig_changed(&self, change: &KubeconfigChanged) {
        let _ = self.app.emit(EVENT_KUBECONFIG_CHANGED, change);
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
