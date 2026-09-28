//! Kubepit core — headless Kubernetes and persistence logic.
//!
//! This crate is deliberately free of any Tauri, window, or UI dependency,
//! which keeps it fast to test (no desktop runtime in CI) and easy to reason
//! about: data + services, side effects explicit.
//!
//! The entry point is [`Kubepit`], one instance per process. Its operations
//! are spread over focused modules as `impl Kubepit` blocks:
//!
//! | Module          | Responsibility                                          |
//! |-----------------|---------------------------------------------------------|
//! | [`store`]       | `clusters.json`, `settings.json`, `workspace.json`      |
//! | [`kubeconfig`]  | discovery, parsing, single-context generation           |
//! | [`cluster`]     | registry add / update / remove / export                 |
//! | [`connection`]  | client pool, connect / disconnect, platform detection   |
//! | [`discovery`]   | served API resources, namespaces                        |
//! | [`resources`]   | generic list / get / apply / patch / delete / scale     |
//! | [`nodes`]       | cordon and drain                                        |
//! | [`watch`]       | batched watches (`WatchBatch`)                          |
//! | [`logs`]        | pod log streaming (`LogChunk`)                          |
//! | [`metrics`]     | metrics-server usage                                    |
//! | [`metrics_history`] | in-memory usage history (per-cluster samplers)      |
//! | [`overview`]    | cluster dashboard aggregation                           |
//! | [`portforward`] | local TCP → pod / service forwarding                    |
//! | [`helm`]        | releases read from secrets, mutations via `helm`        |
//! | [`helm_charts`] | repositories, chart catalog, install / upgrade          |
//! | [`terminal`]    | PTY launch plans (local, exec, attach, node shell)      |
//! | [`access`]      | RBAC self-reviews (can-i, rules, whoami)                |
//! | [`rollout`]     | rollout history and undo (ReplicaSets, ControllerRevs)  |
//! | [`images`]      | set image (strategic merge of container images)         |
//! | [`dry_run`]     | server-side dry run of manifests before apply           |
//! | [`fleet_search`] | name search across every connected cluster            |
//! | [`workload_logs`] | merged logs of every pod of a workload (stern-style) |
//! | [`debug_container`] | ephemeral debug containers (`kubectl debug`)       |
//! | [`pod_fs`]      | container file browser and copy over exec              |
//! | [`updates`]     | updater config, update IPC types, download progress    |
//! | [`alerts`]      | transition alerts, dedupe, notification center history |
//! | [`client_cert`] | kubeconfig client certificate subject and expiry       |
//! | [`prometheus`]  | Prometheus detection, preset + PromQL range queries    |
//! | [`loki`]        | Loki detection, LogQL range queries, label browsing    |
//! | [`service_proxy`] | shared API server service-proxy transport           |
//! | [`openapi`]     | OpenAPI v3 schemas (YAML editing, API explorer)        |
//! | [`saved_forwards`] | saved port forwards, start on connect               |
//! | [`kubeconfig_watch`] | kubeconfig file watching (`kubeconfig://changed`) |
//! | [`proxy`]       | per-cluster proxy (`proxy-url` / override)             |
//! | [`secrets`]     | OS credential store behind `SecretStore`               |
//! | [`credentials`] | managed kubeconfig storage, keychain migration         |
//! | [`manifests`]   | local manifests: render folders, diff / apply to clusters |
//! | [`change_journal`] | in-memory change timeline (per-cluster watchers)    |
//! | [`local_files`] | bounded reads of user-picked files (resource wizards)  |
//! | [`upgrade`]     | upgrade readiness: deprecated / removed API usage      |
//! | [`helm_preview`] | Helm values schemas, upgrade preview (helm-diff)      |
//! | [`history`]     | SQLite audit log, persisted events and changes         |
//! | [`custom_actions`] | user-defined actions (k9s-plugin style), `actions.json` |
//! | [`pod_security`] | Pod Security enforce dry run ("what would break")     |
//! | [`cost`]        | cost insight: OpenCost / Kubecost / estimates           |
//! | [`rightsizing`] | request recommendations and their patches              |
//!
//! Push notifications to the UI go through [`EventSink`]; streams take plain
//! `Fn(T) -> bool` callbacks (return `false` to stop) that the desktop shell
//! bridges to Tauri channels.

pub mod access;
pub mod app;
pub mod cluster;
pub mod connection;
pub mod discovery;
pub mod error;
pub mod events;
pub mod fleet_search;
pub mod helm;
pub mod helm_charts;
pub mod kubeconfig;
pub mod logs;
pub mod metrics;
pub mod metrics_history;
pub mod node_shell;
pub mod nodes;
pub mod objects;
pub mod overview;
pub mod paths;
pub mod platform;
pub mod portforward;
pub mod quantity;
pub mod resources;
pub mod shell_env;
pub mod store;
pub mod tasks;
pub mod terminal;
pub mod tools;
pub mod types;
pub mod watch;

// Workload operations: rollout history / undo, set image, dry-run review.
pub mod dry_run;
pub mod images;
pub mod rollout;
// Logs & debug: merged workload logs, debug containers, container files.
pub mod debug_container;
pub mod pod_fs;
pub mod workload_logs;
// In-app updates (the updater itself lives in the desktop shell).
pub mod updates;
// Alerts: desktop notifications and the notification center.
pub mod alerts;
// Insights: kubeconfig client certificate expiry (health checks live in the UI).
pub mod client_cert;
// Prometheus: provider detection and range queries over the service proxy.
pub mod prometheus;
// Loki: historical logs over the same service-proxy transport.
pub mod loki;
pub mod service_proxy;
// Schema-aware YAML editing and the API explorer.
pub mod openapi;
// Connectivity: saved port forwards, kubeconfig watching, proxies, keychain.
pub mod credentials;
pub mod kubeconfig_watch;
pub mod proxy;
pub mod saved_forwards;
pub mod secrets;
// Local manifests: render folders / Kustomize / Helm, diff and apply.
pub mod manifests;
// Change timeline: in-memory journal of cluster changes.
pub mod change_journal;
// Resource wizards: bounded reads of user-picked local files.
pub mod local_files;
// Upgrade readiness (deprecated APIs), Helm values schemas and upgrade preview.
pub mod helm_preview;
pub mod upgrade;
// Persistent history: own-action audit log, persisted events and changes.
pub mod history;
// Power user: custom actions (k9s-plugin style).
pub mod custom_actions;
// Security: Pod Security Standards enforce dry run.
pub mod pod_security;
// Cost insight and right-sizing recommendations.
pub mod cost;
pub mod rightsizing;

pub use app::Kubepit;
pub use events::{EventSink, NullSink};
pub use paths::Paths;
