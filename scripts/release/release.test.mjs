import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { targets, assetName, sha256, homebrewCask, checkMagic } from './model.mjs';
import { assemble } from './assemble.mjs';

const metadata = {
  version: '0.0.1',
  tag: 'v0.0.1',
  repository: 'erdembas/kubepit',
  commit: 'a'.repeat(40),
  automationCommit: 'b'.repeat(40),
  prerelease: true,
  publishedAt: '2026-09-30T20:00:00Z',
};
function fixture(format, arch) {
  const bytes = Buffer.alloc(2048);
  if (format === 'dmg') bytes.write('koly', bytes.length - 512);
  if (format === 'deb') bytes.write('!<arch>\n');
  if (format === 'rpm') Buffer.from('edabeedb', 'hex').copy(bytes);
  if (format === 'msi') Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
  if (format === 'nsis') bytes.write('MZ');
  if (format === 'AppImage') {
    Buffer.from('7f454c4602010100', 'hex').copy(bytes);
    Buffer.from([65, 73, 2]).copy(bytes, 8);
    bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
  }
  return bytes;
}
async function staging(t) {
  const root = await mkdtemp(join(tmpdir(), 'kubepit-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  const output = join(root, 'output');
  await mkdir(input);
  for (const target of targets) {
    const assets = [];
    for (const format of target.formats) {
      const name = assetName(metadata.version, target, format);
      const bytes = fixture(format, target.arch);
      await writeFile(join(input, name), bytes);
      assets.push({
        name,
        platform: target.platform,
        arch: target.arch,
        format,
        sha256: sha256(bytes),
        size: bytes.length,
        signing: target.platform === 'macos' ? 'ad-hoc' : 'unsigned',
      });
    }
    await writeFile(
      join(input, `${target.id}.json`),
      JSON.stringify({
        schemaVersion: 1,
        version: metadata.version,
        target: target.id,
        commit: metadata.commit,
        automationCommit: metadata.automationCommit,
        assets,
      }),
    );
  }
  return { input, output };
}

test('complete six-target set generates 11 verified installers and checksum-pinned cask', async (t) => {
  const { input, output } = await staging(t);
  const manifest = await assemble(input, output, metadata);
  assert.equal(manifest.assets.length, 11);
  assert.equal(manifest.commit, metadata.commit);
  assert.equal(manifest.automationCommit, metadata.automationCommit);
  assert.equal(manifest.prerelease, true);
  const cask = await readFile(join(output, 'kubepit.rb'), 'utf8');
  assert.equal(sha256(cask), manifest.homebrew.sha256);
  assert.match(cask, /arch arm: "arm64", intel: "x64"/);
  assert.doesNotMatch(cask, /xattr|postflight|auto_updates|~\/\.kubepit/);
  const sums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
  assert.equal(sums.trim().split('\n').length, 12);
  assert.ok(sums.includes(`${sha256(cask)}  kubepit.rb`));
  for (const asset of manifest.assets) assert.ok(sums.includes(`${asset.sha256}  ${asset.name}`));
  const firstManifest = await readFile(join(output, 'release-manifest.json'), 'utf8');
  await assemble(input, output, metadata);
  assert.equal(await readFile(join(output, 'release-manifest.json'), 'utf8'), firstManifest);
});

test('incomplete matrix cannot publish a manifest', async (t) => {
  const { input, output } = await staging(t);
  await rm(join(input, 'windows-arm64.json'));
  await assert.rejects(assemble(input, output, metadata));
  await assert.rejects(readFile(join(output, 'release-manifest.json')));
});

test('tampered installer bytes fail checksum validation', async (t) => {
  const { input, output } = await staging(t);
  const path = join(input, assetName(metadata.version, targets[0], 'dmg'));
  const bytes = await readFile(path);
  bytes[64] = 255;
  await writeFile(path, bytes);
  await assert.rejects(assemble(input, output, metadata), /Integrity mismatch/);
});

test('mixed source commits or extra artifacts fail closed', async (t) => {
  const { input, output } = await staging(t);
  await assert.rejects(
    assemble(input, output, { ...metadata, commit: 'c'.repeat(40) }),
    /provenance/,
  );
  await writeFile(join(input, 'unverified.exe'), Buffer.alloc(2048));
  await assert.rejects(assemble(input, output, metadata), /Unexpected/);
});

test('AppImage architecture and Homebrew completeness are enforced', () => {
  assert.throws(() => checkMagic(fixture('AppImage', 'arm64'), 'AppImage', 'x64'), /architecture/);
  assert.throws(() => homebrewCask({ ...metadata, assets: [] }), /Both macOS/);
  assert.throws(() => assetName('../evil', targets[0], 'dmg'), /Invalid version/);
  assert.throws(() => assetName('0.0.1', targets[5], 'msi'), /Unsupported/);
});
