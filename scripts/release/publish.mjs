import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assert, sha256 } from './model.mjs';
import { github } from './github.mjs';

const directory = resolve('release-output');
const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY;
assert(
  manifest.repository === repository && manifest.commit === process.env.RELEASE_COMMIT,
  'Publication provenance mismatch',
);
// Fetch again immediately before publication; an externally moved tag fails closed.
execFileSync(
  'git',
  ['fetch', '--force', 'origin', `refs/tags/${manifest.tag}:refs/tags/${manifest.tag}`],
  { stdio: 'inherit' },
);
const actualCommit = execFileSync('git', ['rev-parse', `refs/tags/${manifest.tag}^{commit}`], {
  encoding: 'utf8',
}).trim();
assert(actualCommit === manifest.commit, 'Release tag changed while the builders were running');
let release;
try {
  release = await github(`repos/${repository}/releases/tags/${manifest.tag}`);
} catch (error) {
  if (error.status !== 404) throw error;
}
if (!release)
  release = await github(`repos/${repository}/releases`, {
    method: 'POST',
    body: {
      tag_name: manifest.tag,
      name: `Kubepit ${manifest.tag}`,
      draft: true,
      prerelease: manifest.prerelease,
      body: `${manifest.releaseNotes ? `${manifest.releaseNotes}\n\n---\n\n` : ''}Desktop installers built from ${manifest.commit}.\n\nMasaüstü kurulum paketleri ${manifest.commit} kaynak kodundan derlendi.\n\nSee release-manifest.json for architectures, checksums and signing status. İmza ve platform bilgileri için release-manifest.json dosyasına bakın.`,
    },
  });
assert(release.prerelease === manifest.prerelease, 'Release prerelease flag changed during build');
assert(!release.immutable, 'An immutable release cannot accept additional assets');
const names = await readdir(directory);
const expected = [
  ...manifest.assets.map((a) => a.name),
  ...new Set(
    (manifest.updater?.artifacts || [])
      .flatMap((artifact) => [artifact.name, artifact.signature.name])
      .filter((name) => !manifest.assets.some((asset) => asset.name === name)),
  ),
  'kubepit.rb',
  ...(manifest.updater ? ['latest.json'] : []),
  'SHA256SUMS',
  'release-manifest.json',
];
assert(
  names.length === expected.length && names.every((n) => expected.includes(n)),
  'Unexpected publication files',
);
// Preflight all collisions before uploading anything. Published bytes are never
// clobbered: changing a distributed installer requires a new version.
const pending = [];
for (const name of expected) {
  const bytes = await readFile(join(directory, name));
  const found = release.assets.filter((a) => a.name === name);
  assert(found.length <= 1, `Duplicate existing release asset: ${name}`);
  if (found.length) {
    const existing = found[0];
    assert(existing.size === bytes.length, `Refusing to replace published asset ${name}`);
    const digest = existing.digest?.startsWith('sha256:')
      ? existing.digest.slice(7)
      : sha256(
          await github(`repos/${repository}/releases/assets/${existing.id}`, { binary: true }),
        );
    assert(digest === sha256(bytes), `Refusing to replace published asset ${name}`);
  } else pending.push({ name, bytes });
}
// The manifest is the completeness marker and is always uploaded last. The
// website/tap require it and cross-check its entries against GitHub's assets.
for (const { name, bytes } of pending) {
  const response = await fetch(
    `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
      },
      body: bytes,
      signal: AbortSignal.timeout(600_000),
    },
  );
  assert(response.ok, `Upload failed for ${name}: HTTP ${response.status}`);
  const uploaded = await response.json();
  assert(
    uploaded.state === 'uploaded' && uploaded.size === bytes.length,
    `Incomplete upload: ${name}`,
  );
  const digest = uploaded.digest?.startsWith('sha256:')
    ? uploaded.digest.slice(7)
    : sha256(await github(`repos/${repository}/releases/assets/${uploaded.id}`, { binary: true }));
  assert(digest === sha256(bytes), `Uploaded checksum mismatch: ${name}`);
}
if (release.draft)
  await github(`repos/${repository}/releases/${release.id}`, {
    method: 'PATCH',
    body: { draft: false },
  });
console.log(
  `Published ${manifest.tag}: ${manifest.assets.length} verified installers; source ${manifest.commit}.`,
);
