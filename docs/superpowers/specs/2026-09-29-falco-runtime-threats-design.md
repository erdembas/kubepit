# Falco runtime threats: design

- **Date:** 2026-09-29
- **Status:** draft for review
- **Plan:** `docs/superpowers/plans/2026-09-29-falco-runtime-threats.md`
- **Builds on (already on `main`):**
  - the Security view and the one-click Trivy Operator install (`components/workbench/security/`, `b2f8b60`);
  - `api_resources_refresh` and the per-connection discovery cache;
  - merged workload log streaming (`crates/kubepit-core/src/workload_logs.rs`, `WorkloadLogPlanner`);
  - the alert center (`alerts.rs`, `alerts/`), OS notifications and the notification center;
  - the SQLite history database (`history/`, writer thread, retention prune).

## 1. Problem

The Security view answers "what could go wrong": Trivy finds vulnerable images and risky
configuration, and Pod Security Standards show admission levels. It says nothing about
**what is happening right now**: a shell spawned in a production container, `/etc/shadow`
read by an unexpected binary, a new binary dropped and executed, a container escape
attempt. [Falco](https://falco.org) (CNCF graduated) detects exactly these at the kernel
level, but its output lands in the logs of a DaemonSet, one pod per node. In practice
people either never look, or have to wire Falcosidekick to Slack.

Lens and Freelens have nothing here. A Kubernetes IDE that shows runtime threats next to
the workload they happened in, and raises a desktop notification for the dangerous ones,
is a real differentiator.

## 2. Goals

1. **Detect Falco** on a cluster: its pods, namespace, node coverage, output format
   (JSON or text) and whether its output is buffered.
2. **One-click install** of Falco, with the same flow, safety gates and progress UI as the
   Trivy install. The Trivy installer is generalised into an operator installer used by
   both.
3. **Read Falco events** from the Falco pods' logs, parse them (JSON and plain-text output),
   and keep them **locally** in `~/.kubepit/history.db` (default 7 days, capped per cluster).
   On (re)connect, Kubepit backfills from the logs since the last stored event, so events
   that happened while Kubepit was closed come back as long as the node kept the logs.
4. **Runtime threats tab** in the Security view: priority tiles, an hourly histogram, top
   rules and top pods, and a searchable, filterable event list with an event detail drawer.
   Events link to their pod, node and workload.
5. **Notifications**: events at or above a priority threshold raise alerts through the
   existing alert center (dedup, burst grouping, mute, snooze, OS notifications).
6. **Mute rules** per cluster (optionally per namespace): muted events are still stored,
   but hidden by default and never alerted.
7. **Per-object context**: a "Runtime threats" details section on Pods, workloads and
   Nodes, with the latest events for that object.
8. Everything works in `pnpm dev:ui` against the demo backend.

## 3. Non-goals

- Writing or editing Falco rules, or managing Falco's configuration beyond the install
  values. (Linking to the rule's docs is enough.)
- Response actions (killing pods, isolating nodes). Kubepit shows and alerts; the user acts
  with the existing tools.
- Installing Falcosidekick, Falcosidekick UI, Redis, or any PolicyReport CRDs (see D3).
- Kubernetes audit-log detection (`k8saudit` plugin). It needs API server audit
  configuration that Kubepit cannot set up on managed clusters. Events with
  `source: k8saudit` are shown when they appear in the logs, but nothing is done to enable it.
- Alerting while Kubepit is not running. Kubepit is local-first; the backfill (goal 3)
  shows what happened, but a notification can only fire while the app runs.
- Clusters where Falco runs outside Kubernetes (systemd on the nodes).

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Event source = Falco pod logs.** The watcher follows the `falco` container of every pod matching the Falco selector, through the existing `run_workload_logs` driver (pod watch, one follow per container, restarts re-attached, 64-source cap), with timestamps. | It works with every Falco install (Helm chart, manifests, operator) without asking the user to reconfigure anything, and reuses battle-tested streaming code. |
| D2 | **Local store in `history.db`** (`falco_events`, migration = next free number). `INSERT OR IGNORE` on `(cluster_id, id)`. Retention `Settings.falco.retention_days` (default 7, 1–90) plus a per-cluster row cap (default 50 000). Pruned by the existing maintenance loop, in the same tier as events and changes for the size cap. | A persistent, queryable history without any in-cluster storage. It survives app restarts and makes summaries cheap (SQL aggregates). |
| D3 | **No PolicyReport CRDs, no Falcosidekick in the install.** Reading Falcosidekick's `wgpolicyk8s.io/v1alpha2` PolicyReports is an optional phase-2 source, used only when the CRDs already exist. | Falcosidekick's PolicyReport output needs CRDs from `wg-policy-prototypes`. That API group is being deprecated in favour of `openreports.io` (Kyverno 1.15), and installing those CRDs next to Kyverno's reports-server can break the aggregated OpenAPI with duplicate paths. Kubepit must not install third-party CRDs that other tools own. |
| D4 | **Backfill with `since_seconds`.** On start: `since = clamp(now − last_stored + 30 s, 60 s, retention)`, or 1 h when the cluster has no stored events. The IDs already stored since then are loaded into the watcher's seen-set, so the overlap is neither re-emitted nor re-alerted. | Logs usually hold hours to days of Falco output (kubelet rotation, 10 MiB × 5 by default). Old events come back without a second transport. |
| D5 | **Event identity** = Falco's `uuid` when present (Falco ≥ 0.38); otherwise `h:` + 16 hex digits of FNV-1a 64 over `time|hostname|rule|output` (implemented inline, no new dependency). | Stable across restarts and backfills, which dedup relies on. |
| D6 | **Parser accepts JSON and text output.** JSON: `time`, `rule`, `priority`, `output`, optional `message` (with `json_include_message_property`), `output_fields`, `hostname`, `source`, `tags`, optional `uuid`. Text: `HH:MM:SS.nnnnnnnnn: <Priority> <message>` (the kubelet timestamp gives the date; the rule is unknown). Every other line (startup banner, falcoctl output) is ignored; a `Falco version: X` line updates the status. | Many existing installs keep the chart default `json_output: false`. Text still yields priority, message, time and node. The UI suggests JSON when it sees text. |
| D7 | **Kubernetes context from `output_fields`**: `k8s.ns.name`, `k8s.pod.name`, `container.name`, `container.id` (`host` → host event), `container.image.repository` (+ `container.image.tag`), `proc.cmdline`, `user.name`. `<NA>` is treated as missing. | Falco ≥ 0.40 adds these through the container plugin's suggested output fields (`append_output: suggested_output: true`, the default), with no Kubernetes API access needed. |
| D8 | **Opt-in, like every background job.** Per process: `Kubepit::set_falco_watching(true)` in `src-tauri/src/setup.rs`. Per cluster: `Settings.falco.watch_clusters`. Starts after a successful connect, only uses `pool.connected_client`, and stops in `stop_cluster_work`, on removal, on opt-out and on shutdown. A cluster where Falco is not found re-detects every 60 s while the watcher runs, so a later install is picked up. | Follows the change journal, history, metrics and recommendation-scan pattern. Streaming one log per node is real API-server load, so it is never on without consent. The one-click install opts the cluster in. |
| D9 | **Per-cluster source config** `ClusterDef.falco: FalcoConfig`, tagged `mode`: `auto` (default: label `app.kubernetes.io/name=falco`, container `falco`, any namespace) · `pods {namespace, selector, container}` · `off`. Edited in the cluster editor like Loki. | Custom installs (other labels or namespaces, restricted RBAC) need an escape hatch; `off` hides the feature for clusters where it doesn't belong. |
| D10 | **Alerts through the alert center**: a new `AlertReason::RuntimeThreat` (`kind() = None`), raised with `AlertCenter::raise`. `Finding` gains an optional severity override: priority ≥ Critical → `critical`, otherwise `warning`. `condition` = rule name, so the book's 10-minute cooldown and burst grouping apply per pod and rule. Raised only when all hold: the priority ≥ `Settings.falco.alert_priority` (default `warning`), the event is not muted, it is at most 10 minutes old, and alerts are enabled for the cluster. | Reuses dedup, grouping, mute, snooze, OS notifications and the notification center. The age rule keeps a backfill from flooding the user after a reconnect. |
| D11 | **Ingest guard**: a token bucket per watcher (50 events/s sustained, burst 500). Excess events are counted (`FalcoStatus.dropped`) and not stored. UI pushes are batched every 500 ms, at most 200 events per batch (`truncated: true` makes the UI refetch). | A noisy rule can emit thousands of events per second; the IDE must stay responsive and the database bounded. |
| D12 | **Mutes live in settings** (`Settings.falco.mutes: [{cluster_id?, rule, namespace?}]`). They are applied at query time (`include_muted`) and at alert time, never at ingest. | Unmuting shows the history again; nothing is lost. |
| D13 | **Install values**: chart `falcosecurity/falco` (repo `https://falcosecurity.github.io/charts`), release `falco`, namespace `falco`, `wait` + `atomic`, timeout 900 s. Values: `tty: true`, `driver.kind: auto`, `falco.json_output: true`, `falco.json_include_message_property: true` (plus the output/tags/fields properties). Before the install, Kubepit creates the namespace with `pod-security.kubernetes.io/enforce: privileged` through the audited apply when it doesn't exist. If it exists with a stricter enforce level, the install stops with an explanation. | `tty: true` is what the chart README prescribes for unbuffered, real-time log output. The privileged DaemonSet is rejected in namespaces that enforce `baseline`/`restricted`, and Kubepit must not silently relax an existing namespace. |
| D14 | **Generalised operator installer** (`lib/kube/operators/`, `security/operatorInstall.ts`, `OperatorInstallCard`): steps `prepare?` → `repo` → `install` → `verify`, per-operator `verify` (Trivy: discovery; Falco: `falco_status` until found, then opt the cluster in). Same gates: production typed confirm, read-only, RBAC pre-check, helm-missing. Trivy moves onto it unchanged in behaviour. | One tested flow instead of two copies. The next operator (e.g. Kyverno) costs a spec object. |
| D15 | **The view never streams by itself.** The Runtime tab reads the store (`falco_events`, `falco_summary`) and live pushes (`falco://events`). Without the watcher it shows how to start it. | One stream per cluster however many windows are open; the view is cheap to mount. |

## 5. Architecture

```
Falco DaemonSet pods (falco container logs)
        │  pod watch + follow (run_workload_logs, ≤64 sources, timestamps, since=backfill)
        ▼
falco::watcher (per opted-in, connected cluster; TaskRegistry "falco:{cluster}")
        │  falco::parse::parse_line  →  FalcoEvent
        │  seen-set dedup · token bucket · mutes/threshold/age → AlertCenter::raise(RuntimeThreat)
        ├─► history writer: WriteOp::Falco(Vec<FalcoRow>)  → history.db falco_events
        ├─► EventSink::falco_events(batch)   (500 ms, ≤200)  → "falco://events"
        └─► EventSink::falco_status(status)  (on change)     → "falco://status"

UI  Security ▸ Runtime threats ── falco_status / falco_summary / falco_events (reader conn)
    Details ▸ Runtime threats  ── falco_events {pod | pod_prefix | hostname}
    Notification center        ── alerts://new (RuntimeThreat)
    Install card               ── operatorInstall(FALCO): prepare ns → helm repo → helm_install → verify
```

New core module `crates/kubepit-core/src/falco/`: `mod.rs` (lifecycle, commands),
`types.rs`, `parse.rs` (pure), `detect.rs`, `watcher.rs`, `guard.rs` (token bucket, pure).
Storage in `history/falco.rs` (migration SQL, insert, query, summary, prune).

## 6. Parsing (`falco/parse.rs`, pure)

- Input: one log line with the kubelet RFC 3339 timestamp prefix (the watcher requests
  timestamps; `workload_logs::split_timestamp` strips it), plus the emitting pod name.
- JSON when the line starts with `{`. Unknown keys are ignored; a line that fails to parse
  as a Falco object (no `priority` or no `output`/`message`) is not an event.
- `priority` is case-insensitive; `Info` is an alias of `Informational`.
- `message` = the `message` property when present, else `output` with a leading
  `HH:MM:SS.nnnnnnnnn: <Priority> ` removed.
- `time` = the JSON `time` (RFC 3339, nanoseconds) → epoch ms; for text lines, the kubelet
  timestamp.
- `fields` = `output_fields` stringified (numbers and booleans via `to_string`, strings
  verbatim, `<NA>` and nulls dropped), capped at 64 keys and 1 KiB per value.
- `message` is capped at 4 KiB, `command` at 1 KiB, tags at 32.
- Text regex: `^(?:\d{2}:\d{2}:\d{2}\.\d{1,9}: )?(Emergency|Alert|Critical|Error|Warning|Notice|Informational|Info|Debug) (.+)$`.

## 7. Storage (`history/falco.rs`)

```sql
CREATE TABLE falco_events (
    cluster_id TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    time       INTEGER NOT NULL,          -- epoch ms
    priority   INTEGER NOT NULL,          -- 0 debug … 7 emergency
    rule       TEXT,                      -- NULL for text output
    source     TEXT    NOT NULL,
    hostname   TEXT,
    namespace  TEXT,
    pod        TEXT,
    container  TEXT,
    image      TEXT,
    command    TEXT,
    user_name  TEXT,
    message    TEXT    NOT NULL,
    tags       TEXT    NOT NULL,          -- JSON array
    fields     TEXT    NOT NULL,          -- JSON object
    PRIMARY KEY (cluster_id, id)
) WITHOUT ROWID;
CREATE INDEX falco_events_time ON falco_events (cluster_id, time DESC);
CREATE INDEX falco_events_pod  ON falco_events (cluster_id, namespace, pod, time DESC);
CREATE INDEX falco_events_rule ON falco_events (cluster_id, rule, time DESC);
```

- **Writes**: `WriteOp::Falco(Vec<FalcoRow>)`, a droppable data write like `Events`
  (the writer's `dropped` counter covers overload).
- **Reads** (reader connection): `query_events(conn, cluster_id, &FalcoQuery, &mutes)`
  (keyset pagination on `(time, id)`), `summary(conn, cluster_id, &FalcoSummaryQuery,
  &mutes)` (hourly buckets for ranges ≤ 48 h, 6-hour buckets above; top 10 rules and
  pods), `recent_ids(conn, cluster_id, since)`, `last_time(conn, cluster_id)`.
- **Mutes in SQL**: each mute becomes `NOT (rule = ? AND (namespace = ? OR ? IS NULL))`
  (bound parameters, at most 200 mutes).
- **Text search**: `LIKE` with `ESCAPE '\'` on `message`, `command`, `rule`, `pod`.
- **Prune**: `falco_before = now − retention_days`, then the per-cluster cap
  (`DELETE … WHERE rowid-less keyset beyond the newest N`), and falco rows join events and
  changes in the size-cap tier.
- **Clear**: `HistoryKind::Falco`, optionally per cluster; removing a cluster clears it.
- **Size**: about 1 KiB per event, so 50 000 events ≈ 50 MB per cluster at the cap.
  A quiet cluster uses a few hundred KB.

## 8. Watcher lifecycle (`falco/watcher.rs`)

```
connected + process active + cluster opted in + config ≠ off
  └─► detect ── not-found / forbidden ──► status, sleep 60 s, detect again
            └─ found {namespace, selector, container, pods, nodes, buffered}
                 └─► stream (since = backfill) ─► batches ─► parse ─► dedup ─► guard
                        │                                   ├─► store, push, alert
                        └─ ends with error ─► status error, backoff 5 s → 60 s, detect again
stop: disconnect · removal · opt-out · config change · shutdown
```

- **Detection** (`detect.rs`): auto mode lists pods cluster-wide with the label selector
  (`limit=50`). On 403 it tries `falco`, `falco-system`, `kube-system`, `security` and the
  cluster's accessible namespaces. Namespace = the one with the most matching pods.
  `nodes` = the owning DaemonSet's `desiredNumberScheduled` when readable, else the pod
  count. `buffered = Some(!tty)` of the Falco container. Pods mode reads the configured
  namespace only.
- **Status** (`FalcoStatus`) is recomputed on detection, on source added/removed/skipped
  and on stream errors, and pushed only when it changed.
- **Only while connected**: the watcher uses `pool.connected_client` and never connects.

## 9. UX

### 9.1 Security ▸ Runtime threats (new tab, `runtime`)

- **Not found** → `FalcoMissing` (an `OperatorInstallCard`): what Falco is, what the
  install does (privileged DaemonSet on every node, eBPF, namespace `falco` with the
  privileged Pod Security level), buttons *Install Falco* / *Installation guide*, progress
  steps (Prepare namespace → Helm repository → Install chart → Wait for Falco), and the
  manual commands.
- **Forbidden** → explains that Kubepit can't list pods to find Falco and links to the
  cluster settings (pods mode).
- **Off** → one line with a link to the cluster settings.
- **Found, not watching** → `FalcoWatchCard`: "Falco runs on N nodes in namespace X.
  Kubepit can read its events from the pod logs while this cluster is connected and keep
  {days} days of them on this machine." Button *Watch Falco events* (adds the cluster to
  `watch_clusters`).
- **Watching** → `RuntimeOverview`:
  - Toolbar: range (1 h · 24 h · 7 d), minimum priority, *Show muted*, a settings button.
  - Notices (tone-warning strip, only when they apply): output is buffered (`tty: false`),
    text output (no rule names; suggests JSON), streaming N of M nodes (the 64-source cap),
    events dropped during a burst, and the backfill window ("Events since …").
  - Priority tiles (Critical+ · Error · Warning · Notice · Info and debug) with counts for
    the range.
  - Histogram: stacked SVG bars per bucket, drawn with tokens (no chart library).
  - Top rules (count, highest priority, last seen, mute/unmute) and top pods (namespace/pod,
    count; click filters the list, the icon opens the pod).
  - Event list: time, priority chip, rule (or "(text output)"), `namespace/pod ·
    container`, command, node. Keyset *Load more*. Live events matching the filters are
    prepended with a short highlight.
  - Event drawer (`Drawer`): message, rule, priority, time, node, source, tags (MITRE tags
    link to attack.mitre.org), every output field, links to pod/node/workload, *Mute rule*
    (cluster or cluster+namespace), *Copy as JSON*.
- The Security search box filters rule, message, command and pod; the workbench namespace
  selector scopes the list and the summary (host events are shown when all namespaces are
  selected).
- The footer shows Live/Paused and "N events · M nodes".

### 9.2 Elsewhere

- **Details section** "Runtime threats" (Pod: its events; workloads: pods with the
  workload-name prefix, marked approximate; Node: hostname) with the latest 5 events of
  24 h and *Open in Security*. Only while the cluster is watched.
- **Notification center**: `RuntimeThreat` alerts titled "Runtime threat: {rule}" with the
  message as body. Clicking opens Security ▸ Runtime threats filtered to that pod and rule.
- **Settings → Notifications** lists the new reason like the others.
- **Runtime settings dialog** (from the tab): alert threshold, retention days, event cap,
  mutes (with unmute), *Stop watching this cluster*, *Clear stored events of this cluster*.
- **Cluster editor**: `FalcoFields` (Auto / Pods in namespace / Off).

### 9.3 Copy

- Falco priority names are shown translated like Trivy severities (`Critical` → `Kritik`).
  Rule names, messages, output fields, tags, commands and Falco's own words are data and
  are never translated.
- "Runtime threats" / "Çalışma zamanı tehditleri".

## 10. Contract

### 10.1 Types (Rust `falco/types.rs` ⇄ TS `types/index.ts`)

- `FalcoPriority`: `debug | informational | notice | warning | error | critical | alert | emergency`
  (ordered, lowercase on the wire).
- `FalcoEvent {id, cluster_id, time, priority, rule, source, hostname, namespace, pod,
  container, image, command, user, message, tags, fields}`.
- `FalcoConfig` (tag `mode`): `auto` · `pods {namespace, selector, container}` · `off`.
  `ClusterDef.falco` / `ClusterInput.falco`, `#[serde(default)]`.
- `FalcoSettings {watch_clusters, alert_priority, retention_days, max_events, mutes}` in
  `Settings.falco`; `FalcoMute {cluster_id: Option, rule, namespace: Option}`.
- `FalcoStatus {cluster_id, state: off|not-found|forbidden|found|error, watching,
  namespace, selector, container, pods, ready_pods, nodes, streaming, skipped, format:
  unknown|json|text, buffered, version, last_event_at, backfill_since, dropped, error,
  checked_at}`.
- `FalcoQuery {since, until, min_priority, namespaces, pod, pod_prefix, hostname, rules,
  text, include_muted, before: FalcoCursor?, limit}`, `FalcoCursor {time, id}`,
  `FalcoEventPage {events, next}`.
- `FalcoSummaryQuery {since, until, namespaces, include_muted}`, `FalcoSummary {since,
  until, bucket_ms, buckets: [{start, counts}], totals, top_rules: [{rule, count,
  max_priority, last_at, muted}], top_pods: [{namespace, pod, count, max_priority,
  last_at}]}`, `FalcoCounts {critical, error, warning, notice, info}` (critical includes
  alert and emergency; info includes debug).
- `FalcoEventBatch {cluster_id, events, truncated}`.
- `AlertReason` gains `RuntimeThreat`; `HistoryKind` gains `falco`.

### 10.2 Commands (all read-only, listed in `NOT_MUTATING`)

- `falco_status(cluster_id, refresh) -> FalcoStatus`
- `falco_events(cluster_id, query) -> FalcoEventPage`
- `falco_summary(cluster_id, query) -> FalcoSummary`

Opt-in, thresholds and mutes go through the existing `settings_set`; clearing through
`history_clear`; the install through the existing audited `resource_apply_yaml` and
`helm_install`.

### 10.3 Events

`falco://events` (`FalcoEventBatch`) and `falco://status` (`FalcoStatus`), through two new
`EventSink` methods with no-op defaults.

## 11. Security and safety

- **Read-only clusters**: nothing in the watcher mutates. The install is blocked on
  read-only clusters in the UI and refused by the backend (`ensure_writable` in the
  audited apply and helm install).
- **Production**: the install needs the typed confirmation (`falco`), and the message says
  it installs a privileged DaemonSet on every node.
- **RBAC**: the install card pre-checks `create namespaces`, `create daemonsets.apps` and
  `create serviceaccounts` in `falco`; the watcher needs `list/watch pods` and `get
  pods/log` in the Falco namespace and degrades to `forbidden` without them.
- **Audit**: the install is two audited actions (namespace apply, helm install). Reads
  aren't audited, like every other read.
- **Data at rest**: events can contain command lines with secrets. `history.db` is already
  0600 in a 0700 directory. Events never leave the machine. *Clear stored events* and
  cluster removal delete them.
- **No real clusters in tests**: parser fixtures, the fake API server with log streams,
  temp `Paths`, fake helm only.

## 12. Testing strategy

- **Rust unit**: parser (JSON with and without `message`, text, `Info` alias, `<NA>`,
  caps, garbage, banner and version lines, uuid vs hash id), token bucket, backfill
  window, status diffing, alert gating (threshold, mute, age), SQL (insert-ignore,
  keyset pages, filters, mutes, summary buckets, prune by age and cap, clear).
- **Rust integration** (`tests/falco.rs`, fake API server): detection in auto and pods
  mode, 403 fallback, streaming two Falco pods with JSON and text lines into the store,
  backfill `sinceSeconds` on restart, dedup across a restart, RuntimeThreat alerts only
  for fresh events above the threshold, never connecting on its own, and stop on disconnect.
- **Vitest**: `lib/kube/falco` (priority order, grouping, query building, live merge,
  mute matching, histogram geometry), `lib/kube/operators` (repo plan, request, Falco
  values and namespace manifest), `operatorInstall` flow (prepare/repo/install/verify,
  retry semantics, Trivy parity), alert text for the new reason.
- **Manual** in `pnpm dev:ui`, English and Turkish: install on a cluster without Falco,
  watch, live events, mute/unmute, notification click-through, details sections, cluster
  editor modes, read-only and production gates.

## 13. Rollout

No flag: nothing runs until a cluster opts in, and `ClusterDef.falco` defaults to `auto`.
Docs: an ARCHITECTURE.md subsection under Security, the persistence table (`falco_events`),
and a README feature bullet.

**Phase 2 (optional)**: (a) search Loki for events older than the local store when the
cluster has a Loki source (same parser, not stored); (b) ingest Falcosidekick PolicyReports
when `wgpolicyk8s.io` is already served (for clusters beyond the 64-node streaming cap).

## 14. Open questions

1. Default alert threshold: `warning` (the plan) catches "Read sensitive file untrusted" and
   "Drop and execute new binary"; `notice` would add every interactive shell, which is noisy
   on clusters where people `kubectl exec` a lot. Keep `warning`?
2. The 64-source cap comes from workload logs. Should the Falco watcher allow more (e.g.
   128) given one small stream per node, or should clusters above it use phase 2(b)?
3. Should *Watch Falco events* be offered automatically (a one-time prompt) for clusters
   where Falco is found, or only from the Security tab (the plan)?
4. GKE Autopilot needs a partner allowlist and special values for Falco. Detect Autopilot
   and point to the docs, or leave it to the failure message?
