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
  window label that saved `workspace.json`).

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
| `kubeconfigs/<id>.yaml` | backend  | pasted kubeconfigs (`managed: true`), mode 0600     |
| `run/<id>.kubeconfig`   | backend  | single-context kubeconfig for kubectl/helm/terminal |

Kubepit never rewrites a user's kubeconfig files.

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
