import { createHash, createPublicKey, verify } from 'node:crypto';
import { assert, assetName, sha256, targets, versionPattern } from './model.mjs';

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function decodeBase64(value, label) {
  assert(
    typeof value === 'string' && value.length > 0 && base64Pattern.test(value),
    `Invalid ${label} encoding`,
  );
  const decoded = Buffer.from(value, 'base64');
  assert(decoded.toString('base64') === value, `Noncanonical ${label} encoding`);
  return decoded;
}

/** Parse Tauri's base64-wrapped Minisign public key, using Node's Ed25519 implementation. */
export function updaterPublicKey(value) {
  const lines = decodeBase64(value, 'updater public key').toString('utf8').trimEnd().split(/\r?\n/);
  assert(
    lines.length === 2 && lines[0].startsWith('untrusted comment: '),
    'Invalid updater public key',
  );
  const bytes = decodeBase64(lines[1], 'Minisign public key');
  assert(
    bytes.length === 42 && ['Ed', 'ED'].includes(bytes.subarray(0, 2).toString()),
    'Invalid updater public key algorithm',
  );
  return {
    keyId: bytes.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

/** Authenticate the signed trusted comment without needing to download the large payload. */
export function updaterSignature(publicKey, encoded, version) {
  const publicPart = updaterPublicKey(publicKey);
  const lines = decodeBase64(encoded, 'updater signature')
    .toString('utf8')
    .trimEnd()
    .split(/\r?\n/);
  assert(
    lines.length === 4 &&
      lines[0].startsWith('untrusted comment: ') &&
      lines[2].startsWith('trusted comment: '),
    'Invalid Minisign signature',
  );
  const packet = decodeBase64(lines[1], 'Minisign signature packet');
  const global = decodeBase64(lines[3], 'Minisign comment signature');
  assert(packet.length === 74 && global.length === 64, 'Invalid Minisign signature length');
  const algorithm = packet.subarray(0, 2).toString();
  assert(['Ed', 'ED'].includes(algorithm), 'Unsupported Minisign signature algorithm');
  assert(packet.subarray(2, 10).equals(publicPart.keyId), 'Updater signing key mismatch');
  const signature = packet.subarray(10);
  const comment = lines[2].slice('trusted comment: '.length);
  const versions = comment.split('\t').filter((field) => field.startsWith('version:'));
  assert(
    versionPattern.test(version) && versions.length === 1 && versions[0] === `version:${version}`,
    'Updater signature version mismatch',
  );
  assert(
    verify(null, Buffer.concat([signature, Buffer.from(comment)]), publicPart.key, global),
    'Updater trusted comment signature is invalid',
  );
  return { key: publicPart.key, signature, prehashed: algorithm === 'ED' };
}

/** Verify exactly the bytes Tauri will install, including its authenticated version. */
export function verifyUpdaterSignature(bytes, encoded, publicKey, version) {
  const signature = updaterSignature(publicKey, encoded, version);
  const message = signature.prehashed ? createHash('blake2b512').update(bytes).digest() : bytes;
  assert(
    verify(null, message, signature.key, signature.signature),
    'Updater payload signature is invalid',
  );
}

export function updaterEntries(version, target) {
  assert(versionPattern.test(version), 'Invalid updater version');
  const arch = target.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const os = target.platform === 'macos' ? 'darwin' : target.platform;
  const base = `${os}-${arch}`;
  const formats = target.platform === 'macos' ? ['app.tar.gz'] : target.formats;
  return formats.map((format) => ({
    target: target.id,
    platform: target.platform,
    arch: target.arch,
    format,
    name:
      format === 'app.tar.gz'
        ? `Kubepit_${version}_macos_${target.arch}.app.tar.gz`
        : assetName(version, target, format),
    platformKeys:
      target.platform === 'windows'
        ? format === 'nsis'
          ? [base, `${base}-nsis`]
          : [`${base}-msi`]
        : target.platform === 'linux' && format !== 'AppImage'
          ? [`${base}-${format}`]
          : [base],
  }));
}

export function updaterFeed(manifest) {
  const platforms = {};
  for (const artifact of manifest.updater.artifacts)
    for (const key of artifact.platformKeys) {
      assert(!platforms[key], 'Duplicate updater platform');
      platforms[key] = { url: artifact.url, signature: artifact.signature.content };
    }
  return {
    version: manifest.version,
    notes:
      manifest.releaseNotes ||
      `Kubepit ${manifest.version}: signed desktop update. / İmzalı masaüstü güncellemesi.\n${manifest.releaseUrl}`,
    pub_date: manifest.publishedAt,
    platforms,
  };
}

export function releaseNotesFromChangelog(changelog, version) {
  assert(versionPattern.test(version), 'Invalid changelog version');
  const sections = changelog.split(/(?=^## )/m);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = sections.find((entry) =>
    new RegExp(`^## \\[?${escaped}\\]?(?=\\s|$)`).test(entry),
  );
  assert(section, `CHANGELOG.md has no ${version} release notes`);
  const notes = section
    .replace(/^## [^\n]*\n/, '')
    .replace(/^<!-- kubepit-actions: [a-z,-]+ -->\s*$/m, '')
    .trim();
  assert(
    notes.length > 0 && Buffer.byteLength(notes) <= 64 * 1024,
    'Release notes are missing or too large',
  );
  return notes;
}

/** Metadata-only validation shared by Pages: no installer execution or credential access. */
export function validateUpdaterFeed(
  manifest,
  feedText,
  checksums,
  githubAssets,
  expectedPublicKey,
) {
  const updater = manifest.updater;
  assert(
    updater?.schemaVersion === 1 && updater.publicKey === expectedPublicKey,
    'Updater public key is not the trusted application key',
  );
  updaterPublicKey(expectedPublicKey);
  assert(
    versionPattern.test(manifest.version) && manifest.tag === `v${manifest.version}`,
    'Invalid updater release version',
  );
  assert(
    typeof manifest.releaseNotes === 'string' &&
      manifest.releaseNotes.length > 0 &&
      Buffer.byteLength(manifest.releaseNotes) <= 64 * 1024,
    'Invalid signed update release notes',
  );
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository),
    'Invalid updater repository',
  );
  const root = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/`;
  const sums = checksums instanceof Map ? checksums : new Map();
  if (!(checksums instanceof Map))
    for (const line of checksums.trimEnd().split('\n')) {
      const entry = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/);
      assert(entry && !sums.has(entry[2]), 'Invalid updater checksums');
      sums.set(entry[2], entry[1]);
    }
  const validateAsset = (asset, name) => {
    assert(
      asset?.name === name &&
        asset.url === `${root}${name}` &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        /^[a-f0-9]{64}$/.test(asset.sha256),
      `Invalid updater metadata: ${name}`,
    );
    assert(sums.get(name) === asset.sha256, `Updater checksum mismatch: ${name}`);
    const published = githubAssets.filter((item) => item.name === name);
    assert(
      published.length === 1 &&
        published[0].state === 'uploaded' &&
        published[0].size === asset.size &&
        published[0].browser_download_url === asset.url,
      `Updater asset is not completely published: ${name}`,
    );
    if (published[0].digest != null)
      assert(
        published[0].digest === `sha256:${asset.sha256}`,
        `Published updater digest mismatch: ${name}`,
      );
  };
  validateAsset(updater.feed, 'latest.json');
  assert(
    typeof feedText === 'string' &&
      Buffer.byteLength(feedText) === updater.feed.size &&
      sha256(feedText) === updater.feed.sha256,
    'Updater feed checksum mismatch',
  );
  const expected = targets.flatMap((target) => updaterEntries(manifest.version, target));
  const installers = targets.flatMap((target) =>
    target.formats.map((format) => ({
      name: assetName(manifest.version, target, format),
      platform: target.platform,
      arch: target.arch,
      format,
    })),
  );
  assert(
    Array.isArray(manifest.assets) && manifest.assets.length === installers.length,
    'Incomplete installer set for updater release',
  );
  for (const entry of installers) {
    const matches = manifest.assets.filter((asset) => asset.name === entry.name);
    assert(matches.length === 1, 'Missing or duplicate installer for updater release');
    const asset = matches[0];
    for (const field of ['platform', 'arch', 'format'])
      assert(asset[field] === entry[field], 'Installer target mismatch for updater release');
    if (entry.platform === 'macos')
      assert(asset.signing === 'notarized', 'Updater release macOS installers must be notarized');
    validateAsset(asset, entry.name);
  }
  const expectedNames = new Set([
    ...installers.map((entry) => entry.name),
    ...expected.flatMap((entry) => [entry.name, `${entry.name}.sig`]),
    'kubepit.rb',
    'latest.json',
  ]);
  assert(
    sums.size === expectedNames.size && [...sums.keys()].every((name) => expectedNames.has(name)),
    'Unexpected updater checksum entries',
  );
  assert(
    sums.get('kubepit.rb') === manifest.homebrew?.sha256,
    'Updater release cask checksum mismatch',
  );
  assert(
    Array.isArray(updater.artifacts) && updater.artifacts.length === expected.length,
    'Incomplete updater artifact set',
  );
  for (const entry of expected) {
    const matches = updater.artifacts.filter((artifact) => artifact.name === entry.name);
    assert(matches.length === 1, 'Missing or duplicate updater artifact');
    const artifact = matches[0];
    for (const field of ['target', 'platform', 'arch', 'format'])
      assert(artifact[field] === entry[field], `Updater target mismatch: ${entry.name}`);
    assert(
      JSON.stringify(artifact.platformKeys) === JSON.stringify(entry.platformKeys),
      'Updater platform key mismatch',
    );
    validateAsset(artifact, entry.name);
    validateAsset(artifact.signature, `${entry.name}.sig`);
    // Tauri writes its base64 signature without a newline. Requiring its exact
    // bytes makes the embedded feed signature agree with the checked sidecar.
    assert(
      Buffer.byteLength(artifact.signature.content || '') === artifact.signature.size &&
        sha256(artifact.signature.content) === artifact.signature.sha256,
      'Updater signature content mismatch',
    );
    updaterSignature(expectedPublicKey, artifact.signature.content, manifest.version);
  }
  const feed = JSON.parse(feedText);
  const expectedFeed = updaterFeed(manifest);
  assert(
    feed.version === expectedFeed.version &&
      feed.pub_date === expectedFeed.pub_date &&
      feed.notes === expectedFeed.notes,
    'Updater feed release metadata mismatch',
  );
  assert(
    feed.platforms &&
      Object.keys(feed.platforms).length === Object.keys(expectedFeed.platforms).length,
    'Incomplete updater feed',
  );
  for (const [key, entry] of Object.entries(expectedFeed.platforms))
    assert(
      feed.platforms[key]?.url === entry.url && feed.platforms[key]?.signature === entry.signature,
      `Updater feed platform mismatch: ${key}`,
    );
  return feed;
}
