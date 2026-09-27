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

pub use app::Kubepit;
pub use events::{EventSink, NullSink};
pub use paths::Paths;
