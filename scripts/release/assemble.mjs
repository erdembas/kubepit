import { readFile, writeFile, mkdir, readdir, copyFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  targets,
  assert,
  assetName,
  sha256,
  checkMagic,
  homebrewCask,
  versionPattern,
} from './model.mjs';
import {
  updaterEntries,
  updaterFeed,
  updaterPublicKey,
  verifyUpdaterSignature,
  validateUpdaterFeed,
  releaseNotesFromChangelog,
} from './updater.mjs';

export async function assemble(input, output, metadata) {
  const { version, tag, repository, commit, automationCommit, prerelease, publishedAt } = metadata;
  const updaterEnabled = metadata.updaterEnabled === true;
  const publicKey = metadata.updaterPublicKey || '';
  if (updaterEnabled) {
    updaterPublicKey(publicKey);
    assert(
      typeof metadata.releaseNotes === 'string' &&
        metadata.releaseNotes.length > 0 &&
        Buffer.byteLength(metadata.releaseNotes) <= 64 * 1024,
      'Signed update release notes are required',
    );
  } else assert(version === '0.0.1', 'New releases require a complete signed updater');
  assert(versionPattern.test(version) && tag === `v${version}`, 'Invalid version/tag');
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid repository');
  assert(
    /^[a-f0-9]{40}$/.test(commit) && /^[a-f0-9]{40}$/.test(automationCommit),
    'Invalid source/automation commit',
  );
  assert(
    typeof prerelease === 'boolean' && Number.isFinite(Date.parse(publishedAt)),
    'Invalid release metadata',
  );
  const entries = await readdir(input);
  const expectedFiles = [];
  const assets = [];
  const updaterArtifacts = [];
  await mkdir(output, { recursive: true });
  for (const target of targets) {
    const reportName = `${target.id}.json`;
    expectedFiles.push(reportName);
    const report = JSON.parse(await readFile(join(input, reportName), 'utf8'));
    assert(
      report.target === target.id &&
        report.version === version &&
        report.commit === commit &&
        report.automationCommit === automationCommit &&
        report.schemaVersion === 1,
      `Invalid ${target.id} provenance`,
    );
    assert(
      Array.isArray(report.assets) && report.assets.length === target.formats.length,
      `Incomplete ${target.id} build`,
    );
    for (const format of target.formats) {
      const name = assetName(version, target, format);
      const matches = report.assets.filter((a) => a.name === name);
      assert(matches.length === 1, `Missing/duplicate asset ${name}`);
      const asset = matches[0];
      assert(
        asset.platform === target.platform && asset.arch === target.arch && asset.format === format,
        `Asset target mismatch ${name}`,
      );
      assert(
        (target.platform === 'macos'
          ? ['ad-hoc', 'signed', 'notarized']
          : target.platform === 'windows'
            ? ['unsigned', 'signed']
            : ['unsigned']
        ).includes(asset.signing),
        `Invalid signing state ${name}`,
      );
      const path = join(input, name);
      assert((await lstat(path)).isFile(), `Asset must be a regular file: ${name}`);
      const bytes = await readFile(path);
      checkMagic(bytes, format, target.arch);
      assert(
        asset.size === bytes.length && asset.sha256 === sha256(bytes),
        `Integrity mismatch: ${name}`,
      );
      assets.push({
        ...asset,
        url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
      });
      expectedFiles.push(name);
      await copyFile(path, join(output, name));
    }
    if (updaterEnabled) {
      assert(
        report.updater?.schemaVersion === 1 && report.updater.publicKey === publicKey,
        `Invalid ${target.id} updater signing key`,
      );
      const expected = updaterEntries(version, target);
      assert(
        Array.isArray(report.updater.artifacts) &&
          report.updater.artifacts.length === expected.length,
        `Incomplete ${target.id} updater artifacts`,
      );
      if (target.platform === 'macos')
        assert(
          report.assets.every((asset) => asset.signing === 'notarized'),
          'Signed updates require notarized macOS installers',
        );
      for (const entry of expected) {
        const matches = report.updater.artifacts.filter((artifact) => artifact.name === entry.name);
        assert(matches.length === 1, 'Missing or duplicate updater artifact');
        const artifact = matches[0];
        for (const field of ['target', 'platform', 'arch', 'format'])
          assert(artifact[field] === entry[field], `Updater target mismatch: ${entry.name}`);
        assert(
          JSON.stringify(artifact.platformKeys) === JSON.stringify(entry.platformKeys),
          'Updater platform key mismatch',
        );
        const path = join(input, entry.name);
        assert((await lstat(path)).isFile(), 'Updater artifact must be a regular file');
        const bytes = await readFile(path);
        assert(
          bytes.length === artifact.size && sha256(bytes) === artifact.sha256,
          'Updater artifact integrity mismatch',
        );
        if (entry.format === 'app.tar.gz')
          assert(
            bytes.length >= 1024 && bytes.subarray(0, 3).equals(Buffer.from([31, 139, 8])),
            'Invalid macOS updater gzip archive',
          );
        else checkMagic(bytes, entry.format, entry.arch);
        const signature = artifact.signature;
        assert(signature?.name === `${entry.name}.sig`, 'Updater signature filename mismatch');
        const signaturePath = join(input, signature.name);
        assert((await lstat(signaturePath)).isFile(), 'Updater signature must be a regular file');
        const signatureBytes = await readFile(signaturePath);
        assert(
          signatureBytes.length === signature.size &&
            sha256(signatureBytes) === signature.sha256 &&
            signatureBytes.toString('utf8') === signature.content,
          'Updater signature integrity mismatch',
        );
        verifyUpdaterSignature(bytes, signature.content, publicKey, version);
        updaterArtifacts.push({
          ...entry,
          size: bytes.length,
          sha256: artifact.sha256,
          url: `https://github.com/${repository}/releases/download/${tag}/${entry.name}`,
          signature: {
            ...signature,
            url: `https://github.com/${repository}/releases/download/${tag}/${signature.name}`,
          },
        });
        if (!expectedFiles.includes(entry.name)) expectedFiles.push(entry.name);
        expectedFiles.push(signature.name);
        await copyFile(path, join(output, entry.name));
        await copyFile(signaturePath, join(output, signature.name));
      }
    } else assert(!report.updater, 'Unexpected updater artifacts in legacy release');
  }
  assert(
    entries.length === expectedFiles.length &&
      entries.every((name) => expectedFiles.includes(name)),
    'Unexpected or duplicate artifact files',
  );
  assets.sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    schemaVersion: 1,
    version,
    tag,
    repository,
    commit,
    automationCommit,
    prerelease,
    publishedAt,
    releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    assets,
    ...(updaterEnabled ? { releaseNotes: metadata.releaseNotes } : {}),
  };
  const cask = homebrewCask(manifest);
  await writeFile(join(output, 'kubepit.rb'), cask);
  manifest.homebrew = {
    caskUrl: `https://github.com/${repository}/releases/download/${tag}/kubepit.rb`,
    sha256: sha256(cask),
    tap: null,
    installCommand: null,
  };
  manifest.checksums = {
    name: 'SHA256SUMS',
    url: `https://github.com/${repository}/releases/download/${tag}/SHA256SUMS`,
  };
  const checksumAssets = new Map(assets.map((asset) => [asset.name, asset.sha256]));
  checksumAssets.set('kubepit.rb', manifest.homebrew.sha256);
  let feedText;
  if (updaterEnabled) {
    manifest.updater = { schemaVersion: 1, publicKey, artifacts: updaterArtifacts };
    feedText = `${JSON.stringify(updaterFeed(manifest), null, 2)}\n`;
    manifest.updater.feed = {
      name: 'latest.json',
      size: Buffer.byteLength(feedText),
      sha256: sha256(feedText),
      url: `https://github.com/${repository}/releases/download/${tag}/latest.json`,
    };
    for (const artifact of updaterArtifacts) {
      checksumAssets.set(artifact.name, artifact.sha256);
      checksumAssets.set(artifact.signature.name, artifact.signature.sha256);
    }
    checksumAssets.set('latest.json', manifest.updater.feed.sha256);
    await writeFile(join(output, 'latest.json'), feedText);
  }
  const sums =
    [...checksumAssets]
      .map(([name, hash]) => `${hash}  ${name}`)
      .sort()
      .join('\n') + '\n';
  if (updaterEnabled) {
    const published = [
      ...assets,
      ...updaterArtifacts.flatMap((artifact) => [artifact, artifact.signature]),
      manifest.updater.feed,
    ]
      .filter((asset, index, all) => all.findIndex((item) => item.name === asset.name) === index)
      .map((asset) => ({
        name: asset.name,
        size: asset.size,
        state: 'uploaded',
        browser_download_url: asset.url,
        digest: `sha256:${asset.sha256}`,
      }));
    validateUpdaterFeed(manifest, feedText, sums, published, publicKey);
  }
  await writeFile(join(output, 'SHA256SUMS'), sums);
  await writeFile(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await assemble(resolve('release-input'), resolve('release-output'), {
    version: process.env.RELEASE_VERSION,
    tag: process.env.RELEASE_TAG,
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.RELEASE_COMMIT,
    automationCommit: process.env.GITHUB_SHA,
    prerelease: process.env.RELEASE_PRERELEASE === 'true',
    publishedAt: process.env.RELEASE_PUBLISHED_AT,
    updaterEnabled: process.env.RELEASE_UPDATER_ENABLED === 'true',
    updaterPublicKey: process.env.RELEASE_UPDATER_PUBLIC_KEY,
    releaseNotes:
      process.env.RELEASE_UPDATER_ENABLED === 'true'
        ? releaseNotesFromChangelog(
            execFileSync('git', ['show', `${process.env.RELEASE_COMMIT}:CHANGELOG.md`], {
              encoding: 'utf8',
              maxBuffer: 1024 * 1024,
            }),
            process.env.RELEASE_VERSION,
          )
        : undefined,
  });
  console.log(
    `Validated complete release: ${manifest.assets.length} installers, Homebrew cask and SHA256SUMS.`,
  );
}
