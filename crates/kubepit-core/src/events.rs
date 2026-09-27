//! Event sink abstraction.
//!
//! Core never talks to Tauri. State changes that the UI must hear about
//! without polling (connection status, registry edits, port-forward
//! transitions) are pushed through this trait; the desktop shell implements
//! it on top of `AppHandle::emit`, tests use [`NullSink`] or a recorder.

use crate::types::{ClusterDef, ClusterStatus, KubeconfigChanged, PortForward, SavedPortForward};

pub trait EventSink: Send + Sync + 'static {
    /// `cluster://status` — one cluster's connection state changed.
    fn cluster_status(&self, status: &ClusterStatus);
    /// `cluster://list` — the full registry after any change.
    fn cluster_list(&self, clusters: &[ClusterDef]);
    /// `portforward://changed` — the full list of port forwards.
    fn port_forwards(&self, forwards: &[PortForward]);
    /// `portforward://saved` — the full list of saved port forwards.
    fn saved_port_forwards(&self, _saved: &[SavedPortForward]) {}
    /// `kubeconfig://changed` — watched kubeconfig files changed.
    fn kubeconfig_changed(&self, _change: &KubeconfigChanged) {}
}

/// Sink that drops every event (tests, headless tools).
#[derive(Default, Clone, Copy)]
pub struct NullSink;

impl EventSink for NullSink {
    fn cluster_status(&self, _status: &ClusterStatus) {}
    fn cluster_list(&self, _clusters: &[ClusterDef]) {}
    fn port_forwards(&self, _forwards: &[PortForward]) {}
}
