import { readFile, writeFile, mkdir, readdir, copyFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  targets,
  assert,
  assetName,
  sha256,
  checkMagic,
  homebrewCask,
  versionPattern,
} from './model.mjs';

export async function assemble(input, output, metadata) {
  const { version, tag, repository, commit, automationCommit, prerelease, publishedAt } = metadata;
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
  const sums =
    [...assets.map((a) => `${a.sha256}  ${a.name}`), `${manifest.homebrew.sha256}  kubepit.rb`]
      .sort()
      .join('\n') + '\n';
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
  });
  console.log(
    `Validated complete release: ${manifest.assets.length} installers, Homebrew cask and SHA256SUMS.`,
  );
}
