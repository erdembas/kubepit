//! Tauri IPC command surface.
//!
//! Every command is a thin adapter over [`kubepit_core::Kubepit`]; names,
//! parameters and return types mirror `apps/desktop/src/lib/ipc.ts`. JS
//! camelCase arguments arrive as the snake_case parameters below
//! (`clusterId` → `cluster_id`). Errors cross as human-readable strings
//! (`format!("{e:#}")`, full context chain).
//!
//! Filesystem work (registry, settings, kubeconfig scans) runs on the
//! blocking pool so neither the window event loop nor Tokio's async workers
//! stall on disk I/O.

mod access;
mod app;
mod clusters;
mod fleet;
mod helm;
mod helm_charts;
mod logs;
mod metrics;
mod portforward;
mod resources;
mod workloads;
// Logs & debug: workload logs, log export, debug containers, container files.
mod logs_debug;
// In-app updates (inert until release signing is configured).
mod updater;
// Alerts: notification center commands and the `alerts://new` event.
pub(crate) mod alerts;
// Insights: kubeconfig client certificate expiry.
mod insights;
// Prometheus: detection status, preset series, ad-hoc PromQL.
mod prometheus;
// OpenAPI v3 schemas: YAML editing, API explorer.
mod openapi;
// Connectivity: saved port forwards, proxy info, keychain storage.
mod connectivity;
// Local manifests: render folders, diff / apply to clusters.
mod manifests;
// Change timeline: in-memory change journal.
mod changes;
// Resource wizards: user-picked local files.
mod files;
// Upgrade readiness (deprecated APIs), Helm values schemas and upgrade preview.
mod helm_preview;
mod upgrade;
// Persistent history: audit log, persisted events and changes.
mod history;
// Power user: custom actions (k9s-plugin style).
mod custom_actions;

pub use access::*;
pub use alerts::*;
pub use app::*;
pub use changes::*;
pub use clusters::*;
pub use connectivity::*;
pub use custom_actions::*;
pub use files::*;
pub use fleet::*;
pub use helm::*;
pub use helm_charts::*;
pub use helm_preview::*;
pub use history::*;
pub use insights::*;
pub use logs::*;
pub use logs_debug::*;
pub use manifests::*;
pub use metrics::*;
pub use openapi::*;
pub use portforward::*;
pub use prometheus::*;
pub use resources::*;
pub use updater::*;
pub use upgrade::*;
pub use workloads::*;

use kubepit_core::error::to_ipc;

/// Result type of every command.
pub type IpcResult<T> = Result<T, String>;

/// Render a core error for the frontend.
pub(crate) fn ipc_err(err: anyhow::Error) -> String {
    to_ipc(err)
}

/// Run blocking work on the blocking pool and flatten its result.
pub(crate) async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> IpcResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
        .map_err(ipc_err)
}
