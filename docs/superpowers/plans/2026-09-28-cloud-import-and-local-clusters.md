# Cloud Import and Local Clusters Implementation Plan

> **Superseded implementation direction (2026-09-29):** AWS/GCP/Azure discovery
> and import are now paid private features; local kind/k3d/minikube lifecycle is
> proposed as free. Start with the [commercial program](2026-09-29-commercial-program.md).
> Reuse this file's provider/CLI safety cases, but not its all-public code placement
> or obsolete test-harness setup. Do not execute it unchanged.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add EKS/GKE/AKS clusters through the user's own CLIs and create/start/stop/delete kind, k3d and minikube clusters from an "Add cluster" hub. Every result is registered as a Kubepit-managed kubeconfig and no user kubeconfig is ever written.

**Architecture:** Two new core modules, `crates/kubepit-core/src/cloud/` and `crates/kubepit-core/src/local_clusters/`. Pure argument builders and parsers sit in per-provider files. One CLI runner resolves tools through `tools.rs`, whose overrides live in `Settings.tool_paths`. Imports run the provider CLI against a private temp kubeconfig, reduce it to one context and register it through the existing managed path (`store_managed`, which is keychain aware); imports are idempotent by a new `ClusterDef.origin`. Login and local-cluster operations run as backend-built argv in PTY terminals opened in a new cluster-less "Local dock" on the Dashboard. The terminal exit hook in the desktop shell registers local clusters.

**Tech Stack:** Rust (tokio, serde, serde_yaml, kube `Kubeconfig`), Tauri 2 commands, Channels and events, React 18 + Tailwind v4 + Zustand, Vitest (dev only, for pure TS helpers).

**Spec:** `docs/superpowers/specs/2026-09-28-cloud-import-and-local-clusters-design.md`

## Global Constraints

- IPC contract: every new command, type, event and `TerminalSpec` variant changes `apps/desktop/src/types/index.ts` **and** `apps/desktop/src/lib/ipc.ts` in the same task as the Rust side. Serde field names are snake_case like the TS interfaces. Tagged unions use `#[serde(tag = "kind", rename_all = "kebab-case")]`.
- Design: the UI must be visually identical to RunHQ. Use tokens from `src/styles/theme.css`, primitives from `src/components/ui/` (`Dialog`, `Tabs`, `Button`, `Select`, `Input`, `Switch`, `ConfirmDialog`, `Badge`), 11–13px UI text, uppercase tracked labels, `bg-fg/N` hover pads and the accent strip for active rows. No chart or UI libraries.
- Layouts use container queries (`@container`, `@[560px]:`), not viewport breakpoints.
- i18n: every user-visible string ships in English **and** Turkish in the same task. Use `import * as i18n from '@/i18n'` plus `i18n.useLocale()` in components and `@/i18n/core` in pure helpers. Use `i18n.t` / `i18n.rich` / `i18n.plural`, never concatenated fragments. Run `pnpm i18n:check -- --fix`, then add the Turkish values by hand. `pnpm i18n:check` must pass. Never translate provider or product names, CLI commands, regions, cluster/profile/project names, kubeconfig content or CLI output.
- Safety: tests never run real `aws`/`gcloud`/`az`/`kind`/`k3d`/`minikube`/`kubelogin`, never connect to a real cluster or cloud account, and never read real user files (`~/.kube`, `~/.aws`, `~/.config/gcloud`, `~/.azure`). Use the fake CLI harness (`tests/support/fake_cli.rs`), the fake API server (`tests/support/mod.rs`), `Paths::new(tempdir)` (never `KUBEPIT_HOME` from the environment) and `MemorySecretStore`. Never mutate the process `PATH` in tests.
- Kubepit never writes a user kubeconfig. Every provider CLI invocation that could write one gets an explicit private target (`--kubeconfig`/`--file` and/or `KUBECONFIG`) inside `run/`.
- `read_only`: deleting or stopping a local cluster registered with `read_only: true` is refused in the backend via `ensure_writable`. Cloud import and local create are allowed.
- Background work is opt-in per process: nothing here polls. Discovery, listing and import run on request only. Local-cluster completion runs only from the desktop shell's terminal exit hook (tests call `local_cluster_terminal_exited` directly).
- Timeouts: 60 s for list/describe/accounts calls, 120 s for credential generation and `kubeconfig get`, 5 s for version probes. Discovery concurrency is ≤ 4 scopes. CLI error detail is trimmed to 4096 bytes.
- Name rules: accounts/profiles/configurations/subscriptions/resource groups/cloud cluster names must match `^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}$`, and local cluster names `^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$`. Local nodes are 1–10, ports 1–65535 with unique host ports, and versions match `^v?\d+\.\d+(\.\d+)?$`.
- The six checks, all passing at the end of every task that touches their area:
  `pnpm typecheck` · `pnpm i18n:check` · `pnpm test` · `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace`.
  `pnpm dev:ui` must keep working against the demo backend (`src/lib/ipc/mock/`) whenever commands are added.

## Review Focus

- **CLI missing or not on the GUI `PATH`** (Finder launch, SDK in `~/google-cloud-sdk/bin`): tool status reads "not found", discovery returns `tool-missing` without a panic or hang, and a `tool_paths` override fixes it. Tested in Task 4 (`accounts_report_tool_missing_without_running_anything`).
- **Expired SSO or login mid-discovery**: that scope reports `login-required` while the other scopes still list clusters, and **Sign in** opens the right login argv. Tested in Task 5 (`one_expired_scope_does_not_block_the_others`) and Task 7.
- **CLI prints warnings or non-JSON noise around its JSON** (the aws v1 deprecation banner, gcloud "Listed 0 items." on stderr): parsers read stdout only, tolerate empty output as "no clusters", and fail with `failed` plus the raw text on malformed JSON. Tested in Task 5 (`empty_and_noisy_outputs_parse`).
- **Import run twice, or the same cluster reachable from two profiles**: the same origin updates in place (no duplicate, same id), and a different origin creates a separate cluster. Tested in Task 6 (`reimport_updates_in_place_and_other_profile_adds`).
- **Window closed while `kind create` runs**: nothing is lost. `local_cluster_register` adopts the finished cluster, and a second completion for the same op is a no-op. Tested in Task 9 (`register_adopts_existing_and_completion_is_idempotent`).

---

## File Structure

**Core (Rust)**
- `crates/kubepit-core/src/tools.rs`: modify. Adds `run_with_env`, `EXTERNAL_TOOLS`, `tool_override`, `path_with_tool_dir`.
- `crates/kubepit-core/src/paths.rs`: modify. Adds `PrivateTempDir` and `Paths::private_temp_dir`.
- `crates/kubepit-core/src/types.rs`: modify. Adds `Settings.tool_paths`, `ClusterDef.origin`, `ClusterInput.origin` and two `TerminalSpec` variants.
- `crates/kubepit-core/src/app.rs`: modify. Normalizes `tool_paths` in `set_settings`, and adds the `cloud_discoveries` and `local_ops` fields.
- `crates/kubepit-core/src/cluster.rs`: modify. Copies `origin` in `cluster_add`, keeps it in `cluster_update`, and adds `register_managed`.
- `crates/kubepit-core/src/events.rs`: modify. Adds `EventSink::local_cluster_done`.
- `crates/kubepit-core/src/terminal.rs`: modify. Dispatches the two new specs.
- `crates/kubepit-core/src/cloud/mod.rs`: create. Module doc and re-exports.
- `crates/kubepit-core/src/cloud/types.rs`: create. `CloudProvider`, `ClusterOrigin`, accounts, scopes, clusters, events, import request/result, errors.
- `crates/kubepit-core/src/cloud/cli.rs`: create. `Cli`: resolve, env, run, classify.
- `crates/kubepit-core/src/cloud/errors.rs`: create. `classify`.
- `crates/kubepit-core/src/cloud/aws.rs`, `gcp.rs`, `azure.rs`: create. Pure argv builders and parsers.
- `crates/kubepit-core/src/cloud/regions.rs`: create. `EKS_REGIONS`.
- `crates/kubepit-core/src/cloud/accounts.rs`: create. `cloud_tools_status`, `cloud_accounts`.
- `crates/kubepit-core/src/cloud/discover.rs`: create. `cloud_discover`, `cloud_discover_cancel`.
- `crates/kubepit-core/src/cloud/import.rs`: create. `cloud_import`, exec checks, `prepare_cloud_login_terminal`.
- `crates/kubepit-core/src/local_clusters/mod.rs`: create. Types, validation, `local_clusters_list`, `local_cluster_plan`, `local_cluster_register`.
- `crates/kubepit-core/src/local_clusters/kind.rs`, `k3d.rs`, `minikube.rs`: create. Pure argv, config and parsers.
- `crates/kubepit-core/src/local_clusters/ops.rs`: create. `LocalClusterOps`, terminal binding, completion.
- `crates/kubepit-core/src/lib.rs`: modify. `pub mod cloud; pub mod local_clusters;` plus the module table rows.
- `crates/kubepit-core/tests/support/fake_cli.rs`: create. Generalised fake-CLI harness.
- `crates/kubepit-core/tests/cloud_import.rs`, `tests/local_clusters.rs`: create.

**Desktop shell**
- `apps/desktop/src-tauri/src/ipc/cloud.rs`: create. Cloud and local commands.
- `apps/desktop/src-tauri/src/ipc/mod.rs`: modify. Module plus `pub use`.
- `apps/desktop/src-tauri/src/lib.rs`: modify. Registers the commands in `generate_handler!` (51-216).
- `apps/desktop/src-tauri/src/app_state.rs`: modify. Adds `EVENT_LOCAL_CLUSTER_DONE` and the sink method.
- `apps/desktop/src-tauri/src/setup.rs`: modify. The exit hook (33-36) also completes local-cluster ops.

**Frontend**
- `apps/desktop/package.json`, `package.json`, `apps/desktop/vite.config.ts`, `scripts/check-i18n.mjs`: modify (Vitest harness, Task 1).
- `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts`: modify (contract).
- `apps/desktop/src/lib/cloud/model.ts` (+ `model.test.ts`): create. Pure hub helpers.
- `apps/desktop/src/lib/ipc/mock/cloudImport.ts`, `mock/localClusters.ts`: create. `mock/index.ts`: modify.
- `apps/desktop/src/store/useDockStore.ts`: modify. `LOCAL_DOCK_ID` and openers.
- `apps/desktop/src/store/types.ts:170-171`, `store/useAppStore.ts:446-447`: modify. Hub tab state.
- `apps/desktop/src/components/workbench/dock/ClusterDock.tsx`: modify. Adds the `local` prop.
- `apps/desktop/src/components/dashboard/Dashboard.tsx`: modify. Renders the Local dock.
- `apps/desktop/src/components/discover/AddClusterDialog.tsx`: create. The hub shell.
- `apps/desktop/src/components/discover/KubeconfigTab.tsx`: create (body moved from `DiscoverDialog.tsx`). `DiscoverDialog.tsx`: delete.
- `apps/desktop/src/components/discover/ImportOptions.tsx`: create. Section and tags footer shared by tabs.
- `apps/desktop/src/components/discover/cloud/{CloudTab,AccountPicker,DiscoveryResults}.tsx`, `cloud/useCloudDiscovery.ts`: create.
- `apps/desktop/src/components/discover/local/{LocalTab,CreateLocalClusterForm}.tsx`, `local/useLocalClusters.ts`: create.
- `apps/desktop/src/components/app/AppShell.tsx:56-61`: modify. Renders `AddClusterDialog`.
- `apps/desktop/src/components/settings/categories.tsx:352-410`: modify. Tool rows for the new tools.
- `apps/desktop/src/i18n/{en,tr}/shell.json`: modify.
- `docs/ARCHITECTURE.md`, `README.md`: modify.

---

### Task 1: Frontend unit-test harness (skip if present)

**Files:**
- Modify: `apps/desktop/package.json`, `package.json`, `apps/desktop/vite.config.ts`, `scripts/check-i18n.mjs:38-42`
- Test: `apps/desktop/src/lib/format.test.ts`

**Interfaces:**
- Produces: `pnpm test` runs `vitest run` in `apps/desktop` (environment `node`, include `src/**/*.test.ts`). The i18n checker ignores `*.test.ts(x)` files.

- [ ] **Step 1: Check whether the harness exists**

Run: `test -f apps/desktop/vitest.config.ts || grep -q '"test"' apps/desktop/package.json && echo present`
Expected: prints `present` → run Step 6 only, then commit nothing. Otherwise continue.

- [ ] **Step 2: Write the smoke test**

```ts
// apps/desktop/src/lib/format.test.ts
import { describe, expect, it } from 'vitest';
import { formatAge } from './format';

describe('formatAge', () => {
  it('prints kubectl-style ages', () => {
    const now = 1_700_000_000_000;
    expect(formatAge(now - 45_000, now)).toBe('45s');
    expect(formatAge(now - 3 * 3600_000, now)).toBe('3h');
    expect(formatAge(null, now)).toBe('—');
  });
});
```

- [ ] **Step 3: Add Vitest**

Add `"vitest": "^3.2.4"` to `apps/desktop` devDependencies and the script `"test": "vitest run"`. Add the root script `"test": "pnpm --filter @kubepit/desktop test"`. In `vite.config.ts`, add `/// <reference types="vitest/config" />` and `test: { environment: 'node', include: ['src/**/*.test.ts'] }`. In `scripts/check-i18n.mjs` `walk()`, skip names matching `/\.test\.tsx?$/`. Run `pnpm install`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test`
Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json package.json pnpm-lock.yaml apps/desktop/vite.config.ts scripts/check-i18n.mjs apps/desktop/src/lib/format.test.ts
git commit -m "test(ui): add a Vitest harness for pure frontend helpers"
```

- [ ] **Step 6: Verify the checks still pass**

Run: `pnpm typecheck && pnpm i18n:check && pnpm test`
Expected: all pass.

---

### Task 2: Tool overrides, env-aware runner, private temp dirs

**Files:**
- Modify: `crates/kubepit-core/src/tools.rs:93-151`, `crates/kubepit-core/src/paths.rs:148-209`, `crates/kubepit-core/src/types.rs:1034-1088`, `crates/kubepit-core/src/app.rs:169-201`
- Modify: `apps/desktop/src/types/index.ts:1209-1240`, `apps/desktop/src/lib/ipc/mock/app.ts:160-178`
- Test: unit tests in `tools.rs` and `paths.rs`

**Interfaces:**
- Produces:
  - `pub const EXTERNAL_TOOLS: [&str; 8] = ["aws","gcloud","az","gke-gcloud-auth-plugin","kubelogin","kind","k3d","minikube"]`
  - `pub fn tool_override<'a>(settings: &'a Settings, name: &str) -> Option<&'a str>`
  - `pub fn path_with_tool_dir(program: &Path) -> Option<std::ffi::OsString>` (the tool's dir prepended to the current `PATH`)
  - `pub async fn run_with_env(program: &Path, args: &[String], env: &[(String, String)], timeout: Duration) -> Result<CommandOutput>` (`run_with_stdin` delegates to the same private `run_full`)
  - `pub struct PrivateTempDir` with `path(&self) -> &Path` and `file(&self, name: &str) -> PathBuf`. It removes itself on `Drop`.
  - `impl Paths { pub fn private_temp_dir(&self, prefix: &str) -> Result<PrivateTempDir> }` creates `run/<prefix>-<uuid>` with mode 0700.
  - `Settings.tool_paths: BTreeMap<String, String>` (serde default). TS: `tool_paths: Record<string, string>`.

- [ ] **Step 1: Write the failing tests**

```rust
// tools.rs tests
#[cfg(unix)] #[tokio::test]
async fn run_with_env_passes_env_and_tool_dir_path() {
    let sh = PathBuf::from("/bin/sh");
    let out = run_with_env(&sh, &["-c".into(), "printf '%s' \"$KP_X\"".into()],
        &[("KP_X".into(), "yes".into())], PROBE_TIMEOUT).await.unwrap();
    assert_eq!(out.stdout, "yes");
    let dir = tempfile::tempdir().unwrap();
    let tool = dir.path().join("aws");
    let joined = path_with_tool_dir(&tool).unwrap();
    assert_eq!(std::env::split_paths(&joined).next().unwrap(), dir.path());
}
#[test]
fn tool_override_ignores_blank_and_unknown() {
    let mut s = Settings::default();
    s.tool_paths.insert("aws".into(), "/opt/aws".into());
    assert_eq!(tool_override(&s, "aws"), Some("/opt/aws"));
    assert_eq!(tool_override(&s, "gcloud"), None);
}
// paths.rs tests
#[cfg(unix)] #[test]
fn private_temp_dir_is_0700_and_removed_on_drop() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let paths = Paths::new(root.path());
    paths.ensure_dirs().unwrap();
    let dir = paths.private_temp_dir("import").unwrap();
    let p = dir.path().to_path_buf();
    assert!(p.starts_with(paths.run_dir()));
    assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o700);
    drop(dir);
    assert!(!p.exists());
}
// app.rs tests (or a new test in tests/cloud_import.rs later): set_settings drops blank and unknown keys
#[test]
fn set_settings_normalizes_tool_paths() { /* insert "aws" → " /x ", "evil" → "/y", "kind" → "  " ;
   assert saved.tool_paths == {"aws": "/x"} */ }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core tools:: paths:: set_settings_normalizes_tool_paths`
Expected: compile errors: `run_with_env`, `tool_override`, `private_temp_dir` and `tool_paths` are not defined.

- [ ] **Step 3: Implement**

`run_full(program, args, stdin, env, timeout)` holds today's `run_with_stdin` body plus `cmd.envs(env)`, and both public functions call it. In `set_settings`, trim the values, drop blank values, and drop keys not in `EXTERNAL_TOOLS`. Add `tool_paths: {}` to the TS `Settings` and to the mock default.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core tools:: paths:: set_settings_normalizes_tool_paths && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/{tools,paths,types,app}.rs apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc/mock/app.ts
git commit -m "feat(core): tool path overrides, env-aware runner and private temp dirs"
```

---

### Task 3: Cluster origin, idempotent managed registration, fake CLI harness

**Files:**
- Create: `crates/kubepit-core/src/cloud/mod.rs`, `crates/kubepit-core/src/cloud/types.rs`, `crates/kubepit-core/tests/support/fake_cli.rs`
- Modify: `crates/kubepit-core/src/types.rs:31-98`, `crates/kubepit-core/src/cluster.rs:100-246`, `crates/kubepit-core/src/lib.rs`, `apps/desktop/src/types/index.ts:53-106`, `apps/desktop/src/lib/ipc/mock/app.ts:345-380`
- Test: `crates/kubepit-core/tests/cloud_import.rs` (created here)

**Interfaces:**
- Produces:
  - `cloud::types::{CloudProvider, ClusterOrigin, LocalProvider}`:
    - `CloudProvider` is `Aws | Gcp | Azure`, serialized lowercase.
    - `LocalProvider` is `Kind | K3d | Minikube`, serialized lowercase.
    - `ClusterOrigin` is tagged kebab-case on `kind`:
      - `Eks { profile, region, name, arn: Option<String> }`
      - `Gke { configuration, project, location, name }`
      - `Aks { subscription, resource_group, name }`
      - `Local { provider: LocalProvider, name }`
  - `impl ClusterOrigin { pub fn key(&self) -> String }` returns `eks/<profile>/<region>/<name>`, `gke/<configuration>/<project>/<location>/<name>`, `aks/<subscription>/<resource_group>/<name>` or `local/<provider>/<name>` (the ARN is not part of the key).
  - `ClusterDef.origin: Option<ClusterOrigin>` and `ClusterInput.origin: Option<ClusterOrigin>`, both `#[serde(default)]`.
  - `impl Kubepit { pub fn cluster_import_kubeconfig(&self, input: ClusterInput) -> Result<(ClusterDef, bool)> }` requires `input.kubeconfig_text` and `input.origin` (`bail!` otherwise). When a cluster with the same `origin.key()` exists, it overwrites that cluster's managed kubeconfig via `store_managed(&existing.id, text)`, rewrites `run/<id>.kubeconfig` (unless transient), emits `cluster_list`, and returns `(existing, true)`; name, tags and environment stay as the user left them. Otherwise it calls `cluster_add` and returns `(new, false)`. This is the only registration entry point that cloud import and local clusters use.
  - `impl Kubepit { pub fn cluster_by_origin(&self, key: &str) -> Option<ClusterDef> }`
  - Test harness `FakeCli`:
    - `FakeCli::new(tools: &[&str]) -> FakeCli` writes one shared `#!/bin/sh` dispatcher per tool name (mode 0755).
    - `path(&self, tool) -> PathBuf`, `marker(&self, name, content)`, `calls(&self) -> Vec<String>` (lines `tool argv…`), `env_log(&self) -> Vec<String>` (lines `tool KUBECONFIG=… CLOUDSDK_ACTIVE_CONFIG_NAME=…`), `reply(&self, tool, args_prefix, stdout)` (a canned stdout file keyed by a sanitized argv prefix), `configure(&self, app: &Kubepit)` (sets `settings.tool_paths` for every tool).
    - The dispatcher **exits 97 with `refusing: KUBECONFIG outside run dir`** whenever it is asked to write credentials (`update-kubeconfig`, `get-credentials`, `kind create`, `minikube start`) and neither `--kubeconfig`/`--file` nor `KUBECONFIG` points inside the directory named by the `run-dir` marker.
    - A `kubeconfig` marker holds the YAML the fake writes to the target file (tests put `support::kubeconfig_for(server)` there with the context renamed).
- TS: `ClusterOrigin` union, `origin?: ClusterOrigin | null` on `ClusterDef` and `ClusterInput`.

- [ ] **Step 1: Write the failing tests**

```rust
// tests/cloud_import.rs
#[test]
fn origin_keys_are_stable() {
    let o = ClusterOrigin::Eks { profile: "dev".into(), region: "eu-west-1".into(), name: "web".into(), arn: Some("arn:x".into()) };
    assert_eq!(o.key(), "eks/dev/eu-west-1/web");
    assert_eq!(serde_json::to_value(&o).unwrap()["kind"], "eks");
}
#[tokio::test]
async fn register_managed_is_idempotent_by_origin_in_file_and_keychain_mode() {
    // for keychain in [false, true]: Kubepit::open_with_secrets(Paths::new(tmp), Recorder, MemorySecretStore)
    // (keychain: kubeconfig_storage_set(true)); cluster_import_kubeconfig(input(origin eks/dev/eu-west-1/web, text A))
    // → (a, false); cluster_import_kubeconfig(same origin, text B) → (b, true)
    assert_eq!(a.id, b.id);
    assert_eq!(app.cluster_list().len(), 1);
    // the stored kubeconfig now holds B: file mode reads kubeconfigs/<id>.yaml,
    // keychain mode reads MemorySecretStore key "kubeconfig/<id>" and no file exists
}
#[test]
fn cluster_update_keeps_the_backend_owned_origin() {
    // add with origin; cluster_update(def with origin = None) → returned def.origin is still Some(..)
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test cloud_import`
Expected: FAIL to compile (`ClusterOrigin`, `cluster_import_kubeconfig` and `origin` are missing).

- [ ] **Step 3: Implement the types, `cluster_import_kubeconfig`, `cluster_by_origin` and the `FakeCli` harness**

`cluster_add` copies `input.origin`, and `cluster_update` keeps `existing.origin`. The mock `cluster_add` copies `origin` too. `tests/support/mod.rs` declares `pub mod fake_cli;`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test cloud_import && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/{cloud,types.rs,cluster.rs,lib.rs} crates/kubepit-core/tests/{support/fake_cli.rs,cloud_import.rs} apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc/mock/app.ts
git commit -m "feat(core): cluster origin and idempotent managed registration"
```

---

### Task 4: CLI runner, error classification, tools status and accounts

**Files:**
- Create: `crates/kubepit-core/src/cloud/cli.rs`, `cloud/errors.rs`, `cloud/accounts.rs`, and the parser halves of `cloud/aws.rs`, `cloud/gcp.rs`, `cloud/azure.rs`
- Modify: `crates/kubepit-core/src/cloud/types.rs`
- Test: unit tests in `errors.rs`, `aws.rs`, `gcp.rs`, `azure.rs`; integration tests in `tests/cloud_import.rs`

**Interfaces:**
- Consumes: `tools::{find_executable, tool_override, path_with_tool_dir, run_with_env}` (Task 2), `FakeCli` (Task 3).
- Produces:
  - Types:
    - `CloudErrorKind` is `ToolMissing | LoginRequired | AccessDenied | NotFound | Timeout | Failed`, serialized kebab-case.
    - `CloudError { kind, detail: String }`
    - `CloudToolStatus { name, path: Option<String>, version: Option<String> }`
    - `CloudAccount { provider, id, label, detail: Option<String>, default_region: Option<String>, login_hint: Option<String>, is_default: bool }`
    - `CloudAccounts { accounts: Vec<CloudAccount>, error: Option<CloudError> }`
  - `pub fn classify(provider: CloudProvider, out: &CommandOutput) -> CloudError`:
    - **`LoginRequired`** when stderr matches, case-insensitively:
      - aws: `Token has expired`, `SSO session associated with this profile has expired`, `Unable to locate credentials`, `ExpiredToken`, `aws sso login`
      - gcp: `gcloud auth login`, `Reauthentication failed`, `do not currently have an active account`
      - azure: `az login`, `AADSTS`
    - **`AccessDenied`** on `AccessDenied`, `not authorized`, `PERMISSION_DENIED`, `AuthorizationFailed`.
    - **`NotFound`** on `ResourceNotFoundException`, `NOT_FOUND`, `ResourceNotFound`, `could not be found`.
    - **`Failed`** otherwise.
    - `detail` is stderr (or stdout when stderr is empty), trimmed and cut to 4096 bytes on a char boundary.
  - `pub(crate) struct Cli { program: PathBuf, provider: CloudProvider }` with `pub(crate) async fn run(&self, args: &[String], extra_env: &[(String, String)], timeout: Duration) -> Result<String, CloudError>`. It always sets `PATH` (via `path_with_tool_dir`), `AWS_PAGER=""`, `AWS_CLI_AUTO_PROMPT=off`, `CLOUDSDK_CORE_DISABLE_PROMPTS=1` and `AZURE_CORE_NO_COLOR=1`. A timeout maps to `CloudErrorKind::Timeout`.
  - `impl Kubepit { pub(crate) fn cli(&self, tool: &str, provider: CloudProvider) -> Result<Cli, CloudError> }` returns `ToolMissing` with `detail = tool` when unresolved.
  - `impl Kubepit { pub async fn cloud_tools_status(&self) -> Vec<CloudToolStatus> }` covers `EXTERNAL_TOOLS` in order. Each probe has a 5 s timeout. Versions come from:
    - `aws --version`: the first token, e.g. `aws-cli/2.17.0`
    - `gcloud version --format=json`: the `"Google Cloud SDK"` field
    - `az version --output json`: the `"azure-cli"` field
    - `kind version`: the second token
    - `k3d version`: the third token of the first line
    - `minikube version --short`: the trimmed output
    - the two plugins: no version.
  - `impl Kubepit { pub async fn cloud_accounts(&self, provider: CloudProvider) -> CloudAccounts }`:
    - aws: `configure list-profiles`, then per profile `configure get region --profile P` (a missing region is `None`, not an error); `id`/`label`/`login_hint` = profile; `is_default` = profile `default`.
    - gcp: `config configurations list --format=json`; `id`/`label` = name; `detail` = `"{account} · {project}"`; `login_hint` = account; `is_default` = `is_active`.
    - azure: `account list --output json --only-show-errors` (only `state == "Enabled"`); `id` = subscription id; `label` = name; `detail` and `login_hint` = tenantId; `is_default` = isDefault.
  - Parsers:
    - `aws::parse_profiles(&str) -> Vec<String>`
    - `gcp::parse_configurations(&str) -> Result<Vec<CloudAccount>>`
    - `azure::parse_accounts(&str) -> Result<Vec<CloudAccount>>`

- [ ] **Step 1: Write the failing tests**

```rust
// errors.rs
#[test] fn classifies_login_access_and_not_found() {
    let out = |e: &str| CommandOutput { success: false, code: Some(255), stdout: String::new(), stderr: e.into() };
    assert_eq!(classify(CloudProvider::Aws, &out("Error when retrieving token from sso: Token has expired and refresh failed")).kind, CloudErrorKind::LoginRequired);
    assert_eq!(classify(CloudProvider::Gcp, &out("ERROR: (gcloud.container.clusters.list) You do not currently have an active account selected.")).kind, CloudErrorKind::LoginRequired);
    assert_eq!(classify(CloudProvider::Azure, &out("ERROR: AADSTS700082: The refresh token has expired")).kind, CloudErrorKind::LoginRequired);
    assert_eq!(classify(CloudProvider::Aws, &out("An error occurred (AccessDeniedException) when calling the ListClusters operation")).kind, CloudErrorKind::AccessDenied);
    assert!(classify(CloudProvider::Aws, &out(&"x".repeat(10_000))).detail.len() <= 4096);
}
// tests/cloud_import.rs
#[tokio::test] async fn accounts_report_tool_missing_without_running_anything() {
    // fresh app, tool_paths["aws"] = "/no/such/aws" → cloud_accounts(Aws).error.kind == ToolMissing, accounts empty
}
#[tokio::test] async fn aws_accounts_list_profiles_with_default_regions() {
    // FakeCli aws: `configure list-profiles` → "default\nprod\n"; `configure get region --profile default` → "eu-west-1";
    // prod region → exit 1 empty. Assert ids ["default","prod"], default_region [Some("eu-west-1"), None], is_default [true,false]
}
#[tokio::test] async fn gcp_and_azure_accounts_parse() {
    // gcloud configurations json with {name:"work",is_active:true,properties:{core:{account:"a@x.io",project:"p1"}}}
    // az account list with one Enabled and one Disabled subscription → only the Enabled one, login_hint = tenantId
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core cloud:: --test cloud_import`
Expected: FAIL (the functions are not defined).

- [ ] **Step 3: Implement the runner, the classification, the parsers, `cloud_tools_status` and `cloud_accounts`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core cloud:: --test cloud_import`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/cloud crates/kubepit-core/tests/cloud_import.rs
git commit -m "feat(core): cloud CLI runner, error classification and account listing"
```

---

### Task 5: Streaming cloud discovery

**Files:**
- Create: `crates/kubepit-core/src/cloud/discover.rs`, `crates/kubepit-core/src/cloud/regions.rs`
- Modify: `cloud/aws.rs`, `cloud/gcp.rs`, `cloud/azure.rs`, `cloud/types.rs`, `crates/kubepit-core/src/app.rs:37-118` (field `cloud_discoveries: TaskRegistry`), `app.rs:213-231` (`shutdown` stops them)
- Test: parser unit tests; `tests/cloud_import.rs`

**Interfaces:**
- Consumes: `Cli`, `classify` (Task 4); `cluster_by_origin` (Task 3).
- Produces:
  - Types:
    - `CloudScope { provider, account, region: Option<String> }`
    - `CloudDiscoverRequest { provider, scopes: Vec<CloudScope> }`
    - `CloudCluster { provider, account, region: Option<String>, location, name, project: Option<String>, resource_group: Option<String>, endpoint: Option<String>, version: Option<String>, status: Option<String>, arn: Option<String>, aad: bool, registered_id: Option<String> }`
    - `CloudCluster::origin(&self) -> ClusterOrigin`. For gcp, `account` is the configuration.
    - `CloudDiscoveryEvent` is tagged kebab-case on `kind`, with variants `Scope { discovery_id, scope, clusters, error: Option<CloudError> }` and `Done { discovery_id }`.
  - `pub const EKS_REGIONS: &[&str]`: every commercial region with EKS, sorted, dated by a `// Updated 2026-09` comment.
  - `impl Kubepit { pub fn cloud_discover<F: Fn(CloudDiscoveryEvent) -> bool + Send + Sync + 'static>(&self, request: CloudDiscoverRequest, on_event: F) -> Result<String> }` validates every account and region against the name rule (`bail!` on invalid), snapshots the tool and the registered origins, spawns on `cloud_discoveries`, runs ≤ 4 scopes concurrently (`futures::stream::iter(..).buffer_unordered(4)`), sends one `Scope` per scope, then `Done`, and stops early when `on_event` returns `false`. It returns the discovery id (uuid).
  - `impl Kubepit { pub fn cloud_discover_cancel(&self, discovery_id: &str) -> bool }`
  - Per scope:
    - aws: `eks list-clusters --profile P --region R --output json`, then `eks describe-cluster --name N …` per cluster (sequential within the scope). A scope without `region` uses the profile's default region, else `bail!`.
    - gcp: `container clusters list --configuration C --project P --format=json`, with the project taken from the configuration. An account with no project reports `Failed` with detail `no project`.
    - azure: `aks list --subscription S --output json --only-show-errors`.
  - Parsers:
    - `aws::parse_list_clusters(&str) -> Result<Vec<String>>`
    - `aws::parse_describe(&str, profile, region) -> Result<CloudCluster>` (fields `cluster.endpoint|version|status|arn`)
    - `gcp::parse_clusters(&str, configuration, project) -> Result<Vec<CloudCluster>>` (fields `name`, `location`, `endpoint`, `currentMasterVersion`, `status`)
    - `azure::parse_clusters(&str, subscription) -> Result<Vec<CloudCluster>>` (fields `name`, `resourceGroup`, `location`, `fqdn` or `privateFqdn`, `kubernetesVersion`, `powerState.code`; `aad` = `aadProfile` present and non-null)
    - In all of them, empty or whitespace stdout means `Ok(vec![])`.

- [ ] **Step 1: Write the failing tests**

```rust
// aws.rs / gcp.rs / azure.rs unit tests
#[test] fn empty_and_noisy_outputs_parse() {
    assert_eq!(aws::parse_list_clusters("").unwrap(), Vec::<String>::new());
    assert_eq!(aws::parse_list_clusters("{\"clusters\":[\"a\",\"b\"]}\n").unwrap(), vec!["a", "b"]);
    assert!(gcp::parse_clusters("[]", "work", "p1").unwrap().is_empty());
    assert!(azure::parse_clusters("not json", "s").is_err());
    let aks = azure::parse_clusters(r#"[{"name":"c","resourceGroup":"rg","location":"westeurope","fqdn":"c.hcp.io","kubernetesVersion":"1.30.3","powerState":{"code":"Running"},"aadProfile":{"managed":true}}]"#, "sub").unwrap();
    assert!(aks[0].aad);
    assert_eq!(aks[0].origin().key(), "aks/sub/rg/c");
}
// tests/cloud_import.rs
#[tokio::test] async fn one_expired_scope_does_not_block_the_others() {
    // FakeCli aws: region eu-west-1 → list ["web"], describe → endpoint/version/arn; region us-east-1 → exit 255
    // stderr "Token has expired". cloud_discover(Aws, [dev/eu-west-1, dev/us-east-1]) collecting events until Done.
    // Assert: 2 Scope events + 1 Done; eu-west-1 has 1 cluster with version "1.30", us-east-1 error.kind == LoginRequired
}
#[tokio::test] async fn discovery_marks_registered_clusters() {
    // register a cluster with origin eks/dev/eu-west-1/web first → discovered web.registered_id == Some(id)
}
#[tokio::test] async fn invalid_scope_names_are_refused_before_spawning() {
    // account "dev; rm -rf /" → cloud_discover returns Err, FakeCli.calls() is empty
}
#[tokio::test] async fn cancel_stops_a_running_discovery() {
    // FakeCli marker "sleep" makes list-clusters sleep 5s; start, cancel → returns true; no Done within 500ms
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core cloud:: --test cloud_import`
Expected: FAIL.

- [ ] **Step 3: Implement the parsers, `EKS_REGIONS`, `cloud_discover` and `cloud_discover_cancel`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core cloud:: --test cloud_import`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/cloud crates/kubepit-core/src/app.rs crates/kubepit-core/tests/cloud_import.rs
git commit -m "feat(core): stream EKS, GKE and AKS discovery per scope"
```

---

### Task 6: Cloud import into managed kubeconfigs

**Files:**
- Create: `crates/kubepit-core/src/cloud/import.rs`
- Modify: `cloud/aws.rs`, `cloud/gcp.rs`, `cloud/azure.rs` (credential argv builders), `cloud/types.rs`
- Test: `tests/cloud_import.rs`

**Interfaces:**
- Consumes: `Paths::private_temp_dir` (Task 2); `cluster_import_kubeconfig` (Task 3); `Cli` (Task 4); `CloudCluster` (Task 5); `kubeconfig::{load, single_context, to_yaml}`.
- Produces:
  - Types:
    - `CloudImportRequest { cluster: CloudCluster, name: String, environment: Option<ClusterEnvironment>, tags: Vec<String> }`
    - `ImportWarningCode` is `ExecPluginMissing | KubeloginMissing`, serialized kebab-case.
    - `ImportWarning { code, detail }`
    - `CloudImportResult { cluster: Option<ClusterDef>, updated: bool, warnings: Vec<ImportWarning>, error: Option<CloudError> }`
  - Argv builders (target file `F` is always explicit):
    - `aws::update_kubeconfig_args(profile, region, name, file: &Path) -> Vec<String>` gives `eks update-kubeconfig --name N --region R --profile P --kubeconfig F`. Env adds `KUBECONFIG=F`.
    - `gcp::credentials_args(configuration, project, location, name) -> Vec<String>` gives `container clusters get-credentials N --location L --project P --configuration C`. Env adds `KUBECONFIG=F` and `USE_GKE_GCLOUD_AUTH_PLUGIN=True`.
    - `azure::credentials_args(subscription, rg, name, file) -> Vec<String>` gives `aks get-credentials --subscription S --resource-group RG --name N --file F --overwrite-existing --only-show-errors`. Env adds `KUBECONFIG=F`.
    - `azure::kubelogin_convert_args(file) -> Vec<String>` gives `convert-kubeconfig -l azurecli --kubeconfig F`.
  - `pub(crate) fn check_exec(kc: &mut Kubeconfig, context: &str, settings: &Settings) -> Vec<ImportWarning>`: for the context's user `exec.command`, when it is not found on `PATH` it uses the `tool_overrides` absolute path when one exists, else warns `ExecPluginMissing` (detail = command).
  - `pub(crate) fn pin_gcloud_configuration(kc: &mut Kubeconfig, context: &str, configuration: &str)` sets or replaces the exec env entry `CLOUDSDK_ACTIVE_CONFIG_NAME`.
  - `impl Kubepit { pub async fn cloud_import(&self, requests: Vec<CloudImportRequest>) -> Vec<CloudImportResult> }` processes requests sequentially:
    1. Create `private_temp_dir("import")` and run the CLI against `F = dir.file("kubeconfig")`.
    2. For aad AKS clusters, run `kubelogin` (if it is missing, warn `KubeloginMissing` and keep going).
    3. `load(F)`, then take its `current_context`, then `single_context`.
    4. Pin (gcp), then `check_exec`.
    5. `cluster_import_kubeconfig(ClusterInput { name, context, kubeconfig_text: Some(to_yaml(single)), tags, environment, origin: Some(cluster.origin()), .. })`.
    6. Drop the temp dir.

    One failing request never aborts the others; its `error` is set.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test] async fn import_writes_only_private_targets_and_cleans_up() {
    // FakeCli aws with markers run-dir = app.paths().run_dir() and kubeconfig = support::kubeconfig_for(fake.url) with the
    // context renamed to "arn:aws:eks:eu-west-1:1:cluster/web" (token auth, so connect works without an exec plugin;
    // the exec-plugin tests below use exec users and never connect).
    let results = app.cloud_import(vec![req_eks("dev", "eu-west-1", "web")]).await;
    assert!(results[0].error.is_none());
    let call = fake.calls().into_iter().find(|c| c.contains("update-kubeconfig")).unwrap();
    assert!(call.contains(&format!("--kubeconfig {}", app.paths().run_dir().display())));
    assert!(fake.env_log().iter().any(|l| l.contains(&format!("KUBECONFIG={}", app.paths().run_dir().display()))));
    // no leftovers
    assert!(std::fs::read_dir(app.paths().run_dir()).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with("import-")));
    // registered, managed, origin set, connects to the fake API server
    let c = results[0].cluster.clone().unwrap();
    assert!(c.managed);
    assert_eq!(c.origin.unwrap().key(), "eks/dev/eu-west-1/web");
    app.cluster_connect(&c.id).await.unwrap();
}
#[tokio::test] async fn fake_cli_refuses_a_default_kubeconfig() {
    // FakeCli marker run-dir points at a different temp dir → the CLI exits 97 → result.error.kind == Failed,
    // detail contains "refusing"; proves the fake guard works (sanity test for the harness itself)
}
#[tokio::test] async fn reimport_updates_in_place_and_other_profile_adds() {
    // import dev/eu-west-1/web twice → second result.updated == true, same id, cluster_list().len() == 1;
    // import prod/eu-west-1/web → a second cluster
}
#[tokio::test] async fn missing_exec_plugin_warns_and_override_is_absolutized() {
    // fake kubeconfig exec.command "gke-gcloud-auth-plugin"; tool_paths has no such key → warning ExecPluginMissing;
    // then set tool_paths["gke-gcloud-auth-plugin"] = fake path, reimport → no warning and the managed kubeconfig's
    // exec.command == that absolute path; the exec env contains CLOUDSDK_ACTIVE_CONFIG_NAME=work
}
#[tokio::test] async fn aad_aks_runs_kubelogin_convert_on_the_private_file() {
    // aad cluster: calls() contains "kubelogin convert-kubeconfig -l azurecli --kubeconfig <run dir>/import-…/kubeconfig";
    // without the kubelogin tool configured → warning KubeloginMissing, import still succeeds
}
#[tokio::test] async fn keychain_mode_import_writes_no_kubeconfig_file() {
    // open_with_secrets(MemorySecretStore) + kubeconfig_storage_set(true); import → no kubeconfigs/<id>.yaml,
    // MemorySecretStore has "kubeconfig/<id>"
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test cloud_import import_ reimport_ missing_exec aad_aks keychain_mode fake_cli_refuses`
Expected: FAIL.

- [ ] **Step 3: Implement the argv builders, `check_exec`, `pin_gcloud_configuration` and `cloud_import`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test cloud_import`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/cloud crates/kubepit-core/tests/cloud_import.rs
git commit -m "feat(core): import cloud clusters into managed kubeconfigs"
```

---

### Task 7: Cloud login terminal

**Files:**
- Modify: `crates/kubepit-core/src/types.rs:970-1007` (`TerminalSpec::CloudLogin`), `crates/kubepit-core/src/terminal.rs:112-235`, `crates/kubepit-core/src/cloud/import.rs` (or `cloud/login.rs`), `apps/desktop/src/types/index.ts:1157-1184`
- Test: unit tests in `terminal.rs`

**Interfaces:**
- Consumes: `Cli` resolution (Task 4).
- Produces:
  - `TerminalSpec::CloudLogin { provider: CloudProvider, #[serde(default)] account: Option<String> }`. TS: `{ kind: 'cloud-login'; provider: CloudProvider; account: string | null }`.
  - `impl Kubepit { pub(crate) fn prepare_cloud_login_terminal(&self, provider: CloudProvider, account: Option<&str>) -> Result<TerminalLaunch> }` returns `LaunchProgram::Exec`. The argv is:
    - aws `sso login --profile <account>` (account required)
    - gcp `auth login [<account>]`
    - azure `login [--tenant <account>]`

    `env` is `PATH` with the tool dir, and `cwd` is the home dir. An account that fails the name rule is `bail!`ed.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test] async fn cloud_login_builds_fixed_argv() {
    let (_d, app, _c) = crate::cluster::tests_support::app_with_cluster(false);
    // tool_paths aws/gcloud/az → tempdir fakes
    let l = app.prepare_terminal("t1", &TerminalSpec::CloudLogin { provider: CloudProvider::Aws, account: Some("dev".into()) }, &|_| true).await.unwrap();
    assert!(matches!(l.program, LaunchProgram::Exec { ref args, .. } if args == &["sso", "login", "--profile", "dev"]));
    assert!(app.prepare_terminal("t2", &TerminalSpec::CloudLogin { provider: CloudProvider::Aws, account: None }, &|_| true).await.is_err());
    assert!(app.prepare_terminal("t3", &TerminalSpec::CloudLogin { provider: CloudProvider::Gcp, account: Some("a b;c".into()) }, &|_| true).await.is_err());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kubepit-core cloud_login_builds_fixed_argv`
Expected: FAIL.

- [ ] **Step 3: Implement the variant, the dispatch and `prepare_cloud_login_terminal`; add the TS union member**

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p kubepit-core cloud_login_builds_fixed_argv && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src apps/desktop/src/types/index.ts
git commit -m "feat(core): cloud login terminals with backend-built argv"
```

---

### Task 8: Local clusters: listing, validation and plans

**Files:**
- Create: `crates/kubepit-core/src/local_clusters/mod.rs`, `local_clusters/kind.rs`, `local_clusters/k3d.rs`, `local_clusters/minikube.rs`, `local_clusters/ops.rs` (the op store only)
- Modify: `crates/kubepit-core/src/app.rs` (field `local_ops: LocalClusterOps`), `crates/kubepit-core/src/lib.rs`
- Test: unit tests per provider file; `crates/kubepit-core/tests/local_clusters.rs`

**Interfaces:**
- Consumes: `FakeCli` (Task 3), `Cli` resolution (Task 4), `cluster_by_origin` (Task 3), `ensure_writable`.
- Produces (types in `local_clusters/mod.rs`, serde as noted):
  - Enums:
    - `LocalClusterAction` is `Create | Delete | Start | Stop` (lowercase).
    - `LocalClusterState` is `Running | Stopped | Unknown` (lowercase).
    - `PortProtocol` is `Tcp | Udp` (lowercase, default `Tcp`).
  - Structs:
    - `PortMapping { host: u16, container: u16, protocol: PortProtocol }`
    - `RegistryOption { port: u16 }`
    - `LocalClusterOptions { kubernetes_version: Option<String>, nodes: u32, ports: Vec<PortMapping>, registry: Option<RegistryOption> }`
    - `LocalClusterRequest { provider: LocalProvider, action, name, options: Option<LocalClusterOptions> }`
    - `LocalCluster { provider, name, state, nodes: Option<u32>, version: Option<String>, registered_id: Option<String> }`
    - `LocalProviderStatus { provider, tool: ToolInfo, error: Option<String> }`
    - `LocalClustersState { providers: Vec<LocalProviderStatus>, clusters: Vec<LocalCluster> }`
    - `LocalClusterPlan { op_id, provider, action, name, command: Vec<String> }`. `command[0]` is the tool name, followed by the args (display only).
  - `pub fn validate_request(req: &LocalClusterRequest) -> Result<()>`. Messages start with a stable code:
    - `invalid-name:`
    - `invalid-nodes:`
    - `invalid-port:`
    - `duplicate-host-port:`
    - `invalid-version:`
    - `registry-unsupported:` (kind)
    - `unsupported-action:` (kind start/stop)
    - `udp-unsupported:` (minikube)
    - `invalid-registry-port:` (minikube port ≠ 5000)
    - `options-required:` (create without options)
  - kind:
    - `kind::config_yaml(opts) -> String`: `kind: Cluster`, `apiVersion: kind.x-k8s.io/v1alpha4`, one `control-plane` node carrying `extraPortMappings`, plus `nodes-1` `worker`s.
    - `kind::create_args(name, opts, config: &Path, kubeconfig: &Path) -> Vec<String>`: `create cluster --name N --config C --kubeconfig K --wait 120s [--image kindest/node:vX.Y.Z]`.
    - `kind::delete_args(name, kubeconfig)`, `kind::list_args()`, `kind::parse_list(&str) -> Vec<String>` (ignores `No kind clusters found.`).
  - k3d:
    - `k3d::create_args(name, opts) -> Vec<String>`: `cluster create N --servers 1 --agents <nodes-1> --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait [--image rancher/k3s:vX.Y.Z-k3s1] [-p H:C/proto@loadbalancer]… [--registry-create N-registry:0.0.0.0:PORT]`.
    - `k3d::start_args`, `k3d::stop_args`, `k3d::delete_args`, `k3d::kubeconfig_args(name)` (`kubeconfig get N`).
    - `k3d::parse_list(&str) -> Result<Vec<LocalCluster>>` (from `name`, `serversCount`, `serversRunning`, `agentsCount`, `agentsRunning`).
  - minikube:
    - `minikube::create_args(name, opts) -> Vec<String>`: `start -p N --nodes <n> [--kubernetes-version vX.Y.Z] [--ports H:C]… [--addons registry]`.
    - `start_args`, `stop_args`, `delete_args`.
    - `minikube::parse_list(&str) -> Result<Vec<LocalCluster>>` (from `valid[].Name`, `.Status`, `.Config.Nodes.len()`, `.Config.KubernetesConfig.KubernetesVersion`; a non-JSON or empty output means none).
  - `pub fn context_name(provider, name) -> String` returns `kind-N`, `k3d-N` or `N`.
  - `impl Kubepit { pub async fn local_clusters_list(&self) -> LocalClustersState }`: an unresolved tool gives `tool.path = None` and no clusters; a failing list sets `error` (stderr, 4096 bytes); `registered_id` comes from `cluster_by_origin("local/<p>/<n>")`.
  - `impl Kubepit { pub fn local_cluster_plan(&self, req: LocalClusterRequest) -> Result<LocalClusterPlan> }`:
    - Runs validation first, then `ensure_writable` on the registered cluster for `Delete`/`Stop`.
    - Creates a `private_temp_dir("local")` holding `kubeconfig` (and kind's `config.yaml`).
    - Stores a `PendingOp` in `local_ops` keyed by a uuid; ops not bound to a terminal within 10 minutes are dropped on the next insert.
    - The env carries `KUBECONFIG=<dir>/kubeconfig` for minikube and kind.
  - `pub(crate) struct LocalClusterOps` with `insert(op) -> String`, `bind(terminal_id, op_id) -> Result<PendingOp>` and `take_by_terminal(terminal_id) -> Option<PendingOp>`.

- [ ] **Step 1: Write the failing tests**

```rust
// kind.rs
#[test] fn kind_config_has_workers_and_port_mappings() {
    let y = config_yaml(&opts(3, &[(8080, 80, Tcp)]));
    let v: serde_yaml::Value = serde_yaml::from_str(&y).unwrap();
    assert_eq!(v["nodes"].as_sequence().unwrap().len(), 3);
    assert_eq!(v["nodes"][0]["role"], "control-plane");
    assert_eq!(v["nodes"][0]["extraPortMappings"][0]["hostPort"], 8080);
}
// k3d.rs
#[test] fn k3d_create_args() {
    let a = create_args("dev", &opts_v(Some("v1.31.2"), 2, &[(8080, 80, Tcp)], Some(5001)));
    assert!(a.windows(2).any(|w| w == ["--agents", "1"]));
    assert!(a.contains(&"--kubeconfig-update-default=false".to_string()));
    assert!(a.windows(2).any(|w| w == ["--image", "rancher/k3s:v1.31.2-k3s1"]));
    assert!(a.windows(2).any(|w| w == ["-p", "8080:80/tcp@loadbalancer"]));
    assert!(a.windows(2).any(|w| w == ["--registry-create", "dev-registry:0.0.0.0:5001"]));
}
// mod.rs
#[test] fn validation_codes() {
    assert!(validate_request(&req(Kind, Create, "Dev_1", Some(opts(1, &[]))) ).unwrap_err().to_string().starts_with("invalid-name:"));
    assert!(validate_request(&req(Kind, Start, "dev", None)).unwrap_err().to_string().starts_with("unsupported-action:"));
    assert!(validate_request(&req(Kind, Create, "dev", Some(with_registry(5000)))).unwrap_err().to_string().starts_with("registry-unsupported:"));
    assert!(validate_request(&req(K3d, Create, "dev", Some(opts(11, &[])))).unwrap_err().to_string().starts_with("invalid-nodes:"));
    assert!(validate_request(&req(K3d, Create, "dev", Some(opts(1, &[(80, 80, Tcp), (80, 81, Tcp)])))).unwrap_err().to_string().starts_with("duplicate-host-port:"));
    assert!(validate_request(&req(Minikube, Create, "dev", Some(opts(1, &[(53, 53, Udp)])))).unwrap_err().to_string().starts_with("udp-unsupported:"));
}
// tests/local_clusters.rs
#[tokio::test] async fn list_merges_providers_and_marks_registered() {
    // FakeCli kind: "get clusters" → "dev\n"; k3d: "cluster list -o json" → [{"name":"k","serversCount":1,"serversRunning":0,"agentsCount":1,"agentsRunning":0}];
    // minikube missing (tool_paths["minikube"] = "/no/such") → providers[2].tool.path == None
    // k's state == Stopped, nodes == Some(2)
}
#[tokio::test] async fn read_only_registered_cluster_refuses_delete_plan() {
    // register origin local/kind/dev with read_only = true (cluster_update) → local_cluster_plan(Delete) is Err and
    // kubepit_core::error::is_read_only(&err); FakeCli.calls() is empty
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core local_clusters:: --test local_clusters`
Expected: FAIL.

- [ ] **Step 3: Implement the types, the builders, the parsers, validation, `local_clusters_list`, `local_cluster_plan` and the op store**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core local_clusters:: --test local_clusters`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/local_clusters crates/kubepit-core/src/{app,lib}.rs crates/kubepit-core/tests/local_clusters.rs
git commit -m "feat(core): list kind, k3d and minikube clusters and plan operations"
```

---

### Task 9: Local-cluster terminals, completion and adoption

**Files:**
- Modify: `crates/kubepit-core/src/local_clusters/ops.rs`, `local_clusters/mod.rs`, `crates/kubepit-core/src/types.rs:970-1007` (`TerminalSpec::LocalCluster`), `crates/kubepit-core/src/terminal.rs:112-235`, `crates/kubepit-core/src/events.rs:11-27`, `crates/kubepit-core/tests/support/mod.rs:176-187` (`Recorder` gains `local_done: Mutex<Vec<LocalClusterDone>>` and `local_done()`), `apps/desktop/src/types/index.ts:1157-1184`
- Test: `crates/kubepit-core/tests/local_clusters.rs`

**Interfaces:**
- Consumes: `LocalClusterOps`, `PendingOp` (Task 8); `cluster_import_kubeconfig` (Task 3).
- Produces:
  - `TerminalSpec::LocalCluster { op_id: String }`. TS: `{ kind: 'local-cluster'; op_id: string }`.
  - `pub struct LocalClusterDone { op_id, provider, action, name, ok: bool, cluster: Option<ClusterDef>, error: Option<String> }`
  - `EventSink::local_cluster_done(&self, _done: &LocalClusterDone) {}` (default no-op).
  - `impl Kubepit { pub(crate) fn prepare_local_cluster_terminal(&self, terminal_id: &str, op_id: &str) -> Result<TerminalLaunch> }` binds the op and returns `LaunchProgram::Exec { program, args }`, the op's env and `cwd` = the op's temp dir. An unknown or expired op is `bail!("unknown-op: …")`.
  - `impl Kubepit { pub async fn local_cluster_terminal_exited(&self, terminal_id: &str, code: Option<i32>) -> Option<LocalClusterDone> }` returns `None` when the terminal has no op; the op is taken, so a second call returns `None`. It emits via `sink.local_cluster_done`.
    - `Create` / `Start` with `code == Some(0)`: read the kubeconfig (kind and minikube from `<dir>/kubeconfig`, k3d from `k3d kubeconfig get N` with a 120 s timeout), take `single_context(context_name)`, then register with `environment: Local`, `tags: [provider]`, `name` = the cluster name and `origin: Local`.
    - `Delete` with `code == Some(0)`: `cluster_remove` of the registered cluster, if any.
    - `Stop`: no registry change.
    - A non-zero or missing code gives `ok: false`, `error: "exit code N"`.
  - `impl Kubepit { pub async fn local_cluster_register(&self, provider: LocalProvider, name: &str) -> Result<ClusterDef> }` fetches the kubeconfig on stdout (kind `get kubeconfig --name N`, k3d `kubeconfig get N`) and registers it idempotently. minikube has no stdout export, so it is refused with `bail!("unsupported-action: …")`; the UI adopts a minikube cluster by running a `Start` op, whose completion registers it (`minikube start` on a running profile only rewrites its kubeconfig).

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test] async fn create_completion_registers_the_cluster() {
    // FakeCli kind with markers run-dir and kubeconfig (context "kind-dev" → fake API server).
    let plan = app.local_cluster_plan(create_req(Kind, "dev", 1)).unwrap();
    let launch = app.prepare_terminal("term-1", &TerminalSpec::LocalCluster { op_id: plan.op_id.clone() }, &|_| true).await.unwrap();
    // simulate the PTY: run the planned program ourselves so the fake writes the kubeconfig
    run_launch(&launch).await; // test helper: tools::run_with_env(program, args, env, 30s)
    let done = app.local_cluster_terminal_exited("term-1", Some(0)).await.unwrap();
    assert!(done.ok);
    let c = done.cluster.unwrap();
    assert_eq!(c.context, "kind-dev");
    assert_eq!(c.environment, Some(ClusterEnvironment::Local));
    assert_eq!(c.origin.unwrap().key(), "local/kind/dev");
    assert!(recorder.local_done().len() == 1);
}
#[tokio::test] async fn failed_exit_reports_and_registers_nothing() { /* code Some(1) → ok false, error "exit code 1", no cluster */ }
#[tokio::test] async fn delete_completion_removes_the_registered_cluster() { /* adopt dev, plan Delete, exit 0 → cluster_list() empty */ }
#[tokio::test] async fn register_adopts_existing_and_completion_is_idempotent() {
    // local_cluster_register(Kind, "dev") → registered; again → same id; local_cluster_terminal_exited on an
    // unknown terminal → None; exited twice for the same terminal → second None
}
#[tokio::test] async fn unknown_op_is_refused() { /* prepare_terminal(LocalCluster{op_id:"nope"}) → Err containing "unknown-op" */ }
#[tokio::test] async fn minikube_start_completion_registers_from_the_private_kubeconfig() {
    // FakeCli minikube "start -p mk" writes the kubeconfig marker (context "mk") to $KUBECONFIG; plan Start, run, exit 0
    // → cluster registered with context "mk"; local_cluster_register(Minikube, "mk") → Err starting with "unsupported-action"
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test local_clusters`
Expected: FAIL.

- [ ] **Step 3: Implement the variant, the dispatch, completion, `local_cluster_register` and the sink method; add the TS union member**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test local_clusters && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src crates/kubepit-core/tests/local_clusters.rs apps/desktop/src/types/index.ts
git commit -m "feat(core): run local cluster operations in terminals and register the result"
```

---

### Task 10: Desktop IPC commands, event and exit hook

**Files:**
- Create: `apps/desktop/src-tauri/src/ipc/cloud.rs`
- Modify: `apps/desktop/src-tauri/src/ipc/mod.rs:13-82`, `apps/desktop/src-tauri/src/lib.rs:51-216`, `apps/desktop/src-tauri/src/app_state.rs:14-75`, `apps/desktop/src-tauri/src/setup.rs:33-36`
- Test: `cargo clippy --workspace --all-targets -- -D warnings` (the shell has no unit tests; behaviour is covered in core)

**Interfaces:**
- Consumes: every `pub` core function from Tasks 4–9.
- Produces these Tauri commands (Rust param names snake_case, JS camelCase):
  - `cloud_tools_status() -> Vec<CloudToolStatus>`
  - `cloud_accounts(provider) -> CloudAccounts`
  - `cloud_discover(request, on_event: Channel<CloudDiscoveryEvent>) -> String`
  - `cloud_discover_cancel(discovery_id) -> bool`
  - `cloud_import(requests) -> Vec<CloudImportResult>`
  - `local_clusters_list() -> LocalClustersState`
  - `local_cluster_plan(request) -> LocalClusterPlan`
  - `local_cluster_register(provider, name) -> ClusterDef`

  It also adds `pub const EVENT_LOCAL_CLUSTER_DONE: &str = "localcluster://done"` and `TauriEventSink::local_cluster_done`. The exit hook in `setup.rs` captures `core.clone()` and, after emitting `terminal://exit`, calls `tauri::async_runtime::spawn(async move { core.local_cluster_terminal_exited(&id, code).await; })`.

- [ ] **Step 1: Add the commands, following `ipc/fleet.rs:32-48` for the channel command and `ipc/clusters.rs:44-51` for the others; register them in `generate_handler!`**

- [ ] **Step 2: Wire the sink and the exit hook**

- [ ] **Step 3: Verify the build**

Run: `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: all pass, no warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "feat(desktop): cloud import and local cluster IPC commands"
```

---

### Task 11: TS contract, pure hub helpers and demo backend

**Files:**
- Modify: `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts:142-156,607-629`, `apps/desktop/src/lib/ipc/mock/index.ts:2-34`
- Create: `apps/desktop/src/lib/cloud/model.ts`, `apps/desktop/src/lib/cloud/model.test.ts`, `apps/desktop/src/lib/ipc/mock/cloudImport.ts`, `apps/desktop/src/lib/ipc/mock/localClusters.ts`

**Interfaces:**
- Consumes: the Rust types from Tasks 3–9 (mirror them field for field).
- Produces:
  - `ipc.cloudToolsStatus()`
  - `ipc.cloudAccounts(provider)`
  - `ipc.cloudDiscover(request, onEvent)`, a `callWithChannel<string, CloudDiscoveryEvent>(..., 'onEvent', ...)`
  - `ipc.cloudDiscoverCancel(discoveryId)`
  - `ipc.cloudImport(requests)`
  - `ipc.localClustersList()`
  - `ipc.localClusterPlan(request)`
  - `ipc.localClusterRegister(provider, name)`
  - `events.onLocalClusterDone(handler)` (`'localcluster://done'`)
  - `lib/cloud/model.ts`:
    - `originKey(o: ClusterOrigin): string` (same strings as Rust `key()`)
    - `cloudClusterOrigin(c: CloudCluster): ClusterOrigin`
    - `groupDiscovery(events: CloudDiscoveryEvent[]): ScopeGroup[]`, where `ScopeGroup = { scope: CloudScope; state: 'running' | 'done' | 'error'; clusters: CloudCluster[]; error: CloudError | null }` in request order
    - `scopeKey(s: CloudScope): string`
    - `localProblems(req: LocalClusterRequest): LocalProblemCode[]`, which mirrors `validate_request` codes (`'invalid-name' | 'invalid-nodes' | 'invalid-port' | 'duplicate-host-port' | 'invalid-version' | 'registry-unsupported' | 'unsupported-action' | 'udp-unsupported' | 'invalid-registry-port' | 'options-required'`)
    - `guessProviderEnvironment(name: string): ClusterEnvironment | null` (wraps `guessEnvironment`)
- Demo:
  - `mock/cloudImport.ts`:
    - `cloud_tools_status` reports everything installed except `kubelogin`.
    - `cloud_accounts` returns two aws profiles, `work`/`personal` gcloud configurations and two subscriptions.
    - `cloud_discover` streams with `sleep(300–900)`; aws `prod/us-east-1` returns `login-required`.
    - `cloud_import` adds demo clusters with `origin` via the same path as `cluster_add` and emits `cluster://list`.
  - `mock/localClusters.ts`:
    - Keeps an in-memory kind `dev` and k3d `lab`.
    - `local_cluster_plan` validates with `localProblems`.
    - Wraps `terminal_create` for `local-cluster` and `cloud-login` specs, playing canned output, then `mockEmit('terminal://exit', …)` and `mockEmit('localcluster://done', …)`, following the pattern of `mock/customActions.ts:349-375`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/cloud/model.test.ts
import { describe, expect, it } from 'vitest';
import { groupDiscovery, localProblems, originKey } from './model';

describe('cloud model', () => {
  it('keys origins like the backend', () => {
    expect(originKey({ kind: 'aks', subscription: 's', resource_group: 'rg', name: 'c' })).toBe('aks/s/rg/c');
    expect(originKey({ kind: 'local', provider: 'kind', name: 'dev' })).toBe('local/kind/dev');
  });
  it('groups scope events and keeps errors per scope', () => {
    const scope = (region: string) => ({ provider: 'aws' as const, account: 'dev', region });
    const groups = groupDiscovery([
      { kind: 'scope', discovery_id: 'd', scope: scope('us-east-1'), clusters: [], error: { kind: 'login-required', detail: 'x' } },
      { kind: 'scope', discovery_id: 'd', scope: scope('eu-west-1'), clusters: [], error: null },
      { kind: 'done', discovery_id: 'd' },
    ]);
    expect(groups.map((g) => g.state)).toEqual(['error', 'done']);
  });
  it('mirrors backend validation codes', () => {
    expect(localProblems({ provider: 'kind', action: 'start', name: 'dev', options: null })).toContain('unsupported-action');
    expect(localProblems({ provider: 'k3d', action: 'create', name: 'Dev', options: { kubernetes_version: null, nodes: 1, ports: [], registry: null } })).toContain('invalid-name');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kubepit/desktop exec vitest run src/lib/cloud`
Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement the contract additions, `model.ts` and both mock files; register the mocks in `mock/index.ts` after `./customActions`**

- [ ] **Step 4: Run the tests and the checks**

Run: `pnpm test && pnpm typecheck && pnpm i18n:check`
Expected: PASS. `pnpm dev:ui` starts and the console shows no errors on load.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc.ts apps/desktop/src/lib/cloud apps/desktop/src/lib/ipc/mock
git commit -m "feat(ui): cloud import and local cluster contract and demo backend"
```

---

### Task 12: Local dock on the Dashboard

**Files:**
- Modify: `apps/desktop/src/store/useDockStore.ts:19-160,371-400`, `apps/desktop/src/components/workbench/dock/ClusterDock.tsx:51-164`, `apps/desktop/src/components/dashboard/Dashboard.tsx:57-...`
- Create: `apps/desktop/src/store/useDockStore.test.ts`
- Modify: `apps/desktop/src/i18n/{en,tr}/shell.json`, `apps/desktop/src/i18n/{en,tr}/dock.json`

**Interfaces:**
- Consumes: the `TerminalSpec` members from Tasks 7 and 9.
- Produces:
  - `export const LOCAL_DOCK_ID = '@local'`. It is never reset by the cluster-removal subscription (which only walks registered ids).
  - `dock.cloudLogin(provider: CloudProvider, account: string | null, title: string): string`
  - `dock.localCluster(opId: string, title: string): string`
  - Both open a terminal tab in `LOCAL_DOCK_ID` and return the tab id.
  - `ClusterDock` gets the prop `local?: boolean`, which hides the cluster shell, create and manifests buttons and the Ctrl+` binding.
  - The Dashboard renders `<ClusterDock clusterId={LOCAL_DOCK_ID} visible={visible} local />` below its content when that dock has tabs.

- [ ] **Step 1: Write the failing test**

```ts
// store/useDockStore.test.ts
import { describe, expect, it } from 'vitest';
import { LOCAL_DOCK_ID, dock, useDockStore } from './useDockStore';

describe('local dock', () => {
  it('opens cluster-less terminals in the local dock', () => {
    const id = dock.localCluster('op-1', 'kind create dev');
    const tab = useDockStore.getState().docks[LOCAL_DOCK_ID]!.tabs.find((t) => t.id === id)!;
    expect(tab.kind === 'terminal' && tab.spec).toEqual({ kind: 'local-cluster', op_id: 'op-1' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kubepit/desktop exec vitest run src/store/useDockStore`
Expected: FAIL (`LOCAL_DOCK_ID` is not exported). If the import itself fails because a store module touches `window` or `localStorage` at import time, guard that access with `typeof window !== 'undefined'` in that module. Do not add a DOM environment.

- [ ] **Step 3: Implement the constant, the openers, the `local` prop and the Dashboard rendering; translate the new labels (`Local dock`, and the tooltips) in EN and TR**

- [ ] **Step 4: Run the tests and the checks**

Run: `pnpm test && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/store apps/desktop/src/components/workbench/dock/ClusterDock.tsx apps/desktop/src/components/dashboard/Dashboard.tsx apps/desktop/src/i18n
git commit -m "feat(ui): cluster-less local dock on the dashboard"
```

---

### Task 13: Add cluster hub with kubeconfig and cloud tabs

**Files:**
- Create: `apps/desktop/src/components/discover/AddClusterDialog.tsx`, `discover/KubeconfigTab.tsx`, `discover/ImportOptions.tsx`, `discover/cloud/CloudTab.tsx`, `discover/cloud/AccountPicker.tsx`, `discover/cloud/DiscoveryResults.tsx`, `discover/cloud/useCloudDiscovery.ts`
- Delete: `apps/desktop/src/components/discover/DiscoverDialog.tsx` (its body moves into `KubeconfigTab.tsx` unchanged)
- Modify: `apps/desktop/src/store/types.ts:170-171`, `apps/desktop/src/store/useAppStore.ts:446-447`, `apps/desktop/src/components/app/AppShell.tsx:56-61`, the openers (`SidebarRail.tsx:226`, `Dashboard.tsx:126,229`, `palette/paletteItems.tsx:251`, `connectivity/ConnectivityHost.tsx:72`), `apps/desktop/src/components/settings/categories.tsx:352-410`, `apps/desktop/src/i18n/{en,tr}/shell.json`

**Interfaces:**
- Consumes: `ipc.cloud*` and `lib/cloud/model.ts` (Task 11), `dock.cloudLogin` (Task 12).
- Produces:
  - `export type AddClusterTab = 'kubeconfig' | 'aws' | 'gcp' | 'azure' | 'local'`
  - store `importDialogTab: AddClusterTab` and `setImportDialogOpen(open: boolean, tab?: AddClusterTab)`. It defaults to `'kubeconfig'`, and existing callers keep working.
  - `useCloudDiscovery(provider)` returns `{ accounts, selected, regions, groups, running, start(), cancel(), rediscover(scope) }`. It subscribes to `events.onTerminalExit` for login tabs it opened and calls `rediscover(scope)` when they exit.
  - `ImportOptions` is `{ sectionId, setSectionId, tags, setTags }`, extracted from `DiscoverDialog.tsx:330-351`.
- UI rules:
  - The hub is a `Dialog size="lg"` with an `@container` body: a left rail at `@[560px]:` and above, `Tabs` below.
  - Cloud rows show name, location, version, status and an "Already added" badge.
  - A `login-required` scope shows **Sign in**, which opens the local dock and switches to the Dashboard.
  - The footer reads `i18n.plural('Import {count} cluster', 'Import {count} clusters', n)`.
  - The result list shows warnings: `exec-plugin-missing` as "{command} was not found. Connections will fail until it is installed." and `kubelogin-missing` translated. `CloudErrorKind` is translated through one `cloudErrorText(kind)` helper in `CloudTab.tsx`.
  - The Settings → Tools rows for the eight tools reuse the `row` helper and write `tool_paths[name]`.

- [ ] **Step 1: Move the discover body into `KubeconfigTab` and render it inside `AddClusterDialog`; switch `AppShell` to the hub**

- [ ] **Step 2: Build the cloud tab, the account picker (AWS region multi-select seeded with the default regions plus `EKS_REGIONS` mirrored as a TS constant in `lib/cloud/model.ts`), the streaming results and the import**

- [ ] **Step 3: Add the tool rows in Settings → Tools**

- [ ] **Step 4: Translate the new strings**

Run: `pnpm i18n:check -- --fix`, then add the Turkish values to `src/i18n/tr/shell.json` by hand.
Expected: `pnpm i18n:check` prints `i18n OK`.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm test && pnpm i18n:check`
Expected: PASS. Manual: `pnpm dev:ui`, then open the hub from the sidebar. On *AWS EKS*, select both profiles and discover: `prod/us-east-1` shows Sign in, and the others list clusters. Import two clusters; they appear in the sidebar with "Already added" on reopen. Repeat in Turkish at a narrow window (the rail collapses to tabs).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/discover apps/desktop/src/components/app/AppShell.tsx apps/desktop/src/store apps/desktop/src/components/SidebarRail.tsx apps/desktop/src/components/dashboard/Dashboard.tsx apps/desktop/src/components/palette/paletteItems.tsx apps/desktop/src/components/connectivity/ConnectivityHost.tsx apps/desktop/src/components/settings/categories.tsx apps/desktop/src/i18n
git commit -m "feat(ui): add cluster hub with EKS, GKE and AKS import"
```

---

### Task 14: Local clusters tab

**Files:**
- Create: `apps/desktop/src/components/discover/local/LocalTab.tsx`, `local/CreateLocalClusterForm.tsx`, `local/useLocalClusters.ts`
- Modify: `apps/desktop/src/components/discover/AddClusterDialog.tsx`, `apps/desktop/src/components/app/useAppBootstrap.ts` (subscribe `events.onLocalClusterDone` → toast and `setClusters`), `apps/desktop/src/i18n/{en,tr}/shell.json`

**Interfaces:**
- Consumes: `ipc.localClustersList|localClusterPlan|localClusterRegister`, `events.onLocalClusterDone`, `localProblems` (Task 11), `dock.localCluster` (Task 12).
- Produces: `useLocalClusters()` returns `{ state, refresh(), run(request), register(provider, name) }`. `run` calls `localClusterPlan`, then `dock.localCluster(plan.op_id, plan.command.join(' '))`, then switches to the Dashboard tab. It refreshes on `localcluster://done`.
- UI rules:
  - Provider sections show tool status ("Not found on PATH" plus a link to Settings → Tools).
  - Rows show name, a state `StatusDot`, nodes and version, plus actions:
    - start/stop (k3d, minikube)
    - delete, through `ConfirmDialog` with `confirmWord={name}` and tone `danger`
    - "Add to Kubepit" when `registered_id` is null (kind and k3d call `register`; minikube runs a `start` op)
    - "Open" when it is set
  - The create form fields are provider, name, version (optional), nodes (1–10), ports (add/remove rows of host, container and protocol) and registry (a port for k3d, a fixed-5000 switch for minikube, disabled with a hint for kind). Inline problems come from `localProblems`, each code translated once.
  - Backend errors whose message starts with a code show the translated code text followed by the rest verbatim.
  - The done toast reads `i18n.t('Local cluster {name} is ready', { name })` on success and `i18n.t('{name}: {error}', …)` on failure.

- [ ] **Step 1: Build the list, the row actions, the create form and adoption**

- [ ] **Step 2: Translate**

Run: `pnpm i18n:check -- --fix`, then add the Turkish values by hand.
Expected: `i18n OK`.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test && pnpm i18n:check`
Expected: PASS. Manual (`pnpm dev:ui`): create a k3d cluster `demo` with 2 nodes and port 8080→80. The local dock plays output, the toast appears, and `demo` is in the sidebar with environment Local. Deleting `demo` asks for the typed name and removes it. kind start/stop are hidden, and kind's registry is disabled with a hint.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/discover apps/desktop/src/components/app/useAppBootstrap.ts apps/desktop/src/i18n
git commit -m "feat(ui): create, start, stop, delete and adopt local clusters"
```

---

### Task 15: Documentation and final verification

**Files:**
- Modify: `docs/ARCHITECTURE.md` (new section "Cloud import and local clusters" after "Connectivity"; persistence note for `settings.json` `tool_paths`; events list gains `localcluster://done`), `README.md` (feature bullet), `docs/ARCHITECTURE.md:12` (fix the stale catalog comment to `en|tr/{shell,workbench,dock}.json`)

- [ ] **Step 1: Write the ARCHITECTURE section**

It covers: D1–D14 in prose (at most one screen), the module map, the fake-CLI test harness and the Local dock.

- [ ] **Step 2: Run the six checks**

Run: `pnpm typecheck && pnpm i18n:check && pnpm test && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md README.md
git commit -m "docs: describe cloud import and local clusters"
```
