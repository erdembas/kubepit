# Linux and Windows validation — design

Status: proposed · Date: 2026-09-28 · Plan: `docs/superpowers/plans/2026-09-28-cross-platform-validation.md`
Depends on: `2026-09-28-ci-and-signed-releases-design.md` (its `ci.yml`, composite setup action and `pnpm test:scripts`).

## Problem

Kubepit is developed and used on macOS. The code already anticipates other
platforms in places (`cfg(windows)` branches in `terminal/shell.rs`,
`tools.rs`, `custom_actions/runner.rs`; the Windows 2.5 KB credential split in
`secrets.rs`; the macOS-only title bar in `components/TitleBar.tsx`), but none
of it has been built, tested or run on Linux or Windows. A code read finds
concrete defects:

| Area | Defect (file) |
|------|---------------|
| Repo | No `.gitattributes`: Windows checkouts get CRLF, while `rustfmt.toml` demands `newline_style = "Unix"` and tests compare `include_str!` fixtures. |
| i18n guard | `scripts/check-i18n.mjs:19` uses `new URL(…).pathname` → `/C:/…` on Windows, so `pnpm i18n:check` cannot find the catalogs. |
| PATH | `shell_env::merge_paths` splits and joins on `:`; Windows is skipped entirely, so WinGet/scoop/Chocolatey/krew tools installed after login are missed; krew (`~/.krew/bin`) and Rancher Desktop (`~/.rd/bin`) are missing on every OS. |
| Exec plugins | kube-rs spawns `aws.exe` / `kubelogin.exe` / `gke-gcloud-auth-plugin.exe` without `CREATE_NO_WINDOW` unless `KUBE_RS_UNSTABLE_CREATE_NO_WINDOW=1`: a console window flashes on every token refresh in the GUI app. |
| Custom actions | Windows needs `sh` on `PATH`, which Git for Windows does not add by default; a timeout kills only `sh.exe`, not its children (`kill_group` is a no-op). |
| Shell command | `terminal/shell.rs::shell_command_for` always appends `-c`, which `cmd.exe` does not understand. |
| Permissions | 0600/0700 are applied only under `cfg(unix)`; on Windows credentials rely on whatever ACL the parent directory has, which is wrong when `KUBEPIT_HOME` is relocated. |
| AppImage | Children (kubectl, helm, the user's shell) inherit the AppImage runtime's `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`, GTK variables pointing into the mount. |
| Shortcuts | On Windows/Linux `Ctrl+K` opens the palette even inside a terminal, stealing readline's kill-line. WebView2 keeps browser keys: `Ctrl+R`/`F5` reload the UI (dropping terminals), `Ctrl+P` prints, `Ctrl+F` opens a find bar. |
| Chrome | The title bar with the palette button and the connection badge renders only on macOS; Windows/Linux have no clickable palette entry. |
| Fonts | Stacks name only macOS fonts; offline Windows falls back to whatever `monospace` is. |
| Notifications | A failed OS notification (no Linux notification daemon) is only logged. |
| Updater | `.deb`/`.rpm` installs get `TargetsNotFound` from the feed (by design of the CI plan) and would show a raw error. |

## Goals

1. `cargo clippy` and `cargo test` pass on `ubuntu-22.04` and `windows-2022`,
   and the Windows CI job becomes required.
2. Each item in the table above is fixed or explicitly decided, with a unit
   test behind `cfg` where the behaviour is OS-specific.
3. The real OS credential stores are exercised by an opt-in integration test
   in CI (never on a developer machine by accident).
4. A manual QA checklist covers what automation cannot (installers, window
   chrome, notifications, updater per install kind, HiDPI, Wayland).

## Non-goals

- Signing and packaging (CI plan). arm64 Windows/Linux.
- A PowerShell or cmd flavour of custom actions; WSL integration.
- Custom (frameless) window chrome on Windows/Linux.
- Flatpak (see the CI spec, D17).
- Translating backend error strings (existing convention: backend errors are
  English; the UI translates only the ones it recognises).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Build on the CI plan's `ci.yml`: flip `experimental` for `windows-2022` to `false` at the end, add `node-windows`, `keyring-it` and `package-smoke` jobs. | One workflow, one composite setup action; the Windows job becomes a gate only once it is green. |
| D2 | `.gitattributes`: `* text=auto eol=lf`, binaries (`*.png *.icns *.ico *.woff2`) as `binary`. | Matches `.editorconfig` and `rustfmt.toml`; keeps `include_str!` fixtures byte-identical on every OS. |
| D3 | PATH: macOS/Linux keep the login-shell probe and gain `~/.krew/bin`, `~/.rd/bin` and (Linux) Linuxbrew and Nix profile directories. Windows does **not** probe a shell (Explorer hands GUI apps the registry environment and refreshes it on `WM_SETTINGCHANGE`) but appends `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%USERPROFILE%\scoop\shims`, `%ProgramData%\chocolatey\bin`, `%ProgramFiles%\Docker\Docker\resources\bin`, `~\.krew\bin`, `~\.rd\bin`. Separators come from `std::env::split_paths` / `join_paths`. | Covers the package managers that install `kubectl`, `helm` and exec plugins on each OS without spawning anything new. |
| D4 | On Windows, startup sets `KUBE_RS_UNSTABLE_CREATE_NO_WINDOW=1` (before any thread), next to the PATH import. | kube-rs gates `CREATE_NO_WINDOW` behind that variable because it breaks stderr inheritance for interactive plugins run from a console; Kubepit is a GUI app without a console, so there is nothing to inherit and the flashing window is the only visible effect. |
| D5 | Inside an AppImage (`APPIMAGE` and `APPDIR` set), every child Kubepit spawns itself (tools, custom action runs, PTYs) gets an environment without the runtime's injections: entries under `$APPDIR` removed from path lists, variables pointing into `$APPDIR` removed, `APPDIR`/`APPIMAGE`/`ARGV0`/`OWD` removed. Kubepit's own process keeps them, and exec plugins spawned by kube-rs are left alone. | WebKitGTK needs those variables in our process; children must see the user's environment. Exec plugins are mostly static Go binaries and kube-rs builds their `Command`; `ExecConfig::drop_env` remains a later option. |
| D6 | Custom actions on Windows keep requiring a POSIX `sh`, now discovered automatically: `sh` on `PATH`, then Git for Windows next to `git.exe` on `PATH` (`<root>\bin\sh.exe`, `<root>\usr\bin\sh.exe`), then `%ProgramFiles%\Git\bin\sh.exe` and `%LOCALAPPDATA%\Programs\Git\bin\sh.exe`. A timeout kills the process tree with `taskkill /T /F /PID`. Settings → Custom actions says so on Windows. | The template engine quotes per POSIX `sh` context (`custom_actions/template.rs`) and k9s imports are `sh -c` scripts; a PowerShell flavour would need a second quoting engine, a second import mapping and a second hostile-value test suite. WSL is rejected: its `sh` runs in a VM where `C:\…\run\<id>.kubeconfig` and `kubectl.exe` are foreign paths, and `wsl.exe` adds seconds of startup. Git for Windows is what k9s users on Windows already have. |
| D7 | Windows "0600": the data directory root, `kubeconfigs/`, `run/` and Helm scratch directories get a **protected DACL** granting full control only to the current user and SYSTEM, inheritable, via `windows-sys` (already in `Cargo.lock`). Files inherit it, so the temp file `atomic_write` creates is never readable by others. | `%USERPROFILE%` is private by default, but `KUBEPIT_HOME` may point anywhere (e.g. `D:\` where Users can read). `icacls` would be slower and fragile with localized account names; doing nothing is unsafe when relocated. |
| D8 | Keyring: keep `keyring` 4 with the `v1` feature (Keychain, Credential Manager, zbus Secret Service). `KeyringSecretStore` gains a service name so an opt-in integration test can use `io.github.erdembas.kubepit.selftest`; CI runs it on all three OSes (Linux under `dbus-run-session` with an unlocked `gnome-keyring`) and checks that a missing Secret Service is reported clearly. | Verifies the Windows chunking (entries capped at 2 048 bytes against the 2 560-byte `CRED_MAX_CREDENTIAL_BLOB_SIZE`) against the real API, never touching the app's own entries. |
| D9 | Terminals: default shells stay pwsh → powershell → cmd (Windows) and `$SHELL` → bash → sh (Linux). `shell_command_for` uses `/C` for cmd and `-Command` for PowerShell. ConPTY behaviour gets `cfg(windows)` tests. | Makes the one shell-specific assumption explicit and covers ConPTY the way the Unix PTY is covered today. |
| D10 | Window chrome: native decorations on Windows/Linux (the `titleBarStyle`, `hiddenTitle` and `trafficLightPosition` keys are macOS-only and ignored elsewhere). `TitleBar` renders on every OS; the 76 px traffic-light gutter and the `data-tauri-drag-region` attributes only on macOS. | Keeps the palette button and the connection badge everywhere; custom chrome would lose Windows Snap Layouts and behave differently per Linux window manager. |
| D11 | Release builds on Windows disable WebView2 browser accelerator keys (`ICoreWebView2Settings3::SetAreBrowserAcceleratorKeysEnabled(false)` through `WebviewWindow::with_webview`) for `main` and every `win-*` window; debug builds keep them for devtools. | Reload, print, find bar and caret browsing make no sense in the app and reload loses terminals and unsaved editors; editing keys (copy, paste, select all) are unaffected. |
| D12 | Shortcuts: on Windows/Linux the palette chord `Ctrl+K` is not taken while focus is inside a terminal (`.xterm`), so `^K` reaches the shell; `Mod+Shift+P` opens the palette from anywhere, including terminals, on every OS. The rule lives in a dependency-free `lib/shortcutRules.ts` tested with Node's type stripping. | Other global chords already yield to editable targets; only the palette chord was taken everywhere. `Ctrl+Shift+P` is the palette chord Windows/Linux users know from VS Code. |
| D13 | Fonts: body stack adds `Segoe UI Variable Text`, `Segoe UI`, `Ubuntu`, `Cantarell`, `Noto Sans`; mono stacks add `Cascadia Mono`, `Consolas`, `DejaVu Sans Mono`, `Liberation Mono`; one `MONO_FONT_STACK` for Monaco. | Predictable rendering offline on each OS without bundling fonts. |
| D14 | A failed OS notification falls back to the in-app toast with the same title. | No notification daemon (minimal Linux desktops) or unpackaged Windows builds must not lose alerts silently. |
| D15 | Updater: `UpdaterStatus` gains `bundle` (`app`, `appimage`, `deb`, `rpm`, `nsis`, `msi`, or `null` for unbundled builds, from `tauri::utils::platform::bundle_type()`). `TargetsNotFound` becomes the stable message `The release feed has no update package for this installation type`, which the UI translates. The About page adds a hint for `deb`/`rpm` (pkexec asks for the administrator password) and `nsis` (the installer closes and reopens Kubepit). | The plugin picks feed entries by install kind; users should know why an update cannot install and what happens when it does. |
| D16 | Linux WebKitGTK blank-window issues (NVIDIA + Wayland) are documented (`WEBKIT_DISABLE_DMABUF_RENDERER=1`), not worked around automatically. | Changing renderer flags for everyone to fix some drivers risks regressions; open question. |

## Architecture

```
crates/kubepit-core/src/
├── shell_env.rs          prepare_gui_environment(): PATH import per OS + Windows env overrides
├── child_env.rs   (new)  AppImage fixes applied to every child we spawn
├── tools.rs              search_path_in(): testable PATH lookup (.exe / .cmd, exec bit)
├── custom_actions/runner.rs  POSIX sh discovery, Windows tree kill
├── paths.rs              set_private_dir(): 0700 on Unix, owner-only DACL on Windows
├── win_acl.rs     (new, cfg(windows))  DACL helpers over windows-sys
├── secrets.rs            KeyringSecretStore { service }
└── updates.rs            UpdaterStatus.bundle, NO_UPDATE_PACKAGE
crates/kubepit-core/tests/keyring_os.rs (new)  opt-in real-store test
apps/desktop/src-tauri/src/
├── setup.rs              prepare_gui_environment(), harden(main)
├── webview_prefs.rs (new) WebView2 accelerator keys off in release builds
├── windows.rs            harden(new windows)
├── terminal/shell.rs     command flag per shell
├── terminal/manager.rs   child_env fixes; ConPTY tests
└── ipc/updater.rs        bundle name, TargetsNotFound message
apps/desktop/src/
├── lib/shortcutRules.ts (new), lib/fonts.ts (new)
├── components/app/useAppShortcuts.ts, lib/keymap.ts
├── components/TitleBar.tsx
├── components/settings/{UpdatesSection,CustomActionsCategory}.tsx, store/useUpdaterStore.ts
├── components/alerts/useAlertNotifications.ts
└── styles/{base,theme,components}.css
docs/QA-CROSS-PLATFORM.md (new)
```

## UX

- Windows/Linux get the title bar strip (palette button, connection badge)
  under the native title bar.
- `Ctrl+K` inside a terminal goes to the shell on Windows/Linux;
  `Ctrl+Shift+P` / `⌘⇧P` opens the palette anywhere. Shown in Settings →
  Keyboard (from `GLOBAL_SHORTCUTS`).
- Settings → Custom actions (Windows): "Custom actions run through a POSIX sh.
  On Windows, install Git for Windows; Kubepit finds its sh.exe automatically."
- Settings → About & Updates: install-kind hints and a translated message
  when the feed has no package for this install.
- Everything else is invisible when it works: no console flashes, tools
  found, fonts consistent, alerts never lost.

New strings (English source → Turkish):

| English | Turkish |
|---------|---------|
| Custom actions run through a POSIX sh. On Windows, install Git for Windows; Kubepit finds its sh.exe automatically. | Özel eylemler bir POSIX sh üzerinden çalışır. Windows'ta Git for Windows'u kurun; Kubepit sh.exe dosyasını kendiliğinden bulur. |
| Installing an update asks for your administrator password. | Güncellemeyi yüklemek yönetici parolanızı ister. |
| The installer closes Kubepit and opens the new version. | Yükleyici Kubepit'i kapatır ve yeni sürümü açar. |
| This installation cannot update itself. Download the new version from GitHub or update it with your package manager. | Bu kurulum kendini güncelleyemez. Yeni sürümü GitHub'dan indirin veya paket yöneticinizle güncelleyin. |

## Data / contract changes

- IPC: `UpdaterStatus.bundle: 'app' | 'appimage' | 'deb' | 'rpm' | 'nsis' | 'msi' | null`
  in `apps/desktop/src/types/index.ts`, `kubepit_core::updates::UpdaterStatus`
  (`Option<String>`) and `src/lib/ipc/mock/updates.ts` (`null`). No new commands.
- Rust API: `KeyringSecretStore` becomes `{ service: &'static str }` with
  `Default`; `setup.rs` uses `KeyringSecretStore::default()`.
- Dependencies: `kubepit-core` gets `windows-sys = "0.61"` (Windows only);
  `kubepit-desktop` gets `webview2-com = "0.39"` and `windows-core = "0.62"`
  (Windows only). All three versions are already in `Cargo.lock`.
- No persisted format changes.

## Security and safety

- Owner-only ACLs on Windows (D7); Unix modes unchanged.
- The keyring integration test uses a separate service name, runs only with
  `KUBEPIT_KEYRING_IT` set, deletes what it writes, and runs in CI on
  ephemeral runners. The default `cargo test` never touches an OS store
  (`Kubepit::open` keeps `DisabledSecretStore`).
- QA uses local throwaway clusters (kind, k3d, minikube) and a dedicated
  `KUBEPIT_HOME`; never production kubeconfigs.
- Custom action quoting is unchanged; the Windows `sh` is found only in fixed
  locations or on `PATH`, never from the current directory (empty `PATH`
  segments stay dropped).
- `read_only` enforcement untouched.

## Testing strategy

- Rust unit tests behind `cfg(windows)` / `cfg(target_os = "linux")` /
  `cfg(unix)` for PATH merging, tool lookup, sh discovery, tree kill, shell
  flags, ConPTY, DACLs, bundle names and error mapping. Pure helpers take their
  inputs (home, env lookups, `PATH` value) so they are testable on every OS.
- `crates/kubepit-core/tests/keyring_os.rs`, ignored by default, run by the
  `keyring-it` CI job.
- `scripts/test/*.test.mjs` for the i18n root resolution, `.gitattributes`,
  shortcut rules and font stacks (Node ≥22.18 strips TS types natively).
- CI: Windows `rust` job required; `node-windows` runs `pnpm i18n:check` and the
  script tests on Windows; `package-smoke` builds debug bundles on each OS on
  `main` for QA downloads.
- `docs/QA-CROSS-PLATFORM.md` for manual runs before each release.

## Rollout

Land tasks in plan order; each keeps `main` green on macOS and Linux. After the
last task the Windows job is required. Run the QA checklist on Windows 11 and
Ubuntu 24.04 (X11 and Wayland) with the `package-smoke` artifacts, then with
the first prerelease from the CI plan.

## Open questions

1. Bundle JetBrains Mono locally (OFL) instead of Google Fonts, for offline use and privacy?
2. Set `WEBKIT_DISABLE_DMABUF_RENDERER=1` automatically when NVIDIA + Wayland is detected?
3. A Settings field for the POSIX `sh` path on Windows (an IPC change), or is discovery enough?
4. Windows DACL: user + SYSTEM only (as proposed), or also `BUILTIN\Administrators` like the profile default?
5. Is `Mod+Shift+P` acceptable as the palette alias, or should terminals simply keep `Ctrl+K` with no alias?
