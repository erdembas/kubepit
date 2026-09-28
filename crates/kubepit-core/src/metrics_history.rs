//! Metrics history: a short in-memory time series of metrics-server usage,
//! so charts work without Prometheus.
//!
//! Sampling is opt-in per process ([`Kubepit::set_metrics_sampling`]; the
//! desktop shell turns it on, tests and headless tools do not). While it is
//! on and a cluster is connected, one sampler task (started after a
//! successful connect, stopped on disconnect, removal and shutdown) polls
//! `metrics.k8s.io` every [`SAMPLE_INTERVAL`] and appends to fixed-size ring
//! buffers covering the last [`HISTORY_WINDOW`]:
//!
//! - the cluster total: sum of nodes (sum of pods when nodes are forbidden),
//! - every node,
//! - every pod (`namespace/name`), at most [`MAX_PODS`]; pods unseen for
//!   [`POD_TTL`] are evicted.
//!
//! The sampler honours the [`MetricsGate`]: while metrics-server is known to
//! be missing it does not sample, and the gate's recheck picks up a
//! metrics-server installed later. A cluster's history is dropped when it
//! disconnects.
//!
//! Memory budget: timestamps are stored once per cluster; a series costs
//! `SLOTS` × 2 × f32 = 1.9 KiB plus its key and map entry (≈ 2.1 KiB). A
//! typical cluster (20 nodes, 400 pods) holds ≈ 0.9 MiB, the worst case
//! (5 000 pods) ≈ 11 MiB.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use kube::Client;
use parking_lot::Mutex;

use crate::app::Kubepit;
use crate::metrics::{node_metrics, pod_metrics, MetricsGate};
use crate::objects::now_millis;
use crate::tasks::TaskRegistry;
use crate::types::{MetricsHistoryQuery, MetricsPoint, MetricsSeries, NodeMetric, PodMetric};

/// Time between two samples.
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(15);
/// How far back the history reaches.
pub const HISTORY_WINDOW: Duration = Duration::from_secs(60 * 60);
/// Ring buffer length (one slot per sample).
pub const SLOTS: usize = (HISTORY_WINDOW.as_secs() / SAMPLE_INTERVAL.as_secs()) as usize;
/// Pods tracked per cluster; new pods beyond the cap are not recorded.
pub const MAX_PODS: usize = 5_000;
/// Nodes and pods not seen for this long are evicted.
pub const POD_TTL: Duration = Duration::from_secs(10 * 60);
/// Bucket width of the downsampled dashboard series.
pub const FLEET_BUCKET: Duration = Duration::from_secs(60);
/// Upper bound for one metrics request.
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(10);

const TTL_TICKS: u64 = POD_TTL.as_secs() / SAMPLE_INTERVAL.as_secs();

/// One series: `[cpu_millicores, memory_bytes]` per slot, NaN = no sample.
struct Ring {
    values: Box<[[f32; 2]]>,
    /// Tick of the most recent sample written.
    last_tick: u64,
}

impl Ring {
    fn new() -> Self {
        Self {
            values: vec![[f32::NAN; 2]; SLOTS].into_boxed_slice(),
            last_tick: 0,
        }
    }

    fn write(&mut self, slot: usize, tick: u64, cpu: f64, memory: f64) {
        self.values[slot] = [cpu as f32, memory as f32];
        self.last_tick = tick;
    }

    fn clear(&mut self, slot: usize) {
        self.values[slot] = [f32::NAN; 2];
    }

    fn get(&self, slot: usize) -> Option<(f64, f64)> {
        let [cpu, memory] = self.values[slot];
        (!cpu.is_nan()).then_some((f64::from(cpu), f64::from(memory)))
    }
}

fn pod_key(namespace: &str, name: &str) -> String {
    format!("{namespace}/{name}")
}

fn sum(items: impl Iterator<Item = (f64, f64)>) -> (f64, f64) {
    items.fold((0.0, 0.0), |(c, m), (ic, im)| (c + ic, m + im))
}

/// The ring buffers of one cluster. Pure bookkeeping, no I/O.
pub struct ClusterHistory {
    /// Samples recorded so far; the next one goes to `ticks % SLOTS`.
    ticks: u64,
    /// Epoch ms per slot.
    timestamps: Box<[i64]>,
    total: Ring,
    nodes: HashMap<String, Ring>,
    pods: HashMap<String, Ring>,
    max_pods: usize,
    /// Whether the last sampling attempt reached metrics-server.
    available: bool,
}

impl Default for ClusterHistory {
    fn default() -> Self {
        Self::with_pod_cap(MAX_PODS)
    }
}

impl ClusterHistory {
    pub fn with_pod_cap(max_pods: usize) -> Self {
        Self {
            ticks: 0,
            timestamps: vec![0; SLOTS].into_boxed_slice(),
            total: Ring::new(),
            nodes: HashMap::new(),
            pods: HashMap::new(),
            max_pods,
            available: true,
        }
    }

    /// Append one sample taken at `ts` (epoch ms). `None` parts were not
    /// readable this time (forbidden, failed) and leave a gap.
    pub fn record(&mut self, ts: i64, nodes: Option<&[NodeMetric]>, pods: Option<&[PodMetric]>) {
        let tick = self.ticks;
        let slot = (tick % SLOTS as u64) as usize;
        self.timestamps[slot] = ts;

        // Evict before inserting so churn frees room for new pods.
        let stale = |ring: &Ring| tick - ring.last_tick >= TTL_TICKS;
        self.nodes.retain(|_, ring| !stale(ring));
        self.pods.retain(|_, ring| !stale(ring));

        let total = match (nodes, pods) {
            (Some(nodes), _) => Some(sum(nodes
                .iter()
                .map(|n| (n.cpu_millicores, n.memory_bytes)))),
            (None, Some(pods)) => {
                Some(sum(pods.iter().map(|p| (p.cpu_millicores, p.memory_bytes))))
            }
            (None, None) => None,
        };
        match total {
            Some((cpu, memory)) => self.total.write(slot, tick, cpu, memory),
            None => self.total.clear(slot),
        }

        for node in nodes.unwrap_or_default() {
            self.nodes
                .entry(node.name.clone())
                .or_insert_with(Ring::new)
                .write(slot, tick, node.cpu_millicores, node.memory_bytes);
        }
        for pod in pods.unwrap_or_default() {
            let key = pod_key(&pod.namespace, &pod.name);
            if let Some(ring) = self.pods.get_mut(&key) {
                ring.write(slot, tick, pod.cpu_millicores, pod.memory_bytes);
            } else if self.pods.len() < self.max_pods {
                let mut ring = Ring::new();
                ring.write(slot, tick, pod.cpu_millicores, pod.memory_bytes);
                self.pods.insert(key, ring);
            }
        }

        // The slot still holds the sample from one window ago for every
        // series that was not written this tick.
        for ring in self.nodes.values_mut().chain(self.pods.values_mut()) {
            if ring.last_tick != tick {
                ring.clear(slot);
            }
        }
        self.ticks += 1;
        self.available = true;
    }

    pub fn mark_unavailable(&mut self) {
        self.available = false;
    }

    pub fn available(&self) -> bool {
        self.available
    }

    pub fn tracked_pods(&self) -> usize {
        self.pods.len()
    }

    /// Points of `query` at or after `since` (epoch ms), oldest first. Named
    /// series are summed per sample; a sample in which none of them was
    /// present is left out.
    pub fn series(&self, query: &MetricsHistoryQuery, since: i64) -> Vec<MetricsPoint> {
        let rings: Vec<&Ring> = match query {
            MetricsHistoryQuery::Cluster => vec![&self.total],
            MetricsHistoryQuery::Nodes { names } => {
                names.iter().filter_map(|n| self.nodes.get(n)).collect()
            }
            MetricsHistoryQuery::Pods { namespace, names } => names
                .iter()
                .filter_map(|n| self.pods.get(&pod_key(namespace, n)))
                .collect(),
        };
        if rings.is_empty() {
            return Vec::new();
        }
        let first = self.ticks.saturating_sub(SLOTS as u64);
        (first..self.ticks)
            .filter_map(|tick| {
                let slot = (tick % SLOTS as u64) as usize;
                let ts = self.timestamps[slot];
                if ts < since {
                    return None;
                }
                let mut present = false;
                let (mut cpu, mut memory) = (0.0, 0.0);
                for (c, m) in rings.iter().filter_map(|r| r.get(slot)) {
                    present = true;
                    cpu += c;
                    memory += m;
                }
                present.then_some(MetricsPoint {
                    ts,
                    cpu_millicores: cpu,
                    memory_bytes: memory,
                })
            })
            .collect()
    }
}

/// Average `points` into buckets of `bucket_ms`; each output point sits at
/// the mean timestamp of its bucket.
pub fn downsample(points: &[MetricsPoint], bucket_ms: i64) -> Vec<MetricsPoint> {
    let mut out: Vec<MetricsPoint> = Vec::new();
    let mut current: Option<(i64, [f64; 3], usize)> = None;
    let flush = |out: &mut Vec<MetricsPoint>, (_, sums, n): (i64, [f64; 3], usize)| {
        let n = n as f64;
        out.push(MetricsPoint {
            ts: (sums[0] / n).round() as i64,
            cpu_millicores: sums[1] / n,
            memory_bytes: sums[2] / n,
        });
    };
    for p in points {
        let bucket = p.ts.div_euclid(bucket_ms.max(1));
        match current.as_mut() {
            Some((b, sums, n)) if *b == bucket => {
                sums[0] += p.ts as f64;
                sums[1] += p.cpu_millicores;
                sums[2] += p.memory_bytes;
                *n += 1;
            }
            _ => {
                if let Some(done) = current.take() {
                    flush(&mut out, done);
                }
                current = Some((bucket, [p.ts as f64, p.cpu_millicores, p.memory_bytes], 1));
            }
        }
    }
    if let Some(done) = current {
        flush(&mut out, done);
    }
    out
}

type Histories = Arc<Mutex<HashMap<String, ClusterHistory>>>;

/// Every connected cluster's history plus its sampler task.
#[derive(Default)]
pub struct MetricsHistory {
    clusters: Histories,
    samplers: TaskRegistry,
    /// This process samples (off by default; see [`Kubepit::set_metrics_sampling`]).
    active: AtomicBool,
}

fn sampler_id(cluster_id: &str) -> String {
    format!("metrics-history:{cluster_id}")
}

impl MetricsHistory {
    /// (Re)start sampling `cluster_id` with `client`. Any previous history
    /// of the cluster is discarded.
    fn start(&self, cluster_id: &str, client: Client, gate: MetricsGate) {
        let id = sampler_id(cluster_id);
        self.samplers.stop(&id);
        self.clusters
            .lock()
            .insert(cluster_id.to_string(), ClusterHistory::default());
        let clusters = self.clusters.clone();
        self.samplers.spawn(
            &id,
            cluster_id,
            run_sampler(cluster_id.to_string(), client, gate, clusters),
        );
    }

    /// Stop the sampler and drop the history (disconnect, removal).
    pub fn stop_cluster(&self, cluster_id: &str) {
        self.samplers.stop_cluster(cluster_id);
        self.clusters.lock().remove(cluster_id);
    }

    pub fn stop_all(&self) {
        self.samplers.stop_all();
        self.clusters.lock().clear();
    }

    pub fn is_sampling(&self, cluster_id: &str) -> bool {
        self.clusters.lock().contains_key(cluster_id)
    }
}

/// Sampling loop of one cluster. It writes only into `clusters` entries that
/// still exist, so a sample racing a disconnect cannot resurrect the history.
async fn run_sampler(cluster_id: String, client: Client, gate: MetricsGate, clusters: Histories) {
    let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let update = |f: &dyn Fn(&mut ClusterHistory)| {
        if let Some(history) = clusters.lock().get_mut(&cluster_id) {
            f(history);
        }
    };
    loop {
        ticker.tick().await;
        if gate.blocked(&cluster_id) {
            update(&|h| h.mark_unavailable());
            continue;
        }
        let (nodes, pods) = tokio::join!(
            bounded(node_metrics(client.clone())),
            bounded(pod_metrics(client.clone())),
        );
        let unavailable = matches!(nodes, Ok(None)) || matches!(pods, Ok(None));
        match (nodes, pods) {
            (Ok(Some(nodes)), pods) => {
                let pods = pods.ok().flatten();
                let ts = now_millis();
                update(&|h| h.record(ts, Some(&nodes), pods.as_deref()));
            }
            (_, Ok(Some(pods))) => {
                let ts = now_millis();
                update(&|h| h.record(ts, None, Some(&pods)));
            }
            _ if unavailable => {
                gate.mark_unavailable(&cluster_id);
                update(&|h| h.mark_unavailable());
            }
            (Err(e), _) | (_, Err(e)) => {
                // Transient (network, RBAC): a gap in the history.
                tracing::debug!(cluster = %cluster_id, "metrics sample failed: {e:#}");
            }
            _ => {}
        }
    }
}

/// One metrics request bounded by [`SAMPLE_TIMEOUT`].
async fn bounded<T>(request: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(SAMPLE_TIMEOUT, request)
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("timed out reading metrics")))
}

impl Kubepit {
    /// Turn metrics sampling on or off for this process, like
    /// [`Kubepit::set_alert_monitoring`]: the desktop shell enables it; tests
    /// and headless tools do not, so request logs stay deterministic. On:
    /// clusters that connect from now on are sampled. Off: every sampler
    /// stops and the histories are dropped.
    pub fn set_metrics_sampling(&self, on: bool) {
        self.metrics_history.active.store(on, Ordering::SeqCst);
        if !on {
            self.metrics_history.stop_all();
        }
    }

    /// Whether this process samples metrics-server usage.
    pub fn metrics_sampling(&self) -> bool {
        self.metrics_history.active.load(Ordering::SeqCst)
    }

    /// Called once a connect succeeded; a no-op unless sampling is on.
    pub(crate) fn start_metrics_sampler(&self, cluster_id: &str, client: Client) {
        if !self.metrics_sampling() {
            return;
        }
        self.metrics_history
            .start(cluster_id, client, self.metrics_gate.clone());
    }

    /// `metrics_history`: the last hour of `query` at full resolution.
    pub fn metrics_history(
        &self,
        cluster_id: &str,
        query: &MetricsHistoryQuery,
    ) -> Result<MetricsSeries> {
        self.cluster_def(cluster_id)?;
        let since = now_millis() - HISTORY_WINDOW.as_millis() as i64;
        let blocked = self.metrics_gate.blocked(cluster_id);
        let clusters = self.metrics_history.clusters.lock();
        let history = clusters.get(cluster_id);
        Ok(MetricsSeries {
            interval_secs: SAMPLE_INTERVAL.as_secs() as u32,
            available: !blocked && history.is_none_or(ClusterHistory::available),
            points: history.map(|h| h.series(query, since)).unwrap_or_default(),
        })
    }

    /// `metrics_history_fleet`: cluster totals of every sampled cluster,
    /// downsampled to [`FLEET_BUCKET`] for the dashboard sparklines.
    pub fn metrics_history_fleet(&self) -> HashMap<String, MetricsSeries> {
        let since = now_millis() - HISTORY_WINDOW.as_millis() as i64;
        let bucket = FLEET_BUCKET.as_millis() as i64;
        let clusters = self.metrics_history.clusters.lock();
        clusters
            .iter()
            .map(|(id, history)| {
                let points = history.series(&MetricsHistoryQuery::Cluster, since);
                let series = MetricsSeries {
                    interval_secs: FLEET_BUCKET.as_secs() as u32,
                    available: history.available() && !self.metrics_gate.blocked(id),
                    points: downsample(&points, bucket),
                };
                (id.clone(), series)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(name: &str, cpu: f64, mem: f64) -> NodeMetric {
        NodeMetric {
            name: name.into(),
            cpu_millicores: cpu,
            memory_bytes: mem,
        }
    }

    fn pod(ns: &str, name: &str, cpu: f64, mem: f64) -> PodMetric {
        PodMetric {
            namespace: ns.into(),
            name: name.into(),
            cpu_millicores: cpu,
            memory_bytes: mem,
            containers: Vec::new(),
        }
    }

    fn pods_query(names: &[&str]) -> MetricsHistoryQuery {
        MetricsHistoryQuery::Pods {
            namespace: "shop".into(),
            names: names.iter().map(|n| n.to_string()).collect(),
        }
    }

    const T0: i64 = 1_700_000_000_000;
    const STEP: i64 = 15_000;

    #[test]
    fn query_matches_the_ts_union() {
        let q: MetricsHistoryQuery =
            serde_json::from_value(json!({"scope": "pods", "namespace": "a", "names": ["x"]}))
                .unwrap();
        assert_eq!(
            q,
            MetricsHistoryQuery::Pods {
                namespace: "a".into(),
                names: vec!["x".into()]
            }
        );
        let q: MetricsHistoryQuery = serde_json::from_value(json!({"scope": "cluster"})).unwrap();
        assert_eq!(q, MetricsHistoryQuery::Cluster);
        let q: MetricsHistoryQuery =
            serde_json::from_value(json!({"scope": "nodes", "names": ["n1"]})).unwrap();
        assert_eq!(
            q,
            MetricsHistoryQuery::Nodes {
                names: vec!["n1".into()]
            }
        );
    }

    #[test]
    fn totals_nodes_and_pods_are_summed_per_sample() {
        let mut h = ClusterHistory::default();
        h.record(
            T0,
            Some(&[node("n1", 100.0, 1e9), node("n2", 300.0, 3e9)]),
            Some(&[
                pod("shop", "web-1", 10.0, 1e6),
                pod("shop", "web-2", 20.0, 2e6),
            ]),
        );
        h.record(
            T0 + STEP,
            Some(&[node("n1", 200.0, 1e9)]),
            Some(&[
                pod("shop", "web-2", 40.0, 4e6),
                pod("shop", "web-3", 5.0, 5e5),
            ]),
        );

        let total = h.series(&MetricsHistoryQuery::Cluster, 0);
        assert_eq!(total.len(), 2);
        assert_eq!(total[0].ts, T0);
        assert_eq!(total[0].cpu_millicores, 400.0);
        assert_eq!(total[0].memory_bytes, 4e9);
        assert_eq!(total[1].cpu_millicores, 200.0);

        let n2 = h.series(
            &MetricsHistoryQuery::Nodes {
                names: vec!["n2".into()],
            },
            0,
        );
        assert_eq!(
            n2.len(),
            1,
            "n2 missed the second sample: a gap, not a zero"
        );

        // A workload series sums whichever of its pods exist at each sample.
        let web = h.series(&pods_query(&["web-1", "web-2", "web-3"]), 0);
        assert_eq!(
            web.iter().map(|p| p.cpu_millicores).collect::<Vec<_>>(),
            vec![30.0, 45.0]
        );
        assert!(h.series(&pods_query(&["nope"]), 0).is_empty());
        assert!(h.series(&pods_query(&[]), 0).is_empty());
        // `since` trims old samples.
        assert_eq!(h.series(&MetricsHistoryQuery::Cluster, T0 + 1).len(), 1);
    }

    #[test]
    fn total_falls_back_to_pods_when_nodes_are_unreadable() {
        let mut h = ClusterHistory::default();
        h.record(
            T0,
            None,
            Some(&[pod("a", "x", 10.0, 100.0), pod("b", "y", 5.0, 50.0)]),
        );
        h.record(T0 + STEP, None, None);
        let total = h.series(&MetricsHistoryQuery::Cluster, 0);
        assert_eq!(total.len(), 1);
        assert_eq!(total[0].cpu_millicores, 15.0);
        assert_eq!(total[0].memory_bytes, 150.0);
    }

    #[test]
    fn ring_keeps_the_last_window_oldest_first() {
        let mut h = ClusterHistory::default();
        let extra = 10;
        for i in 0..(SLOTS + extra) {
            h.record(
                T0 + i as i64 * STEP,
                Some(&[node("n1", i as f64, 1.0)]),
                None,
            );
        }
        let total = h.series(&MetricsHistoryQuery::Cluster, 0);
        assert_eq!(total.len(), SLOTS);
        assert_eq!(total[0].cpu_millicores, extra as f64);
        assert_eq!(total[0].ts, T0 + extra as i64 * STEP);
        assert_eq!(total[SLOTS - 1].cpu_millicores, (SLOTS + extra - 1) as f64);
        assert!(total.windows(2).all(|w| w[0].ts < w[1].ts));
    }

    #[test]
    fn unseen_pods_are_evicted_and_leave_no_stale_slots() {
        let mut h = ClusterHistory::default();
        h.record(T0, None, Some(&[pod("shop", "old", 1.0, 1.0)]));
        for i in 1..TTL_TICKS {
            h.record(
                T0 + i as i64 * STEP,
                None,
                Some(&[pod("shop", "live", 2.0, 2.0)]),
            );
        }
        assert_eq!(h.tracked_pods(), 2, "not yet stale");
        assert_eq!(h.series(&pods_query(&["old"]), 0).len(), 1);
        h.record(
            T0 + TTL_TICKS as i64 * STEP,
            None,
            Some(&[pod("shop", "live", 2.0, 2.0)]),
        );
        assert_eq!(h.tracked_pods(), 1, "unseen for 10 minutes");
        assert!(h.series(&pods_query(&["old"]), 0).is_empty());

        // A pod that comes and goes never reports a sample from a previous
        // lap of the ring buffer.
        let mut h = ClusterHistory::default();
        for i in 0..SLOTS as i64 + 3 {
            let pods: Vec<PodMetric> = if i % 2 == 0 {
                vec![pod("shop", "flappy", i as f64, 1.0)]
            } else {
                Vec::new()
            };
            h.record(T0 + i * STEP, None, Some(&pods));
        }
        let flappy = h.series(&pods_query(&["flappy"]), 0);
        assert!(flappy.iter().all(|p| (p.cpu_millicores as i64) % 2 == 0));
        assert!(flappy
            .iter()
            .all(|p| p.ts == T0 + p.cpu_millicores as i64 * STEP));
    }

    #[test]
    fn pod_cap_bounds_memory() {
        let mut h = ClusterHistory::with_pod_cap(2);
        h.record(
            T0,
            None,
            Some(&[
                pod("a", "p1", 1.0, 1.0),
                pod("a", "p2", 1.0, 1.0),
                pod("a", "p3", 1.0, 1.0),
            ]),
        );
        assert_eq!(h.tracked_pods(), 2);
        // The total still counts every pod.
        assert_eq!(
            h.series(&MetricsHistoryQuery::Cluster, 0)[0].cpu_millicores,
            3.0
        );
    }

    #[test]
    fn availability_follows_the_last_attempt() {
        let mut h = ClusterHistory::default();
        assert!(h.available());
        h.mark_unavailable();
        assert!(!h.available());
        h.record(T0, Some(&[node("n", 1.0, 1.0)]), None);
        assert!(h.available());
    }

    #[test]
    fn downsampling_averages_buckets() {
        let points: Vec<MetricsPoint> = (0..8)
            .map(|i| MetricsPoint {
                ts: 60_000 * 10 + i * 15_000,
                cpu_millicores: i as f64,
                memory_bytes: 10.0,
            })
            .collect();
        let out = downsample(&points, 60_000);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].cpu_millicores, 1.5);
        assert_eq!(out[1].cpu_millicores, 5.5);
        assert_eq!(out[0].memory_bytes, 10.0);
        assert_eq!(out[0].ts, 600_000 + 22_500);
        assert!(downsample(&[], 60_000).is_empty());
    }

    #[test]
    fn window_constants_are_consistent() {
        assert_eq!(SLOTS, 240);
        assert_eq!(TTL_TICKS, 40);
    }
}
