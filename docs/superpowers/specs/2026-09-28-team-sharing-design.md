# Team sharing: design

Status: draft for review · Date: 2026-09-28 · Plan: `docs/superpowers/plans/2026-09-28-team-sharing.md`

## Problem

Teams that use Kubepit set it up again on every machine. They repeat cluster names,
tags, environments, colours and read-only flags, the Prometheus/Loki overrides, saved
table views, bookmarks, custom actions, health-rule ignores and alert rules. There is no
way to share that setup or keep it in sync. The only export today is the custom-actions
JSON (`lib/customActions.ts:318-320`).

## Goals

1. A versioned, reviewable **team profile** file that holds non-secret workspace
   configuration:
   - cluster metadata without credentials: name, context name, server URL, tags,
     environment, colour, notes, read-only, default and accessible namespaces, and the
     Prometheus, Loki and cost overrides
   - saved table views and bookmarks
   - custom actions
   - health-rule ignores
   - alert rules (not personal notification state)
2. Export and import from Settings.
3. **Subscribe** to a profile at a local path (usually a git clone). Kubepit watches it and
   applies changes live. Team-managed entries are read-only locally, and local overrides
   sit on top of them.
4. Map team clusters to local credentials: match by server URL, then by context name, and
   ask about the rest.
5. A validation command for CI in the team repo.
6. **Credentials, tokens and kubeconfig contents are never exported, and tests prove it.**

## Non-goals

- Syncing through a server, or Kubepit running git (users `git pull`, and Kubepit notices).
- Sharing kubeconfigs, credentials, certificates or exec-plugin configuration, in any form.
- Sharing machine-local state: tool paths, fonts, muted or snoozed clusters, history,
  layout, sections.
- Two-way sync: Kubepit never writes into a subscribed profile.
- Per-user policy enforcement. The team profile is advice the user can override, except
  that `read_only` can only be tightened.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **YAML** (`kubepit-team.yaml`), with a header `kind: KubepitTeamProfile`, `version: 1`, `id`, `name`. JSON is accepted on import, since YAML is a superset. Exports are deterministic: struct field order, entries sorted by `id`, LF line endings, trailing newline, block scalars for multi-line notes and commands. | Code review decides the format. YAML allows comments ("prod is read-only because…"), and multi-line notes and command templates diff line by line. JSON escapes them into one `\n` line that nobody can review. Kubernetes teams read YAML every day. Implicit-typing pitfalls are contained: serde_yaml 0.9 follows the YAML 1.2 core schema (so `yes` is a string), every struct is typed with `deny_unknown_fields`, and the serializer quotes ambiguous strings. |
| D2 | A JSON Schema, `crates/kubepit-core/src/team/team-profile.v1.schema.json`, gives editor completion (`# yaml-language-server: $schema=…`) and works with generic CI validators. The **Rust validator is authoritative**, and a test keeps the schema's property names in sync with the serde structs. | No new dependency (no schemars, no jsonschema crate). Two consumers are served. Drift is caught. |
| D3 | The **validation CLI** is a small bin target in `kubepit-core`: `kubepit-team validate [--strict] <path>…` and `kubepit-team schema`. It has exit codes 0/1/2 and `path: <json-path>: code: message` lines, uses the same validator as the app, and is documented with a GitHub Actions snippet (`cargo install --git … --bin kubepit-team kubepit-core`). Settings also has a **Validate** button. | The team repo gets semantic checks (duplicate ids, placeholders, globs, secrets) that a schema cannot express. Prebuilt binaries are an open question. |
| D4 | **Credential-free by construction.** Team types have no credential fields. Server and proxy URLs are exported without userinfo. Import rejects unknown keys and credential-shaped keys (`token`, `password`, `client-key-data`, `client-certificate-data`, `exec`, `auth-provider`, `kubeconfig`). A heuristic **secret scan** covers notes, descriptions and command templates (JWTs, `AKIA…`, `-----BEGIN`, `password=`, `token=`, `Authorization: Bearer`, `aws_secret_access_key`). It produces export warnings, which the user reviews, and validation errors under `--strict`. | Nothing in the pipeline can carry a secret, and user-typed text is flagged. |
| D5 | Export is assembled in the backend from `clusters.json`, settings and `actions.json`, plus the UI-owned views, bookmarks and health ignores that the UI sends in the request. One serializer is shared by the app and the CLI. Local cluster ids are mapped to **team cluster ids**, which are stable slugs: the linked team entry id when there is one, else a unique slug of the name. | The frontend owns views, bookmarks and ignores (localStorage and `workspace.json`), while the backend owns the rest. |
| D6 | **Subscriptions** are `Settings.team_profiles: Vec<TeamSubscription { path, enabled }>`, ordered. A path is a file or a directory (then `kubepit-team.yaml` inside it). They are loaded at startup and on change through `notify`: the parent directory is watched, changes are debounced 500 ms and the watch set is re-armed every 3 s, like `kubeconfig_watch.rs`. Watching is **opt-in per process** (`start_team_profile_watch`, called from `setup.rs`). | This survives `git pull` replacing files atomically. Tests stay deterministic because nothing is watched unless a test asks. |
| D7 | **Layering and conflicts.** Team-managed entries are read-only in the UI. Local overrides are layered on top: <br>• *Clusters*: team fields are materialized into the linked `ClusterDef` on every reload, except the fields listed in `ClusterDef.team.overrides`. `read_only` may only be tightened (team `true` stays `true`). <br>• *Custom actions*: team actions are listed next to local ones with id `team.<profile>.<id>` and cannot be edited. The only local override is "disabled". <br>• *Views, bookmarks, health ignores*: team entries show next to local ones with a lock and cannot be edited or removed. <br>• *Alert rules*: a team value applies unless the user overrides that field (`Settings.alerts_team_overrides`). <br>• Between profiles, the first subscription wins and the loser is reported as a conflict in the status. | Every consumer keeps reading `ClusterDef`, `Settings.alerts` and the stores it already reads. Overrides are explicit and visible, and team intent (read-only production) survives. |
| D8 | **Cluster mapping.** For each team cluster: registered clusters whose server URL (from their kubeconfig through `server_for_context`) matches `match.server` after normalization (lowercased scheme and host, default port and trailing slash removed); else registered clusters whose context equals `match.context`; else discovered but unregistered kubeconfig contexts (from `kubeconfig::discover`), offered as "Add from kubeconfig"; else **needs credentials**. More than one candidate is `ambiguous`, and the user picks. The link is stored on the cluster (`ClusterDef.team`), and a manual pick sticks. | Server URLs identify clusters across machines better than context names, which people rename. |
| D9 | **Import (one-shot)** reuses the same parse, validate and map pipeline but writes plain local entries with no link. **Subscribe** keeps them team-managed. | The two actions share one mental model and one code path. |
| D10 | **Trust gate for team actions.** A team action runs only when the SHA-256 fingerprint of its canonical definition (command, mode, scopes, namespaces, cluster tags, mutating, confirm, timeout) is in `Settings.trusted_team_actions`. The backend refuses otherwise. The UI shows a review dialog with the command. A changed definition needs review again. | A commit to the team repo must not silently change a command that runs on every teammate's machine. `sha2` is already in the dependency tree. |
| D11 | Profile content is limited to 1 MiB per file, 500 clusters, 2,000 views, 2,000 bookmarks, 500 actions (existing limit) and 2,000 ignores. Ids match `^[a-z0-9]([-a-z0-9]{0,62}[a-z0-9])?$`. | Bounded parsing and simple ids. |

## Profile format (v1)

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/erdembas/kubepit/main/crates/kubepit-core/src/team/team-profile.v1.schema.json
kind: KubepitTeamProfile
version: 1
id: platform
name: Platform team
description: Shared Kubepit setup for the platform clusters.
clusters:
  - id: prod-eu
    name: prod-eu-west-1
    match: { server: https://ABC.gr7.eu-west-1.eks.amazonaws.com, context: prod-eu }
    environment: production
    color: "#e5484d"
    tags: [eks, eu]
    read_only: true
    default_namespace: shop
    accessible_namespaces: []
    notes: |
      Read-only: changes go through Argo CD.
    prometheus: { mode: service, namespace: monitoring, service: prometheus-operated, port: 9090, scheme: http, path_prefix: "" }
    loki: { mode: auto }
    # cost: { … }   (only once ClusterDef.cost exists)
views:
  - { id: failing-pods, name: Failing pods, kind_key: v1/Pod, cluster: null, filter: "status:failed", namespaces: null,
      hidden_columns: [], column_order: [], column_widths: {}, sort: { column: age, desc: false }, default: false }
bookmarks:
  - { id: shop-api, type: object, cluster: prod-eu, gvk: { group: apps, version: v1, kind: Deployment, plural: deployments, namespaced: true }, namespace: shop, name: api }
actions:
  - { id: top-pod, name: kubectl top, scopes: [Pod], command: "kubectl top pod {name} -n {namespace}", mode: terminal }
health_ignores:
  - { cluster: "*", rule: pods.no-limits, namespace: kube-system }
alerts:
  disabled_reasons: [Evicted]
  exclude_namespaces: [kube-system, "*-sandbox"]
```

Never included: kubeconfig paths or content, local cluster ids, users and credentials,
exec plugins, proxy credentials, `muted_clusters`, `snoozed_until`, notification
switches, tool paths, history, sections and layout.

## Architecture

- **Core:**
  - `crates/kubepit-core/src/team/`:
    - `model.rs`: serde types and limits
    - `validate.rs`: structural and semantic checks, secret scan, coded findings
    - `export.rs`: assembly from local state, deterministic YAML
    - `mapping.rs`: server normalization and candidate matching
    - `apply.rs`: materializing clusters, effective alerts, team actions
    - `subscriptions.rs`: loading, status, reload
    - `watch.rs`: notify watcher, modelled on `kubeconfig_watch.rs`
  - Bin: `src/bin/kubepit-team.rs`.
- **Contract:**
  - Commands:
    - `team_profile_export(request)` returns `{ yaml, warnings }`
    - `team_profile_validate({ path | text })`
    - `team_profile_preview({ path | text })` returns the parsed profile plus the mapping, before an import or subscribe
    - `team_profile_import(request)`
    - `team_profiles_state()`
    - `team_profile_subscribe(path)` and `team_profile_unsubscribe(path)`
    - `team_cluster_link(profile_id, entry_id, cluster_id | null)`
    - `team_cluster_add_from_context(profile_id, entry_id, kubeconfig_path, context)`
    - `team_cluster_override(cluster_id, field, overridden)`
    - `team_action_trust(action_id, fingerprint)`
  - Event: `teamprofile://changed` (`TeamProfilesState`).
  - `ClusterDef.team?: TeamLink | null`, `CustomActionsState.team: TeamAction[]`, and the
    new `Settings` fields `team_profiles`, `trusted_team_actions` and
    `alerts_team_overrides`.
- **Frontend:**
  - `store/useTeamStore.ts` holds the state from the backend.
  - The pure `lib/team/layers.ts` turns the state into read-only `SavedView`, `Bookmark`
    and `HealthIgnore` entries, keyed to local cluster ids through the links.
  - `useSavedViewsStore`, `useBookmarksStore` and `useHealthStore` expose merged
    selectors. Team entries carry `team: { profile }` and are never persisted in
    localStorage or `workspace.json`.
  - A new Settings category, **Team profiles**, covers subscriptions and status, import,
    export, validation and the cluster mapping table.
  - The cluster editor shows locks and override toggles, and custom actions get a team
    section with a trust review.

## UX

- **Settings → Team profiles:**
  - The subscription list shows the path, profile name, entry counts and last load time,
    plus errors and conflicts. Each row has Reload, Enable/disable and Remove.
  - **Subscribe…** takes a file or folder and shows a preview: what changes, and the
    clusters that need credentials.
  - **Import…** shows the same preview, then writes local copies.
  - **Export…** has a cluster checklist, section toggles, profile id and name, the secret
    warnings, then a save dialog.
  - **Validate…** takes a file and lists its findings.
- **Cluster mapping table:** each team cluster is shown as linked (the local cluster), as
  "Add from kubeconfig" (one click), as ambiguous (a picker) or as needs credentials.
  Needs credentials offers "Pick context…", "Paste kubeconfig…" and, if the
  cloud-import plan has landed, "Import from cloud…".
- **Team-managed items** get a small lock badge ("Managed by {profile}") in the cluster
  editor, saved views, bookmarks, the Health ignores list, custom actions and
  Notifications. Override toggles apply per cluster field and per alert field.
- **Custom actions:** an untrusted team action shows "Review" instead of running. The
  review dialog shows the command, the mode, whether it mutates, and what changed since
  the last trust.
- All strings are in English and Turkish. Profile content (names, notes, commands) is user
  content and is never translated.

## Security and safety

- D4 and D10 are the core. Tests:
  - build clusters whose kubeconfigs hold a token, client key and certificate data, an
    exec env secret and a proxy `user:pass@`, in file mode and in keychain mode
  - export, then assert that **none of those byte strings** and none of the keys
    `token`, `client-key-data`, `client-certificate-data`, `exec`, `password` appear
  - check that importing a profile with such keys fails with `credential-field`
  - check that a note containing a JWT raises `secret-suspected`
- Only the user's chosen paths are read. Kubepit never writes into a subscribed file.
  Symlinks are followed only when the user picked the file. The 1 MiB cap and bounded
  counts apply.
- `read_only` stays enforced in the backend by the materialized `ClusterDef.read_only`.
  The team can only tighten it.
- Background work is limited to the watcher, which only runs when the desktop shell starts
  it.
- Tests never connect to real clusters or cloud accounts and never read real user files:
  temp dirs, `Paths::new`, the fake API server, `DiscoveryRoots` / `discover_with` with
  temp homes, and `MemorySecretStore`.

## Testing strategy

- **Rust unit tests:** model round-trips, deterministic export, validation codes, server
  normalization, mapping precedence, layering rules, the read-only tighten rule, the
  fingerprint and the secret scan.
- **Rust integration tests** (`tests/team_profiles.rs`):
  - the no-secrets proof
  - import and subscribe end to end
  - the watcher picking up an edited file (`start_team_profile_watch_with` on a temp dir)
  - conflicts between two profiles
  - the trust gate refusing, then allowing, a run
  - the CLI through `env!("CARGO_BIN_EXE_kubepit-team")`
- **Vitest:** `lib/team/layers.test.ts` covers merging, locks and cluster-id resolution.
  `lib/team/exportRequest.test.ts` covers collecting local views, bookmarks and ignores
  into the export request.
- **Manual:** the demo backend ships a subscribed demo profile (`mock/team.ts`), walked
  through in English and Turkish.

## Rollout

The feature is inert until the user subscribes or imports. New settings fields default to
empty. Docs: `docs/TEAM_PROFILES.md` (format reference, CI recipe, conflict rules),
an ARCHITECTURE section and a README bullet.

## Open questions

1. `ClusterDef.cost` exists only on `feat/cost`. The plan includes `cost` in team clusters
   when that field exists at execution time, and leaves it out otherwise. Should cost
   ship in v1 regardless?
2. Should we publish prebuilt `kubepit-team` binaries on releases, so CI does not compile
   `kubepit-core`?
3. Should team actions start **disabled** as well as untrusted, or is the trust review
   enough?
4. Should one profile be able to require a minimum Kubepit version (`requires: ">=0.2"`)?
