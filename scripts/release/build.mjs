import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { targets, assert, assetName, sha256, checkMagic } from './model.mjs';
import { updaterEntries, updaterPublicKey, verifyUpdaterSignature } from './updater.mjs';

const target = targets.find((t) => t.id === process.env.RELEASE_TARGET);
assert(target, 'Unknown release target');
const source = resolve('source');
const version = process.env.RELEASE_VERSION;
const updaterEnabled = process.env.RELEASE_UPDATER_ENABLED === 'true';
const publicKey = process.env.RELEASE_UPDATER_PUBLIC_KEY || '';
const output = resolve('release-target');
const temporary = resolve(process.env.RUNNER_TEMP || 'release-temp', `kubepit-${target.id}`);
await mkdir(temporary, { recursive: true });
await mkdir(output, { recursive: true });
const env = {
  ...process.env,
  NODE_OPTIONS: '--max-old-space-size=4096',
  VITE_BASE_PATH: '/',
  VITE_PUBLIC_DEMO: 'false',
  APPIMAGE_EXTRACT_AND_RUN: '1',
};
// Empty optional secrets must not activate Tauri's signing/notarization paths.
for (const name of Object.keys(env))
  if ((name.startsWith('APPLE_') || name.startsWith('TAURI_SIGNING_')) && !env[name])
    delete env[name];
const sourceConfig = JSON.parse(
  await readFile(join(source, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
);
if (updaterEnabled) {
  updaterPublicKey(publicKey);
  assert(
    sourceConfig.bundle.createUpdaterArtifacts === true &&
      sourceConfig.plugins.updater.pubkey === publicKey,
    'Frozen source updater configuration mismatch',
  );
  assert(env.TAURI_SIGNING_PRIVATE_KEY, 'Updater signing private key is required');
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ||= '';
} else {
  assert(version === '0.0.1', 'New releases require signed updater artifacts');
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
}
function run(command, args, { visible = false, extraEnv = {}, cwd = source } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    stdio: visible ? 'inherit' : 'pipe',
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed (exit ${result.status}); ${visible ? 'see build log' : 'signing/validation output withheld to protect credentials'}`,
    );
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}
const overlay = {
  bundle: {
    createUpdaterArtifacts: updaterEnabled,
    macOS: { minimumSystemVersion: '11.0', hardenedRuntime: true },
    windows: { nsis: { languages: ['English', 'Turkish'], displayLanguageSelector: true } },
  },
};
let signing = target.platform === 'macos' ? 'ad-hoc' : 'unsigned';
let keychain;
let windowsThumbprint;
try {
  if (target.platform === 'macos') {
    const certificate = env.APPLE_CERTIFICATE;
    if (updaterEnabled)
      assert(
        [
          'APPLE_CERTIFICATE',
          'APPLE_CERTIFICATE_PASSWORD',
          'APPLE_SIGNING_IDENTITY',
          'APPLE_ID',
          'APPLE_PASSWORD',
          'APPLE_TEAM_ID',
        ].every((name) => env[name]),
        'Updater-enabled macOS releases require complete Developer ID and notarization credentials',
      );
    if (certificate) {
      assert(
        env.APPLE_CERTIFICATE_PASSWORD &&
          env.APPLE_SIGNING_IDENTITY &&
          env.APPLE_SIGNING_IDENTITY !== '-',
        'Apple certificate password and signing identity must be configured together',
      );
      const certPath = join(temporary, 'certificate.p12');
      await writeFile(certPath, Buffer.from(certificate, 'base64'), { mode: 0o600 });
      keychain = join(temporary, 'build.keychain-db');
      const password = randomBytes(32).toString('hex'); // Ephemeral keychain password, not a signing key.
      const existing = run('security', ['list-keychains', '-d', 'user'])
        .split('\n')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
      run('security', ['create-keychain', '-p', password, keychain]);
      run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
      run('security', ['unlock-keychain', '-p', password, keychain]);
      run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...existing]);
      run('security', [
        'import',
        certPath,
        '-k',
        keychain,
        '-P',
        env.APPLE_CERTIFICATE_PASSWORD,
        '-T',
        '/usr/bin/codesign',
      ]);
      run('security', [
        'set-key-partition-list',
        '-S',
        'apple-tool:,apple:,codesign:',
        '-s',
        '-k',
        password,
        keychain,
      ]);
      signing = 'signed';
    } else {
      assert(
        !env.APPLE_SIGNING_IDENTITY || env.APPLE_SIGNING_IDENTITY === '-',
        'Apple signing identity requires an imported certificate',
      );
      env.APPLE_SIGNING_IDENTITY = '-';
    }
    overlay.bundle.macOS.signingIdentity = env.APPLE_SIGNING_IDENTITY;
    const notarization = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].filter((k) => env[k]);
    assert(
      notarization.length === 0 || (notarization.length === 3 && certificate),
      'Apple notarization needs certificate, APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID',
    );
    if (notarization.length === 3) signing = 'notarized';
  }
  if (target.platform === 'windows' && env.WINDOWS_CERTIFICATE) {
    assert(
      env.WINDOWS_CERTIFICATE_PASSWORD,
      'Windows certificate password is required with a certificate',
    );
    const certificatePath = join(temporary, 'certificate.pfx');
    await writeFile(certificatePath, Buffer.from(env.WINDOWS_CERTIFICATE, 'base64'), {
      mode: 0o600,
    });
    windowsThumbprint = run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $cert=Import-PfxCertificate -FilePath $env:KUBEPIT_CERT_PATH -CertStoreLocation Cert:\\CurrentUser\\My -Password (ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force); ($cert | Where-Object HasPrivateKey | Select-Object -First 1).Thumbprint",
      ],
      { extraEnv: { KUBEPIT_CERT_PATH: certificatePath } },
    );
    assert(
      /^[A-Fa-f0-9]{40}$/.test(windowsThumbprint),
      'Could not import Windows signing certificate',
    );
    Object.assign(overlay.bundle.windows, {
      certificateThumbprint: windowsThumbprint,
      digestAlgorithm: 'sha256',
      timestampUrl: 'http://timestamp.digicert.com',
    });
    signing = 'signed';
  }
  const config = join(temporary, 'tauri.release.json');
  await writeFile(config, JSON.stringify(overlay));
  run(
    process.execPath,
    [
      join(source, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js'),
      'build',
      '--ci',
      '--target',
      target.target,
      '--bundles',
      // Tauri removes its intermediate .app after DMG-only builds. Keep it for
      // executable architecture/version/signature verification before upload.
      [...(target.platform === 'macos' ? ['app'] : []), ...target.formats]
        .map((format) => format.toLowerCase())
        .join(','),
      '--config',
      config,
      '--',
      '--locked',
    ],
    { visible: true, cwd: join(source, 'apps/desktop') },
  );
  const bundle = join(source, 'target', target.target, 'release', 'bundle');
  if (target.platform === 'macos') {
    const app = join(bundle, 'macos', 'Kubepit.app');
    const executable = run('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleExecutable',
      join(app, 'Contents', 'Info.plist'),
    ]);
    assert(/^[A-Za-z0-9_.-]+$/.test(executable), 'Invalid macOS executable name');
    assert(
      run('lipo', ['-archs', join(app, 'Contents', 'MacOS', executable)]) ===
        (target.arch === 'arm64' ? 'arm64' : 'x86_64'),
      'macOS executable architecture mismatch',
    );
    assert(
      run('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleShortVersionString',
        join(app, 'Contents', 'Info.plist'),
      ]) === version,
      'macOS app version mismatch',
    );
    run('codesign', ['--verify', '--deep', '--strict', app]);
    const details = run('codesign', ['-dv', '--verbose=4', app]);
    assert(
      signing !== 'ad-hoc' || details.includes('Signature=adhoc'),
      'Expected ad-hoc signature',
    );
    assert(
      signing === 'ad-hoc' || details.includes('Authority=Developer ID Application'),
      'Expected Developer ID signature',
    );
    if (signing === 'notarized') {
      assert(
        details.includes('runtime') && details.includes(`TeamIdentifier=${env.APPLE_TEAM_ID}`),
        'Expected hardened runtime and Apple team signature',
      );
      run('xcrun', ['stapler', 'validate', app]);
      run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    }
  }
  const assets = [];
  const installerFiles = new Map();
  for (const format of target.formats) {
    const directory = join(bundle, format.toLowerCase());
    const extension = format === 'nsis' ? '.exe' : `.${format}`;
    const matches = (await readdir(directory)).filter((name) => name.endsWith(extension));
    assert(matches.length === 1, `Expected exactly one ${format} bundle; found ${matches.length}`);
    const file = join(directory, matches[0]);
    const bytes = await readFile(file);
    checkMagic(bytes, format, target.arch);
    if (format === 'deb') {
      assert(
        run('dpkg-deb', ['-f', file, 'Version']) === version,
        'Debian package version mismatch',
      );
      assert(
        run('dpkg-deb', ['-f', file, 'Architecture']) ===
          (target.arch === 'arm64' ? 'arm64' : 'amd64'),
        'Debian package architecture mismatch',
      );
    }
    if (format === 'rpm') {
      assert(
        run('rpm', ['-qp', '--qf', '%{VERSION}', file]) === version,
        'RPM package version mismatch',
      );
      assert(
        run('rpm', ['-qp', '--qf', '%{ARCH}', file]) ===
          (target.arch === 'arm64' ? 'aarch64' : 'x86_64'),
        'RPM package architecture mismatch',
      );
    }
    if (target.platform === 'windows' && signing === 'signed') {
      const status = run(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-AuthenticodeSignature -FilePath $env:KUBEPIT_VERIFY_FILE).Status',
        ],
        { extraEnv: { KUBEPIT_VERIFY_FILE: file } },
      );
      assert(status === 'Valid', 'Installer Authenticode signature is not valid');
    }
    const name = assetName(version, target, format);
    installerFiles.set(format, file);
    await copyFile(file, join(output, name));
    assets.push({
      name,
      platform: target.platform,
      arch: target.arch,
      format,
      size: bytes.length,
      sha256: sha256(bytes),
      signing,
    });
  }
  let updater;
  if (updaterEnabled) {
    const artifacts = [];
    for (const entry of updaterEntries(version, target)) {
      let file = installerFiles.get(entry.format);
      if (entry.format === 'app.tar.gz') {
        const directory = join(bundle, 'macos');
        const matches = (await readdir(directory)).filter((name) => name.endsWith('.app.tar.gz'));
        assert(matches.length === 1, 'Expected exactly one macOS updater archive');
        file = join(directory, matches[0]);
      }
      const bytes = await readFile(file);
      const signature = await readFile(`${file}.sig`, 'utf8');
      verifyUpdaterSignature(bytes, signature, publicKey, version);
      await copyFile(file, join(output, entry.name));
      await writeFile(join(output, `${entry.name}.sig`), signature);
      artifacts.push({
        ...entry,
        size: bytes.length,
        sha256: sha256(bytes),
        signature: {
          name: `${entry.name}.sig`,
          size: Buffer.byteLength(signature),
          sha256: sha256(signature),
          content: signature,
        },
      });
    }
    updater = { schemaVersion: 1, publicKey, artifacts };
  }
  await writeFile(
    join(output, `${target.id}.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        target: target.id,
        version,
        commit: process.env.RELEASE_COMMIT,
        automationCommit: process.env.GITHUB_SHA,
        assets,
        ...(updater ? { updater } : {}),
      },
      null,
      2,
    ),
  );
  console.log(`Validated ${assets.length} ${target.id} installer(s); signing: ${signing}.`);
} finally {
  if (keychain) spawnSync('security', ['delete-keychain', keychain], { stdio: 'ignore' });
  if (windowsThumbprint)
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Remove-Item -Path 'Cert:\\CurrentUser\\My\\${windowsThumbprint}' -ErrorAction SilentlyContinue`,
      ],
      { stdio: 'ignore' },
    );
  await rm(temporary, { recursive: true, force: true });
}
