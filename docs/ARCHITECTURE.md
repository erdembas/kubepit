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
  (KubeconfigChanged), `customactions://changed` (CustomAction[]),
  `settings://changed` (`{ source, settings }`, after `settings_set` or
  `kubeconfig_storage_set`; every window applies it except `source`, the
  saving window, so its open settings draft is not reset; a dirty draft
  elsewhere keeps its edited fields, `lib/settingsSync.ts`).

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
| `history.db`            | backend  | audit log, persisted events / changes (SQLite)      |
| `actions.json`          | backend  | `CustomActionsFile` (custom actions, see below)     |

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
- Watches are batched (~150 ms) into `WatchBatch` messages. A watch error
  travels in the same batch as the pending `reset`, upserts and deletes, so
  the UI's shared watch cache (`components/workbench/data/watchCache.ts`,
  pure logic in `watchBatch.ts`) always applies the objects first. The list
  turns `error` only when nothing is left; otherwise the rows stay and the
  resource table shows a "Some namespaces could not be watched" notice (for
  example one forbidden namespace of several). kube rarely re-lists after
  an error (only on 410 Gone): a failed watch keeps watching or resumes
  from its resourceVersion, and a namespace whose first list failed
  streams its later list without a reset. So the backend (`watch.rs`)
  counts a source that reported an error as failing until it delivers an
  event again (`InitDone`, `Apply` or `Delete`); once none is failing, the
  next batch has `recovered: true` and the UI clears the error. Only that
  signal clears it: a `reset` or rows of another namespace keep it (with
  `ready` once rows exist), and a batch's message always names a source
  that still fails. A quiet namespace keeps the error until its next event
  or Retry. Error-only batches change no rows and do not bump the snapshot
  `version`. Views that read several lists use `data/listState.ts`: a list
  with an error is incomplete.
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
  most 300) for a live → after diff. That dry run never removes fields a
  chart stops setting; helm's three-way merge does, so each changed object
  with a live object also gets `dropped_fields`: the paths the old render
  has, the new render lacks and the live object still carries, except
  empty maps and lists, which the API server keeps
  (`change_journal::diff::dropped_paths`, the change journal's keyed-list
  walker and path syntax). The dialog makes this a review step: "Upgrade"
  first renders the review (`helm/UpgradeChanges.tsx`: filterable object
  list, per-object `DiffView` in `edit` normalisation, release / live
  toggle, deprecated apiVersions flagged, the dropped fields listed under
  "Helm will remove these fields from the live object" and counted per row
  and in the header), and only a reviewed, unchanged input runs the upgrade
  (still behind the typed-name confirmation). The demo mirrors the walker
  (`mock/droppedPaths.ts`), and its first changed Deployment drops an
  annotation.

## Upgrade readiness (deprecated APIs)

`upgrade.rs` + `upgrade/` answer "what breaks when this cluster moves to a
newer Kubernetes minor" (`upgrade_readiness_scan`, read-only).

- **Table.** `upgrade/deprecated_apis.json` is the single source of truth:
  apiVersion + kind, plural resource, deprecated-in, removed-in (null while
  none is scheduled), replacement (and replacement kind) and note codes,
  dated (`updated`) and covering the 1.16 → 1.32 removals plus `v1
Endpoints` (deprecated in 1.33). Coverage is explicit: `checked_through`
  is the newest minor whose deprecation guide and release notes were
  checked, and `no_removals` lists the checked minors that remove nothing.
  A unit test (`table_accounts_for_every_minor`) requires every minor from
  1.16 through `checked_through` to be some entry's `removed_in` or in
  `no_removals`, never both. The Rust side embeds it
  (`include_str!`); the UI imports the same file
  (`lib/kube/deprecations.ts`, which also translates the note codes). The
  file's `_comment` says how to update it; unit tests check it.
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
  the Helm release. The target card notes when the target is newer than the
  report's `table_checked_through` (later releases may remove more APIs). Reports live in `store/useUpgradeStore.ts` (per cluster
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

## Resource wizards

Form-based `kubectl create` / `kubectl expose` (`components/workbench/wizards/`).
Wizards only build YAML: the manifest goes to the create editor, which runs
the usual server-side dry-run review and applies it (production review and
typed confirmations, `read_only` in the backend, RBAC all unchanged).

- Generators are pure TS in `lib/kube/wizards/` (validation mirrors the API
  server's name/key/port rules; the dry run stays the final check):
  `expose.ts` (Service from a workload or pod: ports from the pod template,
  named ports kept as target ports, selector from the workload's own
  selector, pods it would match beyond the target), `ingress.ts` (rules,
  classes, TLS from a `kubernetes.io/tls` Secret or cert-manager
  `cluster-issuer` / `issuer` annotations, ingress-nginx annotation toggles
  when the chosen or default IngressClass is ingress-nginx, SAN coverage),
  `secret.ts` (generic, docker-registry `.dockerconfigjson`, tls, basic-auth,
  ssh-auth; base64 done for the user, previews redacted until "Reveal"),
  `tls.ts` (PKCS#1 / SEC1 / PKCS#8 key parsing and a key ↔ leaf certificate
  match for RSA, ECDSA and Ed25519 keys that embed their public key; the key
  is only compared, never shown), `configmap.ts` (literals, files — non-UTF-8
  ones as `binaryData` — and `.env` imports), `namespace.ts` (Pod Security
  Standards labels, ResourceQuota / LimitRange presets), `rbac.ts`
  (ServiceAccount + RoleBinding to a Role or ClusterRole), `cron.ts` /
  `cronjob.ts` (schedule parsing incl. macros, localized description built
  from two translated phrases, next runs in the CronJob's time zone).
- `WizardShell` is the frame: form and live YAML preview side by side (or
  stacked, by container query), a footer that names the first blocking
  problem, a non-blocking RBAC hint for what will be created, and "Open in
  editor" / "Review & create". `handOff` opens a create tab with
  `review: true` (the editor starts the dry run in `create` mode) or, when the
  wizard was opened from the editor's template picker, replaces that
  editor's content. Wizard state lives in memory only; secret values are
  never logged or persisted outside the object being created.
- The create editor's review treats "namespaces … not found" as a new
  object when an earlier document of the same manifest creates that
  Namespace (`dock/editor/pendingNamespaces.ts`), since documents are
  applied in order.
- Entry points: a Create menu on the resource page's "+" for kinds with
  wizards (`wizards/catalog.ts`), object actions Expose / Create Ingress /
  Add RoleBinding (`actions/wizardActions.ts`, gated in `ACTION_ACCESS`;
  on a Role or ClusterRole, `actions/roleBindingTarget.ts` picks the
  namespace the wizard binds in and checks `create rolebindings` there,
  never cluster-wide), the create editor's template picker and the palette
  (`create secret`, `expose`, …; not on read-only clusters). "Job from a
  CronJob" lists the namespace's CronJobs and runs their existing "Trigger
  now" action.
- Local files: `local_file_read` (`local_files.rs`) reads a file picked in
  the open dialog — regular files up to 1 MiB, bytes as base64 plus a UTF-8
  flag, content never logged, errors name only path and sizes.
- Demo: `mock/wizards.ts` serves fixture files for the demo picker paths; the
  TLS certificate and key are generated with WebCrypto on first use, so no
  key material ships.

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
  node and up to 5 000 pods; it stops with the connection. Sampling is
  opt-in per process (`Kubepit::set_metrics_sampling`): the desktop shell
  enables it next to the other switches; tests and headless tools do not.
  Turning it off stops every sampler and drops the histories.
- `tests/background.rs` guards the rule for every switch: a connect with
  the defaults sends only `GET /version` and `GET /apis`, and each switch
  (metrics sampling, alerts, change journal, persistent history) shows its
  own traffic once turned on.
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
  `tauri-plugin-notification`, which reports no clicks on desktop (actions
  are mobile-only); clicking one focuses Kubepit. So the notifier window
  remembers the target of the last notification it posted while no Kubepit
  window was focused (its own `document.hasFocus()` and every notice's
  `app_focused`; `lib/alerts/clickThrough.ts`: the alert, or the
  notification center for a group) and opens it when it gains focus itself
  within 10 s; the target is one-shot and a newer notification replaces
  it. Limitations: bringing the notifier window to the front by other
  means within 10 s does the same, and a click that brings another Kubepit
  window to the front opens nothing (Settings → Notifications says so).
  Browser previews use the web Notification API and open the alert on
  click.
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
  `service` (namespace, name, port, scheme, path prefix) or `off`. The
  cluster editor sets it, with Loki and cost, when adding a cluster too:
  `ClusterInput` carries `prometheus`, `loki` and `cost` (serde defaults),
  and `cluster_add` normalizes them like `cluster_update` before anything is
  saved. The field groups take a `null` cluster id while adding, so no
  status lookup runs before the cluster exists.
- **Access** (`access.rs`, `ClusterDef.prometheus_access`, both `auto` and
  `service` modes) for shared or secured sources: a `tenant`
  (`X-Scope-OrgID`, ≤ 200 visible ASCII characters — a header value, so
  no spaces or non-ASCII), `cluster_labels` (a
  selector such as `cluster="prod-eu"`; names match
  `^[a-zA-Z_][a-zA-Z0-9_]*$` and are none of the labels the presets use —
  `__name__`, `namespace`, `pod`, `container`, `resource`, `uid`,
  `owner_name`, `owner_kind`, `job`, `instance`, `replicaset`, `job_name`,
  `reason` — and values are non-empty), an optional `auth` that *references*
  a Secret (bearer token key, or username and password keys; names DNS-1123,
  keys Kubernetes key names) and `tls` for an `https` service behind the
  tunnel (a CA from a ConfigMap or Secret key, else the system roots, or an
  explicit `insecure_skip_verify`). `cluster_add` and `cluster_update`
  normalize it like `prometheus`. Credentials need an explicitly chosen
  `service`: detection ranks services from a cluster-wide list, so anyone
  who may create a Service named `prometheus-operated` (and a pod behind
  it) would otherwise receive them. Validation refuses `auth` with `auto`
  or `off`, and at runtime (`access::credentials_allowed`) only the
  configured service itself gets them — with an older `clusters.json` that
  still pairs `auto` with `auth`, requests fail instead. The cluster editor
  shows the auth fields in service mode only. Two clusters that name the same
  hand-configured service with the same tenant and both declare cluster
  labels must have provably disjoint selectors (a shared label with
  different values); clusters without labels are not compared, since every
  cluster has its own `monitoring/prometheus-operated` behind its own API
  server.
- **Transport** (`proxy.rs`): every request goes through the API server's
  service proxy
  (`/api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy{prefix}/api/v1/…`)
  with the cluster's credentials — no port-forward, RBAC applies
  (`services/proxy`). A second client per connection without kube's
  default retry keeps a 503 ("no endpoints available") from backing off
  for minutes. `Kubepit::prometheus_source` (the service, client and
  access settings of the connection, resolved once per command) +
  `prometheus_send` is the one transport of every caller — chart presets,
  cost usage and trend, right-sizing, the statistics batches, upgrade
  readiness and the PromQL tab (`prometheus_get` is its single-request
  form, used by `prometheus_instant_at`): it sends
  `X-Scope-OrgID` when a tenant is set (the detection probe too), injects
  the cluster-label selector into `Origin::Preset` queries and makes the
  next status request detect again after a proxy or tunnel failure.
- **Tunnel** (`tunnel.rs`): the service proxy does not forward
  `Authorization`, so with `auth` set every request (the probe too) goes
  through an in-process port-forward instead — no local listener, so no
  other local process can use it. The credentials are read from the
  referenced Secret (`get secrets`, the user's RBAC; a bearer token or
  `Basic base64(user:password)`; one read per cluster at a time, given up
  after 15 s so a hung cluster holds up nothing else) and kept in memory for
  at most five minutes per connection and settings (`TunnelCache`: a timer
  drops an entry when it expires even if nothing asks again, a mismatching
  entry is dropped on sight, and disconnect, removal and access changes
  drop it at once); they are
  never logged, stored, returned or quoted in errors, which name the Secret
  and key only (`Credentials` prints as `<redacted>`). Each request
  re-resolves a ready pod behind the service
  (`portforward::resolve_target`, so restarts are survived), opens
  `pods/portforward` to it and speaks HTTP/1.1 over the stream (hyper's
  `client::conn::http1`) with `Authorization`, the tenant and
  `Host: <service>.<namespace>.svc:<port>`. `https` services get TLS over
  the stream (tokio-rustls, ring) with the server name
  `<service>.<namespace>.svc`, trusting the CA of `tls.ca` (a ConfigMap or
  Secret key), else the system roots, or nothing with
  `insecure_skip_verify`.
- **Cluster-label selector** (`matchers.rs`): `with_matchers` is a small
  PromQL lexer that adds `,k="v"` to every vector selector (a bare metric
  name, a `{…}` block, `{__name__=~…}`) and skips string literals,
  function and aggregation names, keywords, label lists after `by` / `on`
  / `without` / `ignoring` / `group_left` / `group_right`, `[…]` ranges and
  numbers. It is never applied to the probe (`query=1`) or to PromQL typed
  in the PromQL tab (`Origin::User`). Charts report the query they sent,
  so a PromQL tab opened from one gets the same data. It fails closed: the
  live right-sizing report keeps the configured label keys in its memory
  answer (`by (namespace, pod, container, cluster)`) and the statistics
  batches in Q11 (pod owners); a series without them or with another value
  fails with `cluster-label-mismatch` (a source that ignored the selector)
  — the live report then falls back to metrics-server with that note, a
  batch aborts with `BatchFailure::Proxy`.
- **States**: `available` when any probed candidate answers; `forbidden`
  when the API server denied every probed candidate
  (`service_proxy::is_proxy_forbidden`: its own 403 `Status` with reason
  `Forbidden` naming `services/proxy`, i.e. no `get` on `services/proxy`),
  with the best candidate as `service` and the API server's message as
  `error`; otherwise `unreachable` (one denial next to a 503 or a timeout
  stays `unreachable`, and so does a 403 of the service itself or of an
  auth proxy in front of it, with its message). `not-found` and `off` as
  before.
- **Cache**: the status (`prometheus_status`) is kept per connection
  (`connected_at`), setting and access settings; negative answers (`forbidden` included) are
  rechecked after five minutes, a vanished service (proxy 404/502/503) is
  re-detected, and disconnect drops it.
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
  A `forbidden` status shows `workbench/common/ProxyForbiddenNotice` above
  that note (and in the PromQL tab): the missing verb, resource and
  namespace, the API server's message verbatim and a copyable
  `kubectl auth can-i get services/proxy -n <ns>`.
  `dock/promql/PromqlView.tsx` draws results with `MultiSeriesChart`
  (SVG, like `TimeSeriesChart`); with cluster labels configured its status
  line says "Cluster selector {…} is not added to your own queries." The
  cluster editor's Prometheus block has a collapsible "Shared or secured
  Prometheus" section (`cluster-editor/PrometheusAccessFields.tsx`,
  container queries): the tenant, label pair rows and, in service mode
  only (a hint says why otherwise), auth (none / bearer token / basic auth
  with the Secret namespace, name and keys) and, for an https service, the
  CA reference and "Skip TLS verification" with a warning badge. Inline checks
  (`lib/prometheusAccess.ts`) mirror `PrometheusAccess::normalized`; the
  backend stays the final check. The status cache key of the UI includes
  the access settings, so a change re-reads the status. The demo backend
  (`lib/ipc/mock/prometheus.ts`) fakes kube-prometheus-stack on
  prod-eu-west-1, the prometheus chart on the other cloud clusters and no
  Prometheus on the local ones; it keeps `prometheus_access` with the
  cluster, keys the status on it and reports a missing credentials Secret
  or key like the backend (the tunnel itself is not simulated).

## Structured logs

Pod logs, merged workload logs and the Loki tab share one pure log model
(`apps/desktop/src/lib/logs/`, no React, no I/O):

- **Parsing** (`parse.ts`, `time.ts`, `levels.ts`): per line, after the
  Kubernetes `timestamps=true` prefix and ANSI colours are removed — JSON
  objects (zap, logrus, slog, pino/bunyan numbers, ECS `log.level`,
  Serilog `@l`/`@m`), logfmt, klog (incl. structured `"msg" k=v`) and text
  layouts (Spring Boot/logback, log4j, Python logging, zap console, Go
  `log`, nginx error logs, bracketed or leading levels, logrus TTY, access
  logs with the level from the status code, Go panics, Python tracebacks,
  Java exception headers) → `{ time, level, message, fields }`. Levels
  normalize to trace/debug/info/warn/error/fatal. `detectLevelToken` is the
  cheap check run on every incoming line (it also locates the level token
  for colouring); `parseLogLine` is the full parse, run lazily.
- **Records** (`records.ts`): `RecordIndex` folds lines into records per
  source — Java/Node stack frames, `Caused by:`, `... N more`, Python
  tracebacks and Go panics join the previous record — and stamps every
  line with its record's level. It is fed incrementally and trimmed with
  the bounded line buffer (50 000 lines), and keeps level counts.
- **Filters and export** (`filter.ts`, `structured.ts`, `rowFilter.ts`):
  level sets, field filters (`key=value`, `key!=value`, `key~regex`,
  `key!~regex`, free text) over parsed fields, flattened JSON paths and
  source fields (pod, container, Loki stream labels); `RowFilter` keeps
  the visible rows incrementally while the predicate is unchanged; export
  of the filtered records as JSON lines or RFC 4180 CSV through the save
  dialog (`saveTextAs` with a file filter).
- **xterm mode**: lines are written with ANSI styling by their record
  level (errors and their stack frames red, other levels on the level
  token); the text itself never changes, so selection and copy stay raw.
  A level filter in the toolbar (both modes) repaints from the buffer.
- **Structured mode** (`dock/logs/structured/`, per-viewer toggle):
  level chips with counts, the filter bar, a column picker over the
  fields discovered in the newest records, and a virtualized table (fixed
  22 px rows; expanded rows add a known detail height) with time, source
  (merged views and Loki; folded into the message below ~620 px), level,
  message and extra field columns. A row expands to its pretty JSON
  (`jsonLines.ts`); clicking a value there or in a field column adds a
  filter (Alt excludes). Pausing freezes the rows at the pause point.

## Loki

Historical logs from an in-cluster Loki (`crates/kubepit-core/src/loki/`),
read-only, over the same transport as Prometheus.

- **Shared service proxy** (`service_proxy.rs`): path building, the GET
  transport with a timeout, proxy error bodies, the retry-free client per
  connection (`Kubepit::proxy_clients`), service listing with a namespace
  fallback, prefix/name validation, the generic per-connection
  detection cache (`DetectCache`) used by both Prometheus and Loki, and
  the `forbidden` rule shared with cost (`proxy_error` tags the API
  server's 403 denial of `services/proxy` with reason
  `ServiceProxyForbidden`, which `is_proxy_forbidden` matches; any other
  403 keeps `ServiceProxy`; `all_forbidden`: every probe denied).
- **Detection** (`loki/detect.rs`) ranks the grafana/loki gateway
  (`loki-gateway`), the microservices query frontend, the simple scalable
  read path (`loki-read`), a single binary (`loki`, loki-stack) and a bare
  querier; write path, backends, caches, canaries, headless and memberlist
  services never qualify. Conventional namespaces (`loki`, `logging`,
  `monitoring`, `observability`) win ties; forbidden cluster-wide lists
  fall back to those namespaces plus the accessible ones. The best four
  are probed with a labels request over the last five minutes.
  `ClusterDef.loki` overrides it: `auto`, a `service` (namespace, name,
  port, scheme, path prefix, optional `X-Scope-OrgID` tenant) or `off`
  (cluster editor, next to Prometheus, when adding or editing a cluster).
  External/Grafana Cloud Loki is out of scope.
- **Commands**: `loki_status` (cached per connection and setting like
  Prometheus), `loki_query_range` (LogQL, nanosecond `start`/`end` as
  strings, limit ≤ 5 000, direction, `step` for metric queries; streams are
  merged by timestamp, metric matrices parsed like PromQL), `loki_labels`
  and `loki_label_values` (optionally narrowed by a selector) for the
  query builder. A vanished service (proxy 404/502/503) marks the
  detection stale. Loki's own errors (bad LogQL, missing tenant, limits)
  come back verbatim. A configured tenant rides on every proxied Loki
  request and on nothing else; `tests/loki.rs` checks the header end to end
  (the fake API server in `tests/support` records request headers).
- **UI** (`dock/loki/`, dock tab kind `loki`): a query builder
  (namespace, workload, pod and container pickers fed by Loki's label
  values — label names follow what the Loki uses, e.g.
  `k8s_namespace_name` — plus a line filter and `| json` / `| logfmt`) or
  raw LogQL (`lib/logs/logql.ts`, workload pods matched by the names their
  kind generates, like the Prometheus presets), range presets
  (15m … 7d), a line limit, and a log-volume histogram
  (`sum(count_over_time(…))`, SVG; click or drag to zoom into an absolute
  window; falls back to the loaded lines). Results render through the same
  xterm and structured views; "Load older" pages backwards from the oldest
  line (end = its timestamp + 1 ns, boundary duplicates dropped). Entry
  points: "Historical logs (Loki)" on pods and workloads (details and
  menus), the pod/workload log toolbars and the command palette. Without
  Loki the tab explains why (not found / off / unreachable) with "Detect
  again" and the settings; `forbidden` (the same state rule as Prometheus)
  shows `ProxyForbiddenNotice` instead.
- **Demo**: `lib/ipc/mock/loki.ts` + `fixtures/loki.ts` fake the gateway on
  prod-eu-west-1, the single binary on the other cloud clusters (dev's is
  unreachable, staging's forbidden) and nothing on the local ones; streams are the fixture pods
  with deterministic JSON, logfmt, klog, nginx and Spring/Java lines per
  minute and a LogQL subset. Demo pod logs mix JSON, logfmt, klog, Python
  tracebacks and Java stack traces so structured mode has work to do.

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
  `problems`. Each render carries a fingerprint (path/size/mtime of every
  file the source depends on); successful renders land in `manifests.json`.
- "Watch" (`manifests/watch.rs`): `manifests_watch(source, since,
  onEvent)` returns an id and watches with `notify` the source's folders
  recursively (a chart's or Kustomize directory's root, a plain source's
  picked folders) plus, non-recursively, the folders of picked files and
  Helm values files, so rename-based editor saves are seen. After 300 ms
  of quiet it recomputes the fingerprint and sends `ManifestsWatchEvent {
  watch_id, fingerprint }` only when it changed (edits of hidden folders
  or `node_modules` stay silent); the tab re-renders when it differs from
  the render's. The baseline is `since`, the fingerprint the tab rendered:
  edits made while no watch ran (tab hidden, Watch off) are reported as
  soon as a watch starts. Each watch is a `manifest_watches` task under
  cluster id `""` that owns the watcher; it runs only while a visible
  Manifests tab has Watch on (`manifests_unwatch` on toggle-off, hide or
  unmount) and is stopped at shutdown. Limitations: Kustomize bases
  outside the root are not watched, and a symlinked manifest whose target
  lies outside the watched folders counts in the fingerprint, but edits of
  the target send no event. The demo backend hands out an id and never
  fires.
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
- Apply is gated per cell on RBAC (`access.ts`, `useApplyDenied`): each
  cell that would create or update asks for `patch` on the object (its
  plural resolved through the target's discovery, namespace = the
  document's, else the target's, else `default`) plus `create` when it is
  new. `planApply` leaves denied cells out and counts them; the apply
  button names the count (or blocks when nothing else is left) and a
  target whose every selected change is denied shows a lock with the
  denied check. Unknown answers and kinds discovery does not know never
  block; the API server still enforces.
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
  rollouts; journaled kinds get a Changes tab in the details panel. Its
  header (`ChangesHeader`) is its own `@container`: in a narrow split pane
  it wraps the ranges, search and refresh onto a second row, the search
  fills that row below `@lg` and the recording label (kept as a tooltip)
  hides below `@2xl`.
- Tests keep the journal off (`tests/support` setup) unless they enable
  it; `tests/change_journal.rs` drives it through the fake API server.

## Persistent history (audit log, events, changes)

`history.rs` (+ `history/`) keeps what must outlive the process in
`~/.kubepit/history.db` — a local SQLite database (`rusqlite`, bundled)
that never leaves the machine.

- **Storage** (`history/db.rs`): WAL mode, `synchronous = NORMAL`,
  incremental auto-vacuum, versioned migrations recorded in
  `schema_version` (a database from a newer Kubepit is refused, never
  migrated backwards), file mode 0600. Tables: `audit` + `audit_objects`
  (before/after per target, cascade-deleted), `events` (upserted by
  cluster + uid) and `changes` (idempotent per journal start + entry id).
- **One writer** (`history/writer.rs`): a dedicated thread behind a bounded
  queue (1 024 operations). Producers only `try_send`; a full queue drops
  the write and counts it (`HistoryStatus.dropped`), so a command never
  waits for the disk and recording never fails the user's action.
  Operations apply in queue order; consecutive data writes share one
  transaction; clear, prune and flush are barriers. Queries use their own
  read connection on the blocking pool at the IPC edge.
- **Audit log** (on by default, `Settings.history.audit`): every mutating
  command's public entry point lives in `history/audited.rs` and wraps the
  unaudited implementation in its domain module (`*_unaudited` in
  `resources.rs`, `nodes.rs`, `rollout.rs`, `images.rs`, `helm.rs`,
  `helm_charts.rs`, `manifests/apply.rs`, `debug_container.rs`,
  `pod_fs.rs`, `node_shell.rs`), so every entry point is covered: apply /
  create / replace, patch, delete, scale, restart, set image, rollout undo,
  CronJob trigger, cordon / uncordon, drain (one entry, its own cordon is
  not separate), Helm install / upgrade / rollback / uninstall, manifests
  apply (one entry, one target per document, failed when any document
  failed), debug containers, file upload, node-shell helper pods,
  right-sizing and mutating custom actions (below). A src-tauri guard
  (`ipc/audit_coverage.rs`, test-only) parses `generate_handler!`: every
  registered command must be classified as mutating or not, and every
  mutating one must call a method defined in `history/audited.rs`. An
  entry holds cluster id / name / context, the identity of the cluster's
  last `access_whoami` (else unknown), action, targets, a redacted
  request, the dry-run flag, outcome and error, duration, a result (Job,
  container, helper pod, Helm revision) and — where a GET or the response
  gives it cheaply — normalized before/after objects (≤ 20 documents,
  5 s per GET, 128 KiB per target). Refusals by the `read_only` guard are
  **not** recorded (nothing reached the cluster; the wrapper does not even
  send its GET); dry runs, which read-only clusters allow, are recorded
  with `dry_run: true`. Validation and API errors are recorded as errors.
- **Custom actions** (`custom-action`, never revertible): background runs
  and terminal launches of `mutating` actions go through the audited
  `custom_action_run` / `prepare_custom_action_terminal`, which resolve the
  saved action once and pass it to the `*_unaudited` body, so the entry
  describes what ran. The request keeps the action's name, id, mode,
  number of targets and the command re-rendered with every
  `annotations.*` value (and, for Secret-like kinds, every `labels.*`
  value) replaced by a marker; stdout and stderr are never stored.
  Background runs record `exit {code}` (a non-zero exit fails the entry; a
  timeout fails it with `timed out after {s}s`, a signal with `terminated
  by a signal`), terminal launches the keyword `terminal-started`. The
  Activity view translates both results (`resultText` in
  `lib/history/audit.ts`); other results stay verbatim. Targets are the
  selected objects (≤ 20) or the cluster. Non-mutating and open-url runs
  are not audited; refused runs (read-only, disabled, out of scope) are
  not recorded.
- **Secrets**: objects go through the change journal's `normalize`
  (Secret `data` / `stringData` become keyed-hash markers, bookkeeping and
  `status` dropped); patch bodies to secret-like kinds (`*Secret`), custom
  `*Secret` kinds' `spec` / `data` and Helm values keep their keys only —
  every value becomes a marker (one random key per process). File contents
  are never stored (name and destination only). `tests/history.rs` checks
  the raw database, WAL and exports for the secret values.
- **Revert**: an object is revertible when the action is apply / replace /
  patch / scale / set image, succeeded, was not a dry run, has a changed
  before-state without redaction markers and is not secret-like. The UI
  (`lib/history/revert.ts`) turns after → before into an RFC 7386 merge
  patch, applies it to the _live_ object (later changes by others stay)
  and sends it as a `replace` with the live resourceVersion — reviewed by
  a server-side dry run first (`components/activity/RevertDialog.tsx`),
  blocked on read-only clusters.
- **Persistent events and changes** (opt-in per cluster,
  `Settings.history.persist_clusters`): while connected, `history/persist.rs`
  watches core/v1 Events cluster-wide (falling back to
  `accessible_namespaces` on 403) and upserts them once a second —
  deletions are ignored, so events outlive the one-hour TTL — and copies
  new change-journal entries every 3 s through `ChangeJournals::reader`
  (a journal restart is detected by its start time). Changes need the
  change timeline to be on.
- **Retention**: every ten minutes (first after one minute) and after a
  settings change: audit entries older than `audit_retention_days`
  (default 90), events and changes older than `retention_days` (default
  7), then the size cap `max_size_mb` (default 512: the oldest events and
  changes go first, the audit log only when nothing else is left), then
  incremental vacuum (full `VACUUM` after a clear or when most of the file
  is free) and a WAL checkpoint.
- **Opt-in per process** (`Kubepit::set_history_recording`, enabled in
  `src-tauri/src/setup.rs`): tests and headless tools record nothing, send
  no audit GETs and start no watchers, so fake-API-server logs stay
  deterministic; queries and clears work either way (the database opens
  lazily).
- **Commands**: `history_status`, `history_audit_list` (filters: clusters,
  actions, outcome, text, time; `"<ts>:<id>"` cursor, total),
  `history_audit_get`, `history_audit_export` (JSON lines),
  `history_events_list`, `history_changes_list` (a `ChangeFilter`; ids are
  the database's), `history_changes_get`, `history_clear` (audit / events /
  changes / all, optionally one cluster).
- **UI**: the global Activity main tab (`components/activity/`, sidebar
  utility row and palette): filters, day groups, expandable entries with
  targets, the redacted request and a DiffView of before/after, links to
  the objects, Revert, export. Settings → History
  (`components/settings/HistoryCategory.tsx`): audit on/off, retention,
  per-cluster persistence, size cap, database path and size, clear
  buttons. Clusters that persist history get 7d / 30d ranges in the
  Changes view, whose timeline then adds persisted entries older than the
  live journal and persisted Warning events; the details Changes and
  Events tabs offer "Load older … from history". Without persistence the
  in-memory paths are unchanged.
- The demo backend (`mock/history.ts`, registered last) wraps every
  mutating demo command to derive the audit log from what you do in
  `pnpm dev:ui`, seeds a few older entries, and ships persisted events and
  changes for `staging-gke`.

## Cost insight & right-sizing

What a cluster costs per month, where the money goes and which requests to
change (`crates/kubepit-core/src/cost/`, `rightsizing/`,
`prometheus/usage.rs`; UI in `components/workbench/cost/`). Everything but
applying a recommendation only reads, so read-only clusters get it all.

- **Sources** (`ClusterDef.cost.source`: `auto`, an `opencost` or
  `kubecost` service, or `estimate`). `cost/detect.rs` ranks the services
  Prometheus detection lists (plus `opencost`, `kubecost` namespaces when
  RBAC forbids the cluster-wide list): OpenCost (`opencost`, API port 9003,
  `/allocation/compute`) before Kubecost (`*-cost-analyzer`, frontend port
  9090, `/model/allocation`), and probes the best three with a one-hour
  query. Requests go through the service proxy with the Prometheus
  transport's `proxy_path` and a retry-free client of the connection
  (`cost/proxy.rs`, plain JSON instead of the Prometheus envelope).
  Detection is cached per connection and setting; "no cost API" is
  rechecked after five minutes, a proxy 404/502/503 re-detects, disconnect
  drops everything. A cost API that fails a query falls back to an
  estimate with an `api-failed` note. When the API server denied the
  proxy for every probed cost API (or the configured one),
  `CostStatus.forbidden` is set, costs are estimated, the answer is
  rechecked after five minutes like "no cost API", and the source card
  shows `ProxyForbiddenNotice` instead of "did not answer".
- **Allocations** (`cost/allocation.rs`): an accumulated breakdown
  (`aggregate=namespace`, `namespace,controllerKind,controller` or
  `label:<prometheus-style key>`, idle included) and daily totals
  (`step=1d`). Every row becomes a monthly run rate (730 h) with its own
  `minutes`, `__idle__` / `__unallocated__` become special rows, controller
  kinds get their Kubernetes spelling.
- **Estimates** (`cost/estimate.rs`, pure): each running or pending pod
  costs its effective requests (containers' sum vs. the largest init
  container, plus overhead) — or its usage when higher and known — at the
  price model's hourly prices; nodes cost their capacity and the rest is
  idle (unknown without node access); claims cost their capacity per
  GiB-month and belong to the first pod mounting them. Workloads come from
  owner references (ReplicaSet → Deployment via `pod-template-hash`, Job →
  CronJob via the scheduled-time suffix). Usage is the Prometheus average
  over the window (`rate` / `avg_over_time` presets per pod) or the current
  metrics-server snapshot; with Prometheus the trend is requests × prices
  per day (`prometheus_metrics` cluster requests, hourly steps).
- **Price model** (`cost/pricing.rs`): the cluster's own (currency, vCPU-
  and GiB-hour, optional GPU-hour and volume GiB-month, discount %) or the
  defaults of the detected platform — rounded on-demand list prices for
  EKS, GKE, AKS and a cheaper generic / on-prem model, always labelled as
  estimates. No per-instance-type price list is shipped.
- **Commands**: `cost_status`, `cost_report` (window 7d/30d, aggregate,
  label; cached five minutes, `refresh` bypasses), `cost_summary` (the
  7-day namespace totals for the dashboard).
- **Right-sizing**: usage fetching and math are separate.
  `prometheus/usage.rs` presets return, per container over `days` (default
  7), the p95 and max of 5-minute CPU rates, the max working set and the
  hours with samples; pods map to Deployments / StatefulSets / DaemonSets
  / CronJobs by the pod names their kind generates (longest name wins),
  worst replica wins, hours are per replica. A CronJob is read at its job
  template and counts one replica; its `cost_replicas` (and so its
  monthly amounts) is the largest duty cycle of its containers' evidence
  (average running pods), one without evidence (`math::cost_replicas`). Without Prometheus the last metrics-server
  hour is used, split per container by the current snapshot (always low
  confidence). Ownership-aware collection is built from
  `rightsizing/ownership.rs`: kube-state-metrics owner series
  (`kube_pod_owner`, `kube_replicaset_owner`, `kube_job_owner`) index pod
  names per namespace; `<none>`, empty and non-controller owners are
  dropped; `OwnerIndex::resolve` follows one hop (ReplicaSet → Deployment,
  Job → CronJob, StatefulSet / DaemonSet directly) and reports bare pods,
  orphan ReplicaSets and standalone Jobs as unowned, other parents
  (`Node`, `Rollout`) as unsupported, and a pod name with several owners
  as ambiguous with its sorted candidates (several owners that resolve to
  one workload are that workload). `prometheus/workload_stats.rs`
  builds the 16 instant queries of one batch (Q1–Q16: CPU p95 / max /
  average / samples, memory max / average / samples, running samples,
  first / last running step, pod / ReplicaSet / Job owners, OOM kills, CFS
  throttled and total periods), all `max by (…)` and evaluated at
  `time=` the window end floored to 5 minutes (`window_end`), four in
  flight. Answers merge per `(namespace, pod, container)`: duplicates keep
  the maximum, negative counts clamp at 0, Prometheus warnings mark the
  batch partial. CPU p95 and memory max are required: a failed answer or
  one above 50,000 series makes the batch splittable, a service-proxy or
  tunnel failure aborts (and re-detects Prometheus), other failures are
  listed as failed queries. Every query goes through the one Prometheus
  transport as a preset (tenant, tunnel, cluster-label selector); on a
  shared Prometheus Q11 keeps the configured label names in its `by (…)`,
  and an owner series without them (or with another value) fails the batch
  with `cluster-label-mismatch`. `rightsizing/evidence.rs` folds a batch into
  per-(workload, container) usage (`ContainerUsage`: `UsageStats` plus
  `UsageEvidence`): pods resolve through the owner index (or, without
  owner series, by name with identity `name-match`), only containers of
  the live pod template count (sidecars and renamed containers are
  skipped), the maxima are over pods that have both a CPU p95 and a memory
  max, averages are sample-weighted, observed hours are the union of the
  pods' running spans (without them, memory samples per replica, capped at
  the window), coverage is samples ÷ running samples, duty the average
  running pods, the throttling ratio needs 600 CFS periods, and an
  ambiguous pod name adds nothing but flags every live candidate
  (`WorkloadExtras.identity`, even for rows left without usage). When the
  ReplicaSet or Job owner query failed or answered nothing for a namespace
  (`OwnerIndex::missing_parent_series`), pods owned by a ReplicaSet / Job
  there are matched by name among Deployments / CronJobs instead, with
  identity `name-match` and partial data. Rows keep at most 50 sorted pod names and the HPA whose
  `scaleTargetRef` names the workload. The metrics-server and legacy Prometheus paths produce
  `ContainerUsage` without evidence. The math sits behind `rightsizing::strategy::RecommendationStrategy`
  (`fn info() -> RightsizingStrategyInfo`, `fn recommend(&ContainerInput) ->
  StrategyOutput`; input = name, current requests/limits, `UsageStats`,
  source, settings, optional `UsageEvidence` and `HpaInfo`; output =
  recommended values, confidence, warnings). `info()` also carries the
  strategy's own `defaults` and the `settings_keys` it reads, so the UI
  renders only those fields (every strategy lists `min_hours`,
  `min_coverage` and `throttle_threshold_percent`, which the shared
  evidence step reads); a request without settings uses the strategy's
  defaults. `STRATEGIES` lists them, requests pick one by id and
  reports list them all, so a new strategy needs no UI, apply or preset
  changes. Settings clamp to headroom 0–300 %, 1–30 days, `min_hours`
  1–720 (at most the window), `min_coverage` 0.1–1 and
  `throttle_threshold_percent` 1–50. New report, workload and container
  fields (`evidence`, `pods`, `hpa`, `lenses`, `cost_replicas`,
  `strategy_auto`, `window_end`, `cpu_avg` / `memory_avg`) default when
  absent, so JSON of older builds still reads. The default
  `percentile-headroom` (`rightsizing/percentile.rs`): CPU request = p95 +
  15 %, memory request = max + 20 %, memory limit = max + 40 % — proposed
  for containers without one (`memory-limit-added`), raised when tighter,
  never lowered (CPU limits are never invented) —, minimums, rounding up
  to sane steps, never below the observed peak, no churn under 10 % /
  10 m / 16 MiB; confidence high from 3 days, medium from 12 hours.
  `workload-history` (`rightsizing/workload_history.rs`, KubeFit's logic)
  sits next to it: CPU request = p95 + 20 %, memory request = max + 20 %,
  both at least the minimums and rounded up to whole millicores / MiB;
  after an OOM kill the memory base is never below the current limit; the
  same no-churn band; a container without a memory limit gets one at the
  peak + `memory_limit_headroom_percent` (never below the request,
  `memory-limit-added`), existing limits are left to `finalize`, CPU
  limits are never invented; confidence high from 72 hours, else medium
  (`short-history`), metrics-server low. `strategy::resolve` picks the
  requested strategy, or automatically `workload-history` when the
  collection resolved pods through kube-state-metrics owner metrics and
  `percentile-headroom` otherwise (`strategy_auto`).
  Between the strategy and `finalize`, the shared `strategy::apply_evidence`
  turns the usage evidence and the HPA into flags that only cap the
  confidence and never change a value (a recommendation is always
  computed): `identity-unclear`, `insufficient-history` (< `min_hours`,
  detail whole hours) and `low-coverage` (< `min_coverage`, detail whole
  %, both rounded down) cap it at low; `partial-data`, `hpa-target` (detail the HPA name),
  `hpa-utilization` (a Utilization target on a request that changes,
  detail `cpu 70%`), `oom-killed`, `cpu-throttled` (throttled ÷ CFS
  periods ≥ the threshold, detail one decimal %) and `identity-by-name`
  cap it at medium; the final confidence is the lowest cap.
  `strategy::finalize` is shared by all strategies: values a strategy left
  alone stay, and a limit a new request would exceed rises proportionally
  (current limit ÷ request ratio kept, flagged `*_limit_raised` with a
  warning). Workloads get a verdict (over / under / balanced / no data;
  any `oom-killed` container makes it under), the monthly cost delta of
  their requests and the weakest container's confidence.
  `rightsizing/summary.rs` adds what the review needs, in Rust so every
  view and export agrees: `lenses_of` (KubeFit's quick-focus groups:
  `cpu-reduction`, `memory-reduction`, `increase` (increase or set),
  `request-unset`, `missing-data`, `needs-review` (changed, not high
  confidence), `limit-raised`) sets `WorkloadRecommendation.lenses`;
  `risk_score` (`+∞` after an OOM kill, else the largest usage ÷ request,
  a missing request counting as 2); `one_click_eligible` (high
  confidence, changed, no raised limit — the UI adds the cluster
  conditions); `summarize` turns a report into a `RecommendationSummary`:
  counts by verdict, confidence and change, one-click count, CPU and
  memory totals (requests × `cost_replicas` over containers with a
  current request and usage, plus the containers without a request),
  monthly current / savings / increases, and `top` — at most five
  under-provisioned workloads (confidence ≥ medium) by risk, then at most
  five high-confidence savings, ties by namespace and name.
- **Recommendation settings** live in the backend
  (`Settings.recommendations`, `recommendations/types.rs`) so background
  scans and the UI agree: `scan_clusters` (opt-in per cluster),
  `interval_minutes` (60, 15–1440), `retention_days` (30, 1–90),
  `strategy` (`None` = automatic), `overrides` per strategy id and
  `alerts` (off). `settings_set` normalizes them (clamps, sorted and
  deduplicated clusters without blanks, a blank or unknown strategy =
  automatic, every override normalized). `rightsizing_report` takes the
  request's strategy (unknown = an error), else the saved one (unknown,
  e.g. from a newer build or a hand edit, = ignored), else resolves
  automatically, and the request's
  settings, else `effective_settings` (the strategy's override, else its
  `info().defaults`).
- **Apply** (`rightsizing_apply`): a strategic merge patch of the named
  containers' resources at the pod template (`patch::template_path`:
  `spec.template.spec`, a CronJob's `spec.jobTemplate.spec.template.spec`,
  so only Jobs it starts afterwards change; `workload_gvk` gives `apps/v1`
  or `batch/v1 cronjobs`) plus a `kubernetes.io/change-cause`; `dryRun: true` returns live vs. result like
  `resource_dry_run_yaml` (allowed on read-only clusters), the real apply
  is refused on read-only clusters. The dialog shows every value that
  changes (raised limits called out with their ratio), the strategy's
  warnings and the dry-run diff, gates on RBAC (`rightsize` in
  `actions/access.ts`) and asks production clusters for a typed
  confirmation. Optional memory limit changes can be left out; limits a
  request would exceed are always sent.
- **UI**: the `@cost` view (Cluster section) with monthly total, idle,
  efficiency (usage ÷ requests, cost-weighted), allocated vs. idle and cost
  by resource, the source and price model, the daily trend
  (`MultiSeriesChart`), a breakdown by namespace / workload / label (key
  configurable, suggestions such as `team`, `app.kubernetes.io/part-of`)
  filtered by the workbench namespaces with CSV export (`lib/tableExport`),
  and the right-sizing list (filters, headroom settings, strategy picker
  when there are several). A cost card on the cluster overview, a fleet
  total per currency in the dashboard's status bar, a right-sizing section
  in Deployment / StatefulSet / DaemonSet / CronJob details and two Health rules
  (`workload-overprovisioned`, `workload-underprovisioned`, category
  efficiency) that only fire on large, confident deltas
  (`lib/kube/rightsizing/model.ts#healthVerdict`). Per-viewer preferences
  live in localStorage (`kubepit.cost.v1`). Every amount goes through one
  formatter, `lib/cost.ts#formatMoney`, in the UI locale: rounded to cents,
  two decimals below 1,000 and none from there, compact notation only from
  one million (`$1.2M`), `signed` deltas (`+$12.50`), unknown currency
  codes as `12.40 XYZ`; unit prices keep four decimals (`formatUnitPrice`).
- **Demo**: OpenCost on prod-eu-west-1 (`mock/fixtures/cost.ts` derives
  allocations with usage, network and idle plus a daily trend), estimates
  elsewhere (Prometheus usage and a requests trend where the demo runs
  Prometheus, the metrics-server snapshot on kind), and synthetic usage
  histories that make some workloads over- and others under-provisioned.

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
- `scope.ts` — one watch scope per slot (`SlotScope`: a namespace list, `[]`
  for cluster-wide, `null` for not watched). The Resource Map and the Map tab
  of namespaced objects, Namespaces and bound PersistentVolumes use one list
  for every slot. Other cluster-scoped roots never watch namespaced kinds
  cluster-wide: `mapSeed` names the kinds that tie the root to namespaces,
  watched cluster-wide (keys other views share), and the namespaces each
  seed object names for the root, mirroring how the builder links it: Node
  → pods by `spec.nodeName`; StorageClass → PVCs; ClusterRole →
  RoleBindings whose `roleRef` names it (their own namespace and their
  ServiceAccount subjects') and ClusterRoleBindings (their ServiceAccount
  subjects'); ClusterRoleBinding → its own ServiceAccount subjects'
  namespaces plus those of the RoleBindings that bind one of them (so their
  Roles too); IngressClass → Ingresses by `ingressClassName`, else the
  legacy `kubernetes.io/ingress.class` annotation, plus class-less Ingresses
  when the root is the default class. `planMapScope` scopes every other
  namespaced slot to the union of those namespaces. Until every seed kind
  syncs (or fails), when nothing matches, and for roots without a seed
  (PriorityClass, unbound PersistentVolumes, …) namespaced slots stay
  unwatched.
  The graph is scoped to the union of the explicit lists (`scopeNamespaces`);
  on those Map tabs `plannedGraphScope` makes "none" mean no namespace
  (`buildTopology` `namespaces: null`), so the seed objects elsewhere make no
  placeholders for what they reference.
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
  chains in linear time through an adjacency index), collapse pods per
  controller into group nodes, and cap the map at 400 nodes with one
  "+N more" node per kind.
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
panel tab; clicking a node opens that object on its own Map tab). The
details tab strip overflows at the panel's 380 px minimum, so it scrolls the
active tab into view (tab requests open the right-most tabs, such as Map)
and turns the wheel into horizontal scrolling (`lib/ui/wheelScroll.ts`).

Views stay mounted, so leaving one only turns it inactive, and that must cost
nothing. `useTopologyData` rebuilds the graph on `topologyDataKey`
(`dataKey.ts`: each slot's `version`, `synced`, `forbidden` and `error`, never
the `status` that stopping the watches flips), and returns its previous model
while disabled. `TopologyMap` likewise keeps its derived view, and so its
layout, while `active` is false (`pausedMemo`).

## NetworkPolicy simulator

"Can A talk to B?" runs entirely in the UI on the shared watches; there is
no backend command. The engine in `lib/kube/netpol/` is pure and
deterministic (no cluster access, no dependencies):

- `parse.ts` normalises pods (labels, IPs, node, host network, container
  and sidecar ports, workload from the controller reference), namespaces,
  Services and `networking.k8s.io/v1` NetworkPolicies, including API
  defaulting (`policyTypes` omitted: Ingress always, Egress when there are
  egress rules; protocol TCP) and peers/ports the API server would reject
  (they match nothing). Namespaces that cannot be listed are synthesised
  with only `kubernetes.io/metadata.name`.
- `engine.ts` implements the semantics: a pod is isolated per direction
  only by policies of its namespace that select it with that type; allowed
  traffic is the union of their rules; a connection needs the source's
  egress and the destination's ingress. Within a peer `podSelector` and
  `namespaceSelector` are ANDed (a lone `podSelector` means the policy's
  namespace), peers/rules/policies are ORed, empty `from`/`to`/`ports`
  match everything, `ipBlock` honours `except`, ports support protocols
  TCP/UDP/SCTP, `endPort` ranges and named ports resolved on the
  destination pod. Ingress from the pod's own node and a pod reaching itself
  are always allowed. Host-network pods follow the common plugin behaviour
  (never isolated, match no selector, traffic from the node IP) and ipBlocks
  matching pod IPs are flagged, since plugins differ on both. Sides return
  a structured explanation: isolating policies, the rules whose peer
  matched (with the ports they allow), rules that did not match and named
  ports the destination does not declare. Ports are interval sets
  (`ports.ts`), addresses BigInt ranges for IPv4/IPv6 (`ip.ts`).
- `query.ts` resolves selections (pod, workload, namespace, Service via its
  selector and `targetPort`, external address/CIDR split at every ipBlock
  boundary so each piece evaluates uniformly; node IPs inside a wider
  range are left out) and groups the evaluated pairs by explanation.
  Without a port the destination's declared ports are checked (any port
  when it declares none). `summary.ts` builds per-pod "who can reach me /
  whom can I reach" (with a DNS check against kube-dns), the namespace
  matrix (workload × workload plus "outside the cluster") and the
  isolation list, memoising pairs per equivalence class (namespace, labels,
  ports, ipBlock matches). `overlay.ts` colours resource-map nodes.
- `caveats.ts` lists policies of engines that are not evaluated
  (CiliumNetworkPolicy / ClusterwideNetworkPolicy, Calico NetworkPolicy /
  GlobalNetworkPolicy in both API groups, AdminNetworkPolicy,
  BaselineAdminNetworkPolicy, ClusterNetworkPolicy) and guesses from
  DaemonSets whether the network plugin enforces NetworkPolicy (Cilium,
  GKE Dataplane V2, Calico/Canal, Antrea, kube-router, Weave, Azure NPM,
  OVN, Amazon VPC CNI with its policy agent flag, kindnet by release;
  Flannel alone does not). Verdicts are marked "not certain" when the
  plugin likely does not enforce, unevaluated policies apply to the
  namespaces involved, the NetworkPolicy list failed or only partly loaded
  (a forbidden namespace would otherwise look unprotected), or a
  host-network pod / pod-IP ipBlock is involved
  (`components/workbench/netpol/uncertain.ts`).

UI (`components/workbench/netpol/`): `useNetpolData` watches pods,
NetworkPolicies and Services cluster-wide (falling back to the selected
namespaces when forbidden), namespaces, DaemonSets and the extra policy
kinds, and shares one built model per snapshot. The `@netpol` view
(Network section, palette "Open network policy simulator") has three
modes: simulate (source/destination pickers, protocol and port, verdict
card with the explanation trail; policies and pods open in a docked
details panel), matrix (SVG grid of one namespace, hover or pin a cell for
its explanation, filter by port) and isolation (workloads without ingress
or egress protection, deny-all, isolated). Pods and workloads get a
Reachability details tab (a workload without pods evaluates its pod
template), NetworkPolicies a plain-words summary and traffic flow, and the
resource map a "Reachability" toggle that colours nodes and edges by what
the selected pod can reach. The demo backend (`mock/fixtures/netpol.ts`)
adds default-deny namespaces, label/namespace/ipBlock/named-port rules and
DNS egress allowances, and Cilium with two Cilium policies on the AKS
cluster.

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
  needs, a fix hint and `optIn` (off by default). Every finding points at
  one object. Pod-spec rules
  run once per workload template (bare pods only when no loaded controller
  covers them), so one bad template is one finding, not one per replica.
- `engine.ts` runs the rule families as passes (the async runner yields
  between them), caps findings per rule (400) and objects per list
  (20 000). `summarize` drops silenced findings and scores 0–100: the
  mean over kinds of per-object scores (worst finding: critical 0,
  warning 50, info 90), graded A–F. `isSilenced` (also used by the details
  banner) is true for ignored findings and for findings of an opt-in rule
  the cluster has not turned on. Opt-in findings are still computed, so
  turning a rule on is instant and the engine stays pure.
- `components/workbench/health/useHealthScan.ts` feeds the engine from the
  shared watch cache (the tables' keys, so watches are shared) with 20
  built-in lists plus cert-manager `Certificate`s and 11 controller
  reference lists when served (see `secret-unused` below). A scan runs
  once every list synced or failed (10 s timeout), at most every 3 s, and is
  never cancelled by newer data; rules whose lists could not be read (RBAC)
  are skipped instead of guessing. A list counts as loaded only when it
  synced with no error at all (`data/listState.ts`): a partial one (rows
  kept, one namespace forbidden) is reported with the unreadable lists and
  skips the rules that need it. The last scan per cluster is published
  to `useHealthStore` for the details panels.
- UI: the `@health` view (score ring, severity and category counts,
  filters, findings grouped by rule, ignore / restore), a summary card on
  the cluster overview (automatic up to 1 500 pods, on request above) and
  a banner in the details panel (object-local rules evaluated on the live
  object plus the cross-object findings of the last scan).
- Ignores are per cluster and rule, optionally per namespace, stored as
  `healthIgnores` in `workspace.json` (opaque to the backend) and synced
  across windows with the rest of the workspace snapshot.
- Opt-in rules are turned on per cluster in the view's "Off by default"
  card, stored as `healthOptIns` (`{ clusterId: ruleId[] }`) next to
  `healthIgnores` and synced the same way. Files without it, or with a
  malformed one, hydrate to "no opt-ins". The only opt-in rule so far is
  `container-privilege-escalation-unset` (info: `allowPrivilegeEscalation`
  not set, the Kubernetes default); an explicit `true` stays the warning
  `container-privilege-escalation`, so its existing ignores keep working.
- `secret-unused` (`config.ts#unusedSecretFindings`) runs only when all
  its lists loaded. Besides pod specs, service accounts, Ingress TLS and
  `Certificate.spec.secretName`, it counts the Secrets that controllers
  read through the API (`secretRefs.ts#controllerSecretRefs`): cert-manager
  `Issuer`/`ClusterIssuer`, Gateway API `Gateway`, Validating/Mutating
  webhook configurations (`cert-manager.io/inject-ca-from-secret`) and Flux
  `GitRepository`, `HelmRepository`, `OCIRepository`, `Kustomization`,
  `HelmRelease` and notification `Provider`. A generic walker reads
  `secretRef` and every `…SecretRef` (Flux `certSecretRef`/`proxySecretRef`,
  cert-manager `privateKeySecretRef`, DNS01 and ACME EAB refs, Vault
  `tokenSecretRef`), `secretName`,
  `certificateRefs[]` (kind Secret or unset) and `kind: Secret` entries of
  `valuesFrom[]`/`substituteFrom[]`; a cluster-scoped referrer without a
  namespace matches the name in any namespace. Each list is watched only
  when its kind is served; an unserved kind counts as loaded and empty.
  cert-manager output (`cert-manager.io/certificate-name`,
  `cert-manager.io/allow-direct-injection`) and Argo CD's own secrets
  (`app.kubernetes.io/part-of=argocd`, `argocd-secret`,
  `argocd-initial-admin-secret`, `argocd-redis`,
  `argocd-notifications-secret`) are skipped outright. `ClusterIssuer` and
  the webhook configurations are cluster-scoped, so a user limited to
  namespaces gets a 403 on them and `secret-unused` is skipped (reported as
  an unreadable list) rather than guessed.
- Tests: Vitest in the node environment
  (`pnpm --filter @kubepit/desktop test`, `src/**/*.test.ts(x)`;
  benchmarks `src/**/*.bench.ts` with `bench`). `health/testing.ts`
  provides `emptyHealthInput()` for scan tests and is never imported by
  app code.
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

## Security (Trivy Operator, Pod Security Standards, RBAC)

The `@security` view (`VIEW_KEYS.security`, Cluster section,
`components/workbench/security/`) has two parts: Trivy Operator reports
and Pod Security Standards per namespace. RBAC "who can" lives in My
Permissions. Everything except the Pod Security dry run is UI-side on top of
the generic watches.

- **Trivy Operator** (`lib/kube/trivy/`): detection is discovery-driven
  (`aquasecurity.github.io`: Vulnerability, ConfigAudit, ExposedSecret,
  RbacAssessment, InfraAssessment, Sbom reports, their cluster-scoped
  variants and ClusterComplianceReports). Without the CRDs the view only
  explains what Trivy Operator is and how to install it. `model.ts` reads
  reports into rows (the scanned object from the operator's
  `trivy-operator.resource.kind|name|namespace` and
  `trivy-operator.container.name` labels; a Deployment's ReplicaSet is shown
  as its Deployment); `summary.ts` computes severity totals counting each
  image once (deduplicated by digest), images and workloads ranked worst
  first, CVE search (id, package, title), failed checks grouped by check id,
  exposed secrets and compliance summaries, all with a fixable-only switch.
  Exposed-secret reports are read as metadata only: the `match` field is
  never read. Reports open in a docked details panel with per-kind sections
  (`details/sections/TrivySections.tsx`: CVE list with installed → fixed
  version and advisory links (https only), checks with remediation,
  compliance controls, SBOM components) and table columns
  (`lib/kube/columns/trivy.tsx`). Workloads and pods get a "Security"
  details section with their reports (`reportsFor`) and the Pod Security
  level their template passes.
- **Pod Security Standards** (`lib/kube/pss/`, pure): the official baseline
  and restricted checks, versioned like `k8s.io/pod-security-admission`
  (checks apply from the version that introduced them; AppArmor fields from
  1.30, `container_engine_t` from 1.31, new safe sysctls, Windows pods exempt
  from Linux-only restricted checks from 1.25; restricted seccomp and
  capabilities override their baseline variants). Reasons and details use
  the API server's wording. `namespacePss` reads the
  `pod-security.kubernetes.io/{enforce,audit,warn}[-version]` labels
  (missing = privileged, unparseable = restricted / latest, like the
  plugin); `evaluateNamespace` evaluates the pod-spec owners of a namespace
  (templates plus bare pods, `owners.ts`) at baseline, restricted and each
  mode's policy. The view lists namespaces with their labels and violation
  counts; the expanded row (and the Pod Security section in namespace
  details, `PodSecurityPanel.tsx`) shows the local evaluation next to
  "what would break if I enforce X".
- **Enforce dry run** (`pod_security.rs`, `pod_security_dry_run`): the enforce
  label change as a merge patch with `dryRun=All`; the `Warning` headers of
  the PodSecurity admission plugin are parsed into violating pods (`pod (and
  N other pods): checks`) and notes. A dry run never persists, so it is
  allowed on read-only clusters (the user still needs `patch` on the
  namespace). Asking for the policy a namespace already enforces sends
  nothing (`unchanged`): the API server only evaluates changes. The server
  checks existing pods; the local evaluation also covers templates whose
  pods were already rejected.
- **Health rules** (`health/podSecurity.ts`, `health/rbac.ts`, catalog
  entries in `health/securityRules.ts`, category security): workloads
  violating their namespace's enforce level (critical; running bare pods
  warning) or its audit / warn level (warning) — only in namespaces that set
  a level, so the generic security-context rules are not repeated — and
  risky RBAC grants, one finding per binding and risk: full admin and
  wildcards, `escalate` / `bind` / `impersonate`, reading Secrets,
  `pods/exec|attach`, `nodes/proxy`, pod creation in kube-system (or
  cluster-wide), and bindings to missing roles (hygiene). Bootstrap and
  platform bindings (`rbac-defaults`, `system:` / `eks:` / `gke:` names,
  add-on manager) and built-in identities are skipped; grants limited to one
  namespace are one severity softer (except kube-system). The scan now also
  reads Namespaces, Roles, ClusterRoles and both binding kinds; forbidden
  lists skip their rules.
- **RBAC who can** (`lib/kube/rbac/`, pure, matching through
  `lib/kube/access.ts`): `buildRbacIndex` normalises subjects
  (`User system:serviceaccount:ns:name` is that ServiceAccount; a
  RoleBinding's ServiceAccount defaults to its namespace); `whoCan` returns
  every subject with the binding → role → rule path of each grant
  (RoleBindings only grant namespaced resources in their namespace;
  name-restricted rules and grants in some namespaces are marked partial;
  non-resource URLs through ClusterRoleBindings); `subjectPermissions`
  summarises what a subject can do per scope and resource, including the
  implicit `system:authenticated` / `system:serviceaccounts[:ns]` groups;
  `risk.ts` classifies grants. UI: "Who can…?" and "What can a subject
  do?" in My Permissions (`access/RbacExplorer.tsx`), a Permissions section
  on ServiceAccounts and Bound subjects on Roles / ClusterRoles.
  `access/useRbacData.ts` watches the RBAC lists cluster-wide (RoleBindings
  fall back to the asked namespace) and reports lists it cannot read instead
  of guessing. A list counts as loaded only when it is complete
  (`data/listState.ts`, shared with the health scan): one that kept the
  rows of the readable namespaces but reports an error is listed with the
  unreadable ones ("answers may be incomplete"). Only RBAC is evaluated:
  webhook and cloud IAM authorizers are not visible to it, which the UI
  says.
- **Demo**: `mock/fixtures/trivy.ts` writes reports for prod-eu, staging and
  dev (not prod-us or the local clusters) from the demo workloads and a
  catalog of real CVEs chosen per image; `mock/fixtures/security.ts` labels
  namespaces, adds a Deployment the enforced baseline blocks, a running bare
  pod that violates it, a hardened workload and risky RBAC grants;
  `mock/podSecurity.ts` plays the admission plugin for the dry run with the
  same checks. Viewer identities can read reports but not RBAC or patch
  namespaces, which shows the degraded paths.

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

## Custom actions

k9s-style plugins: user-defined commands for an object, a multi-selection
or a cluster (`crates/kubepit-core/src/custom_actions/`, settings under
Custom actions).

- **Definitions** (`model.rs`, `actions.json`, backend-owned): name,
  description, icon (fixed lucide set), scopes (`Kind`, `group/Kind`,
  `group/*`, `core/Kind`, `*`, `cluster`), namespace globs, cluster tags,
  command template, mode (`terminal`, `background`, `open-url`), `confirm`,
  `mutating`, shortcut (canonical chord, `lib/keymap.ts`), background
  timeout (≤ 600 s). `custom_actions_save` validates and replaces the whole
  list (order included) and broadcasts `customactions://changed`. A fresh
  data folder reports `initialized: false`; the UI then seeds the built-in
  examples (`lib/customActionExamples.ts`, disabled) in the user's language.
- **Placeholders** (`template.rs`): `{cluster}`, `{context}`,
  `{kubeconfig}`, `{namespace}`, `{name}`, `{kind}`, `{group}`, `{version}`,
  `{resource}`, `{container}`, `{labels.<key>}`, `{annotations.<key>}`,
  `{selection.names}`; any other `{…}` stays literal (jsonpath, go
  templates). Substitution tracks the POSIX `sh` context of each
  placeholder: unquoted and `$( … )` values are single-quoted, values inside
  `"…"` / `'…'` close and reopen the quote around a quoted value, comments
  and `\{…}` / `${…}` stay literal, and backticks, `${…}`, `$'…'` and heredoc
  bodies refuse values that need quoting. Values made of
  `[A-Za-z0-9_.,:=@%+/-]` are inserted bare. URLs percent-encode values and
  must start with `http(s)://` in the template. Tests run hostile values
  (`$(…)`, backticks, quotes, `;`, newlines) through `/bin/sh`.
- **Runs** always resolve the *saved* definition by id in the backend, so
  disabled, out-of-scope and — for `mutating` actions — read-only runs are
  refused whatever the UI sends. `KUBECONFIG` is the cluster's
  `run/<id>.kubeconfig` (`KUBEPIT_CLUSTER`, `KUBEPIT_CONTEXT`,
  `KUBEPIT_NAMESPACE`, `KUBEPIT_ACTION` too). Terminal mode is
  `TerminalSpec::CustomAction`: the login shell runs
  `/bin/sh -c "$KUBEPIT_ACTION_COMMAND"` (POSIX quoting whatever the user's
  shell is) after echoing the command. Background mode
  (`custom_action_run`, `runner.rs`) runs `sh -c` in its own process group
  with a timeout (the whole group is killed) and 256 KiB of stdout / stderr.
  Open-url mode returns the URL for the UI to open. `custom_action_resolve`
  previews a possibly unsaved definition (sample cluster values without a
  cluster) and reports missing and misspelled placeholders. Runs of
  `mutating` actions are recorded in the audit log without their output
  (see Persistent history); the run entry points live in
  `history/audited.rs` around `*_unaudited` implementations here.
- **Import** (`import.rs`, `custom_actions_import`): a file the user picked
  (path) or its text (browser previews). Kubepit's JSON export or a k9s
  `plugins.yaml` / single-plugin file: resource-name scopes become kinds,
  `sh -c` scripts are unwrapped and `$NAMESPACE`, `$NAME`, `$POD`,
  `$CONTEXT`, … become placeholders quote-aware, `background`, `confirm`,
  `dangerous` (→ `mutating`) and `shortCut` map directly. Unmappable
  fields, scopes (`helm`, …) and variables (`$FILTER`, `$COL-*`) come back
  as coded notes the UI translates. Nothing is saved until the user adds
  the actions.
- **UI**: `components/workbench/actions/custom/` turns applicable actions
  into `ResourceAction`s (context menus, details toolbar "More", GitOps
  menus) and multi-select actions (`{selection.names}`) into
  `BulkAction`s, so read-only gating works as for built-ins (ids
  `custom:<id>`, no RBAC needs). `runCustomAction` asks for a container
  when a pod has several, shows the resolved command when `confirm` is set
  (and for mutating actions on production clusters, with the typed name),
  then opens a dock terminal, starts a background run (panel bottom left,
  output dialog, toast) or opens the URL. The palette lists actions for the
  focused table's object, its checked rows and the cluster
  (`palette/customActionItems.ts`). Scope matching in the UI mirrors the
  backend (`lib/customActions.ts`).
- The demo backend (`lib/ipc/mock/customActions.ts`) keeps the list in
  memory, resolves with POSIX quoting, fakes plausible output
  (`kubectl top`, `-o wide`, `neat`, `annotate`) and plays terminal runs;
  `lib/ipc/mock/history.ts` audits mutating runs like the backend.

## Keyboard mode

`Settings.keyboard_mode` (off by default) enables vim / k9s-style keys in
the workbench; the key map is data in `lib/keymap.ts` and shown in the `?`
overlay and Settings → Keyboard.

- `KeyboardHost` (`components/workbench/keyboard/`, mounted once) listens
  on `window` and ignores typing targets (inputs, Monaco, xterm, the dock),
  open dialogs / menus / the palette and the app's global shortcuts. The
  resource table active in the focused pane registers a `TableController`
  (`tableKeyboard.ts`, one line in `ResourcePage`) with a keyboard cursor
  (rendered by `ResourceTable` only in keyboard mode) and a ref to its
  filter.
- Keys: `j`/`k` move (the details follow when open), `g`/`G`, `Enter`
  opens details, `Esc` clears the filter once the details panel and the
  selection bar had their turn, `/` focuses the filter, `l` `s` `e` `r`
  `S` `f` `Ctrl-d` run the existing actions of that row (same RBAC gating,
  read-only and confirmations, `keyCommands.ts`), `y` / `d` open the YAML /
  details tabs, `Ctrl-k` (macOS; `Ctrl-Shift-k` elsewhere, where Ctrl+K is
  the palette) kills a pod (grace period 0, normal confirmation). On macOS
  the global shortcuts now answer to ⌘ only, so ⌃K / ⌃D reach terminals and
  keyboard mode.
- `:` opens the command bar (`commandBarModel.ts`): kinds by name, plural
  or short name (`resolveKindName`) optionally with a namespace, `:ns`,
  `:ctx`, `:q` and pages (`:overview`, `:health`, …), with completion.
- Custom action shortcuts work with keyboard mode off too; the first
  enabled action whose scope matches the current row, the checked rows or
  the cluster runs. Conflicts with global shortcuts, keyboard mode keys and
  other actions are listed in the editor, Settings → Keyboard and the
  overlay; the app and keyboard mode win.

## Performance

A reproducible large-cluster harness (spec
`docs/superpowers/specs/2026-09-28-large-cluster-performance-design.md`,
plan `docs/superpowers/plans/2026-09-28-large-cluster-performance.md`).
Nothing in it contacts a real cluster: Rust runs against the in-process
fake API server on 127.0.0.1 with temp-dir `Paths`, the UI against the
in-memory demo backend.

- **Presets.** `perf/scale-presets.json` defines `s` (1 000 pods, 50
  nodes), `m` (10 000 pods, 500 nodes) and `l` (20 000 pods, 1 000 nodes,
  5 000 services, 200 CRDs). The Rust fixture
  (`crates/kubepit-core/tests/support/scale.rs`: paged, selector-aware,
  metadata-only lists, quiet or bursting watches) and the demo backend
  (`?scale=s|m|l&churn=<pod changes/s>` adds `c-scale-<preset>`,
  `lib/ipc/mock/fixtures/scale.ts`) generate the same objects from it.
- **Suites.** Each writes JSON that `scripts/perf/compare.mjs` reads.
  - `pnpm perf:rust` (`cargo bench -p kubepit-core -- --noplot`):
    Criterion benches in `crates/kubepit-core/benches/` (watch batching,
    metrics history, alerts, change journal, history writer, fleet-search
    matchers, Prometheus/Loki parsing) →
    `target/criterion/<group>/<name>/new/estimates.json`. `e2e.rs` runs
    against the `l` fixture (watch to synced, fleet search, a proxied
    Prometheus query) and writes `target/perf/backend-e2e.json` (peak RSS of
    a child with every background watcher on, and the count of lists
    requested without `limit=`).
  - `cargo test -p kubepit-core --test perf_probe` pins watch streams per
    resource path and the unpaged lists (`-- --ignored` repeats it at `m`
    and `l`).
  - `pnpm perf:bench`: Vitest benches (`src/**/*.bench.ts`, Node) of the
    topology, health, netpol, log and table engines →
    `perf-results/frontend-bench.json`.
  - `pnpm perf:ui -- --preset s|m|l --scenarios ttfr,scroll,apply,map,health,leave [--churn N] [--soak <min>] [--port P] [--out F]`:
    Playwright + Chromium against `vite preview` of the production build
    (`pnpm --filter @kubepit/desktop build` first, and
    `pnpm exec playwright install chromium` once). It drives the dev-only
    in-app probe
    (`lib/perf/`, on only with `?perf=1` or `localStorage['kubepit.perf']`;
    `window.__kubepitPerf`), blocks every request outside the preview
    server and refuses a Tauri page → `perf-results/ui.json`. WKWebView is
    measured by hand with the same probe in `pnpm tauri:dev`.
- **Budgets.** `perf/budgets.json` holds one budget per result id (group,
  value, unit, `max`/`min`, whether it is a timing, `per` for per-line
  budgets, `abs` for drifts), set for the reference machine (Apple
  M-series, macOS, on AC power). Ids listed as `informational` (other
  presets of a budgeted id) print without a budget. The spec's Results
  table records the baseline, which budgets it misses and which gated
  optimizations that fires; a missed budget stays as the target of its
  gated task.
- **Compare.** `pnpm perf:compare -- [--slack N|ci] [--only rust,e2e,engines,ui,structural]`
  prints every budget with its value and exits 1 when one is missed or a
  budgeted result is missing. `--slack` multiplies timing budgets (divides
  `min` budgets); `--slack ci` takes `ci_slack` from the budget file.
  Structural counts, memory and ratios stay exact. Unknown ids only warn.
  Tests: `pnpm perf:test` (`node --test scripts/perf/`).
- **CI.** `.github/workflows/perf-guard.yml` (pull requests and pushes to
  `main`) runs the compare tests, the structural probe
  (`cargo test -p kubepit-core --test perf_probe`), Criterion in quick mode
  (`--warm-up-time 1 --measurement-time 3`) and the Vitest benches, then
  `compare.mjs --slack ci --only rust,e2e,engines,structural`, and uploads
  the results. The compare step is `continue-on-error` until calibrated on
  a runner (the first run after the remote exists): the budgets are set on
  an Apple M-series machine, where three Rust ids already miss, so a runner
  more than ~1.8× slower fails them even at slack 2.5. It moves into
  `ci.yml` as its `perf-guard` job when the CI plan lands.
  `.github/workflows/perf-nightly.yml` (03:00 UTC and manual) builds the UI,
  installs Chromium, runs `perf:ui` at `l` with churn 50 and the 30-minute
  soak, `ttfr,map,health` at `s` and `m`, and
  `compare.mjs --slack ci --only ui`. Neither uses secrets.
