# Commercial desktop implementation plan

Status: proposed · Date: 2026-09-29 · Planning only; nothing below has been run.

**Goal:** Ship paid Team cloud profiles and AWS EKS / GKE / AKS discovery/import
at USD 3/user/month or USD 30/user/year while keeping the existing complete
Kubernetes IDE and manual kubeconfig workflows free and independently buildable.

**Architecture:** Public MIT edition contracts, reusable React bootstrap and
Tauri host; a private repository pins public source and compiles a private UI
package and native Tauri plugin into the official signed application. Rust owns
auth, entitlement verification, safe CLI execution and profile synchronization.
The companion commercial-cloud plan owns service auth, organizations, teams,
seats, billing, profile storage and online authorization.

**Spec:** `docs/superpowers/specs/2026-09-29-commercial-desktop-design.md`.

**Execution convention:** This uses Superpowers-style scoped tasks, dependencies,
checkboxes and red/green verification. No Superpowers execution skill is
available in this session; this document does not invent a required subskill.
An executor can use the available tools and independent workers where useful.
Do not create repositories, change licenses, deploy, purchase services or commit
merely because a planning step mentions the eventual operation.

## Roots, constraints and verification commands

All paths below are repository-relative and prefixed with `PUBLIC/` or
`PRIVATE/`. During implementation `PUBLIC/` is a writable public checkout;
`PRIVATE/` is the new private `kubepit-commercial` repository. Its
`vendor/kubepit/` pins a public revision and must never receive local source
patches. “Create” paths do not exist yet. Avoid altering old historical plans
while implementing new tasks; this spec/plan supersedes their premium placement.

- The proposed initial public core license is AGPL-3.0-only; independently
  implemented edition SDK/contracts are MIT. The official combined private
  binary requires an alternative commercial grant for all included controlled
  core plus rights/CLA and dependency-license sign-off. The existing MIT files
  are observed local state; the user says no version was distributed. This
  planning task changes neither licenses nor Git history. No paid DTO, provider
  adapter, account key or service dependency enters public implementation.
- Free includes everything currently shipped and all manual kubeconfig
  workflows. Future kind/k3d/minikube lifecycle belongs to free core and is
  separately scheduled, not implemented as premium in these tasks.
- Public frontend/backend changes update `apps/desktop/src/types/index.ts`,
  `lib/ipc.ts` and corresponding Rust together where applicable. Private changes
  pair `packages/desktop-ui/src/types.ts` / `ipc.ts` with Rust `types.rs` /
  `ipc.rs`. The plugin prefix is `plugin:kubepit-commercial|`.
- Private UI uses `@commercial/`; `@/` retains public source meaning. Preserve
  RunHQ tokens/primitives and EN/TR catalogs. No UI/chart library.
- Service feature IDs are `team_profiles`, `cloud_import`; fresh entitlement
  is 24h and the total offline horizon is last authoritative validation + 7d,
  capped by paid-through. Live service authorization still applies online.
- `PRIVATE/packages/contracts/src/commercial-policy.ts` is the shared constants
  source. Wire JSON is snake_case, API timestamps ISO-8601, JWS timestamps
  NumericDate; ES256 uses fixed service issuer and `kubepit-desktop-pro` audience.
- Test with injected temp paths, fake CLI executables, fake servers/clocks and
  `MemorySecretStore`. Never read real `~/.kube`, real provider credential files
  or run real cloud tools against accounts. No actual login, purchase or deploy.
- Every persistent change has a staged write/recovery path. Imported credentials
  and existing free workflows survive expiry, logout and organization removal.
- Routine focused checks run per task. Run full suites at integration milestones
  or after relevant failures, not redundantly after every documentation edit.

The public baseline commands are:

```bash
pnpm typecheck
pnpm i18n:check
pnpm test:ui
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --filter @kubepit/desktop build
```

Task 5 creates equivalent private scripts: `pnpm typecheck`, `pnpm i18n:check`,
`pnpm test:ui`, `pnpm test:contract`, `pnpm build:desktop`,
`pnpm dev:ui`, `pnpm tauri:build:local`; private Cargo commands use the
private workspace. Commands shown before those scripts exist are implementation
targets, not evidence that checks already pass. Public `pnpm dev:ui` remains
the existing network-free in-memory demo. Private `pnpm dev:ui` uses an explicit
test/demo mode that cannot issue auth, billing or cloud requests.

## Ordering and ownership

```text
1 → 2 → (3, 4) → 5 → (6, 7)
7 → 8 → 9 → 10                       account/entitlement slice
6 + 7 → 11 → (12, 13) → 14 → 15 → 16 → 17   cloud slice
6 + 7 → 18 → 19 → 20 → 21 → 22 → 23 → 24 → 25   team slice
9 is required before paid launch/commit gates in 14–17 and 22–25
service contract fixtures are required before 8, 9, 22 and 26
all slices → 26 → 27 → 28
```

Tasks 3/4, provider adapters 12/13 and cloud/team pure helpers can run in
parallel if file ownership is separate. One integrator owns shared contracts,
public native service interfaces and final release boundaries. The companion
service plan can progress against committed contract fixtures; it does not
wait for the finished desktop UI. No implementation task includes automatic
Git commits or release publication.

### Task 1: Record the current build and free-feature baseline

**Files:** Read `PUBLIC/docs/ARCHITECTURE.md`, `Cargo.toml`,
`pnpm-workspace.yaml`, `apps/desktop/{package.json,vite.config.ts,tsconfig.json}`,
`apps/desktop/src/{main.tsx,App.tsx}`, `apps/desktop/src-tauri/src/{lib.rs,setup.rs}`.
Create `PUBLIC/docs/EDITION_HOST.md` and a private boundary decision record when
the private repository is authorized/available.

- [ ] Record current public-only dependencies and launch/assets/capabilities
      flow; list proposed extension slots against actual components and store unions.
- [ ] Inventory free workflows including manual import, keychain mode,
      kubeconfig repair, multiwindow terminals, mock backend and update configuration.
- [ ] Capture the baseline public checks above; distinguish pre-existing failures
      from new regressions without fixing unrelated user changes.
- [ ] Define a fixture-based acceptance scenario: launch with no account state,
      import and repair a fake kubeconfig, connect only to the fake API server, and
      reopen the saved session. Record original fixture cluster IDs and properties.
- [ ] Record the proposed AGPL core/alternative commercial grant/private premium/
      MIT SDK routes, rights inventory and CLA prerequisites from the licensing
      design. Do not edit `LICENSE`, assume rights over RunHQ/third-party code or
      reset history. Flag unknown provenance before composition work.

**Verify:** All baseline results recorded; the public dependency inventory has
zero private package paths. Expected: no new product code or external requests.

### Task 2: Define the public edition contracts

**Files:** Create `PUBLIC/packages/edition-contracts/{package.json,src/index.ts,
src/registry.ts,src/registry.test.ts}`; update `PUBLIC/pnpm-workspace.yaml` to
include `packages/*`; create `PUBLIC/apps/desktop/src/edition/{host.ts,types.ts}`.

- [ ] Write tests for duplicate registration, contract version mismatch,
      deterministic order, namespaced IDs, disposal and missing optional slots.
- [ ] Define a versioned `EditionDefinition` for Settings/Add cluster/palette/
      status contributions, typed configuration selectors and terminal rendering.
      Keep org/seat/billing/provider/profile DTOs out of this package.
- [ ] Replace no existing default behavior; an empty host must return the
      current core UI and avoid timers/network calls.
- [ ] Define unknown persisted edition-page handling and component error
      boundaries without making every existing tab an unchecked string.
- [ ] Document compiled-edition trust: no dynamic JavaScript or native plugin
      downloads, arbitrary RPC bridge or extension marketplace.

**Verify:** Public `pnpm typecheck`, focused registry Vitest and workspace install
with public inputs only. Expected: empty edition behavior remains identical.

### Task 3: Extract reusable frontend mount and additive locale support

**Files:** Create `PUBLIC/apps/desktop/src/bootstrap.tsx`,
`src/edition/{EditionHost.tsx,slots.ts}`, `src/i18n/edition.ts` and tests;
modify `src/main.tsx`, `components/app/AppShell.tsx`,
`components/settings/SettingsView.tsx`, `components/discover/DiscoverDialog.tsx`,
`store/types.ts`, `components/palette/` and `scripts/check-i18n.mjs` as needed.

- [ ] Add meaningful tests for mount/dispose lifetime, singleton locale/store
      usage, invalid edition registration and unrecognized restored page IDs.
- [ ] Move guard/locale/bootstrap setup into `mountDesktop` while keeping public
      `main.tsx` a default caller; install effects once and dispose edition listeners.
- [ ] Add the narrow registry outlets. Leave the existing kubeconfig pane first
      and usable with no edition and no account. Keep Settings navigation typed.
- [ ] Implement namespace-specific typed catalogs sharing core locale state;
      forbid overriding public message keys and validate placeholder parity.
- [ ] Add EN/TR for public host error/fallback labels in their owned catalogs;
      preserve public `MessageKey` checking and the current checker defaults.

**Verify:** Public TS/i18n/UI suites and production build. Demo smoke in EN/TR:
Settings, discover, palette, saved tabs and multiwindow-compatible bootstrap.

### Task 4: Extract the reusable Tauri shell API

**Files:** Modify `PUBLIC/apps/desktop/src-tauri/src/{lib.rs,setup.rs,app_state.rs,
windows.rs}`, `build.rs`; create `src/edition.rs` and host lifecycle tests.

- [ ] Write tests/harness assertions for core setup once, ordered extension
      initialization, core invoke dispatch preservation and shutdown on failures.
- [ ] Expose configure/run-with-context functions. The default `run()` still
      creates the public context; the private caller can supply its own context.
- [ ] Accept static plugins and post-core-setup/window-destroy/shutdown hooks;
      pass typed host services rather than exporting private `Store` fields.
- [ ] Preserve updater registration rules, all existing core commands, AppState
      ownership, terminal cleanup, watch cleanup and assistant cancellation.
- [ ] Review build-script/capability generation so using the shell as a path
      dependency cannot override the caller's Tauri config or embedded assets.

**Verify:** Public Cargo fmt/clippy/tests, public Tauri debug build against the
demo/fixture environment. Expected: one handler, one AppState, normal cleanup.

### Task 5: Prove private composition with a harmless sample edition

**Files:** Create in `PRIVATE/`: `Cargo.toml`, `pnpm-workspace.yaml`, lockfiles,
`vendor/kubepit` pin, `apps/desktop-commercial/{package.json,vite.config.ts,
tsconfig.json,src/main.tsx,src-tauri/{Cargo.toml,build.rs,tauri.conf.json,
capabilities/default.json,src/main.rs}}`, `packages/desktop-ui/`,
`crates/kubepit-commercial/{Cargo.toml,build.rs,src/lib.rs,src/plugin.rs,
permissions/}`, scripts and CI build-spike workflow.

- [ ] Pin the public revision; configure private path dependencies and exclude
      the nested public workspace from private membership. Resolve a single Tauri
      graph and propagate `custom-protocol` correctly.
- [ ] Use private caller-owned `generate_context!`, register one statically
      compiled plugin, and add one harmless namespaced `edition_status` command.
- [ ] Private Vite keeps `@` on public source, adds `@commercial`, deduplicates
      React/ReactDOM/Zustand and scans both source trees for Tailwind classes.
- [ ] Add a sample EN/TR Settings page using a core primitive; ensure Monaco,
      xterm, assets, CSS and core invoke calls still work. No billing logic yet.
- [ ] Create private script equivalents listed above and a stub-only demo that
      rejects network, real CLI launches and real account data.
- [ ] Build on macOS/Linux/Windows CI; inspect packaged asset/config identity
      and generated capabilities. Do not proceed with a copy-source workaround.

**Verify:** Both public and private production frontend/Cargo builds pass from
clean checkouts. Private build needs authorized private source; public never does.
Expected: a concrete proof that the repository strategy compiles, before features.
Distribution remains blocked until the licensing design's alternative grant and
dependency bill of materials authorize the combined product; a build spike is
not evidence that an AGPL core may be linked to closed modules without that route.

### Task 6: Add narrow core APIs for imported identities and contributions

**Files:** Create `PUBLIC/crates/kubepit-core/src/edition/{mod.rs,origin.rs,
contributions.rs}` and integration tests; modify `cluster.rs`, `app.rs`,
`types.rs`, `store.rs`, relevant connection/action consumers and public TS
contract/mock files together. Create public native terminal host helpers if needed.

- [ ] Test origin idempotency, origin spoof attempts through ordinary updates,
      concurrent import collision and staged credential/registry failure recovery.
- [ ] Add backend-owned namespaced opaque origin metadata and safe managed import
      APIs that reuse current `cluster_reimport_kubeconfig` staging behavior.
- [ ] Define typed metadata/alert/action contribution interfaces; keep local base
      data separate, reject credential-bearing fields and arbitrary settings JSON.
- [ ] Test effective `read_only` through actual mutating commands with fake API
      request counters, including direct `store.cluster(s)` access audits.
- [ ] Make effective snapshots consistent for lists, connections, backend checks,
      background services and UI events; edits operate on base/override state.
- [ ] Expose owned PTY creation from a native launch plan only to compiled Rust
      callers. Do not expose a generic execute-program command to the frontend.

**Verify:** `cargo test -p kubepit-core --test edition_host` plus affected public
UI/mock tests. Expected: failed premium/native integration cannot erase base
config or change normal free command authorization.

### Task 7: Define private desktop/service contracts and scenario fixtures

**Files:** `PRIVATE/crates/kubepit-commercial/src/{types.rs,ipc.rs,error.rs}`,
`packages/desktop-ui/src/{types.ts,ipc.ts,mock/}`, `packages/contracts/`,
`tests/fixtures/contracts/`; plugin command permission files.

- [ ] Agree the companion API's auth transaction, rotating-session, entitlement,
      organization/team, profile revision/ETag and error contracts before UI work.
- [ ] Generate policy constants/fixtures from `packages/contracts/src/commercial-policy.ts`;
      enforce snake_case and ISO timestamps except JWS NumericDate claims.
- [ ] Add Rust/TS golden JSON conformance tests for tagged unions, snake_case
      fields, optional values, revision numbers and unsupported schema versions.
- [ ] Define private command families: account state/login/logout/refresh;
      cloud tools/accounts/discover/cancel/import/login; team preview/publish/follow/
      mapping/override/trust/detach. All paid commands use the plugin namespace.
- [ ] Fix profile shape to document `kind: KubepitTeamProfile, version: 1`
      with `id` slug inside `{id: UUID, org_id, revision, document, targets}`;
      targets is organization or teams with `team_ids`. Authorization lives in
      the service envelope/current membership, never document claims.
- [ ] Define events with run IDs, sequence/generation and payload bounds. Token
      material is absent from DTOs and events sent to webviews.
- [ ] Build deterministic demo scenarios for fresh/grace/expired/revoked states,
      partial discovery, login-required, sync conflict and action trust. Assert the
      demo cannot select production endpoints or invoke provider executables.

**Verify:** `pnpm test:contract`, private Rust contract tests, private typecheck.
Expected: both desktop and service consume the same fixture semantics.

### Task 8: Implement browser authentication and shared native session storage

**Files:** `PRIVATE/crates/kubepit-commercial/src/auth/{mod.rs,transaction.rs,
session.rs,keychain.rs,client.rs,device.rs,dpop.rs}`, tests `auth_session.rs`;
private account DTOs.

- [ ] Write fake-service tests for S256 PKCE, wrong verifier/state, expired
      transaction, one-use replay, cancel, hosted browser refusal and timeout.
- [ ] Start the service-owned browser approval transaction; allowlist HTTPS
      account origins and keep verifier/access tokens inside Rust.
- [ ] Generate/store the P-256 device key and standard RFC 9449 DPoP proofs;
      bind RFC 7638 thumbprint only after proof verification at exchange/refresh/API.
      Test nonce, replay, htm/htu/iat, access-token hash, wrong key and copied lease
      without the local key. Use a maintained implementation, not custom protocol
      cryptography; do not promise key nonexportability on every OS.
- [ ] Store rotating refresh tokens in an edition-specific keychain namespace;
      use session-only storage with explicit user choice if secure storage fails.
- [ ] Serialize refresh across windows, bind requests to account/org generation,
      handle reuse/revocation and broadcast only sanitized account state.
- [ ] Test normal 15-minute access expiry: refresh once and retry; do not treat
      an ordinary access-token 401 as an entitlement revocation. Scope definitive
      revoked-session denial separately from transient auth-provider failure.
- [ ] Implement local logout even offline; attempt remote revocation, clear
      local secrets and cancel owned premium jobs. Never touch kubeconfigs.

**Verify:** `cargo test -p kubepit-commercial --test auth_session`; token-sentinel
assertions on events/logs/files. Expected: no browser cookie/password handling,
plaintext refresh fallback or duplicate concurrent refresh.

### Task 9: Implement signed entitlement verification and gate policy

**Files:** `PRIVATE/crates/kubepit-commercial/src/entitlements/{mod.rs,claims.rs,
verify.rs,clock.rs,policy.rs,cache.rs}`, tests `entitlements.rs` and fixtures;
private TS state model tests.

- [ ] Test signature/key/algorithm/issuer/audience/org/device/version rejection,
      key rotation overlap and oversized/malformed claims with fixed test keys.
- [ ] Use a maintained signature library with fixed ES256, shared fixed issuer
      and `kubepit-desktop-pro` audience; ship verification
      keys only. Never implement a signing secret in the desktop or JS.
- [ ] Implement fresh 24h and grace `min(authoritative_at + 7d, paid_through)`;
      cached validation, 304, failed refresh or app restart cannot reset either.
- [ ] Test signed time, monotonic elapsed time, wall-clock rollback/forward jump,
      persisted maximum time and online-revalidation fallback without promising
      rollback-proof clocks on user-controlled machines.
- [ ] Add launch/commit/cancellation gates for the two paid feature IDs and a
      known-revocation override. Core Kubernetes operations never call this policy.
- [ ] Run free fixture connection/import/repair after every denied state.

**Verify:** `cargo test -p kubepit-commercial --test entitlements`; private policy
Vitest. Expected: bounded grace, immediate known revocation, no free regressions.

### Task 10: Build account, organization and billing status UI

**Files:** `PRIVATE/packages/desktop-ui/src/account/{AccountCategory.tsx,
OrganizationPicker.tsx,BillingCard.tsx,useAccountStore.ts,model.ts,model.test.ts}`,
private i18n catalogs, edition registration.

- [ ] Show optional sign-in, selected org/team, assigned seat, plan/cadence,
      paid-through, refresh/sign-out and hosted account/billing actions.
- [ ] Render free/fresh/grace/expired/revoked/session-only/storage-error states
      from native truth. Never grant access from a browser return URL.
- [ ] Open service-provided allowlisted checkout/portal URLs; prices are the
      agreed $3 monthly/$30 annual plan, with tax/provider context from service.
- [ ] Explain cancellation and offline limits plainly, and preserve the workbench
      while account service is unreachable. No mandatory sign-in overlay.
- [ ] Add complete EN/TR and keyboard/focus behavior with existing primitives.

**Verify:** Private typecheck/i18n/model tests and demo flows in both languages.
Expected: account switching cannot display another org's cached managed entries.

### Task 11: Build bounded CLI/process execution and portable fake tools

**Files:** `PRIVATE/crates/kubepit-commercial/src/cloud/{cli.rs,process.rs,
scratch.rs,errors.rs}`, `tests/support/{fake_cli.rs,fake_cli_main.rs}`, tests
`cloud_process.rs`; only generic reusable fixes go to public tools/terminal code.

- [ ] Make a portable compiled fake executable, not a Unix-shell-only harness;
      dispatch fixtures by argv and capture only test-safe environment fields.
- [ ] Fail the fake writer unless all target kubeconfig paths are inside the
      injected run dir. Inject isolated home/provider config dirs and block network.
- [ ] Implement literal argv, null stdin, prompt/pager suppression, bounded
      stdout/stderr, shared process semaphore and per-operation timeouts.
- [ ] Implement Unix process-group and Windows process-tree/Job Object cancel,
      drain/close pipes and private scratch cleanup including interrupted restarts.
- [ ] Add redacted error classifications and safe snippets. Test secret-bearing
      stderr, oversized output, invalid UTF-8, zero-exit malformed JSON and hangs.

**Verify:** `cargo test -p kubepit-commercial --test cloud_process` on all OSs.
Expected: no child survives cancellation and no fallback reads/writes real home.

### Task 12: Implement tool status and AWS scope/provider adapter

**Files:** `PRIVATE/crates/kubepit-commercial/src/cloud/{tools.rs,accounts.rs,
aws.rs,regions.rs}`, provider fixtures and `tests/cloud_aws.rs`; local settings DTO.

- [ ] Test executable override resolution, version timeout, unsupported version,
      duplicate profile labels, missing region, AWS partition/ARN parsing and pages.
- [ ] Fixed tool enum accepts absolute local overrides; prepend only the resolved
      tool directory where needed, without mutating global process PATH.
- [ ] Implement AWS profile/default-region listing and region selection with
      dated suggestions plus validated custom region support.
- [ ] Build explicit list/describe/update-kubeconfig/SSO argv with profile,
      account/partition/region identity and private kubeconfig target.
- [ ] Define canonical resource-plus-credential-binding origin keys; test that
      another profile does not silently replace the original connection.

**Verify:** `cargo test -p kubepit-commercial --test cloud_aws`; no real AWS CLI.
Expected: available executable does not falsely report authenticated account.

### Task 13: Implement GKE and AKS scope/provider adapters

**Files:** `PRIVATE/crates/kubepit-commercial/src/cloud/{gcp.rs,azure.rs,
windows_launcher.rs}`, fixtures, `tests/{cloud_gcp.rs,cloud_azure.rs}`.

- [ ] Cover GKE regional/zonal locations, configuration/account/project binding,
      inactive configurations, pagination and command construction with fixtures.
- [ ] Cover Azure tenant/subscription/resource IDs/resource group casing,
      pagination and explicit subscription selection without global `az account set`.
- [ ] Build private-target kubeconfig writers and supported exec-plugin conversion
      commands. Never default to AKS `--admin` or silently choose another account.
- [ ] Specify/test GKE auth plugin binding; if the supported CLI cannot preserve
      identity, return a limitation rather than a falsely pinned credential claim.
- [ ] Test common Windows `.cmd` launcher installation layouts with a fixed,
      narrowly quoted adapter or verified underlying executable; reject unsupported
      launchers instead of constructing an arbitrary shell command.

**Verify:** Both focused Rust integration tests on macOS/Linux/Windows fixtures.
Expected: private file paths and identity arguments survive spaces/Unicode.

### Task 14: Implement cancellable streaming discovery

**Files:** `PRIVATE/crates/kubepit-commercial/src/cloud/{discover.rs,tasks.rs}`,
`tests/cloud_discovery.rs`; private IPC and mock paired changes.

- [ ] Write tests for four-worker global concurrency, nested describe bounds,
      pagination/repeated tokens, truncation and one failed scope among successes.
- [ ] Validate selected scopes, check entitlement, snapshot account generation
      and tool configuration, then start the owned run with typed progress events.
- [ ] Enforce bounds from the spec, preserve partial results, expose retry scope,
      not-found/access-denied/login-required/unsupported/malformed/timeout states.
- [ ] Cancel on explicit cancel, window close, logout, account generation change
      or known revocation; discard stale events after replacement and send a final
      outcome that distinguishes complete/partial/cancelled.
- [ ] Do not start discovery on app launch, team sync, browser callback alone or
      opening a free core screen.

**Verify:** `cargo test -p kubepit-commercial --test cloud_discovery`, stream model
Vitest. Expected: cancellation terminates processes and never clears good rows.

### Task 15: Implement transactional cloud import and credential refresh

**Files:** `PRIVATE/crates/kubepit-commercial/src/cloud/{import.rs,identity.rs,
exec_auth.rs}`, `tests/cloud_import.rs`, private IPC and demo import fixtures.

- [ ] Test import and reimport in file/keychain modes, same-origin concurrent
      requests, different identities, ambiguous generated contexts and failed writes.
- [ ] Generate a private kubeconfig, inspect/normalize the selected context,
      validate referenced files and exec tool overrides, then stage managed storage.
- [ ] Check entitlement before launch and commit; preserve old credentials,
      metadata, ID, read-only and team mapping if cancelled/denied/failed precommit.
- [ ] Commit atomically via Task 6; disconnect obsolete pooled clients only
      after success. Make partial batch outcomes explicit and imports idempotent.
- [ ] Emit only safe identity/warning/result metadata; clean all owned scratch
      paths and keep successful imports after subsequent expiry/logout.

**Verify:** `cargo test -p kubepit-commercial --test cloud_import`; run fake
connection/repair after expiry. Expected: no user kubeconfig writes or duplicates.

### Task 16: Implement provider SSO/login terminals and Local dock host

**Files:** `PRIVATE/crates/kubepit-commercial/src/cloud/login.rs`, private plugin
terminal commands/permissions, private terminal renderer; public generic
`components/workbench/dock/` and Dashboard Local dock hooks as required.

- [ ] Test backend-built AWS/GCP/Azure login plans, forbidden raw argv, one-use
      plan IDs, window ownership, stream IDs and permission failures.
- [ ] Use existing PTY byte acknowledgments and terminal lifecycle through the
      public native API; keep cloud-specific intent out of core `TerminalSpec`.
- [ ] Add a cluster-independent Local dock usable later by free local lifecycle.
      It may render core local terminals even with no commercial edition present.
- [ ] Handle browser/device-code completion, close/cancel, missing tool and
      timeout; retry only the still-open selected scope with current authorization.
- [ ] Ensure login output/device codes are never synced, logged as cloud audit
      bodies, automatically sent to AI or persisted in a team document.

**Verify:** Fake PTY integration tests; manual demo keyboard/resize/close in EN/TR
and two windows. Expected: core terminals and window cleanup remain unchanged.

### Task 17: Build cloud Add cluster tabs and actionable tool UX

**Files:** `PRIVATE/packages/desktop-ui/src/cloud/{CloudTab.tsx,ScopePicker.tsx,
DiscoveryResults.tsx,ImportResults.tsx,ToolsCategory.tsx,useCloudDiscovery.ts,
model.ts,model.test.ts}`, catalogs and mock scenarios.

- [ ] Show tool/account/region/configuration/subscription state and identity;
      distinguish missing executable, no login, denied scope and unsupported launcher.
- [ ] Render grouped streaming partial results, cancel/retry scope, already-added
      identity, selected batch import and exec-plugin warnings using existing tokens.
- [ ] Gate paid controls from native entitlement state; retain manual kubeconfig
      pane and direct repair path in every state. Avoid duplicate global tool fields.
- [ ] Cover selection persistence, run replacement and error clearing with pure
      reducer/store tests; no tests mirroring trivial JSX styling.
- [ ] Review narrow-width layout, screen reader names, keyboard focus and EN/TR
      plurals. Never translate provider identifiers or CLI output.

**Verify:** Private UI/typecheck/i18n, mocked end-to-end cloud flows and public
Add cluster regression. Expected: unsupported credentials remain repairable free.

### Task 18: Define private team profile schema and bounded validation

**Files:** `PRIVATE/crates/kubepit-commercial/src/team/{model.rs,validate.rs,
canonical.rs,team-profile.v1.schema.json}`, private TS types and fixtures.

- [ ] Test canonical JSON hashes and YAML/JSON round-trip with Turkish text,
      ambiguous scalars, duplicate keys, unknown fields and supported kind keys.
- [ ] Model only explicit shareable fields; avoid serializing core structs.
      Include safe cost/source settings now present, exclude credential bindings.
- [ ] Keep `kind: KubepitTeamProfile` and `version: 1` in the document schema;
      separate cloud UUID/org/revision/targets envelope types. Do not add a
      conflicting `schema_version` or accept document membership claims.
- [ ] Enforce byte/count/depth limits, references, colors, globs, valid IDs,
      finite numbers, no multi-doc YAML/custom tags and bounded/rejected aliases.
- [ ] Keep JSON Schema and authoritative Rust validator aligned through fixture
      checks; share schema/version expectations with service request validation.
- [ ] Add structural credential rejection and heuristic findings whose messages
      do not echo the detected secret itself.

**Verify:** `cargo test -p kubepit-commercial team::validate`, contract fixtures.
Expected: unsupported documents are rejected before caching or contribution apply.

### Task 19: Build explicit sanitized export/publish preview

**Files:** `PRIVATE/crates/kubepit-commercial/src/team/{export.rs,sanitize.rs,
preview.rs}`, `tests/team_export.rs`, private `team/exportRequest.ts` and tests.

- [ ] Build backend snapshots through the public metadata-only host API and
      explicit selected UI-owned views/bookmarks/ignores; never open credential
      contents just to serialize a profile or send local IDs to the service.
- [ ] Test fixture tokens/private keys/certificates/exec env in both file and
      keychain configurations are absent from payloads, logs and diagnostics.
- [ ] Reject URL userinfo, block known secret-bearing query patterns, review
      arbitrary notes/scripts/URLs and show unresolved risks in exact payload preview.
- [ ] Bind publish consent to audience, canonical payload hash and base revision;
      changing selection/text/org invalidates consent and requests a new preview.
- [ ] Describe scanning as best effort and publish as explicit egress. No
      background upload of existing local config on login or organization creation.

**Verify:** `cargo test -p kubepit-commercial --test team_export`; export request
Vitest. Expected: structural leak prevention is proved without a zero-secrets claim.

### Task 20: Implement deterministic local cluster mapping

**Files:** `PRIVATE/crates/kubepit-commercial/src/team/{mapping.rs,links.rs}`,
`tests/team_mapping.rs`, private mapping-state model fixtures.

- [ ] Test explicit link persistence, safe server normalization, meaningful URL
      paths, several users/contexts on one server and context-only ambiguity.
- [ ] Match by stable org/profile/entry and explicit link first, then show server
      candidates, then context hints. Require review for ambiguous/context-only cases.
- [ ] Never modify a connection identity because a team server/matcher changed;
      show remap-required and preserve the existing link until explicit decision.
- [ ] Support unresolved entries with manual import/paste and optional cloud
      import; no automatic local kubeconfig discovery from a remote update.
- [ ] Store mappings locally with atomic writes and stable origin references;
      verify same profile/entry IDs in two orgs cannot collide.

**Verify:** `cargo test -p kubepit-commercial --test team_mapping`. Expected:
mapping never transmits credentials or silently adopts another identity.

### Task 21: Implement team contribution layers and local overrides

**Files:** `PRIVATE/crates/kubepit-commercial/src/team/{layers.rs,overrides.rs,
apply.rs}`, `tests/team_layers.rs`; private UI merged selectors;
public generic selector adapters from Task 6 only where needed.

- [ ] Test local base/team precedence, multi-profile conflict reporting,
      field-level overrides, removed fields and remote changes to overridden values.
- [ ] Apply validated profile contributions through native generic APIs without
      flattening into localStorage or writing over the user's base settings.
- [ ] Enforce `read_only = local OR applicable shared values` at backend checks;
      test actual mutating command rejection against fake request counters.
- [ ] Merge namespaced views/bookmarks/ignores/alert rules into existing consumers;
      expose ownership/conflicts/overrides and preserve local unrelated entries.
- [ ] Test reload/crash mid-apply and two-window propagation with an atomic
      generation swap. No partial mixture of profile revisions may be visible.

**Verify:** `cargo test -p kubepit-commercial --test team_layers` and selector
Vitest. Expected: changing a team profile cannot make a local read-only cluster writable.

### Task 22: Implement service client, revision preconditions and sync coordinator

**Files:** `PRIVATE/crates/kubepit-commercial/src/team/{client.rs,sync.rs,cache.rs,
publish.rs}`, `tests/team_sync.rs`; private IPC events and mock revision scenarios.

- [ ] Test authenticated ETag GET/304, If-Match/412 update/delete, idempotent
      create, tombstones, server hash mismatch and unsupported document versions.
- [ ] Preserve local draft on 412; return base/local/server state for review.
      Never retry a changed payload under the old consent/hash/idempotency key.
- [ ] Run one Rust coordinator across windows, approximately 60s jitter while
      foreground and opted in, with concurrency caps/backoff/Retry-After.
- [ ] Refresh on foreground/reconnect; pause on expiry/logout/org switch and
      ignore account-generation-stale responses. Polling defaults off in tests.
- [ ] Keep last good cache on transient/invalid replies; ordinary access 401
      refreshes once and retries before lease effects. Profile-role 403 affects only
      that permission/profile; authoritative 403/410 removal detaches that profile.
      Only definitive session/membership/seat/entitlement denial invalidates its
      corresponding authorization scope, never every feature on an arbitrary 403.
- [ ] Verify online requests require live API authorization even with a valid
      signed offline envelope. A 304 is not a new authoritative entitlement issue.

**Verify:** `cargo test -p kubepit-commercial --test team_sync` with fake clock
and service. Expected: zero idle/background sync without opt-in, no lost drafts.

### Task 23: Implement expiry, removal, logout and detach without data loss

**Files:** `PRIVATE/crates/kubepit-commercial/src/team/{lifecycle.rs,migrate.rs}`,
`tests/team_lifecycle.rs`, private lifecycle UI model.

- [ ] Cover subscription disable/unfollow, entry deletion, profile tombstone,
      membership/seat removal, paid expiry, account switch/logout and unknown offline
      revocation in a table-driven transition suite.
- [ ] Stop sync/new paid work; preserve all imported cluster credentials,
      personal base views/bookmarks/actions/overrides and active free connections.
- [ ] Detach shared values safely into labeled local snapshots where specified;
      retain effective read-only until explicit local edit and executable actions
      disabled pending explicit local copy/review.
- [ ] Retain orphan/tombstone provenance to avoid recreating dismissed entries;
      keep cache retention/purge behavior distinct from authorization.
- [ ] Journal lifecycle writes and test crash recovery; user-facing summaries
      state exactly what becomes local, stops syncing or is removed from cache.

**Verify:** `cargo test -p kubepit-commercial --test team_lifecycle`; reopen same
fixture home in community host. Expected: credentials/local config remain usable.

### Task 24: Implement executable-action trust and backend execution gates

**Files:** `PRIVATE/crates/kubepit-commercial/src/team/{actions.rs,trust.rs}`,
`tests/team_actions.rs`, private action review UI; public generic action bridge
and existing custom-action audit integration where necessary.

- [ ] Test disabled/untrusted initial state and canonical hash identity for all
      execution-relevant fields, org/profile/entry binding and changed-definition
      invalidation. Trust records are local and never uploaded.
- [ ] Review exact command/mode/scope/mutating flag/timeout/diff before enable;
      validate again at native execution, including current profile revision/status.
- [ ] Reuse target validation, `read_only`, confirmations, cancellation and audit
      paths. Refuse attempts to spoof action origin or call the public local action
      handler to bypass a contribution's owner gate.
- [ ] Prove sync/startup/selection/deep-link/login/expiry cannot autoexecute;
      after detachment an action requires explicit local copy and review.
- [ ] Audit only safe metadata/outcome; do not treat a declared non-mutating
      arbitrary shell command as a security guarantee.

**Verify:** `cargo test -p kubepit-commercial --test team_actions`; fake runner
asserts zero calls before trust and after any relevant definition change.

### Task 25: Build Team profiles UI and complete both demos

**Files:** `PRIVATE/packages/desktop-ui/src/team/{TeamCategory.tsx,ProfileList.tsx,
ProfilePreview.tsx,PublishDialog.tsx,ConflictDialog.tsx,MappingTable.tsx,
OverrideControls.tsx,ActionTrustDialog.tsx,DetachDialog.tsx,useTeamStore.ts,
layers.ts,layers.test.ts}`, catalogs and mock scenarios.

- [ ] Expose authorized org/team profiles, scope/role, follow state, last revision,
      stale/offline/conflict status, publish preview and mapping without local secrets.
- [ ] Render exact payload/audience consent, 412 conflict review, local overrides,
      ownership badges and read-only safety explanations in the existing UI style.
- [ ] Explain detach/expiry without promising team policy enforcement or remote
      credential revocation. Provide explicit purge and local snapshot choices.
- [ ] Exercise initial follow, ambiguous mapping, changed endpoint, edited action,
      tombstone, offline grace, revoked seat and organization switch in demo fixtures.
- [ ] Complete all EN/TR strings, keyboard flows, narrow layouts, screen reader
      names, focused modal behavior and two-window updates.

**Verify:** Private typecheck/i18n/UI suite and browser demo smoke; public demo
still starts without commercial package. Expected: user content stays untranslated.

### Task 26: Run desktop/service interoperability and adversarial scenarios

**Files:** `PRIVATE/tests/desktop-service/`, contract fixtures, CI workflow;
public host integration fixtures only if a generic regression is found.

- [ ] Connect desktop transport to the companion fake/test service with synthetic
      users/orgs/teams, auth provider and billing events; deny external network.
- [ ] Test cross-tenant IDs, wrong org envelope, refresh-token reuse, member/seat
      removal during discovery/import/publish, duplicate webhook and event reordering.
- [ ] Test 24h freshness, total 7d/paid-through cap, clock anomalies, device/session
      revoke, full offline run, reconnect and cached profile authorization mismatch.
- [ ] Verify raw tokens, fixture cloud secrets, kubeconfigs and profile body text
      are absent from account events, request logs, support metadata and artifacts.
- [ ] Run the public free workflow fixture under every paid state, including
      starting the community build against an existing official-build fixture home.
- [ ] Record remaining protocol/version interoperability limits explicitly;
      reject automatic fallback to unrestricted CLI execution or permissive auth.

**Verify:** `pnpm test:contract`, private integration suite and targeted public
regressions. Expected: service authorization is authoritative; free access survives.

### Task 27: Prepare distribution, migration and documentation boundaries

**Files:** `PUBLIC/docs/{EDITION_HOST.md,ARCHITECTURE.md}`, public README as
appropriate; `PRIVATE/docs/{COMMERCIAL_DESKTOP.md,TEAM_PROFILES.md,CLOUD_IMPORT.md,
RELEASING.md,DATA_LIFECYCLE.md}`, private CI/source manifest/notices files.

- [ ] Document private/public build commands, pinned revision updates, alternative
      core commercial grant, AGPL community corresponding-source obligations, MIT SDK
      notices and exact component ownership. Require first-party rights/CLA inventory
      and a reviewed third-party license BOM; no self-issued third-party AGPL exception.
      Scan public artifacts/lockfiles
      for private paths/packages/secrets before any publication step.
- [ ] Define separate community/official app identity and update feeds; confirm
      config/keychain namespaces and explicitly reviewed migration behavior.
- [ ] Document $3/$30 plan, seat authorization, cancellation/grace, immutable free
      credential access, synced data, script trust and known offline limits.
- [ ] Preserve the old local-cluster feature as a **free follow-up**: kind/k3d/
      minikube code stays public, read-only applies to stop/delete, no kind start/stop
      or registry claim, private kubeconfig targets and backend PTY exit completion
      remain required. Its old cloud-premium placement is not executed.
- [ ] Prepare signed build/release checklist and verified supported CLI/OS matrix.
      Record selected Paddle merchant/low-price quote and license decisions as launch inputs;
      do not fabricate approval, ship, install credentials or change licenses here.

**Verify:** Clean public and private source builds; generated notices inspected;
links/scripts match actual files. Expected: no secret source copied into public repo.

### Task 28: Final acceptance and staged rollout readiness

**Files:** Final acceptance report in `PRIVATE/docs/acceptance/`, final updates
to the two design/plan status fields after implementation, not during planning.

- [ ] Run the full public checks listed at the start, the private counterparts,
      service contract/integration suites and both production frontend builds.
- [ ] Run CI fixture tests on macOS/Linux/Windows, including process tree cleanup,
      private file ACLs, path/launcher handling and multiwindow auth/PTY ownership.
- [ ] Perform EN/TR demo walkthroughs of free/no-account, paid fresh, offline
      grace, expired, revoked, missing tools, partial import and profile conflicts.
- [ ] Inspect shipped binary/config capabilities, commercial-core grant scope,
      AGPL community source offer/materials, MIT SDK/third-party notices,
      updater/feed separation, account-origin allowlist and absence of signing keys.
- [ ] Verify service backup/restore, tenant isolation, auth, seat/billing and
      webhook gates from the companion plan before proposing any paid launch.
- [ ] Record pass/fail evidence, measured limits, unsupported combinations and
      rollback instructions. Stop at a concrete reviewable release candidate;
      publishing/signing production artifacts uses the user's release authorization.

**Expected result:** Public app independently usable and buildable; private paid
features complete against the reviewed service contract; no tests or scripts
have accessed real Kubernetes/cloud credentials; launch blockers explicitly
listed rather than hidden by an optimistic completion statement.

## Completion checklist for the executor

- [ ] No existing feature moved behind account/seat checks.
- [ ] Public/private artifacts and licenses follow the agreed boundary.
- [ ] Both IPC contracts and EN/TR catalogs match their implementations.
- [ ] Origin imports, revision updates and detachment are transactional.
- [ ] Offline/expiry/revocation behavior matches service policy exactly.
- [ ] Team data is explicitly reviewed, allowlisted and never autoexecutes.
- [ ] Community and official builds plus their demos pass their own checks.
- [ ] Merchant/pricing eligibility and release authorization are resolved before
      charging users or publishing an official commercial build.
