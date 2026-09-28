//! Structural probe (large-cluster performance plan, Task 2): pins how many
//! watch streams each resource path gets and which collections are listed
//! without `limit=`, with every background watcher opted in, against a
//! scale fixture on the in-process fake API server. No real cluster.
//!
//! Where the stream counts come from: pods = the UI watch + alerts; nodes
//! and deployments = alerts + change journal; jobs = alerts; secrets and
//! configmaps = journal; events = history persistence. The unpaged lists are
//! the metrics sampler's NodeMetrics and PodMetrics. H1 (shared informers)
//! and H4 (paging) update these expectations.
//!
//! `s` runs with the normal tests (~3 s). The same snapshot at `m` and `l`:
//! `cargo test -p kubepit-core --test perf_probe -- --ignored --nocapture`.

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use support::perf::{
    gvk, persist_history, scale_setup, unpaged_lists, wait_synced, watch_streams_per_path,
};
use support::scale::{preset, ScaleCluster, ScaleServe};
use support::start;

/// Connect to preset `name` with every opt-in watcher on, wait for a
/// cluster-wide pods watch to sync, settle, and read the request log.
async fn snapshot(name: &str) -> (BTreeMap<String, usize>, BTreeSet<String>) {
    let cluster = Arc::new(ScaleCluster::generate(&preset(name)));
    let server = start(cluster.clone().router(ScaleServe::default())).await;
    let (_dir, app, id) = scale_setup(&server.url);
    app.set_alert_monitoring(true);
    app.set_change_journal_recording(true);
    app.set_history_recording(true);
    app.set_metrics_sampling(true);
    persist_history(&app, &id);
    app.cluster_connect(&id).await.unwrap();
    wait_synced(&app, &id, &gvk("", "v1", "Pod", "pods", true)).await; // resource_watch, cluster-wide
    tokio::time::sleep(Duration::from_secs(2)).await;

    let fanout = watch_streams_per_path(&server.log);
    let unpaged = unpaged_lists(&server.log, &cluster);
    println!("[{name}] watch streams per path: {fanout:#?}\n[{name}] unpaged lists: {unpaged:#?}");
    (fanout, unpaged)
}

fn assert_snapshot(name: &str, fanout: &BTreeMap<String, usize>, unpaged: &BTreeSet<String>) {
    let pinned = [
        ("/api/v1/pods", 2),
        ("/api/v1/nodes", 2),
        ("/apis/apps/v1/deployments", 2),
        ("/apis/batch/v1/jobs", 1),
        ("/api/v1/secrets", 1),
        ("/api/v1/configmaps", 1),
        ("/api/v1/events", 1),
    ];
    for (path, streams) in pinned {
        assert_eq!(
            fanout.get(path),
            Some(&streams),
            "[{name}] {path}: {fanout:#?}"
        );
    }
    // Every other path (the journal's remaining kinds) has one stream.
    for (path, streams) in fanout {
        if !pinned.iter().any(|(p, _)| p == path) {
            assert_eq!(*streams, 1, "[{name}] {path}: {fanout:#?}");
        }
    }
    assert_eq!(
        *unpaged,
        BTreeSet::from([
            "/apis/metrics.k8s.io/v1beta1/nodes".to_string(),
            "/apis/metrics.k8s.io/v1beta1/pods".to_string(),
        ]),
        "[{name}]"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn watch_fanout_and_pagination_snapshot() {
    let (fanout, unpaged) = snapshot("s").await;
    assert_snapshot("s", &fanout, &unpaged);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "slow (m and l presets): run with --ignored"]
async fn watch_fanout_and_pagination_at_m_and_l() {
    for name in ["m", "l"] {
        let (fanout, unpaged) = snapshot(name).await;
        assert_snapshot(name, &fanout, &unpaged);
    }
}
