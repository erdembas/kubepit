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
  window label that saved `workspace.json`), `portforward://saved`
  (SavedPortForward[]), `kubeconfig://changed` (KubeconfigChanged).

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
| `port_forwards.json`    | backend  | `SavedPortForward[]` (saved port forwards)          |

With `settings.keychain_kubeconfigs` the pasted kubeconfigs live in the OS
credential store instead of `kubeconfigs/` (see Connectivity).

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

## Diffs

Every diff (apply review, rollout revisions, Helm revisions, compare and
drift) renders through `components/workbench/common/DiffView.tsx` on top of
Monaco's diff editor, with `lib/diff.ts` (Myers line diff) for stats and the
fallback view.

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
