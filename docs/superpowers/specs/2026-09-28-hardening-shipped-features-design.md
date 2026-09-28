# Hardening of shipped features — design

- **Date:** 2026-09-28
- **Status:** proposed
- **Plan:** `docs/superpowers/plans/2026-09-28-hardening-shipped-features.md`
- **Base:** `main` at `c8d7ff2` (includes the `feat/cost` merge)

## Problem

Features shipped over the last branches (health checks, resource map, local
manifests, Prometheus/Loki/cost, alerts, security, upgrade readiness, Helm
preview, history) have a list of known gaps. Each one is small. Together they
make Kubepit noisy on real clusters, slow in a few views, and silent about
permissions. The test harness also has gaps that let regressions through.

## Goals

- Fix every verified gap, each pinned by a test that fails before the fix.
- Group fixes by subsystem so each task is reviewable on its own.
- Add the frontend unit-test runner these fixes need. No frontend tests exist
  today: no vitest or jest, and no `*.test.*` files.

## Non-goals

- New features beyond what a gap needs.
- Performance work beyond the two concrete regressions listed here: the Map
  tab's cluster-wide watches and the slow exit from the Resource Map. The
  400-node map cap and all scale work move to the large-cluster performance
  plan (`2026-09-28-large-cluster-performance`).
- Native, per-OS notification click handling (see D10).

## Verification of the reported items

Every item was checked against the code at `c8d7ff2`. None was already fixed.
Three new defects turned up during verification and are included (marked
*found*). Two items came from the orchestrator (marked *added*).

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | "allowPrivilegeEscalation not set" is noisy | Confirmed | `lib/kube/health/containers.ts:141-161`. One rule id (`container-privilege-escalation`) covers both "set to true" (warning) and "unset" (info). `RuleDef` (`rules.ts:11-21`) cannot turn a rule off by default. |
| 2 | Unused-Secrets rule flags controller-read secrets | Confirmed | `config.ts:92-161`. It only counts pod specs, SA secrets, Ingress TLS and cert-manager `Certificate.spec.secretName`. Gateways, webhook configurations, Issuers and Flux objects are not read. |
| 2b | *found*: `secret-unused` ignores its own `needs` | Confirmed | `engine.ts:64` gates the ConfigMap and Secret loops with `needsMet('configmap-unused')`. A forbidden ServiceAccount or Ingress list therefore produces false positives. |
| 3 | Details Map tab of a cluster-scoped object watches everything | Confirmed | `MapTab.tsx:17-25` returns `[]` (all namespaces) for Node, StorageClass, ClusterRole and similar kinds. `useTopologyData.ts:44-49` then starts 29 slot watches cluster-wide, including Secrets, ConfigMaps and EndpointSlices. |
| 4 | Leaving the Resource Map takes over a second | Confirmed (by code) | Views stay mounted (`ViewPanes.tsx:160-176`), so "leaving" means `isActive=false`. The 29 `stop()` calls change the snapshot `status` (`watchCache.ts:95-106`). Status is part of the rebuild key (`useTopologyData.ts:56-58`), so `buildTopology` and `deriveView` re-run on the way out. `hideKinds` (`view.ts:175-195`) costs O(hidden × edges). |
| 5 | Manifests "Watch" polls every 2 s | Confirmed | `ManifestsView.tsx:35-36, 126-145` polls `manifests_fingerprint` (`manifests/mod.rs:137-143`). |
| 6 | Prometheus missing from the add-cluster flow | Confirmed (Loki and cost too) | `ClusterEditor.tsx:363-373` renders Prometheus, Loki and Cost fields only when editing. `ClusterInput` (TS `types/index.ts:92-108`, Rust `types.rs:76`) has no such fields. `cluster_add` hard-codes defaults (`cluster.rs:144-146`). |
| 7 | Missing `services/proxy` permission not explained | Confirmed | `PrometheusState` and `LokiState` (`types.rs:1303, 1502`) have no forbidden state, so a 403 shows as "unreachable" with the raw message. `CostStatus` falls back to an estimate silently. The cost `is_proxy_failure` comment says "forbidden", but the code only matches 404, 502 and 503 (`cost/mod.rs:119-127`). |
| 8 | Manifests apply has no RBAC gating | Confirmed | `dock/manifests/` has no `useAccess`, `useCan` or `accessCheck` call. Only `read_only` is gated. |
| 9 | Desktop notification click only focuses the app | Confirmed | `lib/alerts/notify.ts:42-57` drops `onClick` on desktop. `tauri-plugin-notification` 2.4.0 supports actions on mobile only ("The Actions API is only available on mobile platforms", v2.tauri.app/plugin/notification). |
| 10 | Alert settings not broadcast between windows | Confirmed | `settings_set` (`src-tauri/src/ipc/app.rs:20-24`) emits nothing. The only workaround is `useAlertNotifications.ts:37-40`, which re-reads settings on each delivery. |
| 11 | Changes header wraps badly | Confirmed | `ChangesPage.tsx:255-317`: a fixed `h-12` row with no wrap, no container query, a `w-56` search field and a long recording label. |
| 12 | Details tab strip overflows at minimum width | Partly fixed | Commit `c332a8f` added `overflow-x-auto`. Still missing: scrolling the active tab into view (tab requests usually target the right-most tabs), wheel-to-horizontal scrolling, and the hidden scrollbar used by the other strips (`main-tabbar-scroll`). `overlay-scroll` has no effect on a horizontal strip. The panel minimum is 380 px (`useWorkbenchStore.ts:53`), and the 7 tabs need about 600 px. |
| 13 | "Add RoleBinding" checks permission cluster-wide | Confirmed | `actions/access.ts:112` uses `{ namespace: ns }`, and `ns` is null for a ClusterRole. The wizard itself binds in `namespace` (`wizardActions.ts:66-85`). |
| 14 | Upgrade table lacks 1.30/1.31/1.33 | Correct by design; coverage not explicit | The official deprecation guide (fetched 2026-09-28) lists removals only for v1.16, 1.22, 1.25, 1.26, 1.27, 1.29 and 1.32. All of them are in `deprecated_apis.json` (52 entries), and `v1 Endpoints` (deprecated in 1.33) is present. Missing: a way to state "checked, nothing removed", and a self-test for it. |
| 15 | Helm preview cannot show fields a new chart drops | Confirmed | `helm_preview.rs:539-594`. The live check is an SSA dry run as manager `kubepit`, which never removes Helm-owned fields (`UpgradeChanges.tsx:273-275` says so). The data for a three-way answer is already in `HelmPreviewObject`: `before` (old render), `after` (new render) and `live.live`. |
| 16 | Loki `X-Scope-OrgID` untested end to end | Confirmed | The fake server's `Request` (`tests/support/mod.rs:20-25`) keeps no headers. `request.rs:273` only unit-tests `tenant_headers()`. |
| 17 | Resource Map 400-node cap | Deferred | Moved to the performance plan (gated task "Resource Map cap"), which has the benchmarks to choose a new cap. |
| 18 | Guard that no background watcher starts unless opted in | Confirmed gap; the known offender is not a watcher | `git log` shows no trace of the flaky test. Only alerts have a guard (`tests/alerts.rs:323`). The metrics sampler is **not** opt-in: it lists `metrics.k8s.io` nodes and pods every 15 s after any connect (`metrics_history.rs:369`, `connection.rs:254`). This breaks the "background work opt-in per process" rule. |
| 19 | *added*: mutating entry points bypassing the audit log | Confirmed | `custom_action_run` for `mutating` actions (`custom_actions/mod.rs:275`) and mutating terminal-mode actions (`prepare_custom_action_terminal`) are not audited. GitOps actions go through `resource_patch`, and wizards through the create editor's `resource_apply_yaml`, so both are already audited. |
| 20 | *added*: inconsistent money formatting | Confirmed | `formatMoney` (`lib/cost.ts:11-31`) with `compact: true` uses standard notation up to 10 000 but allows one decimal (`maximumFractionDigits: compact ? 1 : 0`), so "$5,669.3" appears next to "$7,969". |
| 21 | *found*: an error batch drops its objects | Confirmed | `watchCache.ts:108-112` returns early when `batch.error` is set. The backend puts an error into the same batch as pending upserts, deletes and `reset` (`watch.rs:205-247`), so one forbidden namespace in a multi-namespace watch can drop the other namespaces' rows. |

## Decisions

**D1. Frontend test runner.** Add Vitest `^3.2` as a dev dependency of
`@kubepit/desktop`. Vitest 3 supports the pinned Vite 5, and Vitest 4 does
not. `vitest.config.ts` reuses the `@` alias. Tests are colocated
`src/**/*.test.ts(x)` files and run in the `node` environment, with no jsdom.
Pure logic is tested directly. The two layout fixes (D11) pin their class
contract through `react-dom/server`'s `renderToStaticMarkup`. The runner is
test tooling, not a UI library, so the RunHQ rule is not affected. Command:
`pnpm --filter @kubepit/desktop test`. If the CI plan lands first with the same
runner, Task 1 skips its setup steps.

**D2. Opt-in health rules.**
- `RuleDef` gains `optIn: boolean`, default false. The privilege-escalation
  rule is split in two:
  - `container-privilege-escalation`: severity warning, emitted only when the
    field is `true`.
  - `container-privilege-escalation-unset`: severity info, `optIn: true`.
- Per-cluster opt-ins live next to the ignores in the workspace snapshot, as
  `healthOptIns?: Record<ClusterId, string[]>`, synced across windows like the
  ignores.
- Findings of opt-in rules are computed but silenced, unless the rule is on
  for the cluster, in `summarize` and in the details banner (`isSilenced`).
  This keeps the engine pure and makes turning a rule on instant.
- Existing ignores of `container-privilege-escalation` keep silencing the
  explicit case.

**D3. Unused Secrets reads controller references.**
- The Secret loop moves into `unusedSecretFindings`, gated by
  `needsMet('secret-unused')`, which fixes 2b.
- New optional reference lists join the health scan. Each is watched only when
  its kind is served; unserved kinds count as loaded and empty, as
  `certificates` already does. The lists:
  - cert-manager `Issuer`, `ClusterIssuer`;
  - Gateway API `Gateway`;
  - `ValidatingWebhookConfiguration`, `MutatingWebhookConfiguration`;
  - Flux `GitRepository`, `HelmRepository`, `OCIRepository`, `Kustomization`,
    `HelmRelease`, notification `Provider`.
- A generic walker records Secret names under these keys: `secretRef`,
  `certSecretRef`, `secretName`, `privateKeySecretRef`, `certificateRefs[]`
  (entries whose kind is `Secret` or unset), and
  `valuesFrom[]` / `substituteFrom[]` entries with `kind: Secret`. Namespaces
  follow each API's defaulting: the object's own namespace, or the ref's
  `namespace` when present. It also records the
  `cert-manager.io/inject-ca-from-secret` annotation on webhook
  configurations.
- Secrets are skipped outright when they are annotated
  `cert-manager.io/certificate-name` (cert-manager output) or
  `cert-manager.io/allow-direct-injection`, labelled
  `app.kubernetes.io/part-of=argocd`, or are one of Argo CD's well-known
  secrets (`argocd-secret`, `argocd-initial-admin-secret`, `argocd-redis`,
  `argocd-notifications-secret`).
- These skips add to the existing ones: service-account tokens, Helm
  releases, bootstrap tokens, owned objects, system namespaces and Argo repo
  or cluster secrets.

**D4. Map tab scope for cluster-scoped roots.** No backend selector support is
added. A pure planner, `planMapScope`, picks per slot one of three scopes:
cluster-wide (`[]`), a namespace list, or `null` (not watched).
- A root has one seed kind, watched cluster-wide (the key other views
  already share):
  - Node → Pods with `spec.nodeName`;
  - StorageClass → PVCs with `spec.storageClassName`;
  - ClusterRole → RoleBindings whose `roleRef` names it;
  - IngressClass → Ingresses with `spec.ingressClassName`.
- Every other namespaced slot is scoped to the namespaces of the matching
  seed objects. Cluster-scoped slots are watched as before.
- Roots with no seed watch no namespaced slots. Namespaced slots also stay
  unwatched until the seed has synced, so they never fall back to
  cluster-wide.

**D5. Cheap exit from the Resource Map.**
- The topology rebuild key uses each slot's `version`, `synced` and
  `forbidden`, not `status`.
- `useTopologyData` returns its last model while disabled.
- `hideKinds` becomes linear using an adjacency index.
- Target: leaving the view costs under 200 ms. It is verified with a Chrome
  performance recording in `pnpm dev:ui`, on prod-eu-west-1 with all
  namespaces.

**D6. Manifests watch via `notify`.**
- New streaming commands, `manifests_watch(source, onEvent)` returning an id,
  and `manifests_unwatch(id)`, replace the 2 s poll and the
  `manifests_fingerprint` command.
- Core `manifests/watch.rs` watches the resolved root recursively, plus the
  parent directories of values files, non-recursively. It debounces 300 ms,
  recomputes the fingerprint, and emits `ManifestsWatchEvent { watch_id,
  fingerprint }` only when the fingerprint changes.
- The watch runs as a `TaskRegistry` task under cluster id `""`, like fleet
  search. Aborting the task drops the watcher.
- Limitation, documented: Kustomize bases outside the root are not watched.

**D7. Observability settings when adding a cluster.**
- `ClusterInput` gains optional `prometheus`, `loki` and `cost`. They are
  `#[serde(default)]` in Rust and normalized with the same normalizers
  `cluster_update` uses.
- The editor shows the three field groups in add mode too.
- The field components accept `clusterId: ClusterId | null`: no status lookup
  runs before the cluster exists.

**D8. A `forbidden` state for service-proxy sources.**
- `PrometheusState` and `LokiState` gain `Forbidden` (wire value
  `forbidden`). `CostStatus` gains `forbidden: bool`.
- `service_proxy::is_proxy_forbidden(err)` matches an `ApiError` with code
  403 and reason `ServiceProxy`.
- The state rules:
  - Forbidden when every probed candidate answered 403.
  - Available when any candidate answered.
  - Unreachable otherwise.
- Forbidden is cached like the other negative answers (5-minute recheck,
  "Detect again" forces a recheck).
- One UI component, `ProxyForbiddenNotice`, serves UsageMetrics, the PromQL
  tab, the Loki tab and the Cost view. It names the verb, resource and
  namespace, shows the API server's message verbatim, and offers the copyable
  command `kubectl auth can-i get services/proxy -n <ns>`. Commands are not
  translated.

**D9. RBAC gating for manifests apply.**
- Each (document, target) cell that would be applied gets checks: `patch` on
  the resolved resource (namespace and name), plus `create` when the cell is
  new. The plural resource is resolved through discovery.
- `planApply` excludes cells whose checks are denied and counts them. The
  apply button names the count, and a target whose every cell is denied shows
  a lock.
- Unknown answers never block, following the access model.

**D10. Notification click-through.**
- Native per-OS handling is out of scope. It would mean bypassing the plugin
  with three implementations: `mac-notification-sys` / UNUserNotificationCenter
  (which needs a signed bundle), WinRT activation, and D-Bus actions.
- Instead, when the notifier window posts an OS notification while Kubepit is
  not focused, it remembers that notification's target. If a Kubepit window
  gains focus within 10 s, it opens that target (the alert, or the
  notification center for a group). Clicking a notification focuses Kubepit,
  so on all three OSes a click opens the alert.
- Documented limitation: bringing Kubepit to the front by other means within
  10 s does the same.

**D11. Narrow-pane layouts.**
- The Changes header adopts the established container-query pattern:
  `@container` root, `min-h-12 flex-wrap` header, a shrinking title, a
  recording label hidden below `@2xl`, and a `w-full min-w-0 @lg:w-56`
  search. This follows `ActivityView.tsx:129-187`.
- The details tab strip:
  - scrolls the active tab into view;
  - maps vertical wheel movement to horizontal scrolling through a shared pure
    helper, `horizontalWheelDelta`;
  - uses `main-tabbar-scroll` (hidden scrollbar), like `ViewTabStrip`.

**D12. Add RoleBinding checks the target namespace.** The ClusterRole and Role
action sets an explicit `access` of
`accessCheck('create', RoleBinding, { namespace })`, using the namespace the
wizard binds in. No `bind` check is added: holding the role's permissions is
an equally valid path, and it cannot be checked cheaply.

**D13. Explicit coverage in the deprecation table.**
- `deprecated_apis.json` gains two fields:
  - `checked_through`: the newest minor whose deprecation guide or release
    notes were checked;
  - `no_removals`: minors checked and found to remove nothing.
- A self-test requires every minor from 1.16 through `checked_through` to be
  either some entry's `removed_in` or listed in `no_removals`, never both.
- `UpgradeReport` gains `table_checked_through`. The readiness view says so
  when the target is newer than that.

**D14. Fields a chart drops in the Helm preview.**
- `HelmPreviewObject` gains `dropped_fields: string[]`. These are the paths
  present in the old render, absent from the new render, and still present
  live. That is what Helm's three-way merge removes.
- They are computed with the change journal's keyed-list walker: list items
  are keyed by `name` or `mountPath`, with the same path syntax the Changes
  view shows.
- The review lists them per object and counts them in the header.

**D15. Fake-server request headers.** `support::Request` gains
`headers: Vec<(String, String)>`, with lowercase names, and
`header(name) -> Option<&str>`. The performance plan uses the same interface.

**D16. Metrics sampling is opt-in per process.**
`Kubepit::set_metrics_sampling(bool)` works like `set_alert_monitoring`, and
`setup.rs` enables it. A guard test connects with defaults and asserts that
only `GET /version` and `GET /apis` reach the fake server within 1.5 s. It
then enables each flag and asserts that flag's traffic appears, so the guard
is proven able to fail.

**D17. Auditing custom actions.**
- New `AuditAction::CustomAction` (wire value `custom-action`).
- Audited wrappers in `history/audited.rs` cover:
  - background runs of `mutating` actions: outcome from the exit code and
    timeout; stdout and stderr are never stored;
  - terminal launches of `mutating` actions: recorded at launch with the
    result "started in a terminal".
- The stored command is re-rendered from the template with every
  `annotations.*` value (and, for secret-like target kinds, every `labels.*`
  value) replaced by the history redactor's markers.
- Non-mutating and open-url actions are not audited.
- A src-tauri guard test parses `generate_handler!` in `lib.rs`. Every
  registered command must be classified. Every mutating command's body must
  call a core method that is defined in `history/audited.rs`.

**D18. One money formatter.**
`formatMoney(value, currency, { compact?, signed? })` follows one rule:
- the amount is rounded to cents first;
- below 1 000: two decimals;
- from 1 000: no decimals;
- with `compact`, from 1 000 000: compact notation with at most one decimal
  (`$1.2M`);
- `signed` uses `signDisplay: 'exceptZero'`;
- non-finite values count as 0;
- unknown currency codes fall back to `<number> <code>` with the same fraction
  rule.

`formatUnitPrice` (four decimals) stays for unit prices. The cost view,
overview card, dashboard fleet total and right-sizing deltas all use
`formatMoney`. The right-sizing panel drops its hand-built `−`/`+` prefix and
uses `signed`.

**D19. Error batches keep their objects.** `WatchEntry.apply` applies `reset`,
upserts and deletes first, then records the error. The status becomes `error`
only when the batch leaves no synced data. Otherwise the snapshot keeps its
rows and carries `error` and `forbidden` for the banner.

## Architecture and contract changes

| Area | Change |
|------|--------|
| `types/index.ts` + `ipc.ts` | `WorkspaceSnapshot.healthOptIns?`; `ClusterInput.prometheus?/loki?/cost?`; `PrometheusState`/`LokiState` + `'forbidden'`; `CostStatus.forbidden`; `ManifestsWatchEvent`, `ipc.manifestsWatch/manifestsUnwatch` (and `manifestsFingerprint` removed); `SettingsChanged`, `events.onSettingsChanged` (`settings://changed`); `HelmPreviewObject.dropped_fields`; `UpgradeReport.table_checked_through`; `AuditAction` + `'custom-action'` |
| Rust `kubepit-core` | `ClusterInput` fields; `PrometheusState::Forbidden`, `LokiState::Forbidden`, `CostStatus.forbidden`, `service_proxy::is_proxy_forbidden`; `manifests/watch.rs`; `HelmPreviewObject.dropped_fields`, `change_journal::diff::dropped_paths`; `deprecations::table_checked_through`, `no_removals`; `Kubepit::set_metrics_sampling`; `AuditAction::CustomAction`, custom-action audited wrappers |
| `src-tauri` | `manifests_watch`/`manifests_unwatch` (and `manifests_fingerprint` removed); `settings_set` and `kubeconfig_storage_set` emit `settings://changed`; `setup.rs` enables metrics sampling; `ipc/audit_coverage.rs` guard test |
| Demo backend | Mirrors each contract change (`mock/app.ts`, `mock/manifests.ts`, `mock/prometheus.ts`, `mock/loki.ts`, `mock/cost.ts`, `mock/helmPreview.ts`, `mock/upgrade.ts`, `mock/history.ts`) |

## UX

All strings ship in English and Turkish.

- Health view: an "Off by default" card lists opt-in rules, with Turn on /
  Turn off per cluster.
- Service-proxy sources show a permission notice instead of "unreachable".
- The manifests apply button explains denied cells, and target headers show a
  lock.
- The upgrade view notes when the target is past `checked_through`.
- The Helm review lists "Helm will remove these fields".
- Settings → Notifications explains the click behaviour.
- The Activity view shows "Custom action" entries.

Layouts use container queries, 11–13 px text and the existing primitives.

## Safety

- Tests use the fake API server and temp dirs (`KUBEPIT_HOME`, or explicit
  `Paths`). No real cluster is contacted.
- Mutations stay behind `read_only` in the backend. Mutating custom actions
  are still refused on read-only clusters before any audit entry is written
  (the refusal is not recorded, like other read-only refusals).
- Audit entries never contain command output or annotation values.

## Testing strategy

- Rust: unit tests next to the code, plus fake-server e2e tests in
  `crates/kubepit-core/tests/`: `loki.rs`, `prometheus.rs`, `cost.rs`,
  `manifests.rs`, `helm_preview.rs`, `history.rs`, a new `background.rs`, and
  `fleet.rs`.
- src-tauri: the audit coverage guard and the `SettingsChanged` payload.
- Frontend: Vitest unit tests for every pure change. The two layout fixes use
  SSR class assertions.
- Visual checks in `pnpm dev:ui`: the Changes view at about 560 px wide, the
  details panel at 380 px, and the Resource Map exit timing.

## Rollout

Tasks land in plan order on one branch. Task 1 adds Vitest, and Task 17 adds
fake-server headers; later tasks and the performance plan rely on both.
Recommended order across plans: this plan first, then the performance plan.

## Open questions

1. D10 is a heuristic. Do you prefer documentation only, with no focus-based
   click-through?
2. D3 adds up to 11 small optional watches to the health scan on clusters that
   serve cert-manager, Gateway API, webhooks and Flux. Is that acceptable, or
   should Flux references be limited to `GitRepository` and `Kustomization`?
3. D13: should recently graduated beta APIs be added once their removals are
   scheduled? The guide does not list DRA `resource.k8s.io` betas,
   ValidatingAdmissionPolicy `v1beta1` or VolumeAttributesClass `v1beta1` yet.
4. D6 removes `manifests_fingerprint`. Keep it for scripting?
