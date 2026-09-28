# Large-cluster performance: design

- **Date:** 2026-09-28
- **Status:** proposed
- **Plan:** `docs/superpowers/plans/2026-09-28-large-cluster-performance.md`
- **Base:** `main` at `c8d7ff2`
- **Depends on:**
  - The hardening plan (`2026-09-28-hardening-shipped-features`). It adds Vitest (its Task 1), fake-server request headers (its Task 17) and opt-in metrics sampling (its Task 18).
  - The CI plan, being written in parallel on the `docs/plans-release` branch. It provides the GitHub Actions workflow that the regression guard extends.

## Problem

Kubepit's data paths have only been exercised against the demo backend and small fake-server fixtures. The largest demo cluster has 612 pods and 24 nodes. The code has size caps that have never run end to end: 20 000 objects per health list, 5 000 pods in the metrics history, 400 map nodes and 50 000 log lines.

Reading the code turned up scale risks that nobody has measured:

- **Duplicate watches.**
  - Frontend: watch keys include the namespace scope (`watchCache.ts:159-162`). Pods are watched with the selected namespaces by tables, health, overview tiles and Pod Security, and cluster-wide (`[]`) by netpol, the overview health card and Node details. Services, NetworkPolicies, DaemonSets, Roles and RoleBindings split the same way.
  - Backend: every subsystem runs its own `kube::runtime` watcher: UI watches, alerts (pods, jobs, deployments, nodes), the change journal (17 kinds cluster-wide, including Secrets and ConfigMaps) and history persistence (Events).
- **Full objects everywhere.** There is no metadata-only watch. Alerts deserialise into slim types, but the full JSON still crosses the wire.
- **Unpaged lists.** Watches do page: kube-core drops `resourceVersion=0` when `limit` is set, so the initial list is `limit=500` plus `continue`. These do not:
  - `resource_list`;
  - `cluster_overview` (pods, deployments, nodes, events);
  - the metrics sampler (NodeMetrics and PodMetrics every 15 s);
  - `metrics_pods` polling from tables (every 15 s).
- **O(n) copies per frame.** `WatchEntry.flush` copies the whole map and items array on every animation frame that has changes (`watchCache.ts:131-145`). Tables then re-filter and re-sort everything (`useKindTable.ts:89-98`).
- **No backpressure.**
  - `Channel::send` serialises the batch on the watch task and queues large payloads in an unbounded per-webview map (`tauri-2.12.0/src/ipc/channel.rs`).
  - A large send to a closed webview returns `Ok`, so that watch runs until unwatch or disconnect.
- **Journal hot path.**
  - `ClusterJournal::apply` re-parses the baseline JSON on every event.
  - `JournalReader::details_after` converts up to 500 entries to YAML while holding the shared journal lock, every 3 s.
- **Fleet search.** It reads 40 pages at 20 000 pods inside a 10 s per-cluster timeout.
- **Retention.** `watchCache` entries keep their last snapshot until disconnect, even when nothing subscribes.
- **Demo backend.** The mock DB has O(n) `find`/`ownedBy` and quadratic generation. It emits whole lists as one batch; the real backend sends chunks of at most 500.

## Goals

- **G1.** Reproducible scale fixtures:
  - a synthetic fake API server for Rust;
  - a scaled demo cluster for `pnpm dev:ui`.

  Both are generated from one preset file.
- **G2.** Benchmarks and measurements covering:
  - backend: watch batching, `metrics_history`, the alert, change-journal and history watchers, fleet search, the Prometheus/Loki proxies, and the SQLite writer;
  - frontend: time-to-first-rows, table scroll FPS, Resource Map build and layout, the health scan, the netpol engine, structured log parsing, and memory over a 30-minute watch soak.
- **G3.** Numeric budgets with a CI regression guard.
- **G4.** Optimizations only where the harness proves a budget is missed, each behind a stated gate.

## Non-goals

- Load tests against real clusters. Safety rules forbid them.
- API server or etcd tuning.
- Clusters above 50 000 pods.
- Rewriting an engine without a measurement.
- Speculative infrastructure: an optimization task whose gate does not fire is skipped and recorded.
- Per-platform webview parity. CI measures Chromium. WKWebView (macOS) is measured by hand with the same in-app probe. WebView2 and WebKitGTK are not measured.

## Decisions

**D1. One preset file.** `perf/scale-presets.json` at the repository root is read by Rust (`include_str!`) and by TypeScript (a JSON import). Each preset defines:

- `namespaces`, `nodes`, `deploymentsPerNamespace`, `replicas`, `oldReplicaSets`;
- `configMapsPerDeployment`, `secretsPerDeployment`, `servicesPerDeployment`;
- `crds`, `crsPerCrd`, `events`, `seed`.

| Preset | Nodes | Namespaces | Deployments | Pods | Services | ConfigMaps | Secrets | CRDs × CRs | Events |
|--------|------:|-----------:|------------:|-----:|---------:|-----------:|--------:|-----------:|-------:|
| `s` | 50 | 25 | 250 | 1 000 | 250 | 500 | 250 | 20 × 10 | 2 000 |
| `m` | 500 | 200 | 2 500 | 10 000 | 2 500 | 5 000 | 2 500 | 100 × 20 | 10 000 |
| `l` | 1 000 | 400 | 5 000 | 20 000 | 5 000 | 10 000 | 5 000 | 200 × 20 | 20 000 |

Every Deployment also has one current and one old ReplicaSet, and one EndpointSlice per Service. The `m` and `l` sizes match the "10k / 20k pods, 1k nodes, 5k services, many CRDs" brief. One source keeps backend and UI numbers comparable.

**D2. Rust scale fixture.** `tests/support/scale.rs` generates objects deterministically from a preset and serves them through the existing fake server:

- discovery for built-ins and every generated CRD;
- lists that honour `limit`/`continue` (an opaque offset token, `410 Expired` for an unknown token), with `metadata.resourceVersion` and `remainingItemCount`;
- watches: quiet by default, or a burst of MODIFIED pod events;
- metadata-only answers when `Accept` asks for `PartialObjectMetadataList`;
- `fieldSelector` (`spec.nodeName`, `metadata.namespace`) and equality `labelSelector`.

Deterministic structural probes (request counts per path) are ordinary tests, not benchmarks.

**D3. Rust benchmarks with Criterion** (`crates/kubepit-core/benches/`, `harness = false`):

| Target | Covers |
|--------|--------|
| `watch` | `WatchAggregator` |
| `metrics_history` | `ClusterHistory` |
| `watchers` | alerts `Tracker` / `AlertBook`, journal `prepare`/`apply`/`details_after`, history `Writer` |
| `search_proxies` | `NameMatcher`, `prometheus::parse::parse_response`, `loki::parse::parse_query` |
| `e2e` | fake-server `resource_watch` to synced, fleet search, a proxied Prometheus query, backend max RSS |

`[profile.bench]` sets `lto = "thin"`, `codegen-units = 16` and `debug = "line-tables-only"`, so CI builds stay fast while `opt-level = "s"` (inherited from release) matches shipping code. Criterion writes `target/criterion/<group>/<name>/new/estimates.json`, which the compare script reads.

**D4. Frontend measurement in three layers.**

1. **Vitest bench** (`*.bench.ts`, Node) for the pure engines: topology build/view/layout, `scanHealth`, `buildCluster` + `namespaceMatrix`, `parseLogLine`, `detectLevelToken`, `RecordIndex`, and table filter/sort. None of them imports React or zustand (verified); they use `@/i18n/core`.
2. **An in-app probe** (`lib/perf/`), active only with `?perf=1` or `localStorage['kubepit.perf'] = '1'`, with no cost when inactive. It records:
   - time-to-first-rows and time-to-synced;
   - watch batch apply → flush duration;
   - FPS during a programmatic scroll;
   - long tasks;
   - map build/view/layout and health scan durations;
   - heap samples and watch-cache statistics.

   It is exposed as `window.__kubepitPerf`, with helpers to connect and open views.
3. **A Playwright driver** (`scripts/perf/ui-perf.mjs`, `playwright` dev dependency, Chromium) runs scenarios against `vite preview` of the production build with `?perf=1&scale=<preset>&churn=<n>`.

The macOS WKWebView number comes from the same probe in `pnpm tauri:dev`, opened through devtools. It is recorded by hand.

**D5. Scaled demo cluster.**
- `?scale=s|m|l` adds a `c-scale-<preset>` cluster to the demo backend. `&churn=<events/s>` adds pod churn: status and label changes, plus 10% create/delete.
- `window_open` keeps both parameters.
- Every demo watch now follows the backend's batch contract: a first batch with `reset: true` and at most 500 objects, further batches of at most 500 every 150 ms, and `synced: true` only on the last.
- Mock DB lookups (`find`, `ownedBy`, node scheduling) get indexes, so a 20 000-pod cluster builds in under 3 s.

**D6. Budgets** live in `perf/budgets.json`:
- Absolute numbers on the reference machine: Apple M-series (M2 Pro or newer), 16 GB+, macOS, on AC power.
- CI multiplies timing budgets by `ci_slack` (2.5 on GitHub-hosted runners).
- Structural budgets (request counts, pagination) are exact everywhere.
- The first baseline run (plan Task 10) fills the Results table below. A budget the current code already meets stays. A missed budget fires a gate. Budgets may be tightened later; loosening one needs a note in this spec.

**D7. CI guard.**
- Every PR: structural tests run as part of `cargo test`, plus a `perf-guard` job: Criterion in quick mode + Vitest bench → `scripts/perf/compare.mjs` with slack.
- `perf-nightly.yml` (schedule plus manual dispatch): the Playwright UI suite, including the 30-minute soak.
- Both extend the CI plan's workflows. If the CI plan has not landed, the CI task stops and waits.

**D8. Optimizations as gated hypotheses.** A gated task runs only when its gate fires. Every gated task records its before and after numbers in the Results table.

| Id | Hypothesis | Gate | Fix |
|----|------------|------|-----|
| H1 | Subsystems duplicate backend watches of the same resource | The structural probe shows ≥ 2 watch streams for one resource path at `l`, **and** backend max RSS or initial-sync CPU misses its budget | A per-cluster informer hub (`informer.rs`): one watcher per (gvk, scope) fanning out to UI aggregators, alerts, journal and persist, reference-counted |
| H2 | The UI opens several backend watches per kind (scope variants) | The demo watch registry shows the same (cluster, kind) registered with different scopes in the standard scenario (pods table + health + map + netpol on `m`) | Namespaced consumers derive a filtered view from a live cluster-wide entry of the same kind |
| H3 | Payload size of kinds consumers read only as metadata dominates | Secrets + ConfigMaps are > 30% of the map's initial bytes at `l` **and** map time-to-first-paint misses its budget | An optional `metadataOnly` watch option, used by topology slots that only need identity and references |
| H4 | Unpaged non-watch lists spike memory and latency | The probe sees unpaged responses above 5 000 objects **and** RSS or latency misses its budget | Page `resource_list`, `cluster_overview` and metrics lists with `limit=500` + `continue`, with bounded totals |
| H5 | Heavy TS engines block the main thread | Long tasks > 50 ms attributable to health, netpol or map at `m` | Run those engines in a Vite module worker (`lib/perf/worker/`), passing the locale |
| H6 | No backpressure: queues grow, dead windows keep watching | Churn soak at `l` shows apply lag > 1 s or a watch outliving its window | Acknowledged watch batches: at most 4 unacked per watch, latest-wins coalescing of pending upserts, and the watch stops when unacked for 60 s |
| H7 | Per-frame snapshot copies and full re-sorts cost too much | Batch apply → commit p95 > 16 ms at `l` with churn 50/s | Incremental snapshots (items array reused when only updates arrive) and a sort merge of changed rows |
| H8 | Idle snapshots and journal baselines grow memory | Soak heap at 30 min > 1.15 × heap at 5 min | Evict `watchCache` entries idle (unsubscribed) for 5 minutes; cap journal baseline bytes |
| H9 | The journal hot path is slow | `journal/apply_update` or `journal/details_after_500` misses its budget | Keep the parsed baseline object (not only its string); convert to YAML outside the lock |
| H10 | Fleet search times out at scale | `fleet_search/e2e_l` > 6 s per cluster | Stop paging at the per-kind match limit sooner; raise concurrency per cluster; stream partial results before the timeout |
| MAP | The 400-node Resource Map cap (from hardening) | Map bench at 800 and 1 200 nodes within budget (build + view + layout ≤ 250 ms, frame ≤ 16 ms while panning) | Raise `DEFAULT_MAX_NODES` to the largest size within budget, else keep 400 and record why |

Pagination note: watch lists already page. H4 is about the non-watch lists above.

## Budgets (initial; ratified by the baseline)

Numbers are medians on the reference machine unless stated otherwise.

**Backend (Criterion)**

| Id | Budget |
|----|-------:|
| `watch/aggregator_initial_20k` (fold 20 000 init events, drain batches) | 120 ms |
| `watch/reset_batch_20k` | 60 ms |
| `watch/steady_500` (500 upserts + batch) | 3 ms |
| `metrics_history/record_5k_pods_1k_nodes` | 4 ms |
| `metrics_history/series_cluster` | 50 µs |
| `metrics_history/series_100_pods` | 1 ms |
| `alerts/tracker_initial_20k` | 150 ms |
| `alerts/tracker_pod_update` | 5 µs |
| `alerts/book_record` | 10 µs |
| `journal/prepare_configmap_4k` | 40 µs |
| `journal/apply_update` | 60 µs |
| `journal/details_after_500` | 50 ms |
| `history/writer_events_10k` (submit + flush) | 1.0 s, 0 dropped |
| `fleet_search/matcher_substring_50k` | 5 ms |
| `fleet_search/matcher_glob_50k` | 15 ms |
| `fleet_search/matcher_regex_50k` | 15 ms |
| `prometheus/parse_200x240` | 8 ms |
| `loki/parse_5000_lines_50_streams` | 10 ms |
| `e2e/watch_pods_synced_l` | 3.0 s |
| `e2e/fleet_search_l` | 6.0 s |
| `e2e/prometheus_query` | 50 ms |
| `e2e/max_rss_l_all_watchers` | 700 MB |

**Structural (exact)**

- Every list request that the watch, fleet-search and metrics paths make at `l` carries `limit=`.
- Watch streams per resource path follow the snapshot pinned in plan Task 2. H1 lowers the target to 1.

**Frontend engines (Vitest bench, Node 22)**

| Id | Budget |
|----|-------:|
| `topology/namespace_l` (build + view + layout, one namespace) | 30 ms |
| `topology/all_m` (all namespaces) | 1 500 ms |
| `topology/layout_800` | 250 ms |
| `health/scan_m` | 1 500 ms |
| `health/scan_l` | 3 000 ms |
| `netpol/build_l` | 800 ms |
| `netpol/matrix_namespace_l` | 300 ms |
| `logs/parse_json` | 4 µs/line |
| `logs/parse_logfmt` | 4 µs/line |
| `logs/parse_text` | 3 µs/line |
| `logs/detect_level` | 0.8 µs/line |
| `logs/record_index_50k` | 250 ms |
| `table/filter_sort_20k` | 60 ms |

**UI (Playwright + probe, Chromium, production build)**

| Id | Budget |
|----|-------:|
| `ui/ttfr_pods_s` | 400 ms |
| `ui/ttfr_pods_m` | 900 ms |
| `ui/ttfr_pods_l` | 1 500 ms |
| `ui/synced_pods_l` | 4 s |
| `ui/scroll_fps_l` | median ≥ 55, p95 frame ≤ 25 ms, no long task > 100 ms |
| `ui/apply_p95_l_churn50` | 16 ms |
| `ui/map_namespace_l` (open → first paint) | 500 ms |
| `ui/map_all_m` | 2.5 s |
| `ui/health_scan_m` | 3 s, no long task > 200 ms |
| `ui/map_leave` | 200 ms |
| `ui/soak_heap_ratio` (heap after GC at 30 min ÷ 5 min, `l`, churn 50/s, cycling pods table / map / health every 60 s) | ≤ 1.15 |
| `ui/soak_dom_nodes` | ± 10% |

## Architecture

```
perf/scale-presets.json ─┬─> crates/kubepit-core/tests/support/scale.rs ─> fake API server ─> tests + benches/e2e.rs
                         └─> apps/desktop/src/lib/ipc/mock/fixtures/scale.ts ─> demo backend (?scale=&churn=)
crates/kubepit-core/benches/*.rs ──> target/criterion/**/estimates.json ─┐
apps/desktop/src/**/*.bench.ts ────> perf-results/frontend-bench.json ────┼─> scripts/perf/compare.mjs ─> CI
scripts/perf/ui-perf.mjs (Playwright + lib/perf probe) ─> perf-results/ui.json ┘      (perf/budgets.json)
```

## UX

The harness adds no user-visible UI, so it adds no i18n strings. The probe is a developer API, and the scale cluster's name is demo data. An optimization task that adds UI (for example H6's "stopped: window closed" state) ships English and Turkish strings in the same change.

## Data and contract changes

The harness changes no contract. Gated tasks may:

- H3: add `options: { metadataOnly?: boolean }` to `resource_watch`;
- H6: add `resource_watch_ack(watchId, seq)` and `WatchBatch.seq`;
- H4: change `resource_list` paging.

Each such change touches `types/index.ts`, `lib/ipc.ts`, the Tauri command and the demo backend together.

## Safety

- Nothing contacts a real cluster. The Rust fixture is the in-process fake server on 127.0.0.1, and UI runs use the demo backend.
- `scripts/perf/ui-perf.mjs` refuses to run when `window.__TAURI_INTERNALS__` exists.
- Benchmarks use temp dirs for `Paths`, so `KUBEPIT_HOME` is never the user's.
- Optimizations keep `read_only` enforcement and the opt-in-per-process rule for background work. The informer hub starts watchers only for opted-in consumers and live UI watches.

## Testing strategy

- **Fixture correctness.** Counts, paging continuity, determinism, the metadata-only shape and selectors (Rust); generator counts and the batch contract (Vitest).
- **Structural probes** pin request fan-out and pagination.
- **Benchmarks and the UI driver** produce JSON. `compare.mjs` has its own `node --test` suite: a missing budgeted result fails, unknown ids warn, and slack applies only to timings.
- **Each gated optimization** carries unit tests of its new behaviour, plus the benchmark that fired its gate as the proof.

## Rollout

1. Harness and baseline (Tasks 1–10).
2. CI guard (Task 11, after the CI plan).
3. Gated optimizations (Tasks 12–22: H1–H10, then the map cap), in order of measured impact.
4. Update the Results table and the budgets (Task 23).

## Results

Filled in by plan Task 10 and each gated task.

| Id | Budget | Baseline | After | Gate fired? |
|----|-------:|---------:|------:|-------------|
| _(one row per budget id)_ | | | | |

## Open questions

1. Is the reference machine right (Apple M2 Pro or newer), or should budgets be set on the CI runner?
2. What are the CI plan's workflow file and job names? This spec assumes `.github/workflows/ci.yml`.
3. Should the 30-minute soak also run on macOS runners (WKWebView through `tauri dev` is not scriptable in CI), or stay Chromium-only?
4. Adding Playwright means a ~150 MB browser download in the nightly job only. Is that acceptable?
