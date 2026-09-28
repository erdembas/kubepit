# Team Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export, import and subscribe to a versioned YAML team profile holding non-secret Kubepit configuration (cluster metadata, saved views, bookmarks, custom actions, health ignores, alert rules). Imported clusters are mapped to local credentials, and a CI validation CLI checks the profile. Credentials are never exported.

**Architecture:** A new core module `crates/kubepit-core/src/team/` owns the model, validation, export, mapping, layering, subscriptions and a `notify` watcher. A small bin, `kubepit-team`, reuses the validator. Team cluster fields are materialized into linked `ClusterDef`s, and team alert rules into the effective alert settings, so existing consumers stay unchanged. Team actions sit beside local actions behind a trust gate. The UI merges read-only team views, bookmarks and health ignores into its stores without persisting them.

**Tech Stack:** Rust (serde, serde_yaml 0.9, notify 8, sha2 0.10), Tauri 2 commands and events, React 18 + Tailwind v4 + Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-team-sharing-design.md`

## Global Constraints

- IPC contract: every new command, type, field and event changes `apps/desktop/src/types/index.ts` **and** `apps/desktop/src/lib/ipc.ts` in the same task as the Rust side. Structs cross verbatim, so types mirroring TS camelCase stores (`SavedView`, `Bookmark`) use `#[serde(rename_all = "camelCase")]`.
- Design: the UI must be visually identical to RunHQ. Use tokens from `src/styles/theme.css` and primitives from `src/components/ui/` (`Dialog`, `Button`, `Switch`, `Input`, `Badge`, `ConfirmDialog`, `Tabs`), 11–13px UI text, uppercase tracked labels, `bg-fg/N` hover pads and the accent strip for active rows. No chart or UI libraries. Layouts use container queries (`@container`, `@[…px]:`).
- i18n: every user-visible string ships in English **and** Turkish in the same task. Use `import * as i18n from '@/i18n'` and `i18n.useLocale()` in components, and `@/i18n/core` in pure helpers. Use `i18n.t` / `rich` / `plural`, never concatenated fragments. Run `pnpm i18n:check -- --fix`, then add Turkish by hand. `pnpm i18n:check` passes. Profile content (names, notes, commands, ids) is user content and is never translated.
- Safety: tests never connect to real clusters or cloud accounts and never read real user files. They use temp dirs with `Paths::new(tempdir)` (never `KUBEPIT_HOME` from the environment), the fake API server (`tests/support/mod.rs`), `kubeconfig::discover_with` with temp homes, and `MemorySecretStore`.
- **Credentials, tokens and kubeconfig contents are never exported.** Team types have no credential fields. URLs are exported without userinfo. Imports reject credential-shaped keys. `tests/team_profiles.rs::export_never_contains_credentials` is the proof and must stay green.
- `read_only` is enforced in the backend through the materialized `ClusterDef.read_only`. A team value of `true` cannot be overridden to `false`.
- Background work is opt-in per process: only `start_team_profile_watch`, called from `apps/desktop/src-tauri/src/setup.rs`, watches files. Tests call `team_profiles_reload()` or start the watcher explicitly.
- Format constants: `kind: KubepitTeamProfile`, `version: 1`, the default file name `kubepit-team.yaml`, ids matching `^[a-z0-9]([-a-z0-9]{0,62}[a-z0-9])?$`, at most 1 MiB per file, 500 clusters, 2,000 views, 2,000 bookmarks, 500 actions and 2,000 health ignores, a watch debounce of 500 ms, and a re-arm every 3 s.
- `ClusterDef.cost` comes from `feat/cost`. If `cost: Option<CostConfig>` exists on `ClusterDef` when this plan runs, `TeamCluster` and `TeamClusterField` carry `cost` exactly like `prometheus`. Otherwise leave it out and say so in the final report.
- The six checks pass at the end of every task that touches their area: `pnpm typecheck` · `pnpm i18n:check` · `pnpm test` · `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace`. `pnpm dev:ui` keeps working against `src/lib/ipc/mock/`.

## Review Focus

- **The profile file disappears or is half-written during `git pull`**: the last good profile stays applied, the status shows the parse error, and the next good write recovers. Tested in Task 9 (`broken_write_keeps_last_good_profile`).
- **A team cluster matches two local clusters** (the same server through two contexts or users): the state is `ambiguous`, nothing auto-links, and a manual pick sticks across reloads. Tested in Task 5 (`ambiguous_server_needs_a_pick_and_the_pick_sticks`).
- **The user overrides a team field, then the team changes that field**: the local value wins, while the other fields update. `read_only: true` from the team stays true even when "overridden". Tested in Task 6 (`overrides_survive_reloads_and_read_only_only_tightens`).
- **A profile is unsubscribed or disabled**: its team views, bookmarks, ignores and actions disappear. Linked clusters keep their current values as plain local values (the link is dropped) and are never deleted. Tested in Task 8 (`unsubscribe_unlinks_but_keeps_clusters`).
- **Non-ASCII and multi-line content** (Turkish notes, emoji, `|` blocks, commands with quotes): the export → import round-trip is byte-stable and the diff shows line-level changes. Tested in Task 2 (`export_is_deterministic_and_round_trips_unicode`).

---

## File Structure

**Core (Rust)**
- `crates/kubepit-core/src/team/mod.rs`: create. Module doc, re-exports, `TeamState` (in-memory loaded profiles).
- `crates/kubepit-core/src/team/model.rs`: create. Serde types, limits, `SCHEMA_JSON`.
- `crates/kubepit-core/src/team/team-profile.v1.schema.json`: create. JSON Schema (draft 2020-12).
- `crates/kubepit-core/src/team/validate.rs`: create. Raw-value walk, semantic checks, secret scan, `TeamFinding`.
- `crates/kubepit-core/src/team/export.rs`: create. `team_profile_export`, deterministic YAML.
- `crates/kubepit-core/src/team/mapping.rs`: create. `normalize_server`, candidates, links.
- `crates/kubepit-core/src/team/apply.rs`: create. Materializing clusters, `effective_alerts`, team actions and fingerprints.
- `crates/kubepit-core/src/team/subscriptions.rs`: create. Load, reload, state, subscribe, preview, import.
- `crates/kubepit-core/src/team/watch.rs`: create. `notify` watcher.
- `crates/kubepit-core/src/bin/kubepit-team.rs`: create. Validation CLI.
- `crates/kubepit-core/Cargo.toml`: modify. `sha2 = "0.10"`, `[[bin]] name = "kubepit-team"`.
- `crates/kubepit-core/src/types.rs:31-68,1034-1088`: modify. `ClusterDef.team` plus the new `Settings` fields.
- `crates/kubepit-core/src/app.rs`: modify. The `team` field, effective alerts in `set_settings`, watcher stop in `shutdown`.
- `crates/kubepit-core/src/alerts.rs:150-155`: modify (callers pass effective settings).
- `crates/kubepit-core/src/custom_actions/{mod.rs,model.rs}`: modify. `CustomActionsState.team` and the team lookup plus trust gate in `runnable_action` (mod.rs ~218-250).
- `crates/kubepit-core/src/cluster.rs:182-246`: modify. `cluster_update` keeps `team` and records overrides.
- `crates/kubepit-core/src/events.rs`: modify. `team_profiles_changed`.
- `crates/kubepit-core/src/lib.rs`: modify. `pub mod team;`.
- `crates/kubepit-core/tests/team_profiles.rs`: create.

**Desktop shell**
- `apps/desktop/src-tauri/src/ipc/team.rs`: create. `ipc/mod.rs`, `lib.rs:51-216`, `app_state.rs`, `setup.rs:31`: modify.

**Frontend**
- `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts`: modify.
- `apps/desktop/src/lib/team/layers.ts` (+ `layers.test.ts`), `lib/team/exportRequest.ts` (+ `exportRequest.test.ts`): create.
- `apps/desktop/src/store/useTeamStore.ts`: create.
- `apps/desktop/src/lib/savedViews.ts:26-33`, `store/useSavedViewsStore.ts`, `store/useBookmarksStore.ts:14-150`, `store/useHealthStore.ts:30-80`: modify (team layers).
- `apps/desktop/src/components/app/useAppBootstrap.ts`: modify. Load team state and subscribe to the event.
- `apps/desktop/src/lib/ipc/mock/team.ts`: create. `mock/index.ts`: modify.
- `apps/desktop/src/components/settings/TeamCategory.tsx`, `settings/team/{SubscriptionList,ProfilePreviewDialog,ExportDialog,ValidateDialog,ClusterMappingTable}.tsx`: create.
- `apps/desktop/src/store/types.ts:39-49`, `components/settings/SettingsView.tsx:30-222`: modify (register the category).
- `apps/desktop/src/components/cluster-editor/ClusterEditor.tsx`, `settings/CustomActionsCategory.tsx`, `settings/NotificationsCategory.tsx`, `workbench/health/HealthPage.tsx`, `nav/BookmarksSection.tsx`, the saved-views menu (`components/workbench/table/`): modify (locks, overrides, trust review).
- `apps/desktop/src/components/ui/TeamBadge.tsx`: create (lock badge primitive).
- `apps/desktop/src/i18n/{en,tr}/{shell,workbench}.json`: modify.
- `docs/TEAM_PROFILES.md`: create. `docs/ARCHITECTURE.md`, `README.md`: modify.

---

### Task 1: Frontend unit-test harness (skip if present)

**Files:** `apps/desktop/package.json`, `package.json`, `apps/desktop/vite.config.ts`, `scripts/check-i18n.mjs` (walk), `apps/desktop/src/lib/format.test.ts`

**Interfaces:**
- Produces: `pnpm test` runs `vitest run` (environment `node`, include `src/**/*.test.ts`). The i18n checker skips `*.test.ts(x)`.

- [ ] **Step 1: Skip check**: run `grep -q '"test"' apps/desktop/package.json && echo present`. If it prints `present`, go to Step 5.
- [ ] **Step 2: Write `src/lib/format.test.ts`**, asserting `formatAge(now - 45_000, now) === '45s'`, `formatAge(now - 3 * 3600_000, now) === '3h'` and `formatAge(null, now) === '—'`.
- [ ] **Step 3: Add `vitest@^3.2.4`** as a devDependency. Scripts: `apps/desktop` `"test": "vitest run"`, root `"test": "pnpm --filter @kubepit/desktop test"`. In `vite.config.ts`, add `/// <reference types="vitest/config" />` and `test: { environment: 'node', include: ['src/**/*.test.ts'] }`. The checker's `walk` skips `/\.test\.tsx?$/`. Run `pnpm install`.
- [ ] **Step 4: Run `pnpm test`**. Expected: `1 passed`. Commit: `git commit -m "test(ui): add a Vitest harness for pure frontend helpers"`.
- [ ] **Step 5: Run `pnpm typecheck && pnpm i18n:check && pnpm test`**. Expected: all pass.

---

### Task 2: Team profile model and deterministic YAML

**Files:**
- Create: `crates/kubepit-core/src/team/mod.rs`, `crates/kubepit-core/src/team/model.rs`
- Modify: `crates/kubepit-core/src/lib.rs`
- Test: unit tests in `model.rs`

**Interfaces:**
- Produces (`team::model`):
  - Constants: `PROFILE_KIND = "KubepitTeamProfile"`, `PROFILE_VERSION: u32 = 1`, `DEFAULT_FILE = "kubepit-team.yaml"`, `MAX_BYTES = 1 << 20`, `MAX_CLUSTERS = 500`, `MAX_VIEWS = 2000`, `MAX_BOOKMARKS = 2000`, `MAX_IGNORES = 2000`.
  - `TeamProfile { kind, version, id, name, description: String, clusters: Vec<TeamCluster>, views: Vec<TeamView>, bookmarks: Vec<TeamBookmark>, actions: Vec<CustomAction>, health_ignores: Vec<TeamHealthIgnore>, alerts: Option<TeamAlertRules> }`. Collections default to empty, empty ones are skipped when serializing, and `deny_unknown_fields` applies.
  - `TeamClusterMatch { server: Option<String>, context: Option<String> }`
  - `TeamCluster { id, name, #[serde(rename = "match")] matcher: TeamClusterMatch, environment: Option<ClusterEnvironment>, color: Option<String>, tags: Vec<String>, read_only: bool, default_namespace: Option<String>, accessible_namespaces: Vec<String>, notes: String, prometheus: Option<PrometheusConfig>, loki: Option<LokiConfig>, proxy_url: Option<String> }` (+ `cost`, see Global Constraints).
  - `TeamViewSort { column, desc }`
  - `TeamView { id, name, kind_key, cluster: Option<String>, filter: String, namespaces: Option<Vec<String>>, hidden_columns, column_order, column_widths: BTreeMap<String, f64>, sort: Option<TeamViewSort>, default: bool }`
  - `TeamBookmark` is tagged on `type`, lowercase: `Object { id, cluster, gvk: Gvk, namespace: Option<String>, name }` or `View { id, cluster, kind_key, view: Option<String> }`.
  - `TeamHealthIgnore { cluster: String /* team cluster id or "*" */, rule, namespace: Option<String> }`
  - `TeamAlertRules { disabled_reasons: Option<Vec<AlertReason>>, include_namespaces: Option<Vec<String>>, exclude_namespaces: Option<Vec<String>> }`
  - `pub fn to_yaml(profile: &TeamProfile) -> Result<String>`: sorts every collection by `id` (health ignores by `(cluster, rule, namespace)`), normalizes line endings to LF and ends with exactly one `\n`. The first line is the `# yaml-language-server: $schema=https://raw.githubusercontent.com/erdembas/kubepit/main/crates/kubepit-core/src/team/team-profile.v1.schema.json` comment.
  - `pub fn from_text(text: &str) -> Result<TeamProfile>` accepts YAML or JSON.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn export_is_deterministic_and_round_trips_unicode() {
    let p = sample_profile(); // two clusters in reverse id order, notes "Üretim — salt okunur 🚦\nikinci satır", an action with quotes
    let a = to_yaml(&p).unwrap();
    let b = to_yaml(&from_text(&a).unwrap()).unwrap();
    assert_eq!(a, b);
    assert!(a.starts_with("# yaml-language-server: $schema="));
    assert!(a.find("id: a-cluster").unwrap() < a.find("id: b-cluster").unwrap());
    assert!(a.contains("notes: |"));
    assert!(a.ends_with('\n') && !a.ends_with("\n\n"));
}
#[test] fn json_is_accepted_and_unknown_fields_are_rejected() {
    assert!(from_text(r#"{"kind":"KubepitTeamProfile","version":1,"id":"t","name":"T"}"#).is_ok());
    assert!(from_text("kind: KubepitTeamProfile\nversion: 1\nid: t\nname: T\nextra: 1\n").is_err());
}
#[test] fn yes_stays_a_string() {
    let p = from_text("kind: KubepitTeamProfile\nversion: 1\nid: t\nname: yes\n").unwrap();
    assert_eq!(p.name, "yes");
}
```

- [ ] **Step 2: Run them to verify they fail**. Run `cargo test -p kubepit-core team::model`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement the model, `to_yaml` and `from_text`**. Force block style for multi-line strings by post-processing only if serde_yaml does not already emit `|`; do not hand-write a YAML emitter.
- [ ] **Step 4: Run `cargo test -p kubepit-core team::model`**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(team): team profile model and deterministic YAML"`.

---

### Task 3: Validation, secret scan and JSON Schema

**Files:**
- Create: `crates/kubepit-core/src/team/validate.rs`, `crates/kubepit-core/src/team/team-profile.v1.schema.json`
- Modify: `crates/kubepit-core/src/team/model.rs` (`pub const SCHEMA_JSON: &str = include_str!("team-profile.v1.schema.json")`)
- Test: unit tests in `validate.rs`

**Interfaces:**
- Consumes: `team::model` (Task 2), `custom_actions::model::validate_action`.
- Produces:
  - `TeamSeverity` is `Error | Warning` (lowercase).
  - `TeamFindingCode` (kebab-case): `ParseError`, `WrongKind`, `UnsupportedVersion`, `UnknownField`, `CredentialField`, `InvalidId`, `DuplicateId`, `MissingMatch`, `InvalidUrl`, `UrlCredentials`, `UnknownClusterRef`, `UnknownViewRef`, `InvalidAction`, `InvalidGlob`, `InvalidColor`, `TooLarge`, `TooMany`, `SecretSuspected`, `ViewClusterNotExported`.
  - `TeamFinding { severity, path: String, code, message: String }`. The path looks like `clusters[2].match.server`.
  - `TeamValidation { profile: Option<TeamProfile>, findings: Vec<TeamFinding> }` with `fn ok(&self) -> bool` (no errors).
  - `pub fn validate_text(text: &str, strict: bool) -> TeamValidation`. The phases are:
    1. Size check.
    2. Parse to `serde_yaml::Value` and walk it. Any key in `CREDENTIAL_KEYS = ["token","password","client-key-data","client-certificate-data","client-key","client-certificate","exec","auth-provider","kubeconfig","username","tokenFile","token-file"]` at any depth gives `CredentialField` (error). Keys outside each struct's known field list give `UnknownField`.
    3. Typed parse.
    4. Semantic checks: ids, duplicates per collection, each cluster needs `match.server` or `match.context`, URLs must be `https?://` without userinfo, view and bookmark refs must resolve, each action must pass `validate_action`, glob syntax, colours must be `#rrggbb`, limits.
    5. `secret_scan` over notes, descriptions, names and commands gives `SecretSuspected` (a warning, or an error when `strict`).
  - `pub fn secret_scan(text: &str) -> bool`. Patterns: `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.`, `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`, `-----BEGIN CERTIFICATE-----`, `(?i)(password|passwd|secret|token)\s*[=:]\s*\S{6,}`, `(?i)authorization:\s*bearer\s+\S{10,}`, `(?i)aws_secret_access_key`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn credential_keys_anywhere_are_errors() {
    let v = validate_text("kind: KubepitTeamProfile\nversion: 1\nid: t\nname: T\nclusters:\n- id: a\n  name: a\n  match: {context: a}\n  token: abc\n", false);
    assert!(!v.ok());
    assert!(v.findings.iter().any(|f| f.code == TeamFindingCode::CredentialField && f.path == "clusters[0].token"));
}
#[test] fn semantic_checks() {
    // duplicate cluster ids → DuplicateId; cluster without match → MissingMatch; server "https://u:p@h" → UrlCredentials;
    // bookmark cluster "nope" → UnknownClusterRef; action command with "{nmae}" is fine (unknown placeholders stay literal)
    // but an invalid action id "bad id" → InvalidAction; color "red" → InvalidColor
}
#[test] fn secret_scan_warns_or_fails_in_strict_mode() {
    let doc = "kind: KubepitTeamProfile\nversion: 1\nid: t\nname: T\nclusters:\n- id: a\n  name: a\n  match: {context: a}\n  notes: 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'\n";
    assert!(validate_text(doc, false).ok());
    assert!(!validate_text(doc, true).ok());
}
#[test] fn schema_properties_match_the_model() {
    // parse SCHEMA_JSON; for TeamProfile, TeamCluster, TeamView, TeamBookmark (both variants), TeamHealthIgnore, TeamAlertRules:
    // the set of `properties` keys == the set of keys of serde_json::to_value(fully_populated_sample) for that struct
}
```

- [ ] **Step 2: Run `cargo test -p kubepit-core team::validate`**. Expected: FAIL.
- [ ] **Step 3: Implement the validator, the scan and the schema file**. The schema uses `additionalProperties: false` everywhere and embeds the id pattern and the enums.
- [ ] **Step 4: Run `cargo test -p kubepit-core team::`**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(team): profile validation, secret scan and JSON Schema"`.

---

### Task 4: Export from local state, with the no-secrets proof

**Files:**
- Create: `crates/kubepit-core/src/team/export.rs`, `crates/kubepit-core/tests/team_profiles.rs`
- Modify: `crates/kubepit-core/src/types.rs:31-68` (`ClusterDef.team: Option<TeamLink>` added here, since export reuses linked entry ids), `apps/desktop/src/types/index.ts:53-88`
- Test: `tests/team_profiles.rs`

**Interfaces:**
- Consumes: `to_yaml`, `validate_text` (Tasks 2–3); `credentials::cluster_kubeconfig`; `kubeconfig::server_for_context`.
- Produces:
  - `TeamClusterField` (kebab-case): `Name`, `Tags`, `Environment`, `Color`, `Notes`, `ReadOnly`, `DefaultNamespace`, `AccessibleNamespaces`, `Prometheus`, `Loki`, `ProxyUrl` (+ `Cost`).
  - `TeamLink { profile: String, entry: String, overrides: Vec<TeamClusterField> }`. `ClusterDef.team: Option<TeamLink>` is `#[serde(default)]`. TS: `team?: TeamLink | null`.
  - `TeamExportInclude { views: bool, bookmarks: bool, actions: bool, health_ignores: bool, alerts: bool }`.
  - `ExportView` is camelCase, mirroring TS `SavedView`: `id, name, kindKey, clusterId: Option<String>, filter, namespaces: Option<Vec<String>>, hiddenColumns, columnOrder, columnWidths, sort: Option<{column, desc}>, createdAt: i64`, plus `default: bool`.
  - `ExportBookmark` is camelCase, tagged on `type`, mirroring TS `Bookmark`: `object { id, clusterId, gvk, namespace, name, createdAt }` or `view { id, clusterId, kindKey, viewId, createdAt }`.
  - `ExportHealthIgnore { rule, namespace: Option<String> }`.
  - `TeamExportRequest { id, name, description, cluster_ids: Vec<String>, include, views: Vec<ExportView>, bookmarks: Vec<ExportBookmark>, health_ignores: BTreeMap<String, Vec<ExportHealthIgnore>>, action_ids: Option<Vec<String>> }`.
  - `TeamExportResult { yaml: String, warnings: Vec<TeamFinding> }`.
  - `impl Kubepit { pub fn team_profile_export(&self, request: TeamExportRequest) -> Result<TeamExportResult> }`:
    - Each selected cluster becomes a `TeamCluster`. Its `id` is the linked `team.entry` when it has one, else a unique slug of the name. `match.server` is the kubeconfig server with userinfo stripped, and `match.context` is the context.
    - The metadata fields are copied. `proxy_url` is copied with userinfo stripped.
    - Views and bookmarks for unexported clusters are dropped with a `ViewClusterNotExported` warning.
    - Alerts copy only `disabled_reasons` and the namespace globs from `Settings.alerts`.
    - Actions come from `actions.json` (all of them, or `action_ids`).
    - The output goes through `to_yaml`, then `validate_text(yaml, false)`; errors abort, and warnings come back in the result.
  - `pub fn slugify(name: &str, taken: &HashSet<String>) -> String` produces lowercase `[a-z0-9-]`, collapses dashes, trims the ends, falls back to `cluster`, and appends `-2`, `-3`, … on collisions.

- [ ] **Step 1: Write the failing tests**

```rust
// tests/team_profiles.rs
const SECRETS: &[&str] = &["s3cr3t-token-value", "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCmtleQ==", "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCmNlcnQ=", "exec-env-secret", "proxypass"];
#[tokio::test] async fn export_never_contains_credentials() {
    for keychain in [false, true] {
        // open_with_secrets(Paths::new(tmp), NullSink, MemorySecretStore); keychain → kubeconfig_storage_set(true)
        // cluster A: pasted kubeconfig with users[0].user.token = SECRETS[0], client-key-data = SECRETS[1],
        //   client-certificate-data = SECRETS[2]; cluster B: exec user with env {name: API_KEY, value: SECRETS[3]};
        //   proxy_url "http://user:proxypass@proxy:3128"; notes "plain note"
        let out = app.team_profile_export(all_request(&app)).unwrap();
        for s in SECRETS { assert!(!out.yaml.contains(s), "leaked {s}"); }
        for k in ["token", "client-key-data", "client-certificate-data", "exec:", "password", "users:", "kubeconfig"] {
            assert!(!out.yaml.contains(k), "credential key {k} in export");
        }
        assert!(out.yaml.contains("proxy_url: http://proxy:3128"));
        assert!(kubepit_core::team::validate_text(&out.yaml, true).ok());
    }
}
#[tokio::test] async fn export_maps_clusters_views_and_bookmarks_to_team_ids() {
    // clusters "Prod EU" and "prod-eu" → ids "prod-eu" and "prod-eu-2"; a view bound to cluster A → cluster: prod-eu;
    // a bookmark on an unexported cluster → dropped + warning ViewClusterNotExported
}
#[test] fn alerts_export_only_rules() {
    // Settings.alerts with muted_clusters, snoozed_until, os_notifications=false → YAML has disabled_reasons/exclude_namespaces
    // and none of "muted", "snoozed", "os_notifications", "background_only"
}
```

- [ ] **Step 2: Run `cargo test -p kubepit-core --test team_profiles`**. Expected: FAIL.
- [ ] **Step 3: Implement `TeamLink`, the export and `slugify`; mirror `TeamLink` and `TeamClusterField` in TS**.
- [ ] **Step 4: Run `cargo test -p kubepit-core --test team_profiles && pnpm typecheck`**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(team): export team profiles from local state without credentials"`.

---

### Task 5: Cluster mapping and links

**Files:**
- Create: `crates/kubepit-core/src/team/mapping.rs`
- Modify: `crates/kubepit-core/src/cluster.rs:182-246` (`cluster_update` keeps the backend-owned `team`), `tests/team_profiles.rs`

**Interfaces:**
- Consumes: `TeamProfile` (Task 2), `TeamLink` (Task 4), `kubeconfig::discover_with`, `server_for_context`.
- Produces:
  - `pub fn normalize_server(url: &str) -> Option<String>`: lowercases the scheme and host, drops userinfo, drops `:443` for https and `:80` for http, and trims trailing `/`. Returns `None` for unparsable input.
  - `MappingState` (kebab-case): `Linked`, `Candidate`, `Ambiguous`, `NeedsCredentials`.
  - `MatchedBy` (lowercase): `Server`, `Context`, `Manual`.
  - `MappingCandidate { cluster_id: Option<String>, kubeconfig_path: Option<String>, context: String, server: Option<String>, matched_by: MatchedBy }`.
  - `TeamClusterMapping { profile_id, entry_id, name, state, cluster_id: Option<String>, candidates: Vec<MappingCandidate> }`.
  - `pub(crate) fn map_clusters(profile: &TeamProfile, registered: &[(ClusterDef, Option<String> /*server*/)], discovered: &[KubeconfigSource]) -> Vec<TeamClusterMapping>`. Precedence per entry:
    1. An existing link (`team.profile == id && team.entry == entry`) is `Linked`.
    2. Registered server matches: exactly 1 is `Linked` (auto-link), 2 or more are `Ambiguous`.
    3. Registered context matches, with the same rule.
    4. Discovered contexts (server match first, then context) are `Candidate`.
    5. Otherwise `NeedsCredentials`.

    A registered cluster already linked to another entry is never a candidate.
  - `impl Kubepit { pub fn team_cluster_link(&self, profile_id: &str, entry_id: &str, cluster_id: Option<&str>) -> Result<()> }`: `None` unlinks. It refuses a cluster linked to another entry (`bail!("already-linked: …")`).
  - `impl Kubepit { pub fn team_cluster_add_from_context(&self, profile_id: &str, entry_id: &str, kubeconfig_path: &str, context: &str) -> Result<ClusterDef> }` calls `cluster_add` with the file origin, then links.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn normalize_server_cases() {
    assert_eq!(normalize_server("HTTPS://User:pw@ABC.EKS.amazonaws.com:443/").as_deref(), Some("https://abc.eks.amazonaws.com"));
    assert_eq!(normalize_server("http://10.0.0.1:80").as_deref(), Some("http://10.0.0.1"));
    assert_eq!(normalize_server("https://k:6443").as_deref(), Some("https://k:6443"));
    assert_eq!(normalize_server("not a url"), None);
}
// tests/team_profiles.rs
#[tokio::test] async fn mapping_prefers_server_then_context_then_discovery() { /* registered by server, by context,
   discovered-only in a temp HOME ~/.kube/config (discover_with(Some(tmp_home), None, &[])), and none → states
   Linked, Linked, Candidate, NeedsCredentials */ }
#[tokio::test] async fn ambiguous_server_needs_a_pick_and_the_pick_sticks() {
    // two registered clusters with the same server → Ambiguous; team_cluster_link(.., Some(b)) → Linked(b);
    // a fresh map_clusters (reload) still returns Linked(b); cluster_update(b with team=None) keeps the link
}
```

- [ ] **Step 2: Run `cargo test -p kubepit-core team::mapping --test team_profiles`**. Expected: FAIL.
- [ ] **Step 3: Implement**. Server lookup for registered clusters uses `cluster_kubeconfig` (keychain aware); a load error means `None`.
- [ ] **Step 4: Run the same command**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(team): map team clusters to local credentials"`.

---

### Task 6: Layering: materialized clusters and effective alerts

**Files:**
- Create: `crates/kubepit-core/src/team/apply.rs`
- Modify: `crates/kubepit-core/src/types.rs:1034-1088` (`Settings.alerts_team_overrides`), `crates/kubepit-core/src/app.rs:169-201`, `crates/kubepit-core/src/alerts.rs:150-155` callers, `crates/kubepit-core/src/cluster.rs:182-246`, `apps/desktop/src/types/index.ts:1209-1240`
- Test: unit tests in `apply.rs`, `tests/team_profiles.rs`

**Interfaces:**
- Consumes: `TeamLink`, `TeamClusterField` (Task 4); `TeamCluster`, `TeamAlertRules` (Task 2).
- Produces:
  - `pub fn materialize(def: &ClusterDef, entry: &TeamCluster) -> ClusterDef`. It copies every team field not in `def.team.overrides`. `read_only` is `entry.read_only || def.read_only` when overridden, and `entry.read_only` otherwise.
  - `TeamAlertField` (kebab-case): `DisabledReasons`, `IncludeNamespaces`, `ExcludeNamespaces`.
  - `Settings.alerts_team_overrides: Vec<TeamAlertField>` (default empty).
  - `pub fn effective_alerts(local: &AlertSettings, team: Option<&TeamAlertRules>, overrides: &[TeamAlertField]) -> AlertSettings`. Each team `Some(v)` field replaces the local value unless it is overridden. Machine-local fields are always local.
  - `impl Kubepit { pub(crate) fn effective_alert_settings(&self) -> AlertSettings }`. `set_settings` and team reloads call `apply_alert_settings(&self.effective_alert_settings())`.
  - `cluster_update` compares incoming against existing for linked clusters. A changed team field is added to `team.overrides`, so editing a team value in the cluster editor is an override.
  - `impl Kubepit { pub fn team_cluster_override(&self, cluster_id: &str, field: TeamClusterField, overridden: bool) -> Result<ClusterDef> }` sets overrides explicitly. Turning an override off re-applies the team value at once.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn overrides_survive_reloads_and_read_only_only_tightens() {
    let entry = team_cluster(|c| { c.color = Some("#ff0000".into()); c.read_only = true; c.tags = vec!["eks".into()]; });
    let mut def = local_def(|d| { d.color = Some("#00ff00".into()); d.read_only = false;
        d.team = Some(TeamLink { profile: "p".into(), entry: "e".into(), overrides: vec![TeamClusterField::Color, TeamClusterField::ReadOnly] }); });
    let out = materialize(&def, &entry);
    assert_eq!(out.color.as_deref(), Some("#00ff00"));
    assert!(out.read_only);
    assert_eq!(out.tags, vec!["eks"]);
    def.team.as_mut().unwrap().overrides.clear();
    assert_eq!(materialize(&def, &entry).color.as_deref(), Some("#ff0000"));
}
#[test] fn effective_alerts_respect_overrides_and_keep_machine_state() {
    // team exclude ["kube-system"], local exclude ["x"], muted {a: None}; overrides [] → exclude ["kube-system"], muted kept;
    // overrides [ExcludeNamespaces] → exclude ["x"]
}
// tests/team_profiles.rs
#[tokio::test] async fn read_only_from_team_blocks_mutations() {
    // link a cluster to an entry with read_only: true, reload; resource_delete on it → is_read_only(err)
}
```

- [ ] **Step 2: Run `cargo test -p kubepit-core team::apply --test team_profiles`**. Expected: FAIL.
- [ ] **Step 3: Implement `materialize`, `effective_alerts`, override recording and `team_cluster_override`; add the TS `alerts_team_overrides`**.
- [ ] **Step 4: Run `cargo test -p kubepit-core && pnpm typecheck`**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(team): layer team values under local overrides"`.

---

### Task 7: Team custom actions and the trust gate

**Files:**
- Modify: `crates/kubepit-core/Cargo.toml` (`sha2 = "0.10"`), `crates/kubepit-core/src/team/apply.rs`, `crates/kubepit-core/src/custom_actions/model.rs:174-181`, `crates/kubepit-core/src/custom_actions/mod.rs:115-250`, `crates/kubepit-core/src/types.rs` (`Settings.trusted_team_actions`, `Settings.team_actions_disabled`), `apps/desktop/src/types/index.ts`
- Test: `crates/kubepit-core/tests/team_profiles.rs`

**Interfaces:**
- Consumes: `TeamProfile.actions` (Task 2).
- Produces:
  - `pub fn action_fingerprint(a: &CustomAction) -> String`: lowercase hex SHA-256 of `serde_json::to_string(&json!({command, mode, scopes, namespaces, cluster_tags, mutating, confirm, timeout_secs}))`.
  - `TeamAction { action: CustomAction /* id = "team.<profile>.<id>" */, profile: String, fingerprint: String, trusted: bool, disabled_locally: bool }`.
  - `CustomActionsState.team: Vec<TeamAction>` (`#[serde(default)]`). TS: `team: TeamAction[]`.
  - `Settings.trusted_team_actions: BTreeMap<String, String>` (id → fingerprint) and `Settings.team_actions_disabled: Vec<String>`.
  - `runnable_action` resolves ids starting with `team.` from the loaded team actions. It refuses:
    - a locally disabled action: `bail!("the custom action \"…\" is disabled")`
    - an untrusted action: `bail!("untrusted-team-action: review \"…\" before running it")`

    Then it applies today's mutating/read-only and scope checks.
  - `custom_actions_save` rejects ids starting with `team.` (`bail!("team actions are read-only")`).
  - `impl Kubepit { pub fn team_action_trust(&self, action_id: &str, fingerprint: &str) -> Result<()> }` refuses a fingerprint that is not the current one (`bail!("stale-fingerprint")`).

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test] async fn trust_gate_refuses_then_allows_and_rearms_on_change() {
    // subscribe a profile (temp file) with action {id: echo, command: "echo {name}", mode: background};
    let id = "team.p.echo";
    let err = app.custom_action_run(&cluster, id, &target).await.unwrap_err();
    assert!(err.to_string().starts_with("untrusted-team-action"));
    let fp = app.custom_actions_list().team[0].fingerprint.clone();
    app.team_action_trust(id, &fp).unwrap();
    assert!(app.custom_action_run(&cluster, id, &target).await.is_ok());
    // edit the file: command "echo changed {name}"; team_profiles_reload() → trusted == false, run refused again
    assert!(app.team_action_trust(id, &fp).is_err());
}
#[tokio::test] async fn team_actions_cannot_be_saved_locally() {
    let mut list = app.custom_actions_list().actions;
    list.push(CustomAction { id: "team.p.x".into(), ..Default::default() });
    assert!(app.custom_actions_save(list).is_err());
}
```

(These tests use `team_profile_subscribe` and `team_profiles_reload` from Task 8. Write them now and mark them `#[ignore]`; Task 8 removes the `#[ignore]`. Unit-test `action_fingerprint` stability here: the same definition gives the same hash, and a changed command gives a different hash.)

- [ ] **Step 2: Run `cargo test -p kubepit-core team::apply::fingerprint`**. Expected: FAIL.
- [ ] **Step 3: Implement the fingerprint, the state field, the lookup, the gate, save rejection and `team_action_trust`**.
- [ ] **Step 4: Run `cargo test -p kubepit-core && pnpm typecheck`**. Expected: PASS (the ignored tests are skipped).
- [ ] **Step 5: Commit** `git commit -m "feat(team): team custom actions behind a trust gate"`.

---

### Task 8: Subscriptions, preview, import and state

**Files:**
- Create: `crates/kubepit-core/src/team/subscriptions.rs`
- Modify: `crates/kubepit-core/src/team/mod.rs` (`TeamState`), `crates/kubepit-core/src/app.rs` (field `team: TeamState`), `crates/kubepit-core/src/types.rs` (`Settings.team_profiles`), `crates/kubepit-core/src/events.rs` (`team_profiles_changed`), `apps/desktop/src/types/index.ts`
- Test: `tests/team_profiles.rs` (also remove the `#[ignore]` added in Task 7)

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces:
  - `TeamSubscription { path: String, enabled: bool }` and `Settings.team_profiles: Vec<TeamSubscription>`.
  - `TeamSource { path: Option<String>, text: Option<String> }`. Exactly one must be set.
  - `TeamCounts { clusters, views, bookmarks, actions, health_ignores: u32 }`.
  - `TeamProfileStatus { path, enabled, profile_id: Option<String>, name: Option<String>, loaded_at: Option<i64>, counts: TeamCounts, findings: Vec<TeamFinding> }`.
  - `TeamConflict { profile_id, kind: String /* "cluster" | "view" | "bookmark" | "action" | "health-ignore" | "local-cluster" */, entry_id, winner: String }`.
  - `TeamViewEntry { profile: String, view: TeamView }` and `TeamBookmarkEntry { profile, bookmark: TeamBookmark }`.
  - `TeamIgnoreEntry { profile, ignore: TeamHealthIgnore }`.
  - `TeamProfilesState { profiles: Vec<TeamProfileStatus>, clusters: Vec<TeamClusterMapping>, views: Vec<TeamViewEntry>, bookmarks: Vec<TeamBookmarkEntry>, health_ignores: Vec<TeamIgnoreEntry>, alerts: Option<TeamAlertRules>, conflicts: Vec<TeamConflict> }`.
  - `EventSink::team_profiles_changed(&self, _state: &TeamProfilesState) {}`.
  - `impl Kubepit`:
    - `pub fn team_profiles_state(&self) -> TeamProfilesState`
    - `pub fn team_profiles_reload(&self) -> TeamProfilesState`. It resolves a directory path to `<dir>/kubepit-team.yaml`, reads and validates each enabled subscription (**keeping the last good profile on errors**), maps clusters, auto-links unambiguous ones, materializes linked clusters (disconnecting only when `proxy_url` changed), applies effective alerts, and emits `cluster_list` and `team_profiles_changed`. Cross-profile duplicates resolve with the first subscription winning, and the loser is recorded as a `TeamConflict`.
    - `pub fn team_profile_subscribe(&self, path: &str) -> Result<TeamProfilesState>` and `pub fn team_profile_unsubscribe(&self, path: &str) -> Result<TeamProfilesState>`. Unsubscribing or disabling drops `team` from linked clusters and keeps their current values.
    - `pub fn team_profile_preview(&self, source: TeamSource) -> Result<TeamPreview>`, where `TeamPreview { validation: TeamValidation, mapping: Vec<TeamClusterMapping>, changes: Vec<TeamClusterChange { cluster_id, fields: Vec<TeamClusterField> }> }`.
    - `pub fn team_profile_validate(&self, source: TeamSource) -> TeamValidation`.
    - `pub fn team_profile_import(&self, request: TeamImportRequest) -> Result<TeamImportResult>`, where `TeamImportRequest { source, include: TeamExportInclude, links: BTreeMap<String, String> }` and `TeamImportResult { clusters_updated: Vec<String>, actions_added: u32, views: Vec<ExportView>, bookmarks: Vec<ExportBookmark>, health_ignores: BTreeMap<String, Vec<ExportHealthIgnore>> }`. The import writes plain local values: no link, actions appended with ids made unique, alert rules written into `Settings.alerts`. Views, bookmarks and ignores come back with local cluster ids for the UI to store.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test] async fn subscribe_links_materializes_and_emits() { /* temp dir with kubepit-team.yaml; subscribe(dir) →
   profiles[0].name == "Platform", the linked cluster has the team color/tags, recorder saw team_profiles_changed */ }
#[tokio::test] async fn two_profiles_first_wins_with_a_conflict() { /* same cluster entry matched by both → one link, conflicts.len()==1 */ }
#[tokio::test] async fn unsubscribe_unlinks_but_keeps_clusters() { /* after unsubscribe: cluster still exists with team color, team == None,
   state.views empty, custom_actions_list().team empty */ }
#[tokio::test] async fn import_writes_local_copies_without_links() { /* team_profile_import → cluster updated, team == None;
   actions_added == 1 and custom_actions_list().actions contains it (ids unique); result.views have the local clusterId */ }
#[tokio::test] async fn preview_lists_changes_and_needs_credentials() { /* preview shows changed fields for the linked cluster and
   one NeedsCredentials entry; nothing is written (clusters.json unchanged) */ }
```

- [ ] **Step 2: Run `cargo test -p kubepit-core --test team_profiles`**. Expected: FAIL.
- [ ] **Step 3: Implement `TeamState`, the subscriptions, preview, import, validate and the sink method; mirror the types in TS**.
- [ ] **Step 4: Run `cargo test -p kubepit-core && pnpm typecheck`**. Expected: PASS, including the Task 7 tests.
- [ ] **Step 5: Commit** `git commit -m "feat(team): subscribe to, preview and import team profiles"`.

---

### Task 9: Profile watcher (opt-in)

**Files:**
- Create: `crates/kubepit-core/src/team/watch.rs`
- Modify: `crates/kubepit-core/src/app.rs:213-231` (`shutdown` stops the watcher), `crates/kubepit-core/src/team/mod.rs`
- Test: `tests/team_profiles.rs`

**Interfaces:**
- Consumes: `team_profiles_reload` (Task 8). Pattern: `kubeconfig_watch.rs:261-448` (`Weak<Kubepit>`, a dedicated thread, `recommended_watcher` on parent directories, `RecursiveMode::NonRecursive`, `recv_timeout`, debounce and re-arm).
- Produces: `impl Kubepit { pub fn start_team_profile_watch(self: &Arc<Self>); pub fn stop_team_profile_watch(&self) }`. It is idempotent, watches the parent directory of every enabled subscription's resolved file, debounces by 500 ms, re-reads the subscription list every 3 s, and calls `team_profiles_reload()` when a relevant file changed.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test(flavor = "multi_thread")] async fn watcher_applies_edits() {
    // subscribe temp file (color "#111111"); app.start_team_profile_watch(); rewrite file with color "#222222";
    // wait_for (poll 50ms, ≤20s, like tests/connectivity.rs:88-97) until the linked cluster's color == "#222222"
}
#[tokio::test(flavor = "multi_thread")] async fn broken_write_keeps_last_good_profile() {
    // write "kind: [" → state.profiles[0].findings has ParseError, linked cluster keeps "#222222";
    // write a good file again → findings empty
}
#[test] fn nothing_is_watched_unless_started() { /* Kubepit::open + subscribe → no watcher thread (team watch slot is None) */ }
```

- [ ] **Step 2: Run `cargo test -p kubepit-core --test team_profiles watcher_ broken_write nothing_is_watched`**. Expected: FAIL.
- [ ] **Step 3: Implement the watcher**.
- [ ] **Step 4: Run the same command**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(team): watch subscribed team profiles"`.

---

### Task 10: `kubepit-team` validation CLI

**Files:**
- Create: `crates/kubepit-core/src/bin/kubepit-team.rs`
- Modify: `crates/kubepit-core/Cargo.toml` (`[[bin]] name = "kubepit-team", path = "src/bin/kubepit-team.rs"`)
- Test: `tests/team_profiles.rs` (runs `env!("CARGO_BIN_EXE_kubepit-team")`)

**Interfaces:**
- Consumes: `team::validate_text`, `team::model::SCHEMA_JSON`.
- Produces this CLI:
  - `kubepit-team validate [--strict] <path>…` prints one line per finding, formatted `"{path}: {severity}: {finding.path}: {code}: {message}"`, then `"{n} file(s) valid"` or `"{n} problem(s)"`. It exits 0 when every file is valid, 1 on any error finding, and 2 on usage errors or unreadable files. A directory argument resolves to `kubepit-team.yaml`.
  - `kubepit-team schema` prints `SCHEMA_JSON`.
  - `kubepit-team --version` prints the crate version.

  It uses no new dependency (manual argument parsing).

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn cli_validates_and_sets_exit_codes() {
    let bin = env!("CARGO_BIN_EXE_kubepit-team");
    // good file → status 0, stdout ends with "1 file(s) valid"
    // file with "token:" key → status 1, stdout contains "credential-field"
    // file with a JWT in notes: without --strict → 0 (warning printed); with --strict → 1
    // missing file → 2; `schema` → stdout parses as JSON with "$schema"
}
```

- [ ] **Step 2: Run `cargo test -p kubepit-core --test team_profiles cli_`**. Expected: FAIL.
- [ ] **Step 3: Implement the bin**.
- [ ] **Step 4: Run `cargo test -p kubepit-core --test team_profiles cli_ && cargo clippy --workspace --all-targets -- -D warnings`**. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(team): kubepit-team validation CLI for CI"`.

---

### Task 11: Desktop IPC, event and watcher start

**Files:**
- Create: `apps/desktop/src-tauri/src/ipc/team.rs`
- Modify: `apps/desktop/src-tauri/src/ipc/mod.rs`, `apps/desktop/src-tauri/src/lib.rs:51-216`, `apps/desktop/src-tauri/src/app_state.rs` (`EVENT_TEAM_PROFILES_CHANGED = "teamprofile://changed"` and the sink method), `apps/desktop/src-tauri/src/setup.rs:31` (`core.start_team_profile_watch()` after `start_kubeconfig_watch`, and one initial `team_profiles_reload()`)

**Interfaces:**
- Produces these commands:
  - `team_profile_export(request)`
  - `team_profile_validate(source)`
  - `team_profile_preview(source)`
  - `team_profile_import(request)`
  - `team_profiles_state()`
  - `team_profiles_reload()`
  - `team_profile_subscribe(path)` and `team_profile_unsubscribe(path)`
  - `team_cluster_link(profileId, entryId, clusterId)`
  - `team_cluster_add_from_context(profileId, entryId, kubeconfigPath, context)`
  - `team_cluster_override(clusterId, field, overridden)`
  - `team_action_trust(actionId, fingerprint)`

  Synchronous core calls go through `blocking(...)` (pattern `ipc/clusters.rs:44-51`).

- [ ] **Step 1: Add the commands, the sink and the setup wiring**.
- [ ] **Step 2: Run `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`**. Expected: all pass.
- [ ] **Step 3: Commit** `git commit -m "feat(desktop): team profile IPC commands and watcher"`.

---

### Task 12: TS contract, team layers and demo backend

**Files:**
- Modify: `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts`, `apps/desktop/src/lib/savedViews.ts:26-33`, `apps/desktop/src/store/useSavedViewsStore.ts`, `apps/desktop/src/store/useBookmarksStore.ts`, `apps/desktop/src/store/useHealthStore.ts`, `apps/desktop/src/components/app/useAppBootstrap.ts`, `apps/desktop/src/lib/ipc/mock/index.ts`
- Create: `apps/desktop/src/lib/team/layers.ts`, `lib/team/layers.test.ts`, `lib/team/exportRequest.ts`, `lib/team/exportRequest.test.ts`, `apps/desktop/src/store/useTeamStore.ts`, `apps/desktop/src/lib/ipc/mock/team.ts`

**Interfaces:**
- Consumes: the Rust types from Tasks 4–8.
- Produces:
  - `ipc.teamProfileExport|Validate|Preview|Import`
  - `ipc.teamProfilesState|Reload`
  - `ipc.teamProfileSubscribe|Unsubscribe`
  - `ipc.teamClusterLink|AddFromContext|Override`
  - `ipc.teamActionTrust`
  - `events.onTeamProfilesChanged`
  - `SavedView.team?: { profile: string }`, `Bookmark` members gain `team?: { profile: string }`, `HealthIgnore.team?: string`.
  - `lib/team/layers.ts`: `teamLayers(state: TeamProfilesState, clusterIds: ClusterId[]): { views: SavedView[]; bookmarks: Bookmark[]; ignores: Record<ClusterId, HealthIgnore[]> }`:
    - View and bookmark ids become `team.<profile>.<id>`. View bookmarks point at `team.<profile>.<viewId>`.
    - Team cluster refs resolve through `state.clusters` entries with `state === 'linked'`. Entries whose cluster is not linked are dropped. A view with `cluster: null` stays global.
    - An ignore with `cluster: "*"` applies to every id in `clusterIds`.
  - `lib/team/exportRequest.ts`: `buildExportRequest(input: { id; name; description; clusterIds: ClusterId[]; include: TeamExportInclude; views: SavedView[]; defaults: Record<string, string>; bookmarks: Bookmark[]; ignores: Record<ClusterId, HealthIgnore[]> }): TeamExportRequest`. It keeps local entries only (drops `team`), marks views that are defaults, and keeps ignores only for exported clusters.
  - `store/useTeamStore.ts`: `{ state: TeamProfilesState | null; load(): Promise<void>; set(state) }`. On `set`, it pushes `teamLayers` into `useSavedViewsStore.setTeamViews`, `useBookmarksStore.setTeamBookmarks` and `useHealthStore.setTeamIgnores`.
  - Stores:
    - `teamViews`, `teamBookmarks` and `teamIgnores` are left out of `partialize` and out of the workspace snapshot (`useAppBootstrap.ts:98-113`).
    - The selectors `selectViews`, `selectBookmarks` and `useHealthIgnores` return local plus team entries. Replace direct `s.views` / `s.bookmarks` reads (grep both) with them.
    - Mutating actions ignore ids that start with `team.`.
  - Demo (`mock/team.ts`):
    - A subscribed profile "Platform (demo)" at `~/src/platform/kubepit-team.yaml` that links `prod-eu-west-1` and `staging-gke`, with 2 views, 1 bookmark, 2 actions (one trusted, one not), ignores and alert rules.
    - `team_profile_export` returns a YAML built in TS from the request (a simplified serializer is enough for the demo).
    - Validate and preview accept `text`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/team/layers.test.ts
import { describe, expect, it } from 'vitest';
import { teamLayers } from './layers';
describe('teamLayers', () => {
  it('resolves linked clusters, drops unlinked ones and expands "*" ignores', () => {
    const out = teamLayers(demoState(), ['c-prod', 'c-dev']);
    expect(out.views.map((v) => [v.id, v.clusterId])).toEqual([['team.p.failing', 'c-prod'], ['team.p.global', null]]);
    expect(out.bookmarks.every((b) => b.team?.profile === 'p')).toBe(true);
    expect(Object.keys(out.ignores).sort()).toEqual(['c-dev', 'c-prod']);
  });
});
// lib/team/exportRequest.test.ts: team entries are excluded; a default view has default: true; ignores of unexported clusters are dropped
```

- [ ] **Step 2: Run `pnpm --filter @kubepit/desktop exec vitest run src/lib/team`**. Expected: FAIL.
- [ ] **Step 3: Implement the contract, layers, the export request, the stores, the bootstrap load and subscription, and the mock**.
- [ ] **Step 4: Run `pnpm test && pnpm typecheck && pnpm i18n:check`**. Expected: PASS. `pnpm dev:ui` shows the team views in the prod cluster's saved-views menu.
- [ ] **Step 5: Commit** `git commit -m "feat(ui): team profile contract, read-only team layers and demo profile"`.

---

### Task 13: Settings → Team profiles

**Files:**
- Create: `apps/desktop/src/components/settings/TeamCategory.tsx`, `settings/team/SubscriptionList.tsx`, `settings/team/ProfilePreviewDialog.tsx`, `settings/team/ExportDialog.tsx`, `settings/team/ValidateDialog.tsx`, `settings/team/ClusterMappingTable.tsx`, `apps/desktop/src/components/ui/TeamBadge.tsx`
- Modify: `apps/desktop/src/store/types.ts:39-49` (`'team'`), `apps/desktop/src/components/settings/SettingsView.tsx:30-141,210-222`, `apps/desktop/src/i18n/{en,tr}/shell.json`

**Interfaces:**
- Consumes: `useTeamStore`, `ipc.team*`, `buildExportRequest` (Task 12); `pickOpenPath`, `pickSavePath`, `saveTextAs` (`components/workbench/dock/shared/saveFile.ts:12-50`); `downloadText` (`lib/platform.ts:47`).
- Produces:
  - `TeamBadge({ profile }: { profile: string })` renders a lock icon and `i18n.t('Managed by {profile}', { profile })` (11px, `text-fg-dim`).
  - The category (group `workspace`, icon `Users`):
    - The subscription list shows status, counts, findings (code → translated text, detail verbatim), conflicts, Reload, the enable switch and Remove.
    - "Subscribe…" picks a file or folder, then the preview dialog, then `teamProfileSubscribe`.
    - "Import…" shows the preview with section toggles, then `teamProfileImport`, then adds the returned views, bookmarks and ignores to the local stores.
    - "Export…" has a cluster checklist, section toggles, id and name, and the warnings list, then saves `kubepit-team.yaml`.
    - "Validate…" picks a file and lists its findings.
    - The mapping table shows state chips. Linked, Candidate and Ambiguous rows have a picker. NeedsCredentials rows have "Pick context…" (discovered contexts), "Paste kubeconfig…" (opens `ClusterEditor` in paste mode, then links on save) and "Import from cloud…" (only when `useAppStore.getState().setImportDialogOpen` accepts a tab argument, which the cloud-import plan adds).
  - One `findingText(code: TeamFindingCode): string` helper translates every finding code once.

- [ ] **Step 1: Build the category and its dialogs; register it in `SettingsView`**.
- [ ] **Step 2: Translate**: run `pnpm i18n:check -- --fix`, then add Turkish to `src/i18n/tr/shell.json` by hand. Expected: `i18n OK`.
- [ ] **Step 3: Verify**: run `pnpm typecheck && pnpm test && pnpm i18n:check`, expecting PASS. Manual (`pnpm dev:ui`, EN and TR, narrow and wide): the demo subscription shows 2 linked clusters. Export the prod cluster: the YAML shows no `token` and has the schema comment. Validate a pasted profile containing `token:` and see "credential field" in the findings.
- [ ] **Step 4: Commit** `git commit -m "feat(ui): team profiles settings with subscribe, import, export and validation"`.

---

### Task 14: Locks, overrides and trust review across the app

**Files:**
- Modify: `apps/desktop/src/components/cluster-editor/ClusterEditor.tsx` and `cluster-editor/ClusterFields.tsx` (per-field lock and override toggle for linked clusters, calling `ipc.teamClusterOverride`), `apps/desktop/src/components/settings/CustomActionsCategory.tsx` (team section: badge, disable switch writing `team_actions_disabled`, a Review button opening the trust dialog), `apps/desktop/src/components/workbench/actions/custom/runCustomAction.tsx` (an untrusted team action opens the review instead of running), `apps/desktop/src/components/settings/NotificationsCategory.tsx` (team alert rules with override toggles for `alerts_team_overrides`), `apps/desktop/src/components/workbench/health/HealthPage.tsx:334-345` (team ignores show `TeamBadge`, no restore button), `apps/desktop/src/components/workbench/nav/BookmarksSection.tsx` and the saved-views menu under `components/workbench/table/` (team entries locked: no rename, delete or set-default), `apps/desktop/src/i18n/{en,tr}/{shell,workbench}.json`
- Create: `apps/desktop/src/components/settings/customActions/TrustDialog.tsx`

**Interfaces:**
- Consumes: `TeamBadge` (Task 13), `TeamAction` and `TeamLink` (TS), `ipc.teamActionTrust` and `ipc.teamClusterOverride`.
- Produces: `TrustDialog({ action, onClose })`. It shows the name, profile, mode, the mutating flag and the command in `CopyableCodeBlock`. When a previous fingerprint exists (the id is in `settings.trusted_team_actions` with another value), it adds "Changed since you last trusted it". Trusting calls `teamActionTrust(action.id, fingerprint)`, then reloads the custom actions.

- [ ] **Step 1: Implement the locks, overrides and trust review**.
- [ ] **Step 2: Translate**: run `pnpm i18n:check -- --fix` and add Turkish by hand. Expected: `i18n OK`.
- [ ] **Step 3: Verify**: run `pnpm typecheck && pnpm test && pnpm i18n:check`, expecting PASS. Manual (`pnpm dev:ui`): on the linked prod cluster the colour field is locked, and "Override" makes it editable. The read-only toggle cannot be turned off when the team says read-only. The untrusted demo action opens the review, and after trusting it runs. Team ignores and team views cannot be removed.
- [ ] **Step 4: Commit** `git commit -m "feat(ui): team locks, local overrides and action trust review"`.

---

### Task 15: Documentation and final verification

**Files:**
- Create: `docs/TEAM_PROFILES.md`
- Modify: `docs/ARCHITECTURE.md` (a "Team profiles" section: model, layering, mapping, trust gate, watcher opt-in, persistence of the new `settings.json` fields, the `teamprofile://changed` event), `README.md` (feature bullet)

- [ ] **Step 1: Write `docs/TEAM_PROFILES.md`**. It covers: the format reference (every field, with the Task 2 example), what is never included, conflict and override rules, mapping rules, the trust gate, and a CI recipe:

```yaml
# .github/workflows/kubepit-team.yml
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo install --locked --git https://github.com/erdembas/kubepit --bin kubepit-team kubepit-core
      - run: kubepit-team validate --strict kubepit-team.yaml
```

- [ ] **Step 2: Run the six checks**: `pnpm typecheck && pnpm i18n:check && pnpm test && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`. Expected: all pass.
- [ ] **Step 3: Commit** `git commit -m "docs: team profiles format, rules and CI validation"`.
