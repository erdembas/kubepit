//! Event sink abstraction.
//!
//! Core never talks to Tauri. State changes that the UI must hear about
//! without polling (connection status, registry edits, port-forward
//! transitions) are pushed through this trait; the desktop shell implements
//! it on top of `AppHandle::emit`, tests use [`NullSink`] or a recorder.

use crate::alerts::AlertEvent;
use crate::types::{ClusterDef, ClusterStatus, PortForward};

pub trait EventSink: Send + Sync + 'static {
    /// `cluster://status` — one cluster's connection state changed.
    fn cluster_status(&self, status: &ClusterStatus);
    /// `cluster://list` — the full registry after any change.
    fn cluster_list(&self, clusters: &[ClusterDef]);
    /// `portforward://changed` — the full list of port forwards.
    fn port_forwards(&self, forwards: &[PortForward]);
    /// `alerts://new` — an alert was raised (`fresh`) or a repeat merged
    /// into an existing one. No-op by default.
    fn alert(&self, _event: &AlertEvent) {}
    /// `alerts://changed` — alerts were marked read or cleared.
    fn alerts_changed(&self) {}
}

/// Sink that drops every event (tests, headless tools).
#[derive(Default, Clone, Copy)]
pub struct NullSink;

impl EventSink for NullSink {
    fn cluster_status(&self, _status: &ClusterStatus) {}
    fn cluster_list(&self, _clusters: &[ClusterDef]) {}
    fn port_forwards(&self, _forwards: &[PortForward]) {}
}
