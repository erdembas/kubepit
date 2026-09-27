# Releasing Kubepit

This page covers release signing for the in-app updater, the update feed and
a GitHub Releases workflow. Code signing and notarization for macOS and
Windows are separate topics; they are mentioned only where they touch the
updater.

## How the updater is wired

- `tauri-plugin-updater` does the download, the signature check and the
  install. Kubepit calls it through its own commands (`update_status`,
  `update_check`, `update_install`; see `apps/desktop/src-tauri/src/ipc/updater.rs`)
  and relaunches with `tauri-plugin-process`.
- **The updater stays inert until release signing is configured.** At startup
  `lib.rs` reads `plugins.updater` from the bundled config
  (`kubepit_core::updates::UpdaterConfig`). Only when `pubkey` is a non-empty
  string and every endpoint is an `https://` URL is the plugin registered.
  Otherwise `update_check` / `update_install` refuse and Settings → About &
  Updates says "Updates are not configured for this build". Builds without a
  key therefore keep working exactly as before.
- The committed `apps/desktop/src-tauri/tauri.conf.json` has an empty
  `pubkey` and the feed
  `https://github.com/erdembas/kubepit/releases/latest/download/latest.json`.
- With a key, the main window checks once, 8 s after startup, when the
  `auto_check_updates` setting is on (default). Nothing is downloaded until
  the user clicks "Download and install".

## 1. Generate the signing key pair (once)

The updater verifies every download with a [minisign](https://jedisct1.github.io/minisign/)
signature. Generate the key pair on a trusted machine:

```bash
pnpm --filter @kubepit/desktop tauri signer generate -w ~/.tauri/kubepit.key
```

You are asked for a password (use one). This writes:

| File                       | What it is                                        |
| -------------------------- | ------------------------------------------------- |
| `~/.tauri/kubepit.key`     | **private key** — never commit it, never share it |
| `~/.tauri/kubepit.key.pub` | public key — safe to commit                       |

Store the private key and its password in a password manager and as CI
secrets. **If the private key is lost, installed copies can no longer be
updated in-app**: a new key means users have to download the next release
manually once.

## 2. Configure the public key

Paste the _content_ of `kubepit.key.pub` (one base64 line, not the path)
into `apps/desktop/src-tauri/tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IC4uLgo...",
      "endpoints": ["https://github.com/erdembas/kubepit/releases/latest/download/latest.json"]
    }
  }
}
```

Alternatively leave the file untouched and inject the key only in release
builds; the Tauri CLI merges `--config` into the bundled config, which is
what Kubepit reads at startup:

```bash
pnpm --filter @kubepit/desktop tauri build \
  --config '{"plugins":{"updater":{"pubkey":"'"$(cat ~/.tauri/kubepit.key.pub)"'"}}}'
```

## 3. Produce updater artifacts

Enable updater bundles in `tauri.conf.json` (keep it off until the private
key is available in every environment that runs `tauri build`, otherwise the
build fails asking for it):

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

and provide the private key to the build:

| Variable                             | Value                                      |
| ------------------------------------ | ------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | content of `kubepit.key` (or a path to it) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's password (empty string if none)  |

`tauri build` then writes an update bundle and its `.sig` next to the
installers:

| Platform | Update bundle                                                          | Signature                 |
| -------- | ---------------------------------------------------------------------- | ------------------------- |
| macOS    | `bundle/macos/Kubepit.app.tar.gz`                                      | `….tar.gz.sig`            |
| Linux    | `bundle/appimage/Kubepit_<version>_amd64.AppImage`                     | `….AppImage.sig`          |
| Windows  | `bundle/nsis/Kubepit_<version>_x64-setup.exe` (and `bundle/msi/*.msi`) | `….exe.sig` / `….msi.sig` |

Only AppImage installs can update themselves on Linux; `.deb` / `.rpm`
users update through their package manager.

The version users see comes from `version` in `tauri.conf.json` (keep it in
sync with `apps/desktop/src-tauri/Cargo.toml` and `package.json`). The
updater compares it with the feed using semver.

## 4. The update feed (`latest.json`)

The endpoint returns a static JSON document. `releases/latest/download/…`
always resolves to the newest **published, non-prerelease** GitHub release,
so drafts and prereleases are never offered.

```json
{
  "version": "0.2.0",
  "notes": "## Highlights\n\n- Table export\n- Saved views and bookmarks",
  "pub_date": "2026-10-01T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<content of Kubepit.app.tar.gz.sig>",
      "url": "https://github.com/erdembas/kubepit/releases/download/v0.2.0/Kubepit_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<content of Kubepit.app.tar.gz.sig>",
      "url": "https://github.com/erdembas/kubepit/releases/download/v0.2.0/Kubepit_x64.app.tar.gz"
    },
    "linux-x86_64": {
      "signature": "<content of the .AppImage.sig>",
      "url": "https://github.com/erdembas/kubepit/releases/download/v0.2.0/Kubepit_0.2.0_amd64.AppImage"
    },
    "windows-x86_64": {
      "signature": "<content of the -setup.exe.sig>",
      "url": "https://github.com/erdembas/kubepit/releases/download/v0.2.0/Kubepit_0.2.0_x64-setup.exe"
    }
  }
}
```

- `version` (required): semver, a leading `v` is allowed.
- `notes` (optional): shown as release notes (Markdown) in Settings.
- `pub_date` (optional): RFC 3339.
- `platforms` (required): keys are `<os>-<arch>` with `os` ∈ `darwin`,
  `linux`, `windows` and `arch` ∈ `x86_64`, `aarch64`, `i686`, `armv7`.
  A key may add the installer (`windows-x86_64-msi`, `linux-x86_64-appimage`)
  to pick a specific bundle. `signature` is the **content** of the `.sig`
  file, not a URL.

## 5. GitHub Releases workflow (outline)

[`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action) builds
every platform, uploads the bundles and generates `latest.json`:

```yaml
name: release
on:
  push:
    tags: ['v*']

jobs:
  build:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            args: --target aarch64-apple-darwin
          - os: macos-latest
            args: --target x86_64-apple-darwin
          - os: ubuntu-22.04
            args: ''
          - os: windows-latest
            args: ''
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ startsWith(matrix.os, 'macos') && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}
      - name: Linux dependencies
        if: startsWith(matrix.os, 'ubuntu')
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - run: pnpm install --frozen-lockfile
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          # macOS signing / notarization secrets go here as well (APPLE_*).
        with:
          projectPath: apps/desktop
          tagName: ${{ github.ref_name }}
          releaseName: Kubepit ${{ github.ref_name }}
          releaseBody: See the changelog.
          releaseDraft: true
          prerelease: false
          includeUpdaterJson: true
          args: ${{ matrix.args }}
```

Release checklist:

1. Bump `version` in `tauri.conf.json`, `src-tauri/Cargo.toml` and
   `apps/desktop/package.json`; commit; tag `vX.Y.Z`; push the tag.
2. Wait for every matrix job; the draft release now holds the installers,
   the update bundles with their `.sig` files and `latest.json`.
3. Review the notes: tauri-action copies `releaseBody` into
   `latest.json` → `notes`. If you rewrite the release text afterwards,
   update `notes` in the uploaded `latest.json` too.
4. Publish the release. From that moment `…/releases/latest/download/latest.json`
   serves it and running copies find the update.
5. Smoke test: install the previous release, open Settings → About &
   Updates → Check for updates, install, relaunch, confirm the new version.

## Notes

- macOS: `bundle.macOS.signingIdentity` is `"-"` (ad-hoc) today. The updater
  signature is independent of Apple code signing, but Gatekeeper still
  applies to the first download; use a Developer ID + notarization for
  public releases.
- Windows: the NSIS installer runs in passive mode and restarts Kubepit on
  its own; macOS and Linux relaunch from the "Relaunch now" button.
- Never commit `kubepit.key`, `.env` files with the password, or CI logs
  that print either.
