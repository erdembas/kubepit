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
mod logs;
mod metrics;
mod portforward;
mod resources;
mod workloads;

pub use access::*;
pub use app::*;
pub use clusters::*;
pub use fleet::*;
pub use helm::*;
pub use logs::*;
pub use metrics::*;
pub use portforward::*;
pub use resources::*;
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
