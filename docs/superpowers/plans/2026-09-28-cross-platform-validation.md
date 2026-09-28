# Linux and Windows Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kubepit build, test and run correctly on Linux and Windows, with OS-specific behaviour pinned by `cfg`-gated tests, the Windows CI job required, and a manual QA checklist for what automation cannot see.

**Architecture:** Fix each platform assumption where it lives (PATH import, tool lookup, POSIX `sh` discovery, file ACLs, keyring service, PTY shell flags, updater install kind, shortcuts, chrome, fonts) behind small pure helpers that take their inputs, so they are testable on every OS; OS-only effects are tested behind `cfg(windows)` / `cfg(target_os = "linux")`. CI (from the CI plan) gains a required Windows job, a real-keyring job and debug package builds.

**Tech Stack:** Rust (`std::env::split_paths`, `windows-sys` 0.61, `webview2-com` 0.39, `keyring` 4, `portable-pty` 0.8, `tauri-plugin-updater` 2.11), React 18 + TypeScript, Node 22 (`node:test` with native type stripping), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-28-cross-platform-validation-design.md`

## Global Constraints

- **Depends on the CI plan** (`docs/superpowers/plans/2026-09-28-ci-and-signed-releases.md`, Tasks 1 and 5): `pnpm test:scripts`, `.github/actions/setup/action.yml`, `.github/workflows/ci.yml` with the `rust` matrix (`os`, `experimental`) and `scripts/ci/test/workflows.test.mjs` must exist before Task 1 here.
- IPC contract: `apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts` define every frontend ⇄ backend command and shape; change both sides and `src/lib/ipc/mock/` in the same change (Task 8 changes `UpdaterStatus`).
- Design: the UI stays visually identical to RunHQ — tokens from `src/styles/theme.css`, primitives from `src/components/ui/`, 11–13px UI text, uppercase tracked labels, `bg-fg/N` hover pads; no chart or UI libraries.
- i18n: every user-visible string ships in English and Turkish in the same change; `import * as i18n from '@/i18n'` in components; run `pnpm i18n:check -- --fix`, then add Turkish by hand; `pnpm i18n:check` must pass. Never translate Kubernetes data, commands or logs. Exact strings and translations are in the spec's UX table.
- Safety: never connect to real clusters from tests or scripts; tests use fixtures, the fake API server (`crates/kubepit-core/tests/support/mod.rs`) and temp dirs / `KUBEPIT_HOME`. The default `cargo test` never touches an OS credential store (`Kubepit::open` keeps `DisabledSecretStore`); the real-store test is opt-in via `KUBEPIT_KEYRING_IT`.
- Mutating backend commands honour `ClusterDef.read_only` (unchanged here).
- Background work stays opt-in per process (`set_alert_monitoring`, `set_change_journal_recording`, `set_history_recording` only in `apps/desktop/src-tauri/src/setup.rs`).
- Layouts that adapt to space use container queries.
- The six checks pass before each commit: `pnpm typecheck`, `pnpm i18n:check`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `pnpm --filter @kubepit/desktop build`.
- New dependencies only as stated: `windows-sys = "0.61"` (kubepit-core, `cfg(windows)`), `webview2-com = "0.39"` and `windows-core = "0.62"` (kubepit-desktop, `cfg(windows)`); all already resolved in `Cargo.lock`. No npm dependencies.
- Script tests that import `.ts` files need Node ≥ 22.18 (native type stripping); CI's `node-version: 22` resolves the latest 22.x. Imported TS files have no imports and only erasable syntax.
- OS-specific tests use `#[cfg(windows)]`, `#[cfg(target_os = "linux")]`, `#[cfg(unix)]`; a test is gated only when it exercises OS-only behaviour, never to hide a failure.
- Windows and Linux results come from CI (the executor's Mac cannot build them); pushing is a **(user)** action — no remote is configured in this worktree.

## Review Focus

- Windows user names and paths with spaces and non-ASCII letters (`C:\Users\Erdem Baş\…`) must survive PATH merging, tool lookup, sh discovery and ACLs (Task 2: `windows_dirs_use_known_package_manager_locations`, `search_path_in_handles_spaces`; Task 4: sh candidates under `Erdem Baş`; Task 6: ACL on a `Erdem Baş data` dir).
- A Windows user without Git for Windows who runs a custom action must get an error naming Git for Windows, not a crash or a silent no-op (Task 4: `a_missing_sh_names_git_for_windows`).
- Merging PATH on Windows must use `;` and must never produce an empty (current-directory) entry (Task 2: `merge_paths_skips_empty_segments` on both OS families).
- `Ctrl+K`, typed inside a terminal on Windows/Linux, must reach the shell, and the palette must still be reachable from the terminal (Task 9: `isPaletteChord` tests).
- Linux without a running Secret Service (headless, WSL, locked keyring) must report the store as unavailable instead of hanging or corrupting state (Task 7: `secret_service_missing_is_reported` in the `keyring-it` job; the existing `an_unavailable_store_changes_nothing` covers migration).

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `.gitattributes` (create) | LF everywhere, binaries untouched |
| `scripts/check-i18n.mjs` (modify) | Windows-safe catalog root, CLI guard |
| `scripts/test/check-i18n.test.mjs`, `scripts/test/gitattributes.test.mjs`, `scripts/test/platform-ui.test.mjs` (create) | Node tests |
| `crates/kubepit-core/src/shell_env.rs` (modify) | per-OS PATH import, `prepare_gui_environment` |
| `crates/kubepit-core/src/tools.rs:47-62` (modify) | `search_path_in` |
| `crates/kubepit-core/src/child_env.rs` (create) | AppImage child-environment fixes |
| `crates/kubepit-core/src/custom_actions/runner.rs` (modify) | POSIX sh discovery, Windows tree kill |
| `crates/kubepit-core/src/custom_actions/mod.rs:335-344,596-640` (modify) | Windows terminal launch + tests |
| `crates/kubepit-core/src/win_acl.rs` (create, `cfg(windows)`) | protected DACL helpers |
| `crates/kubepit-core/src/paths.rs:55-65,183-193` (modify) | `set_private_dir` per OS, root protected on Windows |
| `crates/kubepit-core/src/helm_preview.rs:158-168` (modify) | scratch dir through `set_private_dir` |
| `crates/kubepit-core/src/secrets.rs:244-305` (modify) | `KeyringSecretStore { service }`, `SELFTEST_SERVICE` |
| `crates/kubepit-core/tests/keyring_os.rs` (create) | opt-in real-store test |
| `crates/kubepit-core/src/updates.rs:92-98` (modify) | `UpdaterStatus.bundle`, `NO_UPDATE_PACKAGE` |
| `apps/desktop/src-tauri/src/setup.rs` (modify) | `prepare_gui_environment`, `KeyringSecretStore::default()`, `harden(main)` |
| `apps/desktop/src-tauri/src/terminal/shell.rs:19-27` (modify) | command flag per shell |
| `apps/desktop/src-tauri/src/terminal/manager.rs:150-158` (modify) | child env fixes; ConPTY tests |
| `apps/desktop/src-tauri/src/ipc/updater.rs` (modify) | bundle name, `TargetsNotFound` message |
| `apps/desktop/src-tauri/src/webview_prefs.rs` (create) | WebView2 accelerator keys off (release, Windows) |
| `apps/desktop/src-tauri/src/windows.rs:111-118` (modify) | `harden` new windows |
| `apps/desktop/src/lib/shortcutRules.ts`, `apps/desktop/src/lib/fonts.ts` (create) | dependency-free rules and stacks |
| `apps/desktop/src/components/app/useAppShortcuts.ts`, `src/lib/keymap.ts:103-121` (modify) | palette chord rule, `Mod+Shift+P` |
| `apps/desktop/src/components/TitleBar.tsx` (modify) | title bar on every OS |
| `apps/desktop/src/styles/{base,theme,components}.css`, `src/components/workbench/dock/shared/xtermUtils.ts:6-7`, `src/components/workbench/common/{InlineCodeEditor,MonacoView,DiffView}.tsx` (modify) | font stacks |
| `apps/desktop/src/components/alerts/useAlertNotifications.ts:75-79` (modify) | toast fallback |
| `apps/desktop/src/components/settings/{UpdatesSection,CustomActionsCategory}.tsx`, `src/store/useUpdaterStore.ts`, `src/types/index.ts:1358-1363`, `src/lib/ipc/mock/{app,updates}.ts` (modify) | platform hints, contract, mock |
| `apps/desktop/src/i18n/{en,tr}/shell.json` (modify) | four new strings |
| `.github/workflows/ci.yml`, `scripts/ci/test/workflows.test.mjs` (modify) | `node-windows`, `keyring-it`, `package-smoke`, Windows required |
| `docs/QA-CROSS-PLATFORM.md` (create), `docs/ARCHITECTURE.md`, `README.md` (modify) | QA checklist, platform notes, per-OS requirements |

---

### Task 1: Windows-safe repository basics

**Files:**
- Create: `.gitattributes`, `scripts/test/check-i18n.test.mjs`, `scripts/test/gitattributes.test.mjs`
- Modify: `scripts/check-i18n.mjs:19` (and wrap the top-level body in `main()`), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `pnpm test:scripts`, composite setup action (CI plan).
- Produces: `export function catalogRoot(scriptUrl: string, options?: { windows?: boolean }): string` in `scripts/check-i18n.mjs`; `ci.yml` job `node-windows`.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/test/check-i18n.test.mjs
import { catalogRoot } from '../check-i18n.mjs';
test('POSIX root', () => assert.equal(catalogRoot('file:///repo/scripts/check-i18n.mjs', { windows: false }), '/repo/apps/desktop/src/'));
test('Windows root has a drive letter and no leading slash', () =>
  assert.equal(catalogRoot('file:///C:/Users/Erdem%20Ba%C5%9F/kubepit/scripts/check-i18n.mjs', { windows: true }),
    'C:\\Users\\Erdem Baş\\kubepit\\apps\\desktop\\src\\'));
test('importing the module does not run the check', async () => { /* the import above did not exit or print */ assert.ok(true); });
```

```js
// scripts/test/gitattributes.test.mjs — runs `git check-attr text eol -- <paths>` from the repo root
test('sources are LF', () => {
  for (const p of ['crates/kubepit-core/src/lib.rs', 'apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/src/i18n/tr/shell.json', 'CHANGELOG.md'])
    assert.match(checkAttr(p), /eol: lf/, p);
});
test('icons are binary', () => {
  for (const p of ['apps/desktop/src-tauri/icons/icon.png', 'apps/desktop/src-tauri/icons/icon.icns', 'apps/desktop/src-tauri/icons/icon.ico'])
    assert.match(checkAttr(p), /text: unset/, p);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:scripts`
Expected: FAIL — `catalogRoot` is not exported (and importing runs the check); `eol: unspecified`.

- [ ] **Step 3: Implement**

`catalogRoot` = `fileURLToPath(new URL('../apps/desktop/src/', scriptUrl), options)` (Node ≥22.1 accepts `{ windows }`); `main()` uses `catalogRoot(import.meta.url)` and runs only when `import.meta.url === pathToFileURL(process.argv[1]).href`. `.gitattributes`: `* text=auto eol=lf` and `*.png binary`, `*.icns binary`, `*.ico binary`, `*.woff2 binary`. Run `git add --renormalize .` and confirm `git status` shows no content changes (the tree is already LF).

`ci.yml` job `node-windows` (`windows-2022`): checkout, setup (`rust: 'false'`), `pnpm i18n:check`, `pnpm test:scripts`.

- [ ] **Step 4: Run the tests and checks**

Run: `pnpm test:scripts && pnpm i18n:check && actionlint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .gitattributes scripts/check-i18n.mjs scripts/test/check-i18n.test.mjs scripts/test/gitattributes.test.mjs .github/workflows/ci.yml
git commit -m "build: LF line endings and a Windows-safe i18n guard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Per-OS PATH import and tool lookup

**Files:**
- Modify: `crates/kubepit-core/src/shell_env.rs`, `crates/kubepit-core/src/tools.rs:47-62`, `apps/desktop/src-tauri/src/setup.rs:11-14`
- Test: tests modules of both files

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub fn prepare_gui_environment()` — `import_login_shell_path()` then `set_var` for each of `gui_env_overrides()`; called first in `setup_app`.
  - `pub fn gui_env_overrides() -> &'static [(&'static str, &'static str)]` — `[("KUBE_RS_UNSTABLE_CREATE_NO_WINDOW", "1")]` on Windows, `[]` elsewhere.
  - `fn merge_paths(parts: &[OsString]) -> OsString`
  - `fn canonical_dev_tool_dirs_for(home: Option<&Path>, var: &dyn Fn(&str) -> Option<OsString>) -> Vec<PathBuf>`
  - `pub fn search_path_in(name: &str, path_var: &OsStr) -> Option<PathBuf>` (tools.rs; `search_path` delegates with `$PATH`).

- [ ] **Step 1: Write the failing tests**

```rust
fn join(parts: &[&str]) -> OsString { std::env::join_paths(parts).unwrap() }

#[test]
fn merge_paths_uses_the_platform_separator() {
    #[cfg(unix)] let (a, b, c) = ("/a", "/b", "/c");
    #[cfg(windows)] let (a, b, c) = (r"C:\a", r"C:\b", r"C:\Program Files\c");
    assert_eq!(merge_paths(&[join(&[a, b]), join(&[b, c])]), join(&[a, b, c]));
}

#[test]
fn merge_paths_skips_empty_segments() {
    #[cfg(unix)] assert_eq!(merge_paths(&["/a::/b".into(), "::/c:".into()]), OsString::from("/a:/b:/c"));
    #[cfg(windows)] assert_eq!(merge_paths(&[r"C:\a;;C:\b".into(), r";C:\c;".into()]), OsString::from(r"C:\a;C:\b;C:\c"));
}

#[test]
fn canonical_dirs_include_krew_and_rancher_desktop() {
    let home = std::env::temp_dir().join("kp home");
    let dirs = canonical_dev_tool_dirs_for(Some(&home), &|_| None);
    assert!(dirs.contains(&home.join(".krew").join("bin")));
    assert!(dirs.contains(&home.join(".rd").join("bin")));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_dirs_include_linuxbrew_and_nix() {
    let dirs = canonical_dev_tool_dirs_for(Some(Path::new("/home/u")), &|_| None);
    for d in ["/home/linuxbrew/.linuxbrew/bin", "/home/u/.linuxbrew/bin", "/home/u/.nix-profile/bin", "/nix/var/nix/profiles/default/bin"] {
        assert!(dirs.contains(&PathBuf::from(d)), "{d}");
    }
}

#[cfg(windows)]
#[test]
fn windows_dirs_use_known_package_manager_locations() {
    let home = Path::new(r"C:\Users\Erdem Baş");
    let var = |k: &str| match k {
        "LOCALAPPDATA" => Some(OsString::from(r"C:\Users\Erdem Baş\AppData\Local")),
        "ProgramData" => Some(OsString::from(r"C:\ProgramData")),
        "ProgramFiles" => Some(OsString::from(r"C:\Program Files")),
        _ => None,
    };
    let dirs = canonical_dev_tool_dirs_for(Some(home), &var);
    for d in [r"C:\Users\Erdem Baş\AppData\Local\Microsoft\WinGet\Links", r"C:\Users\Erdem Baş\scoop\shims",
              r"C:\ProgramData\chocolatey\bin", r"C:\Program Files\Docker\Docker\resources\bin", r"C:\Users\Erdem Baş\.krew\bin"] {
        assert!(dirs.contains(&PathBuf::from(d)), "{d}");
    }
}

#[test]
fn gui_env_overrides_hide_exec_plugin_consoles_on_windows() {
    assert_eq!(gui_env_overrides().contains(&("KUBE_RS_UNSTABLE_CREATE_NO_WINDOW", "1")), cfg!(windows));
}
```

In `tools.rs`:

```rust
#[cfg(windows)]
#[test]
fn search_path_in_prefers_exe_then_cmd() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("kubectl.cmd"), "@echo off").unwrap();
    assert_eq!(search_path_in("kubectl", dir.path().as_os_str()), Some(dir.path().join("kubectl.cmd")));
    std::fs::write(dir.path().join("kubectl.exe"), "").unwrap();
    assert_eq!(search_path_in("kubectl", dir.path().as_os_str()), Some(dir.path().join("kubectl.exe")));
}

#[cfg(unix)]
#[test]
fn search_path_in_requires_the_exec_bit() { /* file without +x → None; after chmod 755 → Some */ }

#[test]
fn search_path_in_handles_spaces() {
    let dir = tempfile::tempdir().unwrap(); let bin = dir.path().join("Program Files").join("tools");
    std::fs::create_dir_all(&bin).unwrap();
    let file = bin.join(if cfg!(windows) { "helm.exe" } else { "helm" });
    std::fs::write(&file, "").unwrap();
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap(); }
    let path_var = std::env::join_paths([dir.path().join("empty"), bin.clone()]).unwrap();
    assert_eq!(search_path_in("helm", &path_var), Some(file));
}
```

Keep `canonical_includes_homebrew_on_macos` (adapted to `Vec<PathBuf>`), the `extract_marked` tests and `invalid_variable_names_are_not_probed`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core shell_env tools`
Expected: FAIL to compile — `canonical_dev_tool_dirs_for`, `gui_env_overrides`, `search_path_in` not found; `merge_paths` takes `&[String]`.

- [ ] **Step 3: Implement**

`merge_paths` splits every part with `std::env::split_paths`, drops empty entries, dedupes preserving order and joins with `std::env::join_paths` (an entry containing the separator is skipped with a `tracing::warn!`). `canonical_dev_tool_dirs_for` keeps today's list for macOS/Linux, adds `~/.krew/bin` (or `$KREW_ROOT/bin`) and `~/.rd/bin` everywhere, Linuxbrew and Nix (`~/.nix-profile/bin`, `/nix/var/nix/profiles/default/bin`, `/run/current-system/sw/bin`) on Linux and Nix on macOS, and the Windows list from the test (`%USERPROFILE%\scoop\shims` unless `SCOOP` is set). `import_login_shell_path` on Windows skips the probe and merges **inherited first**, then the canonical dirs; macOS/Linux keep probe → canonical → inherited. Update the tracing `entries` count to use `split_paths`. `setup.rs` calls `kubepit_core::shell_env::prepare_gui_environment()` instead of `import_login_shell_path()` (same position, before any thread).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core shell_env tools && cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS (Windows/Linux variants run in CI).

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/shell_env.rs crates/kubepit-core/src/tools.rs apps/desktop/src-tauri/src/setup.rs
git commit -m "fix(core): per-OS PATH import and hidden exec-plugin consoles on Windows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: AppImage child environment

**Files:**
- Create: `crates/kubepit-core/src/child_env.rs`
- Modify: `crates/kubepit-core/src/lib.rs` (`pub mod child_env;`), `crates/kubepit-core/src/tools.rs:108-122`, `crates/kubepit-core/src/custom_actions/runner.rs:90-109`, `apps/desktop/src-tauri/src/terminal/manager.rs:150-158`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `#[derive(Debug, Clone, PartialEq, Eq)] pub enum EnvFix { Remove(OsString), Set(OsString, OsString) }`
  - `pub fn fixes_from_env(vars: &[(OsString, OsString)]) -> Vec<EnvFix>` — empty unless both `APPIMAGE` and `APPDIR` are present.
  - `pub fn child_env_fixes() -> &'static [EnvFix]` — `fixes_from_env(std::env::vars_os())` cached in a `OnceLock`.
  - Callers apply with `for fix in child_env_fixes() { match fix { EnvFix::Remove(k) => cmd.env_remove(k), EnvFix::Set(k, v) => cmd.env(k, v) }; }` (tokio `Command`, portable-pty `CommandBuilder`).

- [ ] **Step 1: Write the failing tests**

```rust
fn vars(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> { list.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect() }

#[test]
fn nothing_changes_outside_an_appimage() {
    assert!(fixes_from_env(&vars(&[("PATH", "/usr/bin"), ("APPDIR", "/tmp/.mount_K")])).is_empty());
}

#[test]
fn appimage_injections_are_removed_for_children() {
    let fixes = fixes_from_env(&vars(&[
        ("APPIMAGE", "/home/u/Kubepit.AppImage"), ("APPDIR", "/tmp/.mount_K"), ("ARGV0", "Kubepit"), ("OWD", "/home/u"),
        ("PATH", "/tmp/.mount_K/usr/bin:/usr/local/bin:/usr/bin"),
        ("LD_LIBRARY_PATH", "/tmp/.mount_K/usr/lib"),
        ("GDK_PIXBUF_MODULE_FILE", "/tmp/.mount_K/usr/lib/gdk-pixbuf-2.0/loaders.cache"),
        ("HOME", "/home/u"),
    ]));
    assert!(fixes.contains(&EnvFix::Set("PATH".into(), "/usr/local/bin:/usr/bin".into())));
    for k in ["LD_LIBRARY_PATH", "GDK_PIXBUF_MODULE_FILE", "APPIMAGE", "APPDIR", "ARGV0", "OWD"] {
        assert!(fixes.contains(&EnvFix::Remove(k.into())), "{k}");
    }
    assert!(!fixes.iter().any(|f| matches!(f, EnvFix::Remove(k) | EnvFix::Set(k, _) if k == "HOME")));
}

#[test]
fn a_name_prefix_is_not_a_parent_directory() {
    let fixes = fixes_from_env(&vars(&[("APPIMAGE", "/a"), ("APPDIR", "/tmp/.mount_K"), ("XDG_DATA_DIRS", "/tmp/.mount_Kx/share:/usr/share")]));
    assert!(!fixes.iter().any(|f| matches!(f, EnvFix::Set(k, _) | EnvFix::Remove(k) if k == "XDG_DATA_DIRS")));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core child_env`
Expected: FAIL — unresolved module `child_env`.

- [ ] **Step 3: Implement `child_env.rs` and apply it**

Path-list variables: `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`, `XDG_CONFIG_DIRS`, `GI_TYPELIB_PATH`, `GST_PLUGIN_SYSTEM_PATH`, `GST_PLUGIN_SYSTEM_PATH_1_0`, `GTK_PATH`, `PYTHONPATH`, `PERLLIB`, `QT_PLUGIN_PATH`, `GSETTINGS_SCHEMA_DIR` — drop entries for which `Path::starts_with(appdir)` (component-wise); all dropped → `Remove`, some dropped → `Set`, none → nothing. Any other variable whose value as a path starts with `appdir` → `Remove`. Always `Remove` `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`. Output sorted by variable name. Apply the loop in `tools::run_with_stdin` (after `cmd.args`), `runner::run_shell` (before the caller's `env` so action variables still win) and the PTY `CommandBuilder` in `manager.rs` (before `TERM`/`COLORTERM` and `launch.env`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/child_env.rs crates/kubepit-core/src/lib.rs crates/kubepit-core/src/tools.rs crates/kubepit-core/src/custom_actions/runner.rs apps/desktop/src-tauri/src/terminal/manager.rs
git commit -m "fix(linux): children of the AppImage get the user's environment" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: POSIX sh for custom actions on Windows

**Files:**
- Modify: `crates/kubepit-core/src/custom_actions/runner.rs:34-41,67-80,103-109,165-200`, `crates/kubepit-core/src/custom_actions/mod.rs:335-344,596-640`, `apps/desktop/src/components/settings/CustomActionsCategory.tsx:152-160`, `apps/desktop/src/i18n/{en,tr}/shell.json`

**Interfaces:**
- Consumes: `tools::find_executable` (existing), `search_path_in` (Task 2).
- Produces:
  - `pub fn posix_shell() -> Result<PathBuf>` (signature unchanged).
  - `pub(crate) fn git_sh_candidates(git_exe: Option<&Path>, program_files: Option<&Path>, local_app_data: Option<&Path>) -> Vec<PathBuf>`
  - `pub(crate) fn pick_posix_shell(on_path: Option<PathBuf>, candidates: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Result<PathBuf>`
  - `pub(crate) const MISSING_SH: &str = "custom actions need a POSIX sh: install Git for Windows (https://git-scm.com/download/win) or put sh.exe on PATH"`
  - `fn kill_tree(pid: Option<u32>)` — Unix: today's `kill -KILL -<pid>`; Windows: `taskkill /T /F /PID <pid>` with `CREATE_NO_WINDOW`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn git_sh_candidates_follow_the_git_install() {
    let root = PathBuf::from_iter(["/", "opt", "Git"]);
    for git in [root.join("cmd").join("git.exe"), root.join("bin").join("git.exe"), root.join("mingw64").join("bin").join("git.exe")] {
        let c = git_sh_candidates(Some(&git), None, None);
        assert_eq!(c[..2], [root.join("bin").join("sh.exe"), root.join("usr").join("bin").join("sh.exe")], "{git:?}");
    }
}

#[cfg(windows)]
#[test]
fn git_sh_candidates_include_standard_locations() {
    let c = git_sh_candidates(None, Some(Path::new(r"C:\Program Files")), Some(Path::new(r"C:\Users\Erdem Baş\AppData\Local")));
    assert_eq!(c, [PathBuf::from(r"C:\Program Files\Git\bin\sh.exe"), PathBuf::from(r"C:\Users\Erdem Baş\AppData\Local\Programs\Git\bin\sh.exe")]);
}

#[test]
fn pick_prefers_path_then_the_first_existing_candidate() {
    let (a, b) = (PathBuf::from("a/sh.exe"), PathBuf::from("b/sh.exe"));
    assert_eq!(pick_posix_shell(Some(a.clone()), &[b.clone()], &|_| true).unwrap(), a);
    assert_eq!(pick_posix_shell(None, &[a.clone(), b.clone()], &|p| p == b.as_path()).unwrap(), b);
}

#[test]
fn a_missing_sh_names_git_for_windows() {
    let err = pick_posix_shell(None, &[], &|_| false).unwrap_err().to_string();
    assert!(err.contains("Git for Windows"), "{err}");
}
```

Change the runner tests module from `#[cfg(all(test, unix))]` to `#[cfg(test)]` (they now use `posix_shell()`; Windows CI runners ship Git for Windows) so `captures_output_and_exit_code` and `timeouts_kill_the_whole_group` run on Windows too. In `mod.rs`, `the_terminal_script_hands_the_command_to_sh` runs `posix_shell().unwrap()` instead of `/bin/sh` and drops `#[cfg(unix)]`; `terminal_actions_run_through_the_login_shell` adds:

```rust
if cfg!(windows) {
    assert_eq!(launch.program, LaunchProgram::Exec { program: runner::posix_shell().unwrap(), args: vec!["-c".into(), TERMINAL_SCRIPT.into()] });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core custom_actions`
Expected: FAIL to compile — `git_sh_candidates`, `pick_posix_shell` not found.

- [ ] **Step 3: Implement**

Git root: walk up from `git.exe`'s directory while the directory name (case-insensitive) is `cmd`, `bin`, `mingw64` or `clangarm64`; candidates are `<root>\bin\sh.exe`, `<root>\usr\bin\sh.exe`, then `<ProgramFiles>\Git\bin\sh.exe`, `<LOCALAPPDATA>\Programs\Git\bin\sh.exe`, deduped. `posix_shell()` on Windows: `pick_posix_shell(find_executable("sh", None), &git_sh_candidates(find_executable("git", None).as_deref(), env ProgramFiles, env LOCALAPPDATA), &Path::is_file)`; elsewhere `/bin/sh`. Replace `kill_group` with `kill_tree` at both call sites. Windows terminal-mode launch: `LaunchProgram::Exec { program: posix_shell()?, args: ["-c", TERMINAL_SCRIPT] }` (the script's `/bin/sh` resolves inside Git's MSYS tree; the command arrives through `KUBEPIT_ACTION_COMMAND`, so it is echoed like on Unix).

UI: under the "Actions" section header in `CustomActionsCategory.tsx`, when `useAppStore((s) => s.appInfo?.platform) === 'windows'`, a `text-fg-dim text-[11.5px]` paragraph with the first string of the spec's UX table; add the key with `pnpm i18n:check -- --fix` and the Turkish text from the spec to `src/i18n/tr/shell.json`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core custom_actions && pnpm typecheck && pnpm i18n:check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/custom_actions/runner.rs crates/kubepit-core/src/custom_actions/mod.rs apps/desktop/src/components/settings/CustomActionsCategory.tsx apps/desktop/src/i18n/en/shell.json apps/desktop/src/i18n/tr/shell.json
git commit -m "fix(windows): find Git for Windows' sh and kill timed-out action trees" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Terminals on Windows — shell flags and ConPTY tests

**Files:**
- Modify: `apps/desktop/src-tauri/src/terminal/shell.rs:19-27`, `apps/desktop/src-tauri/src/terminal/manager.rs` (tests module)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub(super) fn command_flag_for(path: &Path) -> &'static str` — `"/C"` for `cmd`, `"-Command"` for `pwsh`/`powershell`, `"-c"` otherwise (file stem, case-insensitive); `shell_command_for` uses it.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn command_flags_per_shell() {
    assert_eq!(command_flag_for(Path::new("cmd.exe")), "/C");
    assert_eq!(command_flag_for(Path::new("PowerShell.exe")), "-Command");
    assert_eq!(command_flag_for(Path::new("pwsh")), "-Command");
    assert_eq!(command_flag_for(Path::new("/bin/zsh")), "-c");
}

#[cfg(windows)]
#[test]
fn default_shell_on_windows_is_powershell_or_cmd() {
    let (path, _) = default_shell();
    let stem = path.file_stem().unwrap().to_string_lossy().to_ascii_lowercase();
    assert!(["pwsh", "powershell", "cmd"].contains(&stem.as_str()), "{path:?}");
    assert!(path.is_file());
}
```

In `manager.rs`, mirroring the Unix tests with `cmd.exe` (ConPTY adds escape sequences, so assert with `contains`):

```rust
#[cfg(windows)]
#[test]
fn windows_launch_environment_reaches_the_child() {
    // exec("cmd.exe", &["/C", "echo %KUBEPIT_TEST% & ping -n 2 127.0.0.1 >NUL"]) → decoded output contains "yes"
}
#[cfg(windows)]
#[test]
fn windows_exit_code_and_cleanup_are_reported() {
    // exec("cmd.exe", &["/C", "ping -n 2 127.0.0.1 >NUL & exit 3"]) with a cleanup counter → hook gets ("exits", Some(3)), cleanup ran once
}
#[cfg(windows)]
#[test]
fn windows_destroy_runs_cleanup_once_and_reports_no_exit() {
    // exec("cmd.exe", &["/C", "ping -n 30 127.0.0.1 >NUL"]); destroy twice → cleanup 1, no exit event within 1.5 s
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-desktop terminal`
Expected: FAIL to compile — `command_flag_for` not found.

- [ ] **Step 3: Implement `command_flag_for` and use it in `shell_command_for`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-desktop terminal && cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS locally; the `cfg(windows)` tests pass in CI.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/terminal/shell.rs apps/desktop/src-tauri/src/terminal/manager.rs
git commit -m "fix(terminal): per-shell command flag and ConPTY tests" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Owner-only data directory on Windows

**Files:**
- Create: `crates/kubepit-core/src/win_acl.rs`
- Modify: `crates/kubepit-core/Cargo.toml`, `crates/kubepit-core/src/lib.rs`, `crates/kubepit-core/src/paths.rs:55-65,183-193`, `crates/kubepit-core/src/helm_preview.rs:158-168`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub(crate) fn set_private_dir(dir: &Path)` in `paths.rs` (now `pub(crate)`): Unix 0700 as today; Windows `win_acl::restrict_to_owner`, errors logged with `tracing::warn!`.
  - `win_acl` (`#[cfg(windows)] pub(crate) mod win_acl;`): `pub(crate) fn current_user_sid() -> std::io::Result<String>`, `pub(crate) fn restrict_to_owner(path: &Path) -> std::io::Result<()>`, `pub(crate) fn dacl_trustees(path: &Path) -> std::io::Result<(bool, Vec<String>)>` (protected flag, SID strings of allow ACEs, sorted and deduped).
  - `Paths::ensure_dirs` also protects the root on Windows (so `history.db`, its `-wal`/`-shm` and every temp file inherit).

- [ ] **Step 1: Write the failing tests (`paths.rs`)**

```rust
#[cfg(windows)]
#[test]
fn private_dirs_are_owner_only_on_windows() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("Erdem Baş data"));
    paths.ensure_dirs().unwrap();
    let mut expected = vec![crate::win_acl::current_user_sid().unwrap(), "S-1-5-18".to_string()];
    expected.sort();
    for d in [paths.root().to_path_buf(), paths.kubeconfigs_dir(), paths.run_dir()] {
        assert_eq!(crate::win_acl::dacl_trustees(&d).unwrap(), (true, expected.clone()), "{d:?}");
    }
    let file = paths.managed_kubeconfig("abc").unwrap();
    atomic_write(&file, b"secret", true).unwrap();
    assert_eq!(crate::win_acl::dacl_trustees(&file).unwrap().1, expected);
}
```

The existing `#[cfg(unix)]` mode assertions stay.

- [ ] **Step 2: Run the test to verify it fails**

Run (CI, Windows): `cargo test -p kubepit-core private_dirs_are_owner_only_on_windows`
Expected: FAIL to compile — `win_acl` not found. Locally: `cargo test -p kubepit-core paths` still passes (the test is Windows-only).

- [ ] **Step 3: Implement**

`Cargo.toml`: `[target.'cfg(windows)'.dependencies] windows-sys = { version = "0.61", features = ["Win32_Foundation", "Win32_Security", "Win32_Security_Authorization", "Win32_System_Threading", "Win32_Storage_FileSystem"] }`. `restrict_to_owner`: `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY)` + `GetTokenInformation(TokenUser)` for the user SID, `ConvertStringSidToSidW("S-1-5-18")` for SYSTEM, two `EXPLICIT_ACCESS_W` (`GRANT_ACCESS`, `FILE_ALL_ACCESS`, `TRUSTEE_IS_SID`, inheritance `OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE` for directories, none for files) → `SetEntriesInAclW` → `SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, …)`; free with `LocalFree`. `dacl_trustees`: `GetNamedSecurityInfoW` (DACL + control via `GetSecurityDescriptorControl`, `SE_DACL_PROTECTED`), iterate `GetAce`, `ConvertSidToStringSidW`. Every `unsafe` block carries a `// SAFETY:` comment. `ensure_dirs` calls `set_private_dir(&self.root)` under `cfg(windows)`; `helm_preview::ScratchDir::create` calls `crate::paths::set_private_dir(&dir)` instead of its own `cfg(unix)` block.

- [ ] **Step 4: Run the checks**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS locally; after pushing **(user)**, `rust (windows-2022)` passes `private_dirs_are_owner_only_on_windows`.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/Cargo.toml Cargo.lock crates/kubepit-core/src/win_acl.rs crates/kubepit-core/src/lib.rs crates/kubepit-core/src/paths.rs crates/kubepit-core/src/helm_preview.rs
git commit -m "fix(windows): owner-only ACLs on the Kubepit data directory" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Keyring backends against the real OS stores

**Files:**
- Modify: `crates/kubepit-core/src/secrets.rs:244-305`, `apps/desktop/src-tauri/src/setup.rs:19-24`, `.github/workflows/ci.yml`, `scripts/ci/test/workflows.test.mjs`
- Create: `crates/kubepit-core/tests/keyring_os.rs`

**Interfaces:**
- Consumes: `write_value`, `read_value`, `delete_value` (existing).
- Produces:
  - `pub struct KeyringSecretStore { service: &'static str }` with `impl Default` (service `SERVICE`), `pub const fn with_service(service: &'static str) -> Self`, `pub fn service(&self) -> &str`; `entry()` uses `self.service`.
  - `pub const SELFTEST_SERVICE: &str = "io.github.erdembas.kubepit.selftest";`
  - `ci.yml` job `keyring-it`.

- [ ] **Step 1: Write the failing tests**

Unit test in `secrets.rs` (never touches the OS store):

```rust
#[test]
fn keyring_store_service_and_entry_limit() {
    assert_eq!(KeyringSecretStore::default().service(), SERVICE);
    assert_eq!(KeyringSecretStore::with_service(SELFTEST_SERVICE).service(), SELFTEST_SERVICE);
    // 2 048 leaves headroom under Windows' CRED_MAX_CREDENTIAL_BLOB_SIZE (2 560 bytes).
    assert_eq!(KeyringSecretStore::default().max_value_len(), cfg!(windows).then_some(2048));
    // A chunk header always fits in one entry.
    let header = format!("{CHUNK_MAGIC}{}:{}", "f".repeat(12), 9999);
    assert!(header.len() < 2048, "{header}");
}
```

`tests/keyring_os.rs` (every test `#[ignore]`, returns early unless the variable matches):

```rust
fn enabled(mode: &str) -> bool { std::env::var("KUBEPIT_KEYRING_IT").as_deref() == Ok(mode) }

#[test]
#[ignore = "touches the OS credential store; run with KUBEPIT_KEYRING_IT=1"]
fn real_store_round_trips_a_chunked_kubeconfig() {
    if !enabled("1") { return; }
    let store = KeyringSecretStore::with_service(SELFTEST_SERVICE);
    let key = format!("kubeconfig/it-{}", uuid::Uuid::new_v4());
    let value: Vec<u8> = (0..10 * 1024).map(|i| b"abcdefghijklmnopqrstuvwxyz0123456789\n"[i % 37]).collect();
    write_value(&store, &key, &value).unwrap();
    assert_eq!(read_value(&store, &key).unwrap().unwrap(), value);
    let raw = store.get(&key).unwrap().unwrap();
    assert_eq!(raw.starts_with(b"kubepit-chunked:v1:"), cfg!(windows));
    delete_value(&store, &key).unwrap();
    assert_eq!(read_value(&store, &key).unwrap(), None);
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "run with KUBEPIT_KEYRING_IT=missing and no D-Bus session"]
fn secret_service_missing_is_reported() {
    if !enabled("missing") { return; }
    let err = KeyringSecretStore::with_service(SELFTEST_SERVICE).get("k").unwrap_err().to_string();
    assert!(err.contains("Secret Service") && (err.contains("not available") || err.contains("locked")), "{err}");
}
```

(`uuid` is already a dependency of `kubepit-core`; integration tests can use it.)

Workflow invariant:

```js
test('keyring integration job', () => {
  const ci = readWorkflow('ci.yml');
  for (const s of ['keyring-it:', 'KUBEPIT_KEYRING_IT=1', 'KUBEPIT_KEYRING_IT=missing', 'dbus-run-session', '--test keyring_os'])
    assert.ok(ci.includes(s), s);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core keyring; pnpm test:scripts`
Expected: FAIL — `with_service` / `SELFTEST_SERVICE` not found; `keyring-it:` missing.

- [ ] **Step 3: Implement the store change, `setup.rs` and the CI job**

`setup.rs`: `Arc::new(KeyringSecretStore::default())`. `keyring-it` (matrix `ubuntu-22.04`, `macos-14`, `windows-2022`, `timeout-minutes: 15`, setup with `linux-deps: 'true'`, `install: 'false'`): Linux installs `gnome-keyring dbus-x11`, then runs `dbus-run-session -- bash -c 'printf "ci" | gnome-keyring-daemon --unlock --components=secrets >/dev/null && KUBEPIT_KEYRING_IT=1 cargo test -p kubepit-core --test keyring_os --locked -- --ignored --test-threads=1'` and `env -u DBUS_SESSION_BUS_ADDRESS KUBEPIT_KEYRING_IT=missing cargo test -p kubepit-core --test keyring_os --locked -- --ignored`; macOS and Windows run `KUBEPIT_KEYRING_IT=1 cargo test -p kubepit-core --test keyring_os --locked -- --ignored --test-threads=1` (bash shell).

- [ ] **Step 4: Run the tests and actionlint**

Run: `cargo test --workspace && pnpm test:scripts && actionlint`
Expected: PASS (the ignored tests are skipped locally); after pushing **(user)**, `keyring-it` passes on all three OSes.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/secrets.rs crates/kubepit-core/tests/keyring_os.rs apps/desktop/src-tauri/src/setup.rs .github/workflows/ci.yml scripts/ci/test/workflows.test.mjs
git commit -m "test(keyring): verify Keychain, Credential Manager and Secret Service in CI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Updater per install kind

**Files:**
- Modify: `crates/kubepit-core/src/updates.rs:92-98`, `apps/desktop/src-tauri/src/ipc/updater.rs:46-78`, `apps/desktop/src/types/index.ts:1358-1363`, `apps/desktop/src/lib/ipc/mock/updates.ts`, `apps/desktop/src/store/useUpdaterStore.ts:86-88`, `apps/desktop/src/components/settings/UpdatesSection.tsx:80-98`, `apps/desktop/src/i18n/{en,tr}/shell.json`

**Interfaces:**
- Consumes: `tauri::utils::platform::bundle_type()`, `tauri::utils::config::BundleType`, `tauri_plugin_updater::Error::TargetsNotFound`.
- Produces:
  - `UpdaterStatus { configured: bool, current_version: String, endpoint: String, bundle: Option<String> }` (Rust) / `bundle: 'app' | 'appimage' | 'deb' | 'rpm' | 'nsis' | 'msi' | null` (TS).
  - `pub const NO_UPDATE_PACKAGE: &str = "The release feed has no update package for this installation type";` in `updates.rs`; TS mirror `export const NO_UPDATE_PACKAGE` in `store/useUpdaterStore.ts` with the same text.
  - Desktop: `fn bundle_name(bundle: Option<BundleType>) -> Option<&'static str>`, `fn check_error(err: tauri_plugin_updater::Error) -> String`.

- [ ] **Step 1: Write the failing Rust tests**

```rust
// updater.rs
#[test]
fn bundle_names() {
    use tauri::utils::config::BundleType::*;
    for (b, n) in [(Deb, "deb"), (Rpm, "rpm"), (AppImage, "appimage"), (Nsis, "nsis"), (Msi, "msi"), (App, "app"), (Dmg, "app")] {
        assert_eq!(bundle_name(Some(b)), Some(n));
    }
    assert_eq!(bundle_name(None), None);
}
#[test]
fn missing_targets_get_a_stable_message() {
    assert_eq!(check_error(tauri_plugin_updater::Error::TargetsNotFound(vec!["linux-x86_64-deb".into()])), NO_UPDATE_PACKAGE);
    assert!(check_error(tauri_plugin_updater::Error::ReleaseNotFound).starts_with("update check failed: "));
}
// updates.rs
#[test]
fn updater_status_carries_the_install_kind() {
    let s = UpdaterStatus { configured: true, current_version: "0.1.0".into(), endpoint: DEFAULT_UPDATE_ENDPOINT.into(), bundle: Some("deb".into()) };
    assert_eq!(serde_json::to_value(&s).unwrap()["bundle"], serde_json::json!("deb"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core updates; cargo test -p kubepit-desktop updater`
Expected: FAIL to compile — no field `bundle`, no `bundle_name` / `check_error` / `NO_UPDATE_PACKAGE`.

- [ ] **Step 3: Implement both sides**

`update_status` fills `bundle: bundle_name(tauri::utils::platform::bundle_type()).map(str::to_string)`; `update_check` maps the `check()` error through `check_error`. TS type and mock (`bundle: null`) in the same change. `useUpdaterStore.check`: when `errorText(e) === NO_UPDATE_PACKAGE`, store the translated fourth string of the spec's UX table as `error` (and toast it) instead of the raw text. `UpdatesSection`: below the "Current version" line, `status.bundle === 'deb' || status.bundle === 'rpm'` → second UX string; `status.bundle === 'nsis'` → third; same `text-fg-dim text-[11.5px]` style. Add keys with `pnpm i18n:check -- --fix` and the Turkish texts from the spec.

- [ ] **Step 4: Run the tests and checks**

Run: `cargo test --workspace && pnpm typecheck && pnpm i18n:check && pnpm --filter @kubepit/desktop build`
Expected: PASS; `pnpm dev:ui` → Settings → About & Updates still renders the demo update.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/updates.rs apps/desktop/src-tauri/src/ipc/updater.rs apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc/mock/updates.ts apps/desktop/src/store/useUpdaterStore.ts apps/desktop/src/components/settings/UpdatesSection.tsx apps/desktop/src/i18n/en/shell.json apps/desktop/src/i18n/tr/shell.json
git commit -m "feat(updates): install-kind hints and a clear message without a feed package" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Shortcuts, fonts, notification fallback

**Files:**
- Create: `apps/desktop/src/lib/shortcutRules.ts`, `apps/desktop/src/lib/fonts.ts`, `scripts/test/platform-ui.test.mjs`
- Modify: `apps/desktop/src/components/app/useAppShortcuts.ts:23-34`, `apps/desktop/src/lib/keymap.ts:106`, `apps/desktop/src/styles/base.css:7-15,60-63`, `apps/desktop/src/styles/theme.css:50-51`, `apps/desktop/src/styles/components.css:127-128`, `apps/desktop/src/components/workbench/dock/shared/xtermUtils.ts:6-7`, `apps/desktop/src/components/workbench/common/InlineCodeEditor.tsx:144`, `MonacoView.tsx:78`, `DiffView.tsx:155`, `apps/desktop/src/components/alerts/useAlertNotifications.ts:75-79`, `apps/desktop/src/lib/ipc/mock/app.ts:274`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `shortcutRules.ts` (no imports, erasable syntax only): `export type ShortcutInput = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; inTerminal: boolean }`, `export function isPaletteChord(input: ShortcutInput, isMac: boolean): boolean`.
  - `fonts.ts` (no imports): `export const MONO_FONT_STACK = "'JetBrains Mono', 'SF Mono', 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', 'Liberation Mono', ui-monospace, Menlo, monospace";`, `export const UI_FONT_STACK = "'Inter', 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Ubuntu, Cantarell, 'Noto Sans', system-ui, sans-serif";`

- [ ] **Step 1: Write the failing tests**

```js
import { isPaletteChord } from '../../apps/desktop/src/lib/shortcutRules.ts';
import { MONO_FONT_STACK, UI_FONT_STACK } from '../../apps/desktop/src/lib/fonts.ts';
const ev = (o) => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, inTerminal: false, ...o });
test('palette chord', () => {
  assert.equal(isPaletteChord(ev({ ctrlKey: true }), false), true);
  assert.equal(isPaletteChord(ev({ ctrlKey: true, inTerminal: true }), false), false); // ^K reaches the shell
  assert.equal(isPaletteChord(ev({ key: 'P', ctrlKey: true, shiftKey: true, inTerminal: true }), false), true);
  assert.equal(isPaletteChord(ev({ metaKey: true, inTerminal: true }), true), true);
  assert.equal(isPaletteChord(ev({ key: 'P', metaKey: true, shiftKey: true }), true), true);
  assert.equal(isPaletteChord(ev({ ctrlKey: true }), true), false); // ⌃K stays free on macOS
  assert.equal(isPaletteChord(ev({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(isPaletteChord(ev({ ctrlKey: true, shiftKey: true }), false), false); // Ctrl+Shift+K is keyboard mode's kill
});
test('font stacks cover every OS and CSS uses them', () => {
  for (const f of ['Cascadia Mono', 'DejaVu Sans Mono']) assert.ok(MONO_FONT_STACK.includes(f));
  for (const f of ['Segoe UI', 'Cantarell']) assert.ok(UI_FONT_STACK.includes(f));
  const css = ['base.css', 'theme.css', 'components.css'].map((f) => readFileSync(`apps/desktop/src/styles/${f}`, 'utf8').replace(/\s+/g, ' ')).join('\n');
  assert.ok(css.includes(MONO_FONT_STACK)); assert.ok(css.includes(UI_FONT_STACK));
  assert.doesNotMatch(css, /'SF Mono', 'Fira Code'/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:scripts`
Expected: FAIL — `Cannot find module …/shortcutRules.ts`

- [ ] **Step 3: Implement**

`isPaletteChord`: `mod = isMac ? metaKey : ctrlKey`; false with Alt or without `mod`; `key.toLowerCase() === 'p' && shiftKey` → true; `key.toLowerCase() === 'k' && !shiftKey` → `isMac || !inTerminal`. `useAppShortcuts` computes `inTerminal = (event.target as Element | null)?.closest?.('.xterm') != null` and replaces its `key === 'k'` branch with `isPaletteChord(…, IS_MAC)`. `GLOBAL_SHORTCUTS` palette entry keys become `[`${MOD}+k`, `${MOD}+shift+p`]` (same label, so no new string). CSS stacks: every mono `font-family` / `--font-mono` becomes `MONO_FONT_STACK`'s list, the `body` stack `UI_FONT_STACK`'s list (written on one line so the test's whitespace normalisation matches). `NERD_FONT_STACK` inserts `"Cascadia Mono", "DejaVu Sans Mono"` before `"Courier New"`. The three Monaco components import `MONO_FONT_STACK`. Notification fallback: in the `catch` of `deliver`, keep the `console.warn` and add `useAppStore.getState().pushToast('info', notification.title)`. Mock platform: `/Mac/.test(ua) ? 'macos' : /Windows/.test(ua) ? 'windows' : 'linux'`.

- [ ] **Step 4: Run the tests and checks**

Run: `pnpm test:scripts && pnpm typecheck && pnpm i18n:check && pnpm --filter @kubepit/desktop build`
Expected: PASS; `pnpm dev:ui` on macOS looks unchanged (`JetBrains Mono` still first).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/shortcutRules.ts apps/desktop/src/lib/fonts.ts scripts/test/platform-ui.test.mjs apps/desktop/src/components/app/useAppShortcuts.ts apps/desktop/src/lib/keymap.ts apps/desktop/src/styles apps/desktop/src/components/workbench/dock/shared/xtermUtils.ts apps/desktop/src/components/workbench/common apps/desktop/src/components/alerts/useAlertNotifications.ts apps/desktop/src/lib/ipc/mock/app.ts
git commit -m "fix(ui): terminal-safe palette chord, per-OS fonts, notification fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Window chrome and WebView2 keys

**Files:**
- Create: `apps/desktop/src-tauri/src/webview_prefs.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/lib.rs` (`mod webview_prefs;`), `apps/desktop/src-tauri/src/setup.rs`, `apps/desktop/src-tauri/src/windows.rs:116-118`, `apps/desktop/src/components/TitleBar.tsx:18-28,54`

**Interfaces:**
- Consumes: `tauri::WebviewWindow::with_webview`, `PlatformWebview::controller()` (Windows).
- Produces: `pub(crate) fn harden(window: &tauri::WebviewWindow)` — Windows release builds: `controller.CoreWebView2()?.Settings()?.cast::<ICoreWebView2Settings3>()?.SetAreBrowserAcceleratorKeysEnabled(false)`; failures logged; no-op on other OSes and in debug builds (`cfg(debug_assertions)`).

- [ ] **Step 1: Write the verification first (no automated UI test exists for chrome)**

Add to `docs/QA-CROSS-PLATFORM.md` (created in Task 11; create the file now with this section) under "Window chrome": Windows release build — `Ctrl+R`, `F5`, `Ctrl+P`, `Ctrl+F`, `F7` do nothing; `Ctrl+=`/`Ctrl+-`/`Ctrl+0` still zoom; copy/paste in inputs and terminals still work; the title bar strip shows the palette button and the connection badge, with no empty 76 px gutter; dragging the native title bar and Snap Layouts work; same on Linux (X11 and Wayland) for the strip.

- [ ] **Step 2: Implement**

`Cargo.toml`: `[target.'cfg(windows)'.dependencies] webview2-com = "0.39"`, `windows-core = "0.62"` (both already in `Cargo.lock` through wry). `setup.rs`: after `app.manage`, `if let Some(main) = app.get_webview_window("main") { crate::webview_prefs::harden(&main) }`. `windows.rs`: keep the built window (`let window = builder.build()…?;`) and call `harden(&window)`. `TitleBar.tsx`: remove `if (!IS_MAC) return null`; render the gutter `<div className="w-[76px] …">` only when `IS_MAC`, and spread `data-tauri-drag-region` only when `IS_MAC` (`{...(IS_MAC ? { 'data-tauri-drag-region': true } : {})}`); update the doc comment.

- [ ] **Step 3: Run the checks**

Run: `cargo clippy --workspace --all-targets -- -D warnings && pnpm typecheck && pnpm --filter @kubepit/desktop build`
Expected: PASS; after pushing **(user)**, `rust (windows-2022)` compiles `webview_prefs.rs`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml Cargo.lock apps/desktop/src-tauri/src/webview_prefs.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/setup.rs apps/desktop/src-tauri/src/windows.rs apps/desktop/src/components/TitleBar.tsx docs/QA-CROSS-PLATFORM.md
git commit -m "fix(windows): no browser keys in release builds; title bar on every OS" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Required Windows CI, package smoke builds, QA checklist and docs

**Files:**
- Modify: `.github/workflows/ci.yml`, `scripts/ci/test/workflows.test.mjs`, `docs/QA-CROSS-PLATFORM.md`, `docs/ARCHITECTURE.md` (Terminals, Connectivity → OS keychain, Custom actions, Updates, Persistence), `README.md` (Development requirements)

**Interfaces:**
- Consumes: `ci.yml` jobs from the CI plan and Tasks 1 and 7.
- Produces: `rust` matrix with `windows-2022` `experimental: false`; job `package-smoke` (artifacts `package-<os>`).

- [ ] **Step 1: Write the failing invariant tests**

```js
test('windows is a required rust job', () => {
  const ci = readWorkflow('ci.yml');
  assert.match(ci, /os: windows-2022,\s*experimental: false/);
  assert.doesNotMatch(ci, /experimental: true/);
});
test('package smoke builds run outside PRs on every OS', () => {
  const ci = readWorkflow('ci.yml');
  const job = ci.split('package-smoke:')[1] ?? '';
  for (const s of ["github.event_name != 'pull_request'", 'tauri build --debug --ci --bundles', 'upload-artifact', 'ubuntu-22.04', 'macos-14', 'windows-2022'])
    assert.ok(job.includes(s), s);
});
test('node checks run on Windows', () => assert.match(readWorkflow('ci.yml').split('node-windows:')[1] ?? '', /pnpm i18n:check/));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:scripts`
Expected: FAIL — `experimental: true` still present; no `package-smoke:`.

- [ ] **Step 3: Implement**

Flip `windows-2022` to `experimental: false` (keep the key for future OSes). `package-smoke`: `if: github.event_name != 'pull_request'`, matrix (`macos-14` → `app,dmg`; `windows-2022` → `nsis`; `ubuntu-22.04` → `appimage,deb,rpm`), setup (`linux-deps: 'true'`), `pnpm --filter @kubepit/desktop tauri build --debug --ci --bundles <list>`, upload `target/debug/bundle/**` as `package-<os>` (retention 7 days). No secrets.

`docs/QA-CROSS-PLATFORM.md`, one checklist per OS (Windows 11, Ubuntu 24.04 X11 + Wayland, Fedora for rpm, macOS as the baseline), each item a `- [ ]` with the expected result. Preamble: use only local throwaway clusters (kind, k3d, minikube) and `KUBEPIT_HOME` pointed at a scratch folder; never production kubeconfigs. Sections: Install and first launch (DMG / NSIS per-user without UAC / AppImage / deb / rpm; no console window; fonts); Tools and PATH (Settings → Tools finds kubectl and helm installed via WinGet/scoop/Chocolatey/Homebrew/Linuxbrew/krew; an exec-plugin cluster connects without a console flash); Terminals (local shell per OS default, pod exec/attach, node shell, resize, `Ctrl+C`, `Ctrl+K` reaches the shell on Windows/Linux, `Ctrl+Shift+P` opens the palette, copy/paste chords); Custom actions (terminal and background with Git for Windows; without it the error names Git for Windows; a `sleep 600` action times out and leaves no `sleep.exe`/`sh.exe` in Task Manager); Kubeconfig watch (editing `~/.kube/config` shows the notice); Keychain mode (toggle on/off per OS; Linux without a keyring shows the unavailable error and keeps files; a kubeconfig with embedded certificates > 2.5 KB round-trips on Windows); Permissions (`icacls "%USERPROFILE%\.kubepit"` lists only the user and SYSTEM, inherited by `kubeconfigs\`; Linux `stat -c %a ~/.kubepit/kubeconfigs` → `700`, files `600`); Notifications (Settings → Notifications → test; Windows shows "Kubepit" only for installed builds; Linux without a daemon shows a toast); Updater (install the previous release, then: macOS app, Windows NSIS closes and reopens, AppImage self-replaces, deb/rpm pkexec prompt or the "cannot update itself" message); Window chrome (Task 10's section); Multiple windows; HiDPI (Windows 125 % / 150 %, GNOME fractional scaling); Troubleshooting (`WEBKIT_DISABLE_DMABUF_RENDERER=1` for blank windows on NVIDIA + Wayland).

`docs/ARCHITECTURE.md`: short platform notes where the behaviour lives (PATH import per OS and `KUBE_RS_UNSTABLE_CREATE_NO_WINDOW`; AppImage child env; Windows sh discovery and tree kill; owner-only DACL; `SELFTEST_SERVICE`; `UpdaterStatus.bundle`). `README.md`: per-OS requirements (Linux packages from the composite action, Windows: WebView2 runtime, Git for Windows for custom actions).

- [ ] **Step 4: Run all checks**

Run: `pnpm test:scripts && actionlint && pnpm typecheck && pnpm i18n:check && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && pnpm --filter @kubepit/desktop build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml scripts/ci/test/workflows.test.mjs docs/QA-CROSS-PLATFORM.md docs/ARCHITECTURE.md README.md
git commit -m "ci: require Windows, add package smoke builds and the cross-platform QA checklist" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (user): Push, protect, run QA**

Push; confirm every `ci` job is green on all three OSes, add `rust (windows-2022)`, `node-windows` and `keyring-it` to the required checks, then run `docs/QA-CROSS-PLATFORM.md` with the `package-<os>` artifacts from `main`. File any failure as its own fix with a `cfg`-gated regression test.
