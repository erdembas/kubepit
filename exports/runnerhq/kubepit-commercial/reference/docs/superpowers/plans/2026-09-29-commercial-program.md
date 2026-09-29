# Open-Core Commercial Program: Implementation Handoff

> **For the implementing agent:** This is a planning artifact, not an instruction to charge a card, publish source, reset Git history or deploy production during a review. The founder intends a separate implementation agent to execute the approved plan. Read the documents below before editing. Work task by task, preserve user changes, and report verified checkpoints. If Superpowers is available, use its execution/review workflow; it was not installed in the planning environment, so no unavailable skill is a hidden dependency.

**Goal:** Deliver a free, independently buildable open-source Kubepit core and a separately maintained commercial product with organization/team accounts, Paddle seat subscriptions, paid cloud-provider discovery/import, and synchronized team profiles.

**Price contract:** USD 3/seat/month or USD 30/seat/year; one subscription and invoice per organization, not per device or team.

**Architecture:** Public community app + minimal edition-host contracts; private commercial repository consuming a pinned public checkout; Node 24/Fastify 5/PostgreSQL 17 modular monolith, React console, Rust/Tauri commercial plugin and private React UI. Kubernetes/cloud credentials remain on the desktop.

**License proposal:** Public first-party core AGPL-3.0-only with an alternate commercial grant for the official combined proprietary build; proprietary commercial implementation; selected SDK/contracts MIT. This is contingent on ownership, dependency and contributor-rights review. The current source says MIT, but the founder states it has never been pushed/distributed. No Git history or license has been changed by creating this plan. AGPL permits lawful forks; it is not a noncompetition license.

## Read in this order

1. `AGENTS.md` and `docs/ARCHITECTURE.md` in the current checkout.
2. [Product/architecture strategy](../specs/2026-09-29-open-core-commercial-strategy.md).
3. [Licensing/repository decision record](../specs/2026-09-29-commercial-licensing-and-repository.md).
4. [Cloud specification](../specs/2026-09-29-commercial-cloud-design.md).
5. [Desktop specification](../specs/2026-09-29-commercial-desktop-design.md).
6. [Cloud task plan](2026-09-29-commercial-cloud.md) and [desktop task plan](2026-09-29-commercial-desktop.md).

This file coordinates those two implementation tracks. It does not duplicate their tasks or permit choosing inconsistent contracts. The four older cloud/team spec/plan files are superseded references, not an alternative public implementation path.

## Confirmed input and open decisions

**Confirmed by the founder:** Core is free/open source; team-level features will be paid; target price is $3/user/month or $30/user/year; a small Node/PostgreSQL, .NET or managed backend is acceptable; Paddle is preferred; code has not yet been pushed/distributed; a later history reset is intended; this request is comprehensive planning for another agent.

**Recommended defaults:** Node/Postgres, AGPL + commercial alternative, separate private repo, free local kind/k3d/minikube lifecycle, paid EKS/GKE/AKS convenience, no automatic trial, managed identity, bounded offline entitlement, organization-owned seats and data.

**Must resolve before the corresponding external action:** Copyright/control of all dual-licensed first-party code; approved license/legal documents; company/seller country and Paddle eligibility; approved <$10 pricing; data region/retention; domains and identity-provider settings; code-signing credentials. Pending launch decisions do not prevent implementing fixtures, contracts, local sandbox flows or the public generic extension host.

Do not interpret the founder's statement about a future history reset as authorization to run `git reset`, remove `.git`, force-push, delete a remote or discard the current working tree during implementation. Prepare a reviewed publication snapshot and retain a private recoverable development archive in a separately authorized publication task.

## Repository layout contract

```text
kubepit/                                      # community, intended public
  LICENSE                                     # proposed AGPL after ownership gate
  LICENSES/                                   # SPDX texts, exceptions, notices
  Cargo.toml                                  # first-party workspace declarations reviewed
  pnpm-workspace.yaml
  apps/desktop/                               # complete free application, remains in place
    src/{bootstrap.tsx,edition/,components/,i18n/,lib/}
    src-tauri/                                # reusable shell + community entrypoint
  crates/kubepit-core/                         # free Kubernetes/local operations
  packages/edition-contracts/                  # small explicit MIT SDK/interface boundary
  docs/{ARCHITECTURE.md,EXTENSIONS.md,...}

kubepit-commercial/                           # PRIVATE, separate repository/history
  LICENSE                                     # proprietary terms / license reference
  licenses/                                   # controlled-core commercial grant + notices
  vendor/kubepit/                             # pinned public SHA, no commercial edits
  apps/
    api/                                      # API and worker entrypoints, same image
    console/                                  # browser account/team/billing UI
    desktop-commercial/                       # private Vite/Tauri entrypoints/config
  packages/
    contracts/                                # cloud API, policy constants, schemas/fixtures
    db/                                       # SQL/Drizzle migrations + RLS
    billing/                                  # Paddle and fake adapters
    desktop-ui/                               # paid React features + private i18n catalogs
  crates/kubepit-commercial/                  # auth, lease, providers, profiles, Tauri plugin
  tests/{unit,integration,contract,e2e,fixtures}/
  ops/                                        # deployment, test composition, runbooks
  docs/{decisions,security,operations,plans}/
```

These are target paths, not files created by this planning task. Prefer a narrow extraction of bootstrap/host interfaces over moving all existing UI and Rust code. Validate the nested Cargo/pnpm workspace arrangement in the early composition spike. Neither private source nor private git URLs may become a dependency of a clean public build. Do not solve resolver problems by copying the private crate into the public repository.

The private build uses a public source package/API, not patching a vendor checkout at build time. Preserve one React instance, the public `@/` resolution, private `@commercial/` resolution, public and private Tailwind source discovery, a single locale store and correct runtime asset paths. Private Tauri plugin commands are namespaced and cannot replace the public core's invoke handler.

## Workstream ownership

| Stream               | Owns                                                                                                         | May begin when                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Licensing/repository | Ownership inventory, dual-license route, CLA, trademark/terms requirements, publication isolation            | Immediately; no license change without reviewed decision       |
| Public host          | Reusable desktop bootstrap/shell, edition registries/contracts, additive i18n support, free demo build       | Current dirty work preserved and baseline recorded             |
| Cloud                | Private API/console, Postgres tenancy, identity, seats, Paddle, profile API, entitlement signing, operations | Private target repo/path established; fake providers permitted |
| Desktop commercial   | Private shell/UI/plugin, login/lease, provider import, team profile local behavior                           | Host composition spike and contract baseline                   |
| Release/verification | Test pipelines, signed artifacts/feeds, legal/BOM audit, platform checks, backup recovery                    | Incrementally; live commerce after business gates              |

Only one agent owns a shared contract file at a time. Core `types/index.ts` and `lib/ipc.ts` change with the Rust core command in the same task; private commercial DTOs and `ipc.ts` change with the private Tauri command in the same task. A route/schema change without its generated fixtures and consumer update is incomplete.

## Shared constants and boundary tests

The cloud plan defines `packages/contracts/src/commercial-policy.ts` as the canonical source for price amounts, feature identifiers and entitlement timing. Generate fixtures consumable by Rust/TS. Product constants are not scattered in UI components.

| Item                          | Baseline                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Features                      | `cloud_import`, `team_profiles`                                               |
| Monthly/yearly unit price     | USD 300 / 3000 integer cents                                                  |
| Entitlement signing           | Standard ES256 JWS; fixed issuer/audience, allowlisted key IDs                |
| Freshness / total offline cap | 24h / 7d from authoritative validation, both bounded by paid-through          |
| Profile sync                  | ETag/revisions; 60s foreground polling with jitter; paused offline/background |
| Paid API                      | Always authenticates and authorizes current membership, role, scope and seat  |
| Profile size                  | 1 MiB maximum; bounded depth/counts; exact limits in shared schema            |
| Public core                   | Never requires a cloud account or an entitlement                              |
| Imported credentials          | Remain local, usable and recoverable after subscription expiry                |

An expired short-lived access token is not proof of canceled entitlement: perform the documented refresh once. A permission denial on one profile is not blanket revocation of all organizations/features. Stable error codes distinguish transport errors, refresh failures, membership revocation, seat removal, billing ineligibility and profile-scope denial. Scope cache invalidation accordingly.

## Checkpoint 0 — Preserve and record the baseline

**Files:** Read existing source, `LICENSE`, package manifests and all seven program documents. Write only a private implementation status log when execution begins.

- [ ] Record current branch/SHA and dirty paths. Read ongoing changes before moving shared entrypoints. Do not “clean up” assistant or TLS edits unrelated to the program.
- [ ] Confirm the proposed private checkout is truly private before placing proprietary files there; local folder naming or `.gitignore` is not access control.
- [ ] Read only repository fixtures; no real clusters, `~/.kube`, `~/.aws`, gcloud or Azure credentials in tests/scripts.
- [ ] Identify existing test commands rather than adding a second Vitest harness from the old plans. Use `pnpm test:ui`, not a nonexistent root `pnpm test`.
- [ ] Capture baseline failures separately. Do not call a program task complete by silently disabling an unrelated check.

**Pass:** A reproducible starting state, clear file ownership, no deleted user changes, and no accidental external calls.

## Checkpoint 1 — Licensing and distribution route

**Files:** Proposed public `LICENSE`, `LICENSES/`, package declarations, private `licenses/`, contribution and trademark policy documents. The licensing plan owns exact contents.

- [ ] Inventory first-party, contributor, employer-owned, copied/generated and dependency code. Explicitly include inherited RunHQ code/assets, fonts, icons, samples and code snippets.
- [ ] Review AGPL/commercial alternative with a qualified reviewer for actual linking/distribution. Confirm the founder/company can grant it; arrange assignment to a future legal entity if necessary.
- [ ] Choose a contributor agreement that provides needed alternative licensing rights; DCO alone is not an alternate-license grant. Keep contributor expectations transparent.
- [ ] Produce the component/license map: public core, MIT edition contracts, private implementation, dependency notices and commercial-core grant.
- [ ] Verify no restrictive trademark/noncompetition terms are inserted into the standard OSS source license. Forks remain legitimate under AGPL; official brand/service access is distinct.
- [ ] Apply approved license declarations coherently in a dedicated implementation change; do not claim an AGPL file header makes third-party code relicensable.

**Pass:** Both Community distribution and the official proprietary composition have a documented lawful path. If this gate is unresolved, continue generic code preparation but do not distribute the proprietary combined build.

## Checkpoint 2 — Composition spike before product breadth

**Public paths:** `apps/desktop/src/bootstrap.tsx`, `src/edition/`, `src/main.tsx`, shell host APIs, `packages/edition-contracts`, workspace manifests.\
**Private paths:** `apps/desktop-commercial`, minimal `packages/desktop-ui` and `crates/kubepit-commercial`.

- [ ] Build the existing Community app through the extracted default host with no behavior change.
- [ ] Build a private wrapper with one synthetic settings page and a `ping` fixture command. Use a compiled Tauri plugin and explicit post-core-setup hook; do not replace core dispatch.
- [ ] Confirm initializers, updater configuration, window/terminal ownership, close hooks and locale state run exactly once in both editions.
- [ ] Run `pnpm dev:ui` from a public checkout where the private directory is absent. Simulate blocked Kubepit Cloud domains and verify free startup/use.
- [ ] Confirm production private bundles contain the correct UI assets/translations, while public source archives/builds contain no commercial implementation or private git credentials.
- [ ] Pin the passing public SHA and SDK/host compatibility version. Record how an upstream update is tested before changing the pin.

**Pass:** Two clean builds, one public core, no vendor patches, no private build dependency in Community, and existing tests remain green. Stop architectural expansion here if packaging is not yet reproducible.

## Checkpoint 3 — Cloud foundation and tenant isolation

Execute the foundation tasks in the cloud plan: private workspace, local database, migrations, role/RLS policy tests, auth adapter, organization/team membership, seats and invitations.

- [ ] Run integration tests with actual PostgreSQL 17 and separate owner/runtime/intake roles. Exercise FORCE RLS and missing context.
- [ ] Verify scoped composite foreign keys, last-owner invariants and pooled transaction-context reset.
- [ ] Exercise invite races, duplicate acceptance, seat reservations and concurrent removal/role changes.
- [ ] Complete browser-to-desktop approval using fixture identity before integrating real hosted login.
- [ ] Verify token/session values never reach renderer logs, localStorage, query strings or general app exports.

**Pass:** Org A cannot touch org B even through wrong IDs or a reused connection; a clean API can start with fixture providers; no billing request is required to test tenancy.

## Checkpoint 4 — Billing sandbox and entitlement end to end

Execute cloud billing/signing tasks and desktop auth/lease tasks together against shared contract fixtures.

- [ ] Create sandbox prices matching the two server-owned SKUs. No live products/charges merely to validate a test.
- [ ] Show exact checkout and subscription-change previews. Reject arbitrary price IDs, amounts, currencies and unauthenticated org claims.
- [ ] Test successful purchase, abandoned checkout, failed payment, renewal, cancellation, interval change, quantity up/down, refund/dispute and recovery.
- [ ] Test signed raw-body webhook verification, replay, duplicates, out-of-order delivery, persistence failure, provider timeout and reconciliation.
- [ ] Ensure a pending seat decrease constrains concurrent invitations/assignments so provider/network latency cannot over-allocate capacity.
- [ ] Verify signed lease in the Rust backend; tampering, wrong issuer/audience/org/device, stale key, expiry and clock rollback require correct denial/recovery.
- [ ] Simulate access-token expiration, IdP outage, billing-provider outage and cloud outage separately. None may falsely convert an error into paid authorization or disable core.
- [ ] Measure/remove secrets from all logs and fixtures; use generated fake keys only.

**Pass:** Payment state grants exactly the purchased rights, one change never charges twice, cloud access is live-authorized, and expiry preserves ordinary cluster access.

## Checkpoint 5 — Paid cloud-provider import

Execute desktop provider tasks in EKS → GKE → AKS order with fake CLIs. Port the useful pure argv/parser cases from the older cloud design to private code. Public local-tool mechanics can be shared through typed interfaces without publishing premium implementations.

- [ ] Stream results per scope, with isolated failure/cancellation and useful missing-tool/expired-login states.
- [ ] Every credential writer targets a private temporary kubeconfig. Fake CLIs fail if a target could fall back to a user's default kubeconfig.
- [ ] Distinct origins remain distinct; re-import of the same origin preserves the existing cluster ID/settings and safely replaces credentials.
- [ ] Provider login, cloud re-import and keychain access require user action, including when triggered from shared profile mapping.
- [ ] Paid origin records do not make core connection or free kubeconfig repair dependent on the paid plugin.
- [ ] Validate Windows CLI argument/process handling and GKE auth-plugin/account pinning; use approved synthetic/manual test accounts only in a separately arranged smoke check.
- [ ] Run the browser demo with no real executables, credentials or outbound provider calls.

**Pass:** All advertised providers work in fixtures/demo; imported clusters remain usable after logout, expiry, plugin removal and cloud outage. A single incomplete provider cannot be hidden behind a claim of three-provider support.

## Checkpoint 6 — Team profiles and local safety

Execute private profile validation, cloud publish/revision API and desktop layer/mapping tasks together.

- [ ] User selects fields and sees the exact outbound sanitized document. Sign-in alone uploads nothing.
- [ ] Reject credential-bearing structured fields; inspect notes/actions/URLs, handle bounded malformed YAML and do not pretend regex proves absence of every secret.
- [ ] Map cluster references to local credentials; ambiguous matches require a local choice. Shared metadata never becomes a credential lookup/exfiltration instruction.
- [ ] Use ETag conditional writes and preserve drafts on conflict. No automatic last-writer-wins overwrite.
- [ ] Test org-wide/team-scoped access, profile removal, member removal, team removal, tombstone expiry and long-offline list reconciliation.
- [ ] Trust-gate shared executable actions per content hash; a profile update cannot autoexecute or carry forward stale approval for changed command semantics.
- [ ] Test local overrides, multiple profiles targeting one object, stable priority/order and restrictive read-only composition. Expiry/removal never silently relaxes safety.
- [ ] Keep cached data readable/exportable according to documented ownership; detach by explicit action without deleting local clusters.

**Pass:** Two synthetic users/devices share only intended metadata and receive consistent revisions; unauthorized access fails; synced content never causes unattended command execution or credential upload.

## Checkpoint 7 — Operations, console and release readiness

- [ ] Complete EN/TR account, organization switcher, invitations, member/seat tables, teams, profiles, billing, data export/deletion and device/session screens. Follow RunHQ tokens and accessibility requirements.
- [ ] Confirm payment/billing portal permissions do not bypass seat invariants. Clarify purchased versus assigned/reserved seats in UI copy.
- [ ] Run an actual PostgreSQL backup/restore drill into a fresh isolated environment. Verify tenant isolation and webhook/job dedup state after restore.
- [ ] Apply graceful shutdown, migration locking, rollback compatibility, timeouts, rate limits, job retries/dead letters, redacted monitoring and alert/runbook ownership.
- [ ] Run appropriate public checks and private unit/integration/contract/e2e tests, dependency/license scan and artifact-boundary inspection.
- [ ] Validate signed macOS/Windows/Linux builds and separate update feeds/app identities. Updater signing keys and entitlement signing keys are distinct systems.
- [ ] Obtain Paddle seller/$3 approval, complete legal/privacy/refund/subprocessor documents and select actual hosting region/account costs.
- [ ] Exercise cancellation, organization deletion, restored payment, revoked employee, lost device and support recovery with sandbox identities.
- [ ] Conduct a small invited beta before broad release; report measured failures and operational load rather than assuming low request counts imply production readiness.

**Pass:** A reviewed release candidate and operational evidence. Production deployment/publication/live commerce are separate explicit launch actions after the corresponding gates; preparing them is part of implementation, executing them is not implied by this planning review.

## Validation rules

Public changes use the current required commands:

```bash
pnpm typecheck
pnpm i18n:check
pnpm test:ui
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --filter @kubepit/desktop build
```

Private workspace commands are introduced and defined in the two task plans. They must run local fake providers and disposable PostgreSQL. Database isolation, transactional races, webhook replay and lease verification require meaningful integration tests; do not substitute snapshot tests of implementation text. No tests/scripts connect to real Kubernetes clusters, cloud-provider accounts or live payment customers. External traffic is blocked except explicitly scoped sandbox integration checks performed after configuration.

Every checkpoint produces a short record: changed files/contract versions, tests run with results, unresolved risks, and next dependent task. Mark checkboxes only after evidence exists. Never mark legal/provider/manual platform gates passed from a mocked success.

## Handoff prompt for the implementation agent

```text
Implement the Kubepit commercial program described in
docs/superpowers/plans/2026-09-29-commercial-program.md.

Read AGENTS.md and ARCHITECTURE.md first, then all linked new specifications
and both implementation plans. Preserve the current dirty working tree.
Start with baseline preservation, ownership/license decision recording and
the minimal public/private build-composition spike. Use fixture providers
and an isolated PostgreSQL; do not read real kube/cloud credentials.

Community must remain independently buildable and usable without login.
Premium implementation and cloud code belong only in the private target
repository. Do not execute the older team/cloud plans unchanged.
Keep public IPC and private IPC contracts paired with their respective Rust
changes, EN/TR strings, demo behavior, tests and documented failure paths.

Prices are $3/seat/month or $30/seat/year with Paddle as the preferred
provider. Do not create live charges, publish private source, rewrite git
history, change repository visibility or deploy production merely to finish
a task. Prepare reviewable artifacts and surface the explicit legal,
merchant and release gates. License proposal is AGPL core with an alternate
commercial grant; do not assume a folder split alone permits proprietary
linking, or claim forks are forbidden.

Work in the checkpoint order, use parallel agents on disjoint files where
useful, and report verified progress without treating mock tests as live
release approval.
```

## Planning-file confidentiality

These plans are currently local documents in the repository intended for public release. They disclose architecture and commercial policy, not credentials. Before the first public push, decide which high-level documents should be public and move internal operational/business planning to the private repository if desired. Removing files from a future commit does not remove them from already published history; the founder's stated prepublication history reset belongs to the separately reviewed publication procedure. Never remove third-party attributions or lose the recoverable development archive as part of that procedure.
