# CI and Signed Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the six checks on Linux, macOS and Windows for every PR and `main`, and turn a `vX.Y.Z` tag into a signed, updater-ready draft GitHub release that also feeds a Homebrew tap and winget.

**Architecture:** Workflow logic lives in small Node ≥22 ESM scripts under `scripts/release/` (built-ins only, `node:test` tests); the workflows under `.github/` only wire them together around `pnpm --filter @kubepit/desktop tauri build`. A shared composite action sets up pnpm, Node, Rust and caches. `latest.json` is generated and validated by our scripts and checked against `tauri-plugin-updater`'s own parser in a Rust test.

**Tech Stack:** GitHub Actions, `actionlint`, Node 22 (`node:test`, `node:crypto`, `node:fs`), Tauri CLI 2, `gh` CLI, Rust (`serde_json`, `tauri-plugin-updater` 2.11), Homebrew casks, komac (winget).

**Spec:** `docs/superpowers/specs/2026-09-28-ci-and-signed-releases-design.md`

## Global Constraints

- IPC contract: `apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts` define every frontend ⇄ backend command; change both sides (and `src/lib/ipc/mock/`) in the same change. This plan changes no command.
- Design: the UI stays visually identical to RunHQ (`src/styles/theme.css` tokens, `src/components/ui/` primitives, 11–13px text); no chart or UI libraries.
- i18n: every user-visible string ships in English and Turkish in the same change (`src/i18n/{en,tr}/{shell,workbench,dock}.json`); `pnpm i18n:check` must pass. This plan adds no UI strings.
- Safety: never connect to real clusters from tests, scripts or CI; tests use fixtures, the fake API server (`crates/kubepit-core/tests/support/mod.rs`) and `KUBEPIT_HOME`/explicit temp paths. No job reads `~/.kube` or holds cluster credentials.
- Mutating backend commands honour `ClusterDef.read_only`.
- Background work is opt-in per process (`set_alert_monitoring`, `set_change_journal_recording`, `set_history_recording` only in `apps/desktop/src-tauri/src/setup.rs`).
- Layouts that adapt to space use container queries.
- The six checks pass before every commit that touches code: `pnpm typecheck`, `pnpm i18n:check`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `pnpm --filter @kubepit/desktop build`.
- Scripts: Node ≥22 ESM (`.mjs`), built-in modules only, no new npm or cargo dependencies. Each script exports pure functions and runs its CLI only when executed directly (`import.meta.url === pathToFileURL(process.argv[1]).href`).
- Never generate, commit or print keys, certificates or tokens. Secrets and variables are referenced by name only; fixtures use dummy strings (`dW50cnVzdGVkIGNvbW1lbnQ=`) or keys generated in memory at test time.
- Every third-party action is pinned to a full 40-hex commit SHA with a `# vX.Y.Z` comment (look it up with `gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha`, dereferencing annotated tags).
- No git remote is configured in this worktree: pushing, branch protection, secrets/variables, the tap repository and the winget fork are user actions. Steps that need them are marked **(user)**.
- Runners: `ubuntu-22.04`, `macos-14`, `windows-2022`; Node `22`; Rust `stable` (MSRV stays 1.89 via `clippy.toml`).
- Canonical asset names (exact): `Kubepit_<v>_universal.dmg`, `Kubepit_<v>_universal.app.tar.gz`, `Kubepit_<v>_x64-setup.exe`, `Kubepit_<v>_amd64.AppImage`, `Kubepit_<v>_amd64.deb`, `Kubepit-<v>-1.x86_64.rpm`; each updater bundle has `<name>.sig`.
- Feed base URL: `https://github.com/erdembas/kubepit/releases/download/v<version>/`.

## Review Focus

- A `.deb` or `.rpm` install checking for updates must never be handed the AppImage: `latest.json` has no generic `linux-<arch>` key (Task 4: validator test and the Rust fixture test asserting `download_url("linux-x86_64")` fails).
- An updater private key that does not match `TAURI_UPDATER_PUBKEY` must stop the release before upload (Task 3: wrong-key verification test; Task 6: the build job runs `minisign.mjs verify`).
- A tag that disagrees with any version file must fail the release in `prepare`, naming the file (Task 1: mismatch tests).
- A fork or a repository without secrets must build unsigned instead of failing, and CI for PRs never reads secrets (Task 2: `overlayFromEnv` tests; Task 5: no `secrets.` in `ci.yml`).
- Re-running a failed release must reuse the draft and replace assets instead of erroring on "already exists" (Task 6: `gh release view` guard and `--clobber` asserted).

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `package.json` (modify) | `test:scripts`, `release:check`, `release:bump` scripts |
| `CHANGELOG.md` (create) | Keep a Changelog history; source of release notes |
| `scripts/release/versions.mjs` | read / check / bump the five version files, tag parsing |
| `scripts/release/changelog.mjs` | extract a version's notes, promote `[Unreleased]` |
| `scripts/release/tauri-config.mjs` | release `--config` overlay from env |
| `scripts/release/collect-artifacts.mjs` | find bundles, canonical names, sha256, manifest, `SHA256SUMS` |
| `scripts/release/minisign.mjs` | verify updater `.sig` files against the public key |
| `scripts/release/latest-json.mjs` | build `latest.json` from manifests |
| `scripts/release/validate-latest-json.mjs` | validate `latest.json` |
| `scripts/release/homebrew-cask.mjs` | render `Casks/kubepit.rb` |
| `scripts/release/fixtures/latest.valid.json` | feed fixture shared by Node and Rust tests |
| `scripts/release/fixtures/overlay.example.json` | overlay fixture shared by Node and Rust tests |
| `scripts/release/test/*.test.mjs` | one test file per script |
| `scripts/ci/test/workflows.test.mjs` | invariants over `.github/` and `docs/RELEASING.md` |
| `apps/desktop/src-tauri/src/ipc/updater.rs:125-151` (modify) | two Rust tests: overlay enables updates, plugin parses the feed |
| `.github/actions/setup/action.yml` | composite setup (pnpm, Node, Rust, caches, Linux deps) |
| `.github/workflows/ci.yml` | checks on PRs and `main` |
| `.github/workflows/release.yml` | tag / dispatch release: prepare → build → finalize |
| `.github/workflows/distribute.yml` | tap + winget on `release: published` |
| `.github/dependabot.yml` | weekly `github-actions` updates |
| `docs/RELEASING.md` (rewrite) | setup, secrets, signing, versioning, release, dry run, distribution |
| `README.md` (modify) | CI badge, Install section |

---

### Task 1: Version files, changelog and the script test harness

**Files:**
- Create: `scripts/release/versions.mjs`, `scripts/release/changelog.mjs`, `CHANGELOG.md`
- Modify: `package.json` (scripts)
- Test: `scripts/release/test/versions.test.mjs`, `scripts/release/test/changelog.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `VERSION_FILES: ReadonlyArray<{ path: string, kind: 'json' | 'cargo' }>` in order `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `crates/kubepit-core/Cargo.toml` (the first is the reference).
  - `readVersions(root: string): Array<{ path: string, version: string }>`
  - `checkVersions(root: string, tag?: string): string` — the common version; throws on mismatch.
  - `bumpVersions(root: string, version: string): string[]` — changed paths.
  - `parseTag(tag: string): string`, `isPrerelease(version: string): boolean`
  - `extractNotes(text: string, version: string): string`, `promoteUnreleased(text: string, version: string, date: string): string`
  - CLIs: `node scripts/release/versions.mjs check [--tag vX.Y.Z]` (prints the version), `node scripts/release/versions.mjs prerelease X.Y.Z` (prints `true` or `false`), `node scripts/release/versions.mjs bump X.Y.Z`, `node scripts/release/changelog.mjs extract X.Y.Z` (prints notes).

- [ ] **Step 1: Write the failing tests**

`makeRepo(dir, version)` (test helper) writes the five files with realistic shapes: a `tauri.conf.json` whose only `"version"` is top-level, Cargo manifests with `[package] version = "…"` followed by `[dependencies] serde = { version = "1" }` and `[build-dependencies] tauri-build = { version = "2" }`.

```js
test('all files agree', () => assert.equal(checkVersions(repo('0.1.0')), '0.1.0'));
test('a mismatch names the file and the reference', () => {
  const root = repo('0.1.0'); setVersion(root, 'apps/desktop/src-tauri/tauri.conf.json', '0.0.9');
  assert.throws(() => checkVersions(root), /apps\/desktop\/src-tauri\/tauri\.conf\.json has 0\.0\.9, expected 0\.1\.0/);
});
test('the tag must match', () =>
  assert.throws(() => checkVersions(repo('0.1.0'), 'v0.2.0'), /tag v0\.2\.0 does not match version 0\.1\.0/));
test('tags', () => {
  assert.equal(parseTag('v1.2.3'), '1.2.3'); assert.equal(parseTag('v1.2.3-rc.1'), '1.2.3-rc.1');
  assert.throws(() => parseTag('1.2.3'), /must start with "v"/); assert.throws(() => parseTag('v1.2'), /not a valid version/);
  assert.equal(isPrerelease('0.2.0-rc.1'), true); assert.equal(isPrerelease('0.2.0'), false);
});
test('bump rewrites exactly one line per file', () => {
  const root = repo('0.1.0'); const before = snapshot(root);
  assert.equal(bumpVersions(root, '0.2.0').length, 5);
  assert.equal(checkVersions(root), '0.2.0');
  for (const [path, text] of Object.entries(before)) {
    const a = text.split('\n'); const b = read(root, path).split('\n');
    assert.equal(b.length, a.length, path);
    const changed = b.filter((line, i) => line !== a[i]);
    assert.equal(changed.length, 1, path);
    assert.match(changed[0], /0\.2\.0/, path);
  }
  assert.match(read(root, 'apps/desktop/src-tauri/Cargo.toml'), /serde = \{ version = "1" \}/);
  assert.throws(() => bumpVersions(root, 'banana'), /not a valid version/);
});
```

```js
const CL = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Table export\n\n## [0.1.0] - 2026-09-01\n\n### Added\n\n- First\n';
test('extract', () => assert.equal(extractNotes(CL, '0.1.0'), '### Added\n\n- First'));
test('CRLF is normalised', () => assert.equal(extractNotes(CL.replaceAll('\n', '\r\n'), '0.1.0'), '### Added\n\n- First'));
test('missing or empty sections throw', () => {
  assert.throws(() => extractNotes(CL, '0.2.0'), /No CHANGELOG\.md section for 0\.2\.0/);
  assert.throws(() => extractNotes('## [0.2.0] - 2026-10-01\n\n## [0.1.0]\n- x\n', '0.2.0'), /section for 0\.2\.0 is empty/);
});
test('promote', () => {
  const out = promoteUnreleased(CL, '0.2.0', '2026-10-01');
  assert.match(out, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-01\n\n### Added\n\n- Table export\n\n## \[0\.1\.0\]/);
  assert.throws(() => promoteUnreleased(out, '0.3.0', '2026-10-02'), /Nothing under \[Unreleased\]/);
  assert.throws(() => promoteUnreleased(CL, '0.1.0', '2026-10-02'), /already has a section for 0\.1\.0/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "scripts/**/*.test.mjs"`
Expected: FAIL with `Cannot find module …/scripts/release/versions.mjs`

- [ ] **Step 3: Implement `scripts/release/versions.mjs` and `scripts/release/changelog.mjs`**

Version pattern: `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`. JSON files: replace the first `"version": "<old>"` textually and assert `JSON.parse(result).version === new` (re-serialising would reformat `tauri.conf.json`). Cargo files: replace the first `version = "<old>"` after the `[package]` header and before the next `[` header. The `bump` CLI also runs `promoteUnreleased` on `CHANGELOG.md` with today's UTC date and then `cargo update --workspace --offline` (it must only touch the `kubepit-core` and `kubepit-desktop` entries of `Cargo.lock`). `extractNotes` takes the lines after `## [<version>]` up to the next `## [`, trimmed; `[Unreleased]` never matches a version.

- [ ] **Step 4: Add `CHANGELOG.md` and the root scripts**

`CHANGELOG.md` opens with a Keep a Changelog header (format link, SemVer link, one sentence: "The section of a released version becomes its GitHub release notes and the notes shown in Settings → About & Updates.") followed by `## [Unreleased]`, `### Added`, `- Signed installers for macOS, Windows and Linux, in-app updates, a Homebrew cask and a winget package.`

Root `package.json` scripts: `"test:scripts": "node --test \"scripts/**/*.test.mjs\""`, `"release:check": "node scripts/release/versions.mjs check"`, `"release:bump": "node scripts/release/versions.mjs bump"`.

- [ ] **Step 5: Run the tests and the real check**

Run: `pnpm test:scripts && pnpm release:check`
Expected: all tests PASS; prints `0.1.0`.

- [ ] **Step 6: Commit**

```bash
git add package.json CHANGELOG.md scripts/release/versions.mjs scripts/release/changelog.mjs scripts/release/test/versions.test.mjs scripts/release/test/changelog.test.mjs
git commit -m "build(release): version bump/check and changelog scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Release config overlay

**Files:**
- Create: `scripts/release/tauri-config.mjs`, `scripts/release/fixtures/overlay.example.json`
- Modify: `apps/desktop/src-tauri/src/ipc/updater.rs:125-151` (tests module)
- Test: `scripts/release/test/tauri-config.test.mjs`, `apps/desktop/src-tauri/src/ipc/updater.rs` (`release_overlay_enables_the_updater`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `releaseOverlay({ pubkey?: string, macSigningIdentity?: string, windowsSignCommand?: string | null }): object`
  - `windowsSignCommand({ provider?: string, endpoint?: string, account?: string, profile?: string }): string | null`
  - `overlayFromEnv(env: Record<string, string | undefined>): object` — reads `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_UPDATER_PUBKEY`, `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `WINDOWS_SIGNING_PROVIDER`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`.
  - CLI: `node scripts/release/tauri-config.mjs` prints `overlayFromEnv(process.env)` as JSON.

- [ ] **Step 1: Write the failing Node tests**

```js
test('empty inputs give an empty overlay', () => assert.deepEqual(releaseOverlay({}), {}));
test('a pubkey enables updater artifacts', () => assert.deepEqual(releaseOverlay({ pubkey: '  KEY \n' }),
  { bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: 'KEY' } } }));
test('signing identities', () => {
  assert.deepEqual(releaseOverlay({ macSigningIdentity: 'Developer ID Application: A (T)' }),
    { bundle: { macOS: { signingIdentity: 'Developer ID Application: A (T)' } } });
  assert.deepEqual(releaseOverlay({ windowsSignCommand: 'sign %1' }), { bundle: { windows: { signCommand: 'sign %1' } } });
});
test('azure sign command', () => {
  assert.equal(windowsSignCommand({ provider: 'azure', endpoint: 'https://weu.codesigning.azure.net', account: 'acct', profile: 'prof' }),
    'trusted-signing-cli -e https://weu.codesigning.azure.net -a acct -c prof -d Kubepit %1');
  assert.equal(windowsSignCommand({ provider: 'azure', account: 'a', profile: 'p' }), null);
  assert.equal(windowsSignCommand({ provider: '' }), null);
  assert.throws(() => windowsSignCommand({ provider: 'foo' }), /Unknown WINDOWS_SIGNING_PROVIDER "foo"/);
});
test('env without the matching secrets stays unsigned', () => {
  assert.deepEqual(overlayFromEnv({ TAURI_UPDATER_PUBKEY: 'K' }), {});
  assert.deepEqual(overlayFromEnv({ APPLE_SIGNING_IDENTITY: 'X' }), {});
  assert.deepEqual(overlayFromEnv({ WINDOWS_SIGNING_PROVIDER: 'azure', AZURE_SIGNING_ENDPOINT: 'e', AZURE_SIGNING_ACCOUNT: 'a', AZURE_SIGNING_PROFILE: 'p' }), {});
  assert.equal(overlayFromEnv({ TAURI_UPDATER_PUBKEY: 'K', TAURI_SIGNING_PRIVATE_KEY: 'x' }).plugins.updater.pubkey, 'K');
});
test('fixture matches', () => assert.deepEqual(releaseOverlay({ pubkey: 'dW50cnVzdGVkIGNvbW1lbnQ=' }),
  JSON.parse(readFileSync(new URL('../fixtures/overlay.example.json', import.meta.url)))));
```

- [ ] **Step 2: Write the failing Rust test in `apps/desktop/src-tauri/src/ipc/updater.rs`**

Add a test-only `fn merge_patch(target: &mut serde_json::Value, patch: &serde_json::Value)` (RFC 7396, what `tauri build --config` applies) and:

```rust
#[test]
fn release_overlay_enables_the_updater() {
    let mut config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let overlay: serde_json::Value = serde_json::from_str(include_str!("../../../../../scripts/release/fixtures/overlay.example.json")).unwrap();
    merge_patch(&mut config, &overlay);
    let updater = UpdaterConfig::from_plugin_config(config.pointer("/plugins/updater"));
    assert!(updater.enabled());
    assert_eq!(updater.endpoint(), DEFAULT_UPDATE_ENDPOINT);
    assert_eq!(config.pointer("/bundle/createUpdaterArtifacts"), Some(&serde_json::json!(true)));
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test:scripts; cargo test -p kubepit-desktop release_overlay_enables_the_updater`
Expected: FAIL — module not found; `include_str!` cannot find `overlay.example.json`.

- [ ] **Step 4: Implement `scripts/release/tauri-config.mjs` and write the fixture**

`overlayFromEnv` uses the pubkey only when `TAURI_SIGNING_PRIVATE_KEY` is non-empty, the Apple identity only when `APPLE_CERTIFICATE` is non-empty, and the Azure command only when `AZURE_CLIENT_SECRET` is non-empty. The fixture is exactly `{"bundle":{"createUpdaterArtifacts":true},"plugins":{"updater":{"pubkey":"dW50cnVzdGVkIGNvbW1lbnQ="}}}` (pretty-printed, 2 spaces).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:scripts && cargo test -p kubepit-desktop updater`
Expected: PASS (including the existing `committed_config_is_ready_for_a_signing_key`).

- [ ] **Step 6: Commit**

```bash
git add scripts/release/tauri-config.mjs scripts/release/fixtures/overlay.example.json scripts/release/test/tauri-config.test.mjs apps/desktop/src-tauri/src/ipc/updater.rs
git commit -m "build(release): tauri --config overlay for release signing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Artifact collection and signature verification

**Files:**
- Create: `scripts/release/collect-artifacts.mjs`, `scripts/release/minisign.mjs`
- Test: `scripts/release/test/collect-artifacts.test.mjs`, `scripts/release/test/minisign.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Kind = 'dmg' | 'app' | 'nsis' | 'appimage' | 'deb' | 'rpm'`, `type Arch = 'universal' | 'aarch64' | 'x86_64'`
  - `type ArtifactEntry = { name: string, kind: Kind, arch: Arch, sha256: string, signature: string | null }`
  - `EXPECTED_KINDS = { macos: ['dmg', 'app'], windows: ['nsis'], linux: ['appimage', 'deb', 'rpm'] }`, `UPDATER_KINDS = ['app', 'nsis', 'appimage']`
  - `findBundles(bundleDir: string, platform: 'macos' | 'windows' | 'linux'): Array<{ path: string, kind: Kind, arch: Arch }>`
  - `canonicalName({ kind: Kind, arch: Arch, version: string }): string`
  - `collect({ bundleDir, platform, version, outDir, requireSignatures }): ArtifactEntry[]` — also writes `<outDir>/manifest-<platform>.json`.
  - `sha256sums(entries: ArtifactEntry[]): string`
  - `parsePublicKey(pubkeyB64: string): { keyId: Buffer, publicKey: import('node:crypto').KeyObject }`
  - `verifySignature({ data: Buffer, signatureB64: string, pubkeyB64: string }): { ok: boolean, reason?: string }`
  - `verifyManifest({ manifest: ArtifactEntry[], dir: string, pubkeyB64: string }): string[]` — failures, `[]` when all verify.
  - CLIs: `collect-artifacts.mjs --platform P --bundle-dir D --version V --out O [--require-signatures]`, `collect-artifacts.mjs sums --manifests-dir D`, `minisign.mjs verify --manifest F --dir D --pubkey B64`.

- [ ] **Step 1: Write the failing collection tests**

The helper builds Tauri's real output trees in a temp dir: `target/universal-apple-darwin/release/bundle/{dmg/Kubepit_0.2.0_universal.dmg, macos/Kubepit.app/ (a directory), macos/Kubepit.app.tar.gz, macos/Kubepit.app.tar.gz.sig}`, `target/release/bundle/nsis/Kubepit_0.2.0_x64-setup.exe{,.sig}`, `target/release/bundle/{appimage/Kubepit_0.2.0_amd64.AppImage{,.sig}, deb/Kubepit_0.2.0_amd64.deb, rpm/Kubepit-0.2.0-1.x86_64.rpm}`.

```js
test('canonical names', () => {
  const n = (kind, arch) => canonicalName({ kind, arch, version: '0.2.0' });
  assert.equal(n('dmg', 'universal'), 'Kubepit_0.2.0_universal.dmg');
  assert.equal(n('app', 'universal'), 'Kubepit_0.2.0_universal.app.tar.gz');
  assert.equal(n('nsis', 'x86_64'), 'Kubepit_0.2.0_x64-setup.exe');
  assert.equal(n('appimage', 'x86_64'), 'Kubepit_0.2.0_amd64.AppImage');
  assert.equal(n('deb', 'x86_64'), 'Kubepit_0.2.0_amd64.deb');
  assert.equal(n('rpm', 'x86_64'), 'Kubepit-0.2.0-1.x86_64.rpm');
});
test('find macOS universal bundles, ignoring the .app directory', () =>
  assert.deepEqual(findBundles(macDir, 'macos').map(({ kind, arch }) => [kind, arch]), [['dmg', 'universal'], ['app', 'universal']]));
test('collect copies, hashes and records signatures', () => {
  const entries = collect({ bundleDir: linuxDir, platform: 'linux', version: '0.2.0', outDir, requireSignatures: true });
  const appimage = entries.find((e) => e.kind === 'appimage');
  assert.equal(appimage.name, 'Kubepit_0.2.0_amd64.AppImage');
  assert.equal(appimage.sha256, sha256Of(join(outDir, appimage.name)));
  assert.equal(appimage.signature, 'SIG-APPIMAGE');
  assert.ok(existsSync(join(outDir, 'Kubepit_0.2.0_amd64.AppImage.sig')));
  assert.equal(entries.find((e) => e.kind === 'deb').signature, null);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'manifest-linux.json'))), entries);
});
test('missing bundles and signatures fail loudly', () => {
  rmSync(join(linuxDir, 'deb'), { recursive: true });
  assert.throws(() => collect({ bundleDir: linuxDir, platform: 'linux', version: '0.2.0', outDir }), /no deb bundle found in/);
  rmSync(join(macDir, 'macos/Kubepit.app.tar.gz.sig'));
  assert.throws(() => collect({ bundleDir: macDir, platform: 'macos', version: '0.2.0', outDir, requireSignatures: true }),
    /Kubepit_0\.2\.0_universal\.app\.tar\.gz has no \.sig/);
});
test('SHA256SUMS', () => assert.equal(sha256sums([{ name: 'b', sha256: '2' }, { name: 'a', sha256: '1' }]), '1  a\n2  b\n'));
```

- [ ] **Step 2: Write the failing minisign tests**

`makeKeyPair()` (test helper) uses `crypto.generateKeyPairSync('ed25519')` and a random 8-byte key id, and formats the public key and signatures exactly like Tauri (below); nothing is written to disk.

```js
test('a signature from the configured key verifies', () => {
  const k = makeKeyPair(); const data = Buffer.from('bundle');
  assert.deepEqual(verifySignature({ data, signatureB64: k.sign(data), pubkeyB64: k.pubkeyB64 }), { ok: true });
});
test('tampered data, another key, a forged comment and garbage are rejected', () => {
  const k = makeKeyPair(); const other = makeKeyPair(); const data = Buffer.from('bundle');
  assert.equal(verifySignature({ data: Buffer.from('bundle!'), signatureB64: k.sign(data), pubkeyB64: k.pubkeyB64 }).reason, 'signature does not match the data');
  assert.match(verifySignature({ data, signatureB64: other.sign(data), pubkeyB64: k.pubkeyB64 }).reason, /^signed with key [0-9A-F]{16}, expected [0-9A-F]{16}$/);
  assert.equal(verifySignature({ data, signatureB64: k.sign(data, { forgeTrustedComment: true }), pubkeyB64: k.pubkeyB64 }).reason, 'trusted comment signature does not match');
  assert.equal(verifySignature({ data, signatureB64: 'bm9wZQ==', pubkeyB64: k.pubkeyB64 }).reason, 'not a minisign signature');
});
test('verifyManifest lists the failing assets and skips unsigned ones', () => {
  // temp dir: the AppImage signed by k, the NSIS installer signed by `other`, a deb with signature: null
  const failures = verifyManifest({ manifest, dir, pubkeyB64: k.pubkeyB64 });
  assert.equal(failures.length, 1);
  assert.ok(failures[0].startsWith('Kubepit_0.2.0_x64-setup.exe: signed with key '), failures[0]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test:scripts`
Expected: FAIL with `Cannot find module …/collect-artifacts.mjs` and `…/minisign.mjs`

- [ ] **Step 4: Implement `scripts/release/collect-artifacts.mjs`**

Patterns: macOS `dmg/*.dmg` → `dmg`, `macos/*.app.tar.gz` → `app` (files only); Windows `nsis/*-setup.exe` → `nsis`; Linux `appimage/*.AppImage`, `deb/*.deb`, `rpm/*.rpm`. Arch: `universal` when `bundleDir` contains `universal-apple-darwin`, else from the file name (`aarch64`; `x64`/`amd64`/`x86_64` → `x86_64`). A `<file>.sig` next to a bundle is copied as `<canonical>.sig` and its trimmed text becomes `signature`. `requireSignatures` applies to `UPDATER_KINDS`.

- [ ] **Step 5: Implement `scripts/release/minisign.mjs`**

Formats (Tauri base64-encodes the whole minisign file once more):

```
pubkeyB64    = base64("untrusted comment: …\n" + base64("Ed" | keyId[8] | ed25519Pk[32]) + "\n")
signatureB64 = base64("untrusted comment: …\n" + base64(alg[2] | keyId[8] | sig[64]) + "\n"
                      + "trusted comment: <text>\n" + base64(globalSig[64]) + "\n")
alg "ED": sig = Ed25519(BLAKE2b-512(data))   alg "Ed": sig = Ed25519(data)
globalSig = Ed25519(sig[64] | <text>)
```

Build the `KeyObject` from the raw 32 bytes as a JWK (`{ kty: 'OKP', crv: 'Ed25519', x: base64url }`), hash with `createHash('blake2b512')`, verify with `crypto.verify(null, …)`. Key ids are printed as uppercase hex of the 8 bytes in reverse order (minisign's display order).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test:scripts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/release/collect-artifacts.mjs scripts/release/minisign.mjs scripts/release/test/collect-artifacts.test.mjs scripts/release/test/minisign.test.mjs
git commit -m "build(release): collect bundles and verify updater signatures" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `latest.json` builder, validator and plugin compatibility

**Files:**
- Create: `scripts/release/latest-json.mjs`, `scripts/release/validate-latest-json.mjs`, `scripts/release/fixtures/latest.valid.json`
- Modify: `apps/desktop/src-tauri/src/ipc/updater.rs` (tests module)
- Test: `scripts/release/test/latest-json.test.mjs`, `apps/desktop/src-tauri/src/ipc/updater.rs` (`release_feed_fixture_resolves_every_install_kind`)

**Interfaces:**
- Consumes: `ArtifactEntry` (Task 3).
- Produces:
  - `DOWNLOAD_BASE = 'https://github.com/erdembas/kubepit/releases/download'`
  - `buildLatestJson({ version: string, notes: string, pubDate: string, manifests: ArtifactEntry[] }): { version, notes, pub_date, platforms: Record<string, { url: string, signature: string }> }`
  - `DEFAULT_REQUIRED = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64-appimage']`
  - `validateLatestJson(doc: object, { version: string, require?: string[], assets?: string[] }): string[]` — problems, `[]` when valid.
  - CLIs: `latest-json.mjs --version V --notes-file F --manifests-dir D [--pub-date ISO]` (prints JSON), `validate-latest-json.mjs <file> --version V [--assets-file F] [--require a,b]` (exit 1 and one problem per line when invalid).

- [ ] **Step 1: Write the failing Node tests**

`SAMPLE` manifests: `app/universal` (`SIG_APP`), `dmg/universal` (null), `nsis/x86_64` (`SIG_NSIS`), `appimage/x86_64` (`SIG_APPIMAGE`), `deb/x86_64` (`SIG_DEB`), `rpm/x86_64` (null), where each `SIG_*` is `base64("untrusted comment: fixture <kind>\n")`.

```js
const fixture = JSON.parse(readFileSync(new URL('../fixtures/latest.valid.json', import.meta.url)));
test('build matches the fixture', () => assert.deepEqual(
  buildLatestJson({ version: '0.2.0', notes: '### Added\n\n- Table export', pubDate: '2026-10-01T12:00:00.000Z', manifests: SAMPLE }), fixture));
test('fixture keys', () => assert.deepEqual(Object.keys(fixture.platforms).sort(), [
  'darwin-aarch64', 'darwin-aarch64-app', 'darwin-x86_64', 'darwin-x86_64-app',
  'linux-x86_64-appimage', 'linux-x86_64-deb', 'windows-x86_64', 'windows-x86_64-nsis']));
test('the fixture is valid', () => assert.deepEqual(validateLatestJson(fixture, { version: '0.2.0' }), []));
const broken = (mutate) => { const d = structuredClone(fixture); mutate(d); return validateLatestJson(d, { version: '0.2.0' }).join('\n'); };
test('problems', () => {
  assert.match(broken((d) => (d.platforms['linux-x86_64'] = d.platforms['linux-x86_64-appimage'])), /generic linux-x86_64 key/);
  assert.match(broken((d) => (d.platforms['darwin-aarch64'].url = d.platforms['darwin-aarch64'].url.replace('https:', 'http:'))), /darwin-aarch64 url must be https/);
  assert.match(broken((d) => (d.platforms['windows-x86_64'].url = 'https://example.com/x-setup.exe')), /windows-x86_64 url must start with https:\/\/github\.com\/erdembas\/kubepit\/releases\/download\/v0\.2\.0\//);
  assert.match(broken((d) => (d.version = '0.1.0')), /version 0\.1\.0 does not match 0\.2\.0/);
  assert.match(broken((d) => (d.platforms['linux-x86_64-deb'].url = d.platforms['linux-x86_64-appimage'].url)), /linux-x86_64-deb must point at a \.deb/);
  assert.match(broken((d) => delete d.platforms['windows-x86_64']), /missing platform windows-x86_64/);
  assert.match(broken((d) => (d.platforms['darwin-aarch64'].signature = 'nope')), /signature of darwin-aarch64 is not a minisign signature/);
  assert.match(broken((d) => (d.pub_date = 'yesterday')), /pub_date must be RFC 3339/);
  assert.match(broken((d) => (d.notes = ' ')), /notes must not be empty/);
  assert.match(validateLatestJson(fixture, { version: '0.2.0', assets: ['Kubepit_0.2.0_universal.app.tar.gz'] }).join('\n'),
    /Kubepit_0\.2\.0_x64-setup\.exe is not an uploaded asset/);
});
```

- [ ] **Step 2: Write the failing Rust test in `updater.rs`**

```rust
#[test]
fn release_feed_fixture_resolves_every_install_kind() {
    let feed: tauri_plugin_updater::RemoteRelease =
        serde_json::from_str(include_str!("../../../../../scripts/release/fixtures/latest.valid.json")).unwrap();
    assert!(feed.download_url("darwin-aarch64-app").unwrap().as_str().ends_with("_universal.app.tar.gz"));
    assert!(feed.download_url("darwin-x86_64").unwrap().as_str().ends_with("_universal.app.tar.gz"));
    assert!(feed.download_url("windows-x86_64").unwrap().as_str().ends_with("_x64-setup.exe"));
    assert!(feed.download_url("linux-x86_64-appimage").unwrap().as_str().ends_with(".AppImage"));
    assert!(feed.signature("linux-x86_64-deb").is_ok());
    // A .deb/.rpm install must never fall back to the AppImage.
    assert!(feed.download_url("linux-x86_64").is_err());
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test:scripts; cargo test -p kubepit-desktop release_feed_fixture`
Expected: FAIL — module not found; fixture file missing.

- [ ] **Step 4: Implement `latest-json.mjs`, `validate-latest-json.mjs` and generate the fixture**

Key mapping (entries with `signature: null` are skipped): `app/universal` → `darwin-aarch64-app`, `darwin-x86_64-app`, `darwin-aarch64`, `darwin-x86_64`; `app/<arch>` → `darwin-<arch>-app`, `darwin-<arch>`; `nsis` → `windows-x86_64-nsis`, `windows-x86_64`; `appimage` / `deb` / `rpm` → `linux-x86_64-appimage` / `-deb` / `-rpm` only. URLs are `${DOWNLOAD_BASE}/v${version}/${name}`. Validator rules: `version` semver (leading `v` allowed) equal to `--version`; `pub_date` parses and matches RFC 3339; `notes` non-blank string; every key matches `^(darwin|linux|windows)-(x86_64|aarch64|i686|armv7)(-(app|appimage|deb|rpm|nsis|msi))?$`; no key matches `^linux-[^-]+$`; URL https, under the base, extension consistent with the installer suffix (`-app`/generic darwin → `.app.tar.gz`, `-nsis`/generic windows → `-setup.exe`, `-msi` → `.msi`, `-appimage` → `.AppImage`, `-deb` → `.deb`, `-rpm` → `.rpm`); signature is base64 whose decoded text starts with `untrusted comment:`; every `require` key present; every URL's file name in `assets` when given. Write the fixture by running the builder on `SAMPLE` once and committing the pretty-printed result.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:scripts && cargo test -p kubepit-desktop updater`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/release/latest-json.mjs scripts/release/validate-latest-json.mjs scripts/release/fixtures/latest.valid.json scripts/release/test/latest-json.test.mjs apps/desktop/src-tauri/src/ipc/updater.rs
git commit -m "build(release): generate and validate latest.json" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: CI workflow

**Files:**
- Create: `.github/actions/setup/action.yml`, `.github/workflows/ci.yml`, `.github/dependabot.yml`
- Test: `scripts/ci/test/workflows.test.mjs`

**Interfaces:**
- Consumes: `pnpm test:scripts` (Task 1).
- Produces:
  - Composite action `./.github/actions/setup` with inputs `rust` (`'true'`), `rust-targets` (`''`, comma list), `linux-deps` (`'false'`), `install` (`'true'`).
  - `ci.yml` job ids `frontend`, `rust-fmt`, `rust` (matrix `os`, `experimental`; display name `rust (${{ matrix.os }})`), `workflows`. The cross-platform plan flips `experimental` for `windows-2022` and adds jobs.
  - Test helpers in `workflows.test.mjs`: `readWorkflow(name): string` (reads `.github/workflows/<name>`), `allWorkflowFiles(): string[]` (every `*.yml` under `.github/`, including `actions/*/action.yml`), `usesRefs(text): Array<{ action: string, ref: string }>` (from `uses: <action>@<ref>`).

- [ ] **Step 1: Write the failing invariant tests**

```js
const SIX = ['pnpm typecheck', 'pnpm i18n:check', 'cargo fmt --all -- --check',
  'cargo clippy --workspace --all-targets --locked -- -D warnings', 'cargo test --workspace --locked',
  'pnpm --filter @kubepit/desktop build'];
test('ci runs the six checks and the script tests', () => {
  const ci = readWorkflow('ci.yml');
  for (const cmd of [...SIX, 'pnpm test:scripts']) assert.ok(ci.includes(cmd), cmd);
});
test('ci covers three operating systems', () => {
  const ci = readWorkflow('ci.yml');
  for (const os of ['ubuntu-22.04', 'macos-14', 'windows-2022']) assert.ok(ci.includes(os), os);
});
test('ci is read-only and never reads secrets', () => {
  const ci = readWorkflow('ci.yml');
  assert.match(ci, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(ci, /secrets\./);
  assert.doesNotMatch(ci, /pull_request_target/);
});
test('third-party actions are pinned to commit SHAs', () => {
  for (const file of allWorkflowFiles())
    for (const { action, ref } of usesRefs(readFileSync(file, 'utf8')))
      if (!action.startsWith('./')) assert.match(ref, /^[0-9a-f]{40}$/, `${file}: ${action}@${ref}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:scripts`
Expected: FAIL with `ENOENT … .github/workflows/ci.yml`

- [ ] **Step 3: Write `.github/actions/setup/action.yml`**

Steps: `pnpm/action-setup` (no `version`, it reads `packageManager`), `actions/setup-node` (`node-version: 22`, `cache: pnpm`), when `rust == 'true'`: `dtolnay/rust-toolchain` (`toolchain: stable`, `components: clippy, rustfmt`, `targets: ${{ inputs.rust-targets }}`) and `Swatinem/rust-cache` (`save-if: ${{ github.ref == 'refs/heads/main' }}`); when `linux-deps == 'true' && runner.os == 'Linux'`: `sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf build-essential file`; when `install == 'true'`: `pnpm install --frozen-lockfile`. All `shell: bash`.

- [ ] **Step 4: Write `.github/workflows/ci.yml` and `.github/dependabot.yml`**

Triggers: `pull_request`, `push: branches: [main]`, `workflow_dispatch`. Top-level `permissions: contents: read`; `concurrency: { group: ci-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`; env `CARGO_TERM_COLOR: always`.
- `frontend` (`ubuntu-22.04`): checkout, setup (`rust: 'false'`), then `pnpm typecheck`, `pnpm i18n:check`, `pnpm --filter @kubepit/desktop build`, `pnpm test:scripts`.
- `rust-fmt` (`ubuntu-22.04`): checkout, setup (`install: 'false'`), `cargo fmt --all -- --check`.
- `rust`: matrix `include: [{os: ubuntu-22.04, experimental: false}, {os: macos-14, experimental: false}, {os: windows-2022, experimental: true}]`, `fail-fast: false`, `continue-on-error: ${{ matrix.experimental }}`; checkout, setup (`linux-deps: 'true'`, `install: 'false'`), `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`. (`tauri::generate_context!` embeds no assets without the `custom-protocol` feature, so no frontend build is needed.)
- `workflows` (`ubuntu-22.04`): checkout, run rhysd/actionlint's `scripts/download-actionlint.bash` fetched from a pinned commit for version `1.7.7`, then `./actionlint -color` (shellcheck is preinstalled on the runner and picked up automatically).

`dependabot.yml`: `version: 2`, one update for `package-ecosystem: github-actions`, `directory: /`, `schedule.interval: weekly`.

- [ ] **Step 5: Run the tests and actionlint**

Run: `pnpm test:scripts && actionlint`
Expected: PASS; actionlint prints nothing.

- [ ] **Step 6: Commit**

```bash
git add .github/actions/setup/action.yml .github/workflows/ci.yml .github/dependabot.yml scripts/ci/test/workflows.test.mjs
git commit -m "ci: run the six checks on Linux, macOS and Windows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7 (user): Push and protect**

Push the branch, open a PR, confirm `frontend`, `rust-fmt`, `rust (ubuntu-22.04)`, `rust (macos-14)` and `workflows` pass, then mark them required in branch protection. `rust (windows-2022)` may fail until the cross-platform plan lands.

---

### Task 6: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `scripts/ci/test/workflows.test.mjs`

**Interfaces:**
- Consumes: every CLI from Tasks 1–4; composite action (Task 5).
- Produces: `release.yml` job ids `prepare` (outputs `tag`, `version`, `prerelease`, `dry_run`, `updater_signing`), `build` (matrix `platform` ∈ `macos|windows|linux`), `finalize`; workflow artifacts `release-notes`, `manifest-<platform>`, and in dry runs `bundles-<platform>`, `feed`.

- [ ] **Step 1: Write the failing invariant tests**

```js
test('release triggers and permissions', () => {
  const r = readWorkflow('release.yml');
  assert.match(r, /tags:\n\s+- 'v\*\.\*\.\*'/);
  assert.match(r, /workflow_dispatch:[\s\S]*dry_run:/);
  assert.match(r, /^permissions:\n {2}contents: read$/m);
  assert.equal((r.match(/contents: write/g) ?? []).length, 3);
  assert.doesNotMatch(r, /pull_request/);
});
test('release runs the tested scripts', () => {
  const r = readWorkflow('release.yml');
  for (const s of ['versions.mjs check --tag', 'changelog.mjs extract', 'tauri-config.mjs', 'collect-artifacts.mjs',
    'minisign.mjs verify', 'latest-json.mjs', 'validate-latest-json.mjs', 'collect-artifacts.mjs sums'])
    assert.ok(r.includes(s), s);
});
test('release builds the agreed bundles', () => {
  const r = readWorkflow('release.yml');
  for (const s of ['--bundles app,dmg', '--bundles nsis', '--bundles appimage,deb,rpm', 'universal-apple-darwin', 'tauri build --ci'])
    assert.ok(r.includes(s), s);
});
test('re-runs reuse the draft and replace assets', () => {
  const r = readWorkflow('release.yml');
  assert.ok(r.indexOf('gh release view') > -1 && r.indexOf('gh release view') < r.indexOf('gh release create'));
  assert.ok(r.includes('--clobber'));
  assert.ok(r.includes('--draft'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:scripts`
Expected: FAIL with `ENOENT … release.yml`

- [ ] **Step 3: Write `.github/workflows/release.yml`**

Triggers (block style, as the test expects): `push:` → `tags:` → `- 'v*.*.*'`; `workflow_dispatch` with inputs `tag` (string, optional) and `dry_run` (boolean, default `true`). Top-level `permissions: contents: read`; `concurrency: release-${{ github.ref }}` without cancel; `defaults.run.shell: bash`.

`prepare` (`ubuntu-22.04`, `permissions: contents: write`): checkout, `actions/setup-node` 22; tag = the pushed tag, else `inputs.tag`, else `v$(node scripts/release/versions.mjs check)`; `node scripts/release/versions.mjs check --tag "$TAG"`; `node scripts/release/changelog.mjs extract "$VERSION" > "$RUNNER_TEMP/notes.md"` uploaded as `release-notes`; signing availability from `env: HAS_UPDATER: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY != '' }}` (likewise `APPLE_CERTIFICATE`, `AZURE_CLIENT_SECRET`) written to `$GITHUB_OUTPUT` and to the step summary as "on/off" lines; unless dry run: `gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --draft --verify-tag --title "Kubepit $TAG" --notes-file "$RUNNER_TEMP/notes.md"` plus `--prerelease` when `node scripts/release/versions.mjs prerelease "$VERSION"` prints `true` (also exported as output `prerelease`). `gh` authenticates with `GH_TOKEN: ${{ github.token }}` in every job that calls it.

`build` (needs `prepare`, `permissions: contents: write`, `fail-fast: false`) matrix include:

| platform | os | target | bundles | rust-targets | bundle-dir |
|----------|----|--------|---------|--------------|------------|
| macos | macos-14 | universal-apple-darwin | app,dmg | aarch64-apple-darwin,x86_64-apple-darwin | target/universal-apple-darwin/release/bundle |
| windows | windows-2022 | | nsis | | target/release/bundle |
| linux | ubuntu-22.04 | | appimage,deb,rpm | | target/release/bundle |

Steps: checkout; setup (`linux-deps: 'true'`, `rust-targets`); Windows + `vars.WINDOWS_SIGNING_PROVIDER == 'azure'`: `cargo install trusted-signing-cli --locked` (pin `--version` to the current release); macOS + API key present: write `secrets.APPLE_API_PRIVATE_KEY` to `$RUNNER_TEMP/AuthKey.p8` and export `APPLE_API_KEY_PATH`; `node scripts/release/tauri-config.mjs > "$RUNNER_TEMP/tauri.release.json"` with the env names from Task 2 (`TAURI_UPDATER_PUBKEY: ${{ vars.TAURI_UPDATER_PUBKEY }}`, `AZURE_SIGNING_*` from `vars`); `pnpm --filter @kubepit/desktop tauri build --ci --bundles <bundles> [--target <target>] --config "$RUNNER_TEMP/tauri.release.json"` with env `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (`vars`), `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; `node scripts/release/collect-artifacts.mjs --platform … --bundle-dir … --version "$VERSION" --out dist-release` (+ `--require-signatures` when updater signing is on); when on: `node scripts/release/minisign.mjs verify --manifest dist-release/manifest-<platform>.json --dir dist-release --pubkey "$TAURI_UPDATER_PUBKEY"`; upload `dist-release/manifest-<platform>.json` as artifact `manifest-<platform>`; dry run: upload `dist-release/` as `bundles-<platform>`; else `gh release upload "$TAG" <every file in dist-release except manifest-*.json> --clobber`.

`finalize` (needs `[prepare, build]`, `ubuntu-22.04`, `permissions: contents: write`): download `release-notes` and `manifest-*` (merge into `manifests/`); `node scripts/release/collect-artifacts.mjs sums --manifests-dir manifests > SHA256SUMS`; when updater signing is on: `node scripts/release/latest-json.mjs --version "$VERSION" --notes-file notes.md --manifests-dir manifests > latest.json` and `node scripts/release/validate-latest-json.mjs latest.json --version "$VERSION" --assets-file assets.txt`, where `assets.txt` is `gh release view "$TAG" --json assets --jq '.assets[].name'` (dry run: the manifest names); otherwise `echo "::warning::updater signing is off, no latest.json"`. Upload `SHA256SUMS` (and `latest.json`) with `gh release upload … --clobber`, or as artifact `feed` in dry runs.

- [ ] **Step 4: Run the tests and actionlint**

Run: `pnpm test:scripts && actionlint`
Expected: PASS; actionlint prints nothing.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml scripts/ci/test/workflows.test.mjs
git commit -m "ci(release): signed draft releases with updater feed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Distribution — Homebrew tap and winget

**Files:**
- Create: `scripts/release/homebrew-cask.mjs`, `.github/workflows/distribute.yml`
- Modify: `scripts/ci/test/workflows.test.mjs`
- Test: `scripts/release/test/homebrew-cask.test.mjs`

**Interfaces:**
- Consumes: canonical names (Task 3), composite action not needed.
- Produces: `renderCask({ version: string, sha256: string }): string`; CLI `homebrew-cask.mjs --version V --sha256 H` (prints the cask). `distribute.yml` jobs `homebrew`, `winget`.

- [ ] **Step 1: Write the failing tests**

```js
const SHA = 'a'.repeat(64);
test('cask', () => {
  const cask = renderCask({ version: '0.2.0', sha256: SHA });
  for (const line of ['cask "kubepit" do', '  version "0.2.0"', `  sha256 "${SHA}"`,
    '  url "https://github.com/erdembas/kubepit/releases/download/v#{version}/Kubepit_#{version}_universal.dmg"',
    '  auto_updates true', '  depends_on macos: ">= :high_sierra"', '  app "Kubepit.app"', '    "~/.kubepit",'])
    assert.ok(cask.includes(line), line);
  assert.throws(() => renderCask({ version: '0.2.0', sha256: 'xyz' }), /sha256 must be 64 hex characters/);
});
test('distribution only follows published, final releases', () => {
  const d = readWorkflow('distribute.yml');
  assert.match(d, /release:\n\s+types: \[published\]/);
  assert.ok(d.includes('github.event.release.prerelease == false'));
  assert.match(d, /^permissions:\n {2}contents: read$/m);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:scripts`
Expected: FAIL with `Cannot find module …/homebrew-cask.mjs`

- [ ] **Step 3: Implement `renderCask`**

Exact cask (Tauri's default `minimumSystemVersion` is 10.13):

```ruby
cask "kubepit" do
  version "<version>"
  sha256 "<sha256>"

  url "https://github.com/erdembas/kubepit/releases/download/v#{version}/Kubepit_#{version}_universal.dmg"
  name "Kubepit"
  desc "Local-first Kubernetes IDE for many clusters"
  homepage "https://github.com/erdembas/kubepit"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :high_sierra"

  app "Kubepit.app"

  zap trash: [
    "~/.kubepit",
    "~/Library/Caches/io.github.erdembas.kubepit",
    "~/Library/WebKit/io.github.erdembas.kubepit",
  ]
end
```

- [ ] **Step 4: Write `.github/workflows/distribute.yml`**

Trigger (block style) `release:` → `types: [published]`; top-level `permissions: contents: read`; both jobs `if: github.event.release.prerelease == false`; version = `github.event.release.tag_name` without `v`.
- `homebrew` (`ubuntu-22.04`, env `HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}`, every step `if: env.HOMEBREW_TAP_TOKEN != ''`): checkout; `gh release download "$TAG" --pattern "Kubepit_${VERSION}_universal.dmg"`; `sha256sum`; checkout `${{ vars.HOMEBREW_TAP_REPO || 'erdembas/homebrew-tap' }}` into `tap/` with `token: ${{ secrets.HOMEBREW_TAP_TOKEN }}`; `node scripts/release/homebrew-cask.mjs … > tap/Casks/kubepit.rb`; commit `kubepit ${VERSION}` as `github-actions[bot]` and push.
- `winget` (`ubuntu-22.04`, env `WINGET_TOKEN`, steps gated likewise): download a pinned komac Linux release (`gh release download <pinned tag> -R russellbanks/Komac --pattern '*x86_64-unknown-linux-gnu.tar.gz'`); `komac update "${{ vars.WINGET_PACKAGE_ID || 'ErdemBas.Kubepit' }}" --version "$VERSION" --urls "https://github.com/erdembas/kubepit/releases/download/${TAG}/Kubepit_${VERSION}_x64-setup.exe" --submit` with `GITHUB_TOKEN: ${{ secrets.WINGET_TOKEN }}` (check the flags against `komac update --help` of the pinned release).

- [ ] **Step 5: Run the tests and actionlint**

Run: `pnpm test:scripts && actionlint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/release/homebrew-cask.mjs scripts/release/test/homebrew-cask.test.mjs .github/workflows/distribute.yml scripts/ci/test/workflows.test.mjs
git commit -m "ci(release): Homebrew tap and winget on publish" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Release documentation, secret inventory and the dry run

**Files:**
- Modify: `docs/RELEASING.md` (rewrite), `README.md:44-64`, `scripts/ci/test/workflows.test.mjs`

**Interfaces:**
- Consumes: every workflow and script above.
- Produces: `docs/RELEASING.md` tables "Secrets" and "Variables" whose rows start with `` | `NAME` | `` (the test parses them).

- [ ] **Step 1: Write the failing inventory test**

```js
const names = (re) => new Set(allWorkflowFiles().flatMap((f) => [...readFileSync(f, 'utf8').matchAll(re)].map((m) => m[1])));
const documented = (heading) => {
  const doc = readFileSync('docs/RELEASING.md', 'utf8');
  const section = doc.split(`## ${heading}`)[1]?.split('\n## ')[0] ?? '';
  return new Set([...section.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]));
};
test('every secret is documented and every documented secret is used', () => {
  const used = names(/secrets\.([A-Z0-9_]+)/g); used.delete('GITHUB_TOKEN');
  assert.deepEqual([...used].sort(), [...documented('Secrets')].sort());
});
test('every variable is documented and used', () =>
  assert.deepEqual([...names(/vars\.([A-Z0-9_]+)/g)].sort(), [...documented('Variables')].sort()));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:scripts`
Expected: FAIL — the sets differ (RELEASING.md has no such sections yet).

- [ ] **Step 3: Rewrite `docs/RELEASING.md`**

Sections, in order: How releases work (the flow and the inert-updater rule, kept from today's page); `## Secrets` table — `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `HOMEBREW_TAP_TOKEN`, `WINGET_TOKEN` (what it is, where to create it, which job reads it); `## Variables` table — `TAURI_UPDATER_PUBKEY`, `APPLE_SIGNING_IDENTITY`, `WINDOWS_SIGNING_PROVIDER`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `HOMEBREW_TAP_REPO`, `WINGET_PACKAGE_ID`; Updater keys (today's §1–2, but the public key goes into the variable, not `tauri.conf.json`); macOS signing and notarization (Developer ID `.p12` export, App Store Connect API key); Windows signing (the options table from the spec, Azure setup steps, how to add another provider in `windowsSignCommand`); Versioning and changelog (`pnpm release:bump X.Y.Z`, Keep a Changelog, prereleases); Cutting a release (bump → commit → tag → push the tag → wait → review the draft → publish → smoke test from today's checklist); Dry run on a fork (below); Distribution (creating `erdembas/homebrew-tap` with a `Casks/` folder, the first winget submission with `komac new`, AppImage on GitHub Releases, why not Flathub); Troubleshooting (`TargetsNotFound` for deb/rpm installs, key mismatch reported by `minisign.mjs verify`, notarization failures). Keep the "never commit `kubepit.key`" notes.

README: add a CI badge under the title block and an "Install" section before "Development" (`brew install --cask erdembas/tap/kubepit`, `winget install ErdemBas.Kubepit`, AppImage/deb/rpm from Releases); add `pnpm test:scripts` to the checks list.

- [ ] **Step 4: Run the tests and all checks**

Run: `pnpm test:scripts && actionlint && pnpm typecheck && pnpm i18n:check && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && pnpm --filter @kubepit/desktop build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/RELEASING.md README.md scripts/ci/test/workflows.test.mjs
git commit -m "docs(release): secrets, signing, versioning and distribution" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (user): Dry run on a fork**

Push to a fork; run `release` via `workflow_dispatch` with `dry_run: true`. Expected: `prepare` reports every signing step "off", the three `build` jobs pass, `bundles-macos|windows|linux` hold the canonical names, `feed` holds `SHA256SUMS` and the warning about `latest.json`. Optionally add a throwaway updater key pair to the fork's secrets/variables (generated by you, never reused) and re-run: `minisign.mjs verify` passes and `feed` contains a valid `latest.json`.

- [ ] **Step 7 (user): Prerelease rehearsal**

In the real repository with secrets set: `pnpm release:bump 0.1.1-rc.1` (or the agreed version), commit, tag, push the tag. Expected: a draft prerelease with every canonical asset, `.sig` files, `latest.json` and `SHA256SUMS`; the macOS DMG opens without a Gatekeeper warning (`spctl -a -vv Kubepit.app` says "Notarized Developer ID"). Delete the draft afterwards.
