# KubeFit-style Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port KubeFit's recommendation logic into Kubepit as an ownership-aware
`workload-history` strategy with flags and confidence. Scans are stored in `history.db`
and run in the background, and results appear in a dedicated Recommendations view,
workload details, Health and the dashboard.

**Architecture:**
- One strategy-independent collection pipeline, `rightsizing/collect.rs`:
  - 16 server-side instant PromQL queries per batch;
  - kube-state-metrics owner resolution;
  - evidence folding.

  It feeds every `RecommendationStrategy`. A shared evidence step adds flags and caps the
  confidence, and the existing `finalize` raises limits proportionally.
- Scans wrap that pipeline, persist through the history writer thread (migration 2),
  and are scheduled per connected, opted-in cluster.
- The UI reads stored scans, re-evaluated with the current settings, through new
  `recommendations_*` commands.

**Tech Stack:**
- Rust: kube 4, rusqlite, tokio, serde.
- React 18, Tailwind v4, Zustand; hand-drawn SVG charts (`TimeSeriesChart`,
  `MultiSeriesChart`, `Sparkline`, `charts.tsx`).
- Tauri 2 commands and events.

**Spec:** `docs/superpowers/specs/2026-09-28-kubefit-recommendations-design.md`

## Global Constraints

**Contract and design**
- IPC contract: `apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts`
  change in the same task as the serde structs.
  - Snake_case fields cross verbatim.
  - Command names are snake_case strings.
  - JS arguments are camelCase (`clusterId` → `cluster_id`).
- RunHQ design:
  - tokens from `src/styles/theme.css` and primitives from `src/components/ui/`;
  - 11–13 px UI text, uppercase tracked labels, `bg-fg/N` hover pads, the accent strip
    for active rows.
- No chart or UI libraries.
  - Charts are SVG through `TimeSeriesChart`, `MultiSeriesChart`, `Sparkline` and
    `components/workbench/overview/charts.tsx`.
  - Nothing from KubeFit's shadcn / recharts / sonner UI is ported.
  - lucide-react icons, already a dependency, are allowed.
- Layouts use container queries (`@container` with `@md:` / `@2xl:` / `@3xl:`
  variants). There are no viewport breakpoints.

**Internationalization**
- Every user-visible string ships in English and Turkish in the same task.
  - Use `import * as i18n from '@/i18n'` in components (with `i18n.useLocale()`), and
    `@/i18n/core` in pure helpers.
  - English source strings are the keys.
  - Use `i18n.t` / `i18n.rich` / `i18n.plural`. Never concatenate translated fragments.
- Run `pnpm i18n:check -- --fix`, then add the Turkish by hand.
- Turkish terms follow Kubepit's catalogs:
  - istek (request), sınır (limit), kısıtlama (throttling), güven (confidence);
  - öneri (recommendation), tarama (scan), kapsam (coverage), pay (headroom);
  - doğru boyutlandırma (right-sizing);
  - `container'ı` with a straight apostrophe.
  - KubeFit's Turkish copy may be reused where it fits these terms.
- Never translate Kubernetes data, kinds used as identifiers, YAML (including the export
  fragment's comments), PromQL, pod names or flag details.

**Safety and read-only**
- Never connect to real clusters or a real Prometheus from tests or scripts.
  - Use the fake API server in `crates/kubepit-core/tests/support`, fixtures, and
    temp-dir `Paths` / `KUBEPIT_HOME`.
  - `~/.kube` is never read.
- Mutating backend commands honour `ClusterDef.read_only` (`ensure_writable`).
  - Only `rightsizing_apply` mutates.
  - Dry runs and scans are allowed on read-only clusters.

**Background work**
- Background work is opt-in per process: `Kubepit::set_recommendation_scans`, enabled
  only in `src-tauri/src/setup.rs`.
- It is also opt-in per cluster: `Settings.recommendations.scan_clusters`.
- Scans never connect on their own (`pool.connected_client`).
- Tests start no scheduler unless the test is about scheduling.
- Scan writes are blocking control operations on the history writer; they are never
  dropped.
- Exports carry no connection metadata: no kubeconfig, server URL, Prometheus service,
  Secret reference, tenant or label selector.

**Values** (spec §7 is normative)

| Value | Default | Range |
|---|---|---|
| `days` | 7 | 1–30 |
| `min_hours` | 24 | 1–720, ≤ days × 24 |
| `min_coverage` | 0.9 | 0.1–1 |
| `workload-history` headroom | CPU 20 %, memory 20 % | |
| `percentile-headroom` headroom | CPU 15 %, memory 20 %, memory limit 40 % | |
| Minimum requests | 10 m / 32 MiB | |
| Throttling | 5 % of CFS periods, ≥ 600 periods | 1–50 % |
| High-confidence history | 72 h | |
| Scan interval | 60 min | 15–1440 |
| First scan after connect | 120 s + 0–60 s jitter | |
| Manual scan cooldown | 60 s | |
| Concurrent scans | 1 per cluster, 2 overall | |
| Collection: queries in flight / timeout / series cap / batch budget / scan timeout | 4 / 60 s / 50,000 / 32 / 20 min | |
| Retention | 30 days | 1–90 |
| Rows kept | all runs < 48 h, then the last successful run per UTC day, and the latest always | |
| Pod names stored per workload | 50 | |

**Dependencies:** no new crates, except phase 7's in-tree `hyper`, `hyper-util`,
`http-body-util`, `tokio-rustls` and `rustls`.

**Checks** (every task ends green):
- `pnpm typecheck`
- `pnpm i18n:check`
- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `pnpm dev:ui` keeps working: every command the UI calls has a demo handler.

## Review Focus

- **RBAC-limited clusters** (cluster-wide lists are forbidden, `accessible_namespaces`
  is set). A scan should cover the accessible namespaces instead of failing. Tested in
  Task 7 (`restricted_clusters_scan_their_accessible_namespaces`).
- **Templates that differ from history** (injected sidecars, containers renamed or added
  since the window). Only live template containers are recommended; others are skipped
  and never crash. Tested in Task 4
  (`template_containers_decide_what_is_recommended`).
- **Rows and runs written by an older build** (JSON without the new fields, `NULL`
  summary). They still read and re-evaluate. Tested in Task 11
  (`rows_from_older_builds_still_read`).
- **A cluster disconnected or removed mid-scan.** The run is marked interrupted, the
  latest pointer is untouched, removal leaves no rows behind, and nothing panics on the
  foreign key. Tested in Task 17 (`disconnect_or_removal_interrupts_a_running_scan`).
- **Oversized or odd Prometheus answers** (more than 50,000 series, NaN / ±Inf, negative
  counts). The batch splits, non-finite values are ignored and counts clamp at 0. Tested
  in Task 3 (`batches_merge_per_pod_and_container`) and Task 7
  (`failed_batches_split_down_to_namespaces`).

---

## File Structure

**Core** (`crates/kubepit-core/src/`)

| File | Responsibility |
|---|---|
| `rightsizing/types.rs` (modify) | Settings fields, `UsageEvidence`, `HpaInfo`, `RecommendationLens`, new report / workload fields |
| `rightsizing/ownership.rs` (new) | kube-state-metrics owner indexes; `resolve(ns, pod) -> Owner` |
| `prometheus/workload_stats.rs` (new) | Q1–Q16 builders, `StatsBatch` merge, batch fetch with `time=` |
| `rightsizing/evidence.rs` (new) | Fold per-pod stats into per-(workload, container) `UsageStats` + `UsageEvidence` |
| `rightsizing/strategy.rs` (modify) | `ContainerInput.evidence` / `hpa`, `apply_evidence`, `resolve` |
| `rightsizing/workload_history.rs` (new) | The `workload-history` strategy |
| `rightsizing/collect.rs` (new) | Pipeline: listing, batches, split, budget, fallbacks, progress; `compute_rightsizing` |
| `rightsizing/summary.rs` (new) | Lenses, `risk_score`, `one_click_eligible`, `summarize` |
| `rightsizing/export.rs` (new) | JSON and YAML exports |
| `rightsizing/mod.rs`, `patch.rs`, `math.rs`, `percentile.rs` (modify) | CronJob support, re-evaluation, verdict OOM rule, strategy info |
| `prometheus/usage_history.rs` (new) | Range queries for the usage charts |
| `prometheus/usage.rs` (modify) | Keep only pod-average presets; `prometheus_instant_at` |
| `recommendations.rs` + `recommendations/{types,scan,schedule}.rs` (new) | Settings type, scan runner, scheduler, read commands |
| `history/recommendations.rs` (new) | Migration 2 SQL, begin / finish, reads, prune, clear |
| `history/{db,writer,types}.rs`, `history.rs` (modify) | Migration list, writer operations, `HistoryKind::Recommendations`, status |
| `events.rs`, `app.rs`, `connection.rs`, `types.rs`, `lib.rs`, `alerts/model.rs` (modify) | Event, state, lifecycle hooks, `Settings.recommendations`, optional alert |

**Core tests** (`crates/kubepit-core/tests/`)
- `recommendations.rs` (new): engine and scan end-to-end tests against the fake API
  server.
- `cost.rs` and `support/mod.rs` (modify).

**Desktop shell** (`apps/desktop/src-tauri/src/`)
- `ipc/recommendations.rs` (new).
- `lib.rs`, `app_state.rs` and `setup.rs` (modify).

**UI** (`apps/desktop/src/`)

| File | Responsibility |
|---|---|
| `types/index.ts`, `lib/ipc.ts` (modify) | Contract |
| `store/useRecommendationsStore.ts` (new) | Latest scan, status, runs and events per cluster |
| `lib/kube/recommendations/model.ts` (new) | Pure view models: keys, lenses, sort, spotlight, ranking, capacity, totals, apply mode |
| `lib/kube/rightsizing/model.ts` (modify) | Warning texts, strategy label, `workloadGvk`, CronJob |
| `components/workbench/recommendations/*` (new) | The view |
| `components/workbench/cost/*` (modify) | Summary card instead of the panel; dialog acknowledgement; details section |
| `components/dashboard/RecommendationsFleetCard.tsx` (new) | Fleet card |
| `components/settings/HistoryCategory.tsx` (modify) | Recommendations block |
| `lib/kube/health/{rules,rightsizing}.ts`, `components/workbench/health/useHealthScan.ts` (modify) | Health |
| `lib/ipc/mock/recommendations.ts`, `lib/ipc/mock/fixtures/recommendations.ts` (new) | Demo backend |
| `i18n/{en,tr}/{workbench,shell}.json` (modify) | Catalogs |

**Optional phase 7**
- Core: `prometheus/{access,matchers,tunnel}.rs` (new).
- UI: `components/cluster-editor/PrometheusFields.tsx` (modify).

---

# Phase 1: Engine

### Task 1: Contract for settings, evidence and strategy info

**Files:**
- Modify:
  - `crates/kubepit-core/src/rightsizing/types.rs`
  - `crates/kubepit-core/src/rightsizing/math.rs:21-54` (`normalized`)
  - `crates/kubepit-core/src/rightsizing/strategy.rs:35-46,128-158`
  - `crates/kubepit-core/src/rightsizing/percentile.rs:46-52`
  - `crates/kubepit-core/src/rightsizing/mod.rs` (construct the new fields)
- Modify:
  - `apps/desktop/src/types/index.ts:2139-2260`
  - `apps/desktop/src/lib/kube/rightsizing/model.ts:27-34`
  - `apps/desktop/src/lib/ipc/mock/cost.ts` (strategies, new fields)
- Test: the `#[cfg(test)] mod tests` in `crates/kubepit-core/src/rightsizing/types.rs`

**Interfaces:**
- Produces, in Rust (TS mirrors with the same snake_case names):
  - `RightsizingSettings`:
    - gains `min_hours: f64` (24), `min_coverage: f64` (0.9) and
      `throttle_threshold_percent: f64` (5);
    - `normalized()` clamps them to 1–min(720, days × 24), 0.1–1 and 1–50.
  - `RightsizingRequest.settings: Option<RightsizingSettings>`.
  - `RightsizingStrategyInfo { id, name, defaults: RightsizingSettings, settings_keys:
    Vec<String> }`.
  - `UsageStats` gains `cpu_avg: Option<f64>` and `memory_avg: Option<f64>`
    (`#[serde(default)]`).
  - `UsageEvidence { observed_hours: f64, cpu_coverage: Option<f64>, memory_coverage:
    Option<f64>, cpu_samples: f64, memory_samples: f64, pods: u32, duty: Option<f64>,
    throttle_ratio: Option<f64>, oom_killed: bool, partial: bool, identity:
    EvidenceIdentity }`. It is `Default` + `Clone` + `PartialEq`.
  - `enum EvidenceIdentity { OwnerMetrics, NameMatch, Ambiguous }`, kebab-case,
    default `OwnerMetrics`.
  - `HpaInfo { name, min_replicas: Option<u32>, max_replicas: u32, metrics:
    Vec<HpaMetric> }`.
  - `HpaMetric { resource: HpaResource, target_utilization: Option<u32> }`, with
    `enum HpaResource { Cpu, Memory, Other }`.
  - `enum RecommendationLens { CpuReduction, MemoryReduction, Increase, RequestUnset,
    MissingData, NeedsReview, LimitRaised }`, kebab-case.
  - `ContainerInput` gains `evidence: Option<&'a UsageEvidence>` and
    `hpa: Option<&'a HpaInfo>`.
  - `ContainerRecommendation.evidence: Option<UsageEvidence>`; `finalize` copies
    `input.evidence`.
  - `WorkloadRecommendation` gains `pods: Vec<String>`, `pods_truncated: bool`,
    `hpa: Option<HpaInfo>`, `lenses: Vec<RecommendationLens>` and `cost_replicas: f64`,
    all `#[serde(default)]`.
  - `RightsizingReport` gains `strategy_auto: bool` and `window_end: i64`
    (`#[serde(default)]`).
  - `RightsizingNoteKind` gains `OwnershipUnavailable`, `PartialData`, `NamespaceFailed`,
    `QueryBudgetExceeded` and `HpaUnavailable`.
- `percentile-headroom`'s info:
  - `defaults = RightsizingSettings::default()`;
  - `settings_keys = ["cpu_headroom_percent", "memory_headroom_percent",
    "memory_limit_headroom_percent", "days"]`.
  - *Review decision:* every strategy also lists `min_hours`, `min_coverage` and `throttle_threshold_percent`, which the shared evidence step reads.
- `rightsizing_report` uses `request.settings` or else the resolved strategy's
  `info().defaults` (Task 10 replaces this with the effective settings).

Steps:

- [x] **Step 1: Write the failing test**

```rust
#[test]
fn contract_defaults_normalize_and_old_json_reads() {
    let s = RightsizingSettings::default();
    assert_eq!((s.min_hours, s.min_coverage, s.throttle_threshold_percent), (24.0, 0.9, 5.0));
    let n = RightsizingSettings { days: 2, min_hours: 999.0, min_coverage: 0.0,
        throttle_threshold_percent: 90.0, ..s.clone() }.normalized();
    assert_eq!((n.min_hours, n.min_coverage, n.throttle_threshold_percent), (48.0, 0.1, 50.0));
    let req: RightsizingRequest = serde_json::from_str(r#"{"namespaces":[]}"#).unwrap();
    assert!(req.settings.is_none());
    // OLD_WORKLOAD: a WorkloadRecommendation literal as serialized before this task
    // (no pods/pods_truncated/hpa/lenses/cost_replicas, no container evidence,
    // usage without cpu_avg/memory_avg).
    let old: WorkloadRecommendation = serde_json::from_str(OLD_WORKLOAD).unwrap();
    assert!(old.pods.is_empty() && old.lenses.is_empty() && old.hpa.is_none());
    assert!(old.containers[0].evidence.is_none());
    assert_eq!(old.containers[0].usage.unwrap().cpu_avg, None);
    assert_eq!(serde_json::to_value(EvidenceIdentity::NameMatch).unwrap(), json!("name-match"));
    assert_eq!(serde_json::to_value(RecommendationLens::LimitRaised).unwrap(), json!("limit-raised"));
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kubepit-core rightsizing::types`

Expected: compile errors (`min_hours`, `UsageEvidence` … not found).

- [x] **Step 3: Implement the types, clamps and field plumbing listed under Interfaces**

- Add `evidence: None, hpa: None` to every existing `ContainerInput` literal: the tests
  in `strategy.rs`, `percentile.rs`, `math.rs` and `mod.rs`.
- Mirror everything in `types/index.ts` and add the new fields to `DEFAULT_RIGHTSIZING`.
- In the demo `cost.ts`:
  - `STRATEGIES` entries get `defaults` and `settings_keys`;
  - the demo workloads get `pods: []`, `pods_truncated: false`, `hpa: null`, `lenses: []`
    and `cost_replicas: replicas`;
  - containers get `evidence: null`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core rightsizing && pnpm typecheck`

Expected: PASS. Every existing right-sizing test is still green.

- [x] **Step 5: Verify the demo**

Run: `pnpm dev:ui`, open a cloud cluster → Cost → Right-sizing.

Expected: the list renders as before, with no console errors.

- [x] **Step 6: Commit**

```bash
git add crates/kubepit-core/src/rightsizing apps/desktop/src/types/index.ts apps/desktop/src/lib/kube/rightsizing/model.ts apps/desktop/src/lib/ipc/mock/cost.ts
git commit -m "feat(rightsizing): evidence, lens and settings contract"
```

### Task 2: Ownership resolution

**Files:**
- Create: `crates/kubepit-core/src/rightsizing/ownership.rs`
- Modify: `crates/kubepit-core/src/rightsizing/mod.rs:22-26` (`pub mod ownership;`)
- Test: the tests module of `ownership.rs`

**Interfaces:**
- Consumes: `crate::prometheus::parse::PromData`.
- Produces:
  - `pub enum Owner { Workload { kind: String, name: String }, Unowned,
    Unsupported(String), Ambiguous(Vec<(String, String)>) }`.
  - `#[derive(Default)] pub struct OwnerIndex`, with:
    - `from_data(pods: &PromData, replicasets: &PromData, jobs: &PromData) -> Self`;
    - `merge(&mut self, other: OwnerIndex)`;
    - `is_empty(&self) -> bool` (no pod owner at all);
    - `resolve(&self, namespace: &str, pod: &str) -> Owner`.
  - `pub fn is_none_owner(kind: &str, name: &str) -> bool` (empty or `<none>`).
- The algorithm is spec §6.4, verbatim:
  - a `<none>` owner, an empty owner or `owner_is_controller="false"` is dropped;
  - one hop RS → Deployment and Job → CronJob;
  - `Rollout` or another parent kind is `Unsupported`.

Steps:

- [x] **Step 1: Write the failing tests**

```rust
#[test] fn none_and_non_controller_owners_are_ignored() {
    // kube_pod_owner{pod="bare",owner_kind="<none>",owner_name="<none>"} and
    // {pod="x",owner_kind="ReplicaSet",owner_name="x-rs",owner_is_controller="false"}
    assert_eq!(index.resolve("apps", "bare"), Owner::Unowned);
    assert_eq!(index.resolve("apps", "x"), Owner::Unowned);
}
#[test] fn replicasets_and_jobs_resolve_one_hop() {
    assert_eq!(index.resolve("apps", "api-old"), Owner::Workload { kind: "Deployment".into(), name: "api".into() });
    assert_eq!(index.resolve("apps", "nightly-28765432-abcde"), Owner::Workload { kind: "CronJob".into(), name: "nightly".into() });
    assert_eq!(index.resolve("apps", "db-0"), Owner::Workload { kind: "StatefulSet".into(), name: "db".into() });
}
#[test] fn orphans_standalone_jobs_and_bare_pods_are_unowned() { /* RS without parent, Job without parent */ }
#[test] fn two_owners_for_one_pod_name_are_ambiguous() {
    assert!(matches!(index.resolve("apps", "web-0"), Owner::Ambiguous(c) if c.len() == 2));
}
#[test] fn unsupported_parents_are_reported() {
    assert_eq!(index.resolve("apps", "canary-abc-12345"), Owner::Unsupported("Rollout".into()));
    assert_eq!(index.resolve("kube-system", "etcd-node1"), Owner::Unsupported("Node".into()));
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core rightsizing::ownership`

Expected: FAIL to compile (`OwnerIndex` not defined).

- [x] **Step 3: Implement `ownership.rs` per the Interfaces block**

Index keys are `(namespace, subject)`, where the subject is the `pod`, `replicaset` or
`job_name` label. The values are `BTreeSet<(kind, name)>`, so `Ambiguous` lists its
candidates in sorted order.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core rightsizing::ownership`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/rightsizing/ownership.rs crates/kubepit-core/src/rightsizing/mod.rs
git commit -m "feat(rightsizing): resolve pods to workloads through kube-state-metrics"
```

### Task 3: Workload statistics queries

**Files:**
- Create: `crates/kubepit-core/src/prometheus/workload_stats.rs`
- Modify:
  - `crates/kubepit-core/src/prometheus/mod.rs:19-24` (`pub mod workload_stats;`)
  - `crates/kubepit-core/src/prometheus/usage.rs:168-180`:
    - add `prometheus_instant_at(&self, cluster_id: &str, query: &str, time:
      Option<i64>) -> Result<PromData>`, which sends `time` when set;
    - `prometheus_instant` calls it with `None`.
- Test: the tests module of `workload_stats.rs`

**Interfaces:**
- Consumes: `OwnerIndex::from_data` (Task 2); `quote`, `regex_escape`,
  `MAX_NAMESPACE_MATCHERS`, `USAGE_TIMEOUT`.
- Produces:
  - `pub enum StatQuery { CpuP95, CpuMax, CpuAvg, CpuSamples, MemoryMax, MemoryAvg,
    MemorySamples, Running, FirstSeen, LastSeen, PodOwners, ReplicasetOwners, JobOwners,
    Oom, Throttled, Periods }`, with:
    - `ALL: [StatQuery; 16]`;
    - `name(self) -> &'static str` (the snake_case names of spec §6.2);
    - `is_required(self)`, true for `CpuP95` and `MemoryMax`.
  - `pub struct StatScope { pub namespaces: Vec<String>, pub pod_regex: Option<String>,
    pub days: u32, pub end_secs: i64 }`. Empty `namespaces` = the whole cluster.
  - `pub fn window_end(now_ms: i64) -> i64`, which gives `floor(now_s / 300) × 300`.
  - `pub fn query(q: StatQuery, scope: &StatScope) -> String`: the PromQL of spec §6.2
    with the `NS` / `POD` / `SEL` / `KSM` matchers. `NS` is omitted when `namespaces` is
    empty or longer than 40.
  - `pub struct PodContainerStats { cpu_p95: Option<f64>, cpu_max: Option<f64>, cpu_avg:
    Option<f64>, cpu_samples: f64, memory_max: Option<f64>, memory_avg: Option<f64>,
    memory_samples: f64, running: f64, oom: bool, throttled: f64, periods: f64 }`.
  - `pub struct PodSpan { pub first_secs: i64, pub last_secs: i64 }`.
  - `pub struct StatsBatch { pub containers: HashMap<(String, String, String),
    PodContainerStats>, pub spans: HashMap<(String, String), PodSpan>, pub owners:
    OwnerIndex, pub warnings: Vec<String>, pub failed: Vec<StatQuery> }`.
  - `pub const MAX_SCAN_SERIES: usize = 50_000`.
  - `pub enum BatchFailure { Proxy(String), Splittable { query: &'static str, message:
    String } }`, deriving `thiserror::Error`.
  - `pub fn merge(answers: Vec<(StatQuery, anyhow::Result<PromData>)>) ->
    Result<StatsBatch, BatchFailure>`.
  - `impl Kubepit { pub(crate) async fn prometheus_stats_batch(&self, cluster_id: &str,
    scope: &StatScope, on_answer: &(dyn Fn() + Send + Sync)) -> Result<StatsBatch,
    BatchFailure> }`. It runs 4 queries in flight
    (`futures::stream::iter(..).buffer_unordered(4)`), calls `on_answer` once per answer,
    and maps proxy failures (`is_proxy_failure`, which also invalidates the cache) to
    `Proxy`.

Steps:

- [x] **Step 1: Write the failing tests**

```rust
#[test] fn stat_queries_follow_the_spec() {
    let scope = StatScope { namespaces: vec!["shop".into(), "a.b".into()], pod_regex: None, days: 7, end_secs: 1_700_000_100 };
    assert_eq!(query(StatQuery::CpuP95, &scope),
        r#"quantile_over_time(0.95, (max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace=~"a\\.b|shop"}[5m])))[7d:5m]) * 1000"#);
    assert_eq!(query(StatQuery::Running, &scope),
        r#"count_over_time((max by (namespace, pod, container) (kube_pod_container_status_running{namespace=~"a\\.b|shop"} == 1))[7d:5m])"#);
    assert_eq!(query(StatQuery::PodOwners, &scope),
        r#"max by (namespace, pod, owner_kind, owner_name) (max_over_time(kube_pod_owner{namespace=~"a\\.b|shop",owner_is_controller!="false"}[7d]))"#);
    let one = StatScope { pod_regex: Some("web-[a-z0-9]+-[a-z0-9]+".into()), namespaces: vec!["shop".into()], ..scope.clone() };
    assert!(query(StatQuery::CpuMax, &one).contains(r#"pod=~"web-[a-z0-9]+-[a-z0-9]+""#));
    assert!(!query(StatQuery::ReplicasetOwners, &one).contains("pod=~"));
    let all = StatScope { namespaces: vec![], ..scope };
    assert!(StatQuery::ALL.iter().all(|q| !query(*q, &all).contains("namespace=~")));
    assert!(query(StatQuery::FirstSeen, &all).starts_with("min_over_time(timestamp(max by (namespace, pod)"));
}
#[test] fn window_end_aligns_to_five_minutes() { assert_eq!(window_end(1_700_000_123_456), 1_700_000_100); }
#[test] fn batches_merge_per_pod_and_container() {
    // Series without namespace/pod/container are ignored, a repeated key keeps the max,
    // negative counts clamp to 0 (NaN/±Inf never reach here: parse drops them).
    assert_eq!(batch.containers[&key("shop", "web-1", "app")].cpu_p95, Some(120.0));
    assert_eq!(batch.containers[&key("shop", "web-1", "app")].running, 0.0);
    assert_eq!(batch.spans[&("shop".into(), "web-1".into())], PodSpan { first_secs: 1000, last_secs: 9000 });
    assert_eq!(batch.failed, vec![StatQuery::Oom]);        // optional failure recorded
    assert_eq!(batch.warnings, vec!["partial".to_string()]);
    assert!(matches!(merge(vec![(StatQuery::CpuP95, Err(anyhow!("timeout")))]), Err(BatchFailure::Splittable { .. })));
    assert!(matches!(merge(vec![(StatQuery::MemoryMax, Ok(data_with(MAX_SCAN_SERIES + 1)))]), Err(BatchFailure::Splittable { .. })));
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core prometheus::workload_stats`

Expected: FAIL to compile.

- [x] **Step 3: Implement the builders, `merge` and `prometheus_stats_batch`**

Ownership comes from `OwnerIndex::from_data`, with the answers of Q11–Q13 (an empty
`PromData` for failed ones).

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core prometheus`

Expected: PASS, and the existing Prometheus tests are still green.

- [x] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/prometheus
git commit -m "feat(prometheus): server-side workload statistics queries"
```

### Task 4: Evidence folding

**Files:**
- Create: `crates/kubepit-core/src/rightsizing/evidence.rs`
- Modify: `crates/kubepit-core/src/rightsizing/mod.rs:139-186,440-537`
  - `WorkloadUsage` moves to `evidence.rs`.
  - `usage_from_prometheus` and `metrics_server_usage` produce `ContainerUsage {
    evidence: None }`.
  - `recommend_workload` reads `ContainerUsage`.
- Test: the tests module of `evidence.rs`

**Interfaces:**
- Consumes: `StatsBatch`, `PodSpan` (Task 3); `Owner`, `OwnerIndex` (Task 2);
  `PodMatcher`, `Workload` (`mod.rs`).
- Produces:
  - `pub struct ContainerUsage { pub stats: UsageStats, pub evidence:
    Option<UsageEvidence> }`.
  - `pub type WorkloadUsage = HashMap<(usize, String), ContainerUsage>`.
  - `#[derive(Default)] pub struct WorkloadExtras { pub pods: Vec<String>, pub
    pods_truncated: bool, pub hpa: Option<HpaInfo> }`.
  - `pub struct HpaTarget { pub namespace: String, pub kind: String, pub name: String,
    pub info: HpaInfo }`.
  - `pub struct FoldInput<'a> { pub workloads: &'a [Workload], pub batch: &'a
    StatsBatch, pub hpas: &'a [HpaTarget], pub start_secs: i64, pub end_secs: i64, pub
    days: u32, pub partial_namespaces: &'a HashSet<String> }`.
  - `#[derive(Default, Debug, PartialEq)] pub struct FoldReport { pub unowned_pods: u32,
    pub unsupported_pods: u32, pub ambiguous_pods: u32, pub name_matched: bool }`.
  - `pub struct Folded { pub usage: WorkloadUsage, pub extras: Vec<WorkloadExtras>, pub
    report: FoldReport }`.
  - `pub fn fold(input: &FoldInput<'_>) -> Folded`.
  - `pub fn union_hours(spans: &[PodSpan], start_secs: i64, end_secs: i64) -> f64`, where
    each span is `[first, last + 300]`.
  - `pub const MAX_POD_NAMES: usize = 50`.
  - `pub const MIN_THROTTLE_PERIODS: f64 = 600.0`.
- The formulas are spec §6.5, verbatim.
  - When `batch.owners.is_empty()`, pods fold through `PodMatcher` with identity
    `NameMatch`, and `report.name_matched = true`.
  - Without spans: `hours = Σ memory_samples · 300 / 3600 / max(replicas, 1)`, capped at
    `days · 24`.

Steps:

- [x] **Step 1: Write the failing tests**

```rust
#[test] fn rollout_pods_fold_into_one_deployment() {
    // KubeFit fixture, 1 day: api-old (first half) and api-new (second half), each
    // 144 cpu/memory samples, 144 running, p95 100 m, memory max 100 MiB.
    let f = fold(&input);
    let u = &f.usage[&(0, "api".into())];
    assert_eq!((u.stats.cpu_p95, u.stats.memory_max), (100.0, 100.0 * MIB));
    let e = u.evidence.as_ref().unwrap();
    assert_eq!((e.cpu_samples, e.cpu_coverage, e.observed_hours), (288.0, Some(1.0), 24.0));
    assert_eq!(e.identity, EvidenceIdentity::OwnerMetrics);
    assert_eq!(f.extras[0].pods, vec!["api-new", "api-old"]);
}
#[test] fn statefulset_pods_recreated_under_the_same_name_stay_one_row() { /* db-0 twice → one row, identity OwnerMetrics */ }
#[test] fn ambiguous_pod_names_flag_candidates_and_contribute_nothing() {
    assert_eq!(f.usage[&(0, "app".into())].evidence.as_ref().unwrap().identity, EvidenceIdentity::Ambiguous);
    assert_eq!(f.report.ambiguous_pods, 1);
}
#[test] fn template_containers_decide_what_is_recommended() {
    // stats for "istio-proxy" (not in the template) are skipped; template container
    // "worker" without stats has no usage entry.
    assert!(!f.usage.contains_key(&(0, "istio-proxy".into())));
    assert!(!f.usage.contains_key(&(0, "worker".into())));
}
#[test] fn union_hours_merges_overlapping_spans() {
    let spans = [PodSpan { first_secs: 0, last_secs: 3600 }, PodSpan { first_secs: 1800, last_secs: 7200 }, PodSpan { first_secs: 10_000, last_secs: 10_300 }];
    assert_eq!(union_hours(&spans, 0, 86_400), 2.25);
}
#[test] fn throttle_ratio_needs_enough_periods_and_duty_averages_running_pods() {
    assert_eq!(e.throttle_ratio, Some(0.05));  // 50 / 1000
    assert_eq!(few.throttle_ratio, None);      // 500 periods
    assert_eq!(e.duty, Some(1.0));             // 288 running × 300 / 86 400
}
#[test] fn name_matching_is_the_fallback_without_owner_metrics() { assert!(f.report.name_matched); /* identity NameMatch */ }
#[test] fn hpa_attaches_by_scale_target() { assert_eq!(f.extras[0].hpa.as_ref().unwrap().name, "api"); }
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core rightsizing::evidence`

Expected: FAIL to compile.

- [x] **Step 3: Implement `fold` and `union_hours`, and update the `mod.rs` call sites**

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core rightsizing`

Expected: PASS, with the existing `mod.rs` tests adapted to `ContainerUsage`.

- [x] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/rightsizing
git commit -m "feat(rightsizing): fold per-pod statistics into workload evidence"
```

### Task 5: Shared evidence step and the OOM verdict rule

**Files:**
- Modify:
  - `crates/kubepit-core/src/rightsizing/strategy.rs:28-33,160-166`
  - `crates/kubepit-core/src/rightsizing/math.rs:177-203`
- Test: the tests modules of `strategy.rs` and `math.rs`

**Interfaces:**
- Consumes: `ContainerInput.evidence` / `hpa` (Task 1).
- Produces:
  - Warning constants `WARN_IDENTITY_UNCLEAR` … `WARN_IDENTITY_BY_NAME`, with the codes of
    spec §6.7.
  - `pub fn apply_evidence(input: &ContainerInput<'_>, output: StrategyOutput) ->
    StrategyOutput`. It adds warnings and caps the confidence; values are untouched.
    - `hpa-utilization` applies when the HPA has a Utilization target on a resource whose
      recommended request differs from the current one.
    - Detail formats:
      - `insufficient-history`: whole hours;
      - `low-coverage`: whole %;
      - `cpu-throttled`: % with one decimal;
      - `hpa-target`: the HPA name;
      - `hpa-utilization`: `"cpu 70%"`.
  - `recommend(strategy, input)` becomes
    `finalize(input, apply_evidence(input, strategy.recommend(input)))`.
  - `math::verdict`: any container with the `oom-killed` warning makes the workload
    `Verdict::Under`.

Steps:

- [x] **Step 1: Write the failing tests**

```rust
#[test] fn evidence_caps_confidence_and_adds_flags() {
    let cases: &[(fn(&mut UsageEvidence, &mut Option<HpaInfo>), &str, Confidence)] = &[
        (|e, _| e.identity = EvidenceIdentity::Ambiguous, WARN_IDENTITY_UNCLEAR, Confidence::Low),
        (|e, _| e.observed_hours = 10.0, WARN_INSUFFICIENT_HISTORY, Confidence::Low),
        (|e, _| e.cpu_coverage = Some(0.5), WARN_LOW_COVERAGE, Confidence::Low),
        (|e, _| e.partial = true, WARN_PARTIAL_DATA, Confidence::Medium),
        (|_, h| *h = Some(hpa("api", None)), WARN_HPA_TARGET, Confidence::Medium),
        (|_, h| *h = Some(hpa("api", Some(70))), WARN_HPA_UTILIZATION, Confidence::Medium),
        (|e, _| e.oom_killed = true, WARN_OOM_KILLED, Confidence::Medium),
        (|e, _| e.throttle_ratio = Some(0.08), WARN_CPU_THROTTLED, Confidence::Medium),
        (|e, _| e.identity = EvidenceIdentity::NameMatch, WARN_IDENTITY_BY_NAME, Confidence::Medium),
    ];
    for (modify, code, cap) in cases {
        let rec = run_with(modify);                     // Fixed strategy returns High
        assert!(codes(&rec).contains(code), "{code}");
        assert_eq!(rec.confidence, *cap, "{code}");
    }
}
#[test] fn evidence_never_changes_values() { assert_eq!(flagged.recommended, clean.recommended); }
#[test] fn oom_makes_the_verdict_under() { assert_eq!(verdict(&[oom_container], 10.0, 5.0), Verdict::Under); }
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core -- rightsizing::strategy rightsizing::math`

Expected: FAIL (`apply_evidence` not found).

- [x] **Step 3: Implement `apply_evidence`, wire it into `recommend`, and add the verdict rule**

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core rightsizing`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/rightsizing
git commit -m "feat(rightsizing): flags and confidence caps from usage evidence"
```

### Task 6: The `workload-history` strategy and automatic resolution

**Files:**
- Create: `crates/kubepit-core/src/rightsizing/workload_history.rs`
- Modify: `crates/kubepit-core/src/rightsizing/strategy.rs:64-81`
  - `STRATEGIES = &[&PercentileHeadroom, &WorkloadHistory]`;
  - add `resolve`.
- Test: the tests modules of `workload_history.rs` and `strategy.rs`

**Interfaces:**
- Consumes: `settle`, `MIN_CPU_CHANGE`, `MIN_MEMORY_CHANGE`, `MIB`; `apply_evidence` runs
  after this strategy (Task 5).
- Produces:
  - `pub const WORKLOAD_HISTORY_ID: &str = "workload-history"`.
  - `pub struct WorkloadHistory`, with `info()`:
    - `name` "Workload history";
    - `defaults = WorkloadHistory::defaults()` (CPU and memory headroom 20, the rest as
      `RightsizingSettings::default()`);
    - `settings_keys = ["cpu_headroom_percent", "memory_headroom_percent", "days",
      "min_hours", "min_coverage", "throttle_threshold_percent"]`.
  - `pub fn resolve(requested: Option<&str>, owner_metrics: bool) -> Result<(&'static dyn
    RecommendationStrategy, bool)>`, where the bool means "automatic". A blank or `None`
    request gives `workload-history` when `owner_metrics`, else `percentile-headroom`.
  - `DEFAULT_STRATEGY_ID` stays `percentile-headroom`, so the registry test is unchanged.
- The formulas are spec §6.6, verbatim:
  - round up to whole millicores and whole MiB;
  - OOM floor `max(memory_max, current memory limit)`;
  - `settle` for no churn;
  - a container without a memory limit gets one: `max(memory, ceil(mem_base × (1 + memory_limit_headroom/100)))` in whole MiB,
    flagged `memory-limit-added` (spec decision 10); existing limits are left to `finalize`;
  - confidence tiers: metrics-server low; ≥ 72 h high; else medium with `short-history`.

Steps:

- [x] **Step 1: Write the failing tests**

Test helpers: `current(cpu, mem)` sets both requests and a memory limit of `mem`;
`requests_only(cpu, mem)` sets the two requests and no limits.

```rust
#[test] fn kubefit_fixture_numbers() {
    let r = run(current(1000.0, 256.0 * MIB), usage(100.0, 100.0 * MIB, 168.0));
    assert_eq!((r.recommended.cpu_request, r.recommended.memory_request), (Some(120.0), Some(120.0 * MIB)));
    assert_eq!(r.cpu, Change::Decrease);
    assert_eq!(r.recommended.memory_limit, Some(256.0 * MIB), "limits never lowered");
}
#[test] fn minimums_and_whole_units() {
    assert_eq!(run(current(500.0, GIB), usage(1.0, MIB, 168.0)).recommended.cpu_request, Some(10.0));
    assert_eq!(run(current(1000.0, GIB), usage(101.3, 100.0 * MIB + 1.0, 168.0)).recommended.cpu_request, Some(122.0));
    assert_eq!(run(current(1000.0, GIB), usage(101.3, 100.0 * MIB + 1.0, 168.0)).recommended.memory_request, Some(121.0 * MIB));
}
#[test] fn containers_without_a_memory_limit_get_one() {
    let r = run(requests_only(1000.0, 256.0 * MIB), usage(100.0, 100.0 * MIB, 168.0));
    assert_eq!(r.memory_limit, Change::Set);
    assert_eq!(r.recommended.memory_limit, Some(140.0 * MIB)); // 100 MiB × 1.4
    assert!(codes(&r).contains(&"memory-limit-added"));
    assert_eq!(r.cpu_limit, Change::Unchanged, "CPU limits are never invented");
}
#[test] fn oom_floor_uses_the_current_limit() {
    let r = run_oom(limits(256.0 * MIB), usage(100.0, 200.0 * MIB, 168.0));
    assert_eq!(r.recommended.memory_request, Some(308.0 * MIB));   // 256 MiB × 1.2 → 307.2 → 308
    assert!(r.memory_limit_raised);
}
#[test] fn confidence_tiers_and_no_churn() {
    assert_eq!(run(current(1000.0, GIB), usage(100.0, 200.0 * MIB, 168.0)).confidence, Confidence::High);
    let short = run(current(1000.0, GIB), usage(100.0, 200.0 * MIB, 48.0));
    assert_eq!(short.confidence, Confidence::Medium);
    assert!(codes(&short).contains(&"short-history"));
    assert_eq!(run(current(125.0, GIB), usage(100.0, 200.0 * MIB, 168.0)).cpu, Change::Unchanged);
}
#[test] fn resolution_prefers_workload_history_with_owner_metrics() {
    assert_eq!(resolve(None, true).map(|(s, a)| (s.info().id, a)).unwrap(), (WORKLOAD_HISTORY_ID.into(), true));
    assert_eq!(resolve(None, false).map(|(s, a)| (s.info().id, a)).unwrap(), (DEFAULT_STRATEGY_ID.into(), true));
    assert_eq!(resolve(Some("percentile-headroom"), true).unwrap().1, false);
    assert!(resolve(Some("nope"), true).is_err());
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core -- rightsizing::workload_history rightsizing::strategy`

Expected: FAIL to compile.

- [x] **Step 3: Implement the strategy and `resolve`**

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core rightsizing`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/rightsizing
git commit -m "feat(rightsizing): workload-history strategy (KubeFit logic)"
```

### Task 7: The collection pipeline behind `rightsizing_report`

**Files:**
- Create: `crates/kubepit-core/src/rightsizing/collect.rs`
- Modify:
  - `crates/kubepit-core/src/rightsizing/mod.rs:211-262,327-443`:
    - `recommend_workload` takes `&WorkloadExtras` and sets `pods`, `pods_truncated`,
      `hpa` and `cost_replicas` (`replicas`, or for CronJobs the maximum `duty`, 1.0
      without evidence);
    - `rightsizing_report` delegates to `compute_rightsizing(.., &|_| {})`.
  - `crates/kubepit-core/src/prometheus/usage.rs`: delete `container_cpu_p95`,
    `container_cpu_max`, `container_memory_max`, `container_hours`,
    `merge_container_stats`, `ContainerStats`, `ContainerStatsMap` and
    `prometheus_container_stats`, with their tests. The pod-average presets stay.
  - `crates/kubepit-core/tests/cost.rs:387-495`: the router answers the Q1–Q16 markers.
- Create: `crates/kubepit-core/tests/recommendations.rs`
- Test: `crates/kubepit-core/tests/recommendations.rs` and `crates/kubepit-core/tests/cost.rs`

**Interfaces:**
- Consumes:
  - `StatScope`, `query`, `prometheus_stats_batch`, `window_end`, `BatchFailure`
    (Task 3);
  - `fold`, `FoldInput`, `HpaTarget` (Task 4);
  - `resolve` (Task 6);
  - `lists::namespaced`.
- Produces:
  - `#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug, PartialEq)] pub struct
    ScanProgress { pub completed: u32, pub total: u32, pub workloads: u32 }`.
  - `pub const MAX_BATCHES: usize = 32`.
  - `pub fn split(namespaces: &[String]) -> (Vec<String>, Vec<String>)`, which halves
    the sorted list.
  - `impl Kubepit { pub async fn compute_rightsizing(&self, cluster_id: &str, request:
    &RightsizingRequest, progress: &(dyn Fn(ScanProgress) + Send + Sync)) ->
    Result<RightsizingReport> }`.
- Pipeline:
  1. List the workloads (existing `workloads_in_scope`, which falls back to
     `accessible_namespaces`) and the `autoscaling/v2` HPAs. A forbidden HPA list adds
     the `HpaUnavailable` note.
  2. Plan one batch (the namespaces of the workloads). Split failed batches down to single
     namespaces within `MAX_BATCHES`. Collect the notes `NamespaceFailed` (detail: the
     namespaces joined with `, `), `QueryBudgetExceeded`, `PartialData` (detail: the
     failed query names) and `OwnershipUnavailable`. When **no** batch succeeded, return
     `Err` with the first splittable message (the scan then fails and keeps the last
     good result).
  3. Fold, resolve the strategy (owner metrics = `!batch.owners.is_empty()`), recommend,
     and sort.
  4. `window_end` goes into `window_end` (ms).
  5. The metrics-server and none fallbacks stay as they are today.
  6. `progress` fires after each answer, with `total = 16 × planned batches`.
  7. A single-workload request adds `pod_regex = workload_pod_regex(kind, name)`.

Steps:

- [ ] **Step 1: Write the failing end-to-end tests**

The router `kubefit_router(fixture)` routes `/api/v1/query` by these markers, in this
order:

| Marker | Query |
|---|---|
| `quantile_over_time(0.95` | Q1 |
| `max_over_time((max by (namespace, pod, container) (rate(container_cpu` | Q2 |
| `avg_over_time((max by (namespace, pod, container) (rate(` | Q3 |
| `count_over_time((max by (namespace, pod, container) (rate(` | Q4 |
| `max_over_time(container_memory_working_set_bytes` | Q5 |
| `avg_over_time(container_memory_working_set_bytes` | Q6 |
| `count_over_time((max by (namespace, pod, container) (container_memory` | Q7 |
| `count_over_time((max by (namespace, pod, container) (kube_pod_container_status_running` | Q8 |
| `min_over_time(timestamp(` | Q9 |
| `max_over_time(timestamp(` | Q10 |
| `kube_pod_owner` | Q11 |
| `kube_replicaset_owner` | Q12 |
| `kube_job_owner` | Q13 |
| `last_terminated_reason` | Q14 |
| `cfs_throttled_periods` | Q15 |
| `cfs_periods_total` | Q16 |

The fixture duplicates every series with `instance="duplicate"`.

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kubefit_rollout_fixture_becomes_one_deployment_row() {
    let report = app.compute_rightsizing(&id, &one_day(), &record_progress).await.unwrap();
    assert_eq!((report.strategy.as_str(), report.strategy_auto), ("workload-history", true));
    let api = &report.workloads[0];
    assert_eq!((api.kind.as_str(), api.name.as_str(), report.workloads.len()), ("Deployment", "api", 1));
    let c = &api.containers[0];
    assert_eq!((c.recommended.cpu_request, c.recommended.memory_request), (Some(120.0), Some(120.0 * MIB)));
    assert_eq!(c.evidence.as_ref().unwrap().cpu_coverage, Some(1.0));
    assert_eq!(api.pods, vec!["api-new", "api-old"]);
    assert!(progress_is_monotonic_and_complete(&progress));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flags_lower_confidence_but_never_block() {
    for (fixture, code, cap) in [
        (Fixture { partial: true, ..base() }, "partial-data", Confidence::Medium),
        (Fixture { gaps: true, ..base() }, "low-coverage", Confidence::Low),
        (Fixture { hpa: true, ..base() }, "hpa-target", Confidence::Medium),
        (Fixture { oom: true, ..base() }, "oom-killed", Confidence::Medium),
        (Fixture { throttled_percent: 10.0, ..base() }, "cpu-throttled", Confidence::Medium),
        // ambiguous: the name api-old is also owned by StatefulSet api-old-set; api-new is clean.
        (Fixture { ambiguous: true, ..base() }, "identity-unclear", Confidence::Low),
    ] {
        let c = &scan(fixture).await.workloads[0].containers[0];
        assert!(c.usage.is_some() && c.recommended.cpu_request != c.current.cpu_request, "{code}: computed, never blocked");
        assert!(c.warnings.iter().any(|w| w.code == code) && c.confidence <= cap, "{code}");
    }
    assert!(scan(Fixture { none_owners: true, ..base() }).await.workloads.iter().all(|w| w.name != "<none>"));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_above_the_limit_raises_it_proportionally() {
    // cpu 2 cores p95, current request 1 core, limit 1 core → 2400 m / 2400 m
    assert_eq!((c.recommended.cpu_request, c.recommended.cpu_limit, c.cpu_limit_raised), (Some(2400.0), Some(2400.0), true));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_kube_state_metrics_pods_match_by_name() {
    assert_eq!((report.strategy.as_str(), report.strategy_auto), ("percentile-headroom", true));
    assert!(report.notes.iter().any(|n| n.kind == RightsizingNoteKind::OwnershipUnavailable));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_batches_split_down_to_namespaces() {
    // Q1 fails whenever the selector names "b" (alone or together) or the answer would
    // exceed MAX_SCAN_SERIES; "a" answers → rows for a, NamespaceFailed note "b".
    assert!(report.notes.iter().any(|n| n.kind == RightsizingNoteKind::NamespaceFailed && n.detail.as_deref() == Some("b")));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_clusters_scan_their_accessible_namespaces() {
    // 403 on cluster-wide lists; setup's accessible namespaces team-a, team-b each hold a Deployment.
    assert!(queries(&log).iter().all(|q| q.contains(r#"namespace=~"team-a|team-b""#)));
    assert_eq!(report.workloads.len(), 2);
}
```

Also update `tests/cost.rs::right_sizing_recommends_from_prometheus_history` to answer the
new markers:
- Q1 = 120, Q2 = 300, Q5 = 314572800, Q7 = 2016;
- the owner and running queries are empty.

It then asserts:
- `report.strategy == "percentile-headroom" && report.strategy_auto`;
- `usage.hours == 84.0` (2016 × 300 s ÷ 2 replicas).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test recommendations --test cost`

Expected: FAIL (`compute_rightsizing` not found).

- [ ] **Step 3: Implement `collect.rs` and the `mod.rs` / `usage.rs` changes listed under Interfaces**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core`

Expected: PASS, the whole crate.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core
git commit -m "feat(rightsizing): ownership-aware collection pipeline with automatic strategy"
```

### Task 8: CronJob recommendations and apply

**Files:**
- Modify:
  - `crates/kubepit-core/src/rightsizing/patch.rs:26-32`
  - `crates/kubepit-core/src/rightsizing/mod.rs:79-105,279-325,539-600`
  - `crates/kubepit-core/src/history/audited.rs:23,405`
- Modify:
  - `apps/desktop/src/lib/kube/rightsizing/model.ts:36-41` (`RIGHTSIZABLE_KINDS` + `workloadGvk`)
  - `apps/desktop/src/components/workbench/cost/RightsizingDialog.tsx:49-53,245`
  - `apps/desktop/src/components/workbench/cost/CostBreakdown.tsx:26,219`
  - `apps/desktop/src/components/workbench/cost/RightsizingPanel.tsx:39,453`
  - `apps/desktop/src/components/workbench/details/sections/JobSections.tsx:104` (add `RightsizingSection`)
  - `apps/desktop/src/lib/ipc/mock/cost.ts` (`PLURAL`, `patched()` at the jobTemplate path)
- Test:
  - the tests module of `crates/kubepit-core/src/rightsizing/patch.rs`
  - `crates/kubepit-core/tests/cost.rs`

**Interfaces:**
- Produces:
  - `template_path("CronJob") == Some(&["spec", "jobTemplate", "spec", "template",
    "spec"])`.
  - `pub(crate) fn workload_gvk(kind: &str) -> Option<Gvk>`: apps/v1 for Deployment,
    StatefulSet and DaemonSet; batch/v1 `cronjobs` for CronJob. It replaces `apps_gvk`.
  - `workload_from_value("CronJob", obj)` reads
    `/spec/jobTemplate/spec/template/spec/containers`, with `replicas = 1`.
  - `workloads_in_scope` also lists `CronJob`s.
  - TS: `workloadGvk(kind: string): Gvk`, exported from `lib/kube/rightsizing/model.ts`.
    `appsGvk` is removed.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn cronjob_patches_the_job_template() {
    let body = resources_patch(template_path("CronJob").unwrap(), &[change("job", 120.0)], None);
    assert_eq!(body.pointer("/spec/jobTemplate/spec/template/spec/containers/0/resources/requests/cpu"), Some(&json!("120m")));
}
#[test] fn cronjob_templates_are_read() { assert_eq!(workload_from_value("CronJob", &cronjob()).unwrap().containers[0].0, "job"); }
// tests/cost.rs
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cronjobs_are_recommended_and_dry_run_patched() {
    // pods nightly-28765432-abcde → Job nightly-28765432 → CronJob nightly; 72 running
    // slots of 288 in one day.
    let nightly = report.workloads.iter().find(|w| w.kind == "CronJob").unwrap();
    assert_eq!(nightly.cost_replicas, 0.25);
    let dry = app.rightsizing_apply(&id, &cron_ref(), &changes, true).await.unwrap();
    assert!(patch_body(&log).contains("jobTemplate"));
    assert!(app.rightsizing_apply(&id, &cron_ref(), &changes, false).await.unwrap_err().to_string().contains("read-only"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core rightsizing::patch && cargo test -p kubepit-core --test cost`

Expected: FAIL.

- [ ] **Step 3: Implement the core and UI changes listed under Interfaces**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Verify the demo**

Run: `pnpm dev:ui`, open a CronJob's details.

Expected: a Right-sizing section, and "Review & apply" shows a dry-run diff at
`jobTemplate`.

- [ ] **Step 6: Commit**

```bash
git add crates/kubepit-core apps/desktop/src
git commit -m "feat(rightsizing): recommend and patch CronJobs"
```

### Task 9: Lenses, risk score and run summary

**Files:**
- Create: `crates/kubepit-core/src/rightsizing/summary.rs`
- Modify:
  - `crates/kubepit-core/src/rightsizing/mod.rs` (`recommend_workload` sets
    `lenses = lenses_of(&rec)`)
  - `apps/desktop/src/types/index.ts` (the summary types of spec §10.2)
  - `docs/ARCHITECTURE.md` ("Cost insight & right-sizing": pipeline, strategies, flags,
    CronJobs)
- Test: the tests module of `summary.rs`

**Interfaces:**
- Consumes: `WorkloadRecommendation`, `RightsizingReport` (Task 1).
- Produces:
  - `pub fn lenses_of(rec: &WorkloadRecommendation) -> Vec<RecommendationLens>` (spec
    §6.9, in declaration order).
  - `pub fn risk_score(rec: &WorkloadRecommendation) -> f64`: `f64::INFINITY` for
    `oom-killed`, else the maximum of `memory_max / memory_request` and
    `cpu_p95 / cpu_request`, with a missing request counting as 2.
  - `pub fn one_click_eligible(rec: &WorkloadRecommendation) -> bool`: high confidence,
    changed, no `*_limit_raised`.
  - `pub struct ResourceTotals { current, recommended: f64, comparable, unset: u32 }`.
  - `pub struct SummaryEntry { kind, namespace, name, verdict, confidence, monthly_delta,
    cpu_delta, memory_delta }`.
  - `pub struct RecommendationSummary`, with the fields of spec §10.2.
  - `pub fn summarize(report: &RightsizingReport) -> RecommendationSummary`.
    - Totals: requests × `cost_replicas` over comparable containers.
    - `top`: at most `TOP_PER_KIND = 5` under-provisioned (confidence ≥ medium) by
      `risk_score` descending, then at most 5 high-confidence over-provisioned by
      `monthly_delta` ascending.
    - Ties by namespace, then name.

Steps:

- [x] **Step 1: Write the failing tests**

```rust
#[test] fn lenses_follow_kubefit_semantics() {
    assert_eq!(lenses_of(&shrinking()), vec![RecommendationLens::CpuReduction, RecommendationLens::MemoryReduction]);
    assert!(lenses_of(&growing_with_raise()).contains(&RecommendationLens::LimitRaised));
    assert!(lenses_of(&unset_request()).contains(&RecommendationLens::RequestUnset));
    assert!(lenses_of(&no_usage()).contains(&RecommendationLens::MissingData));
    assert!(lenses_of(&medium_changed()).contains(&RecommendationLens::NeedsReview));
    assert!(!lenses_of(&unchanged_high()).contains(&RecommendationLens::NeedsReview));
}
#[test] fn risk_orders_oom_first_then_ratio() { assert!(risk_score(&oom()) > risk_score(&memory_twice_request())); }
#[test] fn summary_totals_use_cost_replicas_and_pick_the_top() {
    let s = summarize(&report_of(vec![web_3_replicas(), nightly_quarter_duty(), hot_under()]));
    assert_eq!(s.cpu.current, 3.0 * 1000.0 + 0.25 * 500.0 + 200.0);
    assert_eq!((s.top[0].name.as_str(), s.one_click), ("hot", 1));
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core rightsizing::summary`

Expected: FAIL to compile.

- [x] **Step 3: Implement `summary.rs`, set the lenses, mirror the TS types, and update the docs section**

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core && pnpm typecheck`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/rightsizing apps/desktop/src/types/index.ts docs/ARCHITECTURE.md
git commit -m "feat(rightsizing): lenses, risk score and run summaries"
```

### Task 10: `Settings.recommendations` and effective settings

**Files:**
- Create:
  - `crates/kubepit-core/src/recommendations.rs` (module root, `pub mod types;`)
  - `crates/kubepit-core/src/recommendations/types.rs`
- Modify:
  - `crates/kubepit-core/src/lib.rs` (`pub mod recommendations;`)
  - `crates/kubepit-core/src/types.rs:1041-1091` (`Settings.recommendations`)
  - `crates/kubepit-core/src/app.rs:176-207` (normalize in `set_settings`)
  - `crates/kubepit-core/src/rightsizing/collect.rs` (effective settings and strategy)
- Modify:
  - `apps/desktop/src/types/index.ts:1212-1243`
  - `apps/desktop/src/lib/ipc/mock/app.ts` (default settings)
- Test: the tests module of `recommendations/types.rs`

**Interfaces:**
- Produces:
  - `pub struct RecommendationSettings { pub scan_clusters: Vec<String>, pub
    interval_minutes: u32, pub retention_days: u32, pub strategy: Option<String>, pub
    overrides: BTreeMap<String, RightsizingSettings>, pub alerts: bool }`.
    - Defaults: `[]`, 60, 30, `None`, `{}`, false.
    - `normalized()`:
      - clamps the interval to 15–1440 and the retention to 1–90;
      - sorts and dedupes `scan_clusters` and drops blanks;
      - turns a blank strategy into `None`;
      - normalizes each override.
    - `scans(cluster_id) -> bool`.
  - `pub fn effective_settings(rec: &RecommendationSettings, strategy: &dyn
    RecommendationStrategy) -> RightsizingSettings`: `overrides[id]` or else
    `info().defaults`, normalized.
  - In `compute_rightsizing`:
    - `request.strategy.or(settings.recommendations.strategy)` feeds `resolve`;
    - `request.settings` (normalized) or else `effective_settings`.

Steps:

- [x] **Step 1: Write the failing tests**

```rust
#[test] fn recommendation_settings_default_and_normalize() {
    let d = RecommendationSettings::default();
    assert_eq!((d.interval_minutes, d.retention_days, d.alerts), (60, 30, false));
    let n = RecommendationSettings { interval_minutes: 5, retention_days: 400, strategy: Some(" ".into()),
        scan_clusters: vec!["b".into(), " ".into(), "a".into(), "b".into()], ..d }.normalized();
    assert_eq!((n.interval_minutes, n.retention_days, n.strategy.clone()), (15, 90, None));
    assert_eq!(n.scan_clusters, vec!["a", "b"]);
    assert!(n.scans("a") && !n.scans("c"));
}
#[test] fn effective_settings_prefer_overrides_then_strategy_defaults() {
    let d = RecommendationSettings::default();
    assert_eq!(effective_settings(&d, &WorkloadHistory).cpu_headroom_percent, 20.0);
    let o = RecommendationSettings { overrides: [("workload-history".into(), RightsizingSettings { cpu_headroom_percent: 35.0, ..WorkloadHistory::defaults() })].into(), ..d };
    assert_eq!(effective_settings(&o, &WorkloadHistory).cpu_headroom_percent, 35.0);
    assert_eq!(effective_settings(&o, &PercentileHeadroom).cpu_headroom_percent, 15.0, "an unrelated override is ignored");
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core recommendations`

Expected: FAIL to compile.

- [x] **Step 3: Implement the settings, normalization and wiring, and mirror them in TS and the demo**

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core && pnpm typecheck`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add crates/kubepit-core apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc/mock/app.ts
git commit -m "feat(recommendations): backend settings with per-strategy overrides"
```

# Phase 2: Storage, export and charts

### Task 11: Migration 2 and the recommendation store

**Files:**
- Create: `crates/kubepit-core/src/history/recommendations.rs`
- Modify:
  - `crates/kubepit-core/src/history/db.rs:31-106` (`MIGRATIONS` gets `(2, recommendations::MIGRATION)`)
  - `crates/kubepit-core/src/history.rs:25-31` (`pub mod recommendations;`)
  - `crates/kubepit-core/src/recommendations/types.rs` (`RunStatus`, `ScanTrigger`, `RecommendationRun`, `RecommendationTrendPoint`)
- Test: the tests module of `history/recommendations.rs` (temp-dir `db::open`)

**Interfaces:**
- Consumes: `RightsizingReport`, `RecommendationSummary` (Task 9), `RightsizingSettings`.
- Produces:
  - `pub const MIGRATION: &str`, the SQL of spec §11, verbatim.
  - `pub struct ScanBegin { pub cluster_id: String, pub started: i64, pub trigger:
    ScanTrigger, pub source_config: String }`.
  - `pub enum ScanOutcome { Success { report: RightsizingReport, summary:
    RecommendationSummary, settings: RightsizingSettings }, Failed(String),
    Interrupted(String) }`.
  - `pub fn row_key(kind: &str, namespace: &str, name: &str) -> String`, which gives
    `kind/namespace/name`.
  - `pub fn begin(conn: &Connection, scan: &ScanBegin) -> Result<i64>`.
  - `pub fn finish(conn: &mut Connection, run_id: i64, finished: i64, outcome:
    &ScanOutcome) -> Result<()>`: one transaction. Success writes the rows, the run and
    upserts `rec_latest`; otherwise only the run is written.
  - `pub fn sweep_interrupted(conn: &Connection, now: i64) -> Result<u64>`, with error
    `app-restarted`.
  - `pub struct StoredScan { pub run: RecommendationRun, pub report: RightsizingReport,
    pub settings: RightsizingSettings }`.
  - `pub struct LatestRead { pub scan: Option<StoredScan>, pub source_changed: bool, pub
    last_failure: Option<RecommendationRun> }`.
  - `pub fn latest(conn: &Connection, cluster_id: &str, source_config: &str) ->
    Result<LatestRead>`.
  - `pub fn scan(conn: &Connection, cluster_id: &str, run_id: i64) ->
    Result<Option<StoredScan>>`: rows sorted by `sort_recommendations`.
  - `pub fn runs(conn: &Connection, cluster_id: &str, limit: u32) ->
    Result<Vec<RecommendationRun>>`: ≤ 500, newest first.
  - `pub fn last_attempt(conn: &Connection, cluster_id: &str) ->
    Result<Option<RecommendationRun>>`.
  - `pub fn trend(conn: &Connection, cluster_id: &str, key: &str) ->
    Result<Vec<RecommendationTrendPoint>>`: successful runs whose rows are kept, oldest
    first.
  - `pub fn fleet(conn: &Connection) -> Result<Vec<(String, RecommendationRun, String)>>`:
    cluster id, the latest run, and its source config.

Steps:

- [x] **Step 1: Write the failing tests**

```rust
#[test] fn migration_two_applies_on_fresh_and_version_one_databases() {
    assert_eq!(schema_version(&db::open(&fresh).unwrap()).unwrap(), 2);
    let v1 = database_with_only_migration_one(&dir);     // executes MIGRATIONS[0] + version row 1
    assert_eq!(db::migrate(&v1).unwrap(), 2);
    assert_eq!(count(&v1, "audit"), 1, "existing data kept");
}
#[test] fn latest_moves_only_on_success() {
    let a = begin(&conn, &scan_begin("c1")).unwrap(); finish(&mut conn, a, 10, &success(report_of(vec![web()]))).unwrap();
    let b = begin(&conn, &scan_begin("c1")).unwrap(); finish(&mut conn, b, 20, &ScanOutcome::Failed("boom".into())).unwrap();
    let read = latest(&conn, "c1", CONFIG).unwrap();
    assert_eq!(read.scan.unwrap().run.id, a);
    assert_eq!(read.last_failure.unwrap().error.as_deref(), Some("boom"));
}
#[test] fn source_config_mismatch_hides_the_latest() { let r = latest(&conn, "c1", OTHER).unwrap(); assert!(r.scan.is_none() && r.source_changed); }
#[test] fn running_runs_become_interrupted_on_sweep() { assert_eq!(sweep_interrupted(&conn, 99).unwrap(), 1); assert_eq!(runs(&conn, "c1", 10).unwrap()[0].status, RunStatus::Interrupted); }
#[test] fn trend_lists_kept_runs_in_time_order() { assert_eq!(trend(&conn, "c1", "Deployment/shop/web").unwrap().len(), 2); }
#[test] fn rows_from_older_builds_still_read() {
    // A row JSON without pods/hpa/lenses/cost_replicas/evidence and a run with NULL summary.
    assert_eq!(scan(&conn, "c1", run).unwrap().unwrap().report.workloads[0].name, "legacy");
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core history::recommendations`

Expected: FAIL to compile.

- [x] **Step 3: Implement `history/recommendations.rs` and append the migration**

- [x] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core history`

Expected: PASS, including the existing history tests.

- [x] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/history crates/kubepit-core/src/history.rs crates/kubepit-core/src/recommendations
git commit -m "feat(history): store recommendation scans (migration 2)"
```

### Task 12: Retention, thinning, size cap and clear

**Files:**
- Modify:
  - `crates/kubepit-core/src/history/db.rs:456-567` (clear, `PrunePolicy`, `prune`)
  - `crates/kubepit-core/src/history/recommendations.rs` (`prune`, `clear`, `status`)
  - `crates/kubepit-core/src/history/types.rs:411-444` (`HistoryKind::Recommendations`, `HistoryStatus.recommendations`)
  - `crates/kubepit-core/src/history.rs:198-204,305-341` (`policy`, status)
- Modify:
  - `apps/desktop/src/types/index.ts:828` (`HistoryKind`, `HistoryStatus`)
  - `apps/desktop/src/lib/ipc/mock/history.ts` (status and clear)
- Test: the tests modules of `history/recommendations.rs` and `history/db.rs`

**Interfaces:**
- Consumes: Task 11's tables; `Settings.recommendations.retention_days` (Task 10).
- Produces:
  - `PrunePolicy` gains `rec_before: i64` (now − retention days) and
    `rec_rows_before: i64` (now − 48 h).
  - `recommendations::prune(conn, policy) -> Result<u64>` implements spec §11 retention
    steps 1–2.
  - `db::prune`'s size-cap loop calls `recommendations::delete_oldest_rows(conn, 0.1)`
    after events and changes run out and before the audit log.
  - `recommendations::clear(conn, cluster_id: Option<&str>)`.
  - `recommendations::status(conn) -> HistoryTableStatus`: row count of `rec_rows`,
    oldest `rec_runs.started`.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn retention_deletes_old_runs_but_keeps_the_latest() { /* latest older than 30 d stays; others go */ }
#[test] fn thinning_keeps_48_hours_then_one_run_per_day() {
    // hourly runs over 4 UTC-aligned days → runs < 48 h keep rows; the 2 older days keep
    // only their last run; the latest run is among the recent ones.
    assert_eq!(kept_runs(&conn), 48 + 2);
}
#[test] fn size_cap_drops_recommendation_rows_before_the_audit_log() {
    assert!(count(&conn, "audit") > 0 && count(&conn, "rec_rows") < before);
}
#[test] fn clearing_recommendations_per_cluster() { clear(&conn, Some("c1")).unwrap(); assert!(latest(&conn, "c1", CONFIG).unwrap().scan.is_none()); assert!(latest(&conn, "c2", CONFIG).unwrap().scan.is_some()); }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core history`

Expected: FAIL.

- [ ] **Step 3: Implement prune, clear and status, plus the `HistoryKind` and `HistoryStatus` changes on both sides**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core history && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/history crates/kubepit-core/src/history.rs apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc/mock/history.ts
git commit -m "feat(history): retention and thinning of recommendation scans"
```

### Task 13: Writer operations, history API and re-evaluation

**Files:**
- Modify:
  - `crates/kubepit-core/src/history/writer.rs:30-47,64-74,126-` (operations and start sweep)
  - `crates/kubepit-core/src/history.rs` (API)
  - `crates/kubepit-core/src/rightsizing/mod.rs` (`reevaluate`)
- Test: the tests modules of `history/writer.rs` and `rightsizing/mod.rs`

**Interfaces:**
- Consumes: Task 11's `begin`, `finish`, `sweep_interrupted`, reads; `recommend_workload`,
  `lenses_of`.
- Produces:
  - `WriteOp::ScanBegin(ScanBegin, mpsc::Sender<Result<i64>>)` and
    `WriteOp::ScanFinish(i64, i64, Box<ScanOutcome>, Option<mpsc::Sender<Result<()>>>)`.
    Both are control operations (barriers).
  - `Writer::start` runs `sweep_interrupted` after `db::open`.
  - On `History`:
    - `pub(crate) fn rec_begin(&self, scan: ScanBegin) -> Result<i64>` (blocking, 30 s);
    - `pub(crate) fn rec_finish(&self, run_id: i64, outcome: ScanOutcome) -> Result<()>`
      (blocking, 60 s);
    - `pub(crate) fn rec_finish_detached(&self, run_id: i64, outcome: ScanOutcome) ->
      bool` (`submit`, used by drop guards);
    - `pub(crate) fn rec_read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) ->
      Result<T>`.
  - `pub fn reevaluate(stored: &RightsizingReport, strategy: &dyn RecommendationStrategy,
    auto: bool, settings: &RightsizingSettings, pricing: &CostPricing) ->
    RightsizingReport`.
    - It rebuilds every `ContainerInput` from the stored `current`, `usage`, `evidence`
      and `stored.source`, and the workload `hpa`.
    - It recomputes verdict, monthly values, `cost_replicas`, lenses and sort.
    - It keeps `computed_at`, `window_secs`, `window_end` and the notes.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn scan_ops_are_barriers_and_never_dropped() {
    // Park the thread (WriteOp::Block), fill the queue until submit() returns false,
    // then rec_begin via send_blocking waits and succeeds once unblocked.
    assert!(!writer.submit(data_op()));
    assert!(handle.join().unwrap().is_ok());
}
#[test] fn writer_start_sweeps_running_runs() { assert_eq!(runs(&reader, "c1", 5).unwrap()[0].status, RunStatus::Interrupted); }
#[test] fn reevaluation_uses_the_stored_inputs() {
    let again = reevaluate(&stored, &WorkloadHistory, true, &RightsizingSettings { cpu_headroom_percent: 50.0, ..WorkloadHistory::defaults() }, &pricing);
    assert!(again.workloads[0].containers[0].recommended.cpu_request > stored.workloads[0].containers[0].recommended.cpu_request);
    assert_eq!(again.workloads[0].containers[0].usage, stored.workloads[0].containers[0].usage);
    assert_eq!(again.window_end, stored.window_end);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core -- history::writer rightsizing::tests`

Expected: FAIL.

- [ ] **Step 3: Implement the operations, the API and `reevaluate`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src
git commit -m "feat(history): blocking scan writes and re-evaluation of stored scans"
```

### Task 14: JSON and YAML exports

**Files:**
- Create: `crates/kubepit-core/src/rightsizing/export.rs`
- Modify: `crates/kubepit-core/src/rightsizing/mod.rs:22-26`
- Test: the tests module of `export.rs`

**Interfaces:**
- Consumes: `patch::format_cpu`, `patch::format_memory`; `WorkloadRef`.
- Produces:
  - `pub const EXPORT_FORMAT: &str = "kubepit.recommendations/v1"`.
  - `pub fn export_json(report: &RightsizingReport, cluster_name: &str, scanned_at: i64,
    selection: &[WorkloadRef]) -> Result<String>`: pretty JSON, the shape of spec §10.5;
    an empty selection means every workload.
  - `pub fn export_yaml(report: &RightsizingReport, selection: &[WorkloadRef]) ->
    String`.
    - Per changed container:
      - a header comment `# {kind} {ns}/{name} · container {c}`;
      - `# Resource fragment, not a complete manifest. Values are rounded up.`;
      - the complete resulting `resources` block.
    - Raised limits carry `# raised with the request (limit ÷ request ×{ratio})`, where
      the ratio has at most 2 decimals and no trailing zeros.
    - Fragments are separated by a blank line.
    - With nothing changed, the output is `# No changes to export.\n`.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn yaml_fragments_use_kubernetes_quantities() {
    let y = export_yaml(&report_with(350.0, 402_653_184.0, Some(1_073_741_824.0)), &[]);
    assert!(y.contains(r#"cpu: "350m""#) && y.contains(r#"memory: "384Mi""#) && y.contains(r#"memory: "1Gi""#));
    assert!(!y.contains("402653184") && !y.contains("1073741824"));
    assert!(export_yaml(&report_with(350.0, 384.0 * MIB + 1.0, None), &[]).contains(r#"memory: "385Mi""#));
    assert!(export_yaml(&report_with(2000.0, 2.0 * GIB, None), &[]).contains(r#"memory: "2Gi""#));
}
#[test] fn yaml_calls_out_raised_limits_and_skips_unchanged() {
    // current cpu request 1000 m / limit 2000 m, recommended request 2400 m → limit 4800 m
    let y = export_yaml(&raised_report(), &[]);
    assert!(y.contains(r#"cpu: "4800m""#) && y.contains("# raised with the request (limit ÷ request ×2)"));
    assert!(!y.contains("container sidecar"), "unchanged containers are skipped");
    assert_eq!(export_yaml(&unchanged_report(), &[]), "# No changes to export.\n");
}
#[test] fn json_is_locale_invariant_and_has_no_connection_metadata() {
    let j = export_json(&report_from_service_cluster(), "prod", 1_790_000_000_000, &[]).unwrap();
    let v: Value = serde_json::from_str(&j).unwrap();
    assert_eq!(v["format"], EXPORT_FORMAT);
    assert_eq!(v["workloads"][0]["containers"][0]["recommended"]["cpu_request"], json!(120.0));
    for secret in ["prometheus-operated", "monitoring", "kubeconfig", "token", "X-Scope-OrgID"] { assert!(!j.contains(secret), "{secret}"); }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core rightsizing::export`

Expected: FAIL to compile.

- [ ] **Step 3: Implement both builders**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core rightsizing::export`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/rightsizing
git commit -m "feat(rightsizing): JSON and container-resources YAML exports"
```

### Task 15: Usage history range queries

**Files:**
- Create: `crates/kubepit-core/src/prometheus/usage_history.rs`
- Modify:
  - `crates/kubepit-core/src/prometheus/mod.rs:19-24` (the module; `fetch_range` becomes
    `pub(crate)`)
  - `docs/ARCHITECTURE.md` ("Persistent history": recommendation tables and retention;
    "Prometheus": workload statistics and usage history)
- Test:
  - the tests module of `usage_history.rs`
  - `crates/kubepit-core/tests/recommendations.rs`

**Interfaces:**
- Consumes: `range::auto_step`, `Window`, `workload_pod_regex`, `quote`, `regex_escape`,
  `fetch_range`.
- Produces:
  - `pub struct WorkloadUsageHistory { start: i64, end: i64, step_secs: u64, pod_filter:
    PodFilter, cpu_avg, cpu_peak, memory_avg, memory_peak: Vec<PromPoint>, warnings:
    Vec<String> }`, with `enum PodFilter { Names, Pattern }` (kebab-case).
  - `pub fn history_queries(workload: &WorkloadRef, container: &str, pods: &[String],
    step_secs: u64) -> Result<([String; 4], PodFilter)>`: the four queries of spec §6.11.
    - Pods must be DNS-1123 subdomains (≤ 253 characters) and there may be at most 50.
    - An empty `pods` uses the pattern.
  - `impl Kubepit { pub async fn recommendations_usage_history(&self, cluster_id: &str,
    workload: &WorkloadRef, container: &str, pods: &[String], days: Option<u32>) ->
    Result<WorkloadUsageHistory> }`. The window ends at `window_end(now)` and covers
    `days.unwrap_or(7)` days (clamped 1–30).

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn history_queries_use_names_or_the_pattern() {
    let (q, filter) = history_queries(&web(), "app", &["web-1".into(), "web-2".into()], 3600).unwrap();
    assert_eq!(filter, PodFilter::Names);
    assert_eq!(q[0], r#"max(max_over_time((rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace="shop",container="app",pod=~"web-1|web-2"}[5m]))[3600s:5m])) * 1000"#);
    assert_eq!(history_queries(&web(), "app", &[], 3600).unwrap().1, PodFilter::Pattern);
}
#[test] fn invalid_pod_names_are_refused() {
    assert!(history_queries(&web(), "app", &["a|b".into()], 3600).is_err());
    assert!(history_queries(&web(), "app", &vec!["p".into(); 51], 3600).is_err());
}
// tests/recommendations.rs
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_history_reads_four_range_queries() {
    assert_eq!((h.step_secs, h.cpu_peak.len() > 0, count(&log, "/api/v1/query_range")), (3600, true, 4));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core prometheus::usage_history && cargo test -p kubepit-core --test recommendations usage_history`

Expected: FAIL.

- [ ] **Step 3: Implement the module and update the docs sections**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core docs/ARCHITECTURE.md
git commit -m "feat(prometheus): per-container usage history for recommendation charts"
```

# Phase 3: Scans

### Task 16: Scan runner

**Files:**
- Create: `crates/kubepit-core/src/recommendations/scan.rs`
- Modify:
  - `crates/kubepit-core/src/recommendations.rs`: the `Recommendations` state
    - `statuses: Mutex<HashMap<String, RecommendationScanStatus>>`;
    - `running: Mutex<HashSet<String>>`;
    - `semaphore: Arc<tokio::sync::Semaphore>` (2);
    - `last_manual: Mutex<HashMap<String, i64>>`;
    - `manual: TaskRegistry`;
    - `app: Mutex<Option<Weak<Kubepit>>>`.
  - `crates/kubepit-core/src/recommendations/types.rs`: `ScanState`,
    `RecommendationScanStatus`.
  - `crates/kubepit-core/src/app.rs:37-116`: the `recommendations` field.
  - `crates/kubepit-core/src/events.rs:11-27`: the sink method.
  - `crates/kubepit-core/tests/support/mod.rs:185-196`: `Recorder` records scan
    statuses.
- Test: `crates/kubepit-core/tests/recommendations.rs`

**Interfaces:**
- Consumes:
  - `compute_rightsizing`, `ScanProgress` (Task 7);
  - `summarize` (Task 9);
  - `rec_begin`, `rec_finish`, `rec_finish_detached` (Task 13);
  - `ScanBegin`, `ScanOutcome` (Task 11);
  - `pool.connected_client`.
- Produces:
  - `EventSink::recommendation_scan(&self, _status: &RecommendationScanStatus) {}`
    (default no-op).
  - `pub const MANUAL_COOLDOWN_MS: i64 = 60_000`.
  - `pub const MAX_CONCURRENT_SCANS: usize = 2`.
  - `pub const SCAN_TIMEOUT: Duration = Duration::from_secs(20 * 60)`.
  - `pub fn source_config(cluster: &ClusterDef) -> String`:
    `serde_json::to_string(&cluster.prometheus)` (phase 7 appends the access settings).
  - `impl Kubepit`:
    - `pub async fn recommendations_scan(self: &Arc<Self>, cluster_id: &str) ->
      Result<RecommendationScanStatus>`.
      - Refuses when disconnected ("connect to the cluster first").
      - Returns the current status when a scan runs.
      - Refuses within the cooldown ("wait {n} s before scanning again").
      - Otherwise spawns `run_scan` in `manual` (keyed `rec-manual:{cluster}`, tagged
        with the cluster) and returns `queued`.
    - `pub fn recommendations_status(&self, cluster_id: &str) ->
      RecommendationScanStatus`.
  - `pub(crate) async fn run_scan(app: Arc<Kubepit>, cluster_id: String, trigger:
    ScanTrigger) -> Result<i64>`:
    1. queued → acquire the semaphore → running;
    2. `rec_begin`;
    3. a `RunGuard` whose drop calls `rec_finish_detached(Interrupted("stopped"))` unless
       disarmed;
    4. `compute_rightsizing` with a strategy-free request (`settings: None`) under
       `SCAN_TIMEOUT`;
    5. source `None` → `Failed("no-usage-source")`;
    6. success → `summarize` + `ScanOutcome::Success`; an error → `Failed("{e:#}")`;
    7. status updates are emitted at state changes and at most every 250 ms while
       progressing.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_scan_stores_a_run_and_its_rows() {
    app.cluster_connect(&id).await.unwrap();
    app.recommendations_scan(&id).await.unwrap();
    let done = wait_for_state(&recorder, ScanState::Success).await;
    let read = app.history_rec_latest_for_tests(&id);         // reads via rec_read + latest()
    assert_eq!(read.scan.unwrap().report.workloads[0].name, "api");
    assert!(recorder.scans.lock().iter().any(|s| s.state == ScanState::Running && s.progress.is_some()));
    assert!(done.last_success_at.is_some());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failing_scan_keeps_the_last_good_result() {
    // second scan: Q1 answers 422 {"status":"error","errorType":"execution","error":"too many samples"}
    // for every batch, including single namespaces.
    assert_eq!(read.scan.unwrap().run.id, first_run);
    assert!(read.last_failure.unwrap().error.unwrap().contains("too many samples"));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_scan_per_cluster_and_manual_scans_are_rate_limited() {
    let a = app.recommendations_scan(&id).await.unwrap();
    let b = app.recommendations_scan(&id).await.unwrap();
    assert_eq!(a.run_id.or(b.run_id), b.run_id);            // same run reported
    wait_for_state(&recorder, ScanState::Success).await;
    assert!(app.recommendations_scan(&id).await.unwrap_err().to_string().contains("wait"));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_change_hides_results_and_scans_need_a_connection() {
    // update ClusterDef.prometheus to a service → latest().source_changed
    app.cluster_disconnect(&id);
    assert!(app.recommendations_scan(&id).await.unwrap_err().to_string().contains("connect"));
}
```

`history_rec_latest_for_tests` is a `#[doc(hidden)] pub fn` on `Kubepit`. Task 18
replaces its uses with `recommendations_latest`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test recommendations scan`

Expected: FAIL to compile.

- [ ] **Step 3: Implement the state, the runner, the sink method and the recorder**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core
git commit -m "feat(recommendations): manual scans persisted with keep-last-good"
```

### Task 17: Scheduler

**Files:**
- Create: `crates/kubepit-core/src/recommendations/schedule.rs`
- Modify:
  - `crates/kubepit-core/src/recommendations.rs` (`scheduled: TaskRegistry`, the process
    flag)
  - `crates/kubepit-core/src/connection.rs:250-256,375-393` (start on connect, stop in
    `stop_cluster_work`, clear on removal)
  - `crates/kubepit-core/src/app.rs:176-224` (sync after `set_settings`, stop at shutdown)
  - `crates/kubepit-core/src/cluster.rs` (a Prometheus config change makes the next scan
    due in 120 s)
- Test:
  - the tests module of `schedule.rs`
  - `crates/kubepit-core/tests/recommendations.rs`

**Interfaces:**
- Consumes: `run_scan` (Task 16); `last_attempt` (Task 11); `RecommendationSettings`
  (Task 10).
- Produces:
  - `pub const FIRST_DELAY_MS: i64 = 120_000`.
  - `pub const MAX_JITTER_MS: i64 = 60_000`.
  - `pub const SLICE: Duration = Duration::from_secs(60)`.
  - `pub fn next_due(connected_at: i64, jitter_ms: i64, last_attempt_end: Option<i64>,
    interval_ms: i64) -> i64`: `max(connected_at + FIRST_DELAY_MS + jitter,
    last_attempt_end + interval)`, where a missing last attempt gives the first term.
  - `impl Kubepit`:
    - `pub fn set_recommendation_scans(self: &Arc<Self>, on: bool)`: stores the `Weak`,
      then syncs;
    - `pub(crate) fn start_recommendation_scans(&self, cluster_id: &str)`;
    - `pub(crate) fn stop_recommendation_scans(&self, cluster_id: &str)`: aborts the
      scheduler and any manual scan;
    - `pub(crate) fn sync_recommendation_scans(&self)`.
  - The scheduler loop:
    - it sleeps in slices of at most `SLICE`, comparing the wall clock with `next_due`;
    - it calls `run_scan(.., ScanTrigger::Schedule)`;
    - it recomputes due after every run;
    - it sets `status.scheduled` and `next_at`.
  - Cluster removal also runs `rec_read`/clear for the cluster (`HistoryKind::Recommendations`).

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn next_due_follows_the_rules() {
    assert_eq!(next_due(1_000, 30_000, None, 3_600_000), 151_000);
    assert_eq!(next_due(1_000, 0, Some(10_000), 3_600_000), 3_610_000);
    assert_eq!(next_due(10_000_000, 0, Some(10_000), 3_600_000), 10_120_000, "long ago: after the first delay");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schedulers_run_only_for_opted_in_connected_clusters() {
    app.set_recommendation_scans(true);
    opt_in(&app, &id);                          // settings_set scan_clusters [id]
    app.cluster_connect(&id).await.unwrap();
    let s = app.recommendations_status(&id);
    assert!(s.scheduled && s.next_at.unwrap() >= s_connected + 120_000 && s.next_at.unwrap() <= s_connected + 180_000);
    opt_out(&app, &id);
    assert!(!app.recommendations_status(&id).scheduled);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_or_removal_interrupts_a_running_scan() {
    // Router sleeps 2 s on Q1 (std::thread::sleep inside the router closure).
    app.recommendations_scan(&id).await.unwrap();
    wait_for_state(&recorder, ScanState::Running).await;
    app.cluster_disconnect(&id);
    assert_eq!(last_run(&app, &id).status, RunStatus::Interrupted);
    assert_eq!(last_run(&app, &id).error.as_deref(), Some("stopped"));
    app.cluster_remove(&id).await.unwrap();
    assert!(runs_of(&app, &id).is_empty(), "removal clears the history");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core recommendations::schedule && cargo test -p kubepit-core --test recommendations schedul`

Expected: FAIL.

- [ ] **Step 3: Implement the scheduler and the lifecycle hooks**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core`

Expected: PASS. The existing tests stay deterministic because no test enables scans
except these.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core
git commit -m "feat(recommendations): hourly background scans while connected"
```

### Task 18: Read commands, Tauri wiring and the IPC contract

**Files:**
- Modify:
  - `crates/kubepit-core/src/recommendations.rs` (read commands)
  - `crates/kubepit-core/src/recommendations/types.rs` (`RecommendationLatest`,
    `RecommendationScanView`, `ClusterRecommendationSummary`)
- Create: `apps/desktop/src-tauri/src/ipc/recommendations.rs`
- Modify:
  - `apps/desktop/src-tauri/src/ipc/mod.rs`
  - `apps/desktop/src-tauri/src/lib.rs:177-178` (register the commands)
  - `apps/desktop/src-tauri/src/app_state.rs:47-75` (emit `recommendations://scan`)
  - `apps/desktop/src-tauri/src/setup.rs:24-29` (`core.set_recommendation_scans(true)`)
- Modify:
  - `apps/desktop/src/types/index.ts`
  - `apps/desktop/src/lib/ipc.ts:525-546,639-656`
  - `docs/ARCHITECTURE.md` (a new "Recommendations" section: scans, lifecycle, commands,
    event)
- Test: `crates/kubepit-core/tests/recommendations.rs`

**Interfaces:**
- Consumes: Tasks 11–17.
- Produces, on `Kubepit`:

  | Method | Behaviour |
  |---|---|
  | `recommendations_latest(&self, cluster_id, run_id: Option<i64>) -> Result<RecommendationLatest>` | Re-evaluates with the current resolved strategy and effective settings; `reevaluated` is true when those differ from the stored ones; `days_changed` compares `days` |
  | `recommendations_runs(&self, cluster_id, limit: u32) -> Result<Vec<RecommendationRun>>` | |
  | `recommendations_trend(&self, cluster_id, workload: &WorkloadRef) -> Result<Vec<RecommendationTrendPoint>>` | |
  | `recommendations_fleet(&self) -> Result<Vec<ClusterRecommendationSummary>>` | Every registered cluster; `source_changed` compares the current `source_config` |
  | `recommendations_export(&self, cluster_id, run_id: Option<i64>, workloads: &[WorkloadRef], format: RecommendationExportFormat) -> Result<String>` | Uses the re-evaluated report |

- Tauri commands with the same names and spec §10.3 arguments (camelCase in JS).
  `recommendations_scan` takes `state.core.clone()` (an `Arc`).
- TS:
  - the types of spec §10.2;
  - `ipc.recommendationsStatus/Scan/Latest/Runs/Trend/UsageHistory/Fleet/Export(...)`;
  - `onRecommendationScan(handler)` → `listenEvent<RecommendationScanStatus>('recommendations://scan', handler)`.
- `history_rec_latest_for_tests` is removed; the tests use `recommendations_latest`.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn latest_is_reevaluated_after_a_settings_change() {
    set_override(&app, "workload-history", RightsizingSettings { cpu_headroom_percent: 50.0, ..WorkloadHistory::defaults() });
    let l = app.recommendations_latest(&id, None).unwrap();
    let scan = l.scan.unwrap();
    assert!(scan.reevaluated && !scan.days_changed);
    assert_eq!(scan.report.workloads[0].containers[0].recommended.cpu_request, Some(150.0));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fleet_trend_and_export_read_the_store() {
    assert_eq!(app.recommendations_fleet().unwrap().iter().filter(|c| c.run.is_some()).count(), 1);
    assert_eq!(app.recommendations_trend(&id, &api_ref()).unwrap().len(), 2);
    assert!(app.recommendations_export(&id, None, &[], RecommendationExportFormat::Yaml).unwrap().contains("resources:"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test recommendations -- latest fleet`

Expected: FAIL.

- [ ] **Step 3: Implement the commands, the Tauri wiring, the TS contract and the docs section**

- [ ] **Step 4: Run the tests and checks**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core apps/desktop/src-tauri apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc.ts docs/ARCHITECTURE.md
git commit -m "feat(recommendations): read commands, scan event and Tauri wiring"
```

### Task 19: Demo backend

**Files:**
- Create:
  - `apps/desktop/src/lib/ipc/mock/recommendations.ts`
  - `apps/desktop/src/lib/ipc/mock/fixtures/recommendations.ts`
- Modify:
  - `apps/desktop/src/lib/ipc/mock/index.ts:38-40` (register after `./cost`, before
    `./history`)
  - `apps/desktop/src/lib/ipc/mock/cost.ts` (new report fields: `strategy_auto`,
    `window_end`, lenses, evidence and flags on the demo workloads)

**Interfaces:**
- Consumes: the Task 18 contract; `mockEmit` from `./bus`; the demo workload database
  (`getDb`).
- Produces handlers for:
  - `recommendations_status`, `recommendations_scan` (emits
    `recommendations://scan` queued → running with progress 0 … 16 over about 3 s →
    success), `recommendations_latest`, `recommendations_runs`, `recommendations_trend`;
  - `recommendations_usage_history` (deterministic sine-and-noise series with gaps);
  - `recommendations_fleet`;
  - `recommendations_export`, a TS mirror of `export.rs` (header comments and quantities
    identical to the Rust);
  - `history_clear` for kind `recommendations`, and `settings_set` sync.
- Fixtures (spec §15):
  - prod-eu-west-1: 30 days of runs (hourly for 48 h, then daily), every flag, a CronJob,
    one-click candidates;
  - staging: metrics-server only;
  - dev: last run failed plus the last good one;
  - kind: no scan.

Steps:

- [ ] **Step 1: Implement the handlers and fixtures listed under Interfaces**

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Verify in the browser console**

Run: `pnpm dev:ui`, then in the console
`await window.__kubepitMock?.('recommendations_latest', {clusterId: 'prod-eu-west-1', runId: null})`,
or through a temporary call in a component, which you remove afterwards.

Expected: a scan with at least 20 workloads, flags and a summary.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/ipc/mock
git commit -m "feat(demo): recommendation scans in the in-memory backend"
```

# Phase 4: UX

### Task 20: UI data layer and view models

**Files:**
- Create:
  - `apps/desktop/src/store/useRecommendationsStore.ts`
  - `apps/desktop/src/lib/kube/recommendations/model.ts`
- Modify:
  - `apps/desktop/src/lib/kube/rightsizing/model.ts:137-170` (`warningText` for the nine
    new codes; `strategyLabel` for `workload-history`)
  - `apps/desktop/src/components/workbench/cost/CostNotes.tsx` (texts for the new note
    kinds)
  - `apps/desktop/src/App.tsx`, or the root that already subscribes to `onAlert`
    (`startRecommendationEvents()`)
  - `apps/desktop/src/i18n/{en,tr}/{workbench,shell}.json`

**Interfaces:**
- Consumes: the Task 18 contract.
- Produces, in `store/useRecommendationsStore.ts`:
  - `interface ClusterRecs { latest: RecommendationLatest | null; status:
    RecommendationScanStatus | null; runs: RecommendationRun[]; runId: number | null;
    loading: boolean; error: string | null; applied: Record<string, number> }`.
  - `useRecommendationsStore`, with:
    - `byCluster`;
    - `load(clusterId, runId?: number | null): Promise<void>`;
    - `loadRuns(clusterId)`;
    - `scanNow(clusterId): Promise<void>`;
    - `selectRun(clusterId, runId | null)`;
    - `markApplied(clusterId, key)`;
    - `onScanEvent(status)`: on success it reloads the latest scan and runs.
  - `useLatestRecommendations(clusterId: ClusterId, enabled: boolean): { report:
    RightsizingReport | null; run: RecommendationRun | null; latest: RecommendationLatest
    | null; status: RecommendationScanStatus | null; loading: boolean; error: string |
    null }`.
  - `startRecommendationEvents(): () => void`.
- Produces, in `lib/kube/recommendations/model.ts` (pure, `@/i18n/core`):
  - `workloadKey(r)`, which returns `kind/namespace/name`;
  - `lensLabel(l)`;
  - `countLenses(list): Record<RecommendationLens, number>`;
  - `type RecSort = 'priority' | 'delta' | 'cpu' | 'memory' | 'confidence' | 'name'` and
    `sortRecommendations(list, sort)` (priority: under by `riskScore` descending, then
    `monthly_delta` ascending, then key);
  - `riskScore(rec)`, which mirrors `summary.rs::risk_score`;
  - `spotlight(list): { under: WorkloadRecommendation[]; over: WorkloadRecommendation[] }`
    (3 each);
  - `rankUsage(list, resource: 'cpu' | 'memory', stat: 'avg' | 'peak'): { rows: RankRow[];
    available: number; total: number }`:
    - one row per container with usage;
    - zeros kept, null dropped;
    - descending, ties by key;
    - the input is never mutated;
  - `capacityByNamespace(list, resource, top = 5): NamespaceCapacity[]`;
  - `optimizationTotals(list): OptimizationTotals`;
  - `type ApplyMode = 'one-click' | 'review' | 'blocked'` and `applyMode(rec, cluster:
    Pick<ClusterDef, 'read_only' | 'environment'>): ApplyMode` (spec §8; the RBAC gate is
    checked by the caller);
  - `scanStateText(status)`;
  - `runErrorText(error)`, which translates the codes `app-restarted`, `stopped`,
    `no-usage-source` and `cluster-label-mismatch` and passes anything else verbatim.

Steps:

- [ ] **Step 1: Implement the store, the model and the translation functions**

- [ ] **Step 2: Add the translations**

Run: `pnpm i18n:check -- --fix`, then add the Turkish for every key it prints, for
example:
- "HPA target: changing requests changes when it scales." → "HPA hedefi: istekleri
  değiştirmek ölçekleme zamanını değiştirir.";
- "OOM-killed in the window: memory never goes below the limit that killed it." →
  "Pencerede OOM ile sonlandı: bellek, sonlandıran sınırın altına inmez."

- [ ] **Step 3: Run the checks**

Run: `pnpm typecheck && pnpm i18n:check`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): recommendations store and view models"
```

### Task 21: The Recommendations view shell and the Cost card

**Files:**
- Create:
  - `apps/desktop/src/components/workbench/recommendations/RecommendationsPage.tsx`
  - `apps/desktop/src/components/workbench/recommendations/ScanHeader.tsx`
  - `apps/desktop/src/components/workbench/recommendations/RecommendationNotes.tsx`
  - `apps/desktop/src/components/workbench/recommendations/SettingsCard.tsx`
  - `apps/desktop/src/components/workbench/cost/RightsizingSummaryCard.tsx`
- Modify:
  - `apps/desktop/src/lib/kube/nav.ts:19-35,99-113,196-205` (`VIEW_KEYS.recommendations = '@recommendations'`, label, nav item with the spec §9.1 keywords)
  - `apps/desktop/src/lib/kube/icons.ts`
  - `apps/desktop/src/components/workbench/ViewHost.tsx:118-119`
  - `apps/desktop/src/components/workbench/keyboard/commandBarModel.ts` (`:recommendations`)
  - `apps/desktop/src/components/workbench/cost/CostPage.tsx:271-398` (the tab renders `RightsizingSummaryCard`)
  - `apps/desktop/src/components/workbench/cost/prefs.ts` (drop `settings` and `strategy`)
  - `apps/desktop/src/components/workbench/cost/useCost.ts:92-133` (`useRightsizing(clusterId, namespaces, workload, enabled)`, sending `settings: null, strategy: null`)
  - the call sites in `RightsizingSection.tsx` and `useHealthScan.ts`
- Delete: `apps/desktop/src/components/workbench/cost/RightsizingPanel.tsx`
- Modify: the i18n catalogs

**Interfaces:**
- Consumes: `useLatestRecommendations`, `useRecommendationsStore` (Task 20);
  `ipc.settingsSet`; `useAppStore` settings.
- Produces:
  - `RecommendationsPage({ clusterId, namespaces, isActive })`.
  - `ScanHeader({ clusterId, latest, status })`:
    - the source badge, strategy label (plus "(automatic)"), scan age;
    - progress "{completed}/{total} queries" while scanning;
    - "Scan now", disabled when disconnected, scanning, or before `manual_available_at`;
    - "Scan hourly" (toggles `Settings.recommendations.scan_clusters`) and an interval
      `Select` (15 m / 30 m / 1 h / 3 h / 6 h / 12 h / 24 h);
    - the run picker from `runs` (successful ones); a past run shows a "Past scan"
      badge;
    - Settings and Export slots.
  - `SettingsCard({ strategy: RightsizingStrategyInfo, settings: RightsizingSettings,
    onChange, onReset })`:
    - renders only `strategy.settings_keys`, with labels, suffixes and ranges from a
      local field map;
    - unknown keys show the raw key;
    - it writes `Settings.recommendations.overrides[strategy.id]`.
  - `RecommendationNotes({ latest, report, connected, intervalMinutes })`: stale, source
    changed, days changed, automatic fallback, report notes.
  - `RightsizingSummaryCard({ clusterId })`: potential saving, over / under counts, scan
    age, "Open recommendations".

Steps:

- [ ] **Step 1: Implement the components and the removals listed under Files**

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish, then `pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`.
- prod-eu-west-1 → Cluster → Recommendations: the header shows "Prometheus · 7 days",
  "Workload history (automatic)" and the scan age. "Scan now" shows progress, then
  success.
- dev shows "Last scan failed …" with results.
- kind shows the empty state "No scan yet".
- Cost → Right-sizing shows the summary card, and its link opens the view.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): Recommendations view with scan controls; Cost links to it"
```

### Task 22: Summary, capacity overview and review spotlight

**Files:**
- Create:
  - `apps/desktop/src/components/workbench/recommendations/SummaryCards.tsx`
  - `apps/desktop/src/components/workbench/recommendations/CapacityOverview.tsx`
  - `apps/desktop/src/components/workbench/recommendations/ReviewSpotlight.tsx`
- Modify: `RecommendationsPage.tsx`, the i18n catalogs

**Interfaces:**
- Consumes: `optimizationTotals`, `capacityByNamespace`, `spotlight` (Task 20); `Card`,
  `StatTile`, `Legend` (`overview/charts.tsx`); `ChangeCell` (`cost/RightsizingDialog.tsx`).
- Produces:
  - `OptimizationSummary({ list, currency })`:
    - CPU and memory Now → After;
    - the difference and %;
    - "comparable n/N containers, k without requests";
    - the footnote "Totals use requests × current replicas. They are not freed node
      capacity."
  - `AttentionTile({ count, onClick })` and `InventoryTile({ workloads, containers,
    namespaces })`.
  - `CapacityOverview({ list, onNamespace })`:
    - a CPU / memory toggle with `aria-pressed`;
    - paired SVG bars (`fill-fg/15` current, `fill-accent` recommended);
    - "n/N comparable";
    - the empty state "Namespace comparisons appear after the first scan."
  - `ReviewSpotlight({ list, onReview })`: under-provisioned and savings groups, the
    change cells, "Review", and the empty state "No workload needs attention".

Steps:

- [ ] **Step 1: Implement the three components and place them in the page grid**

The grid is `grid gap-3 @3xl:grid-cols-2`.

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish (reuse KubeFit's "Container başına…"
footnote wording adapted to replicas), then `pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`, prod-eu-west-1 → Recommendations.
- The summary shows CPU and memory Now → After.
- The capacity bars list 5 namespaces; clicking one filters the page to it.
- The spotlight lists an OOM-flagged workload first.
- With the pane narrowed below `@3xl`, the cards stack into one column.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): optimization summary, capacity overview and review spotlight"
```

### Task 23: Usage ranking

**Files:**
- Create: `apps/desktop/src/components/workbench/recommendations/UsageRanking.tsx`
- Modify: `RecommendationsPage.tsx`, the i18n catalogs

**Interfaces:**
- Consumes: `rankUsage` (Task 20); `cpuText`, `memoryText`.
- Produces: `UsageRanking({ list, onOpen })`:
  - Toggles: memory (default) / CPU and average (default) / peak, all with
    `aria-pressed`.
  - A search box over workload, container and namespace.
  - Pages of 8 rows, with columns #, workload / container, namespace, value.
  - The footer "Usage data available for {n} of {total} containers."

Steps:

- [ ] **Step 1: Implement the component**

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish, then `pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`.
- Switch CPU / peak: the order changes.
- A container with zero average stays listed; a container without data is not listed but
  is counted in the footer.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): usage ranking of workload containers"
```

### Task 24: Recommendation list with lenses, sorting, selection and export

**Files:**
- Create:
  - `apps/desktop/src/components/workbench/recommendations/RecommendationList.tsx`
  - `apps/desktop/src/components/workbench/recommendations/RecommendationRow.tsx`
  - `apps/desktop/src/components/workbench/recommendations/exportRecommendations.ts`
- Modify: `RecommendationsPage.tsx`, the i18n catalogs

**Interfaces:**
- Consumes:
  - `countLenses`, `sortRecommendations`, `applyMode`, `lensLabel`, `workloadKey`
    (Task 20);
  - `filterRecommendations`, `warningText` (`lib/kube/rightsizing/model.ts`);
  - `ChangeCell`, `RaisedTag`;
  - `ipc.recommendationsExport`;
  - `saveTextAs` (`dock/shared/saveFile.ts`) and `exportFileName` (`lib/tableExport.ts`).
- Produces:
  - `RecommendationList({ clusterId, report, runId, namespaces, readOnlyRun, onOpen,
    onApply, onReview, onBatchApply })`:
    - lens chips with counts, toggling;
    - verdict tabs With changes / Over / Under / All;
    - search;
    - a sort `Select` (priority, monthly change, CPU reduction, memory reduction,
      confidence, name);
    - checkbox selection;
    - a selection bar with "Apply {n} high-confidence" (only `one-click` rows) and "Export
      selected".
  - `RecommendationRow({ rec, mode, applied, selected, onToggle, onOpen, onApply,
    onReview })`:
    - the accent strip when active;
    - verdict and confidence badges;
    - flag chips (`warningText`, detail in `title`);
    - container change cells with `RaisedTag` and ratio;
    - the monthly delta;
    - "Apply" for one-click or "Review & apply".
    - An applied row shows "Applied, updated at the next scan".
  - `exportRecommendations(clusterId, runId, workloads: WorkloadRef[], format:
    RecommendationExportFormat, clusterName: string): Promise<void>`: saves to
    `exportFileName([clusterName, 'recommendations'], format)` with the `json` / `yaml`
    extension.

Steps:

- [ ] **Step 1: Implement the list, the row and the export helper; wire the header Export menu (JSON / YAML) to them**

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish, then `pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`.
- The "Limit raised" lens shows only rows with `RaisedTag`.
- Sorting by CPU reduction puts the largest millicore drop first.
- Select three rows, Export YAML: the file has one fragment per changed container with
  English comments.
- Export JSON contains `"format": "kubepit.recommendations/v1"`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): recommendation list with lenses, sorting, selection and export"
```

### Task 25: Detail drawer: changes, usage charts, history, YAML

**Files:**
- Create:
  - `apps/desktop/src/components/workbench/recommendations/RecommendationDrawer.tsx`
  - `apps/desktop/src/components/workbench/recommendations/UsageHistoryCharts.tsx`
  - `apps/desktop/src/components/workbench/recommendations/RecommendationTrend.tsx`
- Modify:
  - `apps/desktop/src/components/workbench/cost/RightsizingDialog.tsx:127-224` (export
    `ContainerChanges` for reuse; it is unchanged otherwise)
  - `RecommendationsPage.tsx`, the i18n catalogs

**Interfaces:**
- Consumes:
  - `ContainerChanges`;
  - `ipc.recommendationsUsageHistory` and `ipc.recommendationsTrend` through `usePolled`
    (keys include the run id);
  - `TimeSeriesChart` (`refs`, `lines`), `MultiSeriesChart`;
  - `toSeriesPoints` (`lib/prometheus.ts`);
  - `ipc.recommendationsExport(…, [ref], 'yaml')` for the YAML tab;
  - `navigateTo`, `workloadGvk`.
- Produces:
  - `RecommendationDrawer({ clusterId, rec, report, runId, connected, onClose, onApply,
    onReview })`. Tabs:
    - **Changes:** `ContainerChanges` plus, per container: evidence (coverage %, samples,
      observed hours, pods, throttle %, OOM, the HPA line) and the list of flags.
    - **Usage.**
    - **History.**
    - **YAML:** a read-only Monaco-free `<pre>`, copy, and save.
    - The drawer is docked at `@3xl` and above and an overlay below. Its header links to
      the workload.
  - `UsageHistoryCharts({ clusterId, rec, report })`:
    - a container `Select`;
    - CPU and memory `TimeSeriesChart`s (area = average, `lines` = peak);
    - dashed `refs`: current request, recommended request, current limit;
    - a header with window and step, and the "How to read these measurements" disclosure
      (three paragraphs);
    - disconnected or no Prometheus → a note instead.
  - `RecommendationTrend({ clusterId, rec })`: `MultiSeriesChart` of the current vs
    recommended request and the p95 / max per scan, with a CPU / memory toggle.

Steps:

- [ ] **Step 1: Implement the drawer and both charts**

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish (reuse KubeFit's "Zaman kapsamı…" and
"CPU, 5 dakikalık kullanım hızıdır…" paragraphs, adapted), then
`pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`, open a row.
- The Usage tab shows two charts with three dashed reference lines, and gaps break the
  line.
- The History tab shows hourly then daily points.
- The YAML tab matches the exported fragment.
- On staging (no Prometheus) the Usage tab shows the note.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): recommendation drawer with usage charts, history and YAML"
```

### Task 26: Apply flows: one-click, acknowledgement, batch

**Files:**
- Create:
  - `apps/desktop/src/components/workbench/recommendations/quickApply.ts`
  - `apps/desktop/src/components/workbench/recommendations/BatchApplyDialog.tsx`
- Modify:
  - `apps/desktop/src/components/workbench/cost/RightsizingDialog.tsx:230-340` (a
    `requireAck` checkbox and the flag list)
  - `RecommendationList.tsx`, `RecommendationDrawer.tsx`, `ReviewSpotlight.tsx` (wiring)
  - the i18n catalogs

**Interfaces:**
- Consumes: `applyMode` (Task 20); `changesOf`; `ipc.rightsizingApply`; `runMutation`;
  `useActionGates` + `requiredAccess('rightsize', …)`; `markApplied`.
- Produces:
  - `quickApply(clusterId: ClusterId, rec: WorkloadRecommendation): Promise<'applied' |
    'review'>`:
    1. a server-side dry run;
    2. on success, `runMutation(apply)` with the toast "Right-sized {name}" → `'applied'`;
    3. any dry-run error → `'review'`, and the caller opens `RightsizingDialog`.
  - `RightsizingDialog` gains the prop `requireAck: boolean`, true when
    `rec.confidence !== 'high'`. "Apply" stays disabled until "I reviewed: {flags}" is
    ticked. The flags are listed with `warningText`.
  - `BatchApplyDialog({ clusterId, recs, onClose })`: dry-runs each one in turn with a
    per-row status (ok / error), then "Apply {n}" applies only the rows whose dry run
    succeeded. It is refused on read-only clusters and only offered for `one-click`
    rows. Production clusters never reach it, because `applyMode` returns `review`.

Steps:

- [ ] **Step 1: Implement `quickApply`, the acknowledgement and the batch dialog, and wire the buttons**

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish, then `pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`.
- On staging-gke, "Apply" on a high-confidence row without a raise: the toast appears and
  the row shows "Applied…".
- A medium row opens the review; Apply is disabled until the acknowledgement is ticked.
- A raised-limit row opens the review showing ×ratio.
- prod-eu-west-1 (production) always opens the review with the typed name.
- On a read-only demo cluster Apply is blocked with the read-only note.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): one-click apply for high confidence, acknowledged review otherwise"
```

### Task 27: Workload details and Health

**Files:**
- Modify:
  - `apps/desktop/src/components/workbench/cost/RightsizingSection.tsx`
  - `apps/desktop/src/components/workbench/health/useHealthScan.ts:139-147`
  - `apps/desktop/src/lib/kube/health/rules.ts:231-256` (rule `workload-cpu-throttled`)
  - `apps/desktop/src/lib/kube/health/rightsizing.ts`
  - the i18n catalogs

**Interfaces:**
- Consumes: `useLatestRecommendations` (Task 20); `useRightsizing` (the live fallback);
  `Sparkline`; `applyMode`, `quickApply`.
- Produces:
  - `RightsizingSection`:
    - uses the stored row matching `workloadKey(obj)` when a scan exists (subtitle "From
      the scan {age}"), else the live report;
    - shows the flags;
    - shows a `Sparkline` of the recommended CPU and memory requests from
      `recommendations_trend`;
    - "Apply" or "Review & apply";
    - "Open in Recommendations" (navigates to `@recommendations` and selects the key).
  - `useHealthScan` passes the latest stored report (else the live one) as
    `input.rightsizing`.
  - Rule `workload-cpu-throttled`:
    - category `efficiency`, severity `warning`, needs `[]`;
    - title "Workloads throttled by their CPU limit";
    - hint "Raise or remove the CPU limit; the request stays as recommended.";
    - it fires per workload with a `cpu-throttled` flag and confidence ≠ low;
    - message "Container {container} is throttled in {percent} of CPU periods."

Steps:

- [ ] **Step 1: Implement the section, the Health input switch and the new rule**

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish, then `pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`.
- A Deployment's details show "From the scan …", flags and a sparkline.
- A CronJob shows the same.
- Health lists "Workloads throttled by their CPU limit" for the throttled demo workload.
- The overprovisioned findings still appear.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): stored recommendations in details and Health"
```

### Task 28: Fleet card and Settings → History

**Files:**
- Create: `apps/desktop/src/components/dashboard/RecommendationsFleetCard.tsx`
- Modify:
  - `apps/desktop/src/components/dashboard/Dashboard.tsx:33,298`
  - `apps/desktop/src/components/settings/HistoryCategory.tsx`
  - `docs/ARCHITECTURE.md` (UX parts of "Recommendations", "Health checks",
    "Cost insight & right-sizing")
  - the i18n catalogs

**Interfaces:**
- Consumes:
  - `ipc.recommendationsFleet` through `usePolled` (5 min, refreshed by scan events);
  - `useVisibleStore`;
  - `ipc.settingsSet`, `ipc.historyClear('recommendations', id)`.
- Produces:
  - `RecommendationsFleetCard({ visible })`: one row per cluster with a stored run:
    - scan age with a stale badge (disconnected, or older than 2 × interval);
    - potential saving per currency;
    - the under-provisioned count;
    - the one-click count;
    - "Top across the fleet": the `summary.top` entries merged by `monthly_delta`, at
      most 5.
    - A row opens the cluster's Recommendations view. The card is hidden when no
      cluster has a scan.
  - A Recommendations block in `HistoryCategory`:
    - retention (days);
    - interval;
    - a per-cluster "Scan hourly" checklist;
    - the alerts toggle (shown after Task 29);
    - "Clear recommendation history";
    - the `recommendations` table row count and the oldest scan.

Steps:

- [ ] **Step 1: Implement the card and the settings block, and update the docs**

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish, then `pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`.
- The dashboard shows the fleet card: prod stale after disconnecting it, dev with a
  failure badge.
- Settings → History toggles "Scan hourly" for dev, and the Recommendations header
  reflects it.
- Clear removes dev's scans, and the view shows "No scan yet".

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src docs/ARCHITECTURE.md
git commit -m "feat(ui): fleet recommendations card and history settings"
```

### Task 29 (optional): Alerts for new high-confidence savings

**Files:**
- Modify:
  - `crates/kubepit-core/src/alerts/model.rs:14-44` (`AlertReason::RightsizingSaving`,
    `ALL: [_; 9]`)
  - `crates/kubepit-core/src/alerts.rs` (`AlertCenter::raise(&self, sink, cluster_id,
    object, finding)`, extracted from `MonitorCtx::raise`)
  - `crates/kubepit-core/src/recommendations/scan.rs` (the hook after success)
- Modify:
  - `apps/desktop/src/types/index.ts` (`AlertReason`)
  - `apps/desktop/src/lib/alerts/text.ts`
  - `apps/desktop/src/components/settings/NotificationsCategory.tsx`
  - `apps/desktop/src/components/settings/HistoryCategory.tsx` (the toggle)
  - `apps/desktop/src/lib/ipc/mock/recommendations.ts`
  - the i18n catalogs
- Test: the tests module of `recommendations/scan.rs`

**Interfaces:**
- Consumes: `RightsizingReport` (the previous latest and the new one);
  `Settings.recommendations.alerts`.
- Produces:
  - `pub fn saving_alerts(previous: Option<&RightsizingReport>, next: &RightsizingReport)
    -> Vec<&WorkloadRecommendation>`. It returns the workloads that are high-confidence,
    `over`, with savings ≥ 50 % of `monthly_current` and a container drop ≥ 250 m or
    ≥ 512 MiB, and that did not qualify in `previous`.
  - Each alert is `Finding { reason: RightsizingSaving, message: "Requests could shrink
    by {percent}" (English data string), .. }`, raised through `AlertCenter::raise` only
    when `alerts` is on.

Steps:

- [ ] **Step 1: Write the failing test**

```rust
#[test] fn new_large_savings_alert_once() {
    assert_eq!(saving_alerts(None, &with_big_saving()).len(), 1);
    assert!(saving_alerts(Some(&with_big_saving()), &with_big_saving()).is_empty());
    assert!(saving_alerts(None, &medium_confidence_saving()).is_empty());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kubepit-core recommendations::scan`

Expected: FAIL.

- [ ] **Step 3: Implement the reason, `raise`, the hook and the UI texts; translate**

- [ ] **Step 4: Run the checks**

Run: `cargo test --workspace && pnpm typecheck && pnpm i18n:check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core apps/desktop/src
git commit -m "feat(alerts): optional alert for new high-confidence savings"
```

# Phase 5 (optional, drop if overkill): Authenticated and shared Prometheus

### Task 30: `PrometheusAccess` configuration and validation

**Files:**
- Create: `crates/kubepit-core/src/prometheus/access.rs`
- Modify:
  - `crates/kubepit-core/src/types.rs:33-71` (`ClusterDef.prometheus_access`)
  - `crates/kubepit-core/src/cluster.rs` (validate on add and update; cross-cluster
    disjointness)
  - `crates/kubepit-core/src/recommendations/scan.rs` (`source_config` includes the
    access settings)
  - `crates/kubepit-core/src/service_proxy.rs` (the `DetectCache` key includes the
    access settings)
- Modify: `apps/desktop/src/types/index.ts`
- Test: the tests module of `access.rs`

**Interfaces:**
- Produces:
  - `pub struct PrometheusAccess { pub tenant: String, pub cluster_labels:
    BTreeMap<String, String>, pub auth: Option<PrometheusAuth>, pub tls: Option<TunnelTls> }`.
  - `pub enum PrometheusAuth { Bearer { namespace, secret, token_key }, Basic {
    namespace, secret, username_key, password_key } }`, tagged `type`.
  - `pub struct TunnelTls { pub ca: Option<KeyRef>, pub insecure_skip_verify: bool }`.
  - `pub struct KeyRef { pub kind: KeyRefKind (ConfigMap | Secret), pub namespace, pub
    name, pub key }`.
  - `PrometheusAccess::normalized(self) -> Result<Self>`: spec §14 validation; the
    reserved keys are listed verbatim.
  - `pub fn matchers(&self) -> String`: `k="v"` pairs through `quote()`, sorted by key.
  - `pub fn provably_disjoint(a: &PrometheusAccess, b: &PrometheusAccess) -> bool`.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn access_is_validated() {
    assert!(access(&[("pod", "x")]).normalized().is_err());
    assert!(access(&[("9bad", "x")]).normalized().is_err());
    assert!(PrometheusAccess { tenant: "a\nb".into(), ..Default::default() }.normalized().is_err());
    assert_eq!(access(&[("region", "eu"), ("cluster", "prod")]).matchers(), r#"cluster="prod",region="eu""#);
}
#[test] fn shared_sources_need_disjoint_selectors() {
    assert!(provably_disjoint(&access(&[("cluster", "a")]), &access(&[("cluster", "b")])));
    assert!(!provably_disjoint(&access(&[("cluster", "a")]), &access(&[("region", "eu")])));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core prometheus::access`

Expected: FAIL.

- [ ] **Step 3: Implement it, and mirror it in TS**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core apps/desktop/src/types/index.ts
git commit -m "feat(prometheus): tenant, cluster labels and secret auth settings"
```

### Task 31: Selector injection into every preset, and the tenant header

**Files:**
- Create: `crates/kubepit-core/src/prometheus/matchers.rs`
- Modify:
  - `crates/kubepit-core/src/prometheus/{mod,usage,workload_stats,usage_history,proxy}.rs`
  - `crates/kubepit-core/src/upgrade.rs:426`
  - `crates/kubepit-core/src/cost/mod.rs:493,542`
- Test:
  - the tests module of `matchers.rs`
  - `crates/kubepit-core/tests/recommendations.rs`

**Interfaces:**
- Consumes: `PrometheusAccess::matchers` (Task 30).
- Produces:
  - `pub fn with_matchers(query: &str, matchers: &str) -> String`: the spec §14 lexer
    rules.
  - `pub enum Origin { Preset, User }`.
  - `impl Kubepit { pub(crate) async fn prometheus_get(&self, cluster_id: &str,
    endpoint: &str, params: Vec<(&str, String)>, origin: Origin, timeout: Duration) ->
    Result<PromData> }`: the single transport for every caller.
    - It rewrites `query` for `Preset`.
    - It sends `X-Scope-OrgID` when a tenant is set.
    - It invalidates on proxy failures.
  - `upgrade.rs` uses `Origin::Preset`. `prometheus_query_range` (the PromQL tab) uses
    `User`.
  - `workload_stats` fails closed: a Q11 series missing a configured label with its value
    → `BatchFailure::Proxy("cluster-label-mismatch")`, which aborts the scan with that
    error code.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn matchers_reach_every_vector_selector() {
    assert_eq!(with_matchers("sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)", r#"cluster="p""#),
        r#"sum(node_memory_MemTotal_bytes{cluster="p"} - node_memory_MemAvailable_bytes{cluster="p"})"#);
    assert_eq!(with_matchers(r#"max by (pod) (rate(x{a="b"}[5m]))"#, r#"cluster="p""#), r#"max by (pod) (rate(x{a="b",cluster="p"}[5m]))"#);
    assert_eq!(with_matchers(r#"x{} * on(instance, job) group_left(nodename) y{n="a,b"}"#, r#"c="p""#), r#"x{c="p"} * on(instance, job) group_left(nodename) y{n="a,b",c="p"}"#);
    for target in all_targets() { for metric in all_metrics() { if let Some(q) = preset(&target, metric, 60) {
        assert!(balanced_and_every_selector_has(&with_matchers(&q, r#"cluster="p""#), r#"cluster="p""#), "{q}");
    } } }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_scan_query_carries_the_cluster_label_and_mismatches_fail() {
    assert!(queries(&log).iter().all(|q| q.contains(r#"cluster="production""#)));
    assert!(headers_of(&log).iter().all(|h| h.contains("x-scope-orgid: team-a")));
    assert_eq!(last_run(&app, &id).error.as_deref(), Some("cluster-label-mismatch"));
}
```

The fake server's `Request` gains `headers: Vec<(String, String)>` in
`tests/support/mod.rs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core prometheus::matchers && cargo test -p kubepit-core --test recommendations cluster_label`

Expected: FAIL.

- [ ] **Step 3: Implement the lexer and the single transport, and move every caller to it**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --workspace`

Expected: PASS, including `tests/prometheus.rs`, `cost.rs` and `upgrade.rs`.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core
git commit -m "feat(prometheus): cluster-label selector on every preset and tenant header"
```

### Task 32: Secret-authenticated tunnel transport

**Files:**
- Create: `crates/kubepit-core/src/prometheus/tunnel.rs`
- Modify:
  - `crates/kubepit-core/Cargo.toml` (hyper 1, hyper-util, http-body-util, tokio-rustls,
    rustls, all already in `Cargo.lock`)
  - `crates/kubepit-core/src/portforward.rs:352` (`resolve_target` becomes `pub(crate)`)
  - `crates/kubepit-core/src/prometheus/mod.rs` (`prometheus_get` chooses the tunnel
    when `auth` is set)
- Test:
  - the tests module of `tunnel.rs`
  - `crates/kubepit-core/tests/recommendations.rs`

**Interfaces:**
- Consumes: `PrometheusAuth`, `TunnelTls` (Task 30); `Api::<Pod>::portforward`.
- Produces:
  - `pub(crate) struct Credentials(String)`, the finished `Authorization` value. Its
    `Debug` prints `Credentials(<redacted>)`.
  - `pub(crate) async fn read_credentials(client: &Client, auth: &PrometheusAuth) ->
    Result<Credentials>`.
    - It reads the Secret keys.
    - Errors name the Secret and key only, never the value.
    - A per-connection cache keeps credentials for 5 minutes.
  - `pub(crate) async fn request_over<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(stream: S,
    host: &str, path: &str, headers: &[(&str, &str)], timeout: Duration) ->
    Result<RawResponse>`: one HTTP/1.1 GET over hyper's `client::conn::http1`.
  - `pub(crate) async fn tunnel_get(client: &Client, service: &PrometheusService,
    access: &PrometheusAccess, path: &str, timeout: Duration) -> Result<RawResponse>`:
    port-forward to a ready pod (TLS for `https`: server name `<svc>.<ns>.svc`, CA from
    `KeyRef` or the system roots, or skip-verify) → `request_over`.

Steps:

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test] async fn tunnel_requests_carry_auth_and_tenant() {
    let (client, mut server) = tokio::io::duplex(64 * 1024);
    let reply = tokio::spawn(async move { read_request_then_write(&mut server, CHUNKED_OK).await });
    let resp = request_over(client, "prometheus.monitoring.svc", "/api/v1/query?query=1", &[("authorization", "Bearer t0k"), ("x-scope-orgid", "team-a")], Duration::from_secs(5)).await.unwrap();
    let head = reply.await.unwrap();
    assert!(head.contains("authorization: Bearer t0k") && head.contains("x-scope-orgid: team-a"));
    assert!(resp.is_success() && resp.body.contains("\"status\":\"success\""));
}
#[test] fn credentials_never_print() { assert_eq!(format!("{:?}", Credentials("Bearer s3cret".into())), "Credentials(<redacted>)"); }
// tests/recommendations.rs
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_values_stay_out_of_errors() {
    // GET /api/v1/namespaces/monitoring/secrets/prom-auth returns token "s3cret"; the
    // port-forward upgrade is not served by the fake server, so the scan fails.
    let err = last_run(&app, &id).error.unwrap();
    assert!(!err.contains("s3cret") && err.contains("port-forward"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core prometheus::tunnel && cargo test -p kubepit-core --test recommendations secret_values`

Expected: FAIL.

- [ ] **Step 3: Implement the tunnel and the transport choice**

- [ ] **Step 4: Run the tests and checks**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core Cargo.lock
git commit -m "feat(prometheus): authenticated access through a port-forward tunnel"
```

### Task 33: Cluster editor for shared and secured Prometheus

**Files:**
- Modify:
  - `apps/desktop/src/components/cluster-editor/PrometheusFields.tsx`
  - `apps/desktop/src/components/workbench/dock/promql/PromqlView.tsx` (the selector hint)
  - `apps/desktop/src/lib/ipc/mock/prometheus.ts` (keep and echo `prometheus_access`)
  - `docs/ARCHITECTURE.md` ("Prometheus": access, selector, tunnel)
  - the i18n catalogs (workbench, dock, shell by path)

**Interfaces:**
- Consumes: `PrometheusAccess` (Task 30); the existing cluster update flow.
- Produces a collapsible section "Shared or secured Prometheus" with:
  - a tenant field with the hint "X-Scope-OrgID of a multi-tenant Prometheus, Thanos or
    Mimir.";
  - label pair rows (add / remove);
  - auth: none / bearer token / basic auth, with the Secret namespace, name and key
    fields;
  - for https: a CA reference and "Skip TLS verification", which shows a warning badge;
  - inline validation mirroring `normalized()`; the backend stays the final check.

The PromQL tab shows "Cluster selector {matchers} is not added to your own queries." when
labels are configured.

Steps:

- [ ] **Step 1: Implement the section, the hint and the demo echo; update the docs**

- [ ] **Step 2: Translate, run the checks**

Run: `pnpm i18n:check -- --fix`, add the Turkish, then `pnpm typecheck && pnpm i18n:check`.

Expected: PASS.

- [ ] **Step 3: Verify the demo**

Run: `pnpm dev:ui`, edit a cluster → Prometheus.
- A reserved label key `pod` shows an error.
- A saved bearer reference round-trips.
- The PromQL tab shows the hint.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src docs/ARCHITECTURE.md
git commit -m "feat(ui): shared and secured Prometheus settings in the cluster editor"
```

---

## Self-review

- **Spec coverage.** Every spec section maps to a task:

  | Spec section | Tasks |
  |---|---|
  | §6.1–6.3 (queries, batching) | 3, 7 |
  | §6.4 (ownership) | 2 |
  | §6.5 (folding) | 4 |
  | §6.6 (strategy) | 6 |
  | §6.7 (evidence step) | 5 |
  | §6.8 (limits) | reuse; tested in 6, 7 |
  | §6.9 (verdict, lenses, summary) | 5, 9 |
  | §6.10 (resolution, fallbacks) | 6, 7, 10 |
  | §6.11 (usage history) | 15 |
  | §8 (confidence and apply) | 5, 6, 20, 26 |
  | §9.1 (the view) | 21–26 |
  | §9.2 (elsewhere) | 8, 21, 27, 28, 29 |
  | §10 (contract) | 1, 9, 10, 12, 18 |
  | §10.5 (exports) | 14, 24 |
  | §11 (storage) | 11–13 |
  | §12 (lifecycle) | 16, 17 |
  | §13 (security) | 14, 15, 30, 32 |
  | §14 (phase 7) | 30–33 |
  | §15 (testing) | every Rust task, 19 |
  | §16 (docs) | 9, 15, 18, 28, 33 |

- **Type consistency.** Names are used identically across tasks:
  - `ContainerUsage`, `WorkloadExtras`, `HpaTarget`, `StatsBatch`, `BatchFailure`,
    `ScanProgress`;
  - `ScanBegin`, `ScanOutcome`, `StoredScan`, `LatestRead`, `RecommendationLatest`;
  - `rec_begin`, `rec_finish`, `rec_finish_detached`, `rec_read`;
  - `resolve`, `effective_settings`, `reevaluate`, `summarize`, `lenses_of`,
    `risk_score` / `riskScore`, `workload_gvk` / `workloadGvk`.
- **Review Focus.** All five lines have tests in Tasks 3, 4, 7, 11 and 17.
- **UI tasks.** They have no unit tests, because Kubepit has no TS test runner. Each one
  ends with typecheck, the i18n check and a named demo walkthrough. Logic that needs
  pinning lives in Rust (spec decision 19).
