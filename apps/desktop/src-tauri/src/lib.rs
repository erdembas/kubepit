//! Kubepit desktop shell.
//!
//! This crate is intentionally thin. All domain logic lives in
//! [`kubepit_core`]; this shell is responsible for:
//!
//! 1. Wiring up Tauri plugins and commands.
//! 2. Implementing [`kubepit_core::EventSink`] on top of Tauri's event bus.
//! 3. Bridging core stream callbacks to typed `tauri::ipc::Channel`s.
//! 4. Owning the PTY terminals (RunHQ's pipeline, see [`terminal`]).
//! 5. Opening extra app windows and cleaning up after them (see `windows`).

mod app_state;
pub mod ipc;
mod setup;
pub mod terminal;
mod windows;

pub use app_state::AppState;

use setup::setup_app;
use tracing_subscriber::{fmt, EnvFilter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,kube=warn,tower=warn,hyper=warn")),
        )
        .with_target(false)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(setup_app)
        .invoke_handler(tauri::generate_handler![
            // App
            ipc::app_info,
            ipc::settings_get,
            ipc::settings_set,
            ipc::workspace_load,
            ipc::workspace_save,
            ipc::reveal_path,
            // Windows
            windows::window_open,
            // Kubeconfig discovery
            ipc::kubeconfig_discover,
            ipc::kubeconfig_parse_file,
            ipc::kubeconfig_parse_text,
            // Cluster registry & connections
            ipc::cluster_list,
            ipc::cluster_add,
            ipc::cluster_update,
            ipc::cluster_remove,
            ipc::cluster_connect,
            ipc::cluster_disconnect,
            ipc::cluster_statuses,
            ipc::cluster_export_kubeconfig,
            ipc::cluster_overview,
            // Discovery
            ipc::api_resources,
            ipc::namespace_names,
            // Generic resources
            ipc::resource_list,
            ipc::resource_watch,
            ipc::resource_unwatch,
            ipc::resource_get,
            ipc::resource_get_yaml,
            ipc::resource_apply_yaml,
            ipc::resource_delete,
            ipc::resource_patch,
            ipc::resource_scale,
            ipc::resource_restart,
            ipc::resource_events,
            ipc::cronjob_trigger,
            ipc::node_cordon,
            ipc::node_drain,
            // Workload operations
            ipc::rollout_history,
            ipc::rollout_undo,
            ipc::resource_set_image,
            ipc::resource_dry_run_yaml,
            // Logs
            ipc::pod_logs_stream,
            ipc::pod_logs_stop,
            // Metrics
            ipc::metrics_nodes,
            ipc::metrics_pods,
            // Port forwarding
            ipc::port_forward_start,
            ipc::port_forward_stop,
            ipc::port_forward_list,
            // Helm
            ipc::helm_releases,
            ipc::helm_release_detail,
            ipc::helm_rollback,
            ipc::helm_uninstall,
            ipc::helm_upgrade_values,
            // Access (RBAC self-reviews)
            ipc::access_review,
            ipc::access_rules,
            ipc::access_whoami,
            // Fleet: metrics history, fleet search
            ipc::metrics_history,
            ipc::metrics_history_fleet,
            ipc::fleet_search,
            ipc::fleet_search_cancel,
            // Change timeline
            ipc::changes_list,
            ipc::changes_get,
            // Logs & debug
            ipc::workload_logs_stream,
            ipc::workload_logs_stop,
            ipc::save_text_file,
            ipc::pod_debug,
            ipc::pod_fs_list,
            ipc::pod_fs_read,
            ipc::pod_fs_download,
            ipc::pod_fs_upload,
            // Helm charts
            ipc::helm_repo_list,
            ipc::helm_repo_add,
            ipc::helm_repo_remove,
            ipc::helm_repo_update,
            ipc::helm_chart_search,
            ipc::helm_chart_versions,
            ipc::helm_hub_search,
            ipc::helm_chart_show,
            ipc::helm_install,
            ipc::helm_upgrade,
            ipc::helm_release_revision,
            // Terminal
            terminal::commands::terminal_create,
            terminal::commands::terminal_write,
            terminal::commands::terminal_resize,
            terminal::commands::terminal_acknowledge,
            terminal::commands::terminal_destroy,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                windows::on_window_destroyed(window);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Kubepit")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                setup::shutdown(app_handle);
            }
        });
}
