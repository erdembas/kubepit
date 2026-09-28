//! Watch batching (`WatchAggregator`) at the `l` preset: 20 000 pods.
//!
//! - `watch/aggregator_initial_20k`: fold a whole initial list (`Init`,
//!   20 000 `InitApply`, `InitDone`) and drain the batches, flushing every
//!   `FLUSH_MAX_OBJECTS` pending objects like `run_watch` does.
//! - `watch/reset_batch_20k`: the full reset batch after a re-list.
//! - `watch/steady_500`: 500 updates on a synced watch, then one batch.
//!
//! Inputs come from the scale fixture (`tests/support/scale.rs`); nothing
//! touches the network.

#[path = "../tests/support/mod.rs"]
mod support;

use std::hint::black_box;
use std::time::{Duration, Instant};

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use kube::api::{ApiResource, DynamicObject};
use kube::runtime::watcher::Event;
use kubepit_core::objects::{api_resource, object_key, to_kube_object};
use kubepit_core::watch::{WatchAggregator, FLUSH_MAX_OBJECTS};
use serde_json::{json, Value};
use support::perf::pods;
use support::scale::{preset, ScaleCluster};

/// The `l` pods as the watcher delivers them.
fn l_pods() -> Vec<DynamicObject> {
    ScaleCluster::generate(&preset("l"))
        .objects("/api/v1/pods")
        .iter()
        .map(|pod| serde_json::from_value(pod.clone()).expect("a pod parses"))
        .collect()
}

/// Drain every pending batch; returns how many objects they carried.
fn drain(agg: &mut WatchAggregator) -> usize {
    let mut objects = 0;
    while let Some(batch) = agg.take_batch() {
        objects += batch.upserts.len();
        black_box(batch);
    }
    objects
}

/// One initial list folded like `run_watch` does it.
fn initial_sync(pods: Vec<DynamicObject>, ar: &ApiResource) -> WatchAggregator {
    let mut agg = WatchAggregator::new("w", 1);
    agg.on_event(0, Event::Init, ar);
    for pod in pods {
        agg.on_event(0, Event::InitApply(pod), ar);
        if agg.pending() >= FLUSH_MAX_OBJECTS {
            black_box(agg.take_batch());
        }
    }
    agg.on_event(0, Event::InitDone, ar);
    agg
}

fn watch(c: &mut Criterion) {
    let ar = api_resource(&pods());
    let pods = l_pods();
    assert_eq!(pods.len(), 20_000);
    let keyed: Vec<(String, Value)> = pods
        .iter()
        .map(|pod| (object_key(pod), to_kube_object(pod.clone(), &ar)))
        .collect();
    let mut group = c.benchmark_group("watch");

    group.bench_function("aggregator_initial_20k", |b| {
        b.iter_batched(
            || pods.clone(),
            |pods| {
                let mut agg = initial_sync(pods, &ar);
                drain(&mut agg);
                agg
            },
            BatchSize::LargeInput,
        )
    });

    group.bench_function("reset_batch_20k", |b| {
        // A synced watch whose source re-lists: the fresh list is buffered
        // and swapped in at `InitDone` (untimed); the reset batch that
        // follows carries every object (timed).
        let mut agg = WatchAggregator::new("w", 1);
        agg.on_init(0);
        for (key, value) in &keyed {
            agg.on_init_apply(0, key.clone(), value.clone());
        }
        agg.on_init_done(0);
        drain(&mut agg);
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                agg.on_init(0);
                for (key, value) in &keyed {
                    agg.on_init_apply(0, key.clone(), value.clone());
                }
                agg.on_init_done(0);
                let start = Instant::now();
                let batch = agg.take_batch().expect("a reset batch");
                total += start.elapsed();
                assert!(batch.reset && batch.upserts.len() == 20_000);
                drop(black_box(batch));
            }
            total
        })
    });

    group.bench_function("steady_500", |b| {
        let mut agg = initial_sync(pods.clone(), &ar);
        drain(&mut agg);
        let updates: Vec<(String, Value)> = keyed
            .iter()
            .step_by(keyed.len() / 500)
            .take(500)
            .map(|(key, value)| {
                let mut value = value.clone();
                value["status"]["containerStatuses"][0]["restartCount"] = json!(1);
                (key.clone(), value)
            })
            .collect();
        assert_eq!(updates.len(), 500);
        b.iter_batched(
            || updates.clone(),
            |updates| {
                for (key, value) in updates {
                    agg.on_apply(0, key, value);
                }
                agg.take_batch().expect("a batch of updates")
            },
            BatchSize::SmallInput,
        )
    });

    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(20);
    targets = watch
}
criterion_main!(benches);
