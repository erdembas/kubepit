//! Every registered Tauri command is classified; every mutating one must call
//! an audited entry point defined in `kubepit-core/src/history/audited.rs`.
//!
//! Adding a command to `generate_handler!` fails
//! `every_registered_command_is_classified` until it is listed below. A
//! mutating command goes to [`MUTATING`] with the core methods it calls; those
//! must be the audited wrappers, so the audit log cannot be bypassed.

const LIB: &str = include_str!("../lib.rs");
const AUDITED: &str = include_str!("../../../../../crates/kubepit-core/src/history/audited.rs");
const CORE_TERMINAL: &str = include_str!("../../../../../crates/kubepit-core/src/terminal.rs");
const TERMINAL_COMMANDS: &str = include_str!("../terminal/commands.rs");
const RESOURCES: &str = include_str!("resources.rs");
const WORKLOADS: &str = include_str!("workloads.rs");
const MANIFESTS: &str = include_str!("manifests.rs");
const HELM: &str = include_str!("helm.rs");
const HELM_CHARTS: &str = include_str!("helm_charts.rs");
const LOGS_DEBUG: &str = include_str!("logs_debug.rs");
const COST: &str = include_str!("cost.rs");
const CUSTOM_ACTIONS: &str = include_str!("custom_actions.rs");

/// (command, source that must call the methods, audited core methods)
const MUTATING: &[(&str, &str, &[&str])] = &[
    ("resource_apply_yaml", RESOURCES, &["resource_apply_yaml"]),
    ("resource_delete", RESOURCES, &["resource_delete"]),
    ("resource_patch", RESOURCES, &["resource_patch"]),
    ("resource_scale", RESOURCES, &["resource_scale"]),
    ("resource_restart", RESOURCES, &["resource_restart"]),
    ("cronjob_trigger", RESOURCES, &["cronjob_trigger"]),
    ("node_cordon", RESOURCES, &["node_cordon"]),
    ("node_drain", RESOURCES, &["node_drain"]),
    ("rollout_undo", WORKLOADS, &["rollout_undo"]),
    ("resource_set_image", WORKLOADS, &["resource_set_image"]),
    ("manifests_apply", MANIFESTS, &["manifests_apply"]),
    ("helm_rollback", HELM, &["helm_rollback"]),
    ("helm_uninstall", HELM, &["helm_uninstall"]),
    ("helm_upgrade_values", HELM, &["helm_upgrade_values"]),
    ("helm_install", HELM_CHARTS, &["helm_install"]),
    ("helm_upgrade", HELM_CHARTS, &["helm_upgrade"]),
    ("pod_debug", LOGS_DEBUG, &["pod_debug"]),
    ("pod_fs_upload", LOGS_DEBUG, &["pod_fs_upload"]),
    ("rightsizing_apply", COST, &["rightsizing_apply"]),
    ("custom_action_run", CUSTOM_ACTIONS, &["custom_action_run"]),
    // `terminal_create` → `Kubepit::prepare_terminal` (core `terminal.rs`),
    // which creates node-shell pods and launches terminal custom actions.
    (
        "terminal_create",
        CORE_TERMINAL,
        &["start_node_shell", "prepare_custom_action_terminal"],
    ),
];

/// Read-only, dry-run-only or local-state commands (explicitly listed).
const NOT_MUTATING: &[&str] = &[
    // App, settings, workspace, windows, updates (local state).
    "app_info",
    "settings_get",
    "settings_set",
    "workspace_load",
    "workspace_save",
    "reveal_path",
    "update_status",
    "update_check",
    "update_install",
    "window_open",
    // Kubeconfig discovery and the cluster registry (local state).
    "kubeconfig_discover",
    "kubeconfig_parse_file",
    "kubeconfig_parse_text",
    "kubeconfig_storage_set",
    "cluster_list",
    "cluster_add",
    "cluster_update",
    "cluster_remove",
    "cluster_connect",
    "cluster_disconnect",
    "cluster_statuses",
    "cluster_export_kubeconfig",
    "cluster_client_certificate",
    "cluster_proxy_info",
    // Reads: discovery, schemas, objects, watches, logs, metrics.
    "cluster_overview",
    "api_resources",
    "namespace_names",
    "openapi_v3_index",
    "openapi_v3_document",
    "resource_list",
    "resource_watch",
    "resource_unwatch",
    "resource_get",
    "resource_get_yaml",
    "resource_events",
    "rollout_history",
    "pod_logs_stream",
    "pod_logs_stop",
    "workload_logs_stream",
    "workload_logs_stop",
    "metrics_nodes",
    "metrics_pods",
    "metrics_history",
    "metrics_history_fleet",
    "prometheus_status",
    "prometheus_metrics",
    "prometheus_query_range",
    "loki_status",
    "loki_query_range",
    "loki_labels",
    "loki_label_values",
    "helm_releases",
    "helm_release_detail",
    "helm_release_revision",
    "helm_release_values_schema",
    "helm_chart_values_schema",
    "access_rules",
    "access_whoami",
    "fleet_search",
    "fleet_search_cancel",
    "changes_list",
    "changes_get",
    "upgrade_readiness_scan",
    "cost_status",
    "cost_report",
    "cost_summary",
    "rightsizing_report",
    "pod_fs_list",
    "pod_fs_read",
    "pod_fs_download",
    // Dry runs and access reviews (allowed on read-only clusters).
    "resource_dry_run_yaml",
    "manifests_dry_run",
    "pod_security_dry_run",
    "helm_upgrade_preview",
    "access_review",
    // Local manifests, files and Helm repositories (local state).
    "manifests_render",
    "manifests_fingerprint",
    "manifests_recent_list",
    "manifests_recent_remove",
    "local_file_read",
    "save_text_file",
    "helm_repo_list",
    "helm_repo_add",
    "helm_repo_remove",
    "helm_repo_update",
    "helm_chart_search",
    "helm_chart_versions",
    "helm_hub_search",
    "helm_chart_show",
    // Port forwards: local listeners over the API server's proxy.
    "port_forward_start",
    "port_forward_stop",
    "port_forward_list",
    "port_forward_saved_list",
    "port_forward_save",
    "port_forward_saved_update",
    "port_forward_unsave",
    "port_forward_saved_start",
    "port_forward_restart",
    "port_forward_local_port",
    // Persistent history and alerts (local state).
    "history_status",
    "history_audit_list",
    "history_audit_get",
    "history_audit_export",
    "history_events_list",
    "history_changes_list",
    "history_changes_get",
    "history_clear",
    "alerts_list",
    "alerts_mark_read",
    "alerts_clear",
    // Custom action definitions and previews (local state).
    "custom_actions_list",
    "custom_actions_save",
    "custom_actions_import",
    "custom_action_resolve",
    // Running terminals: input, size, flow control, teardown (a node
    // shell's helper pod is Kubepit's own and removed on destroy).
    "terminal_write",
    "terminal_resize",
    "terminal_acknowledge",
    "terminal_destroy",
];

/// Names between `generate_handler![` and `])` in `lib.rs`: the last `::`
/// segment of every entry, comments skipped.
fn registered() -> Vec<String> {
    let start = LIB
        .find("generate_handler![")
        .expect("generate_handler! in lib.rs");
    let rest = &LIB[start + "generate_handler![".len()..];
    let end = rest.find("])").expect("end of generate_handler!");
    rest[..end]
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("//"))
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.rsplit("::").next().unwrap_or(entry).to_string())
        .collect()
}

/// The body of `command` in `src`: from `pub async fn {command}(` to the next
/// `#[tauri::command]` or the end; the whole file when not found (core
/// sources).
fn body<'a>(src: &'a str, command: &str) -> &'a str {
    let Some(start) = src.find(&format!("pub async fn {command}(")) else {
        return src;
    };
    let rest = &src[start..];
    let end = rest.find("#[tauri::command]").unwrap_or(rest.len());
    &rest[..end]
}

#[test]
fn registration_is_parsed() {
    let names = registered();
    assert!(names.len() > 100, "{names:?}");
    for name in ["app_info", "window_open", "terminal_destroy"] {
        assert!(names.iter().any(|n| n == name), "{name} in {names:?}");
    }
    assert!(names.iter().all(|n| !n.contains(':') && !n.contains(' ')));
}

#[test]
fn every_registered_command_is_classified() {
    for name in registered() {
        let mutating = MUTATING.iter().any(|(c, ..)| *c == name);
        assert!(
            mutating ^ NOT_MUTATING.contains(&name.as_str()),
            "classify `{name}` in audit_coverage.rs (exactly once)"
        );
    }
}

#[test]
fn classification_has_no_stale_names() {
    let names = registered();
    for c in MUTATING
        .iter()
        .map(|(c, ..)| *c)
        .chain(NOT_MUTATING.iter().copied())
    {
        assert!(
            names.iter().any(|n| n == c),
            "`{c}` is not registered any more"
        );
    }
}

#[test]
fn mutating_commands_call_audited_entry_points() {
    for (command, source, methods) in MUTATING {
        for method in *methods {
            assert!(
                body(source, command).contains(&format!(".{method}(")),
                "`{command}` must call `{method}`"
            );
            assert!(
                AUDITED.contains(&format!("fn {method}(")),
                "`{method}` must be defined in history/audited.rs"
            );
        }
    }
    // The terminal row checks the core: the command must reach it.
    assert!(body(TERMINAL_COMMANDS, "terminal_create").contains(".prepare_terminal("));
}
