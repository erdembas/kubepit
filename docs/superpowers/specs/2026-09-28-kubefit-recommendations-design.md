# KubeFit-style recommendations in Kubepit: design

- **Date:** 2026-09-28
- **Status:** approved for planning
- **Plan:** `docs/superpowers/plans/2026-09-28-kubefit-recommendations.md`
- **Inputs:**
  - the KubeFit analysis (`kubefit-analysis.md`, KubeFit 0.2.0 working tree);
  - the user's decisions (`kubefit-decisions.md`). **The decisions override the analysis.**
- **Builds on (already on `main`):**
  - the right-sizing strategy interface (`crates/kubepit-core/src/rightsizing/`);
  - the Prometheus service-proxy transport (`prometheus/`, `service_proxy.rs`);
  - the SQLite history database (`history/`).

## 1. Problem

KubeFit computes CPU and memory request recommendations from seven days of Prometheus
history. It resolves every pod to its workload through kube-state-metrics, so a rollout
counts as one workload. It checks coverage and history length, stores every scan, and
shows the results in a review-oriented UI.

Kubepit already has a right-sizing list (`@cost` → Right-sizing) with two limits:

- It is computed on demand and forgotten: no scan history, no trends, no background work.
- Pods map to workloads by name patterns (`workload_pod_regex`). There are no coverage,
  HPA, OOMKilled or throttling signals.

KubeFit's own rules have problems that must not be copied:

- It fails closed on any warning. A single throttled second, any OOM kill, any HPA or one
  partial Prometheus response voids both resources.
- Its severity labels are inverted: "Healthy" means over-provisioned.
- It mishandles StatefulSet pods that are recreated with a new UID.
- It treats kube-state-metrics' `<none>` owner as a real workload.

## 2. Goals

1. A new recommendation strategy that ports KubeFit's *logic* (analysis §2), with the
   KubeFit bugs fixed:
   - the seven-day CPU p95 per pod, then the maximum over the pods;
   - the memory peak;
   - headroom, minimums and rounding up;
   - historical ownership through kube-state-metrics;
   - coverage and history-length checks.
2. Recommendations are never blocked. Each one carries flags and a
   `low` / `medium` / `high` confidence. One-click apply is offered only for high
   confidence; everything else goes through the existing dry-run review with an explicit
   confirmation.
3. A recommended request that exceeds the current limit raises that limit proportionally.
   The raise is visible in the row, the patch, the YAML export and the review.
4. Scans run in the background (hourly, opt-in per process and per cluster, only while
   connected) and manually ("Scan now"). They persist in `~/.kubepit/history.db`:
   - 30-day retention;
   - the last good result is kept when a scan fails;
   - runs cut short are marked interrupted;
   - trends across scans come from stored summary statistics.
5. A dedicated Recommendations view in Kubepit's own design, with KubeFit's useful screens
   re-imagined:
   - capacity overview, optimization summary, review spotlight and usage ranking;
   - usage history charts with request, limit and recommendation lines;
   - the resource change diff;
   - quick-focus filters, sorting, and JSON / YAML export.

   It also integrates with workload details, Health, the dashboard (fleet) and, optionally,
   alerts.
6. Optional last phase: authenticated or shared Prometheus through a Kubernetes Secret
   reference, a tenant header and a cluster-label selector.

## 3. Non-goals

- No direct-URL Prometheus mode, no kubeconfig-less clusters (user decision 3).
- Nothing from KubeFit's shadcn / recharts / sonner UI is ported. No new UI or chart
  libraries.
- No recommendations for:
  - init containers, native sidecars or ephemeral containers;
  - bare pods, standalone Jobs, orphan ReplicaSets;
  - custom controllers (Argo Rollouts and others).

  These are counted and reported, not recommended.
- No CPU or memory **limit** recommendations beyond the proportional raise (KubeFit never
  recommends limits). `percentile-headroom` keeps its existing memory-limit headroom rule.
- No storage of raw or downsampled usage series. Charts query Prometheus on demand
  (§6.11).
- No VPA awareness in this plan (open question 1).
- Nothing HTTP-server related: basic auth, CSRF, Helm chart, Docker, backup CLI, legacy
  `KRR_*` compatibility, or KubeFit's Turkish-key i18n reverse lookup.

## 4. Decisions

Sources:
- **U1–U4** are the user's decisions in `kubefit-decisions.md`.
- **O-…** are the orchestrator defaults in the same file.
- **E-…** are engineering decisions taken here.

| # | Decision | Source | Rationale |
|---|---|---|---|
| 1 | Port KubeFit's logic as a new `RecommendationStrategy` with id **`workload-history`** ("Workload history"). It sits next to `percentile-headroom` and is chosen automatically when kube-state-metrics ownership is available | U1 | "Workload history" names what is new: the workload's whole history across pod incarnations. `prometheus-v1` would name a data source, and metrics-server can feed the strategy too |
| 2 | Evidence collection (usage, coverage, ownership, guards) is **strategy-independent** and feeds every strategy. Only the math differs | E | `strategy.rs` already states that fetching usage happens before any strategy runs. Both strategies gain HPA / OOM / throttling awareness |
| 3 | **Hybrid query strategy:** 16 server-side instant queries per batch, cluster-wide by default, with an adaptive namespace split. The client-side join is over pod names | E | KubeFit issues 1 + 30 × namespaces sequential range queries, about 1,500 proxied requests and hundreds of MB of JSON for 50 namespaces. The hybrid issues about 16 requests with one series per pod-container. §6.3 argues that accuracy is preserved |
| 4 | Stats are keyed by **pod name**, not by `(pod, uid)` | E, O-bugs | cAdvisor series carry no uid. A StatefulSet pod recreated under the same name belongs to the same workload slot, which fixes KubeFit's UID-churn blocking. Reuse of a pod name *across owners* is detected as ambiguity |
| 5 | `<none>`, empty or `owner_is_controller="false"` owners mean "no owner" | O-bugs | kube-state-metrics emits `<none>` for ownerless pods, ReplicaSets and Jobs. KubeFit collapsed them into one bogus row |
| 6 | Coverage is measured against **running** presence (`kube_pod_container_status_running == 1`), not against `kube_pod_container_info` | E | Pending and Completed pods lowered KubeFit's coverage without any data being missing, which voided most batch rows |
| 7 | HPA, OOMKilled, throttling, partial data and unclear identity become **flags and confidence caps**, never blocks | U2 | A recommendation is always computed. Risk drives confidence, and confidence drives how much confirmation apply needs |
| 8 | Throttling uses a **ratio**: throttled CFS periods ÷ CFS periods ≥ 5 % (setting, 1–50 %), and only with ≥ 600 periods | U2 | "Any throttled second" flags nearly every container that has a CPU limit |
| 9 | After an OOM kill, `workload-history` never recommends less memory than the current limit plus headroom | E | The working set peaks at the limit just before the kill, and 5-minute samples miss that peak (krr's `use_oomkill_data` idea). Open question 2 |
| 10 | Limits: reuse `strategy::finalize`, which raises a limit proportionally (current limit ÷ request kept, rounded up). No limit is voided, lowered or invented | U4 | Already implemented and tested. The UI shows the ratio (`RaisedTag`, `limitRatio`) |
| 11 | Severity uses Kubepit's `Verdict`: over / under / balanced / no data, labelled "Over-provisioned", "Under-provisioned", "Well sized", "No usage data". Attention means under-provisioned first | U-bugs | Fixes KubeFit's inverted labels (its GOOD meant over-provisioned) and drops its never-produced CRITICAL |
| 12 | One-click apply requires: high confidence, no raised limit, a non-production and writable cluster, and the RBAC gate. Everything else opens the dry-run review. Medium or low confidence also needs an acknowledgement checkbox that lists the flags | U2, U4 | Limit raises and production clusters always get the review, as the architecture requires |
| 13 | CronJobs are recommended and patchable at `spec.jobTemplate.spec.template.spec`. Their cost uses the observed duty cycle | O-cronjobs | Workloads resolve Job → CronJob. The duty cycle keeps a nightly job from looking like an always-on replica |
| 14 | Settings live in the backend (`Settings.recommendations`), with overrides per strategy. The Cost view's localStorage headroom preferences go away | E | Background scans need the settings in the backend. Per-strategy overrides keep `percentile-headroom`'s 15 % CPU default apart from `workload-history`'s 20 % |
| 15 | Stored scans are re-evaluated on read when the strategy or settings changed. No Prometheus query is needed | E | Rows keep their inputs (current values, usage, evidence), so a headroom change is instant instead of waiting for a scan |
| 16 | Storage: runs, workload rows, a latest pointer and a summary. Row thinning keeps every run for 48 h, then one successful run per UTC day, for 30 days, and always the latest run | U-storage, O-retention | Full hourly rows for 30 days would be about 1.4 M rows for a 2,000-workload cluster. Thinning gives hourly then daily trend points at about 60 MB worst case |
| 17 | No raw or downsampled series are stored. Usage charts query Prometheus on demand; trends use stored per-scan statistics | U-storage, O-retention | Downsampling every container every hour would cost about 100 MB of JSON per scan through the proxy. Trends already come from rows |
| 18 | UX: a dedicated **Recommendations** view (`@recommendations`, Cluster section). The Cost view's Right-sizing tab becomes a summary card that links to it | E (U-ux leaves it open) | Scan lifecycle, history, spotlight, ranking, charts and batch apply need room. The view also works without cost prices |
| 19 | Exports (JSON, YAML fragment), lenses, summaries and risk scores are built in Rust | E | Kubepit has no TS test runner. Rust keeps KubeFit's export and lens test cases testable |
| 20 | Background scans are opt-in per process (`Kubepit::set_recommendation_scans`) and per cluster (`Settings.recommendations.scan_clusters`). They run hourly by default, only while connected, one at a time per cluster and at most two at once | U-storage, O-background | Same pattern as alerts, the change journal and history persistence. Tests and headless tools never scan |
| 21 | A source-config change invalidates the latest pointer: results are hidden with a note, and the next scheduled scan starts early | E (KubeFit behaviour 8) | Results from another Prometheus source must not pass as current |
| 22 | Phase 7 (authenticated Prometheus) is optional: auth goes through an in-process port-forward stream, the tenant header through the proxy, and the label selector is injected into every preset | U3 | The API server's service proxy does not forward `Authorization` |

## 5. Architecture

```
                  ┌──────────────────────── kubepit-core ────────────────────────┐
 connect ──►      │ recommendations.rs (scheduler, runner, commands)             │
 schedule / Scan  │   │ one scan = rightsizing::collect::compute(...) + persist  │
 now              │   ▼                                                           │
                  │ rightsizing/collect.rs ── lists workloads, HPAs (live API)   │
                  │   │  ├─ prometheus/workload_stats.rs  Q1–Q16 per batch        │
                  │   │  ├─ rightsizing/ownership.rs      pod → workload          │
                  │   │  ├─ rightsizing/evidence.rs       fold → UsageStats +     │
                  │   │  │                                UsageEvidence           │
                  │   │  └─ fallbacks: name match, metrics-server hour            │
                  │   ▼                                                           │
                  │ rightsizing/strategy.rs: resolve → strategy.recommend →       │
                  │   apply_evidence (flags, caps) → finalize (limits)            │
                  │   ▼                                                           │
                  │ rightsizing/summary.rs (lenses, summary, risk)               │
                  │   ▼                                                           │
                  │ history/recommendations.rs (rec_runs, rec_rows, rec_latest)  │
                  │   via the history writer thread (blocking control ops)       │
                  └──────────────────────────────────────────────────────────────┘
 UI: store/useRecommendationsStore ◄── recommendations://scan event, recommendations_* commands
     components/workbench/recommendations/*  (view)   dashboard/RecommendationsFleetCard
     cost/RightsizingSection (details)  lib/kube/health/rightsizing.ts (findings)
```

`rightsizing_report` (the live, on-demand command) and scans share one pipeline:
`Kubepit::compute_rightsizing(cluster_id, request, progress)`. The details panel and
Health use the latest stored scan when one exists and fall back to the live report
otherwise.

## 6. Algorithm

### 6.1 Window

- `D` = `settings.days` (default 7, range 1–30).
- `end = floor(now_s / 300) × 300`; every instant query sends `time=end`.
- `start = end − D·86400`.
- Subqueries use `[Dd:5m]`, which gives 2,016 steps for 7 days.

### 6.2 Queries (instant, per batch)

Matchers:

| Name | Value |
|---|---|
| `NS` | `namespace=~"a\|b"` (sorted, escaped with `regex_escape`), or nothing for a cluster-wide batch |
| `POD` | `pod=~"<regex>"` for a single-workload scope, else nothing |
| `SEL` | `container!="",container!="POD"` + `NS` + `POD` |
| `KSM` | `NS` + `POD` |

Every aggregation is `max by (…)`, which collapses duplicate scrapes (KubeFit behaviour 2).

| # | Name | PromQL |
|---|---|---|
| Q1 | `cpu_p95` | `quantile_over_time(0.95, (max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{SEL}[5m])))[Dd:5m]) * 1000` |
| Q2 | `cpu_max` | `max_over_time((max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{SEL}[5m])))[Dd:5m]) * 1000` |
| Q3 | `cpu_avg` | `avg_over_time((max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{SEL}[5m])))[Dd:5m]) * 1000` |
| Q4 | `cpu_samples` | `count_over_time((max by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{SEL}[5m])))[Dd:5m])` |
| Q5 | `memory_max` | `max by (namespace, pod, container) (max_over_time(container_memory_working_set_bytes{SEL}[Dd]))` |
| Q6 | `memory_avg` | `max by (namespace, pod, container) (avg_over_time(container_memory_working_set_bytes{SEL}[Dd]))` |
| Q7 | `memory_samples` | `count_over_time((max by (namespace, pod, container) (container_memory_working_set_bytes{SEL}))[Dd:5m])` |
| Q8 | `running` | `count_over_time((max by (namespace, pod, container) (kube_pod_container_status_running{KSM} == 1))[Dd:5m])` |
| Q9 | `first_seen` | `min_over_time(timestamp(max by (namespace, pod) (kube_pod_container_status_running{KSM} == 1))[Dd:5m])` |
| Q10 | `last_seen` | `max_over_time(timestamp(max by (namespace, pod) (kube_pod_container_status_running{KSM} == 1))[Dd:5m])` |
| Q11 | `pod_owners` | `max by (namespace, pod, owner_kind, owner_name) (max_over_time(kube_pod_owner{KSM,owner_is_controller!="false"}[Dd]))` |
| Q12 | `replicaset_owners` | `max by (namespace, replicaset, owner_kind, owner_name) (max_over_time(kube_replicaset_owner{NS}[Dd]))` |
| Q13 | `job_owners` | `max by (namespace, job_name, owner_kind, owner_name) (max_over_time(kube_job_owner{NS}[Dd]))` |
| Q14 | `oom` | `max by (namespace, pod, container) (max_over_time(kube_pod_container_status_last_terminated_reason{KSM,reason="OOMKilled"}[Dd]))` |
| Q15 | `throttled` | `max by (namespace, pod, container) (increase(container_cpu_cfs_throttled_periods_total{SEL}[Dd]))` |
| Q16 | `periods` | `max by (namespace, pod, container) (increase(container_cpu_cfs_periods_total{SEL}[Dd]))` |

Notes:

- Q12 and Q13 omit `POD`: ReplicaSet and Job series have no `pod` label.
- In `NS`, the literal `\|` above is a plain `|`. It is escaped here only for the table.
- Q3 uses a subquery on purpose. `rate(x[7d])` would divide the increase of a pod that
  lived one day by seven days.
- Q9 and Q10 rely on `timestamp()` of an aggregated expression returning the evaluation
  step.

**Required queries** are Q1 and Q5. The rest refine the result:

- If a refining query fails, the batch is still used. Its rows get the `partial-data`
  flag, and the scan note names the query.
- Prometheus `warnings` on any query also mark the batch partial.

### 6.3 Batching, budget and why the hybrid is accurate

**First batch:** all namespaces that have live workloads in scope, or the whole cluster
(no `NS`) above 40 namespaces (`MAX_NAMESPACE_MATCHERS`).

**When a batch fails.** A required query of a batch may fail with a timeout, a Prometheus
error such as "too many samples", or more than 50,000 series:
- A batch with several namespaces is split into two halves, recursively, down to single
  namespaces.
- A single namespace that still fails gets no usage (no-data), and a `namespace-failed`
  note lists it.
- A proxy failure (404 / 502 / 503 from the service proxy, meaning Prometheus is gone)
  aborts the scan.
- When no batch succeeds at all, the scan fails with the first error and keeps the last
  good result.

**Limits:**

| Limit | Value |
|---|---|
| Queries in flight per scan | 4 |
| Timeout per query | 60 s (`USAGE_TIMEOUT`) |
| Series per response | 50,000 |
| Batches per scan | 32 (≤ 512 requests); namespaces left over get the `query-budget-exceeded` note |
| Scan timeout | 20 minutes |

**Cost:**
- Typical cluster: **16 requests per scan**, each returning one series per
  pod-container seen in the window.
- KubeFit: `1 + namespaces × (2 + D × 4)` range requests (1,501 for 50 namespaces),
  each returning 288 points per series.
- The server-side cost is 4 heavy 2,016-step subqueries (Q1–Q4) plus lighter ones
  (Q7–Q10). This is well under Prometheus' default `query.max-samples` of 50 M up to
  about 20,000 containers. Beyond that, the split takes over.
- Hourly scans are the default. The interval can go up to 24 h.

**Accuracy.** KubeFit joins samples to owners per 5-minute timestamp.

- A pod's controller owner is immutable for its UID.
- At any instant, pod names are unique within a namespace.

So the only way per-name aggregation can misattribute samples is when a pod name was used
by **different owners** within the window. Q11 exposes exactly that case, as more than one
owner for one `(namespace, pod)`, and it is flagged instead of silently mixed.

A StatefulSet pod recreated under the same name has one owner, so it is pooled into the
same slot. That is the intended fix.

The one deliberate difference is the CPU p95: it is computed per pod *name* rather than
per `(pod, uid)` incarnation.

### 6.4 Ownership resolution (`rightsizing/ownership.rs`)

**Indexes:**
- `pods[(ns, pod)]` = the set of `(owner_kind, owner_name)` from Q11;
- `replicasets[(ns, rs)]` from Q12;
- `jobs[(ns, job)]` from Q13.

An entry is dropped when `owner_kind` or `owner_name` is empty or `<none>`, or when
`owner_is_controller="false"` (the last check is repeated client-side).

`resolve(ns, pod) -> Owner`:

1. No owner → `Unowned` (bare pod: skipped, counted).
2. More than one owner → `Ambiguous(candidates)`.
3. `ReplicaSet r`: look up `replicasets[(ns, r)]`.
   - One `Deployment` parent → `Workload(Deployment, parent)`.
   - No parent → `Unowned` (orphan ReplicaSet).
   - More than one parent → `Ambiguous`.
   - Another parent kind (e.g. `Rollout`) → `Unsupported(kind)`.
4. `Job j`: look up `jobs[(ns, j)]`.
   - One `CronJob` parent → `Workload(CronJob, parent)`.
   - No parent → `Unowned` (standalone Job).
   - More than one parent → `Ambiguous`.
   - Another parent kind → `Unsupported`.
5. `StatefulSet` or `DaemonSet` → `Workload(kind, name)`.
6. Anything else (`Node` for static pods, custom kinds) → `Unsupported(kind)`.

**Which rows exist:**
- Only workloads that also exist **live** (listed through the API) get rows.
- An ambiguous pod contributes no samples. Every live candidate workload gets the
  `identity-unclear` flag.

**Name-match fallback.** If Q11 returns no usable series (no kube-state-metrics), pods
fold into workloads through the existing `PodMatcher` (`workload_pod_regex`, the longest
name wins), and every row gets the `identity-by-name` flag.

### 6.5 Folding into per-container usage and evidence (`rightsizing/evidence.rs`)

**Notation:**
- `P` = the set of pod names resolved to workload `w`.
- `c` = a container name from `w`'s live pod template. Other containers, such as
  injected sidecars, are skipped because they cannot be patched.
- For each pod `p` and container `c`, `s[p,c]` holds the per-pod statistics from
  Q1–Q8 and Q14–Q16.

**`UsageStats` of `(w, c)`:**

```
cpu_p95    = max_p s.cpu_p95          (max over pods of per-pod p95, as krr "simple")
cpu_max    = max_p s.cpu_max
memory_max = max_p s.memory_max
cpu_avg    = Σ_p s.cpu_avg·s.cpu_samples / Σ_p s.cpu_samples          (None if Σ = 0)
memory_avg = Σ_p s.memory_avg·s.memory_samples / Σ_p s.memory_samples
hours      = observed_hours           (below)
```

- A pod with no Q1 or no Q5 value contributes nothing to the maxima.
- A row whose pods produced neither value has `usage = None`.

**`UsageEvidence` of `(w, c)`:**

```
observed_hours  = |⋃_p [first_seen_p, last_seen_p + 300] ∩ [start, end]| / 3600
                  (interval union; pods of w; 0 when Q9/Q10 are missing → then
                   hours = Σ_p s.memory_samples·300/3600 / max(replicas,1), capped at D·24)
cpu_coverage    = min(1, Σ_p s.cpu_samples    / Σ_p s.running)   (None if Σ running = 0)
memory_coverage = min(1, Σ_p s.memory_samples / Σ_p s.running)
cpu_samples     = Σ_p s.cpu_samples,  memory_samples = Σ_p s.memory_samples
pods            = |P|
duty            = Σ_p s.running · 300 / (end − start)            (average running pods)
throttle_ratio  = Σ_p throttled / Σ_p periods   if Σ_p periods ≥ 600, else None
oom_killed      = ∃p: s.oom > 0
partial         = w's namespace was in a partial batch
identity        = owner-metrics | name-match | ambiguous
```

The same `observed_hours` applies to every container of `w`.

**Workload level:**
- `pods`: pod names, sorted, at most 50, with `pods_truncated`.
- `hpa`: `HpaInfo` from the live HPA whose `spec.scaleTargetRef` is `(w.kind, w.name)` in
  the same namespace. It carries the name, min / max replicas and its resource metrics
  (`cpu` / `memory` with an optional target utilization in %).

### 6.6 Strategy `workload-history` (`rightsizing/workload_history.rs`)

**Defaults:**

| Setting | Default |
|---|---|
| `cpu_headroom_percent` | 20 |
| `memory_headroom_percent` | 20 |
| `min_cpu_millicores` | 10 |
| `min_memory_bytes` | 32 MiB |
| `days` | 7 |
| `min_hours` | 24 |
| `min_coverage` | 0.9 |
| `throttle_threshold_percent` | 5 |

`memory_limit_headroom_percent` is not used by this strategy.

**Formulas.** Here `u` is the usage, `e` the evidence, `s` the settings and `cur` the
current values. CPU is in millicores and memory in bytes.

```
no usage      → recommended = {} (unchanged), confidence low, warning no-usage
cpu_raw       = max(s.min_cpu, u.cpu_p95 × (1 + s.cpu_headroom/100))
cpu           = ceil(cpu_raw − 1e-9)                                    (whole millicores)
mem_base      = u.memory_max
if e.oom_killed and cur.memory_limit = L:  mem_base = max(mem_base, L)  (OOM floor)
mem_raw       = max(s.min_memory, mem_base × (1 + s.memory_headroom/100))
memory        = ceil(mem_raw / MiB − 1e-9) × MiB                        (whole MiB)
cpu           = settle(cur.cpu_request,    cpu,    10 m,   u.cpu_p95)   (no churn)
memory        = settle(cur.memory_request, memory, 16 MiB, mem_base)
recommended   = {cpu_request: cpu, memory_request: memory}              (limits left to finalize)
confidence    = metrics-server → low (+ metrics-server-only)
                hours ≥ 72     → high
                otherwise      → medium (+ short-history)
```

- `settle` keeps the current value unless the change is at least 10 % **and** at least
  10 m / 16 MiB, or the current value is below the observed peak. This matches KubeFit's
  "OK within 10 %" band and stops hourly churn.
- KubeFit fixture check: 0.1 cores and 100 MiB against a current request of 1 core /
  256 MiB give **120 m** and **120 MiB**.

### 6.7 Shared evidence step (`strategy::apply_evidence`)

This step runs after every strategy and before `finalize`. It only adds warnings and caps
the confidence, never changes values. The final confidence is the minimum of the
strategy's confidence and every cap that applies.

| Condition | Warning code | Cap |
|---|---|---|
| `e.identity = ambiguous` | `identity-unclear` | low |
| `e.observed_hours < s.min_hours` | `insufficient-history` (detail: hours) | low |
| `cpu_coverage` or `memory_coverage` < `s.min_coverage` | `low-coverage` (detail: %) | low |
| `e.partial` | `partial-data` | medium |
| `hpa` set | `hpa-target` (detail: HPA name) | medium |
| HPA scales on a Utilization target of a resource whose request changes | `hpa-utilization` (detail: `cpu 70%`) | medium |
| `e.oom_killed` | `oom-killed` | medium |
| `throttle_ratio ≥ s.throttle_threshold_percent / 100` | `cpu-throttled` (detail: %) | medium |
| `e.identity = name-match` | `identity-by-name` | medium |

`finalize` then adds `cpu-limit-raised` / `memory-limit-raised`. These do not cap the
confidence, but they block one-click apply (§8).

Warning codes are stable kebab-case strings that the UI translates. The existing
`no-usage`, `short-history`, `metrics-server-only`, `memory-near-limit` and `cpu-bursts`
keep their meaning.

### 6.8 Limits

`strategy::finalize` is unchanged (user decision 4). When a new request exceeds the
current limit:

```
limit' = round_up(request × max(1, cur_limit / cur_request))
```

A missing current request makes the ratio 1. The raise is flagged `*_limit_raised`, and
`patch::validate` refuses request > limit.

KubeFit's test "a request above the limit becomes `?`" becomes: 2 cores × 1.2 against a
1-core request and a 1-core limit → request 2400 m, limit 2400 m, `cpu_limit_raised`.

### 6.9 Verdict, lenses, summary

**Verdict.** `math::verdict` is unchanged, plus one rule: any container with the
`oom-killed` warning makes the workload `under`.

**Workload fields:**
- `confidence` = the weakest confidence of the containers that have usage (existing
  rule).
- `cost_replicas` = `replicas`, or for CronJobs the maximum `duty` over the containers
  (1.0 without evidence).
- `monthly_*` use `cost_replicas`.

**Lenses** (`WorkloadRecommendation.lenses`, computed in Rust, KubeFit semantics):

| Lens | Rule |
|---|---|
| `cpu-reduction` | any container with `cpu = decrease` |
| `memory-reduction` | any container with `memory = decrease` |
| `increase` | any container with `cpu` or `memory` = `increase` / `set` |
| `request-unset` | any template container with no current CPU or memory request |
| `missing-data` | verdict `no-data`, or any template container without usage |
| `needs-review` | changed and confidence ≠ high |
| `limit-raised` | any `*_limit_raised` |

**Summary** (`RecommendationSummary`, per successful run):
- counts by verdict, confidence and changed;
- `one_click`: high-confidence changed workloads with no raised limit;
- CPU and memory totals: Σ current and Σ recommended requests × `cost_replicas` over
  comparable containers, plus the number of containers with an unset request;
- monthly current, savings and increases in the report currency;
- `top`: at most 5 under-provisioned workloads (confidence ≥ medium) by `risk_score`,
  then at most 5 over-provisioned high-confidence workloads by savings.

`risk_score(rec)`, the largest value over its containers:

| Case | Score |
|---|---|
| container has `oom-killed` | `+∞` |
| otherwise | `max(memory_max / memory_request, cpu_p95 / cpu_request)`, where a missing request counts as 2 |

Ties are broken by namespace, then name (deterministic, unlike KubeFit's hash order).

### 6.10 Strategy resolution and fallbacks

- **Explicit strategy.** `request.strategy = Some(id)` or
  `Settings.recommendations.strategy = Some(id)` → that strategy.
- **Automatic** (`None`):
  - `workload-history` when the collection resolved at least one pod through owner
    metrics;
  - otherwise `percentile-headroom`.
  - `RightsizingReport.strategy_auto = true`.
- **Settings:** the request's own settings, else
  `Settings.recommendations.overrides[id]`, else `strategy.info().defaults`, always
  normalized.
- **Sources**, in order:
  - Prometheus: evidence available;
  - metrics-server: the last hour, per the existing `metrics_server_usage`, evidence
    `None`, always low confidence;
  - none: a scan with source `none` is recorded as **failed** (`no-usage-source`), and the
    last good result stays.

### 6.11 Usage history for charts (on demand)

Command `recommendations_usage_history(cluster, workload, container, pods, days)`:

- Range queries over `[end − D·86400, end]`.
- Step: `range::auto_step`, which gives 1 h for 7 days.
- `SEL_C` = `container!="",container!="POD",namespace="<ns>",container="<c>"`, plus
  `pod=~"<names>"` when the UI passes the row's (non-truncated) pod list, else
  `pod=~"<workload_pod_regex>"`.

| Series | PromQL |
|---|---|
| CPU peak | `max(max_over_time((rate(container_cpu_usage_seconds_total{SEL_C}[5m]))[{step}s:5m])) * 1000` |
| CPU average | `avg(avg_over_time((max by (pod) (rate(container_cpu_usage_seconds_total{SEL_C}[5m])))[{step}s:5m])) * 1000` |
| Memory peak | `max(max_over_time(container_memory_working_set_bytes{SEL_C}[{step}s]))` |
| Memory average | `avg(max by (pod) (avg_over_time(container_memory_working_set_bytes{SEL_C}[{step}s])))` |

Gaps stay gaps: `TimeSeriesChart` breaks lines after 2.5 intervals. This matches
KubeFit's rule that gaps are never zero (behaviour 5).

## 7. Windows and thresholds

| Name | Default | Range | Where |
|---|---|---|---|
| History window `days` | 7 | 1–30 | `RightsizingSettings.days` |
| Subquery resolution | 5 m | fixed | Q1–Q10 |
| Window end alignment | 300 s | fixed | `time=` parameter |
| `min_hours` (insufficient history) | 24 | 1–720, ≤ days × 24 | settings |
| High-confidence history | 72 h | fixed | strategies |
| `min_coverage` | 0.9 | 0.1–1 | settings |
| CPU / memory headroom (`workload-history`) | 20 % / 20 % | 0–300 % | settings |
| CPU / memory headroom (`percentile-headroom`) | 15 % / 20 %, memory limit 40 % | 0–300 % | settings (existing) |
| Minimum CPU / memory request | 10 m / 32 MiB | ≥ 0 | settings |
| Rounding (`workload-history`) | up to 1 m / 1 MiB | fixed | strategy |
| No-churn band | < 10 % or < 10 m / 16 MiB | fixed | `math::settle` |
| Throttling threshold | 5 %, ≥ 600 periods | 1–50 % | settings |
| Scan interval | 60 min | 15–1440 min | `Settings.recommendations.interval_minutes` |
| First scan after connect (when due) | 120 s + 0–60 s jitter | fixed | scheduler |
| Manual scan rate limit | 60 s per cluster | fixed | scheduler |
| Concurrent scans | 1 per cluster, 2 overall | fixed | scheduler |
| Queries in flight / timeout / series cap / batch budget | 4 / 60 s / 50,000 / 32 | fixed | collection |
| Scan timeout | 20 min | fixed | runner |
| Run retention | 30 days | 1–90 | `Settings.recommendations.retention_days` |
| Rows kept | all runs < 48 h, then the last successful run per UTC day, and the latest run always | fixed | prune |
| Pod names stored per workload | 50 | fixed | evidence |

## 8. Confidence model and apply rules

| Confidence | Meaning | Apply |
|---|---|---|
| **High** | Prometheus with owner metrics, ≥ 72 h observed, coverage ≥ `min_coverage`, and no cap from §6.7 | One-click "Apply" when **also** no limit is raised, the cluster is not `production`, not `read_only`, and the RBAC `rightsize` gate passes. It runs a silent server-side dry run, applies only if that dry run succeeds, and shows a toast. Any failure opens the review dialog |
| **Medium** | Usable, but a risk flag applies (HPA, OOM, throttling, partial data, name matching, < 72 h) | Review dialog (dry-run diff). "Apply" stays disabled until the user ticks "I reviewed: {flags}" |
| **Low** | Too little or unreliable data (metrics-server, < `min_hours`, low coverage, unclear identity) | Same as medium; the flags are listed first |

- **Batch apply** covers only one-click-eligible selected rows. It dry-runs each one in
  turn, shows the per-workload result, then applies the ones whose dry run succeeded.
- **Production clusters** always use the dialog with the typed-name confirmation
  (existing rule).
- **Read-only clusters** allow the review; apply is refused in the backend
  (`ensure_writable`).

## 9. UX

All UI follows the RunHQ design:
- tokens from `theme.css` and primitives from `components/ui/`;
- 11–13 px text, uppercase tracked labels, `bg-fg/N` hover pads, the accent strip on
  active rows;
- `@container` layouts;
- SVG charts only, through `TimeSeriesChart`, `MultiSeriesChart`, `Sparkline` and
  `charts.tsx` (`Card`, `StatTile`, `SegmentBar`, `Legend`).

### 9.1 The Recommendations view (`@recommendations`)

A Cluster-section nav item next to Cost, with the palette keywords
"recommendations right-sizing rightsizing requests kubefit krr".

**Header:**
- title and namespace scope;
- source badge ("Prometheus · 7 days" / "metrics-server · last hour");
- strategy ("Workload history (automatic)");
- scan state:
  - last scan age;
  - progress bar "{completed}/{total} queries" while scanning;
  - "Last scan failed: … Showing results from {time}";
- **Scan now** (disabled while scanning, rate-limited, or disconnected);
- **Scan hourly** switch (per cluster) with the interval;
- run picker (the successful runs of the retention window; a past run is read-only);
- Settings, and Export (JSON / YAML).

**Notes:**
- stale (disconnected, or older than 2 × the interval);
- source changed (results hidden, "Scan now");
- `strategy_auto` fallback ("kube-state-metrics not found: pods are matched by name");
- partial or failed namespaces;
- budget exceeded.

**Body, top to bottom** (container queries collapse the grids to one column):

1. **Optimization summary.**
   - For CPU and memory:
     - Now → After;
     - the difference with its direction and %;
     - "comparable n/N containers, k without requests".
   - The honest footnote: requests × current replicas; "not freed node capacity" (from
     KubeFit).
   - Two tiles: **Attention** (under-provisioned; a click sets the filter) and
     **Inventory** (workloads · containers · namespaces).
2. **Capacity overview.**
   - A CPU / memory toggle (`aria-pressed`).
   - The top 5 namespaces by current requests.
   - Paired SVG bars: current vs recommended, scaled to the largest of the five.
   - "n/N comparable".
   - A click filters the list by that namespace.
3. **Review spotlight.**
   - The three highest-risk under-provisioned workloads, then the three largest
     high-confidence savings (`risk_score`, deterministic).
   - Each shows its change cells and a "Review" button.
4. **Usage ranking.**
   - Toggles: memory (default) / CPU and average (default) / peak.
   - Workload and container rows, 8 per page.
   - Zeros are kept, missing values are dropped and listed as "Usage data available for
     n/N containers."
   - Ties are broken by key.
5. **Recommendations list.**
   - Lens chips with counts (§6.9).
   - Verdict tabs: With changes / Over / Under / All.
   - Search over kind, namespace, name and container.
   - Sort by: priority (under by risk, then savings), monthly delta, CPU reduction
     (millicores × replicas), memory reduction, confidence, name.
   - Checkbox selection with a selection bar:
     - "Apply {n} high-confidence";
     - "Export selected".
   - Each row shows:
     - kind, name and namespace;
     - verdict and confidence badges;
     - flag chips (translated, with the detail as a tooltip);
     - per-container CPU / memory change cells and `RaisedTag ×ratio`;
     - the monthly delta;
     - "Apply" (one-click) or "Review & apply".
   - Rows applied in this session show "Applied, updated at the next scan".
6. **Detail drawer**, docked beside the list; it becomes an overlay below `@3xl`. Tabs:
   - **Changes:** the resource change diff (`ContainerChanges`: request / limit current
     → recommended, Increase / Decrease / New value / Unchanged, raised limits with their
     ratio), and per container: coverage %, samples, observed hours, pods, throttle %,
     OOM, the HPA note, and every flag explained.
   - **Usage:** per container, CPU and memory charts. The average is the area, the peak
     a line, and dashed reference lines show the current request, the recommendation and
     the current limit. Header: the scan window, the step, and "How to read these
     measurements" (KubeFit's three paragraphs, reworded). Only while connected with
     Prometheus, else a note.
   - **History:** how the recommendation moved across stored scans
     (`MultiSeriesChart`): current request, recommended request, CPU p95 / memory max per
     scan (hourly for 48 h, then daily).
   - **YAML:** the fragment (§10.5), copy and save.
   - The drawer header links to the workload's details.

### 9.2 Elsewhere

- **Cost view.** The Right-sizing tab becomes a card with:
  - the potential saving, over / under counts and scan age from the latest scan;
  - "Open recommendations".

  `RightsizingPanel.tsx` is removed; its settings card moves to the Recommendations view.
- **Workload details** (Deployment, StatefulSet, DaemonSet, **CronJob**). The
  `RightsizingSection` shows:
  - the latest stored row ("from the scan {age}") when there is one, else the live report;
  - flags and confidence;
  - a sparkline of the recommended request across scans;
  - "Review & apply" or "Apply", and "Open in Recommendations".
- **Health.**
  - `workload-overprovisioned` and `workload-underprovisioned` read the latest stored
    scan (else the live report).
  - New rule `workload-cpu-throttled`: warning, efficiency category, throttle ratio ≥ the
    threshold with confidence ≥ medium. Hint: "Raise or remove the CPU limit; the
    request stays as recommended."
- **Dashboard.** A `RecommendationsFleetCard` shows every cluster that has a stored scan:
  - scan age with a stale badge;
  - potential saving (per currency), under-provisioned count, one-click count;
  - "Top across the fleet": the merged `summary.top`, by monthly delta.

  It works for disconnected clusters from `history.db`. A row opens that cluster's view.
- **Settings → History:**
  - a Recommendations block: retention, the per-cluster "scan hourly" list, the interval;
  - the alerts toggle (optional phase);
  - "Clear recommendation history";
  - the table's size.
- **Alerts** (optional task, default off).
  - New reason `RightsizingSaving`. It fires when a successful scan finds a
    high-confidence over-provisioned workload whose savings are ≥ 50 % of its monthly
    requests and whose container drops by ≥ 250 m or ≥ 512 MiB (the Health `over`
    threshold), and that workload was not flagged so in the previous successful run.
  - It honours the alert filters, mutes and snoozes.

### 9.3 Copy and terminology

- English source strings; Turkish follows Kubepit's catalogs:
  - request → "istek", limit → "sınır", throttling → "kısıtlama", confidence → "güven";
  - recommendation → "öneri", scan → "tarama", coverage → "kapsam", headroom → "pay";
  - right-sizing → "doğru boyutlandırma";
  - "container" stays English with a straight apostrophe (`container'ı`).
- KubeFit's TR copy is reused where it fits these terms (analysis §4.3). Examples:
  - "Totals are per container…" → "…Boşalacak node kapasitesi değildir.";
  - the three "How to read" paragraphs.
- Kubernetes data, kinds used as identifiers, YAML (including the fragment's comments),
  PromQL and pod names are never translated.
- Flag details are data: percentages, HPA names, hours.

## 10. Contract and data changes

`types/index.ts` and `lib/ipc.ts` change together with the serde structs. Snake_case
fields cross verbatim.

### 10.1 Changed types

- `RightsizingSettings` gains:
  - `min_hours: number` (24);
  - `min_coverage: number` (0.9);
  - `throttle_threshold_percent: number` (5).

  `normalized()` clamps them per §7.
- `RightsizingRequest.settings` becomes optional (`None` = effective settings).
- `RightsizingStrategyInfo` gains:
  - `defaults: RightsizingSettings`;
  - `settings_keys: string[]`, the settings the strategy reads, so the UI renders only
    those fields.
- `UsageStats` gains `cpu_avg: number | null` and `memory_avg: number | null`.
- `ContainerRecommendation` gains `evidence: UsageEvidence | null`.
- `WorkloadRecommendation` gains:
  - `pods: string[]` and `pods_truncated: boolean`;
  - `hpa: HpaInfo | null`;
  - `lenses: RecommendationLens[]`;
  - `cost_replicas: number`.
- `RightsizingReport` gains:
  - `strategy_auto: boolean`;
  - `window_end: number` (ms);
  - more `RightsizingNoteKind` values: `ownership-unavailable`, `partial-data`,
    `namespace-failed`, `query-budget-exceeded`, `hpa-unavailable`.
- `patch::template_path("CronJob")` = `spec.jobTemplate.spec.template.spec`.
  `WorkloadRef.kind` accepts `CronJob`.
- `HistoryKind` gains `recommendations`.
- `HistoryStatus` gains `recommendations: HistoryTableStatus`.
- `Settings` gains `recommendations: RecommendationSettings`.

### 10.2 New types

```ts
interface UsageEvidence {
  observed_hours: number;
  cpu_coverage: number | null;      memory_coverage: number | null;
  cpu_samples: number;              memory_samples: number;
  pods: number;                     duty: number | null;
  throttle_ratio: number | null;    oom_killed: boolean;
  partial: boolean;                 identity: 'owner-metrics' | 'name-match' | 'ambiguous';
}
interface HpaInfo { name: string; min_replicas: number | null; max_replicas: number;
  metrics: { resource: 'cpu' | 'memory' | 'other'; target_utilization: number | null }[] }
type RecommendationLens = 'cpu-reduction' | 'memory-reduction' | 'increase' | 'request-unset'
  | 'missing-data' | 'needs-review' | 'limit-raised';
interface RecommendationSettings {
  scan_clusters: ClusterId[];       interval_minutes: number;   // 60 (15–1440)
  retention_days: number;           // 30 (1–90)
  strategy: string | null;          // null = automatic
  overrides: Record<string, RightsizingSettings>;
  alerts: boolean;                  // false
}
type ScanState = 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'interrupted';
type ScanTrigger = 'manual' | 'schedule';
interface RecommendationScanStatus {
  cluster_id: ClusterId; scheduled: boolean; interval_minutes: number;
  state: ScanState; run_id: number | null; trigger: ScanTrigger | null;
  progress: { completed: number; total: number; workloads: number } | null;
  started_at: number | null; finished_at: number | null; error: string | null;
  last_success_at: number | null; next_at: number | null; manual_available_at: number | null;
}
interface RecommendationRun {
  id: number; cluster_id: ClusterId; started_at: number; finished_at: number | null;
  status: 'running' | 'success' | 'failed' | 'interrupted'; trigger: ScanTrigger;
  error: string | null; source: RightsizingSource | null; strategy: string | null;
  window_secs: number | null; workloads: number; rows_kept: boolean;
  summary: RecommendationSummary | null;
}
interface ResourceTotals { current: number; recommended: number; comparable: number; unset: number }
interface SummaryEntry { kind: string; namespace: string; name: string;
  verdict: RightsizingVerdict; confidence: RightsizingConfidence; monthly_delta: number;
  cpu_delta: number; memory_delta: number }
interface RecommendationSummary {
  workloads: number; containers: number; namespaces: number;
  over: number; under: number; balanced: number; no_data: number;
  high: number; medium: number; low: number; changed: number; one_click: number;
  cpu: ResourceTotals; memory: ResourceTotals;
  monthly_current: number; monthly_savings: number; monthly_increases: number;
  currency: string; top: SummaryEntry[];
}
interface RecommendationLatest {
  scan: { run: RecommendationRun; report: RightsizingReport; reevaluated: boolean;
          days_changed: boolean } | null;
  source_changed: boolean;
  last_failure: RecommendationRun | null;   // newer than scan.run, not successful
}
interface RecommendationTrendPoint { run_id: number; at: number;
  verdict: RightsizingVerdict; confidence: RightsizingConfidence; monthly_delta: number;
  containers: { name: string; cpu_request: number | null; cpu_recommended: number | null;
    memory_request: number | null; memory_recommended: number | null;
    cpu_p95: number | null; memory_max: number | null }[] }
interface WorkloadUsageHistory { start: number; end: number; step_secs: number;
  pod_filter: 'names' | 'pattern'; cpu_avg: PromPoint[]; cpu_peak: PromPoint[];
  memory_avg: PromPoint[]; memory_peak: PromPoint[]; warnings: string[] }
interface ClusterRecommendationSummary { cluster_id: ClusterId; scheduled: boolean;
  source_changed: boolean; run: RecommendationRun | null }
type RecommendationExportFormat = 'json' | 'yaml';
```

### 10.3 Commands

These are read-only for the cluster: queries go through the service proxy, and lists are
lists. Apply keeps using `rightsizing_apply`, which is audited and honours `read_only`.

| Command | Arguments → result |
|---|---|
| `recommendations_status` | `clusterId` → `RecommendationScanStatus` |
| `recommendations_scan` | `clusterId` → `RecommendationScanStatus`. Manual "Scan now"; the cluster must be connected; rate-limited |
| `recommendations_latest` | `clusterId, runId: number \| null` → `RecommendationLatest` (re-evaluated with the current strategy and settings) |
| `recommendations_runs` | `clusterId, limit` → `RecommendationRun[]`, newest first, ≤ 500 |
| `recommendations_trend` | `clusterId, workload: WorkloadRef` → `RecommendationTrendPoint[]` (runs whose rows are kept) |
| `recommendations_usage_history` | `clusterId, workload, container, pods: string[], days: number \| null` → `WorkloadUsageHistory` |
| `recommendations_fleet` | → `ClusterRecommendationSummary[]` (every registered cluster; no cluster access) |
| `recommendations_export` | `clusterId, runId: number \| null, workloads: WorkloadRef[], format` → `string` (empty `workloads` = every workload) |
| `history_clear` | also accepts `kind: 'recommendations'` |

**Event:** `recommendations://scan` carries a `RecommendationScanStatus`. It is emitted at
state changes and at most every 250 ms while progressing.

### 10.4 Settings flow

- `settings_set` normalizes `recommendations`:
  - clamps the numbers;
  - sorts and dedupes `scan_clusters`;
  - drops blank strategy ids;
  - normalizes every override.
- It then calls `sync_recommendation_scans`, which starts or stops per-cluster
  schedulers.
- The UI's settings card writes `overrides[resolved strategy id]`. "Defaults" removes the
  override.

### 10.5 Exports (Rust, locale-invariant)

**JSON:**

```json
{"format":"kubepit.recommendations/v1","cluster":"<cluster display name>",
 "scanned_at":"<RFC 3339>","source":"prometheus","window_secs":604800,
 "strategy":"workload-history","settings":{…},"currency":"USD","workloads":[WorkloadRecommendation…]}
```

It carries no kubeconfig, server URL, Prometheus service, Secret reference, tenant or
label selector.

**YAML:** one fragment per **changed** container, separated by a blank line. Values use
`patch::format_cpu` / `patch::format_memory`. The comments are fixed English:

```yaml
# Deployment shop/web · container app
# Resource fragment, not a complete manifest. Values are rounded up.
resources:
  requests:
    cpu: "1200m"
    memory: "120Mi"
  limits:
    cpu: "2400m"      # raised with the request (limit ÷ request ×2)
    memory: "256Mi"
```

- The resulting `resources` block is complete: recommended values where they change,
  current values where they stay, unset fields omitted.
- With no changed container, the output is `# No changes to export.`.
- KubeFit cases that must keep passing:
  - 402653184 B → `384Mi`; 1073741824 B → `1Gi`; 384 MiB + 1 B → `385Mi`; 2 GiB → `2Gi`;
  - 0.35 cores → `350m`;
  - never a fractional millicore.
  - Kubepit's formatter prints `0` for zero bytes (KubeFit printed `0Mi`); both are valid.

## 11. Storage and retention

`history.db` migration **2** (appended to `MIGRATIONS`; the SQL lives in
`history/recommendations.rs`):

```sql
CREATE TABLE rec_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id    TEXT    NOT NULL,
    started       INTEGER NOT NULL,
    finished      INTEGER,
    status        TEXT    NOT NULL,            -- running | success | failed | interrupted
    trigger       TEXT    NOT NULL,            -- manual | schedule
    error         TEXT,                        -- message or code (app-restarted, stopped, no-usage-source)
    source        TEXT,                        -- prometheus | metrics-server | none
    strategy      TEXT,
    source_config TEXT    NOT NULL,            -- canonical JSON of ClusterDef.prometheus (+ access in phase 7)
    settings      TEXT,                        -- RightsizingSettings used (JSON)
    window_start  INTEGER,
    window_end    INTEGER,
    workloads     INTEGER NOT NULL DEFAULT 0,
    summary       TEXT,                        -- RecommendationSummary (JSON, success only)
    report        TEXT,                        -- RightsizingReport without workloads (JSON)
    rows_kept     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX rec_runs_cluster ON rec_runs (cluster_id, started DESC);
CREATE INDEX rec_runs_status ON rec_runs (status);

CREATE TABLE rec_rows (
    run_id        INTEGER NOT NULL REFERENCES rec_runs (id) ON DELETE CASCADE,
    cluster_id    TEXT    NOT NULL,
    key           TEXT    NOT NULL,            -- kind/namespace/name
    namespace     TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    verdict       TEXT    NOT NULL,
    confidence    TEXT    NOT NULL,
    changed       INTEGER NOT NULL,
    monthly_delta REAL    NOT NULL,
    row           TEXT    NOT NULL,            -- WorkloadRecommendation (JSON)
    PRIMARY KEY (run_id, key)
);
CREATE INDEX rec_rows_trend ON rec_rows (cluster_id, key, run_id);

CREATE TABLE rec_latest (
    cluster_id    TEXT PRIMARY KEY,
    run_id        INTEGER NOT NULL REFERENCES rec_runs (id),
    source_config TEXT    NOT NULL
);
```

**Writes.** They go through the history writer thread as **blocking control operations**
(`send_blocking` from the blocking pool), never as droppable data writes:
- `ScanBegin` inserts a `running` run and returns its id.
- `ScanFinish` runs in **one transaction**:
  - on success: insert the rows, update the run (status, finished, summary, report,
    workloads, `rows_kept = 1`), and upsert `rec_latest`;
  - on failure or interruption: update the run only. **The latest pointer moves only on
    success** (keep the last good result).
- A scan whose future is dropped (abort) submits `ScanFinish(interrupted, "stopped")` from
  a drop guard.
- When the writer starts, `UPDATE rec_runs SET status='interrupted', error='app-restarted',
  finished=now WHERE status='running'`.

**Reads.** They use the reader connection:
- latest: compare `rec_latest.source_config` with the current one; a mismatch sets
  `source_changed` and returns no scan;
- a run with its rows;
- runs, trend and fleet.

**Retention.** It runs with the existing prune (every 10 minutes and after a settings
change):

1. Delete runs with `started < now − retention_days`, except the runs referenced by
   `rec_latest`. Rows cascade.
2. Thinning: for successful runs with `rows_kept = 1` and `finished < now − 48 h` that are
   neither the latest nor the last successful run of their UTC day (per cluster), delete
   the rows and set `rows_kept = 0`. The run and its summary stay, so run history and
   summaries cover the whole retention window.
3. Size cap (`max_size_mb`, shared):
   - after events and changes run out, delete the rows of the oldest `rows_kept` runs
     (never the latest), 10 % at a time;
   - only then the audit log.

**Clear.** `HistoryKind::Recommendations`, optionally for one cluster, deletes
`rec_latest`, then `rec_runs` (rows cascade). Removing a cluster clears its
recommendation history.

**Size estimate:** 2,000 workloads × about 800 B per row × (48 + 30) kept runs ≈ 125 MB
worst case. A typical 300-workload cluster uses about 20 MB.

## 12. Background scan lifecycle

**States per cluster** (`RecommendationScanStatus.state`):

```
idle ─(due or Scan now)─► queued ─(global semaphore 2 acquired)─► running ─► success | failed
                                                                       └─(abort)─► interrupted
```

- **Opt-in per process.**
  - `Kubepit::set_recommendation_scans(true)` in `src-tauri/src/setup.rs`.
  - When it is off, no scheduler runs. Manual `recommendations_scan` still works, so tests
    can drive a scan explicitly.
- **Opt-in per cluster.** `Settings.recommendations.scan_clusters`.
- **Start.** After a successful connect (`connection.rs`, next to
  `start_history_persistence`), if the process and the cluster opted in.
- **Stop.** Everything that stops cluster work stops the scheduler and aborts a running
  scan (`stop_cluster_work`): disconnect, removal, opt-out, shutdown.
- **Due time** (a pure function):

  ```
  due = max(connected_at + 120 s + jitter[0,60 s], last_attempt_end + interval)
  ```

  `last_attempt_end` is the `finished` (else `started`) of the cluster's newest run of any
  status. Failures wait a full interval, so there is no hot retry.
- **Waiting.** The scheduler sleeps in slices of at most 60 s and recomputes against the
  wall clock. After laptop sleep, missed ticks collapse into one scan when it wakes.
- **One scan at a time per cluster.**
  - "Scan now" during a running scan returns the running status.
  - Manual scans are refused within 60 s of the last manual scan
    (`manual_available_at`).
- **Progress.**
  - `total` = 16 × planned batches; it grows when a batch splits.
  - `completed` counts answered queries.
  - `workloads` counts live workloads in scope.
- **Only while connected.** Scans use `pool.connected_client` and never connect on their
  own. Disconnected clusters show their last stored run, marked stale.
- **Source change.** When `ClusterDef.prometheus` (or its access settings) changes, the
  next due time becomes "now + 120 s".

## 13. Security

- **Read-only by construction.** Scans issue GETs through the service proxy and list
  workloads and HPAs; the user's RBAC applies (`services/proxy`, `list`). Read-only
  clusters are scanned. Apply stays `rightsizing_apply`:
  - audited (`history/audited.rs`);
  - dry-run first;
  - refused by `ensure_writable` on read-only clusters;
  - typed confirmation on production.
- **Nothing sensitive is stored.** Rows hold workload names, pod names, resource values,
  statistics, flag details and HPA names. `history.db` stays local with mode 0600.
- **PromQL injection.** Namespace, pod and container values reach PromQL only through
  `quote()` and `regex_escape()`. Pod names passed by the UI to
  `recommendations_usage_history` are validated as DNS-1123 subdomains (≤ 253
  characters, at most 50 of them).
- **Exports** carry no connection metadata (§10.5).
- **Load.** Background work is opt-in and bounded (§6.3, §7). It never auto-connects.
- **Phase 7:**
  - Secret values are read on demand (`get secrets`, the user's RBAC) and kept in memory
    only while a tunnel exists (at most 5 minutes cached).
  - They are never logged, persisted, returned to the UI or quoted in errors.
  - Only the Secret *reference* is stored in `clusters.json`.
  - The tunnel is an in-process port-forward stream with no local listener, so other
    local processes cannot use it.
  - The tenant must have no CR / LF and at most 200 characters.
  - Label names must match `^[a-zA-Z_][a-zA-Z0-9_]*$` and must not be reserved.

## 14. Optional phase 7: authenticated and shared Prometheus

Marked optional: drop it if it is overkill (user decision 3).

**Configuration.** `ClusterDef.prometheus_access: PrometheusAccess`, which applies to both
`auto` and `service` modes:

```rust
pub struct PrometheusAccess {
    pub tenant: String,                        // X-Scope-OrgID; "" = none
    pub cluster_labels: BTreeMap<String, String>, // e.g. {"cluster": "prod-eu"}
    pub auth: Option<PrometheusAuth>,
}
pub enum PrometheusAuth {                      // serde tag "type"
    Bearer { namespace: String, secret: String, token_key: String },
    Basic  { namespace: String, secret: String, username_key: String, password_key: String },
}
```

**Validation:**
- label keys: the regex above;
- reserved keys: `__name__`, `namespace`, `pod`, `container`, `resource`, `uid`,
  `owner_name`, `owner_kind`, `job`, `instance`, `replicaset`, `job_name`, `reason`;
- values: non-empty;
- tenant: at most 200 characters, no CR / LF;
- Secret and key names: DNS-1123;
- two clusters that resolve to the same configured service and tenant must have
  **provably disjoint** selectors, i.e. some shared key with different values (KubeFit's
  rule).

**Selector injection.** `promql::with_matchers(query, matchers) -> String` is a small
PromQL lexer that adds `,k="v"` to every vector selector:
- a bare metric name, a `{…}` block, or `{__name__=~…}`.
- It skips:
  - string literals;
  - function names (an identifier followed by `(`);
  - keywords (`by`, `without`, `on`, `ignoring`, `group_left`, `group_right`, `bool`,
    `offset`, `and`, `or`, `unless`, `atan2`);
  - label lists after `by (` / `on (` / `without (` / `ignoring (` / `group_left (` /
    `group_right (`;
  - `[…]` ranges and numbers.

It is applied to **every** Kubepit-built query:
- chart presets (`promql::preset`);
- `usage.rs`, cost estimates and `workload_stats.rs`;
- usage history;
- upgrade readiness' `apiserver_requested_deprecated_apis`.

It is not applied to the detection probe (`query=1`) or to user-typed PromQL in the PromQL
dock tab, which shows the selector as a hint.

**Fail-closed.** Every series of `workload_stats` Q11 must carry each configured label
with the configured value. Otherwise the scan fails with `cluster-label-mismatch`, as in
KubeFit.

**Transport:**
- *No auth:* the service proxy as today, plus `X-Scope-OrgID` when a tenant is set. The
  proxy forwards custom headers; Loki already does this.
- *With auth:* `prometheus/tunnel.rs` opens `pods/portforward` to a ready pod behind the
  service. It reuses `portforward::resolve_target` (made `pub(crate)`), which re-resolves
  per connection and survives restarts. It speaks HTTP/1.1 over the stream (hyper client
  connection) with `Authorization: Bearer …` or `Basic …` and the tenant header.
  - `https` services use TLS over the stream (tokio-rustls) with server name
    `<service>.<namespace>.svc`. The trust comes from `ca: Option<KeyRef>` (a ConfigMap
    or Secret key), else the system roots. There is an explicit `insecure_skip_verify`
    flag, which the editor warns about.
  - hyper, hyper-util, http-body-util, tokio-rustls and rustls are already in kube's
    dependency tree and become direct dependencies (the `http` precedent).
- One transport entry point, `Kubepit::prometheus_get(cluster_id, endpoint, params,
  origin)`, chooses proxy or tunnel, applies the selector for `Origin::Preset`, and keeps
  proxy-failure invalidation.
- The detection cache keys on `(PrometheusConfig, PrometheusAccess)`.

**UI.** In the cluster editor under Prometheus, a collapsible "Shared or secured
Prometheus" section:
- tenant;
- label pairs;
- auth type with the Secret namespace, name and keys;
- CA reference and skip-verify.

Plus the PromQL tab hint.

## 15. Testing strategy

Never touch real clusters or real Prometheus:
- Every test uses fixtures, `KUBEPIT_HOME` or explicit temp `Paths`, and the fake API
  server in `crates/kubepit-core/tests/support`, whose service-proxy routes answer as
  Prometheus.
- History recording and background scans stay off in tests unless a test turns them on.

**Rust unit tests** (next to the code):

| Area | What they pin down |
|---|---|
| `workload_stats` | exact Q1–Q16 strings for a namespace scope, a cluster-wide scope and a pod-regex scope; merging (series without namespace / pod / container ignored; `max by` duplicates keep one value) |
| `ownership` | `<none>` and `owner_is_controller="false"` ignored; RS → Deployment and Job → CronJob; orphan RS, standalone Job and bare pod are `Unowned`; two owners for one pod name is `Ambiguous`; a `Rollout` parent is `Unsupported` |
| `evidence` | KubeFit rollout (`api-old` + `api-new` → one row, 288 CPU samples, coverage 1); StatefulSet UID churn stays one row with identity owner-metrics; interval union; weighted averages; the throttle ratio needs ≥ 600 periods; duty |
| `workload_history` | 0.1 cores / 100 MiB → 120 m / 120 MiB; minimums; whole-millicore / whole-MiB rounding; OOM floor; no churn; confidence tiers |
| `apply_evidence` | every row of the §6.7 table; the cap is the minimum; values are untouched |
| `finalize` | CPU 2 cores × 1.2 over a 1-core limit → 2400 m / 2400 m, `cpu_limit_raised` (replaces KubeFit's `?`) |
| `summary` | lens semantics (KubeFit's `hasReduction` / `needsIncrease` / `hasMissingData` cases mapped to changes); totals include `cost_replicas`; top selection; `risk_score` order |
| `export` | KubeFit YAML cases (`384Mi`, `1Gi`, `385Mi`, `2Gi`, `350m`); raised-limit comment; the JSON carries no connection metadata and is locale-invariant |
| `history/recommendations` | migration 2 on an empty database and on a version-1 database; begin / finish; the latest pointer moves only on success; interrupted sweep; source-config mismatch; thinning; retention keeps the latest; size-cap order; clear per cluster |
| scheduler | the `next_due` table (first connect, jitter bounds, failure waits an interval, wake after sleep); manual rate limit |
| settings | defaults and normalization of `RecommendationSettings` and the new `RightsizingSettings` fields |
| phase 7 | `with_matchers` over every preset string; access validation and disjointness; tunnel request framing over `tokio::io::duplex` (Authorization, tenant, chunked responses) |

**End-to-end** (`crates/kubepit-core/tests/recommendations.rs`, fake API server). These
port KubeFit's `platform.test.mjs` fixture:

- `api-old` / `api-new` → one `Deployment/api` row. The duplicate `instance="duplicate"`
  series do not double. Result: CPU 120 m, memory 120 MiB, coverage 1, pods
  {api-new, api-old}, strategy `workload-history` (automatic). Progress is monotonic and
  ends at `completed == total`.
- Table-driven flags: partial warnings, CPU sample gaps, HPA, OOM, throttling at 10 %,
  unclear identity, and `<none>` owners.
  - Each yields a computed recommendation (never `?`) with the expected flag and
    confidence cap.
  - Gaps give coverage < 0.1 and low confidence.
  - `<none>` gives no bogus row.
- No kube-state-metrics → percentile-headroom (automatic), `identity-by-name`, and the
  `ownership-unavailable` note. The existing `tests/cost.rs` right-sizing test is updated
  to the new queries; its hours become 168 (observed) instead of 84.
- A required-query failure splits the batch; a namespace that still fails is listed.
- Scan lifecycle:
  - a manual scan stores a run and rows;
  - a failing scan keeps the last good result and records the error (the upstream body is
    quoted, shortened, never leaked beyond Prometheus' own message);
  - a source-config change hides the results;
  - `recommendations_latest` re-evaluates after a settings change;
  - trend points accumulate;
  - disconnect during a scan marks it interrupted.
- CronJob: `jobs` → CronJob row; dry-run apply patches
  `spec.jobTemplate.spec.template.spec`; a read-only cluster refuses the real apply and
  allows the dry run.
- Phase 7: every query of a scan carries `cluster="production"`; a label mismatch fails
  the scan; the bearer Secret is read through the fake API server and never appears in
  errors or logs.

**KubeFit tests that are dropped:** HTTP, basic auth, CSRF, Docker, legacy environment
variables, the i18n reverse lookup, TLS direct-URL, and the shadcn tooltip test.

**UI** (no TS test runner in Kubepit):
- The pure view models (`lib/kube/recommendations/model.ts`) are kept small. Logic that
  needs pinning lives in Rust.
- Each UI task ends with `pnpm typecheck`, `pnpm i18n:check`, and a named walkthrough in
  `pnpm dev:ui` against the demo backend (`lib/ipc/mock/recommendations.ts`).
- Demo backend:
  - prod-eu-west-1 has 30 days of seeded scans with drifting recommendations, flags of
    every kind and a CronJob;
  - staging shows metrics-server-only;
  - dev shows a failed last scan with the last good result;
  - kind has no scan yet.

**The six checks** gate every task:
- `pnpm typecheck`
- `pnpm i18n:check`
- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `pnpm dev:ui` keeps working

## 16. Rollout

Each phase merges on its own and leaves every check green.

1. **Engine.**
   - Contract, ownership, queries, folding, evidence step, `workload-history`, the
     pipeline in `rightsizing_report` (automatic default), CronJobs, lenses and summary.
   - Visible in the existing right-sizing UI immediately: new flags, better identity,
     CronJobs.
2. **Storage and export.** Migration 2, writer operations, retention, re-evaluation,
   exports, usage history queries.
3. **Scans.** Settings, runner, scheduler, commands, events, Tauri wiring, demo backend.
4. **UX.** The Recommendations view and its cards, the list, the drawer, apply flows,
   details, Health, Cost card, fleet card, Settings, optional alerts, docs.
5. **Phase 7 (optional).** Access config, selector injection, tunnel, cluster editor.

`docs/ARCHITECTURE.md` gains a "Recommendations" section and updated "Cost insight &
right-sizing", "Persistent history", "Prometheus" and "Health checks" sections, in the
tasks that change them.

## 17. Open questions

1. **VPA.** Should a workload managed by a VPA in `Auto` / `Recreate` /
   `InPlaceOrRecreate` mode block apply, and should its recommendation be shown next to
   ours? (Proposed: a follow-up.)
2. **OOM floor.** Is "never below the current limit + headroom after an OOM kill"
   acceptable for `workload-history`, or should it only flag, as KubeFit did?
3. **Replicas in totals.** Totals multiply by current replicas (CronJobs by duty cycle).
   KubeFit reported per-container totals without replicas. Is the Kubepit framing ("at
   current replica counts, not freed node capacity") right?
4. **Cost tab.** Is replacing the Cost view's Right-sizing tab with a link card
   acceptable, or should both lists coexist?
5. **Thinning.** Hourly rows for 48 h, then daily, for 30 days. Or full hourly rows,
   bounded only by the size cap?
6. **Throttling default.** 5 % of CFS periods over the window. Too strict or too loose
   for your clusters?
7. **Phase 7 over HTTPS.** Is TLS over the tunnel (service DNS name, CA reference or skip
   verify) needed now (OpenShift `thanos-querier`), or is plain HTTP plus bearer enough?
8. **Scan scope.** Scans cover every readable namespace, and the UI filters. Should a
   per-cluster namespace allowlist for scans exist?
