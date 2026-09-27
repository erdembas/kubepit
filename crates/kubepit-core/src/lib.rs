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
//! | [`overview`]    | cluster dashboard aggregation                           |
//! | [`portforward`] | local TCP → pod / service forwarding                    |
//! | [`helm`]        | releases read from secrets, mutations via `helm`        |
//! | [`terminal`]    | PTY launch plans (local, exec, attach, node shell)      |
//!
//! Push notifications to the UI go through [`EventSink`]; streams take plain
//! `Fn(T) -> bool` callbacks (return `false` to stop) that the desktop shell
//! bridges to Tauri channels.

pub mod app;
pub mod cluster;
pub mod connection;
pub mod discovery;
pub mod error;
pub mod events;
pub mod helm;
pub mod kubeconfig;
pub mod logs;
pub mod metrics;
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

pub use app::Kubepit;
pub use events::{EventSink, NullSink};
pub use paths::Paths;
