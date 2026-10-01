import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { assert, targets, versionPattern } from './model.mjs';
import { github } from './github.mjs';
import { updaterPublicKey } from './updater.mjs';

const tag = process.env.RELEASE_REF || process.env.GITHUB_REF_NAME;
assert(
  tag?.startsWith('v') && versionPattern.test(tag.slice(1)),
  'ref must be an existing v<semver> tag',
);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
assert(/^[a-f0-9]{40}$/.test(commit), 'Invalid resolved source commit');
const source = (path) => git('show', `${commit}:${path}`);
const version = JSON.parse(source('package.json')).version;
assert(tag === `v${version}`, 'Source version does not match release tag');
const config = JSON.parse(source('apps/desktop/src-tauri/tauri.conf.json'));
const updaterEnabled = config.bundle.createUpdaterArtifacts === true;
const publicKey = config.plugins?.updater?.pubkey || '';
if (updaterEnabled) {
  updaterPublicKey(publicKey);
  assert(
    process.env.UPDATER_SIGNING_CONFIGURED === 'true',
    'TAURI_SIGNING_PRIVATE_KEY must be configured before building a signed update',
  );
  assert(
    process.env.APPLE_NOTARIZATION_CONFIGURED === 'true',
    'All six Apple signing/notarization secrets are required before building a signed update',
  );
  const endpoint = `https://${process.env.GITHUB_REPOSITORY.split('/')[0]}.github.io/${process.env.GITHUB_REPOSITORY.split('/')[1]}/updates/latest.json`;
  assert(
    config.plugins.updater.endpoints?.length === 1 &&
      config.plugins.updater.endpoints[0] === endpoint,
    'Source updater must use the verified Pages feed',
  );
} else {
  assert(
    version === '0.0.1' && !publicKey,
    'New releases require a committed updater public key and createUpdaterArtifacts=true',
  );
}
for (const file of [
  'apps/desktop/package.json',
  'apps/website/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
]) {
  assert(JSON.parse(source(file)).version === version, `Version mismatch in ${file}`);
}
for (const file of ['crates/kubepit-core/Cargo.toml', 'apps/desktop/src-tauri/Cargo.toml']) {
  const section = source(file).match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  assert(
    section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] === version,
    `Version mismatch in ${file}`,
  );
}
const lock = source('Cargo.lock');
for (const name of ['kubepit-core', 'kubepit-desktop'])
  assert(
    lock.includes(`name = "${name}"\nversion = "${version}"`),
    `Cargo.lock mismatch for ${name}`,
  );
let release;
try {
  release = await github(`repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${tag}`);
} catch (error) {
  if (error.status !== 404) throw error;
}
const prerelease =
  release?.prerelease ?? (process.env.RELEASE_PRERELEASE === 'true' || version.includes('-'));
// Keep the original manifest date on full-workflow retries. Before a first
// publication use the existing release date, or the frozen source timestamp.
let publishedAt = release?.published_at || git('show', '-s', '--format=%cI', commit);
const existingManifest = release?.assets?.find((asset) => asset.name === 'release-manifest.json');
if (existingManifest) {
  const previous = JSON.parse(
    await github(`repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${existingManifest.id}`, {
      binary: true,
    }),
  );
  assert(
    previous.commit === commit && previous.tag === tag,
    'Existing release manifest provenance mismatch',
  );
  publishedAt = previous.publishedAt;
}
assert(Number.isFinite(Date.parse(publishedAt)), 'Invalid release timestamp');
const output = {
  tag,
  commit,
  version,
  prerelease: String(prerelease),
  published_at: new Date(publishedAt).toISOString(),
  updater_enabled: String(updaterEnabled),
  updater_public_key: publicKey,
  matrix: JSON.stringify({ include: targets }),
};
for (const [key, value] of Object.entries(output))
  await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
console.log(
  `Release source ${tag} resolves to ${commit}; automation ${process.env.GITHUB_SHA}. No tag will be created or moved.`,
);
