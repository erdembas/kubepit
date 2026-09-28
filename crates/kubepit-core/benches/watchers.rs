//! The background watchers' hot paths, fed with `l` scale-fixture objects:
//! the alert monitor (`Tracker`, `AlertBook`), the change journal
//! (`prepare`, `ClusterJournal::apply`, `details_after`) and the history
//! writer thread (SQLite in a temp dir). No network, no real cluster.

#[path = "../tests/support/mod.rs"]
mod support;

use std::hint::black_box;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use kube::api::DynamicObject;
use kube::runtime::watcher::Event;
use kubepit_core::alerts::book::AlertBook;
use kubepit_core::alerts::detect::{Finding, SlimPod, Tracker};
use kubepit_core::alerts::{AlertObjectRef, AlertReason};
use kubepit_core::change_journal::{self, ClusterJournal, JournalLimits, Prepared, Redactor};
use kubepit_core::history::db::EventRow;
use kubepit_core::history::writer::{WriteOp, Writer, QUEUE_CAPACITY};
use kubepit_core::types::Gvk;
use serde_json::{json, Value};
use support::perf::gvk;
use support::scale::{preset, ScaleCluster};

const CLUSTER: &str = "c-scale-l";
/// Journal entries' timestamps: fixed, well inside the 24 h age limit.
const TS: i64 = 1_790_000_000_000;

fn alerts(c: &mut Criterion, cluster: &ScaleCluster) {
    let pods: Vec<SlimPod> = cluster
        .objects("/api/v1/pods")
        .iter()
        .map(|pod| serde_json::from_value(pod.clone()).expect("a pod parses"))
        .collect();
    assert_eq!(pods.len(), 20_000);
    let mut group = c.benchmark_group("alerts");

    group.bench_function("tracker_initial_20k", |b| {
        b.iter_batched(
            || pods.clone(),
            |pods| {
                let mut tracker = Tracker::<SlimPod>::default();
                tracker.on_event(Event::Init);
                for pod in pods {
                    black_box(tracker.on_event(Event::InitApply(pod)));
                }
                tracker.on_event(Event::InitDone);
                tracker
            },
            BatchSize::LargeInput,
        )
    });

    group.bench_function("tracker_pod_update", |b| {
        let mut tracker = Tracker::<SlimPod>::default();
        tracker.on_event(Event::Init);
        for pod in &pods {
            tracker.on_event(Event::InitApply(pod.clone()));
        }
        tracker.on_event(Event::InitDone);
        let mut restarted = cluster.objects("/api/v1/pods")[10_000].clone();
        restarted["status"]["containerStatuses"][0]["restartCount"] = json!(1);
        let restarted: SlimPod = serde_json::from_value(restarted).unwrap();
        b.iter_batched(
            || restarted.clone(),
            |pod| tracker.on_event(Event::Apply(pod)),
            BatchSize::SmallInput,
        )
    });

    group.bench_function("book_record", |b| {
        // A full book (500 alerts); every record is a new alert on a new
        // object a minute after the previous one (no dedupe, no burst), so
        // it takes the slowest path: index, push and evict the oldest.
        let finding = Finding {
            reason: AlertReason::CrashLoopBackOff,
            container: Some("api".into()),
            condition: None,
            message: "back-off 5m0s restarting failed container".into(),
        };
        let object = |i: usize| AlertObjectRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some(format!("ns-{:04}", i % 400 + 1)),
            name: format!("app-{i:06}-api"),
        };
        let at = |i: usize| TS + i as i64 * 60_000;
        let mut book = AlertBook::with_limit(500);
        for i in 0..500 {
            book.record(CLUSTER, object(i), finding.clone(), at(i));
        }
        assert_eq!(book.len(), 500);
        let mut next = 500;
        b.iter_batched(
            || {
                next += 1;
                (object(next), finding.clone(), at(next))
            },
            |(object, finding, now)| book.record(CLUSTER, object, finding, now),
            BatchSize::SmallInput,
        );
        assert_eq!(book.len(), 500);
    });

    group.finish();
}

fn configmap_gvk() -> Arc<Gvk> {
    Arc::new(gvk("", "v1", "ConfigMap", "configmaps", true))
}

fn dynamic(value: &Value) -> DynamicObject {
    serde_json::from_value(value.clone()).expect("an object parses")
}

/// `configmap` with `LOG_LEVEL` set to `level`, prepared for the journal.
fn update(gvk: &Arc<Gvk>, redactor: &Redactor, configmap: &Value, level: usize) -> Prepared {
    let mut obj = dynamic(configmap);
    obj.data["data"]["LOG_LEVEL"] = json!(format!("debug-{level}"));
    change_journal::prepare(gvk, obj, redactor).expect("a ConfigMap is journaled")
}

/// A journal whose baseline holds `configmaps` (one source, listed).
fn journal_with(gvk: &Arc<Gvk>, redactor: &Redactor, configmaps: &[Value]) -> ClusterJournal {
    let mut journal = ClusterJournal::new(CLUSTER, TS, JournalLimits::default());
    journal.register_kind("ConfigMap");
    journal.register_source("configmaps", "ConfigMap");
    journal.begin_list("configmaps");
    for configmap in configmaps {
        let item = change_journal::prepare(gvk, dynamic(configmap), redactor).unwrap();
        journal.list_item("configmaps", item, TS);
    }
    journal.end_list("configmaps", TS);
    journal
}

fn journal(c: &mut Criterion, cluster: &ScaleCluster) {
    let gvk = configmap_gvk();
    let redactor = Redactor::new();
    let configmaps = cluster.objects("/api/v1/configmaps");
    assert_eq!(configmaps.len(), 10_000);
    let mut group = c.benchmark_group("journal");

    group.bench_function("prepare_configmap_4k", |b| {
        let mut big = configmaps[0].clone();
        big["data"] = (0..16)
            .map(|i| (format!("key-{i:02}"), json!(format!("{i:02}").repeat(128))))
            .collect::<serde_json::Map<_, _>>()
            .into();
        assert_eq!(serde_json::to_string(&big["data"]).unwrap().len() / 1024, 4);
        let big = dynamic(&big);
        b.iter_batched(
            || big.clone(),
            |obj| change_journal::prepare(&gvk, obj, &redactor),
            BatchSize::SmallInput,
        )
    });

    group.bench_function("apply_update", |b| {
        // Steady state: each apply is a real modification of the next
        // ConfigMap (recorded as an entry; the journal evicts past 5 000).
        let mut journal = journal_with(&gvk, &redactor, configmaps);
        assert_eq!(journal.tracked_objects(), 10_000);
        let mut next = 0;
        b.iter_batched(
            || {
                next += 1;
                let item = update(&gvk, &redactor, &configmaps[next % configmaps.len()], next);
                (item, TS + next as i64)
            },
            |(item, ts)| journal.apply("configmaps", item, ts),
            BatchSize::SmallInput,
        );
        assert!(!journal.is_empty());
    });

    group.bench_function("details_after_500", |b| {
        let mut journal = journal_with(&gvk, &redactor, configmaps);
        for (i, configmap) in configmaps.iter().enumerate().take(5_000) {
            let item = update(&gvk, &redactor, configmap, i);
            journal.apply("configmaps", item, TS + i as i64);
        }
        assert_eq!(journal.len(), 5_000);
        b.iter(|| {
            let details = journal.details_after(0, 500);
            assert_eq!(details.len(), 500);
            details
        })
    });

    group.finish();
}

fn history(c: &mut Criterion, cluster: &ScaleCluster) {
    let rows: Vec<EventRow> = cluster
        .objects("/api/v1/events")
        .iter()
        .take(10_000)
        .map(|event| EventRow::from_event(CLUSTER, event).expect("an Event row"))
        .collect();
    assert_eq!(rows.len(), 10_000);
    let mut group = c.benchmark_group("history");

    group.bench_function("writer_events_10k", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                let dir = tempfile::tempdir().unwrap();
                let writer = Writer::start(dir.path().join("history.db"), QUEUE_CAPACITY).unwrap();
                let batches: Vec<Vec<EventRow>> = rows.chunks(100).map(<[_]>::to_vec).collect();
                let start = Instant::now();
                for batch in batches {
                    writer.submit(WriteOp::Events(batch));
                }
                assert!(writer.flush(Duration::from_secs(10)), "flushed in 10 s");
                total += start.elapsed();
                let stats = writer.stats();
                assert_eq!(stats.dropped.load(Ordering::Relaxed), 0, "no write dropped");
                assert_eq!(stats.failed.load(Ordering::Relaxed), 0, "no write failed");
            }
            total
        })
    });

    group.finish();
}

fn watchers(c: &mut Criterion) {
    let cluster = ScaleCluster::generate(&preset("l"));
    alerts(c, &cluster);
    journal(c, &cluster);
    history(c, &cluster);
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(20);
    targets = watchers
}
criterion_main!(benches);
