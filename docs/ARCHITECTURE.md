# Kubepit architecture

Kubepit is a local-first Kubernetes IDE for many clusters (think Freelens/Lens),
built with the RunHQ stack and design system: **Tauri 2 + Rust** on the backend,
**React 18 + Tailwind v4 + Zustand** on the frontend.

```
kubepit/
├── apps/desktop/
│   ├── src/                 # React UI
│   │   ├── components/      # shell (sidebar, tabs, status bar) + workbench
│   │   ├── i18n/            # typed EN/TR catalogs (en|tr/{shell,workbench}.json)
│   │   ├── lib/ipc.ts       # ← the IPC contract (every backend command)
│   │   ├── lib/ipc/mock/    # in-memory demo backend for `pnpm dev:ui`
│   │   ├── store/           # Zustand stores
│   │   └── types/index.ts   # ← shared types (mirrored by serde structs)
│   └── src-tauri/           # thin Tauri shell: commands, events, PTY terminals
└── crates/kubepit-core/     # all Kubernetes + persistence logic (no Tauri deps)
```

## Contract

`apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts` are the
single source of truth for the frontend ⇄ backend boundary.

- Command names are the snake_case strings passed to `call(...)`.
- JS argument names are camelCase; Tauri maps them to the snake_case Rust
  parameters (`clusterId` → `cluster_id`). Struct fields cross verbatim, so
  serde structs use the same snake_case names as the TS interfaces.
  (`KubeObject` is raw Kubernetes JSON and keeps its camelCase fields.)
- Errors are returned as `Err(String)` with a human-readable message.
- Streams use typed `tauri::ipc::Channel<T>` parameters (`onEvent`, `onChunk`,
  `onOutput`).
- Global events: `cluster://status` (ClusterStatus), `cluster://list`
  (ClusterDef[]), `portforward://changed` (PortForward[]), `terminal://exit`
  (`{ id, code }`), `workspace://changed` (`{ source, snapshot }`, the
  window label that saved `workspace.json`), `alerts://new` (AlertNotice:
  `{ alert, fresh, notifier, app_focused }`), `alerts://changed` (`null`;
  alerts were marked read or cleared, refetch `alerts_list`),
  `portforward://saved` (SavedPortForward[]), `kubeconfig://changed`
  (KubeconfigChanged).

## Windows

`window_open` adds app windows (`win-*`) beside `main`; all of them share
one backend (connections, port forwards, the PTY manager) and one origin.
A new window starts as a copy of its opener (`lib/windowSeed.ts`); only
`main` persists the workbench session, while layout prefs are shared and
synced live (`store/windowStorage.ts`). Streams are per window (their
channels belong to the webview); terminals are destroyed with the window
that created them (`src-tauri/src/windows.rs`).

## Persistence (`~/.kubepit`, override with `KUBEPIT_HOME`)

| File                    | Owner    | Content                                             |
| ----------------------- | -------- | --------------------------------------------------- |
| `clusters.json`         | backend  | `ClusterDef[]`                                      |
| `settings.json`         | backend  | `Settings`                                          |
| `workspace.json`        | frontend | `WorkspaceSnapshot` (sections, ordering) — opaque   |
| `manifests.json`        | backend  | recently opened local manifest sources (≤ 12)       |
| `kubeconfigs/<id>.yaml` | backend  | pasted kubeconfigs (`managed: true`), mode 0600     |
| `run/<id>.kubeconfig`   | backend  | single-context kubeconfig for kubectl/helm/terminal |
| `port_forwards.json`    | backend  | `SavedPortForward[]` (saved port forwards)          |

With `settings.keychain_kubeconfigs` the pasted kubeconfigs live in the OS
credential store instead of `kubeconfigs/` (see Connectivity).

Kubepit never rewrites a user's kubeconfig files.

Layout prefs, saved table views and bookmarks live in the webview's
localStorage (`kubepit.workbench.v1`, `kubepit.views.v1`,
`kubepit.bookmarks.v1`), shared by every window (`store/windowStorage.ts`).

## Kubernetes access

- `kube` 4.x with `ws` (exec/port-forward), `runtime` (watcher), rustls.
- One `kube::Client` per connected cluster, built from the cluster's
  kubeconfig + context. Exec auth plugins (aws, gke-gcloud-auth-plugin,
  kubelogin) work because startup imports the login-shell `PATH`.
- Resources are handled generically through `DynamicObject` + `ApiResource`
  built from a `Gvk`; typed k8s-openapi structs are used only where logic
  needs them (pods for logs/exec, nodes for drain, metrics).
- `managedFields` are stripped from everything sent to the UI.
- Watches are batched (~150 ms) into `WatchBatch` messages.
- `read_only` clusters reject every mutating command in the backend (dry runs
  and RBAC self-reviews only read, so they stay available).

## Terminals

The RunHQ PTY pipeline (portable-pty + bounded, acknowledged base64 output
channel) is reused verbatim. `TerminalSpec` selects what runs in the PTY:

- `local` — login shell; with a cluster, `KUBECONFIG` points at
  `run/<id>.kubeconfig`.
- `pod-exec` / `pod-attach` — `kubectl exec -it` / `kubectl attach -it`.
- `node-shell` — privileged helper pod (`hostPID`, `nsenter -t 1 -m -u -i -n`)
  plus `kubectl exec`; the pod is deleted when the terminal closes.

## Helm

Releases are read natively from `sh.helm.release.v1.*` secrets
(base64 → gzip → JSON). Rollback, uninstall and upgrade shell out to `helm`.

Charts (`helm_charts.rs`) use the user's own helm configuration: repositories
(`helm repo list|add|remove|update`), the catalog (`helm search repo`),
chart details (`helm show chart|readme|values`, cached for five minutes) and
Artifact Hub (`helm search hub`, only on demand). Installs and upgrades run
with `--output json` and reuse the release decoding above; dry runs
(`--dry-run=server`, `--dry-run` before helm 3.13) are allowed on read-only
clusters. Values go through a private temp file and repository passwords
through `--password-stdin`.

### Values schemas and the upgrade preview

`helm_preview.rs`; nothing here changes a cluster, so read-only clusters
allow all of it (the upgrade itself stays blocked there).

- **`values.schema.json`.** `helm_release_values_schema` reads `chart.schema`
  (base64 JSON, like every `[]byte` in helm's release JSON) from the newest
  revision's secret; `helm_chart_values_schema` runs `helm pull --untar` into
  a private scratch directory (`run/helm-pull-<uuid>`, mode 0700, removed
  right away) and reads the top-level chart's schema, cached for five
  minutes and cleared with the chart cache. `null` = the chart has none.
- **Validation in the deploy dialog** (`HelmDeployDialog.tsx`): the values
  editor binds the schema through `attachValuesSchema` (`lib/kube/schema/
monaco.ts`, `values.ts`): completion, hovers and markers from the same
  schema layer as manifests, with `SchemaSet.fromJsonSchema` handling the
  draft-07 differences (`$ref` JSON pointers to `#/definitions` / `$defs`,
  `type` lists, open objects unless `additionalProperties: false`, `oneOf` /
  `anyOf` branch properties, `const`, exclusive bounds). `validate.ts` also
  checks `minimum`/`maximum`, lengths, `pattern` and item counts (for
  manifests too). Helm validates the _merged_ values, so a required field
  the chart defaults provide is never reported missing. The status bar
  counts problems; nothing blocks a preview or a deploy. Upgrades use the
  target chart version's schema, else (same version, unknown repository)
  the release's.
- **Upgrade preview** (`helm_upgrade_preview`, helm-diff style): the dry-run
  upgrade renders the next manifest; both manifests are split into objects
  (`split_manifest`: `---` documents, `# Source:` templates, `kind: List`
  items) and matched by API group, kind, namespace (the release namespace
  for namespaced kinds without one) and name into added / changed / removed
  / unchanged with before and after documents. With `live`, every rendered
  object also goes through `dry_run.rs` (server-side apply, `dryRun=All`, at
  most 300) for a live → after diff; fields a chart stops setting are not
  removed by that dry run (helm's three-way merge removes them). The dialog
  makes this a review step: "Upgrade" first renders the review
  (`helm/UpgradeChanges.tsx`: filterable object list, per-object
  `DiffView` in `edit` normalisation, release / live toggle, deprecated
  apiVersions flagged), and only a reviewed, unchanged input runs the
  upgrade (still behind the typed-name confirmation).

## Upgrade readiness (deprecated APIs)

`upgrade.rs` + `upgrade/` answer "what breaks when this cluster moves to a
newer Kubernetes minor" (`upgrade_readiness_scan`, read-only).

- **Table.** `upgrade/deprecated_apis.json` is the single source of truth:
  apiVersion + kind, plural resource, deprecated-in, removed-in (null while
  none is scheduled), replacement (and replacement kind) and note codes,
  dated (`updated`) and covering the 1.16 → 1.32 removals plus `v1
Endpoints` (deprecated in 1.33). The Rust side embeds it
  (`include_str!`); the UI imports the same file
  (`lib/kube/deprecations.ts`, which also translates the note codes). The
  file's `_comment` says how to update it; a unit test checks it.
- **Scan** against a target (default: the minor after the server's
  `gitVersion`), concurrently: metadata-only lists (paged, 20 000 per kind)
  of every table kind the cluster serves — one resource per kind, the
  replacement group first — matching the last-applied annotation and every
  `managedFields[].apiVersion` (managers listed; events and endpoints are
  never listed); the stored manifest of each Helm release's newest revision
  (native decoding, helm rebuilds those objects on every upgrade and
  rollback); CRDs serving versions they mark `deprecated`; aggregated API
  services registering a table group-version; and, when asked and
  Prometheus is available, `apiserver_requested_deprecated_apis` over the
  last hour. Removed in the target (or earlier, `already_removed`) =
  blocker, deprecated by then = warning. Kinds forbidden cluster-wide fall
  back to `accessible_namespaces`; what stays unreadable is reported as
  skipped. No background work: scans run on request.
- **UI.** The `@upgrade` view (`VIEW_KEYS.upgradeReadiness`, Cluster section,
  `components/workbench/upgrade/`): target picker (next four minors),
  blockers / warnings / Helm tiles, sources, filters and findings grouped by
  apiVersion + kind with the replacement and notes; rows open the object or
  the Helm release. Reports live in `store/useUpgradeStore.ts` (per cluster
  and target, this session only) and feed the dashboard's fleet card
  (`components/dashboard/UpgradeFleetCard.tsx`: every connected cluster
  against its next minor, "Check all" scans three at a time). Schema-aware
  editors mark deprecated or removed apiVersions (with the replacement), and
  the Manifests tab flags such documents in its list and details.
- **Demo.** `mock/fixtures/upgrade.ts` adds legacy objects (last-applied and
  side-table managedFields), a `legacy-portal` Helm release with removed
  APIs and a CRD with a deprecated version on the cloud clusters (kind stays
  clean); `mock/upgrade.ts` mirrors the scan and `mock/helmPreview.ts` the
  schemas (generated from the demo charts' parameters) and the preview.

## GitOps (Argo CD, Flux)

GitOps support is UI-side on top of the generic resource commands; there is
no backend code and no dependency on the `argocd` or `flux` CLIs.

- Detection is discovery-driven (`lib/kube/gitops/kinds.ts`): Argo CD
  Applications, ApplicationSets and AppProjects plus every kind of the Flux
  toolkit groups (`kustomize`, `helm`, `source`, `notification`, `image`).
  The navigator's GitOps section (moved out of Custom Resources) and the
  `@gitops` overview only appear when one of them is served.
- The overview (`components/workbench/gitops/GitOpsPage.tsx`) watches
  Applications, Kustomizations and HelmReleases cluster-wide (falling back to
  the selected namespaces when that is forbidden) and normalizes them into
  one row model (`lib/kube/gitops/model.ts`: sync, health, short revision,
  source, destination, last sync, suspended, message, status bucket). A row
  matches the namespace filter through its own or its destination namespace.
- Details sections (`details/sections/ArgoSections.tsx`, `FluxSections.tsx`)
  are chosen by API group, not kind name; managed resources (Argo
  `status.resources`) and Flux inventories (`status.inventory`) render as a
  namespace → kind tree whose names open the objects.
- Actions (`actions/gitopsActions.tsx`) are merge patches through
  `resource_patch`, so `read_only` and RBAC (`ACTION_ACCESS`) apply as for
  any mutation (`lib/kube/gitops/patches.ts`): Argo refresh / hard refresh
  (`argocd.argoproj.io/refresh`), sync (the `operation` the Argo CD API sets:
  revision, prune, dry run, force, sync options, retry), terminate
  (`status.operationState.phase: Terminating`) and auto-sync / prune /
  self-heal; Flux reconcile (`reconcile.fluxcd.io/requestedAt`, plus
  `forceAt` / `resetAt` for HelmReleases, optionally the source first) and
  suspend / resume (`spec.suspend`).
- "Managed by GitOps" (`lib/kube/gitops/managed.ts`, `gitops/owner.ts`):
  Argo tracking ids (`argocd.argoproj.io/tracking-id`, checked against the
  object's identity), Argo instance labels (only when a matching Application
  exists) and Flux `kustomize|helm.toolkit.fluxcd.io/name|namespace` labels
  resolve to the owner. The details header shows a badge linking to it, and
  edit, scale, set image, restart and delete show what a manual change will
  run into (self-heal, reconcile interval, drift detection, suspended)
  without blocking.
- The demo backend (`mock/fixtures/gitops.ts`) adds Applications in every
  state, an app of apps, an ApplicationSet and Flux on staging and dev;
  `mock/gitops.ts` plays the controllers so patched objects move like real
  ones.

## Workload operations

- `rollout.rs` builds rollout history from owned ReplicaSets (Deployments)
  or ControllerRevisions (StatefulSets, DaemonSets) and undoes to a revision
  with `kubectl rollout undo` semantics.
- `images.rs` sets container images with a strategic merge patch at the
  pod-template path of each kind and records `kubernetes.io/change-cause`.
- `dry_run.rs` sends every document of a manifest with `dryRun=All` and
  returns live vs. result per document; the editors show it as a review
  before applying (always on production clusters). Dry runs never mutate,
  so they are allowed on read-only clusters.

## Logs & debug

- `workload_logs.rs` watches the pods of a label selector and fans out one
  follow stream per container (at most 64), batching complete lines of all
  sources every 100 ms into `WorkloadLogBatch` messages.
- `debug_container.rs` adds an ephemeral container through the pod's
  `ephemeralcontainers` subresource and waits until it runs; the UI then
  attaches a terminal to it.
- `pod_fs.rs` lists, previews, downloads and uploads container files with
  POSIX `sh` scripts over exec (GNU coreutils and busybox); folders download
  as `.tar`.

## Fleet

- `metrics_history.rs` samples metrics-server every 15 s while a cluster is
  connected and keeps 60 minutes of f32 ring buffers for the cluster, each
  node and up to 5 000 pods; it stops with the connection.
- `fleet_search.rs` searches every connected cluster concurrently with
  metadata-only lists (substring, glob or `/regex/` names, server-side label
  selectors) and streams results per cluster.
- Cross-cluster compare and drift are UI-side: `resource_get` on each
  cluster, `lib/kube/normalize.ts` (mode `compare`) and `lib/diff.ts`.

## Alerts

`alerts.rs` (+ `alerts/`) watches connected clusters and feeds desktop
notifications and the notification center (status bar bell → right panel
`components/alerts/AlertsPanel.tsx`, settings under Notifications).

- **Monitor.** Started after a successful connect when alerts are enabled
  for the cluster, stopped with the connection (disconnect keeps the
  alerts, removing the cluster drops them). One `kube::runtime` watcher per
  kind — pods, Jobs, nodes, Deployments — cluster-wide, or per namespace
  when the cluster declares `accessible_namespaces`. Objects deserialise
  into slim types (identity + the status fields detection needs) and keep
  a compact snapshot; no per-object API calls. Kinds whose reasons are all
  disabled are not watched; a 403/404 on the first list drops that kind
  instead of retrying forever. Alerts only read, so read-only clusters are
  watched too. Monitoring is opt-in per process
  (`Kubepit::set_alert_monitoring`): the desktop shell enables it, tests
  and headless tools do not.
- **Transitions only** (`alerts/detect.rs`, pure functions of the old
  snapshot and the new object): container entering `CrashLoopBackOff`, a new
  `OOMKilled` termination, `ImagePullBackOff`/`ErrImagePull`, pod
  `Evicted`, Job `Failed`, node Ready → False/Unknown and new
  Memory/Disk/PID pressure, Deployment `ProgressDeadlineExceeded`. The
  first list is the baseline and never alerts; a re-list after a desync
  compares against what was known.
- **Book** (`alerts/book.rs`): settings filters (reasons, namespace globs)
  first, then dedupe per (cluster, object, reason[, condition]) with a
  10-minute sliding cooldown (`count` grows, no new notification), burst
  collapse (after 3 alerts of one reason/kind/namespace within a minute the
  rest merge into one group alert, `object.name` empty, `group.names`),
  and a 500-entry in-memory history. `alerts_list`, `alerts_mark_read`,
  `alerts_clear` (`ids: null` = all).
- **Notifications.** The UI decides (`lib/alerts/policy.ts`): only
  `fresh` alerts, not while snoozed or the cluster is muted, OS
  notifications only from the `notifier` window (`main` while open,
  otherwise the first window by label) so several windows never post
  twice, and — with "only in the background" — a toast in the focused
  window instead while Kubepit is in front. Titles and bodies are built in
  the UI's current language (`lib/alerts/text.ts`); reasons, names and
  Kubernetes messages stay verbatim. Desktop notifications go through
  `tauri-plugin-notification` (clicking one focuses Kubepit; the plugin
  reports no clicks on desktop), browser previews use the web
  Notification API and open the alert on click.
- **Settings** (`Settings.alerts`): master switch, disabled reasons,
  include/exclude namespace globs, disabled clusters (not watched), muted
  clusters (recorded, never notify; until a time or indefinitely), global
  snooze (1 h / until tomorrow 08:00), OS notifications and "only in the
  background".

## Prometheus

An optional, richer metrics source next to the metrics-server history
(`crates/kubepit-core/src/prometheus/`):

- **Detection** (`detect.rs`) lists services (cluster-wide, or per
  namespace in `monitoring`, `prometheus`, … plus the cluster's accessible
  namespaces when RBAC forbids that), ranks well-known ones —
  kube-prometheus-stack (`prometheus-operated`,
  `*-kube-prometheus-prometheus`), the prometheus chart
  (`prometheus-server`), VictoriaMetrics (`vmsingle`, `vmselect` with
  `/select/0/prometheus`), Thanos Query, Mimir query-frontend
  (`/prometheus`), OpenShift `thanos-querier` — and probes the best four
  with `query=1`. In-cluster servers rank above query layers that may hold
  several clusters. `ClusterDef.prometheus` overrides it: `auto`, a
  `service` (namespace, name, port, scheme, path prefix) or `off`.
- **Transport** (`proxy.rs`): every request goes through the API server's
  service proxy
  (`/api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy{prefix}/api/v1/…`)
  with the cluster's credentials — no port-forward, RBAC applies
  (`services/proxy`). A second client per connection without kube's
  default retry keeps a 503 ("no endpoints available") from backing off
  for minutes.
- **Cache**: the status (`prometheus_status`) is kept per connection
  (`connected_at`) and setting; negative answers are rechecked after five
  minutes, a vanished service (proxy 404/502/503) is re-detected, and
  disconnect drops it.
- **Queries**: `prometheus_metrics` runs backend presets (`promql.rs`) for
  cluster, node, namespace, workload (pod names generated by its kind),
  pod, container and PVC targets — CPU, memory, requests/limits, network,
  filesystem, volumes, restarts — over cAdvisor, node-exporter,
  kube-state-metrics and kubelet volume stats; the UI never builds PromQL.
  `range.rs` picks a round step for ~240 points (1h → 15 s, 7d → 1 h) and
  a `rate()` window of at least four scrapes. `prometheus_query_range`
  serves the PromQL dock tab (≤ 200 series). All of it is read-only.
- **UI**: `components/workbench/metrics/UsageMetrics.tsx` shows
  `PrometheusUsage` (1h/6h/24h/7d, requests/limits as lines, network,
  filesystem, volumes, restarts) when the status is `available`, else the
  metrics-server `UsageHistory` unchanged, with a note naming the source.
  `dock/promql/PromqlView.tsx` draws results with `MultiSeriesChart`
  (SVG, like `TimeSeriesChart`). The demo backend
  (`lib/ipc/mock/prometheus.ts`) fakes kube-prometheus-stack on
  prod-eu-west-1, the prometheus chart on the other cloud clusters and no
  Prometheus on the local ones.

## Local manifests

The "Manifests" dock tab (`dock/manifests/`) diffs local files against one
or more clusters like `kubectl diff`, then applies the selected changes.

- `manifests/` in the core renders a source into `ManifestDocument`s that
  keep their source file and line: plain folders are walked directly
  (`.yaml`/`.yml`/`.json`, hidden folders and `node_modules` skipped,
  symlinked folders not followed, 5 MiB per file, 5 000 files), Kustomize
  directories run `kubectl kustomize` (configured kubectl) or
  `kustomize build`, charts run `helm template` with release, namespace
  and values files (`# Source:` comments name the template). Nothing touches a
  cluster. Kustomize folders and charts inside a plain folder are listed as
  `nested` instead of being read as YAML; skipped files come back as
  `problems`. `manifests_fingerprint` hashes path/size/mtime so "Watch" can
  poll for edits; successful renders land in `manifests.json`.
- `manifests_dry_run` sends each document with `dryRun=All` (same request
  as `resource_apply_yaml`, concurrently, allowed on read-only clusters).
  `manifests_apply` refuses read-only clusters, applies in dependency order
  (Helm's install order: namespaces, CRDs, RBAC and config before
  workloads, custom resources last), keeps going after a failure and
  retries custom resources while a CRD from the same batch becomes served.
- The UI runs one dry run per target cluster (`useFleetReview`) and shows a
  documents × clusters matrix (`model.ts`): new / changed / unchanged /
  error per cell with counts and filters, the live → after-apply diff in
  `edit` normalisation, and selection for apply. Objects rejected only
  because a namespace or CRD of the same set does not exist yet count as
  new. Read-only clusters are diffed but excluded from apply; production
  targets need a typed confirmation. Applies send exactly the reviewed
  documents and report per cell.
- "Sync to…" in compare and drift reuses the same review: the source
  object goes through `lib/kube/syncable.ts` (status, server bookkeeping,
  owner references, cluster IPs, node names, bound volumes, generated Job
  selectors, injected token volumes stripped; controller-owned and
  cluster-state kinds refused) and is dry-run on the chosen clusters and
  namespace before anything is applied.

## Change timeline

`change_journal.rs` records "what changed" while a cluster is connected
(`Settings.change_journal`, on by default; per-cluster opt-out in
`change_journal_disabled`, toggled from the Changes view). Like the metrics
sampler it starts after a successful connect and stops, dropping the
journal, on disconnect, removal, shutdown or opt-out. Like alerts, recording
is opt-in per process (`Kubepit::set_change_journal_recording`): the desktop
shell enables it, tests and headless tools do not.

- One `kube::runtime` watcher per journaled kind (workloads, CronJobs,
  Services, Ingresses, ConfigMaps, Secrets, HPAs, PDBs, NetworkPolicies,
  Namespaces, Nodes, RBAC), cluster-wide; a kind forbidden cluster-wide
  falls back to the cluster's `accessible_namespaces`. A first list that is
  forbidden or not served ends that watcher (reported in the status, never
  retried); later errors retry with backoff.
- The first list is only the baseline. Every later version is normalized
  (`normalize.rs`: no status, resourceVersion, generation, managedFields,
  bookkeeping/heartbeat annotations; nodes keep labels and spec) and
  compared with the last one; differences become entries with the actor
  (latest non-status `managedFields` entry) and changed paths (`diff.rs`,
  list items keyed by `name` / `mountPath`). A re-list after a desync
  records what changed meanwhile, including deletions.
- **Secret values are never stored**: `data` / `stringData` values become
  keyed-hash markers (`<redacted #…>`, random key per journal) as soon as
  an event arrives, so "value of key X changed" is visible without the
  value. Helm release secrets are not journaled.
- Memory only, per cluster: 24 h, 5 000 entries, 32 MiB of entries and
  64 KiB of before/after per entry (long values shortened, else only the
  paths kept). The baseline keeps one compact JSON string per object.
- `changes_list` (filter, newest first, cursor paging) and `changes_get`
  (normalized before/after YAML) are polled by the UI. The Changes view
  (`components/workbench/changes/`, logic in `lib/kube/changes/`) merges
  journal entries with Warning events, Helm revisions and ReplicaSet
  rollouts; journaled kinds get a Changes tab in the details panel.
- Tests keep the journal off (`tests/support` setup) unless they enable
  it; `tests/change_journal.rs` drives it through the fake API server.

## Access (RBAC)

`access.rs` wraps SelfSubjectAccessReview, SelfSubjectRulesReview and
SelfSubjectReview. The UI evaluates the namespace's rules locally
(`lib/kube/access.ts`, cached in `useAccessStore`) and falls back to
batched access reviews; actions declare what they need in
`components/workbench/actions/access.ts`. Unknown answers never block the
UI — the API server still enforces.

## Resource map (topology)

The relationship map runs entirely in the UI on top of the shared watches
the tables use (`components/workbench/data/watchCache.ts`); it needs no
backend command. Everything under `lib/kube/topology/` is pure and
deterministic:

- `sources.ts` — the kinds read (a fixed list of built-ins plus Gateway API
  `Gateway`/`HTTPRoute`/`GRPCRoute` when served), one watch slot each.
- `build.ts` + `refs.ts` — one node per object (id `kindKey|namespace|name`)
  and typed edges from referrer to referent: ownerReferences, Service /
  PodDisruptionBudget / NetworkPolicy selectors, Service → EndpointSlices,
  Ingress and route backends, parents, TLS secrets and classes, pod spec
  references (volumes, projected volumes, envFrom, valueFrom,
  imagePullSecrets, claims, service account, node), PVC → PV →
  StorageClass, bindings → service accounts / roles, HPA → scale target.
  Unobserved references become placeholder nodes (`missing` when their kind
  is synced, so broken references stand out).
- `view.ts` — scope (a namespace map: namespaced objects plus the
  cluster-scoped ones they relate to; or an object's neighbourhood of 1–3
  hops where ownership links are free and hubs such as nodes, service
  accounts, classes and cluster roles only expand from the root), drop old
  ReplicaSets and bookkeeping objects, hide kinds (bridging ownership
  chains), collapse pods per controller into group nodes, and cap the map at
  400 nodes with one "+N more" node per kind.
- `layout.ts` — tier columns (entry → route → service → workload →
  controller → pods → config/storage/identity → bindings → cluster → node),
  barycenter sweeps against crossings, isotonic (PAV) coordinate passes and
  cubic edges. The UI memoises the layout on graph structure, so status
  changes never move nodes.

`components/workbench/topology/` renders it: `TopologyCanvas` (SVG with
theme tokens, pan / wheel and pinch zoom, hover highlighting, roving
keyboard focus), `TopologyMap` (search, kind chips, legend, notices),
`ResourceMapPage` (the `@resource-map` view scoped by the namespace picker,
with the details panel docked beside the map) and `MapTab` (the details
panel tab; clicking a node opens that object on its own Map tab).

## Diffs

Every diff (apply review, rollout revisions, Helm revisions, compare and
drift) renders through `components/workbench/common/DiffView.tsx` on top of
Monaco's diff editor, with `lib/diff.ts` (Myers line diff) for stats and the
fallback view.

## Tables: columns, export, saved views, bookmarks

- Column prefs per kind — visibility (`hiddenColumns` toggles), order
  (`columnOrder`, dragged in the column menu; fixed columns keep their
  place) and widths (`columnWidths`, dragged on a header edge) — are layout
  prefs of `useWorkbenchStore`; `table/tableModel.ts` applies them.
- Export (`table/ExportDialog.tsx`, opened through `table/exportStore.ts`
  from the toolbar, the selection bar or the palette) writes the visible
  columns in order with the current filter and sort — or only the selected
  rows — as RFC 4180 CSV (optional Excel mode: BOM + formula guard) or JSON
  rows, and the objects as multi-document YAML (`lib/kube/normalize.ts`,
  status and server fields optional). Pure builders are in
  `lib/tableExport.ts`; cell values come from a column's `text` / `value`
  or from the text of its cell's element tree (`lib/kube/columns/export.ts`).
  Files go through the save dialog and `save_text_file`.
- Saved views (`lib/savedViews.ts`, `store/useSavedViewsStore.ts`,
  `table/savedViews.ts`) snapshot a kind's filter, namespace selection,
  column prefs and sort, per cluster or global. A kind's default view (the
  cluster's own beats the global one) applies the first time its table opens
  in a session.
- Bookmarks (`store/useBookmarksStore.ts`) hold objects (cluster + GVK +
  namespace + name) and views. The navigator's group (`nav/BookmarksSection.tsx`)
  re-checks objects with `resource_get` every minute while connected; a 404
  marks them stale. The palette lists bookmarks of every cluster
  (`palette/workbenchItems.ts`).

## Updates

`tauri-plugin-updater` behind `update_status`, `update_check` and
`update_install` (download progress on an `onEvent` channel); the UI
relaunches with `tauri-plugin-process`. The updater is inert until release
signing is configured: the plugin is registered only when
`plugins.updater.pubkey` in `tauri.conf.json` is non-empty and every endpoint
is `https://` (`kubepit_core::updates::UpdaterConfig`); otherwise the
commands refuse and Settings → About & Updates says updates are not
configured. The main window checks once after startup when
`Settings.auto_check_updates` is on. Keys, artifacts and the `latest.json`
feed are described in `docs/RELEASING.md`.

## Health checks & certificates

- `lib/kube/health/` is a Popeye-style rules engine in pure TS, one file per
  rule family (containers, pods, workloads, network, config, storage,
  policy, nodes, certificates). `rules.ts` is the catalog: stable rule ids
  (persisted in ignores), category, default severity, the lists a rule
  needs and a fix hint. Every finding points at one object. Pod-spec rules
  run once per workload template (bare pods only when no loaded controller
  covers them), so one bad template is one finding, not one per replica.
- `engine.ts` runs the rule families as passes (the async runner yields
  between them), caps findings per rule (400) and objects per list
  (20 000). `summarize` applies ignores and scores 0–100: the mean over
  kinds of per-object scores (worst finding: critical 0, warning 50,
  info 90), graded A–F.
- `components/workbench/health/useHealthScan.ts` feeds the engine from the
  shared watch cache (the tables' keys, so watches are shared) with 15
  built-in lists plus cert-manager `Certificate`s when served. A scan runs
  once every list synced or failed (10 s timeout), at most every 3 s, and is
  never cancelled by newer data; rules whose lists could not be read (RBAC)
  are skipped instead of guessing. The last scan per cluster is published
  to `useHealthStore` for the details panels.
- UI: the `@health` view (score ring, severity and category counts,
  filters, findings grouped by rule, ignore / restore), a summary card on
  the cluster overview (automatic up to 1 500 pods, on request above) and
  a banner in the details panel (object-local rules evaluated on the live
  object plus the cross-object findings of the last scan).
- Ignores are per cluster and rule, optionally per namespace, stored as
  `healthIgnores` in `workspace.json` (opaque to the backend) and synced
  across windows with the rest of the workspace snapshot.
- `lib/kube/x509.ts` is a dependency-free PEM/DER X.509 reader (names,
  SANs, validity, serial, algorithms, CA flag, bundles). Secrets and
  ConfigMaps show certificate cards, the Secrets table an "Expires" column,
  cert-manager `Certificate`s a summary section. Only `CERTIFICATE` blocks
  are decoded; keys are never parsed or shown, and signatures are not
  verified.
- `client_cert.rs` (`cluster_client_certificate`) reads the kubeconfig
  user's client certificate (inline data or file; the cluster is never
  contacted) with a minimal DER reader. The cluster card and overview warn
  from 30 days before expiry.
- Demo: `mock/fixtures/certs.ts` holds throwaway openssl certificates whose
  validity is re-stamped relative to the demo boot (so one stays "expiring
  in 12 days" and one "expired 9 days ago"); `mock/fixtures/health.ts`
  adds leftovers that trigger the other rules.

## Schema-aware YAML & API explorer

Editors and the explorer are driven by the connected cluster's own OpenAPI
v3, so CRDs work like builtins.

- `openapi.rs`: `openapi_v3_index` reads `/openapi/v3` (group-version
  documents with their `?hash=` URLs, cached for a minute or until
  `refresh`); `openapi_v3_document` returns one group-version's
  `components.schemas` (`paths` stripped), fetched through the hashed URL
  and cached by that hash. The cache belongs to the connection (dropped on
  disconnect, reset on reconnect). Both only read, so read-only clusters
  allow them.
- `lib/kube/schema/` (pure TS): `openapi.ts` resolves `$ref`/`allOf` per
  level (children stay lazy, recursive definitions are free) and finds a
  kind by `x-kubernetes-group-version-kind`; `fields.ts` walks YAML paths
  and describes fields (type label, required, enum, default, format,
  `x-kubernetes-*` markers); `yamlContext.ts` derives the path under the
  cursor from indentation (works on half-typed documents), `yamlAst.ts`
  from the `yaml` parser's source ranges; `validate.ts`, `complete.ts`,
  `tree.ts` compute markers, suggestions and explorer rows; `loader.ts`
  caches index, documents (by hash) and discovery per cluster.
- `lib/kube/schema/monaco.ts` registers one completion and one hover
  provider for `yaml`; they only answer for models bound with
  `attachKubeYaml(monaco, editor, { clusterId })` (the model → cluster
  mapping; `useKubeYaml` in the dock editors and the details YAML tab).
  Diagnostics run debounced on documents that parse (unknown field, wrong
  type, missing required field, unsupported enum value, value constraints,
  unserved apiVersion/kind, deprecated or removed apiVersion with its
  replacement). No schema means no suggestions and no markers; nothing
  blocks editing or applying. Helm values editors bind their chart's
  `values.schema.json` instead (`attachValuesSchema`, see Helm); other YAML
  stays unbound.
- API explorer: view `@explain` (`VIEW_KEYS.apiExplorer`,
  `components/workbench/explain/`), opened through `openExplain()` in
  `store/useExplainStore.ts` from the navigator, the command palette
  (`explain <kind>`), a kind page's toolbar and the editors ("Explain field
  at cursor", ⌘/Ctrl+Shift+E), which reveals that field in the tree.
- The demo backend serves a handcrafted subset (`mock/fixtures/openapi.ts`:
  Pod, Service, ConfigMap, Secret, Namespace, Deployment, Job, CronJob and
  cert-manager's Certificate) plus a minimal schema for every other kind.

## Connectivity

- **Saved port forwards** (`saved_forwards.rs`, `port_forwards.json`): one
  definition per target (cluster, namespace, pod or service, remote port)
  with a local port (`null` = any), an optional label and
  `start_on_connect`. Live forwards carry `saved_id`; the UI merges both
  lists (`lib/portForwards.ts`) so stopped saved forwards show as rows.
  Forwards with `start_on_connect` start in the background after a
  successful connect; a start that fails (busy local port, missing pod or
  service) is listed in the `error` state without a listener, and
  `port_forward_restart` re-binds any forward on the same local port.
  Service forwards still re-resolve their pod per connection. Busy local
  ports are detected up front (`port_forward_local_port`, same socket
  options as the listener) with a nearby free port to offer.
- **Kubeconfig watching** (`kubeconfig_watch.rs`): `notify` watches the
  directories of every file discovery reads (`$KUBECONFIG`,
  `~/.kube/config`, the files in `~/.kube`, sync paths) and of every
  registered cluster's file, debounced by 500 ms. A change re-runs
  discovery, reports contexts that appeared in the changed files and are
  not registered, regenerates the `run/<id>.kubeconfig` of clusters sourced
  from them and flags connected clusters whose kubeconfig changed, all in
  one `kubeconfig://changed` event. The UI shows a small notice
  (`components/connectivity/ConnectivityHost.tsx`) that opens the discover
  dialog preselected or reconnects. User files are only read; the watch set
  is re-evaluated every 3 s; roots are injectable (`DiscoveryRoots`) so
  tests watch temp dirs.
- **Proxies** (`proxy.rs`): `ClusterDef.proxy_url` (`http`, `https`,
  `socks5`, `socks5h`, validated on both sides) overrides the kubeconfig
  cluster's `proxy-url`. The effective URL is written into the
  single-context kubeconfig, so the Rust client (kube `http-proxy` /
  `socks5`) and `run/<id>.kubeconfig` agree. `socks5h://` is written as
  `socks5://`, which client-go and kube both resolve through the proxy.
  Changing the proxy drops the connection. `cluster_proxy_info` (masked
  credentials) feeds the connect screen and the cluster overview.
- **OS keychain** (`secrets.rs`, `credentials.rs`): opt-in
  `settings.keychain_kubeconfigs`, changed only by `kubeconfig_storage_set`
  (the regular settings save keeps it). Managed kubeconfigs then live in
  the macOS Keychain / Windows Credential Manager / Secret Service under
  service `io.github.erdembas.kubepit`, key `kubeconfig/<id>`, through the
  `SecretStore` trait (`KeyringSecretStore` in the app, `MemorySecretStore`
  in tests, `DisabledSecretStore` behind `Kubepit::open`, so tests never
  reach the OS). Values larger than a store's entry limit (Windows: 2.5 KB)
  are chunked; the header is written last. Toggling migrates entry by entry
  (copy, verify, delete the original) and moves everything back if one
  entry fails; reads fall back to the other location. In keychain mode
  `run/<id>.kubeconfig` of managed clusters is written on connect (or when
  a terminal or helm needs it) and deleted on disconnect, on exit and at
  the next start.
