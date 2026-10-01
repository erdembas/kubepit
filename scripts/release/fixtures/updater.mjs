/** Synthetic, disposable Ed25519 fixtures. Never imported by the release CLI. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName, sha256, targets } from '../model.mjs';
import { updaterEntries } from '../updater.mjs';
import { assemble } from '../assemble.mjs';

export function signingFixture() {
  const keys = generateKeyPairSync('ed25519');
  const keyId = Buffer.from('0102030405060708', 'hex');
  const key = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const packet = Buffer.concat([Buffer.from('Ed'), keyId, key]);
  const publicKey = Buffer.from(
    `untrusted comment: disposable test key\n${packet.toString('base64')}\n`,
  ).toString('base64');
  return {
    publicKey,
    sign(bytes, version, { prehashed = true } = {}) {
      const message = prehashed ? createHash('blake2b512').update(bytes).digest() : bytes;
      const signature = sign(null, message, keys.privateKey);
      const comment = `timestamp:1\tfile:fixture\tversion:${version}`;
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), keys.privateKey);
      const signed = Buffer.concat([Buffer.from(prehashed ? 'ED' : 'Ed'), keyId, signature]);
      return Buffer.from(
        `untrusted comment: fixture only\n${signed.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
      ).toString('base64');
    },
  };
}

function installerBytes(format, arch) {
  const bytes = Buffer.alloc(2048);
  if (format === 'dmg') bytes.write('koly', bytes.length - 512);
  if (format === 'deb') bytes.write('!<arch>\n');
  if (format === 'rpm') Buffer.from('edabeedb', 'hex').copy(bytes);
  if (format === 'msi') Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
  if (format === 'nsis') bytes.write('MZ');
  if (format === 'app.tar.gz') Buffer.from([31, 139, 8]).copy(bytes);
  if (format === 'AppImage') {
    Buffer.from('7f454c4602010100', 'hex').copy(bytes);
    Buffer.from([65, 73, 2]).copy(bytes, 8);
    bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
  }
  return bytes;
}

export async function signedReleaseFixture(t, overrides = {}) {
  const key = signingFixture();
  const metadata = {
    version: '0.0.2',
    tag: 'v0.0.2',
    repository: 'erdembas/kubepit',
    commit: 'a'.repeat(40),
    automationCommit: 'b'.repeat(40),
    prerelease: true,
    publishedAt: '2026-10-01T00:00:00.000Z',
    updaterEnabled: true,
    updaterPublicKey: key.publicKey,
    releaseNotes: '### English\nSigned updates.\n\n### Türkçe\nİmzalı güncellemeler.',
    ...overrides,
  };
  const root = await mkdtemp(join(tmpdir(), 'kubepit-signed-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input'),
    output = join(root, 'output');
  await mkdir(input);
  for (const target of targets) {
    const assets = [];
    for (const format of target.formats) {
      const name = assetName(metadata.version, target, format);
      const bytes = installerBytes(format, target.arch);
      await writeFile(join(input, name), bytes);
      assets.push({
        name,
        platform: target.platform,
        arch: target.arch,
        format,
        size: bytes.length,
        sha256: sha256(bytes),
        signing: target.platform === 'macos' ? 'notarized' : 'unsigned',
      });
    }
    const artifacts = [];
    for (const entry of updaterEntries(metadata.version, target)) {
      const bytes = installerBytes(entry.format, target.arch);
      const content = key.sign(bytes, metadata.version);
      await writeFile(join(input, entry.name), bytes);
      await writeFile(join(input, `${entry.name}.sig`), content);
      artifacts.push({
        ...entry,
        size: bytes.length,
        sha256: sha256(bytes),
        signature: {
          name: `${entry.name}.sig`,
          size: Buffer.byteLength(content),
          sha256: sha256(content),
          content,
        },
      });
    }
    await writeFile(
      join(input, `${target.id}.json`),
      JSON.stringify({
        schemaVersion: 1,
        target: target.id,
        version: metadata.version,
        commit: metadata.commit,
        automationCommit: metadata.automationCommit,
        assets,
        updater: { schemaVersion: 1, publicKey: key.publicKey, artifacts },
      }),
    );
  }
  const manifest = await assemble(input, output, metadata);
  const feedText = await readFile(join(output, 'latest.json'), 'utf8');
  const checksums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
  const githubAssets = await Promise.all(
    (await readdir(output)).map(async (name, index) => {
      const bytes = await readFile(join(output, name));
      return {
        id: index + 1,
        name,
        size: bytes.length,
        state: 'uploaded',
        digest: `sha256:${sha256(bytes)}`,
        browser_download_url: `https://github.com/${metadata.repository}/releases/download/${metadata.tag}/${name}`,
      };
    }),
  );
  return {
    root,
    input,
    output,
    metadata,
    manifest,
    feedText,
    checksums,
    githubAssets,
    publicKey: key.publicKey,
    sign: key.sign,
  };
}
