# Cloud import and local clusters: design

> **Historical design:** The [2026-09-29 commercial strategy](2026-09-29-open-core-commercial-strategy.md)
> separates paid private cloud-provider discovery/import from free local-cluster
> lifecycle. The CLI behavior and credential protections below remain useful inputs;
> the new commercial desktop/cloud specifications own implementation placement and access.

Status: draft for review · Date: 2026-09-28 · Plan: `docs/superpowers/plans/2026-09-28-cloud-import-and-local-clusters.md`

## Problem

Kubepit can add a cluster in two ways. It can discover contexts in kubeconfig files the
user already has (`DiscoverDialog`), or the user can paste a kubeconfig (`ClusterEditor`).
Two situations are not covered:

- **Cloud clusters without a kubeconfig.** Getting an EKS, GKE or AKS cluster into a
  kubeconfig means running `aws eks update-kubeconfig`, `gcloud container clusters
  get-credentials` or `az aks get-credentials` by hand. Each profile, project or
  subscription needs its own run, and every run rewrites `~/.kube/config`. Users with
  many accounts do this over and over.
- **Throwaway local clusters.** kind, k3d and minikube each have their own CLI flags, and
  each one writes into `~/.kube/config`.

## Goals

1. Discover EKS, GKE and AKS clusters through the user's own CLIs (`aws`, `gcloud`, `az`)
   across the profiles, regions, configurations and subscriptions the user picks.
   Discovery streams progress and reports errors per scope.
2. Import the chosen clusters into Kubepit-managed kubeconfigs, through the existing
   managed path (`kubeconfigs/<id>.yaml`, or the OS keychain in keychain mode).
   **`~/.kube/config` and every other user kubeconfig are never written.**
3. Handle exec auth plugins (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`), several
   accounts, and expired SSO or login sessions. When a login is needed, Kubepit opens a
   terminal that runs the provider's login command.
4. Create, delete, start and stop kind, k3d and minikube clusters from the UI. The options
   are Kubernetes version, node count, port mappings and a local registry. CLI output
   streams into a dock terminal, and the result is registered as a Kubepit cluster.
5. Turn `DiscoverDialog` into an **Add cluster** hub with tabs for kubeconfig files,
   cloud providers and local clusters.

## Non-goals

- Talking to cloud APIs directly (no AWS, GCP or Azure SDKs, no credentials held by
  Kubepit).
- Creating or deleting *cloud* clusters.
- Background polling of cloud accounts. Discovery runs only on request.
- A kind registry. kind needs a separate registry container plus a containerd patch, so
  the option is disabled for kind with a hint.
- kind start and stop. kind has no supported restart; the actions are hidden for kind.
- Windows-specific login flows beyond running the same CLI commands.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Credentials come from **the provider CLIs' own kubeconfig writers**, pointed at a private temp file: `aws eks update-kubeconfig --kubeconfig F --alias CTX`, `gcloud container clusters get-credentials` with `KUBECONFIG=F`, and `az aks get-credentials --file F`. `KUBECONFIG=F` is also set for aws and az as a second guard. | The CLI stays authoritative for the exec-plugin stanza (apiVersion, args, env). Kubepit does not have to track changes in each provider's auth format. |
| D2 | The temp file lives in a private directory `run/import-<uuid>/` (mode 0700, file 0600). It is removed on drop, whether the import succeeds or fails. The generated file goes through `kubeconfig::load` and then `single_context` before it is registered as a **managed** kubeconfig via `store_managed`, which is keychain-mode aware. | This reuses the one managed-kubeconfig path, so keychain mode, `run/<id>.kubeconfig` and removal behave exactly as they do for pasted kubeconfigs. |
| D3 | A new `ClusterDef.origin` / `ClusterInput.origin` records where a cluster came from: `eks`, `gke`, `aks` or `local`, plus its identity. Imports are **idempotent by origin**: importing again replaces the managed kubeconfig of the existing cluster instead of adding a duplicate. | This gives a "refresh credentials" path, marks clusters as "already added" in the lists, and lets local start/stop/delete find the registered cluster. |
| D4 | Tools are resolved with `tools::find_executable(name, settings.tool_paths.get(name))`. `Settings.tool_paths` is a new map keyed by a fixed list: `aws`, `gcloud`, `az`, `gke-gcloud-auth-plugin`, `kubelogin`, `kind`, `k3d`, `minikube`. Child processes get the resolved tool's directory prepended to `PATH`. | This mirrors `kubectl_path` / `helm_path`. SDK installs outside `PATH` (for example `~/google-cloud-sdk/bin`) keep working. Tests point overrides at fake scripts, which is the Helm-test pattern, and never mutate the process `PATH`. |
| D5 | Every CLI call runs non-interactively: stdin is null; `AWS_PAGER=""`, `AWS_CLI_AUTO_PROMPT=off`, `CLOUDSDK_CORE_DISABLE_PROMPTS=1`, `AZURE_CORE_NO_COLOR=1`, `--only-show-errors`. Timeouts are 60 s for list and describe calls and 120 s for credential generation. | A hidden prompt must never hang an IPC call. |
| D6 | Failures are classified into `CloudErrorKind`: `tool-missing`, `login-required`, `access-denied`, `not-found`, `timeout` or `failed`. The CLI's stderr is kept verbatim (trimmed to 4 KiB) in `detail`, and the UI translates only the kind. | This follows the existing "codes the UI translates, data verbatim" pattern. Login-required errors get a **Sign in** action. |
| D7 | Login runs in a PTY through a new `TerminalSpec::CloudLogin { provider, account }`. The **backend** builds the argv: `aws sso login --profile P`, `gcloud auth login [ACCOUNT]` or `az login [--tenant T]`. The UI never sends a command line. | The browser and device-code flows need a real terminal. A fixed argv keeps this from becoming a command-injection channel. |
| D8 | Discovery streams one event per scope over a `Channel` (`CloudDiscoveryEvent`), with at most 4 concurrent scopes, and can be cancelled (`cloud_discover_cancel`). A scope is an AWS profile and region, a gcloud configuration (its account and project), or an Azure subscription. | This is the same shape as `fleet_search`. One slow region never blocks the others. |
| D9 | EKS regions default to the profile's configured region. The UI can add more from an embedded `EKS_REGIONS` list (dated in a comment). | Calling `ec2 describe-regions` needs credentials and one extra call per profile. The list changes rarely. |
| D10 | Exec-plugin checks run after generation. When the context's `users[].user.exec.command` is not resolvable, the import still succeeds and returns a warning (`exec-plugin-missing`, with the command). When the command is only reachable through a `tool_paths` override, the managed copy gets the absolute path. For GKE, Kubepit adds `CLOUDSDK_ACTIVE_CONFIG_NAME=<configuration>` to the exec env. For AKS clusters with `aadProfile`, Kubepit runs `kubelogin convert-kubeconfig -l azurecli --kubeconfig F`; if `kubelogin` is missing, the result carries a `kubelogin-missing` warning. | Connections authenticate the way the user's shell would. A GKE cluster keeps using the account it was discovered with even when the user switches the active gcloud configuration. |
| D11 | Local cluster operations run **in a PTY in a dock terminal** through `TerminalSpec::LocalCluster { op_id }`. The UI first asks the backend for a validated plan (`local_cluster_plan`). The backend keeps the argv; the terminal only references the `op_id`. Each operation is a single program invocation (no shell, so it works on every OS): minikube's registry is `--addons=registry` and k3d's is `--registry-create`. | kind and minikube print progress spinners that belong in a terminal. A single exec avoids per-OS shell quoting. |
| D12 | Completion is **backend-driven**. The desktop shell's terminal exit hook calls `Kubepit::local_cluster_terminal_exited(terminal_id, code)`. On success this fetches the kubeconfig (kind: the private file passed as `--kubeconfig`; k3d: `k3d kubeconfig get NAME`; minikube: the private file set as `KUBECONFIG`), then registers or updates the cluster (idempotent by origin). A `localcluster://done` event follows. `local_cluster_register` adopts an existing, unregistered kind or k3d cluster (kubeconfig on stdout), which is also the recovery path when a window closed mid-run. A minikube cluster is adopted by running a `start` op, because minikube only writes kubeconfigs. | Registration does not depend on a window staying open. |
| D13 | Terminals with no cluster open in a **Local dock** on the Dashboard: the reserved dock id `@local` in `useDockStore`, rendered by `ClusterDock` with a `local` flag that hides the cluster-only buttons. | Docks are per cluster today (`ClusterDock` is only rendered in `ClusterWorkbench`), and cloud login or local create has no cluster yet. |
| D14 | Deleting or stopping a local cluster that is registered as `read_only` is refused in the backend (`ReadOnlyError`). Delete also needs a typed-name confirmation in the UI (`ConfirmDialog confirmWord`). Creating a local cluster and importing from the cloud touch no existing cluster, so they are allowed. | Honours `ClusterDef.read_only` for mutating commands. |

## Architecture

```
UI (Add cluster hub)                    kubepit-core                                   user CLIs (fakes in tests)
─────────────────────                   ───────────────────────────────────           ───────────────────────────
Cloud tab ── cloud_accounts ──────────▶ cloud::accounts ─ CliRunner ──────────────▶ aws configure list-profiles …
          ── cloud_discover(onEvent) ─▶ cloud::discover (TaskRegistry, ≤4) ───────▶ aws eks list/describe, gcloud … list, az aks list
          ◀─ CloudDiscoveryEvent ─────
          ── cloud_import ────────────▶ cloud::import: PrivateTempDir → CLI writes F → load → single_context
                                        → exec checks → register_managed(origin) → store_managed (file | keychain)
          ── terminal(cloud-login) ───▶ prepare_terminal → Exec(aws sso login …)
Local tab ── local_clusters_list ─────▶ local_clusters::list ────────────────────▶ kind get clusters, k3d cluster list -o json, minikube profile list -o json
          ── local_cluster_plan ──────▶ validate, build argv, LocalClusterOps.insert(op)
          ── terminal(local-cluster) ─▶ prepare_terminal → bind terminal_id → Exec(kind create cluster …)
src-tauri exit hook ──────────────────▶ local_cluster_terminal_exited → fetch kubeconfig → register_managed → EventSink::local_cluster_done
          ◀─ localcluster://done ─────
```

New core modules: `cloud/` (`types.rs`, `cli.rs`, `errors.rs`, `aws.rs`, `gcp.rs`,
`azure.rs`, `regions.rs`, `discover.rs`, `import.rs`) and `local_clusters/` (`mod.rs`,
`kind.rs`, `k3d.rs`, `minikube.rs`, `ops.rs`). Provider files hold pure argument builders
and output parsers; I/O stays in `cli.rs`, `discover.rs`, `import.rs` and `ops.rs`.

## UX

- **Add cluster hub** (the old Discover dialog, `size="lg"`). It has a left rail that turns
  into a top `Tabs` strip under a container width of about 560 px:
  - *Kubeconfig files*: today's discover list, moved unchanged.
  - *AWS EKS*, *Google GKE*, *Azure AKS*: tool status, account multi-select (plus regions
    for AWS), **Discover**, then results grouped by scope. Each group shows a spinner, its
    clusters, or an error row. A `login-required` row gets a **Sign in** button, which
    opens the Local dock terminal and rediscovers that scope when the terminal exits. The
    shared footer has environment (guessed from the name), tags and a target section.
    Rows already imported are marked "Already added"; importing them again refreshes
    their credentials. The import button reads "Import {count} cluster(s)".
  - *Local*: kind, k3d and minikube with tool status and the existing clusters (state,
    nodes, version, registered or not). Row actions are open, start, stop, delete and
    "Add to Kubepit". **Create** opens a form with provider, name, Kubernetes version,
    node count, port mappings and registry port. The form validates the same rules as the
    backend. Submitting opens the dashboard's Local dock with the CLI running.
- Toasts report `localcluster://done` (success opens the new cluster's card; failure shows
  the error). Exec-plugin warnings show in the import result list and as a note on the
  cluster card until the next connect succeeds.
- Settings → Tools lists the new tools with the detected path, version and an override
  input (same `row` helper as kubectl and helm).
- All new text is in English and Turkish. Provider and product names, CLI commands,
  regions, cluster names and CLI output are never translated.

## Contract changes (`types/index.ts` ⇄ `types.rs`/`cloud/types.rs`, `ipc.ts` ⇄ `src-tauri/src/ipc/cloud.rs`)

- `ClusterDef.origin?: ClusterOrigin | null` and `ClusterInput.origin?: ClusterOrigin | null`,
  where `ClusterOrigin` is tagged on `kind`:
  - `eks {profile, region, name, arn}`
  - `gke {configuration, project, location, name}`
  - `aks {subscription, resource_group, name}`
  - `local {provider, name}`
- `Settings.tool_paths: Record<string, string>`.
- `TerminalSpec` gains `cloud-login {provider, account}` and `local-cluster {op_id}`.
- Commands:
  - `cloud_tools_status`
  - `cloud_accounts(provider)`
  - `cloud_discover(request, onEvent)` and `cloud_discover_cancel(discoveryId)`
  - `cloud_import(requests)`
  - `local_clusters_list`
  - `local_cluster_plan(request)`
  - `local_cluster_register(provider, name)`
- Event: `localcluster://done` (`LocalClusterDone`).
- The demo backend gets `mock/cloudImport.ts` and `mock/localClusters.ts` (fake accounts;
  streaming discovery with one `login-required` scope; imports that add demo clusters;
  terminal playback for the two new specs).

## Security and safety

- User kubeconfigs are never written. Every CLI gets an explicit private target, either
  `--kubeconfig`/`--file` or `KUBECONFIG`. Tests make the fake CLIs **fail unless the
  target is inside the test's `run/` directory**. That proves no call can fall back to
  `~/.kube/config`.
- Kubepit never stores cloud credentials. Imported kubeconfigs usually hold exec stanzas
  only. When one embeds a secret (for example an AKS local-account client key), it goes
  through the managed store: a 0600 file, or the keychain in keychain mode.
- Private temp directories are 0700 and removed on drop. Tests assert that `run/` holds no
  `import-*` leftovers.
- Login and local-cluster terminals execute argv built by the backend from validated
  fields. Account, profile and cluster names are passed as separate arguments and never
  through a shell. Names are checked with `^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}$`
  (accounts) and `^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$` (local clusters).
- `read_only`: see D14. No background work is started by any of this. Discovery,
  listing and import run on request only. The exit-hook completion only fires for
  terminals the user opened.
- Tests never run a real `aws`, `gcloud`, `az`, `kind`, `k3d` or `minikube`, never connect
  to a real cluster or cloud account, and never read real user files. They use the fake
  CLI harness, the fake API server, `Paths::new(tempdir)` and `MemorySecretStore`.

## Testing strategy

- **Rust unit tests** in each provider module cover argument builders and output parsers,
  using fixtures copied from real CLI JSON shapes with names changed.
- **Rust integration tests** (`tests/cloud_import.rs`, `tests/local_clusters.rs`) use
  `tests/support/fake_cli.rs`, a generalised `FakeHelm`. It writes named `#!/bin/sh`
  scripts that log argv and relevant env into `calls.log`, print canned output selected by
  marker files, and write kubeconfigs that point at the fake API server. `tool_paths` point
  at the scripts. The tests cover accounts, streaming discovery with a failing scope,
  login classification, import into file and keychain storage, idempotent re-import, exec
  warnings, the GKE env pin, AKS kubelogin conversion, temp cleanup, local plans and
  validation, read-only refusal, terminal completion registering or removing clusters,
  and adopting existing clusters.
- **Frontend unit tests** (Vitest, added by the plan if missing) cover the pure hub
  helpers in `lib/cloud/model.ts`: grouping events, the "already added" key, and
  local-cluster validation that mirrors the backend.
- **Manual smoke:** `pnpm dev:ui` in English and Turkish walks each tab against the demo
  backend.

## Rollout

The feature ships behind no flag. It changes nothing for existing clusters, since
`origin` defaults to `null`. Docs: a new ARCHITECTURE.md section, the persistence table
(`tool_paths`), and a README feature bullet.

## Open questions

1. Should imported cloud clusters go into a section named after the provider by default,
   or stay unassigned (the plan keeps today's behaviour: the section the user picks)?
2. The GKE account pin via `CLOUDSDK_ACTIVE_CONFIG_NAME` in the exec env needs a check
   against a real `gke-gcloud-auth-plugin` before release. Fallback: no pin, plus a note.
3. Do we want a kind registry (a `registry:2` container plus a containerd patch) in a
   follow-up?
4. Do we want "Refresh credentials" on the cluster card for cloud clusters (a re-import
   by origin), or is re-importing from the hub enough?
