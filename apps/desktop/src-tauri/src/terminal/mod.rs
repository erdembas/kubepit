//! Embedded terminals backed by a host PTY.
//!
//! The PTY manager and its bounded, acknowledged output pipeline are RunHQ's,
//! reused as-is: output is base64-encoded once and pushed through a typed
//! Tauri [`Channel`](tauri::ipc::Channel) per terminal, and the reader stops
//! when xterm falls more than a window behind, so a `cat` of a huge log can
//! never balloon memory.
//!
//! Kubepit extends `terminal_create` with a [`TerminalSpec`] (local shell,
//! `kubectl exec`, `kubectl attach`, node shell) resolved by
//! [`kubepit_core::terminal`], reports children that exit on their own via
//! `terminal://exit`, and runs per-terminal cleanup (node-shell pod deletion)
//! exactly once on exit or destroy.
//!
//! [`TerminalSpec`]: kubepit_core::types::TerminalSpec

pub mod commands;
mod manager;
mod pipeline;
mod pty_io;
mod shell;
mod types;

pub use commands::{
    terminal_acknowledge, terminal_create, terminal_destroy, terminal_resize, terminal_write,
};
pub use manager::{ExitHook, TerminalManager};
pub use types::TerminalOutput;
