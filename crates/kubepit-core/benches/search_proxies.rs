//! Fleet-search name matching and the Prometheus / Loki response parsers.
//!
//! - `fleet_search/matcher_{substring,glob,regex}_50k`: parse a pattern,
//!   then match 50 000 `l` object names (pods, ReplicaSets, ConfigMaps,
//!   Secrets, Services).
//! - `prometheus/parse_200x240`: a matrix of 200 series × 240 points.
//! - `loki/parse_5000_lines_50_streams`: 50 streams × 100 lines, backward.

#[path = "../tests/support/mod.rs"]
mod support;

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use kubepit_core::fleet_search::NameMatcher;
use kubepit_core::loki::parse::parse_query;
use kubepit_core::prometheus::parse::parse_response;
use kubepit_core::types::LokiDirection;
use serde_json::{json, Value};
use support::scale::{preset, ScaleCluster};

/// Epoch seconds of the first sample (1 h window at 15 s steps).
const START_SECS: i64 = 1_790_000_000;

fn names() -> Vec<String> {
    let cluster = ScaleCluster::generate(&preset("l"));
    let names: Vec<String> = [
        "/api/v1/pods",
        "/apis/apps/v1/replicasets",
        "/api/v1/configmaps",
        "/api/v1/secrets",
        "/api/v1/services",
    ]
    .iter()
    .flat_map(|path| cluster.objects(path))
    .map(|obj| obj["metadata"]["name"].as_str().unwrap().to_string())
    .collect();
    assert_eq!(names.len(), 50_000);
    names
}

fn fleet_search(c: &mut Criterion) {
    let names = names();
    let mut group = c.benchmark_group("fleet_search");
    for (id, pattern) in [
        ("matcher_substring_50k", "api"),
        ("matcher_glob_50k", "app-*-api"),
        ("matcher_regex_50k", "/^app-0[0-9]+-api$/"),
    ] {
        let expected = {
            let matcher = NameMatcher::parse(pattern).unwrap();
            names.iter().filter(|n| matcher.matches(n)).count()
        };
        assert!(expected > 0, "{pattern} matches something");
        group.bench_function(id, |b| {
            b.iter(|| {
                let matcher = NameMatcher::parse(black_box(pattern)).unwrap();
                let hits = names.iter().filter(|n| matcher.matches(n)).count();
                assert_eq!(hits, expected);
                hits
            })
        });
    }
    group.finish();
}

/// A Prometheus `query_range` matrix body: `series` × `points`.
fn matrix(series: usize, points: usize) -> String {
    let result: Vec<Value> = (0..series)
        .map(|s| {
            let values: Vec<Value> = (0..points)
                .map(|p| {
                    let value = format!("{:.6}", 0.05 + ((s * 31 + p * 7) % 1000) as f64 / 997.0);
                    json!([START_SECS + p as i64 * 15, value])
                })
                .collect();
            json!({"metric": {"namespace": format!("ns-{:04}", s % 400 + 1),
                              "pod": format!("app-{:04}-api-kbf2jnh5rf-6gdhk", s + 1),
                              "container": "api"},
                   "values": values})
        })
        .collect();
    json!({"status": "success", "data": {"resultType": "matrix", "result": result}}).to_string()
}

/// A Loki `query_range` streams body: `streams` × `lines` log lines.
fn streams(streams: usize, lines: usize) -> String {
    let result: Vec<Value> = (0..streams)
        .map(|s| {
            let values: Vec<Value> = (0..lines)
                .map(|l| {
                    let ns = (START_SECS + (l * streams + s) as i64) * 1_000_000_000;
                    json!([
                        ns.to_string(),
                        format!(
                            "level=info ts={ns} msg=\"GET /api/v1/items/{l} 200\" \
                                    duration_ms={} stream={s}",
                            l % 97
                        )
                    ])
                })
                .collect();
            json!({"stream": {"namespace": format!("ns-{:04}", s + 1),
                              "pod": format!("app-{:04}-api-kbf2jnh5rf-6gdhk", s + 1),
                              "container": "api"},
                   "values": values})
        })
        .collect();
    json!({"status": "success",
           "data": {"resultType": "streams", "result": result, "stats": {}}})
    .to_string()
}

fn proxies(c: &mut Criterion) {
    let prom = matrix(200, 240);
    let parsed = parse_response(&prom).unwrap();
    assert_eq!(parsed.series.len(), 200);
    assert!(parsed.series.iter().all(|s| s.points.len() == 240));
    let mut group = c.benchmark_group("prometheus");
    group.bench_function("parse_200x240", |b| {
        b.iter(|| parse_response(black_box(&prom)).unwrap())
    });
    group.finish();

    let loki = streams(50, 100);
    let parsed = parse_query(&loki, LokiDirection::Backward, 5_000).unwrap();
    assert_eq!((parsed.streams.len(), parsed.lines.len()), (50, 5_000));
    let mut group = c.benchmark_group("loki");
    group.bench_function("parse_5000_lines_50_streams", |b| {
        b.iter(|| parse_query(black_box(&loki), LokiDirection::Backward, 5_000).unwrap())
    });
    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(20);
    targets = fleet_search, proxies
}
criterion_main!(benches);
