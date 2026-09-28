//! In-memory metrics history (`ClusterHistory`) at its caps: 5 000 pods
//! and 1 000 nodes, the ring full (240 samples of 15 s = one hour).
//!
//! - `metrics_history/record_5k_pods_1k_nodes`: one sampler tick.
//! - `metrics_history/series_cluster`: the cluster total series.
//! - `metrics_history/series_100_pods`: the summed series of 100 pods of one
//!   namespace (a large workload).

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use kubepit_core::metrics_history::{ClusterHistory, SAMPLE_INTERVAL, SLOTS};
use kubepit_core::types::{ContainerMetric, MetricsHistoryQuery, NodeMetric, PodMetric};

const PODS: usize = 5_000;
const NODES: usize = 1_000;
/// Pods per namespace, so one namespace holds the 100 queried pods.
const PODS_PER_NAMESPACE: usize = 100;
const START_MS: i64 = 1_790_000_000_000;

fn namespace(i: usize) -> String {
    format!("ns-{:04}", i / PODS_PER_NAMESPACE + 1)
}

fn pod_metrics() -> Vec<PodMetric> {
    (0..PODS)
        .map(|i| {
            let (cpu, memory) = ((5 + i * 13 % 200) as f64, ((64 + i * 7 % 128) << 20) as f64);
            PodMetric {
                namespace: namespace(i),
                name: format!("pod-{i:05}"),
                cpu_millicores: cpu,
                memory_bytes: memory,
                containers: vec![ContainerMetric {
                    name: "app".into(),
                    cpu_millicores: cpu,
                    memory_bytes: memory,
                }],
            }
        })
        .collect()
}

fn node_metrics() -> Vec<NodeMetric> {
    (1..=NODES)
        .map(|i| NodeMetric {
            name: format!("node-{i:04}"),
            cpu_millicores: (400 + i * 37 % 3000) as f64,
            memory_bytes: ((4096 + i * 53 % 16384) << 20) as f64,
        })
        .collect()
}

fn tick_ms(tick: usize) -> i64 {
    START_MS + tick as i64 * SAMPLE_INTERVAL.as_millis() as i64
}

/// A history with a full ring: `SLOTS` samples of every pod and node.
fn full_history(nodes: &[NodeMetric], pods: &[PodMetric]) -> ClusterHistory {
    let mut history = ClusterHistory::default();
    for tick in 0..SLOTS {
        history.record(tick_ms(tick), Some(nodes), Some(pods));
    }
    assert_eq!(history.tracked_pods(), PODS);
    history
}

fn metrics_history(c: &mut Criterion) {
    let (nodes, pods) = (node_metrics(), pod_metrics());
    let mut group = c.benchmark_group("metrics_history");

    group.bench_function("record_5k_pods_1k_nodes", |b| {
        let mut history = full_history(&nodes, &pods);
        let mut tick = SLOTS;
        b.iter(|| {
            history.record(tick_ms(tick), Some(&nodes), Some(&pods));
            tick += 1;
        })
    });

    let history = full_history(&nodes, &pods);
    group.bench_function("series_cluster", |b| {
        b.iter(|| history.series(black_box(&MetricsHistoryQuery::Cluster), 0))
    });

    let query = MetricsHistoryQuery::Pods {
        namespace: namespace(0),
        names: pods[..PODS_PER_NAMESPACE]
            .iter()
            .map(|p| p.name.clone())
            .collect(),
    };
    assert_eq!(history.series(&query, 0).len(), SLOTS);
    group.bench_function("series_100_pods", |b| {
        b.iter(|| history.series(black_box(&query), 0))
    });

    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(20);
    targets = metrics_history
}
criterion_main!(benches);
