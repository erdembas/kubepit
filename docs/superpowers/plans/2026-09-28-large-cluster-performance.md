# Large-Cluster Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible large-cluster performance harness: scale fixtures, benchmarks, UI measurements, budgets and a CI guard. Then apply only the optimizations the harness proves necessary.

**Architecture:**
- One preset file (`perf/scale-presets.json`) drives both the Rust fake-API-server fixture and a scaled demo cluster.
- Criterion benchmarks (backend) and Vitest benches (TS engines) run in CI.
- A dev-only in-app probe plus a Playwright driver measure the UI.
- `scripts/perf/compare.mjs` checks all results against `perf/budgets.json`.
- Optimizations H1–H10 and the map cap are gated tasks: each starts by checking its gate and is skipped (and recorded) when the gate does not fire.

**Tech Stack:** Rust (kube 4.2, tokio, Criterion 0.7), Tauri 2.12, React 18, Zustand 5, Vitest 3 (bench), Playwright (Chromium), Node 22 `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-28-large-cluster-performance-design.md`

## Global Constraints

- **IPC contract.** `apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts` define every frontend ⇄ backend command and shape.
  - Change the Rust serde types, the Tauri command, both TS files and the demo backend (`apps/desktop/src/lib/ipc/mock/`) in the same commit.
  - `pnpm dev:ui` must keep working.
- **Design.** Stay visually identical to RunHQ: tokens from `src/styles/theme.css`, primitives from `src/components/ui/`, 11–13 px UI text, uppercase tracked labels, `bg-fg/N` hover pads, the accent strip for active rows.
  - No chart or UI libraries. Criterion, Vitest and Playwright are dev-only tooling and never ship.
- **i18n is mandatory.** Every user-visible string ships in English and Turkish in the same commit.
  - Components use `import * as i18n from '@/i18n'`; pure helpers use `@/i18n/core`.
  - Use `i18n.t` / `i18n.rich` / `i18n.plural`; never concatenate translated fragments.
  - Run `pnpm i18n:check -- --fix`, then add the Turkish values by hand. `pnpm i18n:check` must pass.
  - Never translate Kubernetes data, kinds, YAML, logs, commands or user content.
  - The probe and benchmarks are not user-visible and add no strings.
- **Safety.** Never connect to real clusters from tests, benchmarks or scripts; `~/.kube` may hold production credentials.
  - Rust uses the fake API server in `crates/kubepit-core/tests/support` on 127.0.0.1, with temp dirs (explicit `Paths`, or `KUBEPIT_HOME` pointed at a temp dir).
  - UI measurements use the demo backend only, and the Playwright driver refuses a Tauri page.
- **read_only.** Every mutating backend command honours `ClusterDef.read_only`. Optimizations must not bypass `ensure_writable`.
- **Background work is opt-in per process.** Watchers and pollers started after connect stay behind `Kubepit::set_*` switches (`set_alert_monitoring`, `set_change_journal_recording`, `set_history_recording`, `set_metrics_sampling`). Only `src-tauri/src/setup.rs` enables them. The informer hub (H1) may only start watches for opted-in consumers and live UI watches.
- **Container queries.** Any UI added uses `@container` with `@lg:`/`@2xl:` variants, never viewport breakpoints.
- **Measure first.** Gated tasks begin with their gate check. No speculative rewrites.
- **Checks.** These must pass before every commit that touches their area, and all of them at the end:
  - `pnpm typecheck`
  - `pnpm i18n:check`
  - `cargo fmt --all -- --check`
  - `cargo clippy --workspace --all-targets -- -D warnings` (this lints benches too)
  - `cargo test --workspace`
  - `pnpm --filter @kubepit/desktop build`
- Also `pnpm --filter @kubepit/desktop test` and `node --test scripts/perf/`.
- **Prerequisites from the hardening plan:**
  - Vitest (its Task 1);
  - `support::Request::{header, path_only}` (its Task 17);
  - `Kubepit::set_metrics_sampling` (its Task 18).

  If any is missing, implement that hardening task first, exactly as specified there.
- **CI.** Task 11 depends on the CI plan's workflow (assumed `.github/workflows/ci.yml`).

## Review Focus

- **New windows.** Opening a new demo window must keep `?scale=` and `&churn=`; `window_open` clears `location.search` today (Task 6, `withScaleParams keeps scale and churn`).
- **Probe cost.** Without `?perf=1` the probe must be inert in production builds: no `window.__kubepitPerf`, no `performance.mark`, no observers (Task 8, `probe is inert when disabled`).
- **Chunked demo batches.** Only the first batch carries `reset: true` and only the last carries `synced: true`. An empty list still produces one reset + synced batch (Task 6, `chunkBatches follows the backend contract`).
- **Missing results.** A result missing for a budgeted id must fail the compare, not pass silently. Unknown result ids only warn (Task 10, `missing budgeted result fails`).
- **Fixture paging.** An unknown `continue` token answers `410 Expired`, so watchers relist. A `limit` larger than the collection returns one page with no `continue` (Task 1, `paging_edges`).

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `perf/scale-presets.json` (new) | Presets `s` / `m` / `l` shared by Rust and TS |
| `perf/budgets.json` (new) | Budget per result id: value, unit, direction, timing or structural |
| `crates/kubepit-core/tests/support/scale.rs` (new) | Deterministic object generator and paged, selector-aware router |
| `crates/kubepit-core/tests/scale_fixture.rs` (new) | Fixture correctness |
| `crates/kubepit-core/tests/perf_probe.rs` (new) | Structural snapshot: watch fan-out and unpaged lists |
| `crates/kubepit-core/benches/{watch,metrics_history,watchers,search_proxies,e2e}.rs` (new) | Criterion benchmarks |
| `apps/desktop/src/lib/ipc/mock/fixtures/scale.ts` (new) | Scaled demo objects, `scaleParams`, `chunkBatches` |
| `apps/desktop/src/lib/perf/{stats,probe,fixtures}.ts` (new) | Probe math, probe and bench inputs |
| `apps/desktop/src/**/*.bench.ts` (new) | Engine benches |
| `scripts/perf/{ui-perf.mjs,lib.mjs,compare.mjs,compareLib.mjs,*.test.mjs}` (new) | UI driver and budget compare |
| `.github/workflows/perf-nightly.yml` (new) | Nightly UI suite and soak |
| `crates/kubepit-core/src/informer.rs` (new, gated H1) | Shared per-cluster watches |
| `apps/desktop/src/lib/perf/worker/*` (new, gated H5) | Engine worker and client |

---

### Task 1: Scale presets and the Rust scale fixture

**Files:**
- Create: `perf/scale-presets.json`
- Create: `crates/kubepit-core/tests/support/scale.rs`
- Modify: `crates/kubepit-core/tests/support/mod.rs` (`pub mod scale;`, `get_json`)
- Test: `crates/kubepit-core/tests/scale_fixture.rs`

**Interfaces:**
- Consumes: `support::Request::{header, path_only}` (hardening Task 17).
- Produces:
  - `perf/scale-presets.json`: `{ "s": Preset, "m": Preset, "l": Preset }`. `Preset = { namespaces, nodes, deploymentsPerNamespace, replicas, oldReplicaSets, configMapsPerDeployment, secretsPerDeployment, servicesPerDeployment, crds, crsPerCrd, events, seed }`. The values are the spec table's: for `l`, 400 namespaces, 1 000 nodes, 12.5 deployments per namespace (5 000 total), replicas 4, oldReplicaSets 1, configMaps 2, secrets 1, services 1, crds 200, crsPerCrd 20, events 20 000. `deploymentsPerNamespace` may be fractional; the generator spreads the remainder over the first namespaces.
  - `pub struct ScalePreset { … }` (serde, camelCase) and `pub fn preset(name: &str) -> ScalePreset`, read through `include_str!("../../../../perf/scale-presets.json")`.
  - `pub struct ScaleCluster`:
    - `pub fn generate(p: &ScalePreset) -> Self`;
    - `pub fn count(&self, collection_path: &str) -> Option<usize>`;
    - `pub fn custom_resources(&self) -> usize`;
    - `pub fn objects(&self, collection_path: &str) -> &[Value]`;
    - `pub fn collections(&self) -> Vec<String>`;
    - `pub fn router(self: Arc<Self>, serve: ScaleServe) -> Router`.
  - `pub struct ScaleServe { pub watch: ScaleWatch }` with `Default`, and `pub enum ScaleWatch { Quiet, PodBurst(usize) }`.
  - `pub async fn get_json(base: &str, path: &str, headers: &[(&str, &str)]) -> (u16, Value)` in `support/mod.rs`: raw HTTP/1.1 GET, read to EOF (the server sends `Connection: close`).
  - Collections:
    - cluster-wide `/api/v1/{pods,nodes,services,configmaps,secrets,events,namespaces,serviceaccounts}`;
    - `/apis/apps/v1/{deployments,replicasets,statefulsets,daemonsets}`;
    - `/apis/batch/v1/{jobs,cronjobs}`;
    - `/apis/discovery.k8s.io/v1/endpointslices`;
    - `/apis/apiextensions.k8s.io/v1/customresourcedefinitions`;
    - one per CRD `/apis/scale{i}.example.com/v1/widgets`;
    - `/apis/metrics.k8s.io/v1beta1/{nodes,pods}`;
    - per-namespace variants `/api/v1/namespaces/{ns}/…`.

    Empty kinds (statefulsets, daemonsets, jobs, cronjobs, RBAC, networking) answer empty lists, so alerts and journal watchers sync.
  - Discovery: `/version` (v1.31.0), `/api`, `/api/v1`, `/apis`, `/apis/{group}/{version}`.

- [x] **Step 1: Write the failing tests**

```rust
// crates/kubepit-core/tests/scale_fixture.rs
mod support;
use std::collections::HashSet;
use std::sync::Arc;
use serde_json::Value;
use support::scale::{preset, ScaleCluster, ScaleServe};
use support::{get_json, start};

#[test]
fn presets_generate_the_declared_counts() {
    let s = ScaleCluster::generate(&preset("s"));
    assert_eq!(s.count("/api/v1/pods"), Some(1_000));
    assert_eq!(s.count("/api/v1/nodes"), Some(50));
    assert_eq!(s.count("/api/v1/services"), Some(250));
    assert_eq!(s.count("/apis/apps/v1/deployments"), Some(250));
    assert_eq!(s.count("/apis/apps/v1/replicasets"), Some(500));
    assert_eq!(s.count("/apis/apiextensions.k8s.io/v1/customresourcedefinitions"), Some(20));
    assert_eq!(s.custom_resources(), 200);
    let l = ScaleCluster::generate(&preset("l"));
    assert_eq!(l.count("/api/v1/pods"), Some(20_000));
    assert_eq!(l.count("/api/v1/nodes"), Some(1_000));
    assert_eq!(l.count("/api/v1/services"), Some(5_000));
}

#[test]
fn generation_is_deterministic() {
    let a = ScaleCluster::generate(&preset("s"));
    let b = ScaleCluster::generate(&preset("s"));
    assert_eq!(serde_json::to_string(a.objects("/api/v1/pods")).unwrap(),
               serde_json::to_string(b.objects("/api/v1/pods")).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paging_returns_every_object_once() {
    let server = start(Arc::new(ScaleCluster::generate(&preset("m"))).router(ScaleServe::default())).await;
    let (mut uids, mut token, mut pages) = (HashSet::new(), None::<String>, 0);
    loop {
        let path = match &token { Some(t) => format!("/api/v1/pods?limit=500&continue={t}"), None => "/api/v1/pods?limit=500".into() };
        let (code, list) = get_json(&server.url, &path, &[]).await;
        assert_eq!(code, 200);
        assert!(list["metadata"]["resourceVersion"].is_string());
        for item in list["items"].as_array().unwrap() { assert!(uids.insert(item["metadata"]["uid"].as_str().unwrap().to_string())); }
        pages += 1;
        token = list["metadata"]["continue"].as_str().filter(|t| !t.is_empty()).map(String::from);
        if token.is_none() { break; }
    }
    assert_eq!((uids.len(), pages), (10_000, 20));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paging_edges() {
    let server = start(Arc::new(ScaleCluster::generate(&preset("s"))).router(ScaleServe::default())).await;
    let (code, _) = get_json(&server.url, "/api/v1/pods?limit=500&continue=bogus", &[]).await;
    assert_eq!(code, 410);
    let (_, all) = get_json(&server.url, "/api/v1/nodes?limit=5000", &[]).await;
    assert_eq!(all["items"].as_array().unwrap().len(), 50);
    assert!(all["metadata"].get("continue").map_or(true, |c| c.as_str() == Some("")));
    let (_, unpaged) = get_json(&server.url, "/api/v1/pods", &[]).await;
    assert_eq!(unpaged["items"].as_array().unwrap().len(), 1_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_only_lists_and_selectors() {
    let server = start(Arc::new(ScaleCluster::generate(&preset("s"))).router(ScaleServe::default())).await;
    let accept = [("Accept", "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1")];
    let (_, meta) = get_json(&server.url, "/api/v1/secrets?limit=10", &accept).await;
    assert_eq!(meta["kind"], "PartialObjectMetadataList");
    assert!(meta["items"][0].get("data").is_none() && meta["items"][0]["metadata"]["name"].is_string());
    let (_, one) = get_json(&server.url, "/api/v1/pods?fieldSelector=spec.nodeName%3Dnode-0007", &[]).await;
    assert!(one["items"].as_array().unwrap().iter().all(|p: &Value| p["spec"]["nodeName"] == "node-0007"));
    assert!(!one["items"].as_array().unwrap().is_empty());
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test scale_fixture`
Expected: FAIL (`support::scale` not found).

- [x] **Step 3: Implement.**
  - Generation uses a seeded xorshift and names objects `ns-0001`, `node-0001`, `app-0001-api` and so on. Pods get owner refs to their current ReplicaSet, `spec.nodeName` round-robin over nodes, labels `app`/`team`, and `status.phase: Running` with container statuses. Secrets are `Opaque` with two data keys.
  - Items are kept sorted by (namespace, name).
  - The continue token is base64 of `"{offset}:{rv}"`. An unknown or undecodable token answers `Reply::Json(410, status(410, "Expired", "…"))`.
  - `watch=true` answers `Reply::Stream(vec![])` (Quiet) or `n` MODIFIED events for the first `n` pods (`PodBurst(n)`).
  - Metadata-only responses apply when `req.header("accept")` contains `as=PartialObjectMetadataList`.
  - `fieldSelector` supports `spec.nodeName=` and `metadata.namespace=`; `labelSelector` supports `k=v[,k=v]`. Decode query values with `%3D`/`%2C` handling.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test scale_fixture`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add perf crates/kubepit-core/tests
git commit -m "test(perf): scale presets and a paged, selector-aware fake API server fixture"
```

---

### Task 2: Structural probe: watch fan-out and unpaged lists

**Files:**
- Create: `crates/kubepit-core/tests/perf_probe.rs`

**Interfaces:**
- Consumes: `ScaleCluster`, `ScaleServe` (Task 1); `Kubepit::set_metrics_sampling` (hardening Task 18).
- Produces:
  - `fn watch_streams_per_path(log: &Log) -> BTreeMap<String, usize>`: GETs with `watch=true`, keyed by `path_only()`.
  - `fn unpaged_lists(log: &Log, cluster: &ScaleCluster) -> BTreeSet<String>`: GET collection paths without `watch=true` and without `limit=`.

  Task 12 (H1) and Task 15 (H4) update the expectations pinned here.

- [ ] **Step 1: Write the test** (a snapshot of today's behaviour; it passes on the current code)

```rust
// crates/kubepit-core/tests/perf_probe.rs
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn watch_fanout_and_pagination_snapshot() {
    let cluster = Arc::new(ScaleCluster::generate(&preset("s")));
    let server = start(cluster.clone().router(ScaleServe::default())).await;
    let (_dir, app, id) = scale_setup(&server.url); // no accessible_namespaces; Settings.change_journal stays true
    app.set_alert_monitoring(true);
    app.set_change_journal_recording(true);
    app.set_history_recording(true);
    app.set_metrics_sampling(true);
    persist_history(&app, &id);
    app.cluster_connect(&id).await.unwrap();
    wait_synced(&app, &id, &gvk("", "v1", "Pod", "pods", true)).await; // resource_watch, cluster-wide
    tokio::time::sleep(Duration::from_secs(2)).await;

    let fanout = watch_streams_per_path(&server.log);
    for (path, streams) in [("/api/v1/pods", 2), ("/api/v1/nodes", 2), ("/apis/apps/v1/deployments", 2),
                            ("/apis/batch/v1/jobs", 1), ("/api/v1/secrets", 1), ("/api/v1/configmaps", 1),
                            ("/api/v1/events", 1)] {
        assert_eq!(fanout.get(path), Some(&streams), "{path}: {fanout:#?}");
    }
    assert_eq!(unpaged_lists(&server.log, &cluster), BTreeSet::from([
        "/apis/metrics.k8s.io/v1beta1/nodes".to_string(),
        "/apis/metrics.k8s.io/v1beta1/pods".to_string(),
    ]));
}
```

Where the counts come from:
- pods = the UI watch + alerts;
- nodes and deployments = alerts + journal;
- jobs = alerts;
- secrets and configmaps = journal;
- events = history persistence.

The helpers `scale_setup`, `persist_history`, `wait_synced` and `gvk` live in this file.

- [ ] **Step 2: Run the test**

Run: `cargo test -p kubepit-core --test perf_probe -- --nocapture`
Expected: PASS. If a count differs, the code changed after this plan was written. Pin the observed value, state it in the commit body, and record it in the spec's Results table (`structural/fanout`).

- [ ] **Step 3: Commit**

```bash
git add crates/kubepit-core/tests/perf_probe.rs docs/superpowers/specs
git commit -m "test(perf): pin watch fan-out and unpaged lists at scale"
```

---

### Task 3: Criterion, watch and metrics-history benchmarks

**Files:**
- Modify: `crates/kubepit-core/Cargo.toml` (dev-dependency `criterion = { version = "0.7", features = ["async_tokio"] }`; `[[bench]]` entries with `harness = false` for `watch`, `metrics_history`, `watchers`, `search_proxies`, `e2e`)
- Modify: `Cargo.toml` (workspace: `[profile.bench] lto = "thin"`, `codegen-units = 16`, `debug = "line-tables-only"`)
- Create: `crates/kubepit-core/benches/watch.rs`, `crates/kubepit-core/benches/metrics_history.rs`
- Create stubs, filled in Tasks 4–5: `benches/watchers.rs`, `benches/search_proxies.rs`, `benches/e2e.rs`. Each is `criterion_main!` with an empty group, so the manifest builds.

**Interfaces:**
- Consumes: `support::scale` through `#[path = "../tests/support/mod.rs"] mod support;` in each bench.
- Produces Criterion ids, stored at `target/criterion/<id>/new/estimates.json` and matched by `perf/budgets.json`:

| Id | Input | Measured |
|----|-------|----------|
| `watch/aggregator_initial_20k` | 20 000 `l` pods as `DynamicObject` | `WatchAggregator::new("w",1)`, `on_event(Init)`, `InitApply` × 20 000, `InitDone`, drain `take_batch` |
| `watch/reset_batch_20k` | aggregator already holding 20 000 objects | `take_batch` after `on_init`/`on_init_done` (full reset) |
| `watch/steady_500` | synced aggregator of 20 000 objects | 500 `on_apply` + `take_batch` |
| `metrics_history/record_5k_pods_1k_nodes` | 5 000 `PodMetric`, 1 000 `NodeMetric` | `ClusterHistory::record` for one tick, after 240 warm ticks |
| `metrics_history/series_cluster` | full ring | `series(&MetricsHistoryQuery::Cluster, 0)` |
| `metrics_history/series_100_pods` | full ring | `series(&Pods { namespace, names: 100 }, 0)` |

- [ ] **Step 1: Write the benches.** Use `criterion_group!{ name = benches; config = Criterion::default().sample_size(20); targets = … }` and build inputs outside `b.iter`. For benches that consume their input, use `iter_batched` with `BatchSize::LargeInput`.

- [ ] **Step 2: Run them**

Run: `cargo bench -p kubepit-core --bench watch --bench metrics_history -- --quick --noplot`
Expected: each id above prints a time, and `target/criterion/watch/aggregator_initial_20k/new/estimates.json` exists.

- [ ] **Step 3: Lint**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: no warnings.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock crates/kubepit-core
git commit -m "perf(bench): Criterion benches for watch batching and metrics history"
```

---

### Task 4: Watcher benchmarks (alerts, change journal, history writer)

**Files:**
- Modify: `crates/kubepit-core/benches/watchers.rs`

**Interfaces:**
- Produces:

| Id | Input | Measured |
|----|-------|----------|
| `alerts/tracker_initial_20k` | 20 000 `SlimPod` from `l` pods (`serde_json::from_value`) | `Tracker::<SlimPod>::default()` + `Init`/`InitApply`×/`InitDone` |
| `alerts/tracker_pod_update` | synced tracker | one `on_event(Apply(pod with restartCount+1))` |
| `alerts/book_record` | `AlertBook::with_limit(500)` holding 500 alerts | `record(cluster, object, finding, now)` |
| `journal/prepare_configmap_4k` | ConfigMap with 4 KiB of data | `change_journal::prepare(&Arc<Gvk>, obj, &Redactor::new())` |
| `journal/apply_update` | `ClusterJournal` baseline of 10 000 ConfigMaps | `apply(source, prepared_update, ts)` |
| `journal/details_after_500` | journal with 5 000 entries | `details_after(0, 500)` |
| `history/writer_events_10k` | temp-dir `Writer::start(path, QUEUE_CAPACITY)` | `submit(WriteOp::Events(rows))` in batches of 100 until 10 000, then `flush(10 s)`. After the run, assert `stats().dropped == 0` |

- [ ] **Step 1: Write the benches** as specified. `writer_events_10k` uses `iter_custom` with a fresh temp dir per iteration.

- [ ] **Step 2: Run them**

Run: `cargo bench -p kubepit-core --bench watchers -- --quick --noplot`
Expected: every id prints a time, and the writer bench reports no drops (the bench panics otherwise).

- [ ] **Step 3: Commit**

```bash
git add crates/kubepit-core/benches/watchers.rs
git commit -m "perf(bench): alerts, change journal and history writer benches"
```

---

### Task 5: Fleet search, proxy parsing and end-to-end benchmarks

**Files:**
- Modify: `crates/kubepit-core/benches/search_proxies.rs`, `crates/kubepit-core/benches/e2e.rs`
- Modify: `crates/kubepit-core/Cargo.toml` (`[target.'cfg(unix)'.dev-dependencies] libc = "0.2"`)

**Interfaces:**
- Produces:

| Id | Input | Measured |
|----|-------|----------|
| `fleet_search/matcher_substring_50k` | 50 000 names | `NameMatcher::parse("api")` then `matches` over all |
| `fleet_search/matcher_glob_50k` | same | pattern `app-*-api` |
| `fleet_search/matcher_regex_50k` | same | pattern `/^app-0[0-9]+-api$/` |
| `prometheus/parse_200x240` | matrix JSON, 200 series × 240 points | `prometheus::parse::parse_response` |
| `loki/parse_5000_lines_50_streams` | streams JSON | `loki::parse::parse_query(text, Backward, 5000)` |
| `e2e/watch_pods_synced_l` | `l` fixture server | `resource_watch` pods cluster-wide until a batch with `synced` (`iter_custom`, one fresh app per iteration) |
| `e2e/fleet_search_l` | `l` fixture server | `fleet_search` for `api` over pods, deployments, services and configmaps, until the cluster's final event |
| `e2e/prometheus_query` | fixture router plus a `prometheus-operated` service answering a 100-series matrix | `prometheus_query_range` |

- `e2e.rs` also writes `target/perf/backend-e2e.json`:
  - `{ "e2e/max_rss_l_all_watchers": <bytes> }`: `getrusage(RUSAGE_SELF).ru_maxrss` (KiB on Linux, bytes on macOS; normalize to bytes). It is measured after connecting to `l` with every opt-in switch on, one pods watch, and a 5 s settle.
  - `"structural/list_requests_without_limit"`: the Task 2 `unpaged_lists` count at `l`.

- [ ] **Step 1: Write the benches.** e2e benches build a `tokio::runtime::Runtime` and use the fixture router from Task 1. They never touch `~/.kube`: `Paths` points at a temp dir.

- [ ] **Step 2: Run them**

Run: `cargo bench -p kubepit-core --bench search_proxies --bench e2e -- --quick --noplot && cat target/perf/backend-e2e.json`
Expected: every id prints a time, and the JSON file holds both keys.

- [ ] **Step 3: Commit**

```bash
git add crates/kubepit-core
git commit -m "perf(bench): fleet search, proxy parsing and end-to-end benches with max RSS"
```

---

### Task 6: A scaled demo cluster that follows the batch contract

**Files:**
- Create: `apps/desktop/src/lib/ipc/mock/fixtures/scale.ts`
- Modify: `apps/desktop/src/lib/ipc/mock/fixtures/profiles.ts:138-145` (`profileFor` handles `c-scale-*`)
- Modify: `apps/desktop/src/lib/ipc/mock/app.ts:44-103,298-301` (cluster definition when `scaleParams().scale`; `window_open` keeps the params)
- Modify: `apps/desktop/src/lib/ipc/mock/fixtures/db.ts:92-160` (name and owner indexes for `find` / `ownedBy`)
- Modify: `apps/desktop/src/lib/ipc/mock/fixtures/build.ts:29` (scale clusters use `generateScaleObjects` instead of `buildCluster`)
- Modify: `apps/desktop/src/lib/ipc/mock/resources.ts:121-146` (emit `chunkBatches`, one batch per 150 ms)
- Modify: `apps/desktop/src/lib/ipc/mock/fixtures/live.ts:64-76` (churn)
- Test: `apps/desktop/src/lib/ipc/mock/fixtures/scale.test.ts`

**Interfaces:**
- Consumes: Vitest (hardening Task 1); `perf/scale-presets.json`, imported as `../../../../../../../perf/scale-presets.json`.
- Produces:
  - `type ScalePresetName = 's' | 'm' | 'l'`.
  - `scaleParams(search: string): { scale: ScalePresetName | null; churn: number }`. `churn` is clamped to 0–1 000 events/s, and an invalid preset gives `null`.
  - `withScaleParams(target: URL, current: string): URL`.
  - `generateScaleObjects(preset: ScalePresetName, clusterId: string): KubeObject[]`: pure and deterministic, with the same counts as the Rust fixture.
  - `chunkBatches(watchId: string, items: readonly KubeObject[], max?: number): WatchBatch[]` (`max` defaults to 500).
  - `mockWatchStats(): Array<{ clusterId: string; key: string; namespaces: string[] }>`, exported from `db.ts` for the probe and for H2.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/lib/ipc/mock/fixtures/scale.test.ts
import { describe, expect, it } from 'vitest';
import { chunkBatches, generateScaleObjects, scaleParams, withScaleParams } from './scale';

describe('scale demo', () => {
  it('generates the preset counts deterministically', () => {
    const objs = generateScaleObjects('s', 'c-scale-s');
    const count = (kind: string) => objs.filter((o) => o.kind === kind).length;
    expect([count('Pod'), count('Node'), count('Service'), count('Deployment'), count('ReplicaSet')])
      .toEqual([1000, 50, 250, 250, 500]);
    expect(JSON.stringify(generateScaleObjects('s', 'c-scale-s'))).toBe(JSON.stringify(objs));
  });
  it('chunkBatches follows the backend contract', () => {
    const items = generateScaleObjects('s', 'c').filter((o) => o.kind === 'Pod');
    const batches = chunkBatches('w', items);
    expect(batches.map((b) => b.upserts.length)).toEqual([500, 500]);
    expect(batches.map((b) => [b.reset, b.synced])).toEqual([[true, false], [false, true]]);
    expect(chunkBatches('w', [])).toEqual([{ watch_id: 'w', reset: true, upserts: [], deletes: [], synced: true, error: null }]);
  });
  it('parses and validates the URL switches', () => {
    expect(scaleParams('?scale=l&churn=50')).toEqual({ scale: 'l', churn: 50 });
    expect(scaleParams('?scale=xl&churn=99999')).toEqual({ scale: null, churn: 1000 });
    expect(scaleParams('')).toEqual({ scale: null, churn: 0 });
  });
  it('withScaleParams keeps scale and churn', () => {
    const url = withScaleParams(new URL('http://localhost:1430/?window=win-2'), '?scale=m&churn=10&perf=1');
    expect(url.searchParams.get('scale')).toBe('m');
    expect(url.searchParams.get('churn')).toBe('10');
    expect(url.searchParams.get('perf')).toBe('1');
    expect(url.searchParams.get('window')).toBe('win-2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kubepit/desktop test -- src/lib/ipc/mock/fixtures/scale.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**
  - The generator mirrors Task 1's naming and shapes, seeded from the preset's `seed`. `c-scale-<preset>` uses platform `kind` and version `v1.31.0` and is not read-only.
  - `window_open` builds its URL with `withScaleParams` (it keeps `perf` too).
  - With `churn > 0`, the liveness timer ticks every 100 ms and applies `churn / 10` pod changes per tick round-robin: 90% status/label updates, 10% delete + recreate.
  - `db.ts` keeps `byName: Map<kindKey, Map<"ns/name", uid>>` and `byOwner: Map<ownerUid, Set<uid>>` in sync in `put`/`drop`.

- [ ] **Step 4: Run the tests and check the build time**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck`
Expected: PASS. Then open `pnpm dev:ui` at `http://localhost:1430/?scale=l`: the `c-scale-l` cluster connects and the pods table fills within 3 s.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "perf(mock): scaled demo clusters (?scale=, &churn=) and backend-like watch batches"
```

---

### Task 7: Engine benches (Vitest bench)

**Files:**
- Create: `apps/desktop/src/lib/perf/fixtures.ts`
- Create: `apps/desktop/src/lib/kube/topology/topology.bench.ts`, `lib/kube/health/health.bench.ts`, `lib/kube/netpol/netpol.bench.ts`, `lib/logs/logs.bench.ts`, `components/workbench/table/tableModel.bench.ts`
- Modify: `package.json` (root script `"perf:bench": "pnpm --filter @kubepit/desktop bench -- --outputJson ../../perf-results/frontend-bench.json"`), `.gitignore` (`perf-results/`)

**Interfaces:**
- Consumes: `generateScaleObjects` (Task 6).
- Produces:
  - `healthInputFor(preset): HealthInput` (every list loaded).
  - `topologyInputFor(preset, namespace: string | null): TopologyInput`.
  - `netpolInputFor(preset): NpInput`, plus 2 default-deny and 1 000 label policies.
  - `logLines(format: 'json' | 'logfmt' | 'text', n: number): string[]`.
  - `tableItems(preset): KubeObject[]`.
  - Bench names are the budget ids themselves:
    - `topology/namespace_l`: `buildTopology` + `deriveView` (root null, `DEFAULT_MAX_NODES`) + `layoutTopology` on one `l` namespace;
    - `topology/all_m`: the same over all namespaces of `m`;
    - `topology/layout_800`, `topology/layout_1200`: `layoutTopology` on views capped at 800 and 1 200;
    - `health/scan_m`, `health/scan_l`: `scanHealth`;
    - `netpol/build_l`: `buildCluster`;
    - `netpol/matrix_namespace_l`: `namespaceMatrix(cluster, 'ns-0001', null)`;
    - `logs/parse_json`, `logs/parse_logfmt`, `logs/parse_text`: `parseLogLine` over 10 000 lines;
    - `logs/detect_level`: `detectLevelToken` over 10 000 lines;
    - `logs/record_index_50k`: `new RecordIndex().ingest(50 000 mixed RawLine)`;
    - `table/filter_sort_20k`: `filterItems` + `sortItems` on `l` pods sorted by the default column.

- [ ] **Step 1: Write the bench files** with `bench('<id>', fn, { time: 2000 })`. Build inputs once at module scope.

- [ ] **Step 2: Run them**

Run: `pnpm perf:bench && node -e "console.log(Object.keys(require('./perf-results/frontend-bench.json')).length > 0)"`
Expected: every id appears in the bench output table; the JSON exists.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src package.json .gitignore
git commit -m "perf(bench): Vitest benches for topology, health, netpol, logs and table model"
```

---

### Task 8: In-app performance probe

**Files:**
- Create: `apps/desktop/src/lib/perf/stats.ts`, `apps/desktop/src/lib/perf/probe.ts`
- Modify: `apps/desktop/src/main.tsx:15-17` (install the probe global)
- Modify: `apps/desktop/src/components/workbench/table/ResourcePage.tsx` (marks), `components/workbench/data/watchCache.ts:108-145` (apply → flush duration), `components/workbench/topology/TopologyMap.tsx:98-120` (build/view/layout), `components/workbench/health/useHealthScan.ts:~226` (scan duration), `components/workbench/ViewPanes.tsx` (view switch)
- Test: `apps/desktop/src/lib/perf/stats.test.ts`, `apps/desktop/src/lib/perf/probe.test.ts`

**Interfaces:**
- Produces:
  - `percentile(values: readonly number[], p: number): number`: nearest-rank; `NaN` for an empty list.
  - `fpsReport(frameTimesMs: readonly number[]): { frames: number; medianFps: number; p95FrameMs: number; longFrames: number }`. A long frame is > 50 ms.
  - `perfEnabled(): boolean`. True for `?perf=1` or `localStorage['kubepit.perf'] === '1'`, evaluated once.
  - `perfMark(name: string): void` and `recordDuration(id: string, ms: number, meta?: Record<string, number>): void`. Both are no-ops when disabled.
  - `measureSince(mark: string, id: string): number | null`.
  - `perfReport(): { durations: Record<string, number[]>; marks: Record<string, number> }` and `resetPerf(): void`.
  - `installPerfGlobal(driver: PerfDriver): void`. It sets `window.__kubepitPerf` only when enabled. `PerfDriver`:
    - `connect(clusterId)`, `openKind(clusterId, kindKey)`, `openView(clusterId, viewKey)`;
    - `switchView(viewKey): Promise<number>` (ms until two animation frames after the switch);
    - `scrollTable(ms): Promise<FpsReport>`, `startFps(): void`, `stopFps(): FpsReport` (manual sampling while dragging), `longTasks(): number[]`;
    - `heap(): number | null` (`performance.memory` when present), `domNodes()`;
    - `watchStats()` (watchCache entries: key, listeners, items), `mockWatchStats()`;
    - `report()`, `reset()`.
  - Recorded ids: `table:ttfr` (navigate → first non-empty rows committed), `table:synced`, `watch:apply` (with `items`), `map:build`, `map:view`, `map:layout`, `health:scan`, `view:switch`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/lib/perf/stats.test.ts
import { describe, expect, it } from 'vitest';
import { fpsReport, percentile } from './stats';

describe('perf stats', () => {
  it('percentile uses nearest rank', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([], 50)).toBeNaN();
  });
  it('fpsReport turns frame times into fps and long frames', () => {
    const r = fpsReport([...Array(60).fill(16.7), 80]);
    expect(r.frames).toBe(61);
    expect(Math.round(r.medianFps)).toBe(60);
    expect(r.p95FrameMs).toBeCloseTo(16.7);
    expect(r.longFrames).toBe(1);
  });
});
```

```ts
// apps/desktop/src/lib/perf/probe.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('probe', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it('probe is inert when disabled', async () => {
    vi.stubGlobal('window', { location: { search: '' }, localStorage: { getItem: () => null } });
    const mark = vi.fn(); vi.stubGlobal('performance', { mark, now: () => 0 });
    const p = await import('./probe');
    p.perfMark('table:navigate'); p.recordDuration('watch:apply', 3);
    p.installPerfGlobal({} as never);
    expect(mark).not.toHaveBeenCalled();
    expect(p.perfReport().durations).toEqual({});
    expect((globalThis.window as { __kubepitPerf?: unknown }).__kubepitPerf).toBeUndefined();
  });
  it('records durations when enabled with ?perf=1', async () => {
    vi.stubGlobal('window', { location: { search: '?perf=1' }, localStorage: { getItem: () => null } });
    vi.stubGlobal('performance', { mark: vi.fn(), now: () => 0 });
    const p = await import('./probe');
    p.recordDuration('watch:apply', 3); p.recordDuration('watch:apply', 5);
    expect(p.perfReport().durations['watch:apply']).toEqual([3, 5]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kubepit/desktop test -- src/lib/perf`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the probe and the instrumentation.**
  - Every instrumentation call is `if (perfEnabled()) …` or a no-op function, so disabled builds do no work beyond one boolean check.
  - `scrollTable` finds the active table's scroll container (`[role="rowgroup"]`'s scroll parent). It scrolls with `requestAnimationFrame` at 2 000 px/s and collects frame deltas and long tasks (`PerformanceObserver('longtask')`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck && pnpm --filter @kubepit/desktop build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "perf(ui): dev-only in-app probe (?perf=1) for rows, scrolling, map, health and watches"
```

---

### Task 9: Playwright UI driver and soak

**Files:**
- Modify: `package.json` (root devDependency `playwright` `^1.55.0`; script `"perf:ui": "node scripts/perf/ui-perf.mjs"`)
- Create: `scripts/perf/lib.mjs`, `scripts/perf/ui-perf.mjs`
- Test: `scripts/perf/lib.test.mjs`

**Interfaces:**
- Consumes: the probe driver (Task 8); `?scale=&churn=` (Task 6).
- Produces:
  - CLI: `pnpm perf:ui -- --preset s|m|l --scenarios ttfr,scroll,apply,map,health,leave [--churn 50] [--soak <minutes>] [--port 4173] [--out perf-results/ui.json]`.
  - It expects `pnpm --filter @kubepit/desktop build` to have run, starts `vite preview --port <port> --strictPort` from `apps/desktop`, and launches Chromium with `--enable-precise-memory-info --js-flags=--expose-gc`.
  - `lib.mjs`:
    - `parseArgs(argv: string[]): Options`: defaults preset `m`, all scenarios, churn 0, soak 0, port 4173.
    - `soakSummary(samples: Array<{ minute: number; heap: number; dom: number }>): { heapRatio: number; domDrift: number }`. The ratio is the last sample's heap ÷ the first sample at or after minute 5; drift is `(lastDom − firstDom) / firstDom`.
    - `resultIds(preset, measurements): Record<string, number>`. It maps to the `ui/*` ids in the spec budgets table (`ui/ttfr_pods_<preset>` and so on).
  - Safety: the driver aborts if `page.evaluate(() => '__TAURI_INTERNALS__' in window)` is true, and only navigates to `http://localhost:<port>`.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/perf/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resultIds, soakSummary } from './lib.mjs';

test('parseArgs applies defaults and validates the preset', () => {
  assert.deepEqual(parseArgs([]).preset, 'm');
  assert.deepEqual(parseArgs(['--preset', 'l', '--soak', '30']).soak, 30);
  assert.throws(() => parseArgs(['--preset', 'xl']), /preset/);
});
test('soakSummary compares the end with the 5-minute sample', () => {
  const s = soakSummary([{ minute: 1, heap: 50, dom: 900 }, { minute: 5, heap: 100, dom: 1000 }, { minute: 30, heap: 110, dom: 1050 }]);
  assert.equal(s.heapRatio, 1.1);
  assert.equal(s.domDrift, 0.05);
});
test('resultIds names results like the budgets', () => {
  assert.deepEqual(Object.keys(resultIds('l', { ttfr: 900, synced: 3000 })).sort(), ['ui/synced_pods_l', 'ui/ttfr_pods_l']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/perf/`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** Each scenario calls the probe driver:
  - `ttfr`: `connect('c-scale-<p>')`, `openKind(…, 'pods')`, then poll `report()` for `table:ttfr` and `table:synced`.
  - `scroll`: `scrollTable(5000)`.
  - `apply`: needs churn; run for 20 s and take the p95 of `watch:apply`.
  - `map`: `openView(…, 'resource-map')` scoped to `ns-0001`, then all namespaces on `m`.
  - `health`: `health:scan` plus the long tasks.
  - `leave`: `switchView` from the map to the overview.
  - `--soak N` cycles pods table → map → health every 60 s. It calls `window.gc()` before each sample and samples every minute.

  Write the JSON result file.

- [ ] **Step 4: Run the tests and one real pass**

Run: `node --test scripts/perf/ && pnpm --filter @kubepit/desktop build && pnpm exec playwright install chromium && pnpm perf:ui -- --preset s --scenarios ttfr,scroll`
Expected: the tests pass, and `perf-results/ui.json` holds `ui/ttfr_pods_s` and `ui/scroll_fps_s`.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/perf
git commit -m "perf(ui): Playwright driver for rows, scrolling, map, health, view switch and soak"
```

---

### Task 10: Budgets, compare script and baseline

**Files:**
- Create: `perf/budgets.json`, `scripts/perf/compareLib.mjs`, `scripts/perf/compare.mjs`
- Modify: `package.json` (scripts `"perf:rust": "cargo bench -p kubepit-core -- --noplot"`, `"perf:compare": "node scripts/perf/compare.mjs"`, `"perf:test": "node --test scripts/perf/"`)
- Modify: `docs/superpowers/specs/2026-09-28-large-cluster-performance-design.md` (Results table)
- Test: `scripts/perf/compare.test.mjs`

**Interfaces:**
- Produces:
  - `perf/budgets.json`: `{ "ci_slack": 2.5, "budgets": { "<id>": { "group": "rust" | "e2e" | "engines" | "ui" | "structural", "value": number, "unit": "ns" | "ms" | "bytes" | "ratio" | "fps" | "count", "direction": "max" | "min", "timing": boolean, "per"?: number } } }`. It holds every id of the spec's Budgets section, with values converted to the unit. `per` divides a measured total for per-line budgets (10 000 for the logs ids).
  - `loadResults(paths): Record<string, { value: number; unit: string }>`:
    - Criterion `median.point_estimate` (ns), from `target/criterion/<group>/<name>/new/estimates.json`;
    - Vitest bench JSON `median ?? p50 ?? mean` (ms);
    - `perf-results/ui.json`;
    - `target/perf/backend-e2e.json`.
  - `evaluate(budgets, results, { slack, only }): { rows: Array<{ id; value; budget; limit; ok; missing }>; failed: boolean; warnings: string[] }`.
  - CLI: `node scripts/perf/compare.mjs [--slack N] [--only rust,e2e,engines,ui,structural]`. It prints a table and exits 1 on failure.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/perf/compare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './compareLib.mjs';

const budgets = { ci_slack: 2.5, budgets: {
  'watch/steady_500': { group: 'rust', value: 3e6, unit: 'ns', direction: 'max', timing: true },
  'ui/scroll_fps_l': { group: 'ui', value: 55, unit: 'fps', direction: 'min', timing: true },
  'structural/list_requests_without_limit': { group: 'structural', value: 2, unit: 'count', direction: 'max', timing: false },
  'logs/parse_json': { group: 'engines', value: 0.004, unit: 'ms', direction: 'max', timing: true, per: 10000 },
} };

test('timings pass within budget × slack and fail beyond', () => {
  const r = evaluate(budgets, { 'watch/steady_500': { value: 7e6, unit: 'ns' } }, { slack: 2.5, only: ['rust'] });
  assert.equal(r.failed, false);
  assert.equal(evaluate(budgets, { 'watch/steady_500': { value: 8e6, unit: 'ns' } }, { slack: 2.5, only: ['rust'] }).failed, true);
});
test('min budgets divide by the slack; structural budgets ignore it', () => {
  assert.equal(evaluate(budgets, { 'ui/scroll_fps_l': { value: 23, unit: 'fps' } }, { slack: 2.5, only: ['ui'] }).failed, false);
  assert.equal(evaluate(budgets, { 'structural/list_requests_without_limit': { value: 3, unit: 'count' } }, { slack: 2.5, only: ['structural'] }).failed, true);
});
test('per-line budgets divide the measured total', () => {
  assert.equal(evaluate(budgets, { 'logs/parse_json': { value: 35, unit: 'ms' } }, { slack: 1, only: ['engines'] }).failed, false);
  assert.equal(evaluate(budgets, { 'logs/parse_json': { value: 45, unit: 'ms' } }, { slack: 1, only: ['engines'] }).failed, true);
});
test('missing budgeted result fails', () => {
  const r = evaluate(budgets, {}, { slack: 2.5, only: ['rust'] });
  assert.equal(r.failed, true);
  assert.equal(r.rows[0].missing, true);
});
test('unknown result ids only warn', () => {
  const r = evaluate(budgets, { 'watch/steady_500': { value: 1e6, unit: 'ns' }, 'new/thing': { value: 1, unit: 'ms' } }, { slack: 2.5, only: ['rust'] });
  assert.equal(r.failed, false);
  assert.match(r.warnings.join('\n'), /new\/thing/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/perf/compare.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `compareLib.mjs`, `compare.mjs` and `budgets.json`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/perf/`
Expected: PASS.

- [ ] **Step 5: Record the baseline on the reference machine.**
  1. Run: `pnpm perf:rust && pnpm perf:bench && pnpm --filter @kubepit/desktop build && pnpm perf:ui -- --preset l --churn 50 --soak 30 && for p in s m; do pnpm perf:ui -- --preset $p --scenarios ttfr,map,health --out perf-results/ui-$p.json; done && pnpm perf:compare -- --slack 1`
  2. Copy every measured value into the spec's Results table (Baseline column).
  3. Mark each gate H1–H10 and MAP as "fires" or "does not fire", using the gate definitions in the spec (D8).

  A budget that the baseline misses stays in `budgets.json` unchanged: it is what its gated task must reach.

- [ ] **Step 6: Commit**

```bash
git add perf package.json scripts/perf docs/superpowers/specs
git commit -m "perf: budgets, compare script and the first baseline"
```

---

### Task 11: CI regression guard

**Files:**
- Modify: `.github/workflows/ci.yml` (from the CI plan): add a `perf-guard` job
- Create: `.github/workflows/perf-nightly.yml`
- Modify: `docs/ARCHITECTURE.md` (new "Performance" section: presets, how to run each suite, budgets, CI)

**Interfaces:**
- Consumes: the CI plan's `ci.yml`. If it does not exist, stop and run the CI plan first.
- Produces:
  - Job `perf-guard` on `ubuntu-latest`, on pull requests. It sets up Node 22, pnpm 9.14.4 and stable Rust (no Tauri system packages; only `kubepit-core` is built), then runs:
    1. `pnpm install --frozen-lockfile`
    2. `node --test scripts/perf/`
    3. `cargo bench -p kubepit-core -- --warm-up-time 1 --measurement-time 3 --noplot`
    4. `pnpm perf:bench`
    5. `node scripts/perf/compare.mjs --slack 2.5 --only rust,e2e,engines,structural`

    It uploads `perf-results/`, `target/perf/` and `target/criterion/` as artifacts.
  - `perf-nightly.yml`: `schedule: cron '0 3 * * *'` plus `workflow_dispatch`. It runs:
    1. build the UI;
    2. `pnpm exec playwright install --with-deps chromium`;
    3. `pnpm perf:ui -- --preset l --churn 50 --soak 30`;
    4. `node scripts/perf/compare.mjs --slack 2.5 --only ui`.

    It uploads the results.

- [ ] **Step 1: Add the job and the workflow.**

- [ ] **Step 2: Validate the YAML and dry-run the commands locally**

Run: `node -e "const y=require('./apps/desktop/node_modules/yaml');for (const f of ['.github/workflows/ci.yml','.github/workflows/perf-nightly.yml']) y.parse(require('fs').readFileSync(f,'utf8'));console.log('ok')"`, then run the `perf-guard` commands in order.
Expected: `ok`, and `compare.mjs` exits 0 with the baseline results.

- [ ] **Step 3: Commit**

```bash
git add .github docs/ARCHITECTURE.md
git commit -m "ci(perf): PR perf guard and nightly UI performance suite"
```

---

## Gated optimizations

Every gated task starts by checking its gate against the Results table from Task 10, or by re-running the named benchmark.

**When the gate does not fire:**
1. Write "no (measured value)" in the Gate column.
2. Commit the spec change as `docs(perf): <id> gate not fired`.
3. Skip the task's remaining steps.

**When the gate fires:**
1. Complete the task.
2. Re-run its benchmark and write the result in the After column in the same commit.

### Task 12 (H1): Shared per-cluster informers

**Files:**
- Create: `crates/kubepit-core/src/informer.rs`; modify `crates/kubepit-core/src/lib.rs` (`pub mod informer;`), `app.rs` (field `informers: Informers`), `connection.rs:383` (`stop_cluster` drops the cluster's informers)
- Modify: `crates/kubepit-core/src/watch.rs:250-346` (`run_watch` consumes a subscription)
- Modify: `crates/kubepit-core/src/alerts/monitor.rs:53`, `change_journal.rs:376`, `history/persist.rs:72`
- Modify: `crates/kubepit-core/tests/perf_probe.rs` (expected fan-out)
- Test: `crates/kubepit-core/tests/informer.rs`

**Interfaces:**
- Produces:
  - `pub struct InformerKey { pub cluster_id: String, pub gvk: Gvk, pub namespace: Option<String> }` (`Hash`, `Eq`).
  - `pub enum InformerEvent { Init, InitApply(Arc<DynamicObject>), InitDone, Apply(Arc<DynamicObject>), Delete(Arc<DynamicObject>), Error(String) }`.
  - `impl Informers { pub fn subscribe(&self, client: Client, key: InformerKey) -> InformerSubscription }`.
  - `pub struct InformerSubscription { rx: broadcast::Receiver<InformerEvent> }` with `pub async fn next(&mut self) -> Option<InformerEvent>`. A subscriber that joins a synced informer first receives a replay (`Init`, `InitApply` per stored object, `InitDone`). `RecvError::Lagged` triggers a new replay.
  - Dropping the last subscription stops the watcher. The broadcast capacity is 1 024. Each informer runs `watcher::watcher(api, Config::default().any_semantic()).default_backoff()` and keeps a `HashMap<uid, Arc<DynamicObject>>` store.
  - `pub fn informer_keys(&self, cluster_id: &str) -> Vec<String>` on `Kubepit`: the live informers of a cluster as `"<plural>[/<namespace>]"`, sorted. Used by tests and the probe.
  - Alerts convert with `serde_json::from_value::<SlimPod>(serde_json::to_value(&*obj))`. The journal and persist use the `DynamicObject` directly.

- [ ] **Step 1: Check the gate.** It fires if Task 2 shows ≥ 2 streams for one path **and** `e2e/max_rss_l_all_watchers` or `e2e/watch_pods_synced_l` misses its budget.

- [ ] **Step 2: Write the failing tests**

```rust
// crates/kubepit-core/tests/informer.rs
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_consumers_share_one_watch_stream() {
    let (server, app, id) = scale_app("s").await;           // alerts on, journal off
    app.set_alert_monitoring(true);
    app.cluster_connect(&id).await.unwrap();
    let watch = app.resource_watch(&id, &pods(), vec![], |_| true).await.unwrap();
    settle().await;
    assert_eq!(watch_streams_for(&server.log, "/api/v1/pods"), 1);
    app.resource_unwatch(&watch);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ui_unwatch_keeps_the_alert_watcher_running() {
    let (server, app, id) = scale_app("s").await;
    app.set_alert_monitoring(true);
    app.cluster_connect(&id).await.unwrap();
    let watch = app.resource_watch(&id, &pods(), vec![], |_| true).await.unwrap();
    settle().await;
    app.resource_unwatch(&watch);
    settle().await;
    assert!(app.informer_keys(&id).contains(&"pods".to_string()), "alerts still hold the pods informer");
    assert_eq!(watch_streams_for(&server.log, "/api/v1/pods"), 1, "no second watch was opened");
    app.set_alert_monitoring(false);
    settle().await;
    assert!(!app.informer_keys(&id).contains(&"pods".to_string()), "the last subscriber stopped it");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn late_subscriber_receives_a_full_replay() {
    let (_server, app, id) = scale_app("s").await;
    app.cluster_connect(&id).await.unwrap();
    let first = app.resource_watch(&id, &pods(), vec![], |_| true).await.unwrap();
    settle().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.resource_watch(&id, &pods(), vec![], move |b| tx.send(b).is_ok()).await.unwrap();
    let mut total = 0;
    while let Some(b) = rx.recv().await { total += b.upserts.len(); if b.synced { break; } }
    assert_eq!(total, 1_000);
    app.resource_unwatch(&first);
}
```

The helpers `scale_app`, `settle` (1 s), `pods()` and `watch_streams_for` live in the file. In `perf_probe.rs`, change the expected streams for `/api/v1/pods`, `/api/v1/nodes` and `/apis/apps/v1/deployments` to 1.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test informer --test perf_probe`
Expected: FAIL (2 streams observed).

- [ ] **Step 4: Implement** the hub and move the four consumers onto it. Keep each consumer's 403 fallback: a forbidden cluster-wide key makes the consumer subscribe to per-namespace keys.

- [ ] **Step 5: Run the tests and the benches**

Run: `cargo test --workspace && cargo bench -p kubepit-core --bench e2e -- --quick --noplot`
Expected: PASS. Record the After values.

- [ ] **Step 6: Commit**

```bash
git add crates docs/superpowers/specs
git commit -m "perf(core): share one watcher per resource between UI, alerts, journal and history"
```

---

### Task 13 (H2): Namespaced consumers derive from a live cluster-wide watch

**Files:**
- Modify: `apps/desktop/src/components/workbench/data/watchCache.ts:157-206`
- Create: `apps/desktop/src/components/workbench/data/deriveScoped.ts`
- Test: `apps/desktop/src/components/workbench/data/deriveScoped.test.ts`, `apps/desktop/src/components/workbench/data/watchCache.test.ts`

**Interfaces:**
- Produces:
  - `deriveScoped(snapshot: WatchSnapshot, namespaces: readonly string[]): WatchSnapshot`, memoized per (snapshot.version, namespaces key).
  - `subscribeWatch(clusterId: ClusterId, gvk: Gvk, namespaces: readonly string[], listener: () => void): { snapshot(): WatchSnapshot; unsubscribe(): void }`: the non-hook subscription that `useWatch` now wraps. Tests use it directly.
  - `useWatch(…, namespaces≠[])`, while `entries` holds a cluster-wide entry for the same (cluster, gvk, version) that has listeners, is `synced` and is not forbidden, subscribes to that entry and returns `deriveScoped(...)` instead of starting its own backend watch.

- [ ] **Step 1: Check the gate.** It fires if `mockWatchStats()` (probe `watchStats()`) during the standard scenario (pods table with namespace `ns-0001`, the health view, the Resource Map and the netpol view on `?scale=m`) shows the same (cluster, kind) with more than one scope.

- [ ] **Step 2: Write the failing tests**

```ts
// deriveScoped.test.ts
it('keeps only objects of the given namespaces and reuses the result per version', () => {
  const snap = snapshot([pod('a', 'x'), pod('b', 'y'), pod('a', 'z')], 7);
  const d = deriveScoped(snap, ['a']);
  expect(d.items.map((o) => o.metadata.name)).toEqual(['x', 'z']);
  expect(deriveScoped(snap, ['a'])).toBe(d);
  expect(d.version).toBe(7);
});

// watchCache.test.ts — vi.mock('@/lib/ipc') records resourceWatch calls and keeps each onBatch callback;
// requestAnimationFrame is stubbed to run synchronously
it('a namespaced subscriber reuses a synced cluster-wide watch', async () => {
  const all = subscribeWatch('c1', PODS, [], () => {});
  await Promise.resolve();
  onBatchOf(0)({ watch_id: 'w', reset: true, synced: true, error: null, deletes: [], upserts: [pod('a', 'x'), pod('b', 'y')] });
  const scoped = subscribeWatch('c1', PODS, ['a'], () => {});
  expect(resourceWatch).toHaveBeenCalledTimes(1);
  expect(scoped.snapshot().items.map((o) => o.metadata.name)).toEqual(['x']);
  scoped.unsubscribe(); all.unsubscribe();
});
```

- [ ] **Step 3: Run the tests to verify they fail.** Run: `pnpm --filter @kubepit/desktop test -- src/components/workbench/data`. Expected: FAIL.

- [ ] **Step 4: Implement.** If the cluster-wide entry stops or becomes forbidden while a derived subscriber is live, the derived subscriber falls back to its own entry.

- [ ] **Step 5: Run the tests to verify they pass, then re-measure `mockWatchStats()`.** Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck`. Expected: PASS; one scope per kind.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src docs/superpowers/specs
git commit -m "perf(ui): namespaced watches derive from a live cluster-wide watch of the same kind"
```

---

### Task 14 (H3): Metadata-only watches for identity-only consumers

**Files:**
- Modify: `crates/kubepit-core/src/watch.rs:312-346`, `crates/kubepit-core/src/types.rs` (`WatchOptions`)
- Modify: `apps/desktop/src-tauri/src/ipc/resources.rs:37-50`
- Modify: `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts:190-201`, `components/workbench/data/watchCache.ts` (key suffix `|meta`), `lib/ipc/mock/resources.ts:121-146`
- Modify: `apps/desktop/src/lib/kube/topology/sources.ts` (per-slot `metadataOnly`), `components/workbench/topology/useTopologyData.ts`
- Test: `crates/kubepit-core/tests/fake_apiserver.rs` or `tests/scale_fixture.rs`; `apps/desktop/src/components/workbench/data/watchCache.test.ts`

**Interfaces:**
- Produces:
  - Rust `pub struct WatchOptions { #[serde(default)] pub metadata_only: bool }` and `resource_watch(&self, cluster_id, gvk, namespaces, options: WatchOptions, sink)`. Metadata-only watches use `kube::runtime::metadata_watcher`. Batch objects carry `apiVersion`, `kind` (the resource's kind) and `metadata` only.
  - TS `resourceWatch(clusterId, gvk, namespaces, onBatch, options?: { metadataOnly?: boolean })` and `useWatch(clusterId, gvk, namespaces, enabled, options?)`.
  - Topology marks a slot `metadataOnly` only when `build.ts`/`refs.ts` read nothing but `metadata` from that kind. Check with grep before flagging. The candidates are Secret, ConfigMap and ServiceAccount.

- [ ] **Step 1: Check the gate.** It fires if, at `l` and a namespace-scoped map, Secrets + ConfigMaps are > 30% of the initial batch bytes (probe `watchStats()` with JSON sizes) **and** `ui/map_namespace_l` misses its budget.

- [ ] **Step 2: Write the failing tests.**
  - Rust `metadata_only_watch_sends_identity_only` against the scale fixture:
    - the first batch holds 250 secrets;
    - each has `metadata.name` and no `data`;
    - the logged request carries `Accept: …as=PartialObjectMetadataList…`.
  - TS: `watchKey(c, gvk, [], { metadataOnly: true })` differs from the full key, and the options reach `ipc.resourceWatch`.

- [ ] **Step 3: Run the tests to verify they fail.** Run: `cargo test -p kubepit-core metadata_only && pnpm --filter @kubepit/desktop test -- watchCache`. Expected: FAIL.

- [ ] **Step 4: Implement** across Rust, Tauri, TS and the mock (the mock strips everything except identity when `metadataOnly`).

- [ ] **Step 5: Run the checks and re-measure `ui/map_namespace_l`.** Expected: PASS; record the After value.

- [ ] **Step 6: Commit**

```bash
git add crates apps/desktop docs/superpowers/specs
git commit -m "perf: metadata-only watches for map slots that only need identity"
```

---

### Task 15 (H4): Page the remaining non-watch lists

**Files:**
- Create: `crates/kubepit-core/src/paging.rs`; modify `lib.rs`
- Modify: `crates/kubepit-core/src/resources.rs:197-229`, `overview.rs:176-215`, `metrics.rs:146-188`
- Modify: `crates/kubepit-core/tests/perf_probe.rs` (the unpaged set becomes empty)
- Test: `crates/kubepit-core/tests/scale_fixture.rs` or a new `tests/paging.rs`

**Interfaces:**
- Produces: `pub async fn list_paged<K>(api: &Api<K>, params: ListParams, page: u32, max_items: usize) -> Result<ObjectList<K>>`.
  - It follows `continue`, with `page = 500`.
  - Past `max_items` (50 000) it fails with "more than {max} {plural}; narrow the namespace or label selector".
  - `resource_list`, `cluster_overview` (which uses `list_metadata` where it only counts) and both metrics lists use it.

- [ ] **Step 1: Check the gate.** It fires if `unpaged_lists` at `l` includes a collection above 5 000 objects **and** `e2e/max_rss_l_all_watchers` or the overview latency misses its budget.

- [ ] **Step 2: Write the failing tests.**
  - `list_paged_follows_continue_and_caps`: 10 000 pods from `m` come back in 20 requests with `limit=500`; `max_items = 5_000` fails with the message above.
  - The probe's unpaged expectation becomes `BTreeSet::new()`.

- [ ] **Step 3: Run the tests to verify they fail.** Run: `cargo test -p kubepit-core --test paging --test perf_probe`. Expected: FAIL.

- [ ] **Step 4: Implement.**

- [ ] **Step 5: Run the tests and the e2e bench.** Expected: PASS; record the After values.

- [ ] **Step 6: Commit**

```bash
git add crates docs/superpowers/specs
git commit -m "perf(core): page resource lists, the cluster overview and metrics lists"
```

---

### Task 16 (H5): Run heavy engines in a worker

**Files:**
- Create: `apps/desktop/src/lib/perf/worker/engineWorker.ts`, `apps/desktop/src/lib/perf/worker/client.ts`
- Modify: the call sites whose engine fired the gate: `components/workbench/health/useHealthScan.ts:~226`, `components/workbench/netpol/useNetpolData.ts:113`, `components/workbench/topology/useTopologyData.ts:90` / `TopologyMap.tsx:100-119`
- Test: `apps/desktop/src/lib/perf/worker/client.test.ts`

**Interfaces:**
- Produces:
  - `type EngineTask = { kind: 'health'; input: HealthInput; locale: Locale } | { kind: 'netpol'; input: NpInput } | { kind: 'topology'; input: TopologyInput; view: ViewOptions }`.
  - `runEngine<T>(task: EngineTask): Promise<T>`. It uses a lazily created module worker (`new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' })`). Without `Worker` (Node, tests) it runs inline.
  - The worker calls `setLocale(task.locale, false)` before health scans. Only engines named by the gate move to the worker.

- [ ] **Step 1: Check the gate.** It fires if the probe's long tasks > 50 ms during `health`, `map` or netpol scenarios at `m` point at that engine (a matching `recordDuration` id in the same frame).

- [ ] **Step 2: Write the failing test**

```ts
it('inline fallback returns what the engine returns', async () => {
  const input = healthInputFor('s');
  expect(await runEngine({ kind: 'health', input, locale: 'en' })).toEqual(scanHealth(input));
});
```

- [ ] **Step 3: Run the test to verify it fails, implement, then run to verify it passes.** Run: `pnpm --filter @kubepit/desktop test -- src/lib/perf/worker && pnpm --filter @kubepit/desktop build`. Expected: PASS, and the build emits the worker chunk. The Tauri CSP already allows `worker-src 'self' blob:`.

- [ ] **Step 4: Re-run `pnpm perf:ui -- --preset m --scenarios health,map`.** Expected: no long task > 50 ms from the moved engines. Record the After value.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src docs/superpowers/specs
git commit -m "perf(ui): run health, netpol or topology engines in a worker"
```

---

### Task 17 (H6): Acknowledged watch batches

**Files:**
- Modify: `crates/kubepit-core/src/watch.rs` (`AckWindow`, `WatchBatch.seq`, `resource_watch_ack`), `crates/kubepit-core/src/types.rs:213-222`
- Modify: `apps/desktop/src-tauri/src/ipc/resources.rs`, `apps/desktop/src-tauri/src/lib.rs:88-89`
- Modify: `apps/desktop/src/types/index.ts:295-303`, `lib/ipc.ts:190-202`, `components/workbench/data/watchCache.ts:108-145`, `lib/ipc/mock/resources.ts`
- Test: unit tests in `watch.rs`; `crates/kubepit-core/tests/fake_apiserver.rs`

**Interfaces:**
- Produces:
  - `pub const MAX_UNACKED: u64 = 4` and `pub const ACK_TIMEOUT: Duration = Duration::from_secs(60)`.
  - `pub struct AckWindow { sent: u64, acked: u64 }` with `can_send(&self) -> bool`, `on_sent(&mut self) -> u64` (returns the seq) and `on_ack(&mut self, seq: u64)`.
  - `WatchBatch.seq: u64`. While `!can_send`, `run_watch` keeps folding events into the aggregator (the upserts map is latest-wins) and does not flush. It stops when no ack arrives for `ACK_TIMEOUT`.
  - `Kubepit::resource_watch_ack(&self, watch_id: &str, seq: u64)`, a Tauri command `resource_watch_ack(watchId, seq)`, and `ipc.resourceWatchAck`.
  - `WatchEntry` acks after `applyBatch`. The mock acks as a no-op.

- [ ] **Step 1: Check the gate.** It fires if the churn soak at `l` shows `watch:apply` lag > 1 s (backend batch time vs apply time), or a watch still running (`watchStats`/backend log) after its window closed.

- [ ] **Step 2: Write the failing tests.**
  - `ack_window_blocks_after_four_unacked`: four `on_sent` → `!can_send`; `on_ack(2)` → `can_send`.
  - `unacked_watch_coalesces_and_stops_after_timeout`, with tokio time paused:
    - a sink that never acks receives exactly 4 batches while 2 000 burst events arrive (`ScaleWatch::PodBurst(2000)`);
    - the task ends once 60 s have been advanced.

- [ ] **Step 3: Run the tests to verify they fail, implement, then run to verify they pass.** Run: `cargo test -p kubepit-core watch && pnpm typecheck && pnpm --filter @kubepit/desktop test`. Expected: PASS.

- [ ] **Step 4: Re-run the churn soak.** Record the After values.

- [ ] **Step 5: Commit**

```bash
git add crates apps/desktop docs/superpowers/specs
git commit -m "perf: acknowledged watch batches bound IPC queues and stop orphaned watches"
```

---

### Task 18 (H7): Incremental snapshots and sort merges

**Files:**
- Modify: `apps/desktop/src/components/workbench/data/watchCache.ts:131-145` (`WatchSnapshot.change`)
- Modify: `apps/desktop/src/components/workbench/table/tableModel.ts:46-68` (`mergeSorted`), `table/useKindTable.ts:89-98`
- Test: `apps/desktop/src/components/workbench/table/tableModel.test.ts`

**Interfaces:**
- Produces:
  - `WatchSnapshot.change: { reset: boolean; upserted: ReadonlySet<string>; deleted: ReadonlySet<string> }`, relative to the previous snapshot.
  - `byUid` is built lazily with a memoized getter.
  - `mergeSorted(prev: readonly KubeObject[], byUid: ReadonlyMap<string, KubeObject>, change: WatchSnapshot['change'], compare: (a: KubeObject, b: KubeObject) => number): KubeObject[]`: it removes changed or deleted uids and binary-inserts the changed objects.
  - `useKindTable` uses it when the filter and sort are unchanged and `!change.reset`.

- [ ] **Step 1: Check the gate.** It fires if `ui/apply_p95_l_churn50` > 16 ms.

- [ ] **Step 2: Write the failing test**

```ts
it.each([1, 50, 500])('mergeSorted equals a full sort after %i random changes', (k) => {
  const { prev, next, change } = randomChange(tableItems('s'), k, 42);
  expect(mergeSorted(prev, next, change, compareByName).map(uid)).toEqual([...next.values()].sort(compareByName).map(uid));
});
```

- [ ] **Step 3: Run the test to verify it fails, implement, then run to verify it passes.** Run: `pnpm --filter @kubepit/desktop test -- src/components/workbench/table`. Expected: PASS.

- [ ] **Step 4: Re-run the `apply` scenario.** Record the After value.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src docs/superpowers/specs
git commit -m "perf(ui): incremental watch snapshots and sorted merges for busy tables"
```

---

### Task 19 (H8): Evict idle watch snapshots

**Files:**
- Modify: `apps/desktop/src/components/workbench/data/watchCache.ts:48-106,157-182`
- Test: `apps/desktop/src/components/workbench/data/watchCache.test.ts`

**Interfaces:**
- Produces: `export const IDLE_EVICT_MS = 300_000`. `stop()` schedules the removal of the entry from `entries` after `IDLE_EVICT_MS`. A new subscriber cancels the timer.

- [ ] **Step 1: Check the gate.** It fires if `ui/soak_heap_ratio` > 1.15.

- [ ] **Step 2: Write the failing tests** (fake timers, mocked ipc):
  - `idle entries are evicted after five minutes`: subscribe, unsubscribe, advance `IDLE_EVICT_MS + 1` → `watchStats()` no longer lists the key.
  - `resubscribing cancels eviction`.

- [ ] **Step 3: Run the tests to verify they fail, implement, then run to verify they pass.** Run: `pnpm --filter @kubepit/desktop test -- src/components/workbench/data`. Expected: PASS.

- [ ] **Step 4: Re-run the soak.** Record the After value.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src docs/superpowers/specs
git commit -m "perf(ui): evict watch snapshots idle for five minutes"
```

---

### Task 20 (H9): Change-journal hot path

**Files:**
- Modify: `crates/kubepit-core/src/change_journal/journal.rs:279-330` (`Base`), `crates/kubepit-core/src/change_journal.rs:273-284` (`JournalReader::details_after`)
- Test: existing `crates/kubepit-core/tests/change_journal.rs` plus a unit test in `journal.rs`

**Interfaces:**
- Produces:
  - `Base` stores the normalized `serde_json::Value` (not only its compact string); `Base::object(&self) -> &Value`.
  - `bytes()` accounting keeps using the serialized size computed on insert.
  - `JournalReader::details_after` clones the entries under the lock and renders YAML after releasing it.

- [ ] **Step 1: Check the gate.** It fires if `journal/apply_update` > 60 µs or `journal/details_after_500` > 50 ms.

- [ ] **Step 2: Write the failing test.** Add `apply_does_not_reparse_the_baseline` to `journal.rs`:
  - Add a `#[cfg(test)]` thread-local `BASELINE_PARSES` counter, incremented wherever a baseline string is parsed.
  - Fold 1 000 updates of one ConfigMap through `apply`.
  - Assert the counter is 0 and `journal.len() == 1_000`.

- [ ] **Step 3: Run the test to verify it fails, implement, then run the full suite and the watcher benches.** Run: `cargo test -p kubepit-core change_journal && cargo bench -p kubepit-core --bench watchers -- --quick --noplot`. Expected: PASS within budget.

- [ ] **Step 4: Commit**

```bash
git add crates docs/superpowers/specs
git commit -m "perf(journal): keep parsed baselines and render YAML outside the journal lock"
```

---

### Task 21 (H10): Fleet search at scale

**Files:**
- Modify: `crates/kubepit-core/src/fleet_search.rs:38-42,206-263`
- Test: `crates/kubepit-core/tests/fleet.rs`

**Interfaces:**
- Produces: `PAGE_SIZE = 2_000` for the metadata-only search lists, `KIND_CONCURRENCY = 8`, and `CLUSTER_TIMEOUT` unchanged at 10 s unless the benchmark still misses its budget after the first two changes.

- [ ] **Step 1: Check the gate.** It fires if `e2e/fleet_search_l` > 6 s.

- [ ] **Step 2: Write the failing test.** `fleet_search_pages_by_2000`: a search for `api` over pods on the `m` fixture, with `limit_per_kind` above 10 000, streams all 10 000 pods, and every list request it makes carries `limit=2000`.

- [ ] **Step 3: Run the test to verify it fails, implement, then run the tests and the e2e bench.** Run: `cargo test -p kubepit-core --test fleet && cargo bench -p kubepit-core --bench e2e -- --quick --noplot`. Expected: PASS and ≤ 6 s.

- [ ] **Step 4: Commit**

```bash
git add crates docs/superpowers/specs
git commit -m "perf(fleet): larger metadata pages and more kind concurrency for fleet search"
```

---

### Task 22 (MAP): Revisit the Resource Map cap

**Files:**
- Modify: `apps/desktop/src/lib/kube/topology/view.ts:56` (`DEFAULT_MAX_NODES`)
- Modify: `docs/ARCHITECTURE.md:709-715`
- Test: `apps/desktop/src/lib/kube/topology/view.test.ts`

**Interfaces:**
- Produces: `DEFAULT_MAX_NODES` = the largest of 400, 800 and 1 200 for which build + view + layout ≤ 250 ms (`topology/layout_800`, `topology/layout_1200` plus the build/view part of `topology/all_m`) **and** the probe's pan frames p95 ≤ 16 ms at that size in Chromium.

- [ ] **Step 1: Check the gate.** Measure 800 and 1 200 with the benches and a manual pan in `pnpm dev:ui?scale=m&perf=1` (`scrollTable` does not apply; use `__kubepitPerf.startFps()` while dragging for 5 s). If only 400 fits, record the numbers and stop.

- [ ] **Step 2: Write the failing test**

```ts
it('caps the view at DEFAULT_MAX_NODES with one "+N more" node per kind', () => {
  const view = deriveView(bigGraph(3000), { rootId: null, hops: 1, expanded: new Set(), hiddenKinds: new Set(), maxNodes: DEFAULT_MAX_NODES });
  expect(DEFAULT_MAX_NODES).toBe(/* chosen value */ 800);
  expect(view.nodes.length).toBeLessThanOrEqual(DEFAULT_MAX_NODES);
  expect(view.aggregated).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run the test to verify it fails, change the constant and the docs, then run the tests to verify they pass.** Run: `pnpm --filter @kubepit/desktop test -- src/lib/kube/topology`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src docs
git commit -m "perf(map): raise the Resource Map cap to the measured budget"
```

---

### Task 23: Final results and checks

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-large-cluster-performance-design.md` (Results complete; budgets tightened where the After values allow, with a note)
- Modify: `docs/ARCHITECTURE.md` ("Performance" section: gates fired and fixes applied)

- [ ] **Step 1: Run every check and the perf guard**

Run: `pnpm typecheck && pnpm i18n:check && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && pnpm --filter @kubepit/desktop build && pnpm --filter @kubepit/desktop test && node --test scripts/perf/ && pnpm perf:rust && pnpm perf:bench && pnpm perf:compare -- --slack 1 --only rust,e2e,engines,structural`
Expected: every command exits 0.

- [ ] **Step 2: Commit**

```bash
git add docs
git commit -m "docs(perf): final results and budgets"
```
