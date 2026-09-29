//! Every registered Tauri command is classified; every mutating one must call
//! an audited entry point defined in `kubepit-core/src/history/audited.rs`.
//!
//! Adding a command to `generate_handler!` fails
//! `every_registered_command_is_classified` until it is listed below. A
//! mutating command goes to [`MUTATING`] with the core methods it calls; those
//! must be the audited wrappers, so the audit log cannot be bypassed.

const LIB: &str = include_str!("../lib.rs");
const AUDITED: &str = include_str!("../../../../../crates/kubepit-core/src/history/audited.rs");

/// A source file: (name for messages, contents).
type Source = (&'static str, &'static str);

const CORE_TERMINAL: Source = (
    "kubepit-core/src/terminal.rs",
    include_str!("../../../../../crates/kubepit-core/src/terminal.rs"),
);
const TERMINAL_COMMANDS: Source = (
    "terminal/commands.rs",
    include_str!("../terminal/commands.rs"),
);
const RESOURCES: Source = ("ipc/resources.rs", include_str!("resources.rs"));
const WORKLOADS: Source = ("ipc/workloads.rs", include_str!("workloads.rs"));
const MANIFESTS: Source = ("ipc/manifests.rs", include_str!("manifests.rs"));
const HELM: Source = ("ipc/helm.rs", include_str!("helm.rs"));
const HELM_CHARTS: Source = ("ipc/helm_charts.rs", include_str!("helm_charts.rs"));
const LOGS_DEBUG: Source = ("ipc/logs_debug.rs", include_str!("logs_debug.rs"));
const COST: Source = ("ipc/cost.rs", include_str!("cost.rs"));
const CUSTOM_ACTIONS: Source = ("ipc/custom_actions.rs", include_str!("custom_actions.rs"));

/// Mutating IPC commands: (command, its source). Each command's body must
/// call the core method of the same name, defined in `history/audited.rs`.
const MUTATING: &[(&str, Source)] = &[
    ("resource_apply_yaml", RESOURCES),
    ("resource_delete", RESOURCES),
    ("resource_patch", RESOURCES),
    ("resource_scale", RESOURCES),
    ("resource_restart", RESOURCES),
    ("cronjob_trigger", RESOURCES),
    ("node_cordon", RESOURCES),
    ("node_drain", RESOURCES),
    ("rollout_undo", WORKLOADS),
    ("resource_set_image", WORKLOADS),
    ("manifests_apply", MANIFESTS),
    ("helm_rollback", HELM),
    ("helm_uninstall", HELM),
    ("helm_upgrade_values", HELM),
    ("helm_install", HELM_CHARTS),
    ("helm_upgrade", HELM_CHARTS),
    ("pod_debug", LOGS_DEBUG),
    ("pod_fs_upload", LOGS_DEBUG),
    ("rightsizing_apply", COST),
    ("custom_action_run", CUSTOM_ACTIONS),
];

/// Mutating commands that reach the core through another function:
/// (command, source, function of `source` whose body must call the methods,
/// audited core methods).
const MUTATING_VIA: &[(&str, Source, &str, &[&str])] = &[
    // `terminal_create` calls `Kubepit::prepare_terminal` (checked below),
    // which creates node-shell pods and launches terminal custom actions.
    (
        "terminal_create",
        CORE_TERMINAL,
        "prepare_terminal",
        &["start_node_shell", "prepare_custom_action_terminal"],
    ),
];

/// Every mutating command with the function to inspect and the methods it
/// must call.
fn mutating() -> Vec<(&'static str, Source, &'static str, Vec<&'static str>)> {
    MUTATING
        .iter()
        .map(|&(command, source)| (command, source, command, vec![command]))
        .chain(
            MUTATING_VIA
                .iter()
                .map(|&(command, source, function, methods)| {
                    (command, source, function, methods.to_vec())
                }),
        )
        .collect()
}

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
    "cluster_kubeconfig_source",
    "cluster_reimport_kubeconfig",
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
    "api_resources_refresh",
    "namespace_names",
    "openapi_v3_index",
    "openapi_v3_document",
    "resource_list",
    "resource_watch",
    "resource_unwatch",
    "resource_watch_ack",
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
    // Recommendations: scans list and query (read-only for the cluster);
    // stored runs, trends, the fleet and exports are local state.
    "recommendations_status",
    "recommendations_scan",
    "recommendations_latest",
    "recommendations_runs",
    "recommendations_trend",
    "recommendations_usage_history",
    "recommendations_fleet",
    "recommendations_export",
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
    "manifests_watch",
    "manifests_unwatch",
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
    // Assistant: local settings, keys, previews and request history. Its
    // tools are read-only; suggested mutations use the audited editor path.
    // Model requests are recorded separately in ai_log by the session guard.
    "ai_status",
    "ai_key_set",
    "ai_key_delete",
    "ai_models",
    "ai_cluster_set",
    "ai_preview",
    "ai_send",
    "ai_tool_decision",
    "ai_cancel",
    "ai_session_end",
    "ai_log_list",
    "ai_log_get",
    "ai_log_export",
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

/// The body of `fn {function}` in `src` (`name`, for messages): from its
/// line to the closing brace at the same indentation. Panics unless the
/// function is defined exactly once, so a renamed, moved or generic command
/// cannot pass by accident.
fn body<'a>(src: &'a str, name: &str, function: &str) -> &'a str {
    let needles = [format!("fn {function}("), format!("fn {function}<")];
    let found: Vec<usize> = needles
        .iter()
        .flat_map(|needle| src.match_indices(needle.as_str()).map(|(i, _)| i))
        .collect();
    let [start] = found[..] else {
        panic!(
            "`fn {function}` is defined {} times in {name}; update audit_coverage.rs",
            found.len()
        );
    };
    let line = src[..start].rfind('\n').map_or(0, |i| i + 1);
    let indent: String = src[line..].chars().take_while(|c| *c == ' ').collect();
    let close = format!("\n{indent}}}\n");
    let end = src[start..]
        .find(&close)
        .unwrap_or_else(|| panic!("the end of `fn {function}` in {name} was not found"));
    &src[line..start + end + close.len()]
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
fn body_finds_exactly_one_function() {
    let src = "#[tauri::command]\npub async fn a(x: u8) -> u8 {\n    x.b()\n}\n\n#[tauri::command]\npub fn c() {}\n";
    assert_eq!(
        body(src, "test", "a"),
        "pub async fn a(x: u8) -> u8 {\n    x.b()\n}\n"
    );
    let generic = "    pub async fn g<R: Runtime>(r: R) {\n        r.h()\n    }\n";
    assert!(body(generic, "test", "g").contains(".h("));
    assert!(std::panic::catch_unwind(|| body(src, "test", "missing")).is_err());
    assert!(std::panic::catch_unwind(|| body("fn a() {\n}\nfn a() {\n}\n", "test", "a")).is_err());
}

#[test]
fn every_registered_command_is_classified() {
    let rows = mutating();
    let mut unclassified = Vec::new();
    let mut twice = Vec::new();
    for name in registered() {
        let mutating = rows.iter().any(|(c, ..)| *c == name);
        match (mutating, NOT_MUTATING.contains(&name.as_str())) {
            (false, false) => unclassified.push(name),
            (true, true) => twice.push(name),
            _ => {}
        }
    }
    assert!(
        unclassified.is_empty() && twice.is_empty(),
        "classify in audit_coverage.rs: {unclassified:?}; listed as both mutating and not: {twice:?}"
    );
}

#[test]
fn classification_has_no_stale_names() {
    let names = registered();
    let stale: Vec<&str> = mutating()
        .into_iter()
        .map(|(c, ..)| c)
        .chain(NOT_MUTATING.iter().copied())
        .filter(|c| !names.iter().any(|n| n == c))
        .collect();
    assert!(stale.is_empty(), "not registered any more: {stale:?}");
}

#[test]
fn mutating_commands_call_audited_entry_points() {
    let mut problems = Vec::new();
    for (command, source, function, methods) in mutating() {
        let code = body(source.1, source.0, function);
        for method in methods {
            if !code.contains(&format!(".{method}(")) {
                problems.push(format!("`{command}` ({function}) must call `{method}`"));
            }
            if !AUDITED.contains(&format!("fn {method}(")) {
                problems.push(format!("`{method}` must be defined in history/audited.rs"));
            }
        }
    }
    // The terminal row checks `prepare_terminal`: the command must reach it.
    let terminal = body(TERMINAL_COMMANDS.1, TERMINAL_COMMANDS.0, "terminal_create");
    if !terminal.contains(".prepare_terminal(") {
        problems.push("`terminal_create` must call `prepare_terminal`".to_string());
    }
    assert!(problems.is_empty(), "{problems:#?}");
}
