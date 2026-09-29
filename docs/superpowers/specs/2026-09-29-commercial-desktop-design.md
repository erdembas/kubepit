# Commercial desktop, team profiles and cloud import: design

Status: proposed implementation baseline · Date: 2026-09-29

Plan: `docs/superpowers/plans/2026-09-29-commercial-desktop.md`.
Companion service design and plan: the 2026-09-29 commercial-cloud documents in
these directories. The service contract is shared; neither side may silently
change authentication, entitlement or profile semantics independently.

This replaces the commercial scope and implementation placement of
`2026-09-28-team-sharing-design.md` and
`2026-09-28-cloud-import-and-local-clusters-design.md`. Their useful operational
requirements are incorporated below. The old local-file subscription system is
not a second sync backend for v1. Their instructions to add premium models to
`kubepit-core`, their unqualified no-secrets claim, and their commit/subskill
instructions must not be carried forward.

This is a planning document. It does not change licenses, create repositories,
open cloud accounts, deploy a service, charge anyone or implement functionality.

## Product boundary

Kubepit remains a useful, complete, local-first Kubernetes IDE without an account.
All functionality present when this design is accepted stays free: manual file
and pasted kubeconfig import, cluster access, the editor, terminals, Helm,
GitOps, metrics, logs, security, fleet operations, custom actions and the
assistant integrations with the user's own providers. Future local kind, k3d
and minikube lifecycle support also belongs to the free core. It is separately
scheduled; it is not a dependency or a paid capability of this launch.

One paid plan adds **Team cloud profiles** and **AWS EKS / GKE / AKS discovery
and import**, at **USD 3 per user per month or USD 30 per user per year**.
An individual can subscribe through a one-member organization. The service
owns seat assignment and billing truth; the desktop never infers paid status
from a checkout redirect. Taxes, invoicing and merchant eligibility follow the
service plan and the selected billing provider's confirmed commercial terms.

Paid cloud import automates CLI work the user can already perform. It is not a
Kubernetes access paywall. A kubeconfig imported during a subscription keeps
working after cancellation, expiry, seat removal, logout or account deletion,
subject to the cloud provider's own credential validity. Manual import,
reimport/repair, export, connect and exec authentication stay free. No entitlement
check is inserted into `cluster_connect`, `cluster_reimport_kubeconfig`, generic
resource commands, kubeconfig exec plugins, or existing terminal commands.

| Capability                                     | Community build       | Official build without paid seat        | Official build with paid seat        |
| ---------------------------------------------- | --------------------- | --------------------------------------- | ------------------------------------ |
| Existing free IDE and manual kubeconfig import | Available             | Available                               | Available                            |
| Future local kind/k3d/minikube management      | Free when implemented | Free when implemented                   | Same free feature                    |
| Cloud CLI discovery/import assistant           | Not compiled          | Optional account/upgrade entry point    | Available with valid entitlement     |
| Team profile publish/subscription/sync         | Not compiled          | Account/status and safe detachment only | Available with service authorization |
| Previously imported Kubernetes connections     | Available             | Available                               | Available                            |
| Stored local views, actions and preferences    | Available             | Available                               | Available                            |

No mandatory sign-in screen, timed free IDE trial, cloud polling before opt-in,
advertisement overlay or premium error stub is required in the community app.
The official binary can expose unobtrusive paid entry points in Add cluster and
Settings; dismissing them leaves normal workflows intact.

## Repository and licensing boundary

The proposed first public release uses **AGPL-3.0-only core**, an **alternative
commercial grant for the controlled core**, proprietary premium implementation,
and an independently implemented **MIT edition SDK/contracts**. The present
checkout says MIT; the user states it has never been pushed or distributed.
That is the planning premise, not a reason to erase rights provenance. Follow
`2026-09-29-commercial-licensing-and-repository.md` for ownership, CLA, SPDX,
third-party notices and legal review. This task changes no license or history.

The official combined Rust/React product must use a documented alternative
commercial grant covering all controlled core code it includes. A private
repository, compiled plugin, MIT wrapper or separate package does not itself
remove AGPL obligations. Rights inventory and a contribution agreement granting
the necessary alternative-license rights are release gates. Third-party
AGPL/GPL components cannot be relicensed by Kubepit without their rights holders'
permission; replace, exclude or obtain an appropriate license where required.
Public community recipients retain their actual AGPL rights to build, modify,
fork, redistribute and compete while complying with its terms. Those rights
are not conditioned on an account and do not include hosted service access.

```text
public kubepit/                         private kubepit-commercial/
  apps/desktop/                          vendor/kubepit/  (exact public Git revision)
    src/bootstrap.tsx                    apps/desktop-commercial/
    src/edition/                           src/main.tsx
    src-tauri/                             src-tauri/{Cargo.toml,tauri.conf.json,src/main.rs}
  crates/kubepit-core/                    packages/desktop-ui/src/
    src/edition/                           {account,entitlements,cloud,team,i18n,mock}/
  packages/edition-contracts/             crates/kubepit-commercial/src/
  scripts/                                 {plugin,auth,entitlements,cloud,team}/
                                           types.rs, ipc.rs
                                         apps/api/  (companion service plan)
                                         packages/contracts/
```

The public repository always builds and tests using only public inputs. It has
no dependency on the private repository, package registry or paid service.
`packages/edition-contracts` is MIT and describes only the small edition host
interfaces, not subscription internals or provider implementations. Public code
does not import commercial schemas, contain private generated files, download
private code during install, or require an environment variable to skip missing
premium dependencies.

The private repository pins public source as `vendor/kubepit` (read-only Git
submodule or an equivalent verified checkout, recorded by full SHA). Its own
workspace and lockfiles include the desktop wrapper, UI package, commercial Rust
crate and service. CI updates the pin through a compatibility change; it never
copies premium source into the public tree or patches vendored source in place.
Private commits and service credentials cannot enter a public source archive.

After the commercial grant and dependency bill of materials are signed off,
the official installer can combine commercially licensed controlled core with
proprietary premium and compatible third-party components. It preserves MIT SDK
and all required third-party notices, identifies component license routes and
offers community source/build instructions. Community AGPL binary releases
include the required corresponding source/build materials. Signing protects
distribution provenance; it is not a claim that local checks are unpatchable.
The community and official update feeds are distinct. Release identity, app IDs,
keychain service names, rollback compatibility and migration are explicit release
decisions; no first-run migration overwrites a user's existing `KUBEPIT_HOME`.

## Concrete build architecture

### React and Vite

Today `apps/desktop/src/main.tsx` installs guards, initializes locale and mounts
`App`; `AppShell`, Settings, Add cluster, store unions and i18n catalogs are
statically wired. Extract a public `mountDesktop(element, edition?)` from that
entry point, with a matching dispose path for subscriptions. The public
`main.tsx` calls it with the empty edition. The private entry point imports
the vendored bootstrap through `packages/desktop-ui`, registers its edition and
calls the same mount function once.

The edition host has versioned registries for Settings pages, Add cluster tabs,
small account/status slots, palette entries, cluster metadata badges, read-only
configuration contributions and terminal renderers. IDs are namespaced and
duplicates rejected. Missing or incompatible contributions fail locally and
leave the core app usable; error boundaries isolate extension UI. Persisted
unknown edition tabs reopen as a closable unavailable page, not a boot failure.
This is a compiled-edition seam, not an end-user plugin marketplace.

Keep the public `@/` alias pointing to
`vendor/kubepit/apps/desktop/src`; private files use `@commercial/`. Private Vite
and TypeScript configuration resolve both, deduplicate React/ReactDOM/Zustand,
and do not let imports create duplicate stores or locale singletons. The private
wrapper imports public CSS once and adds explicit Tailwind v4 `@source` paths
for both public and private components. Existing xterm/Terser build behavior,
Monaco workers, icons and relative assets must survive the composition.

Additive i18n is typed without weakening public `MessageKey` to arbitrary
strings: expose a typed namespace/catalog factory using the same locale store,
with EN/TR placeholder parity and namespaced ownership. A private catalog cannot
replace a core translation. Public components continue to use `@/i18n`; private
components use their typed edition adapter, which delegates `useLocale`, `t`,
`rich` and `plural` to the same engine. The private checker validates private
source/catalogs and the vendored public checker validates public catalogs.
No new UI/chart library is introduced; tokens, primitives, 11–13px text and
RunHQ active-row treatment remain unchanged.

### Rust, Tauri and IPC

Today `kubepit_desktop::run()` creates its own `generate_context!()`, registers
one core invoke handler, builds state in `setup_app` and owns window cleanup.
Expose a public configure/run API that accepts the **caller's** Tauri context,
extension plugins and explicit post-core-setup, window-destroy and shutdown
hooks. The community `run()` remains a small default caller. The private
entry point generates its own context from its own app config and registers a
statically linked `kubepit-commercial` Tauri plugin before build.

The core invoke handler remains installed exactly once. Private commands use
`plugin:kubepit-commercial|<command>` through the plugin's own handler and
private capability permissions; they must not replace the core handler.
Core `AppState` initialization precedes the explicit commercial initialization
hook. Do not assume Tauri plugin setup callback ordering can provide initialized
core state. The hook receives typed `Arc<Kubepit>` and approved host services;
it does not make `Store` or secret internals generally public. Commercial state
is owned once by Rust and shared by all windows. Shutdown first cancels premium
jobs/pollers, then retains the current bounded core/terminal cleanup ordering.

The public package remains a Cargo workspace of its own. The private Cargo
workspace depends on the pinned public `kubepit-core` and `kubepit-desktop`
crates by path, excludes `vendor/kubepit` from private workspace membership, and
uses one compatible Tauri/serde/runtime dependency graph. A build spike must
prove nested-workspace resolution, `build.rs` generated capabilities and
caller-owned `generate_context!` assets on all target OSs. The public crate's
build script is reviewed so it does not accidentally ship its default config
or assets into the private executable. Private `custom-protocol` propagates to
the public shell dependency. Both binaries are independently buildable.

Private Rust DTOs, private `packages/desktop-ui/src/types.ts`, and private
`ipc.ts` change together. Shared cloud-service DTOs live in the private
`packages/contracts` contract with Rust fixture conformance. Its
`src/commercial-policy.ts` is the single source for feature IDs, prices, lease
bounds, issuer/audience and schema policy; generate Rust fixtures from it. Only generic
host interfaces and any free local-cluster interfaces alter the public TS/Rust
contract. Every new private command has an explicit capability and backend
authorization; the webview supplies intent, never an entitlement verdict.

### Native host services

Expose narrow, typed compiled-code APIs for managed single-context import,
credential repair, non-secret cluster identity inspection, configuration
contributions and owned PTY creation. A plugin cannot ask a generic IPC command
to run arbitrary program/argv/environment. Cloud login is a private command
that validates provider intent, builds argv in Rust and launches through the
existing terminal manager. A private terminal renderer uses the existing output
acknowledgment pipeline; terminal IDs are bound to their creating window and
operation, including resize/write/ack/destroy.

Managed import gets a backend-owned origin identifier, such as
`ExtensionOrigin { namespace, key }`, with versioned opaque private provider
identity behind it. Public local cluster origins are separately typed when that
free feature lands. Ordinary `cluster_update` cannot replace origin ownership.
An origin index and the existing kubeconfig mutation lock serialize reimports;
the new managed credential revision is staged before committing registry state.
Failed storage/registry writes keep the original cluster and credentials.

Generic configuration contributions keep local base values separate from
effective values. Native public APIs accept an allowlisted metadata patch and
source ID; they cannot replace kubeconfig paths/content, execute commands,
inject arbitrary JSON into settings or reach private billing internals.
`cluster_def`, `cluster_list`, connection options, `ensure_writable`, emitted
cluster snapshots and background services must consistently use effective
metadata. Audit direct `store.cluster(s)` callers during implementation.
Edits update the local base/override layer, not an already overlaid snapshot.
Removing a contribution never deletes local entries or silently relaxes a
previously effective read-only flag. The private layer persists provenance,
mapping and override state; the public core knows only generic contributions.

## Authentication and desktop account state

The service baseline is Node 24 / Fastify 5 / PostgreSQL 17 with WorkOS AuthKit
behind an auth adapter. Desktop authentication opens the hosted browser flow;
it does not embed a provider secret, collect a password, or read browser cookies.
Use the service's one-use browser approval transaction and S256 PKCE. Rust
creates the verifier and transaction state, opens only an allowlisted HTTPS URL,
polls/completes with the verifier, validates expiry and consumes the code once.
Cancel, browser refusal, replay, wrong state and wrong verifier are distinct
outcomes. A transaction is bound to the starting device/session and cannot
silently select a different organization from a callback parameter.

The service issues its own 15-minute access/rotating refresh tokens. An ordinary
expired access token triggers one serialized refresh and one retry; it does not
revoke a still-valid lease. Only an authoritative session/entitlement denial
updates the corresponding revocation state. Rust stores refresh
tokens in a separate OS-keychain namespace, holds short-lived access tokens in
memory and serializes refresh across windows. A stolen/replayed refresh token
revokes its token family according to the service contract. UI events carry
account display state and entitlement status, never tokens, cookies, PKCE
verifiers or authorization headers. Token failures do not alter Kubernetes
credentials. If secure storage is unavailable, offer explicit session-only
sign-in; never silently save a refresh token in localStorage or plaintext.

Logout revokes the current service session when reachable, clears local auth
material and paid authorization immediately, cancels sync/discovery/import work
that has not committed, and safely detaches cached team contributions. If the
service is unreachable, local logout still succeeds and marks remote revocation
as unconfirmed; short-lived service access expires independently. Account
deletion and device/session management route through the hosted account UI.
Other signed-in devices are governed by service revocation, not by deleting
this machine's kubeconfig files.

Device binding uses a Rust-generated P-256 key and standard RFC 9449 DPoP
proofs at token exchange, refresh and authenticated API calls, with the RFC 7638
JWK thumbprint in the entitlement's `device_key_thumbprint`. The service verifies
proof-of-possession, method/target/time, unique proof IDs, access-token hash where
required, nonce challenge and replay bounds through a maintained implementation.
A supplied thumbprint string alone is not device proof. The private key stays
in OS secure storage (or the explicitly session-only in-memory mode), never in
webview DTOs or cloud payloads. The offline verifier requires the corresponding
local key; copying an envelope alone is insufficient. User-controlled software
and exportable key stores still prevent any promise of an uncloneable device.

## Entitlements and offline behavior

Feature IDs are exactly `team_profiles` and `cloud_import`. The service signs
ES256 entitlement JWS envelopes with a versioned asymmetric key and `kid`; the desktop
ships a bounded verification key set. The envelope binds account, organization,
seat/device where applicable, features, issue time, expiry/fresh-until,
paid-through, authoritative validation time and entitlement/revocation version.
Reject unknown algorithms, audience/issuer mismatch, malformed times, unsupported
versions, oversized payloads, wrong org/account/device and unknown keys. Issuer
is the fixed service issuer in the shared policy; audience is
`kubepit-desktop-pro`. API JSON is snake_case and uses ISO-8601 timestamps;
JWS time claims use NumericDate seconds. The
desktop never possesses the signing key. Key rotation overlaps verification
keys; an unknown key requires online refresh, not acceptance.

An entitlement is fresh for **24 hours, capped by paid-through**. Offline grace
ends at the earlier of
**last authoritative validation + 7 days** and **paid-through**; this is a
seven-day total horizon, not 24 hours plus seven more days. Successful local
signature verification, launching the app, a cached 304 or failed refresh does
not restart that horizon. Only an authenticated authoritative service decision
can advance it. Cloud APIs always authenticate the current session and check
live membership, seat, role and entitlement; a still-valid offline token is
never enough to publish or read new cloud profile data after revocation.

| State                                | Existing free workflows | New local cloud-CLI workflow               | New team service requests                                      |
| ------------------------------------ | ----------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Fresh paid                           | Unchanged               | Allowed                                    | Live authorization required                                    |
| Offline within bounded grace         | Unchanged               | Allowed; CLI needs its own network/auth    | No offline claim of sync; cached profile only                  |
| Expired or beyond paid-through       | Unchanged               | Blocked with account action                | Blocked except account/export rights explicitly granted by API |
| Known seat/member/session revocation | Unchanged               | Refused immediately                        | Refused immediately                                            |
| Unsupported or suspect clock         | Unchanged               | Online revalidation required               | Service time/authorization controls response                   |
| User cancels renewal                 | Unchanged               | Available through paid-through/grace bound | Available through paid-through and live authorization          |

Track signed server time, maximum observed valid wall time and monotonic elapsed
time during a process. Large backward jumps and inconsistent state require
online validation; forward jumps may cause a recoverable conservative expiry.
No software on a user-controlled offline machine can guarantee rollback-proof
time or instant knowledge of remote revocation. The maximum unknown-revocation
window is the signed offline horizon. State rollback resistance is best effort,
not a DRM or hardware-attestation promise.

Check entitlement at private operation planning, launch and before committing
an import or publishing. During a long-running job recheck local deadlines and
known revocation. Stop queued work promptly; cancelling an already-running
provider command terminates its process tree and records whether credentials
were committed. A successfully committed import remains a normal free cluster.
Grace, denied or expired status must never trigger deletion of credentials or
termination of an existing Kubernetes connection.

Billing URLs come from the service and a strict origin allowlist, then open in
the browser. Display the plan, billing cadence, actual seat state, paid-through
and cancellation effect. Refresh after returning; a webhook/service-confirmed
state grants access. Paddle is the selected provider, with launch conditional
on the seller company's jurisdiction/merchant eligibility and a confirmed
low-price quote; do not hardcode processor internals into the UI.

## Cloud provider workflow

### Tools, scope and discovery

Keep AWS/GCP/Azure implementations private. The user's installed `aws`,
`gcloud`, `az`, `gke-gcloud-auth-plugin` and `kubelogin` own cloud sign-in. No
cloud SDK or provider credential is uploaded to Kubepit SaaS. Absolute local
tool overrides live in private local settings, keyed by a fixed tool enum;
they are not team-synced. Tool status distinguishes missing, not executable,
unsupported version, available, login required and unknown. Executable presence
alone proves neither authentication nor permission.

Discovery runs only after the user selects profiles/configurations/subscriptions
and scopes. AWS includes partition/account/region, GKE project/location and
configuration identity, Azure tenant/subscription/resource group. Account list
commands use CLI metadata, not credential files. Preserve partial successes,
scope-level errors and pagination; cap pages, clusters, bytes and concurrent
processes. Start at at most four scope workers, at most 10,000 clusters per
request, 500 scopes and bounded 8 MiB stdout per process; expose truncation and
refine-scope actions. Every child process consumes the same semaphore so nested
describe calls cannot exceed the process limit. Provider-specific pagination
is tested against captured synthetic response shapes, including repeated tokens.

AWS region presets carry an update date and permit validated custom regions for
new regions/partitions; they are not a hardcoded permission boundary. GKE zonal
and regional clusters use their actual location. AKS uses explicit subscription
and tenant context; do not mutate the global active subscription. Result rows
show stable provider identity, connection identity and already-imported status.

Origin identity separates the cloud resource from its authentication choice.
Use a versioned, length-prefixed/canonical encoding rather than delimiter joins:
EKS ARN/partition/account/region/name plus selected credential-profile binding;
GKE project/location/name plus configuration/account binding; AKS canonical ARM
resource ID plus tenant/subscription/login binding. Case normalization follows
the provider field's rules. The same resource through another identity is a
separate connection unless the user explicitly maps it to an existing entry.
Never silently replace a connection's user or role because endpoint/name match.

### Process and credential safety

Non-interactive commands use literal argv, null stdin, no shell, bounded output
and timeouts (5 seconds for version, 60 seconds for list/describe, 120 seconds
for credential generation). Disable pagers/prompts and color where supported.
The environment preserves only what the provider needs for its installed login
and explicit account binding; do not log it. Arguments are validated per
provider, rejecting NUL/control characters and option confusion without one
overrestrictive universal regex for valid cloud identifiers.

Generate kubeconfigs in a unique private directory under `KUBEPIT_HOME/run`:
0700 directory and 0600 file on Unix, user-only ACL on Windows. Set both the
explicit target argument and `KUBECONFIG` where supported:

| Provider | Writer intent                               | Required isolation                                                                                |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| EKS      | `aws eks update-kubeconfig`                 | Explicit profile/region/name/alias, `--kubeconfig F`, `KUBECONFIG=F`                              |
| GKE      | `gcloud container clusters get-credentials` | Explicit configuration/project/location, `KUBECONFIG=F`, plugin mode                              |
| AKS      | `az aks get-credentials`                    | Explicit subscription/resource group/name, `--file F`, `KUBECONFIG=F`; never `--admin` by default |

Do not rewrite `~/.kube/config`, concatenate a multi-path KUBECONFIG, switch the
user's active CLI configuration, run shell interpolation, or log generated
contents. Parse the generated config, select exactly the intended context,
embed referenced credentials using the existing managed import validation, and
stage storage through the public managed API. A writer returning several or
unexpected contexts fails for review rather than guessing.

Preserve provider exec authentication. Resolve a configured missing exec tool
without spawning it, make supported overrides absolute in the managed copy,
and report a warning when a plugin is missing. Pin GKE configuration/account
semantics only after fixture and supported-CLI conformance verification; if a
combination cannot be reliably pinned, explain that fact and refuse silent
identity switching. AKS AAD conversion invokes `kubelogin` against the private
file with a pinned supported login mode; missing tools yield an actionable
warning or refusal according to whether the kubeconfig is actually usable.
Client certificates/tokens produced by a provider remain local in the managed
file/keychain. “Kubepit never stores credentials” would be inaccurate.

Import results are per cluster: imported, refreshed, skipped, cancelled or
failed with a typed code and redacted detail. Keep full provider output out of
telemetry and cloud payloads. Redact tokens, auth headers, private key blocks and
credential URLs in diagnostic snippets; bound them to 4 KiB. Users can copy the
shown redacted diagnostic. No retry loop turns an auth failure into repeated
browser prompts.

An origin lock serializes imports of one connection; different origins may run
within the shared process bound. Reimport preserves cluster ID, user metadata,
local overrides, read-only flag and team links. Registration uses the existing
stage-then-switch credential repair semantics; disconnect old pooled clients
only after success. Crash recovery removes owned stale private scratch files
without following symlinks or deleting an active run from another process.

### Login, cancellation and OS support

“Sign in” creates a private, typed login plan and opens a cluster-independent
terminal in the public Local dock. AWS SSO, GCP browser login and Azure browser
or device-code login use backend-built commands; no generic shell bridge is
added. Explicit UI action may let the provider update its own auth cache, as
its normal login does. Kubepit SaaS auth and cloud-provider auth are separate.
Terminal output is local and may contain device codes; it is not cloud-synced,
persisted in service audit bodies or sent to an assistant automatically.

Cancel/window-close/shutdown aborts discovery, kills child process groups on
Unix and process trees/Job Objects on Windows, closes pipes and cleans scratch
files. A cancelled PTY does not imply the provider erased a login it already
completed. Explicit completed/cancelled events carry a run ID and sequence;
late events from replaced requests cannot overwrite current UI state. Do not
automatically rediscover an entire account after login; retry the selected
scope only when the user still has that workflow open and authorized.

macOS/Linux native executables and Windows executables plus common `gcloud.cmd`
and Azure launcher layouts need explicit adapters. A `.cmd` launcher cannot be
treated as a Unix executable. Prefer a verified underlying executable or a
fixed launcher adapter with tested Windows escaping; never invoke an arbitrary
user-provided shell string. Unsupported launcher versions get a visible tool
status. Test long paths, spaces, Unicode, canceled device-code login and absent
Docker without touching a real cloud account.

Cloud import never creates/deletes cloud clusters. Existing `read_only` still
governs mutations through normal commands, and neither provider import nor team
sync can silently set a local read-only cluster writable.

## Team cloud profiles

### Content and ownership

Profiles are versioned documents scoped to an organization or a selected set
of its teams.
The service enforces organization membership, team membership, role, assigned
seat and feature entitlement on every request. A desktop organization switch
does not transfer profiles, merge IDs or reuse another organization's cached
authorization. The service controls effective access; client filtering is only
presentation. Organization roles are `owner`, `admin`, `member` and
`billing_admin`, following the companion API matrix. Seated owners/admins can
publish; seated members read/use permitted profiles; billing admins have no
profile access. Do not introduce a separate desktop editor/viewer role model.
Only authorized publishers can create a new revision or tombstone.

The shared document discriminator is `kind: "KubepitTeamProfile", version: 1`;
its `id` is a stable local slug. Preserve this field name from the earlier YAML
format; do not introduce a conflicting `schema_version`. The cloud envelope is
separate: `id` (profile UUID), `org_id` (UUID), `revision` (integer), `document`,
and `targets`, either `{ scope: "organization" }` or
`{ scope: "teams", team_ids: UUID[] }`. Organization/team authorization comes
from server metadata and current membership, never claims inside the document.
Mapping/cache keys use the envelope's org/profile UUIDs plus document entry IDs;
two documents sharing a slug cannot collide across organizations or profiles.

The v1 content is an explicit allowlist: cluster display metadata and match
hints, environments/tags/colors/default namespaces, safe source overrides,
saved table views, bookmarks, health-rule ignores, alert reason/namespace rules,
and optional custom action definitions. Exclude kubeconfig bytes and paths,
credential users/exec stanzas, certificates/keys/tokens, local CLI paths,
machine cluster IDs, history, layout, personal mute/snooze state and cloud auth.
Cost overrides now exist; map their safe fields explicitly. Never serialize
`ClusterDef`, `Settings`, `PrometheusAccess` or `CustomAction` wholesale and
subtract a blacklist afterward. Private local credential bindings remain local.

Use canonical JSON for the service document/hash and reviewed YAML/JSON for
download/upload. v1 limit: 1 MiB uncompressed, 500 cluster entries, 2,000 views,
2,000 bookmarks, 500 actions and 2,000 ignores; reject duplicate IDs/keys,
unknown fields, unsupported versions, non-finite numbers and excessively deep
documents before expensive parsing. Disable or bound YAML aliases and custom
tags, and reject multi-document input. Document and entry IDs are validated
slugs, while cloud profile IDs are service UUIDs; a local composite key includes
organization ID, cloud profile ID and entry ID. Use real existing kind keys such as
`pods` and `deployments.apps`, not the older plan's `v1/Pod` example.

No auto-publish exists. A publisher explicitly selects local sections, sees the
exact sanitized payload, audience and diff, reviews warnings, and confirms.
URL userinfo is rejected; query/fragment data and free-form notes, labels,
scripts and URLs can contain arbitrary sensitive information. Strip known
credential parameters or require their removal; show uncertain text for review.
Pattern scanning is a warning/validation aid, not proof that text is secret-free.
High-confidence secret patterns block publication until removed. Tests prove
that structural credential fields and fixture secret bytes are excluded, not
that any user-supplied prose can never hide a secret. The UI says precisely
what leaves the machine. No source kubeconfig or OS-keychain read is needed to
render the preview beyond an approved metadata-only server/context inspection.

### Revisions and synchronization

`GET` returns revision, ETag (`"p:<uuid>:r:<integer>"`), content hash, targets
and sanitized document;
`If-None-Match` supports 304. Publish/update/delete uses `If-Match` against the
reviewed revision; create uses an idempotency key. A 412 preserves the draft and
shows base/local/server diff. No silent last-writer-wins merge, and retry does
not publish a different payload from the reviewed hash. A deleted document is a
tombstone, not an empty response accidentally applied as a profile.

One Rust coordinator polls followed profiles every approximately 60 seconds
with jitter, only while sync is opted in and a window is foreground. Coalesce
requests across windows, refresh on foreground/reconnect, cap concurrency and
use exponential backoff/Retry-After. Pause on logout, revoked access, expired
entitlement, account switch and shutdown. Pure tests start with polling off.
No kubeconfig, cluster discovery or third-party CLI runs because a remote
profile arrived. Use authenticated per-scope requests and bind every response
to account/org/selection generation; late responses are discarded.

Cache the last validated revision and mapping locally in private storage with
permissions and quota, atomically replacing files. On malformed data, hash
mismatch, unsupported schema or transient network failure, keep the last good
revision and show stale/error status. An ordinary expired-access 401 tries one
serialized refresh and retry before changing any entitlement state. A profile
role/permission 403 stops or restricts that profile, not every paid feature;
403/410 authoritative profile removal clears that subscription authorization.
Only authoritative session, membership, seat or entitlement denial revokes the
appropriate account/org/feature scope. A cross-tenant 404 reveals no object
existence and is reconciled against the authorized list without global logout.
Service-originated document changes still pass desktop validation. Updates to
safe declarative fields can apply after initial subscription consent; changes
to executable content always require a new local review. A materially changed
destination/endpoint match hint produces a mapping review, never credential
reuse based solely on an old link.

### Local mapping, layering and lifecycle

Mapping links a stable team cluster entry to a local cluster ID, never copies
credentials. Candidate order is an existing explicit link, exact normalized
server match, then context hint. Normalize host/scheme/default port carefully,
preserve meaningful path components and never infer identity from display name.
Multiple matching contexts/users are ambiguous. Context-only matches require
review; no automatic access is gained. Unmapped entries show manual file/paste
import, and paid cloud import when available. Discovery of local kubeconfigs
is explicit, not triggered by receiving a team document.

Local base configuration and overrides survive every remote update. Team
contributions are namespaced and resolved using explicit user subscription
precedence; conflicts remain visible. A profile cannot overwrite another
profile's IDs or change credential provenance. Local overrides beat shared
values except that `read_only` is the logical OR of the local value and all
active applicable contributions. Backend checks consume that effective value.
This is a safety feature of this client, not an enforceable organization policy
against an AGPL community build, kubectl or another client. Real access control
remains cloud IAM and Kubernetes RBAC/admission policy.

On expiry, logout or known access removal, stop network sync and new premium
operations, preserve imported cluster credentials and personal configurations,
and detach safely. Existing cluster effective display values can become local
values with provenance so views do not vanish unexpectedly; any stricter
read-only state is retained until the user explicitly changes it. Local views,
bookmarks and overrides are never deleted. Previously received team views and
non-executable settings may be copied to clearly labeled local snapshots; they
no longer claim to be current or managed. Previously received actions remain
disabled unless the user explicitly reviews and copies them locally. Clear
service tokens and live subscriptions; cached organization data follows the
published retention/delete choice, with explicit local purge available.

Removing a team entry, unsubscribing or deleting a profile does not delete a
Kubernetes cluster. Show an orphan/detach summary, preserve local choices and
retain a tombstone to avoid immediately recreating dismissed entries. A team
admin cannot erase credentials already present on another user's machine or
revoke their independent Kubernetes rights. Offline revocation is discovered
on reconnect or at the entitlement deadline; document that limit honestly.

### Executable actions

Synced custom actions start **disabled and untrusted**. They cannot auto-run
on sync, startup, schedule, selection change, profile import or deep link.
Local activation requires reviewing a canonical SHA-256 hash bound to
org/profile/entry identity, command, arguments/template, execution mode,
mutating flag, scope, namespace/tag selectors, confirmation and timeout.
Changing any execution-relevant field revokes consent. A locally trusted hash
is stored only on that machine and never synced.

The public native action contribution interface delegates preparation to the
private owner, rechecks consent and current contribution state at execution,
and uses existing target validation, `read_only`, confirmation, cancellation
and audit mechanisms. The UI does not downgrade a declared mutating action or
skip the backend gate. Admission/Kubernetes RBAC is still final authority, and
arbitrary shell commands inherently remain user-trusted local code rather
than something the app can prove harmless. Audit logs record metadata/outcome,
not full potentially secret scripts, environment or terminal output.

## Persistence, errors and support

Under the existing application home, reserve `commercial/` for a versioned
private manifest, entitlement envelope, profile cache, mappings, origin detail,
local overrides, consent hashes and journaled migrations. Store no account
tokens there; refresh credentials use the OS keychain. Public state remains
readable by community releases. Sidecar data cannot change core decoding or
make community startup depend on proprietary code. A safe snapshot/export and
migration rollback path is documented before changing on-disk schema.

Private errors carry stable codes, recoverability, optional scope/run IDs and
redacted bounded detail. UI translates app-owned messages in EN/TR; provider
data, cluster names, commands and user-authored documents stay verbatim. Logs
exclude tokens, cookies, verifiers, raw cloud stderr, kubeconfigs and profile
document bodies. A user-requested support bundle previews included metadata
and does not silently collect credential-bearing files.

## Acceptance and release gates

1. Public checkout builds, tests, launches and imports a fixture kubeconfig
   without private inputs, network authorization or account state.
2. Official build composes the same free shell; no duplicate React/store
   instances, broken assets, second core invoke handler or lost window cleanup.
3. Signed-entitlement tests cover expiry, grace bound, key rotation, clock
   rollback, paid-through, known revocation and preserved free connections.
4. Fake CLI tests prove literal arguments, safe target files, pagination,
   process-tree cancellation, partial failures and transactional reimport.
5. Profile tests prove revision preconditions, tenant separation, last-good
   cache, explicit mapping, local overrides, detachment and action consent.
6. All existing public checks pass; private Rust/TS/i18n/contract suites pass;
   both demos work in EN/TR, wide/narrow windows and multiple windows.
7. macOS, Linux and Windows fixtures verify provider launcher/PTY behavior;
   any provider/version combination not proven is reported unsupported.
8. Service auth, billing and tenant-isolation gates in the companion plan
   pass before a paid public rollout. Actual paid access is never faked by a
   desktop checkout success screen.
9. No automated test or script reads real `~/.kube`, cloud credentials or
   accounts. Inject temp paths, fake CLI executables, fake API servers,
   `MemorySecretStore`, fake clocks, fake billing/auth and network-deny guards.
10. The alternative commercial grant, controlled-core rights/CLA inventory,
    dependency license bill of materials and source/notices obligations are
    signed off before combining or releasing private modules with the core.
11. Source/license notices, separate update feeds, data migration, cancellation
    explanation, service privacy/retention and eligibility decisions are
    reviewed before signing/releasing. This plan itself performs no release.

Prioritize the repository/build seam and free-core regression proof, then the
private auth/entitlement slice, cloud import and team sync. Broader provider
integrations, local Git subscriptions, organization-enforced endpoint policy,
central Kubernetes credentials, remote command execution, SAML/SCIM and local
cluster orchestration are outside this commercial desktop v1.
