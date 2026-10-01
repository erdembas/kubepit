import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './model.mjs';
import { assemble } from './assemble.mjs';
import {
  updaterSignature,
  verifyUpdaterSignature,
  validateUpdaterFeed,
  releaseNotesFromChangelog,
} from './updater.mjs';
import { signedReleaseFixture, signingFixture } from './fixtures/updater.mjs';

test('six-target signed release preserves all native installer formats and checksums', async (t) => {
  const fixture = await signedReleaseFixture(t);
  const { manifest, feedText, checksums, githubAssets, publicKey, output } = fixture;
  const feed = validateUpdaterFeed(manifest, feedText, checksums, githubAssets, publicKey);
  assert.equal(manifest.updater.artifacts.length, 11);
  assert.equal(Object.keys(feed.platforms).length, 13);
  assert.equal(checksums.trimEnd().split('\n').length, 26);
  assert.equal((await readdir(output)).length, 28);
  assert.match(feed.platforms['windows-x86_64-msi'].url, /\.msi$/);
  assert.match(feed.platforms['windows-x86_64'].url, /-setup\.exe$/);
  assert.equal(feed.platforms['windows-x86_64'].url, feed.platforms['windows-x86_64-nsis'].url);
  assert.match(feed.platforms['linux-aarch64'].url, /\.AppImage$/);
  assert.match(feed.platforms['linux-aarch64-deb'].url, /\.deb$/);
  assert.match(feed.platforms['linux-x86_64-rpm'].url, /\.rpm$/);
  assert.equal(feed.notes, manifest.releaseNotes);
  const first = await readFile(join(output, 'release-manifest.json'));
  await assemble(fixture.input, output, fixture.metadata);
  assert.deepEqual(await readFile(join(output, 'release-manifest.json')), first);
});

test('Ed25519 verifies both Minisign formats and rejects byte, version, key and trusted-comment tampering', () => {
  const fixture = signingFixture();
  const bytes = Buffer.from('signed update fixture');
  for (const prehashed of [true, false]) {
    const signature = fixture.sign(bytes, '0.0.2', { prehashed });
    verifyUpdaterSignature(bytes, signature, fixture.publicKey, '0.0.2');
    assert.throws(
      () => verifyUpdaterSignature(Buffer.from('tampered'), signature, fixture.publicKey, '0.0.2'),
      /payload signature/,
    );
    assert.throws(
      () => verifyUpdaterSignature(bytes, signature, fixture.publicKey, '0.0.3'),
      /version mismatch/,
    );
    assert.throws(
      () => verifyUpdaterSignature(bytes, signature, signingFixture().publicKey, '0.0.2'),
      /comment signature/,
    );
    const comment = Buffer.from(signature, 'base64')
      .toString()
      .replace('timestamp:1', 'timestamp:2');
    assert.throws(
      () => updaterSignature(fixture.publicKey, Buffer.from(comment).toString('base64'), '0.0.2'),
      /comment signature/,
    );
  }
});

test('assembly rejects a missing signature, wrong public key and non-notarized macOS updater', async (t) => {
  const fixture = await signedReleaseFixture(t);
  await assert.rejects(
    assemble(fixture.input, fixture.output, {
      ...fixture.metadata,
      updaterPublicKey: signingFixture().publicKey,
    }),
    /signing key/,
  );
  const path = join(fixture.input, 'macos-arm64.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.assets[0].signing = 'ad-hoc';
  await writeFile(path, JSON.stringify(report));
  await assert.rejects(assemble(fixture.input, fixture.output, fixture.metadata), /notarized/);
  report.assets[0].signing = 'notarized';
  await writeFile(path, JSON.stringify(report));
  await rm(join(fixture.input, report.updater.artifacts[0].signature.name));
  await assert.rejects(assemble(fixture.input, fixture.output, fixture.metadata), /ENOENT/);
});

test('hashes alone cannot substitute an unsigned or incorrectly signed update', async (t) => {
  const fixture = await signedReleaseFixture(t);
  const reportPath = join(fixture.input, 'linux-arm64.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const artifact = report.updater.artifacts[0];
  const bytes = await readFile(join(fixture.input, artifact.name));
  bytes[100] ^= 1;
  artifact.sha256 = sha256(bytes);
  report.assets.find((asset) => asset.name === artifact.name).sha256 = sha256(bytes);
  await writeFile(join(fixture.input, artifact.name), bytes);
  await writeFile(reportPath, JSON.stringify(report));
  await assert.rejects(
    assemble(fixture.input, fixture.output, fixture.metadata),
    /payload signature/,
  );
});

test('feed requires every signed platform, expected key and matching published digests', async (t) => {
  const fixture = await signedReleaseFixture(t);
  const validate = (
    manifest = fixture.manifest,
    feed = fixture.feedText,
    sums = fixture.checksums,
    assets = fixture.githubAssets,
    key = fixture.publicKey,
  ) => validateUpdaterFeed(manifest, feed, sums, assets, key);
  assert.throws(() => validate(undefined, `${fixture.feedText} `), /feed checksum/);
  assert.throws(
    () =>
      validate(
        undefined,
        undefined,
        undefined,
        fixture.githubAssets.filter(
          (asset) => asset.name !== fixture.manifest.updater.artifacts[0].signature.name,
        ),
      ),
    /completely published/,
  );
  assert.throws(
    () => validate(undefined, undefined, undefined, undefined, signingFixture().publicKey),
    /trusted application key/,
  );
  const assets = structuredClone(fixture.githubAssets);
  assets.find((asset) => asset.name === fixture.manifest.updater.artifacts[0].name).digest =
    `sha256:${'f'.repeat(64)}`;
  assert.throws(() => validate(undefined, undefined, undefined, assets), /digest mismatch/);
  const manifest = structuredClone(fixture.manifest);
  manifest.updater.artifacts[0].platformKeys = ['darwin-x86_64'];
  assert.throws(() => validate(manifest), /platform key mismatch/);
});

test('release notes come only from the exact frozen version section', () => {
  const changelog =
    '# Changelog\n\n## 0.0.3 — Future\nFuture content\n\n## 0.0.2 — Update\n\n### English\nNew features.\n\n### Türkçe\nYeni özellikler.\n\n## 0.0.1 — Initial\nOld content';
  const notes = releaseNotesFromChangelog(changelog, '0.0.2');
  assert.match(notes, /New features/);
  assert.match(notes, /Yeni özellikler/);
  assert.doesNotMatch(notes, /Future|Old content/);
  assert.throws(() => releaseNotesFromChangelog(changelog, '0.0.4'), /no 0.0.4/);
});
