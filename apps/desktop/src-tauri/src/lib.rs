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

    let context = tauri::generate_context!();
    // Updates stay inert until a release signing key is configured (docs/RELEASING.md).
    let updater = ipc::UpdaterState::new(kubepit_core::updates::UpdaterConfig::from_plugin_config(
        context.config().plugins.0.get("updater"),
    ));
    let mut builder = tauri::Builder::default();
    if updater.enabled() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(updater)
        .setup(setup_app)
        .invoke_handler(tauri::generate_handler![
            // App
            ipc::app_info,
            ipc::settings_get,
            ipc::settings_set,
            ipc::workspace_load,
            ipc::workspace_save,
            ipc::reveal_path,
            // Updates
            ipc::update_status,
            ipc::update_check,
            ipc::update_install,
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
            ipc::cluster_client_certificate,
            ipc::cluster_overview,
            // Discovery
            ipc::api_resources,
            ipc::namespace_names,
            // OpenAPI v3 schemas (YAML editing, API explorer)
            ipc::openapi_v3_index,
            ipc::openapi_v3_document,
            // Generic resources
            ipc::resource_list,
            ipc::resource_watch,
            ipc::resource_unwatch,
            ipc::resource_watch_ack,
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
            // Local manifests
            ipc::manifests_render,
            ipc::manifests_watch,
            ipc::manifests_unwatch,
            ipc::manifests_recent_list,
            ipc::manifests_recent_remove,
            ipc::manifests_dry_run,
            ipc::manifests_apply,
            // Logs
            ipc::pod_logs_stream,
            ipc::pod_logs_stop,
            // Metrics
            ipc::metrics_nodes,
            ipc::metrics_pods,
            // Prometheus metrics (optional source)
            ipc::prometheus_status,
            ipc::prometheus_metrics,
            ipc::prometheus_query_range,
            // Loki historical logs (read-only)
            ipc::loki_status,
            ipc::loki_query_range,
            ipc::loki_labels,
            ipc::loki_label_values,
            // Port forwarding
            ipc::port_forward_start,
            ipc::port_forward_stop,
            ipc::port_forward_list,
            // Connectivity: saved port forwards, proxy info, keychain storage
            ipc::port_forward_saved_list,
            ipc::port_forward_save,
            ipc::port_forward_saved_update,
            ipc::port_forward_unsave,
            ipc::port_forward_saved_start,
            ipc::port_forward_restart,
            ipc::port_forward_local_port,
            ipc::cluster_proxy_info,
            ipc::kubeconfig_storage_set,
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
            // Security: Pod Security enforce dry run
            ipc::pod_security_dry_run,
            // Fleet: metrics history, fleet search
            ipc::metrics_history,
            ipc::metrics_history_fleet,
            ipc::fleet_search,
            ipc::fleet_search_cancel,
            // Change timeline
            ipc::changes_list,
            ipc::changes_get,
            // Upgrade readiness (deprecated APIs)
            ipc::upgrade_readiness_scan,
            // Persistent history (audit log, persisted events and changes)
            ipc::history_status,
            ipc::history_audit_list,
            ipc::history_audit_get,
            ipc::history_audit_export,
            ipc::history_events_list,
            ipc::history_changes_list,
            ipc::history_changes_get,
            ipc::history_clear,
            // Cost insight and right-sizing
            ipc::cost_status,
            ipc::cost_report,
            ipc::cost_summary,
            ipc::rightsizing_report,
            ipc::rightsizing_apply,
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
            // Helm values schemas and upgrade preview
            ipc::helm_release_values_schema,
            ipc::helm_chart_values_schema,
            ipc::helm_upgrade_preview,
            // Custom actions (k9s-plugin style)
            ipc::custom_actions_list,
            ipc::custom_actions_save,
            ipc::custom_actions_import,
            ipc::custom_action_resolve,
            ipc::custom_action_run,
            // Alerts
            ipc::alerts_list,
            ipc::alerts_mark_read,
            ipc::alerts_clear,
            // Resource wizards
            ipc::local_file_read,
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
        .build(context)
        .expect("error while building Kubepit")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                setup::shutdown(app_handle);
            }
        });
}
