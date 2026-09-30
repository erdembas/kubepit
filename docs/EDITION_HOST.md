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
| third-party | `kube` | 4.2 | crates.io | Apache-2.0 |
| third-party | `k8s-openapi` | 0.28 | crates.io | Apache-2.0 |
| third-party | `tokio` | 1 | crates.io | MIT |
| third-party | `serde` / `serde_json` | 1 | crates.io | MIT OR Apache-2.0 |
| third-party | `rusqlite` | 0.32 (bundled) | crates.io | MIT |
| third-party | `rustls` / `tokio-rustls` | 0.23 / 0.26 | crates.io | Apache-2.0 OR ISC OR MIT |
| third-party | `hyper` | 1 | crates.io | MIT |
| third-party | `reqwest` | 0.13 | crates.io | MIT |
| third-party | `tauri` + plugins | 2 | crates.io | MIT OR Apache-2.0 |
| third-party | `portable-pty` | 0.8 | crates.io | MIT |
| third-party | `keyring` | 4 | crates.io | MIT OR Apache-2.0 |
| third-party | `notify` | 8 | crates.io | MIT OR Apache-2.0 |
| third-party | `chrono` | 0.4 | crates.io | MIT OR Apache-2.0 |
| third-party | `regex` | 1 | crates.io | MIT OR Apache-2.0 |
| third-party | `flate2` | 1 | crates.io | MIT OR Apache-2.0 OR Zlib |

Full transitive set is in `Cargo.lock` (396 commits, single contributor). No
private Git URL, private crate, or `LicenseRef` appears in the public workspace.

### Rust workspace — weak copyleft and other license categories

The table above lists only permissive licenses. The full `Cargo.lock` transitive
set also includes these license categories, classified from lockfile metadata:

| Category | Crates (selected) | License | Runtime or build-time |
| --- | --- | --- | --- |
| Weak copyleft (file-level) | `cssparser`, `selectors`, `dtoa-short`, `lightningcss` (npm) | MPL-2.0 | Runtime (`cssparser`/`selectors` via `markup5ever`/`scraper`-like chain); `lightningcss` via Vite build |
| Weak copyleft (file-level) | `option-ext` (via `dirs` → `dirs-sys`) | MPL-2.0 | Runtime (`dirs` used for `KUBEPIT_HOME` path resolution) |
| Data license | `caniuse-lite` (npm) | CC-BY-4.0 | Build-time (browserslist/Vite) |
| Data license | `webpki-root-certs` | CDLA-Permissive-2.0 | Runtime (TLS trust store) |
| Data license | `icu_collections`, `icu_*` | Unicode-3.0 | Runtime (i18n data via `icu_*`) |

MPL-2.0 requires modified MPL-licensed files to be redistributed under MPL; it
does not infect the whole binary. CC-BY-4.0 and CDLA-Permissive-2.0 are data
licenses with attribution requirements. Unicode-3.0 is a permissive data license.
Legal interpretation of distribution obligations for each category is an external
gate (G03); the technical classification above is from lockfile metadata only.

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
(generated at build), codicon TTF (Monaco). Third-party agent provider brand
logos (`apps/desktop/src/assets/agents/{claude,codex,cursor,opencode}.svg`) are
bundled in the binary; their trademark and copyright belong to the respective
providers — provenance and attribution status pending (G02). JetBrains Mono
font is loaded at runtime from Google Fonts (`index.html`: OFL-1.1 license,
external request to `fonts.googleapis.com`). No other third-party font or image
asset ships in the binary.

**Capabilities / CSP:** `default-src 'self'; img-src 'self' data: asset:
https://asset.localhost; style-src 'self' 'unsafe-inline'
https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com;
worker-src 'self' blob:; connect-src ipc: http://ipc.localhost
http://localhost:1430 ws://localhost:1431`. No external API connect-src beyond
Tauri IPC and the dev server. Bundle identifier: `io.github.erdembas.kubepit`.

**Updater:** inert until a release signing key is configured (`pubkey` empty in
`tauri.conf.json`); see `docs/RELEASING.md`.

## 3. Proposed extension slots

Proposed extension slots mapped to actual public components, store types and Rust
host hooks. The edition host design (commercial-desktop-design.md §"React and
Vite") defines versioned registries for: Settings pages, Add cluster tabs,
account/status slots, palette entries, cluster metadata badges, read-only
configuration contributions and terminal renderers.

| Extension slot | Current public component / store / hook | Proposed private consumer | Boundary |
| --- | --- | --- | --- |
| Settings pages | `SettingsView.tsx`, `SettingsCategory` union (`store/types.ts:41-52`: general, kubeconfig, terminal, notifications, history, assistant, custom-actions, keyboard, tools, about) | Commercial settings categories (billing, team, cloud) via edition host registry | Additive category IDs; no public category removed |
| Add cluster tabs | `ClusterEditor.tsx`, `KubeconfigFields.tsx`, `PrometheusFields.tsx`, `CostFields.tsx`, `LokiFields.tsx` | Cloud provider discovery tab | Additive tab; manual import stays free |
| Account/status slots | `MainTab` union (`store/types.ts:15-24`: dashboard, cluster, settings, ai-guide, port-forwards, search, activity) | Account/profile tab via edition host | Additive `MainTab` variant; no free tab removed |
| Palette entries | `CommandPalette.tsx` (`components/palette/`), `paletteItems.tsx` | Cloud/team commands in palette | Additive palette items; existing commands unchanged |
| Cluster metadata badges | `ClusterDef` tags/environment/color in `types/index.ts` | `cloud_import` origin badge | Additive optional fields; `ClusterDef.read_only` preserved |
| Read-only config contributions | `setup.rs` opt-in switches, `App.tsx` hooks | Commercial feature flags via host config | Runtime config; no public flag behind paywall |
| Terminal renderers | `terminal.rs`, `TerminalManager`, `terminal/mod.rs` (PTY pipeline) | Cloud CLI fake executables as private terminal specs | Public PTY pipeline reused; private fake CLIs are test fixtures |
| IPC command registry | `lib/ipc.ts` (162 commands), `ipc/` (161 Rust commands) | Private commands via `plugin:kubepit-commercial\|<cmd>` | Separate plugin handler; core handler stays installed once |
| Store union | 16 Zustand stores (`useAppStore`, `useDockStore`, `useWorkbenchStore`, `useAssistantStore`, `useHealthStore`, `useRecommendationsStore`, `useConnectivityStore`, `useAlertStore`, `useAccessStore`, `useBookmarksStore`, `useCustomActionsStore`, `useExplainStore`, `useFleetSearchStore`, `useSavedViewsStore`, `useUpdaterStore`, `useUpgradeStore`) | `useEntitlementStore`, `useOrgStore`, `useTeamProfileStore` (private) | Private stores import public hooks; no public store depends on private code |
| Rust host hooks | `lib.rs::run()` (configure/run API), `setup_app()` (post-core-setup), window-destroy, shutdown | Commercial init hook receives `Arc<Kubepit>` + approved host services | Core `AppState` init precedes commercial hook; shutdown cancels premium jobs first |
| Mock backend | `lib/ipc/mock/` (39 files, 54 fixtures) | Fake Paddle, fake IdP, fake provider CLIs | `KUBEPIT_TEST_MODE=fixtures` gates all private tests |
| Secret store | `kubepit_core::secrets::KeyringSecretStore` | `MemorySecretStore` for tests | Public trait; private tests use memory adapter |
| Resource watch | `watch.rs`, `watchCache.ts` | Team profile sync watches | Public watch infrastructure; private sync is a separate consumer |
| Custom actions | `custom_actions/` | Shared executable action trust gates (D24) | Public action runner; trust bit is a private backend check |

**Type union boundary:** Entitlement, org, seat, billing, provider and profile
DTOs stay in the **private** `packages/contracts` and `packages/desktop-ui/src/types.ts`.
They do **not** enter the public MIT SDK (`@kubepit/edition-contracts`). The SDK
describes only small edition host interfaces (registry shapes, slot IDs), not
subscription internals or provider implementations. No paid DTO enters public
implementation code.

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

Two independent traces: one for the Rust core against a loopback fake API server,
one for the browser mock backend. Neither uses account state, real clusters or
real credentials.

### Trace A — Rust core (loopback fake server)

Existing infrastructure: `crates/kubepit-core/tests/support/mod.rs:122-123` starts
a `FakeServer` on `127.0.0.1:0`. `connectivity.rs:74` opens `Kubepit::open` with
a temp `KUBEPIT_HOME`. `connectivity.rs:358` already exercises import and reimport.

1. **Temp home, no existing clusters.** Create a temp dir, set
   `KUBEPIT_HOME` to it. `Kubepit::open(paths, events)` starts with no clusters.
   No `~/.kube` access.

2. **Import a fake kubeconfig.** Start `FakeServer` on `127.0.0.1:0`. Parse a
   fixture kubeconfig whose server URL is the fake server's bound address with an
   inline token. Call `cluster_add`. The cluster appears with a generated ID.

3. **Repair (reimport).** Call `cluster_reimport_kubeconfig` with a second
   fixture kubeconfig changing the server URL to a second `FakeServer` on
   `127.0.0.1:0`. The cluster ID stays the same; the source is replaced.
   Reference: `connectivity.rs:358` (existing import/reimport test).

4. **Connect.** Call `cluster_connect`. The fake server serves fixture resources.
   No real Kubernetes API is contacted.

5. **Reopen.** Drop `Kubepit`, re-open with `Kubepit::open` on the same
   `KUBEPIT_HOME`. The cluster is re-read from `clusters.json`; the imported
   cluster is still present with its managed kubeconfig in `kubeconfigs/`.

### Trace B — Browser mock backend (`pnpm dev:ui`)

The mock backend (`lib/ipc/mock/app.ts`) is in-memory only; it does not contact
any server. On launch it seeds six demo clusters:

| Seeded ID | Name | `read_only` | Environment |
| --- | --- | --- | --- |
| `c-prod-eu` | prod-eu-west-1 | true | production |
| `c-prod-us` | prod-us-east-1 | false | production |
| `c-staging` | staging-gke | false | staging |
| `c-dev` | dev-shared | false | development |
| `c-kind` | kind-kubepit | false | local |
| `c-minikube` | minikube | false | local (disconnected) |

1. **Launch.** `pnpm dev:ui` renders the app shell with the six seeded clusters.
   The cluster list is **not** empty.

2. **Import a fake kubeconfig.** Call `kubeconfig_parse_text` with a fixture
   kubeconfig, then `cluster_add`. The mock generates an ID of the form
   `c-${crypto.randomUUID().slice(0,8)}` (`app.ts:509`), not a caller-chosen ID.
   The new cluster appears with `managed: true` and platform
   `['kind', 'v1.32.2', 'https://127.0.0.1:6443']` (`app.ts:552`). No `mock` badge
   exists in the codebase.

3. **Repair (reimport).** Call `cluster_reimport_kubeconfig`. The mock replaces
   the source and sets the cluster status to `disconnected` (`app.ts:492-500`);
   it does not auto-reconnect.

4. **Persistence on reload.** The mock stores only `settings` and `workspace` in
   localStorage (`app.ts:225-239`, `:429-441`). The cluster list (`let clusters`)
   is in-memory only. On reload, imported clusters are lost; only the six seeded
   clusters reappear. `clusters.json` and `kubeconfigs/` are Rust backend paths,
   not used by the browser mock.

**Safety guarantees:** `KUBEPIT_HOME` points at a temp dir (Trace A). No
`~/.kube` access. No real kube/provider credentials. No real network calls (fake
server is loopback; mock is in-memory). `ClusterDef.read_only` is respected for
all mutations.

## 6. Proposed license routes and CLA prerequisites

Recorded from the licensing design
(`docs/superpowers/specs/2026-09-29-commercial-licensing-and-repository.md` in
the public repo).
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
- **First-party code:** 396 commits, all authored and committed by
  `erdembas <erdem.bas@mersel.io>` (corporate domain `mersel.io`).
  `Cargo.toml` authors field: `erdembas@users.noreply.github.com`. `LICENSE`:
  "Erdem Baş". No outside contributions recorded. The corporate email domain
  creates an employer/IP scope question: verification that the contributor has
  rights to license this code under both AGPL and commercial grant is an external
  gate (G08). A single copyright line is not proof of ownership.
- **RunHQ origin:** The PTY pipeline (`terminal/mod.rs:3`, `terminal.rs:3`) is
  described as "RunHQ's, reused as-is". The UI design system, tokens
  (`src/styles/theme.css`), UI primitives (`src/components/ui/`), xterm theme
  (`xtermTheme.ts`) and Monaco theme (`monacoTheme.ts`) originate from the
  RunHQ stack. `AgentProviderLogo.tsx:4-5` states agent SVG logos "retain the
  original MIT license and attribution", but no NOTICE or attribution file
  exists in the repo. `README.md:15` links to `github.com/erdembas/runhq`.
  RunHQ may have been previously distributed under MIT; if so, attribution and
  license-transition obligations apply. Provenance and license compatibility
  verification is an external gate (G01, file-level).
- **Third-party dependencies:** Permissive (MIT, Apache-2.0, ISC, BSD, Zlib),
  weak copyleft (MPL-2.0), data licenses (CDLA-Permissive-2.0, Unicode-3.0,
  CC-BY-4.0) and font license (OFL-1.1 via Google Fonts). Full list in
  `Cargo.lock` and `pnpm-lock.yaml`. No AGPL/GPL dependencies identified in the
  current workspace. Legal classification of each category is G03.
- **Assets:** `docs/icon.png` and Tauri bundle icons — provenance pending (G02).
  Third-party agent provider brand logos
  (`assets/agents/{claude,codex,cursor,opencode}.svg`) — trademark/copyright
  belong to respective providers, provenance pending (G02). Monaco codicon TTF
  ships via `monaco-editor` npm (MIT). JetBrains Mono font loaded at runtime from
  Google Fonts (OFL-1.1).
- **Public git history:** The public repo tracks commercial planning content:
  `docs/superpowers/{plans,specs}/2026-09-29-commercial-*.md` (pricing, Paddle,
  seat and operations details), `exports/runnerhq/kubepit-commercial.zip`,
  `exports/runnerhq/kubepit-commercial/**`, `exports/runnerhq/build-commercial-workflow.py`.
  These should be moved to the private repo before first public push; they
  remain in git history (G07). `git tag -l` and `git remote -v` are empty (no
  tags, no remotes configured).
- **Distribution status:** User states no remote push or outside distribution
  has occurred. Local `LICENSE` = MIT is not evidence of prior distribution.
- **History reset:** Not performed. Not authorized in this workflow. Does not
  resolve copyright, attribution, or existing recipient rights.

**Unresolved rights (recorded in EXTERNAL_GATES.md):**
- G01: RunHQ design system / token / PTY pipeline / theme provenance (file-level)
- G02: Icon, asset, agent logo and font provenance
- G03: Full third-party dependency license audit (legal interpretation)
- G07: Commercial content in public git history; history reset (not authorized)

Seller entity, jurisdiction, Paddle onboarding, CLA/EULA/ToS/privacy/DPA and
trademark review are private commercial gates recorded in the private repo's
`EXTERNAL_GATES.md`. This public document records only the edition boundary.
