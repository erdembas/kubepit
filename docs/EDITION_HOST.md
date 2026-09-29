# Kubepit edition host and free-feature baseline

Date: 2026-09-30 - Phase: P01 - Status: recorded baseline, NOT a license change or
publication action.

This document records the current build, the free-feature baseline, the proposed
edition-host extension slots, and the fixture-based acceptance scenario for the
Community edition. It is a P01 artifact produced by the RunHQ workflow; it does not
change product code, dependencies, or license declarations.

## 1. Current public-only dependencies

### Rust workspace (Cargo.toml)

| Scope | Crate | Version | Source | License (declared) |
| --- | --- | --- | --- | --- |
| first-party | `kubepit-core` | 0.1.0 | local path | MIT (proposed AGPL-3.0-only) |
| first-party | `kubepit-desktop` (src-tauri) | 0.1.0 | local path | MIT (proposed AGPL-3.0-only) |
| third-party | `kube` | 4.2 | crates.io | MIT |
| third-party | `k8s-openapi` | 0.28 | crates.io | MIT |
| third-party | `tokio` | 1 | crates.io | MIT |
| third-party | `serde` / `serde_json` | 1 | crates.io | MIT OR Apache-2.0 |
| third-party | `rusqlite` | 0.32 (bundled) | crates.io | MIT |
| third-party | `rustls` / `tokio-rustls` | 0.23 / 0.26 | crates.io | Apache-2.0 OR ISC |
| third-party | `hyper` | 1 | crates.io | MIT |
| third-party | `reqwest` | 0.13 | crates.io | MIT |
| third-party | `tauri` + plugins | 2 | crates.io | MIT OR Apache-2.0 |
| third-party | `portable-pty` | 0.8 | crates.io | MIT |
| third-party | `keyring` | 4 | crates.io | MIT OR Apache-2.0 |
| third-party | `notify` | 8 | crates.io | MIT OR Apache-2.0 |
| third-party | `chrono` | 0.4 | crates.io | MIT OR Apache-2.0 |
| third-party | `regex` | 1 | crates.io | MIT OR Apache-2.0 |
| third-party | `flate2` | 1 | crates.io | MIT OR Apache-2.0 OR Zlib |

Full transitive set is in `Cargo.lock` (395 commits, single contributor). No
private Git URL, private crate, or `LicenseRef` appears in the public workspace.

### Node workspace (pnpm-workspace.yaml, package.json)

| Scope | Package | Version | License |
| --- | --- | --- | --- |
| first-party | `@kubepit/desktop` | 0.1.0 | MIT (proposed AGPL-3.0-only) |
| third-party | `react` / `react-dom` | 18.3.1 | MIT |
| third-party | `@tauri-apps/api` + plugins | 2.x | MIT OR Apache-2.0 |
| third-party | `@monaco-editor/react` / `monaco-editor` | 0.56.0 | MIT |
| third-party | `@xterm/xterm` + addons | 6.x | MIT |
| third-party | `zustand` | 5.0.15 | MIT |
| third-party | `tailwindcss` / `@tailwindcss/vite` | 4 | MIT |
| third-party | `vite` | 5.4.11 | MIT |
| third-party | `vitest` | 3.2.4 | MIT |
| third-party | `yaml` | 2.8.1 | MIT |
| third-party | `lucide-react` | 0.577.0 | ISC |
| third-party | `@dnd-kit/*` | 6.x / 10.x / 3.x | MIT |
| third-party | `clsx` / `tailwind-merge` | 2.x / 3.x | MIT |
| third-party | `terser` | 5.51.2 | BSD |
| third-party | `playwright` | 1.55.0 | Apache-2.0 |
| third-party | `prettier` | 3.9.8 | MIT |
| third-party | `typescript` | 5.7.2 | Apache-2.0 |

Full transitive set is in `pnpm-lock.yaml`. No private npm registry, `file:`
link to a private package, or `workspace:*` cross-repo reference appears.

### Zero private package paths

The public dependency inventory has **zero private package paths**.
`pnpm-workspace.yaml` includes only `apps/*`. There is no `packages/` directory
yet (the `@kubepit/edition-contracts` SDK is a P03 deliverable). The Community
build graph requires no private Git URL, private npm package, or private
submodule.

## 2. Launch, assets and capabilities flow

```
main.tsx
  -> initializeDesktopLocale()
  -> installScrollIdleTracker()
  -> installTextInputGuard()
  -> perf probe (?perf=1 -> lazy driver chunk)
  -> ReactDOM.createRoot -> <App/>

App.tsx
  -> i18n.useLocale()
  -> useAppBootstrap()        -- cluster list, settings, kubeconfig watch
  -> useAppShortcuts()        -- keyboard shortcuts
  -> useAlertNotifications()  -- desktop notification policy
  -> useUiZoomShortcuts()     -- zoom
  -> startRecommendationEvents() -- recommendation scan events
  -> <AppShell/>              -- sidebar + workbench + dock + status bar

src-tauri/src/lib.rs::run()
  -> tracing init
  -> text_input::disable_os_typing_helpers()   (WebKit, before webview)
  -> tauri::generate_context!()
  -> UpdaterState::new()  (inert unless pubkey configured)
  -> Builder::default()
      .plugin(dialog, opener, process, clipboard, notification)
      .manage(updater)
      .setup(setup_app)
      .invoke_handler(generate_handler![ 161 commands ])

setup.rs::setup_app()
  -> shell_env::import_login_shell_path()  (kubectl/helm/plugin PATH)
  -> Paths::from_env()  (KUBEPIT_HOME or ~/.kubepit)
  -> Kubepit::open_with_secrets(paths, sink, KeyringSecretStore)
  -> set_alert_monitoring(true)
  -> set_change_journal_recording(true)
  -> set_history_recording(true)
  -> set_ai_remote_providers(true)
  -> set_metrics_sampling(true)
  -> set_recommendation_scans(true)
  -> start_kubeconfig_watch()
  -> TerminalManager::with_exit_hook()
  -> app.manage(AppState { ... })
```

**Assets:** `docs/icon.png`, Tauri bundle icon set, Monaco editor workers
(generated at build), codicon TTF (Monaco). No third-party font or image assets
ship in the binary; Google Fonts CSS is referenced in CSP but loaded at runtime
only (style-src allows fonts.googleapis.com).

**Capabilities / CSP:** `default-src 'self'; img-src 'self' data: asset:
https://asset.localhost; style-src 'self' 'unsafe-inline'
https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com;
worker-src 'self' blob:; connect-src ipc: http://ipc.localhost
http://localhost:1430 ws://localhost:1431`. No external API connect-src beyond
Tauri IPC and the dev server. Bundle identifier: `io.github.erdembas.kubepit`.

**Updater:** inert until a release signing key is configured (`pubkey` empty in
`tauri.conf.json`); see `docs/RELEASING.md`.

## 3. Proposed extension slots

Proposed extension slots against actual components and store unions.

| Extension slot | Current public component / store | Proposed private consumer | Boundary |
| --- | --- | --- | --- |
| Edition host flags | `App.tsx` hooks, `setup.rs` opt-in switches | Commercial assembly overrides feature flags | Runtime config, no public feature flag behind a paywall |
| IPC command registry | `lib/ipc.ts` (162 commands), `ipc/` (161 Rust commands) | New private commands for cloud/team/billing | Separate `ipc/` modules in private crate; public contract stays generic |
| Type union | `types/index.ts` (296 types) | Entitlement, org, seat, profile types | Shared via `@kubepit/edition-contracts` MIT SDK (P03) |
| Store union | 26 Zustand stores (`useAppStore`, `useDockStore`, ...) | `useEntitlementStore`, `useOrgStore`, `useTeamProfileStore` | Private stores import public hooks; no public store depends on private code |
| ClusterDef | `types/index.ts::ClusterDef` (read_only, prometheus, loki, cost, ai) | `cloud_import` metadata, team profile ref | Additive optional fields; `ClusterDef.read_only` preserved |
| Mock backend | `lib/ipc/mock/` (38 files, 52 fixtures) | Fake Paddle, fake IdP, fake provider CLIs | `KUBEPIT_TEST_MODE=fixtures` gates all private tests |
| Secret store | `kubepit_core::secrets::KeyringSecretStore` | `MemorySecretStore` for tests | Public trait; private tests use memory adapter |
| Terminal / PTY | `terminal.rs`, `TerminalManager` | Cloud CLI fake executables | Public PTY pipeline reused; private fake CLIs are test fixtures |
| Resource watch | `watch.rs`, `watchCache.ts` | Team profile sync watches | Public watch infrastructure; private sync is a separate consumer |
| Custom actions | `custom_actions/` | Shared executable action trust gates (D24) | Public action runner; trust bit is a private backend check |

**ClusterDef.read_only** is preserved: mutating backend commands honour it
(`AGENTS.md` Safety section). No extension slot moves existing free
functionality behind a subscription.

## 4. Free workflows inventory

All workflows below are free, account-free, and buildable from the public
repository alone:

| Workflow | Public entry point | Notes |
| --- | --- | --- |
| Manual kubeconfig import (file/paste) | `kubeconfig_parse_file`, `kubeconfig_parse_text`, `cluster_add` | File-backed CA/cert/key embedded; no external dependency |
| Kubeconfig discovery | `kubeconfig_discover` | Scans `KUBECONFIG`, `~/.kube`, sync paths |
| Keychain mode | `kubeconfig_storage_set` | OS credential store for managed kubeconfigs |
| Kubeconfig repair / re-import | `cluster_reimport_kubeconfig` | Replaces source, keeps cluster ID + settings |
| Cluster connect/disconnect | `cluster_connect`, `cluster_disconnect` | One `kube::Client` per cluster |
| Resource watch / list / get / apply / patch / delete | `resource_*` | `read_only` honoured for mutations |
| Helm releases / charts / install / upgrade / rollback | `helm_*` | Shells out to `helm` for mutations |
| GitOps (Argo CD, Flux) | UI-side on generic resource commands | No `argocd`/`flux` CLI dependency |
| Logs (pod, workload, Loki) | `pod_logs_stream`, `workload_logs_stream`, `loki_query_range` | Structured log parsing, xterm mode |
| Debug container | `pod_debug` | Ephemeral containers |
| Pod filesystem | `pod_fs_*` | List, preview, download, upload via exec |
| Terminals (local, pod-exec, node-shell) | `terminalIpc` | PTY pipeline, `KUBECONFIG` per cluster |
| Port forwards | `port_forward_*` | Saved forwards persist across restarts |
| Metrics (metrics-server, Prometheus) | `metrics_*`, `prometheus_*` | Opt-in sampling, detection, tunnel for auth |
| Cost insight and right-sizing | `cost_*`, `rightsizing_*`, `recommendations_*` | Prometheus-based, opt-in scans |
| Upgrade readiness (deprecated APIs) | `upgrade_readiness_scan` | Embedded deprecation table 1.16-1.33 |
| Change journal | `changes_*` | Watched changes, audit log |
| History / audit | `history_*` | SQLite `history.db`, retention policy |
| Alerts | `alerts_*` | Desktop notifications, transition-only |
| Custom actions | `custom_action_*` | Local actions, template expansion |
| AI assistant (BYOK / local) | `ai_*` | Remote providers opt-in; local agents via CLI |
| Local manifests (diff/apply) | `manifests_*` | Plain, Kustomize, Helm chart sources |
| Multiwindow terminals | `window_open` | Shared backend, per-window terminals/watches |
| Mock backend / dev:ui | `lib/ipc/mock/` | In-memory demo for `pnpm dev:ui` |
| Update configuration | `update_*` | Inert until signing key configured |
| Resource wizards | `lib/kube/wizards/` | Form-based create/expose/ingress/secret/etc. |
| Fleet search | `fleet_search` | Cross-cluster metadata-only search |
| Pod security standards | `pod_security_dry_run` | PSS level/version validation |
| Node drain / cordon | `node_cordon`, `node_drain` | Drain plan classification |

## 5. Fixture-based acceptance scenario

A fixture-based acceptance scenario for the Community edition, using no account
state, no real cluster, and no real credentials:

1. **Launch with no account state.** Start `pnpm dev:ui` (browser against the
   in-memory mock backend in `lib/ipc/mock/`). No login, no `KUBEPIT_HOME` with
   existing clusters. The app shell renders with an empty cluster list.

2. **Import a fake kubeconfig.** Call `kubeconfig_parse_text` with a fixture
   kubeconfig containing one context pointing at
   `https://fake-api.kubepit.test:6443` with an inline token. Then `cluster_add`
   with the parsed source. The cluster appears in the sidebar with a `mock`
   badge.

   Original fixture cluster ID and properties:
   - Cluster name: `fake-test-cluster`
   - Server: `https://fake-api.kubepit.test:6443`
   - Context: `fake-context`
   - User: `fake-user` (inline token `fake-token`)
   - `read_only`: `false`
   - `managed`: `true` (imported snapshot)

3. **Repair the fake kubeconfig.** Call `cluster_reimport_kubeconfig` with a
   second fixture kubeconfig that changes the server address to
   `https://fake-api-v2.kubepit.test:6443`. The cluster ID stays the same;
   the connection drops and re-connects to the new address.

4. **Connect only to the fake API server.** Call `cluster_connect`. The mock
   backend's `resources.ts` and `registry.ts` serve fixture pods, deployments,
   nodes and namespaces from `mock/fixtures/`. No real Kubernetes API is
   contacted. The workbench renders the fixture resources.

5. **Reopen the saved session.** Call `workspace_save` (persists layout in
   `workspace.json`), then reload. `workspace_load` restores the pinned tabs,
   split panes and selected cluster. The cluster list is re-read from
   `clusters.json`; the imported cluster is still present with its managed
   kubeconfig in `kubeconfigs/`.

   Fixture cluster IDs after reopen:
   - `fake-test-cluster` (same ID, updated server address from step 3)

**Safety guarantees:** `KUBEPIT_HOME` points at a temp dir. No `~/.kube` access.
No real kube/provider credentials. No real network calls (mock backend is
in-memory). `ClusterDef.read_only` is respected for all mutations.

## 6. Proposed license routes and CLA prerequisites

Recorded from the licensing design
(`reference/docs/superpowers/specs/2026-09-29-commercial-licensing-and-repository.md`).
**No `LICENSE` file or manifest license field is changed in P01.**

| Route | Proposed license | Scope | Status |
| --- | --- | --- | --- |
| Public core | AGPL-3.0-only | `crates/kubepit-core`, `apps/desktop` first-party code | Proposed; current MIT stays until L2 activation |
| Alternative commercial grant | Separate commercial license doc | Same controlled core, for the official combined binary | Proposed; requires ownership verification + legal review |
| Private premium | `LicenseRef-Kubepit-Commercial` | `kubepit-commercial` repo (cloud, team, billing, provider import) | Proposed; private repo, not yet populated |
| MIT SDK | MIT | `packages/edition-contracts` (P03 deliverable) | Proposed; does not exist yet |

**CLA prerequisites:**
- Before accepting outside contributions into dual-licensed core, a CLA with
  alternate-licensing grant rights is required. DCO alone is insufficient.
- Copyright assignment is one possible method; a sufficient license grant is
  also acceptable. Must be reviewed by legal counsel.
- Commercial employee/contractor contributions need separate IP and
  confidentiality arrangements.
- AGPL-only contributions cannot be silently relicensed into the commercial
  build without explicit permission.

**Rights inventory summary (L1):**
- **First-party code:** Erdem Bas (<erdem.bas@mersel.io>), 395 commits, single
  contributor. No outside contributions recorded.
- **RunHQ origin:** The UI design system, tokens, and PTY pipeline originate
  from the RunHQ stack. Provenance to be verified in the ownership audit.
- **Third-party dependencies:** MIT, Apache-2.0, ISC, BSD, Zlib licensed.
  Full list in `Cargo.lock` and `pnpm-lock.yaml`. No AGPL/GPL dependencies
  identified in the current workspace.
- **Assets:** `docs/icon.png` and Tauri bundle icons - provenance to be
  verified. Monaco codicon TTF ships via the `monaco-editor` npm package (MIT).
- **Distribution status:** User states no remote push or outside distribution
  has occurred. Local `LICENSE` = MIT is not evidence of prior distribution.
- **History reset:** Not performed. Not authorized in this workflow. Does not
  resolve copyright, attribution, or existing recipient rights.

**Unresolved rights (recorded in EXTERNAL_GATES.md):**
- RunHQ design system / token / PTY pipeline provenance and license compatibility
- Icon and asset provenance
- Seller entity / jurisdiction for commercial grant
- Legal counsel review of CLA, EULA, ToS, privacy, DPA, trademark
- Paddle seller onboarding and sub-$10 quote approval
- No history reset performed or authorized
