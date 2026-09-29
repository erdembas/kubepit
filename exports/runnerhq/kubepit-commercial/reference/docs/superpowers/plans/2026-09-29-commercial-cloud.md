# Commercial Cloud Implementation Plan

> **For agentic workers:** This plan follows the repository's Superpowers-style task and checkbox format. No Superpowers skill is installed in the planning session, and no unavailable sub-skill is a prerequisite. Execute one bounded task at a time, record evidence and keep unresolved gates explicit. This is a handoff plan, not implementation authorization to create paid accounts, charge cards, deploy or publish.

**Goal:** Build the private Kubepit account, organization, team, seat, billing, profile-sync and signed-entitlement service for USD 3/seat/month or USD 30/seat/year. Keep the public Kubernetes IDE free and independent of accounts and licensing. Paid cloud-provider import executes locally; cloud credentials and kubeconfigs never enter this SaaS.

**Architecture:** Node.js 24 LTS + Fastify 5 + TypeScript, PostgreSQL 17 with Drizzle and `pg`, a modular monolith with API and worker modes, PostgreSQL jobs/outbox, WorkOS AuthKit hosted identity, and the user's preferred Paddle Billing adapter subject to merchant and low-value-product approval. Stripe is an optional eligibility-dependent adapter, not an assumed Turkish merchant solution. React 18 + Vite console uses RunHQ tokens and existing primitive patterns; no new UI/chart library.

**Spec:** [Commercial cloud design](../specs/2026-09-29-commercial-cloud-design.md).

**Coordination:** [Program plan](2026-09-29-commercial-program.md), [commercial desktop plan](2026-09-29-commercial-desktop.md), [licensing/repository design](../specs/2026-09-29-commercial-licensing-and-repository.md). These tasks target the proposed **private `kubepit-commercial` repository**, not the current public workspace. The only files delivered by this planning task are Markdown documents. Nothing below has been executed.

## Non-negotiable contracts

- Public core builds/tests without a private package, secret, account or license endpoint. The licensing workstream decides AGPL-3.0-only + alternative commercial grant eligibility for the official combined distribution and a permissive SDK; never merge proprietary implementation into the public repository or silently change third-party licensing. The user states the code has not yet been distributed; preserve any proven third-party/prior grants if discovery changes that baseline.
- `packages/contracts/src/commercial-policy.ts` is the sole source for `team_profiles`, `cloud_import`, USD `300`/`3000`, freshness `86_400` seconds and total offline cap `604_800` seconds. Generate Rust-compatible fixtures. Seven days starts at the last authoritative validation, not after the initial 24 hours, and is capped by paid-through.
- Organization subscription quantity is purchased capacity. A membership can occupy at most one seat in an org; teams/devices do not multiply seats. Premium invitations reserve seats atomically. Removal frees the seat but does not silently reduce purchased quantity or issue a refund.
- Application sessions, current memberships, roles and seats authorize cloud requests. A signed offline lease is not a cloud bearer token. Client flags, checkout return URLs, unverified payment events and arbitrary IdP claims cannot grant access.
- Auth uses the managed provider. Kubepit stores no passwords. Browser provider credentials remain encrypted server-side; opaque desktop refresh credentials remain in Rust and the OS credential store, never the renderer.
- Every tenant relation has `org_id` and composite cross-table FKs. Runtime roles are nonowners with no BYPASSRLS; tenant tables have both ENABLE and FORCE RLS. A single checked-out connection holds each transaction and its transaction-local actor/org context.
- Profile exports contain reviewed metadata only. Kubeconfig/exec auth, tokens, certificates, cloud credentials, local files, logs and secrets are rejected. Remote actions never run without local review and content-hash trust.
- EN/TR in the same UI change, source strings as keys, identifiers/content unchanged. Console uses local fonts. Private desktop work updates its Rust/TS/mock IPC sides together through the desktop plan.
- Fixtures use an ephemeral PostgreSQL 17 database and fake IdP/billing/email services. Never use real clusters, `~/.kube`, production provider accounts, customer addresses or real cards from tests. Sandbox provider rehearsal is separate, documented and uses provider test instruments.
- Do not create paid accounts, accept provider contracts, generate production keys, change DNS, send real invitations, charge cards, reset Git history or deploy as part of implementing local tasks unless that action is separately authorized. Implementation can continue through fixtures while live prerequisites remain pending.

## Task dependencies and working conventions

Tasks 1–5 establish repository contracts/isolation; 6–10 identity and seats; 11–17 billing and leases; 18–20 profiles; 21–23 console/portability; 24–26 operations and release evidence. Desktop implementation can proceed against generated contract fixtures after Task 2; integration requires Task 17 and the desktop auth/lease tasks. Never parallelize changes to the canonical policy file or schema migration sequence without assigning an owner.

Each task adds meaningful boundary tests before or alongside implementation, runs its listed targeted tests and records actual results. Do not add tests that merely assert implementation internals. Keep fixture clocks deterministic, avoid real sleeps, and inspect failure cases as well as happy paths. No fixed test count is promised. A task passes when its named behavior and tests pass; a provider onboarding gate is not passed by a fake adapter.

Task 1 creates these root scripts so the commands below have precise meaning:

| Command                                                        | Contract                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                               | all private TS packages, no emitting                                                                        |
| `pnpm lint`                                                    | TypeScript/React lint + secret-sensitive logging guard                                                      |
| `pnpm i18n:check`                                              | EN/TR completeness and placeholder checks for private UI; reuse public checker rules without editing vendor |
| `pnpm contracts:generate` / `pnpm contracts:check`             | generate TS/OpenAPI/JSON fixtures; check produces no diff                                                   |
| `pnpm test:unit -- <path>`                                     | Vitest unit config, no network                                                                              |
| `pnpm test:integration -- <path>`                              | Vitest integration config against disposable PostgreSQL 17 and fake HTTP providers                          |
| `pnpm test:contract -- <path>`                                 | shared provider/schema/fixture conformance suite                                                            |
| `pnpm test:e2e -- <path>`                                      | Playwright against console, API, test DB and fake providers                                                 |
| `pnpm db:test:up`, `pnpm db:test:migrate`, `pnpm db:test:down` | disposable local Compose DB only; hostname/name safety guard                                                |
| `pnpm build`                                                   | production API/worker/console build without live secrets                                                    |
| `pnpm verify:oss-boundary`                                     | public checkout independently builds/tests with private access denied                                       |

All paths below are relative to the future private repository unless explicitly prefixed `public:`. Test database scripts require `KUBEPIT_TEST_DATABASE_URL` for `127.0.0.1`/`localhost` and a `kubepit_test_` database, and never fall back to `DATABASE_URL`. CI gets disposable service containers and credentials generated for that run.

## Review focus

1. Two administrators invite into the last seat simultaneously: exactly one succeeds, neither a retry nor email failure double-reserves capacity.
2. A request reuses a pooled connection after another org's transaction fails: it sees no prior tenant rows; missing context denies access.
3. Payment succeeds remotely but the response is lost: one operation stays pending and reconciles; no repeated charge or second subscription.
4. An old subscription event arrives after cancellation/refund: current provider truth wins, paid-through does not move forward from the stale event.
5. A removed member is offline: cloud access is immediate-deny, known revocation disables new local premium work, previously valid offline use lasts at most the signed cap. Free local cluster access continues.
6. Team profile contents contain credentials, hostile YAML, cross-org IDs or a newly changed command: upload is blocked or bounded; command execution still requires local trust.
7. A production database restore brings back old sessions/events: the recovery runbook revokes session families and reconciles billing before premium writes resume.

### Task 1: Establish the private workspace and reproducible test harness

**Files:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.node-version`, `tsconfig.base.json`, `apps/api/{package.json,src/app.ts}`, `apps/console/package.json`, `packages/{db,contracts,billing}/package.json`, `vitest.*.config.ts`, `playwright.config.ts`, `ops/compose.test.yml`, `scripts/test-db.mjs`, `docs/decisions/001-runtime.md`.

**Produces:** a private-only scaffold with Node 24/Fastify 5/PostgreSQL 17, pinned lockfiles, test scripts above and isolated fake-provider bootstrapping. It does not create a remote repository or deploy anything.

- [ ] Confirm the program's repository/ownership decision and the public commit to pin in `vendor/kubepit`; document its license/alternative commercial grant prerequisites. Do not choose a floating branch or rewrite public history.
- [ ] Scaffold the workspaces and lock patch versions after checking their current official compatibility. Use `pg` connection pools, Drizzle and TypeBox/JSON Schema-compatible Fastify validation with one chosen schema toolchain.
- [ ] Add test DB safety checks, test-specific environment parsing and a fixture clock. Write `tests/unit/test-database-guard.test.ts` cases `rejects_production_host`, `rejects_generic_database_url`, `requires_test_database_prefix`.
- [ ] Add `tests/integration/harness.test.ts::migrates_disposable_postgres_17`; create/drop only its disposable schema/database. Unit tests deny outbound fetch by default; integrations allow only loopback fake endpoints.
- [ ] Run `pnpm typecheck`, `pnpm test:unit -- tests/unit/test-database-guard.test.ts`, then `pnpm db:test:up`, `pnpm db:test:migrate`, `pnpm test:integration -- tests/integration/harness.test.ts`. Expected: safe local DB succeeds, unsafe URLs fail before connection. Leave no fixtures in a real data directory.

### Task 2: Freeze shared policy and wire contracts

**Files:** `packages/contracts/src/{commercial-policy.ts,errors.ts,auth.ts,organizations.ts,billing.ts,profiles.ts,entitlements.ts,index.ts}`, `packages/contracts/fixtures/`, `packages/contracts/openapi.json`, `scripts/generate-contracts.ts`, `tests/contract/policy.test.ts`, `docs/decisions/002-commercial-contract.md`.

**Produces:** policy constants, error envelope, versioned JSON schemas, OpenAPI, TS DTOs and Rust-readable golden fixtures; no hand-maintained duplicate of price/lease constants.

- [ ] Encode exact cents, currency, feature IDs, freshness/grace cap, DPoP nonce/replay/skew limits, supported schema version, fixed audience `kubepit-desktop-pro` and production issuer configuration constraints. Define times as UTC seconds in JWS and ISO timestamps in REST DTOs.
- [ ] Define strict body/response schemas with unknown fields rejected, bounds, snake_case fields, UUIDs, cursor pagination, request IDs and stable errors from the spec. Add generated contract checks for desktop fixtures rather than a dependency from OSS core to private source.
- [ ] Write `policy.test.ts` cases `annual_discount_is_one_sixth`, `prices_are_integer_cents`, `offline_cap_starts_at_authoritative_time`, `grace_never_exceeds_paid_through`, `all_errors_have_public_safe_shapes` and `generated_rust_fixtures_match_policy`.
- [ ] Run `pnpm contracts:generate`, `pnpm contracts:check`, `pnpm test:contract -- tests/contract/policy.test.ts`, `pnpm typecheck`. Expected: deterministic generation, no unreviewed diff and no private implementation required to consume a public interoperability schema.
- [ ] Send the fixture hash and exact IDs/claim names to the desktop implementer; record the handoff. Schema changes after this task require coordinated consumers/tests.

### Task 3: Create constrained organization, membership and team tables

**Files:** `packages/db/src/schema/{identity,organizations,teams,seats}.ts`, `packages/db/migrations/0001_identity_tenancy.sql`, `tests/integration/tenancy-constraints.test.ts`.

**Produces:** global identity/session table skeletons and tenant org/membership/team/invite/seat-account/allocation schema from the design.

- [ ] Implement UUID IDs, bounded role/status enums, `(org_id,id)` unique keys and composite FKs. Add unique membership/org/person, team membership and partial allocation uniqueness; exactly one allocation target, positive purchased quantity where active, no negative capacity.
- [ ] Design the locking/triggers needed to enforce seat capacity in the database as well as service code; no silent FK bypass in bulk import. Require organization → seat account → membership/invitation lock order. Include `pending_lower_capacity` plus operation ID; allocators obey `min(settled,pending_lower)` while a decrease is unresolved. Include `ready/capacity_conflict` state: only the narrowly authorized reconciler may persist externally proven under-capacity together with conflict state/audit, while retaining visible assignments and blocking allocation increases.
- [ ] Add migration round-trip validation in an empty test database; review SQL rather than trusting generated DDL.
- [ ] Write cases `cross_org_team_member_fk_fails`, `same_person_cannot_have_two_memberships`, `one_allocation_per_member`, `allocation_requires_exactly_one_target`, `cannot_insert_beyond_capacity` and `removed_member_cannot_retain_assignment`.
- [ ] Run `pnpm db:test:migrate`, `pnpm test:integration -- tests/integration/tenancy-constraints.test.ts`. Expected: constraints reject direct invalid SQL, including queries bypassing the application service.

### Task 4: Enforce RLS and transaction-local context

**Files:** `packages/db/migrations/0002_roles_rls.sql`, `packages/db/src/{tenantTransaction.ts,identityScope.ts}`, `apps/api/src/infrastructure/db/index.ts`, `tests/integration/{rls,pool-isolation}.test.ts`.

**Produces:** nonowner `api_runtime`/`worker_runtime`, restricted auth/intake roles, migration-only owner, FORCE RLS and safe context wrappers.

- [ ] Enable and force RLS on all tenant tables. Define both USING/WITH CHECK; missing context fails closed. Revoke PUBLIC privileges and prevent runtime role escalation/DDL/BYPASSRLS.
- [ ] Implement `withTenantTransaction(actor, orgId, fn)` using one checked-out `pg` client, `BEGIN`, parameterized transaction-local `set_config`, Drizzle transaction handle and finally commit/rollback/release. Nested services take the handle; they cannot select the global pool accidentally.
- [ ] Add a narrow identity-scoped membership resolver needed before selecting an organization. If security-definer SQL is needed, fix its search path, revoke PUBLIC execution and prohibit dynamic SQL/user-supplied actor override.
- [ ] Write `missing_context_denies`, `cross_org_reads_and_writes_denied`, `runtime_cannot_disable_rls`, `new_tenant_table_requires_policy`, `rollback_resets_pooled_context`, `concurrent_requests_keep_context` and `privileged_resolver_exposes_only_self`.
- [ ] Run `pnpm test:integration -- tests/integration/rls.test.ts tests/integration/pool-isolation.test.ts`. Expected: tests use runtime credentials for normal operations and fail if run as owner; no tenant rows appear after context omission or pooled reuse.

### Task 5: Add durable jobs, outbox and HTTP idempotency

**Files:** `packages/db/src/schema/{jobs,idempotency}.ts`, `packages/db/migrations/0003_jobs_outbox.sql`, `apps/api/src/infrastructure/{jobs,outbox}/`, `apps/api/src/modules/shared/idempotency.ts`, `tests/integration/{outbox,idempotency,jobs}.test.ts`.

**Produces:** transactional outbox, PostgreSQL leased jobs and API operation deduplication.

- [ ] Add payload versions, org/global scopes, unique dedupe keys, `run_after`, lease owner/expiry, heartbeat, attempts and dead-letter fields. Workers use SKIP LOCKED and short transactions; remote I/O happens outside locks.
- [ ] Implement jittered bounded retries, ten-attempt dead letter, stalled lease recovery and graceful worker shutdown. One handler version must safely replay the previous deployed payload version.
- [ ] Scope HTTP idempotency by actor/org/route/key and canonical request hash; same body returns original operation, changed body returns 409. Keep records 7 days, while immutable billing operation uniqueness survives that cache lifetime.
- [ ] Write `rollback_enqueues_nothing`, `crash_after_send_replays_without_second_effect`, `expired_lease_can_be_reclaimed`, `two_workers_do_not_claim_same_lease`, `changed_request_conflicts`, `another_org_cannot_read_cached_response`.
- [ ] Run `pnpm test:integration -- tests/integration/outbox.test.ts tests/integration/idempotency.test.ts tests/integration/jobs.test.ts`. Expected: at-least-once execution, once-per-business-operation effects, no claim of exactly-once delivery.

### Task 6: Integrate hosted authentication and browser sessions

**Files:** `apps/api/src/modules/auth/{identityProvider.ts,workos.ts,fake.ts,webRoutes.ts,webSessions.ts,csrf.ts}`, `packages/db/migrations/0004_auth_sessions.sql`, `tests/integration/web-auth.test.ts`, `docs/security/auth.md`.

**Produces:** managed sign-in via exact redirect URIs, identity mapping and opaque secure browser sessions.

- [ ] Implement the official AuthKit SDK adapter and a deterministic fake with the same verified identity interface. Validate state/single-use callback, protocol requirements, subject identity and verified email; never auto-link by unverified email.
- [ ] Persist only needed identity attributes; encrypt provider session/refresh material with envelope encryption. Emit Secure/HttpOnly/SameSite Lax host-only cookies. Enforce origin/CSRF checks for mutations, idle/absolute expiry and recent reauth for sensitive operations.
- [ ] Map provider logout/revocation to local sessions; rate-limit start/callback. Redact query secrets and reject open return URLs; allow only relative console destinations on the configured origin.
- [ ] Write `callback_state_replay_fails`, `unverified_email_cannot_link`, `csrf_rejects_foreign_origin`, `cookie_flags_are_secure`, `expired_session_denied`, `provider_revocation_invalidates_session`, `auth_failure_does_not_create_session`.
- [ ] Run `pnpm test:integration -- tests/integration/web-auth.test.ts`, `pnpm typecheck`. Expected: fake hosted browser flow works without passwords or live IdP; production setup remains a separately documented gate.

### Task 7: Implement one-use desktop login and rotating credentials

**Files:** `apps/api/src/modules/auth/{desktopRoutes.ts,loginAttempts.ts,desktopSessions.ts,refresh.ts,devices.ts,dpop.ts}`, `tests/integration/desktop-auth.test.ts`, `tests/contract/desktop-dpop.test.ts`, `packages/contracts/fixtures/{desktop-login,desktop-dpop}/`.

**Produces:** login attempt → browser approval → proof-bound exchange, opaque 15-minute access and rotating 30-day idle/90-day absolute refresh credentials.

- [ ] Add 5-minute attempt expiry, 256-bit polling secret hashes, S256 verifier challenge, random state, device-key thumbprint, browser verification code and explicit CSRF-protected approval. Polling uses a POST body, not bearer material in URLs, with 2-second minimum interval.
- [ ] Consume approval/exchange atomically, permit exactly one successful exchange, bind tokens to the approved identity/device and never return IdP credentials. Store refresh hashes/families; detect reuse and revoke family.
- [ ] Require standard RFC 9449 DPoP ES256 proofs and RFC 7638 JWK thumbprints at exchange/key enrollment, refresh and protected desktop calls. Validate method/URL/nonce/iat/jti and applicable access-token hash with reviewed JOSE libraries; use PostgreSQL replay records. Return token_type DPoP and reject ordinary bearer presentation. A proposed fingerprint without key proof never enrolls a device. Generate exact fixtures/policy described in the design for the Rust implementer.
- [ ] Add own-device list/revoke/logout and max-five-device policy, with no hardware fingerprint or seat multiplication. A revoked device cannot refresh, issue leases or access cloud data.
- [ ] Write `intercepted_attempt_without_verifier_fails`, `wrong_state_fails`, `approval_get_cannot_mutate`, `two_exchanges_issue_one_session`, `poll_secret_never_logged`, `refresh_reuse_revokes_family`, `device_limit_is_not_a_seat_charge`, `fingerprint_without_proof_cannot_enroll`, `wrong_nonce_method_url_or_token_hash_denied`, `dpop_replay_denied`.
- [ ] Run `pnpm test:integration -- tests/integration/desktop-auth.test.ts`, `pnpm test:contract -- tests/contract/desktop-dpop.test.ts`, `pnpm contracts:check`. Expected: handoff fixtures consumed by desktop auth tests; OS-store persistence is implemented by the desktop workstream, never by TS renderer code.

### Task 8: Implement organization lifecycle and role authorization

**Files:** `apps/api/src/modules/organizations/{service.ts,policy.ts,routes.ts}`, `apps/api/src/modules/teams/{service.ts,routes.ts}`, `tests/integration/{organizations,roles}.test.ts`.

**Produces:** org/team APIs and the exact owner/admin/member/billing_admin matrix from the spec.

- [ ] Create an org with one owner, zero paid seats and no automatic subscription. List only current identity memberships; cap self-serve org creation at five/identity. Use 404 for inaccessible org IDs.
- [ ] Enforce role permissions server-side including billing-admin exclusion from profiles, owner-only privileged role grants and deletion/transfer. Owner/admin management is separate from paid usage; premium operations also require a seat.
- [ ] Lock organization rows for role/removal changes so two requests cannot remove the last owner. Implement If-Match revisions on mutable org/member/team records and composite scoped team references.
- [ ] Write `org_creation_does_not_bill`, `last_owner_concurrent_demotions_fail`, `admin_cannot_promote_owner`, `billing_admin_cannot_read_profiles`, `member_cannot_assign_seats`, `guessed_other_org_is_404`.
- [ ] Run `pnpm test:integration -- tests/integration/organizations.test.ts tests/integration/roles.test.ts`. Expected: all matrix cells exercised through HTTP with actual runtime RLS roles.

### Task 9: Implement atomic seat assignments and reserved invitations

**Files:** `apps/api/src/modules/seats/{service.ts,routes.ts}`, `apps/api/src/modules/organizations/{invitations.ts,invitationRoutes.ts}`, `tests/integration/{seat-concurrency,invitations}.test.ts`.

**Produces:** unique assigned/reserved org slots, invitation lifecycle and removal without implicit billing changes.

- [ ] Lock seat account before allocation; reserve capacity before enqueueing invitation mail. Pending same-email retry reuses invitation; invitation state/expiry and partial uniqueness stay consistent. A mail outage leaves a visible retryable invite, not a hidden second reservation.
- [ ] Accept only authenticated matching verified email; consume token, create/reuse membership, convert reservation and attach same-org teams in one transaction. Expiry/cancel/accept races have one terminal outcome.
- [ ] Unassign/remove immediately revokes org access, increments entitlement version and releases allocation without calling billing quantity mutation. Non-seat billing/admin invitations consume no capacity.
- [ ] Write `two_last_seat_invites_only_one_succeeds`, `accept_expire_race_has_one_outcome`, `existing_member_acceptance_cannot_double_allocate`, `wrong_email_cannot_accept`, `removal_frees_slot_without_provider_call`, `multiple_teams_use_one_seat`.
- [ ] Run `pnpm test:integration -- tests/integration/seat-concurrency.test.ts tests/integration/invitations.test.ts` with repeated deterministic concurrent barriers, not timing sleeps. Expected: capacity invariant holds under direct SQL and service-level races.

### Task 10: Add bounded transactional email and security notifications

**Files:** `apps/api/src/infrastructure/mail/{provider.ts,fake.ts,templates.ts,worker.ts}`, `apps/api/src/modules/auth/providerEvents.ts`, `tests/integration/{mail,identity-revocation}.test.ts`, `apps/console/src/i18n/{en,tr}.json`.

**Produces:** invitation, device-sign-in and security emails through an outbox adapter; no messages sent to real people by tests.

- [ ] Choose the production mail vendor only after region/cost approval; implement an adapter with fake transport first. Fixed EN/TR templates escape all user names; URLs are fixed-origin and no arbitrary HTML/body API exists.
- [ ] Set per-identity/org/IP send/resend caps, bounce suppression, complaint handling and generic invite responses to prevent enumeration. Configure attempt expiry/resend without multiplying reservations.
- [ ] Verify managed identity webhook signatures and deduplicate events; disable application sessions for disabled identities and reconcile on refresh. Do not let provider organization claims overwrite application memberships.
- [ ] Write `retry_sends_one_business_invitation`, `template_escapes_org_name`, `resend_cap_is_enforced`, `bounced_address_stops_retries`, `identity_disabled_revokes_all_app_sessions`, `org_claim_does_not_grant_role`.
- [ ] Run `pnpm test:integration -- tests/integration/mail.test.ts tests/integration/identity-revocation.test.ts`, `pnpm i18n:check`. Expected: only fake inbox receives messages; real sending-domain verification stays in the go-live checklist.

### Task 11: Model billing SKUs, operations and provider interfaces

**Files:** `packages/billing/src/{provider.ts,model.ts,fake.ts,prices.ts}`, `packages/db/src/schema/billing.ts`, `packages/db/migrations/0005_billing.sql`, `tests/contract/billing-provider.test.ts`, `tests/unit/billing-economics.test.ts`.

**Produces:** adapter capabilities, immutable SKU mapping and one subscription/org with durable billing operations/documents/adjustments.

- [ ] Consume canonical cents from Task 2; map environment-owned provider price IDs. API never accepts a price or arbitrary amount from the client. Provider customer/subscription/transaction IDs are unique and environment-scoped.
- [ ] Implement the normalized state model, paid-through and verified-at separately from renewal dates, pending increases and settled capacity. Enforce one open subscription-creation operation/org and one current subscription record/org.
- [ ] Model checkout/change quotes with amount, currency, tax, interval, expiry and request hash. Local fee examples remain illustrative and cannot calculate authoritative tax/proration.
- [ ] Write adapter conformance for checkout/preview/change/cancel/portal/fetch/signature/event operations, plus `one_org_one_current_subscription`, `client_amount_is_rejected`, `annual_discount_is_16_67_display_only`, `fee_examples_are_not_price_authority`.
- [ ] Run `pnpm test:contract -- tests/contract/billing-provider.test.ts`, `pnpm test:unit -- tests/unit/billing-economics.test.ts`, `pnpm db:test:migrate`. Expected: exact integer money, USD 3/month and USD 30/year, no hidden min-seat purchase.

### Task 12: Implement Paddle sandbox adapter and merchant decision record

**Files:** `packages/billing/src/paddle/{client.ts,adapter.ts,normalize.ts,verify.ts}`, `tests/contract/paddle.test.ts`, `tests/fixtures/paddle/`, `docs/decisions/003-payments.md`, `.env.example`.

**Produces:** selected Paddle implementation against versioned fixtures and official SDK; conditional live configuration, never live credentials in the repo.

- [ ] Recheck official Paddle SDK/API docs at implementation time; use sandbox endpoints and separate keys. Implement all used capabilities and explicitly reject unsupported ones rather than approximating them.
- [ ] Record seller-country/entity unknowns, Paddle preference, merchant approval requirements and written pricing for the <$10 product. Record applicable tax/refund/dispute terms only after approval; the headline fee is not the negotiated fee.
- [ ] Add env validation and read-only sandbox/startup preflight fetching configured product/price IDs: verify USD 300/3000, recurring interval/count, product, active status, quantity bounds, tax mode and environment. Mismatch disables checkout with an operator alert. Refuse mixed sandbox/live resources. Expose portal with only permitted capabilities; quantity changes stay in our seat-aware service.
- [ ] Write `paddle_conforms_to_provider_contract`, `unknown_price_is_not_entitled`, `wrong_unit_interval_tax_or_currency_disables_checkout`, `sandbox_live_mix_rejected`, `portal_cannot_bypass_quantity_policy`, `invalid_signature_rejected` using official-shape sanitized fixtures.
- [ ] Run `pnpm test:contract -- tests/contract/paddle.test.ts`. Optional manual sandbox exercise uses only provider test instruments and is documented separately. Expected: fake/fixture CI passes without merchant approval; live checkout remains disabled until approval.
- [ ] If Paddle cannot onboard the actual seller or the product economics are unacceptable, pause only provider activation and implement/review a Stripe adapter after explicit merchant-country eligibility/tax decision. Do not quietly switch providers or migrate subscribers.

### Task 13: Implement quote, checkout and explicit subscription changes

**Files:** `apps/api/src/modules/billing/{routes.ts,checkout.ts,changes.ts,operations.ts,portal.ts}`, `tests/integration/{checkout,billing-changes}.test.ts`.

**Produces:** authorized, idempotent purchase/change/cancel/resume operations with reviewable quotes.

- [ ] Require owner/billing_admin and recent reauth for monetary changes. Validate SKU/quantity 1–100, current org revision and Idempotency-Key. Persist operation/outbox before provider calls.
- [ ] Grant initial capacity only after provider-confirmed purchase; checkout redirect polls operation state and never activates a plan. Reuse known checkout/operation on retry; an ambiguous external timeout becomes pending reconciliation.
- [ ] Increase capacity after confirmed settled prorated charge. Decrease only through explicit preview/confirm and if new quantity >= assigned+reserved; no automatic refund, capacity reduced on confirmation and lower charge next renewal. Under the seat-account lock, persist `pending_lower_capacity` tied to the operation before remote dispatch. Every assignment/invite obeys that ceiling; on confirmed failure release it, on ambiguous timeout retain it until reconciliation, on success settle it. Never hold a DB transaction across provider HTTP. Use provider's exact proration behavior and clarify effective dates.
- [ ] Cancel at period end preserves paid-through; resume is explicit. Plan interval switch requires supported exact preview; expired quotes or changed occupancy return a conflict for re-review.
- [ ] Write `redirect_cannot_grant_seats`, `lost_checkout_response_does_not_create_second_subscription`, `increase_waits_for_payment`, `decrease_below_reserved_fails`, `invite_during_pending_decrease_obeys_lower_ceiling`, `ambiguous_decrease_keeps_ceiling_until_reconciled`, `member_removal_never_decreases_bill`, `quote_change_requires_review`, `cancel_keeps_paid_time`.
- [ ] Run `pnpm test:integration -- tests/integration/checkout.test.ts tests/integration/billing-changes.test.ts`. Expected: no provider call from an unauthorized role, no client-supplied monetary authority and no duplicate charges under retries.

### Task 14: Build signature-verified durable webhook intake

**Files:** `apps/api/src/modules/billing/{webhookRoutes.ts,eventIntake.ts}`, `packages/db/migrations/0006_provider_intake.sql`, `tests/integration/webhook-intake.test.ts`.

**Produces:** a bounded raw-body route that authenticates before parsing and durably accepts/deduplicates provider events.

- [ ] Exempt only this route from normal JSON body parsing; cap raw bytes, verify documented signature/timestamp/environment using the SDK and disable body/header logging. Never weaken signature checks for live retry convenience.
- [ ] Persist unique provider/environment/event ID, encrypted raw payload reference and worker outbox job in one transaction. Duplicate verified event returns success; persistence failure returns retryable failure, not success.
- [ ] Add the narrow provider-to-org mapping boundary and grant only needed privileges to intake/worker roles; unbound customer/subscription events go to quarantine, not a client-supplied org ID.
- [ ] Write `raw_whitespace_change_breaks_signature`, `stale_signature_rejected`, `duplicate_event_one_job`, `db_failure_not_acknowledged`, `custom_data_cannot_hijack_other_org`, `body_limit_precedes_expensive_processing`.
- [ ] Run `pnpm test:integration -- tests/integration/webhook-intake.test.ts`. Expected: quick durable response, no business-state changes on the HTTP handler's happy path and no secrets in test-captured logs.

### Task 15: Reconcile billing events, retries and disputed payments

**Files:** `apps/api/src/modules/billing/{reconcile.ts,eventWorker.ts,scheduler.ts,adjustments.ts}`, `tests/integration/{billing-reconcile,billing-adjustments}.test.ts`.

**Produces:** convergence on authoritative provider state despite delivery/order/outage faults.

- [ ] Fetch current provider subscription/transaction for access/money changes outside DB locks; re-lock and compare revision before applying. Derive paid-through/new capacity from confirmed paid transaction line items matched to the correct subscription/customer/SKU/quantity/period, not bare `active` status or an increased provider quantity after failed proration. Store that entitlement evidence. Atomically update settled capacity, pending-decrease ceiling, paid-through, entitlement versions and audit.
- [ ] Run minute pending-operation, 15-minute troubled/recent subscription and daily active sweeps; stale lease issuance checks trigger reconcile after six hours. Failed fetch never advances paid-through or authoritative validation time.
- [ ] Handle old/same-timestamp contradictory events, refunds, dispute suspension/reversal and recovery. Partial refunds require adjustment semantics, not blanket seat cancellation. Alert on duplicate actual subscriptions. For externally proven capacity below allocations, record truthful capacity and enter `capacity_conflict`, retaining assignments for visibility, denying new allocations/invite acceptance/leases and paid cloud profile reads/writes. Permit billing/seat-removal/invite-cancel/export/delete repairs and free core use. Bump org entitlement version; recover only after settled capacity covers deliberately retained occupancy. Never silently select victims or fake capacity to preserve the normal invariant.
- [ ] Write `duplicate_and_reversed_events_converge`, `old_active_after_cancel_does_not_reactivate`, `payment_timeout_reconciles_without_second_charge`, `failed_payment_does_not_advance_paid_through`, `active_subscription_with_unpaid_increase_grants_no_extra_seat`, `wrong_subscription_payment_cannot_extend_term`, `external_decrease_records_truth_and_conflict_without_eviction`, `capacity_conflict_denies_premium_but_allows_repair_export`, `deliberate_removal_or_paid_purchase_resolves_conflict`, `full_refund_revokes_current_term`, `partial_refund_does_not_remove_every_seat`, `dispute_reversal_requires_authoritative_recovery`.
- [ ] Run `pnpm test:integration -- tests/integration/billing-reconcile.test.ts tests/integration/billing-adjustments.test.ts`. Expected: final state matches fake provider truth for every event permutation and operator repair has an idempotent audit trail.

### Task 16: Implement entitlement policy and signed leases

**Files:** `apps/api/src/modules/entitlements/{policy.ts,signer.ts,kmsSigner.ts,routes.ts}`, `packages/db/src/schema/entitlements.ts`, `tests/{unit/entitlement-policy,integration/entitlements}.test.ts`, `packages/contracts/fixtures/entitlements/`.

**Produces:** ES256 lease issuance backed by current session, membership, seat and paid-through, with canonical timings and device binding.

- [ ] Implement fake/test signer and production KMS P-256 adapter; use fixed algorithm/issuer/audience, key IDs and no private key in source/env files. Publish/ship approved public verification keys through the desktop build contract.
- [ ] Compute fresh/grace/exp exactly from canonical policy and authoritative timestamp; cap by paid-through. Never issue for billing_admin, unassigned member, unconfirmed purchase, wrong device or stale state that cannot be authoritatively reconciled.
- [ ] Add lease issue audit and entitlement versions for revocation. Backend live data APIs do not treat the lease as authorization. Errors distinguish known denial from transport/provider outage without disclosing another org.
- [ ] Write `paid_through_caps_every_time`, `seven_days_is_total_not_eight`, `removed_seat_denied`, `cloud_does_not_accept_offline_lease`, `failed_reconcile_does_not_renew_clock`, `lease_has_no_email_or_secret`.
- [ ] Run `pnpm test:unit -- tests/unit/entitlement-policy.test.ts`, `pnpm test:integration -- tests/integration/entitlements.test.ts`, `pnpm contracts:check`. Expected: deterministic JWS fixtures and no issuance based on client paid flags.

### Task 17: Verify desktop/session/lease interoperability and revocation

**Files:** `tests/contract/desktop-entitlements.test.ts`, `packages/contracts/fixtures/entitlements/manifest.json`, `docs/security/offline-access.md`; coordinate with `crates/kubepit-commercial/tests/entitlements.rs` owned by the desktop plan.

**Produces:** one cross-language acceptance matrix covering authentication, lease states and free-core continuation.

- [ ] Exchange test fixtures for valid fresh/grace/expired, tampered signature, unknown kid, wrong issuer/audience/org/subject/device, future nbf, inverted timestamps, revoked version and clock rollback. Test key rotation overlapping old/new leases.
- [ ] Run the desktop verifier against actual API-signed test leases; ensure generated Rust fixtures use the canonical policy rather than duplicate numeric literals. Assert renderer-visible status contains no bearer/refresh token.
- [ ] Distinguish expired access from authoritative revocation: `ACCESS_TOKEN_EXPIRED` triggers one serialized refresh/retry; ordinary profile `FORBIDDEN_ROLE`/404 is resource-scoped. Only authenticated membership/seat/subscription/entitlement denial (including explicit `CAPACITY_CONFLICT`) invalidates that org's lease; confirmed session/family revocation or logout invalidates its sessions' leases. A transport timeout can use an existing valid lease without extending it. A truly offline client can retain prior local paid ability only to its signed cap; document that downloaded data cannot be erased remotely.
- [ ] Write `authoritative_denial_is_not_grace`, `expired_access_refreshes_once_without_revoking_lease`, `profile_permission_denial_does_not_revoke_other_premium_features`, `restart_cannot_extend_grace`, `unpaid_core_remains_usable`, `logout_clears_cached_lease`, `wrong_org_lease_cannot_switch_org`, `old_key_overlap_is_bounded`.
- [ ] Run `pnpm test:contract -- tests/contract/desktop-entitlements.test.ts` and, after desktop crate exists, `cargo test -p kubepit-commercial --test entitlements --locked`. Expected: both sides agree on every fixture; report desktop dependency pending rather than inventing a pass.

### Task 18: Add profile schema, secret rejection and storage

**Files:** `packages/contracts/src/profile-document.ts`, `packages/db/src/schema/profiles.ts`, `packages/db/migrations/0007_profiles.sql`, `apps/api/src/modules/profiles/{validate.ts,repository.ts,limits.ts}`, `tests/integration/profile-validation.test.ts`, `tests/fixtures/profiles/`.

**Produces:** credential-free versioned profile document ingestion, bounded immutable revisions and same-org targeting.

- [ ] Reuse the desktop's agreed `KubepitTeamProfile` format and publish schema interoperability; reject unknown versions/keys, credential-shaped keys, credentialed URLs, forbidden exec-auth/local paths and known secret patterns. Preserve Unicode user content without translating it.
- [ ] Enforce body/depth/entity counts, 1 MiB/doc, 50 profiles/org, 100 MiB aggregate and retained revision bounds. If YAML is supported, disable custom tags/unsafe constructors and expansion; parse with explicit alias/depth limits before validation.
- [ ] Store immutable validated canonical document, SHA-256 and monotonic revision; keep raw rejected payloads out of logs/audit. Add composite FKs for head/revisions/targets.
- [ ] Write `secret_fixture_never_persists`, `nested_credentials_rejected`, `userinfo_url_rejected`, `yaml_alias_bomb_bounded`, `unicode_roundtrip_stable`, `cross_org_target_fk_fails`, `aggregate_limit_transactional`.
- [ ] Run `pnpm test:integration -- tests/integration/profile-validation.test.ts`, `pnpm contracts:check`. Expected: fixtures prove rejection/bounds; documentation acknowledges scanners cannot certify arbitrary free text nonsensitive.

### Task 19: Implement profile access, conditional writes and polling

**Files:** `apps/api/src/modules/profiles/{routes.ts,service.ts,access.ts}`, `tests/integration/{profile-access,profile-sync}.test.ts`.

**Produces:** live-authorized profile APIs, ETags, immutable revisions and conflict-safe edits.

- [ ] Implement org-wide/team visibility and owner/admin edit rights; premium use requires a seat, billing role gains no content access. Every GET/list/revision route checks live membership and scope.
- [ ] Return ETag `"p:<id>:r:<revision>"`; require If-Match on update/delete and If-None-Match or idempotency for creation. Support 304 reads, bounded metadata pagination and 404 for inaccessible IDs.
- [ ] Delete to a 30-day tombstone; full list reconciliation handles long-offline clients after tombstones expire. Preserve head during revision retention cleanup. No server-push execution or arbitrary URL fetching.
- [ ] Write `two_edits_one_precondition_conflict`, `missing_precondition_is_428`, `member_sees_only_targeted_profiles`, `team_removal_denies_next_read`, `etag_304_has_no_body`, `expired_tombstone_still_reconciles_missing_profile`.
- [ ] Run `pnpm test:integration -- tests/integration/profile-access.test.ts tests/integration/profile-sync.test.ts`. Expected: no lost drafts/last-write-wins overwrite and no cached lease bypass of cloud authorization.

### Task 20: Add audit, redaction, limits and abuse controls

**Files:** `apps/api/src/modules/audit/{service.ts,routes.ts,redaction.ts}`, `apps/api/src/infrastructure/{logging,rateLimits}/`, `packages/db/migrations/0008_audit_limits.sql`, `tests/integration/{audit,redaction,abuse}.test.ts`.

**Produces:** append-only scoped audit, safe operational logging and bounded low-cost API use.

- [ ] Audit auth/role/seat/billing/profile/export/deletion changes with IDs, outcomes and field names only. Grant runtime insert/select policies but not update/delete on audit; retention job uses a narrow controlled function.
- [ ] Redact sensitive headers/body/query fields before Pino output; auth/profile/webhook routes never log payloads. Error details and monitoring labels cannot include profile names, invitation tokens or provider secrets.
- [ ] Enforce documented per-IP/identity/org rate/body/storage limits using PostgreSQL counters or bounded local counters where single-instance semantics suffice; monetary/invite limits must persist across restarts. Add Retry-After and readable EN/TR errors.
- [ ] Write `all_secret_canaries_absent_from_logs_audit_exports`, `billing_admin_sees_only_billing_audit`, `runtime_cannot_rewrite_audit`, `invite_relay_abuse_throttled`, `limits_survive_process_restart`.
- [ ] Run `pnpm test:integration -- tests/integration/audit.test.ts tests/integration/redaction.test.ts tests/integration/abuse.test.ts`. Expected: intentional credential canaries do not leak even through errors/retries.

### Task 21: Build the account, organization, team and seat console

**Files:** `apps/console/src/{app,routes,components,api,i18n}/`, `apps/console/src/styles/`, `tests/e2e/organizations.spec.ts`, `tests/unit/console-permissions.test.ts`.

**Produces:** RunHQ-consistent EN/TR console with account/devices, org switch/create, members/invitations, teams and seats.

- [ ] Implement session boot, accessible sign-in/out and org navigation. Render least-privilege role capabilities, but treat hidden buttons only as UX; API remains authoritative. No tokens/localStorage session material.
- [ ] Show purchased/assigned/reserved/available seat counts and distinct invite states. Removal confirmation explicitly says capacity is freed but billed quantity stays unchanged; link billing-authorized users to explicit quantity management.
- [ ] Add last-owner protection feedback, invitation resend/cancel, pending provider/seat conflict feedback and device revocation. Use labeled dialogs, focus trap/return, keyboard access and visible error/status announcements.
- [ ] Translate all app-owned strings in EN/TR, preserve org names/content, bundle fonts locally and use tokens/primitives without adding a UI/chart library.
- [ ] Write E2E `owner_invites_and_assigns_last_seat`, `billing_admin_cannot_open_profiles`, `membership_removal_keeps_other_org`, `keyboard_dialog_focus_returns`, `turkish_flow_has_no_missing_keys`.
- [ ] Run `pnpm typecheck`, `pnpm i18n:check`, `pnpm test:unit -- tests/unit/console-permissions.test.ts`, `pnpm test:e2e -- tests/e2e/organizations.spec.ts`. Expected: both languages and keyboard-only core flows work against fakes.

### Task 22: Build billing and profile review console flows

**Files:** `apps/console/src/routes/{billing,profiles}/`, `apps/console/src/components/{BillingQuote,ProfileDiff,UploadReview}.tsx`, `tests/e2e/{billing,profiles}.spec.ts`.

**Produces:** exact-price checkout/changes/status UX and safe shared-profile administration.

- [ ] Show $3/seat/month and $30/seat/year with 16.67% annual saving, billed period, quantity, tax wording and provider-computed quote. Never label annual equivalent as an available monthly charge.
- [ ] Use hosted checkout/portal through server-generated URLs. Return page polls the operation; provide pending/retry/reconcile states, payment-failure recovery, cancellation date and export access after expiry. Never trust query-string `success=true`.
- [ ] Provide upload preview of exactly shared metadata, validation findings and targeted teams; confirm save against current ETag. A conflict preserves user's draft and opens review of latest authorized content.
- [ ] Expose license-status badges without claiming DRM is foolproof or immediate offline removal. Provide clear separation between SaaS metadata and locally held cluster credentials.
- [ ] Write `checkout_return_does_not_show_paid_before_confirmation`, `annual_quote_is_3000_cents_per_seat`, `decrease_requires_explicit_confirmation`, `profile_conflict_preserves_draft`, `secret_upload_cannot_submit`.
- [ ] Run `pnpm typecheck`, `pnpm i18n:check`, `pnpm test:e2e -- tests/e2e/billing.spec.ts tests/e2e/profiles.spec.ts`. Expected: exact monetary values and reviewed payloads, no live charges or real messages.

### Task 23: Implement portable export, retention and deletion lifecycle

**Files:** `apps/api/src/modules/privacy/{export.ts,deletion.ts,retention.ts,routes.ts}`, `apps/api/src/infrastructure/objects/`, `tests/integration/{exports,deletion,retention}.test.ts`, `docs/security/data-lifecycle.md`.

**Produces:** owner/personal exports, expiry-safe access, cancelable deletion and explicit legally retained financial records.

- [ ] Generate tenant-scoped JSON/YAML exports with temporary encrypted object storage, authenticated 15-minute link and 24-hour object cleanup. Allow authorized export after subscription expiry; never let removed members export other-org data.
- [ ] Require recent reauth and typed org name for deletion, freeze new premium changes, durably cancel renewal and surface unresolved cancellation before claiming success. Give 7-day undo window; purge product data then expire backups under approved policy.
- [ ] Personal deletion requires sole-owner transfer, revokes sessions and removes memberships without canceling other org subscriptions; request managed IdP deletion. Separate legal financial holds with purpose/access controls.
- [ ] Implement proposed retention durations from the spec as reviewed configuration; tombstone/revision cleanup preserves current head and event-dedupe metadata survives raw payload purge.
- [ ] Write `expired_customer_can_export`, `export_contains_only_one_tenant`, `download_link_expires`, `deletion_cannot_leave_hidden_renewal`, `sole_owner_must_transfer`, `raw_payload_purge_preserves_dedupe`, `held_financial_record_not_in_product_export`.
- [ ] Run `pnpm test:integration -- tests/integration/exports.test.ts tests/integration/deletion.test.ts tests/integration/retention.test.ts`. Expected: auditable state transitions and truthful retention messaging; legal durations remain launch approval, not inferred law.

### Task 24: Package deployment, migration and restore runbooks

**Files:** `ops/{Dockerfile,deploy/}`, `ops/runbooks/{deploy,rollback,restore,keys,billing-outage,idp-outage}.md`, `scripts/{migration-preflight,restore-rehearsal}.mjs`, `tests/integration/restore-recovery.test.ts`, `.github/workflows/ci.yml` in the private repo.

**Produces:** reproducible private CI/image and reviewable deployment assets; no automatic production deployment.

- [ ] Build API/worker from one image as nonroot; serve console on the configured origin with TLS/proxy/CSP settings. Use managed PostgreSQL 17 and secret references, runtime pool caps, health endpoints and graceful shutdown. Do not embed production keys in build args or frontend bundles.
- [ ] Add pinned CI actions, lockfile install, contract/unit/integration/e2e checks, secret/dependency/license scans and independent public-boundary checks. Keep migration credential available only to the migration job.
- [ ] Document region approval, encrypted PITR/backups, provisional RPO <=15m/RTO <=4h, daily snapshots 30d, restore rehearsal and spend alerts $40/$50/$60. These are targets, not promises that an unchosen provider meets them.
- [ ] Implement restore recovery that revokes pre-restore app session families, quarantines premium writes, reconciles provider truth and validates RLS/tenant counts before reopening. Document asymmetric key overlap/emergency response and why old offline leases cannot be instantly recalled.
- [ ] Write `restore_does_not_reactivate_revoked_cloud_sessions`, `billing_reconcile_precedes_premium_write_enable`, `migration_role_not_in_runtime_env`, `image_contains_no_secret_canaries`.
- [ ] Run `pnpm build`, `pnpm test:integration -- tests/integration/restore-recovery.test.ts`, `pnpm verify:oss-boundary`. Expected: local images and isolated restore work; actual hosting account, DNS and production deployment remain separately authorized.

### Task 25: Run isolation, load, cost and failure acceptance suites

**Files:** `tests/integration/adversarial-matrix.test.ts`, `tests/e2e/commercial-lifecycle.spec.ts`, `scripts/load-fixtures.mjs`, `docs/operations/acceptance-results.md`.

**Produces:** measured evidence that the service's boundaries, performance and lifecycle meet the provisional launch requirements.

- [ ] Run a matrix of every tenant route with correct/wrong org, roles, missing/removed seat, revoked session and expired plan, including list/export/revision paths. Test actual nonowner DB roles and all composite FKs.
- [ ] Exercise outbox crash, duplicated/out-of-order/missing webhooks, provider timeout after successful charge, IdP outage, database reconnect, key rotation, stale quote, last-seat invite race and concurrent owner changes with deterministic fakes.
- [ ] Measure 50 concurrent metadata clients against production build and fixture PostgreSQL; record p50/p95, pool saturation, webhook intake latency, queue lag, storage/retention growth and estimated monthly spend. Load test uses fake providers and no real clusters/accounts.
- [ ] Run lifecycle purchase → invite → profile publish → desktop fixture use → removal → cancellation → export → deletion; include Turkish and keyboard access. Confirm all free OSS workflows still function after sign-out/expiry.
- [ ] Run `pnpm contracts:check`, `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`, `pnpm test:unit`, `pnpm test:contract`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm build`, `pnpm verify:oss-boundary` once after final fixes. Coordinate the desktop plan's Rust checks; record unavailable environments honestly.
- [ ] Expected: no cross-tenant leak/double charge/seat over-allocation; p95 metadata <500 ms and webhook intake <2 s at fixture load or a documented blocking remediation. Cost estimate includes auth/mail/database/KMS/egress/backup/monitoring and approved low-value payment fees, not just server rent.

### Task 26: Prepare sandbox rehearsal and a concrete go-live handoff

**Files:** `docs/operations/{launch-checklist,sandbox-rehearsal,commercial-handoff}.md`, `docs/decisions/003-payments.md`, `packages/contracts/fixtures/compatibility.json`.

**Produces:** a reviewable release candidate and remaining-decision list; this task does not publish, charge a live card or claim external approvals.

- [ ] Complete the merchant-country/entity decision with the user. Record Paddle approval and applicable <$10 pricing, production product IDs, tax/refund/chargeback policy, auth/mail production setup, region/subprocessors, legal/ownership grants and customer terms. Unresolved items stay unchecked with an owner and precise blocker.
- [ ] In authorized provider sandbox accounts, rehearse sign-in, checkout, settlement webhook, quantity increase/decrease, failed payment/recovery, cancellation, refund/dispute simulator if supported and portal restrictions. Use test cards/addresses and record redacted evidence; no real charge is necessary.
- [ ] Rehearse restore and key rotation in an isolated environment, then link the evidence. Review published pricing text and canonical policy fixtures with desktop/strategy owners; verify agreed no-account OSS behavior and source/binary licensing boundary.
- [ ] Assemble image digest, migration versions, public-core commit, private desktop contract version, config variable names, secret-manager references, runbooks, checks/results, known limitations and rollback steps. Include exact activation sequence and first-invoice/first-renewal reconciliation checks.
- [ ] Expected: another agent can execute the documented deployment with separate explicit authorization and no guessing. Do not check “live ready” until all external prerequisites, selected provider contract tests, current entitlement integration and launch acceptance pass.

## Definition of done and stop conditions

The implementation is done when all local tasks have actual evidence, the independent public build is still account-free and legally distributable under the selected licensing model, the private desktop accepts the server's signed contracts, and the selected production provider is proven in sandbox. Production launch is a separate state requiring confirmed merchant/entity eligibility, approved fee economics at USD 3, terms/privacy/tax presentation, regions, production keys, backups and deployment authorization.

Stop only the affected activation step when a required external fact is unavailable. Continue independent fixture/schema/UI work. Never replace a denied/unknown provider requirement with an assumption, migrate customer subscriptions without a reviewed migration plan, or report a fixture pass as live-payment validation. Keep a short handoff log of task status, exact commands, remaining blockers and any deviations from the design. No automatic commits or history rewriting are prescribed by this plan.
