import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  RELEASE_API,
  HOMEBREW_RAW_URL,
  HOMEBREW_URL,
  HOMEBREW_COMMAND,
  classifyInstaller,
  parseChecksums,
  validateReleasePair,
  readReleaseSnapshot,
  publishedReleaseCandidates,
  releaseMetadataEndpoints,
  selectRelease,
  sortReleases,
  detectPlatform,
  validateHomebrew,
} from '../../apps/website/src/lib/releases/model.mjs';
import { loadPublishedReleases } from '../../apps/website/src/lib/releases/load.mjs';
import { targets, assetName, homebrewCask } from '../release/model.mjs';

const repository = 'https://github.com/erdembas/kubepit';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const clone = (value) => structuredClone(value);

function fixture(version = '0.0.1', prerelease = true) {
  const tag = `v${version}`;
  const url = (name) => `${repository}/releases/download/${tag}/${name}`;
  const installers = [
    ['macos', 'arm64', 'dmg', '.dmg', 'ad-hoc'],
    ['macos', 'x64', 'dmg', '.dmg', 'ad-hoc'],
    ['linux', 'x64', 'AppImage', '.AppImage', 'unsigned'],
    ['windows', 'x64', 'nsis', '-setup.exe', 'unsigned'],
  ].map(([platform, arch, format, extension, signing]) => {
    const name = `Kubepit_${version}_${platform}_${arch}${extension}`;
    return {
      platform,
      arch,
      format,
      signing,
      name,
      url: url(name),
      size: 50000000,
      sha256: hash(name),
    };
  });
  const content = homebrewCask({ version, repository: 'erdembas/kubepit', assets: installers });
  const caskHash = hash(content);
  const checksums =
    [
      ...installers.map((asset) => `${asset.sha256}  ${asset.name}`),
      `${caskHash}  kubepit.rb`,
    ].join('\n') + '\n';
  const assets = [
    ...installers,
    { name: 'kubepit.rb', url: url('kubepit.rb'), size: content.length, sha256: caskHash },
    { name: 'SHA256SUMS', url: url('SHA256SUMS'), size: checksums.length, sha256: hash(checksums) },
    { name: 'release-manifest.json', url: url('release-manifest.json'), size: 4096 },
  ].map((asset, i) => ({
    id: i + 1,
    name: asset.name,
    browser_download_url: asset.url,
    state: 'uploaded',
    size: asset.size,
    digest: asset.sha256 ? `sha256:${asset.sha256}` : null,
  }));
  const release = {
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: '2026-09-30T14:00:00Z',
    html_url: `${repository}/releases/tag/${tag}`,
    assets,
  };
  const manifest = {
    schemaVersion: 1,
    version,
    tag,
    repository: 'erdembas/kubepit',
    commit: 'a'.repeat(40),
    automationCommit: 'b'.repeat(40),
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    prerelease,
    assets: installers,
    checksums: { name: 'SHA256SUMS', url: url('SHA256SUMS') },
    homebrew: { caskUrl: url('kubepit.rb'), sha256: caskHash, tap: null, installCommand: null },
  };
  return { release, manifest, checksums, homebrew: { url: HOMEBREW_URL, content } };
}
function validated(pair) {
  return validateReleasePair(pair.release, pair.manifest, pair.checksums);
}
function snapshotOf(pair) {
  return readReleaseSnapshot({
    schemaVersion: 1,
    checkedAt: '2026-09-30T14:01:00Z',
    releases: [pair],
    homebrew: pair.homebrew,
  });
}
function response(value, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
}
function fakeFetch(pair, overrides = {}) {
  const endpoints = releaseMetadataEndpoints(pair.release);
  return async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.headers.Authorization, undefined);
    if (url in overrides) return overrides[url]();
    if (url === RELEASE_API) return response([pair.release]);
    if (url === endpoints.manifest) return response(pair.manifest);
    if (url === endpoints.checksums) return response(pair.checksums);
    if (url === HOMEBREW_RAW_URL) return response(pair.homebrew.content);
    throw new Error(`Unexpected fixture request: ${url}`);
  };
}

test('classifies each canonical installer; excludes updater archives, aliases and wrong versions', () => {
  const expected = [
    ['macos_arm64.dmg', 'macos', 'arm64', 'dmg'],
    ['macos_x64.dmg', 'macos', 'x64', 'dmg'],
    ['linux_x64.AppImage', 'linux', 'x64', 'AppImage'],
    ['linux_arm64.deb', 'linux', 'arm64', 'deb'],
    ['linux_x64.rpm', 'linux', 'x64', 'rpm'],
    ['windows_arm64-setup.exe', 'windows', 'arm64', 'nsis'],
    ['windows_x64.msi', 'windows', 'x64', 'msi'],
  ];
  for (const [suffix, platform, arch, format] of expected)
    assert.deepEqual(classifyInstaller(`Kubepit_0.0.1_${suffix}`, '0.0.1'), {
      platform,
      arch,
      format,
    });
  for (const name of [
    'Kubepit_0.0.1_macos_arm64.dmg.sig',
    'Kubepit_0.0.1_macos_arm64.tar.gz',
    'Kubepit_0.0.1_linux_x64.exe',
    'Kubepit_0.0.1_windows_x64.dmg',
    'Kubepit_0.0.2_linux_x64.deb',
    '../Kubepit_0.0.1_macos_x64.dmg',
    'Kubepit_0.0.1_linux_x64.deb?token=x',
  ])
    assert.equal(classifyInstaller(name, '0.0.1'), null, name);
});

test('website classifier accepts every installer emitted by the release matrix', () => {
  let count = 0;
  for (const target of targets)
    for (const format of target.formats) {
      assert.deepEqual(classifyInstaller(assetName('0.0.1', target, format), '0.0.1'), {
        platform: target.platform,
        arch: target.arch,
        format,
      });
      count++;
    }
  assert.equal(count, 11);
});

test('requires published manifest, actual installer assets and matching SHA256SUMS', () => {
  const pair = fixture();
  const value = validated(pair);
  assert.equal(value.assets.length, 4);
  assert.equal(value.version, '0.0.1');
  assert.equal(value.prerelease, true);
  assert.equal(value.assets[0].signing, 'ad-hoc');
  assert.equal(value.homebrewCask.sha256, pair.manifest.homebrew.sha256);
  const noManifest = clone(pair);
  noManifest.release.assets.pop();
  assert.equal(validated(noManifest), null);
  const missingPackage = clone(pair);
  missingPackage.release.assets.shift();
  assert.equal(validated(missingPackage), null);
  assert.equal(validateReleasePair(pair.release, pair.manifest, undefined), null);
});

test('rejects drafts, incomplete publication data, wrong repositories and unsafe URLs', () => {
  const mutations = [
    (p) => {
      p.release.draft = true;
    },
    (p) => {
      delete p.release.draft;
    },
    (p) => {
      p.release.published_at = null;
    },
    (p) => {
      p.release.html_url += '?untrusted';
    },
    (p) => {
      p.release.assets[0].state = 'new';
    },
    (p) => {
      p.release.assets[0].size = 0;
    },
    (p) => {
      p.release.assets[0].id = '42';
    },
    (p) => {
      p.release.assets[0].browser_download_url = 'https://evil.example/app.dmg';
    },
    (p) => {
      p.manifest.repository = 'someone/kubepit';
    },
    (p) => {
      p.manifest.commit = 'not-a-commit';
    },
    (p) => {
      p.manifest.version = '9.9.9';
    },
    (p) => {
      p.manifest.tag = '../main';
    },
    (p) => {
      p.manifest.assets[0].url = 'javascript:alert(1)';
    },
    (p) => {
      p.manifest.checksums.url = 'https://evil.example/SHA256SUMS';
    },
    (p) => {
      p.release.assets.push(p.release.assets[0]);
    },
    (p) => {
      p.manifest.assets.push(p.manifest.assets[0]);
    },
    (p) => {
      p.manifest.assets[0].platform = 'windows';
    },
    (p) => {
      p.manifest.assets[0].signing = 'probably-safe';
    },
  ];
  for (const mutate of mutations) {
    const pair = fixture();
    mutate(pair);
    assert.equal(validated(pair), null, mutate.toString());
  }
});

test('rejects checksum mismatch, digest mismatch, missing files and ambiguous checksum rows', () => {
  const pair = fixture();
  for (const text of [
    '',
    'not a checksum',
    `${'a'.repeat(63)}  pkg.deb`,
    `${'a'.repeat(64)}  ../pkg.deb`,
    `${'a'.repeat(64)}  a\n${'a'.repeat(64)}  a`,
  ])
    assert.equal(parseChecksums(text), null);
  assert.equal(parseChecksums(`${'A'.repeat(64)} *pkg.deb\r\n`).get('pkg.deb'), 'a'.repeat(64));
  for (const mutate of [
    (p) => {
      p.manifest.assets[0].sha256 = 'f'.repeat(64);
    },
    (p) => {
      p.release.assets[0].digest = `sha256:${'f'.repeat(64)}`;
    },
    (p) => {
      p.checksums = p.checksums.split('\n').slice(1).join('\n');
    },
    (p) => {
      p.manifest.assets[0].size++;
    },
  ]) {
    const changed = clone(pair);
    mutate(changed);
    assert.equal(validated(changed), null);
  }
  const noDigest = clone(pair);
  delete noDigest.release.assets[0].digest;
  assert.ok(
    validated(noDigest),
    'SHA256SUMS remains required when older GitHub API assets lack digest',
  );
});

test('prereleases never masquerade as stable and semantic ordering handles 1.10 versus 1.9', () => {
  const preview = validated(fixture('0.0.1', true));
  assert.equal(selectRelease([preview], 'stable'), null);
  assert.equal(selectRelease([preview], 'prerelease'), preview);
  const bad = fixture('1.0.0-rc.1', false);
  assert.equal(validated(bad), null);
  const mismatch = fixture();
  mismatch.manifest.prerelease = false;
  assert.equal(validated(mismatch), null);
  const versions = ['1.9.0', '1.10.0-rc.2', '1.10.0-rc.10', '1.10.0', '0.0.1'];
  const sorted = sortReleases(
    versions.map((version) => validated(fixture(version, version.includes('-')))),
  );
  assert.deepEqual(
    sorted.map((r) => r.version),
    ['1.10.0', '1.10.0-rc.10', '1.10.0-rc.2', '1.9.0', '0.0.1'],
  );
});

test('snapshot and discovery discard source-only, malformed and draft records', () => {
  const pair = fixture();
  const draft = fixture('0.0.2');
  draft.release.draft = true;
  assert.equal(publishedReleaseCandidates([{}, draft.release, pair.release]).length, 1);
  assert.deepEqual(readReleaseSnapshot({ schemaVersion: 1, releases: [{}] }).releases, []);
  assert.equal(
    readReleaseSnapshot({ schemaVersion: 1, releases: [pair, pair] }).releases.length,
    1,
  );
  const source = clone(pair.release);
  source.assets = [];
  assert.equal(releaseMetadataEndpoints(source), null);
  assert.equal(publishedReleaseCandidates({ message: 'API rate limit exceeded' }).length, 0);
});

test('Homebrew is enabled only when the actual tap cask matches version, URLs and checksum', async () => {
  const pair = fixture();
  const release = validated(pair);
  assert.deepEqual(await validateHomebrew(pair.homebrew, release), {
    command: HOMEBREW_COMMAND,
    url: HOMEBREW_URL,
    version: '0.0.1',
  });
  assert.equal(
    await validateHomebrew(
      {
        ...pair.homebrew,
        content: pair.homebrew.content.replace('version "0.0.1"', 'version "0.0.2"'),
      },
      release,
    ),
    null,
  );
  assert.equal(
    await validateHomebrew({ ...pair.homebrew, url: 'https://evil.example/cask.rb' }, release),
    null,
  );
  assert.equal(await validateHomebrew(null, release), null);
  const missingArch = {
    ...release,
    assets: release.assets.filter((asset) => asset.arch !== 'arm64'),
  };
  assert.equal(await validateHomebrew(pair.homebrew, missingArch), null);
  // Even a matching declared hash cannot approve a cask that lacks the actual package URLs.
  const bad = {
    ...pair.homebrew,
    content: pair.homebrew.content.replace('/releases/download/', '/other/'),
  };
  assert.equal(
    await validateHomebrew(bad, {
      ...release,
      homebrewCask: { ...release.homebrewCask, sha256: hash(bad.content) },
    }),
    null,
  );
});

test('OS hints never infer an architecture or mistake mobile devices for desktop targets', () => {
  assert.equal(detectPlatform('Mozilla Windows NT 10.0; Win64; x64'), 'windows');
  assert.equal(detectPlatform('Mozilla Macintosh; Intel Mac OS X'), 'macos');
  assert.equal(detectPlatform('Mozilla X11; Linux x86_64'), 'linux');
  assert.equal(detectPlatform('Mozilla Linux; Android'), null);
  assert.equal(detectPlatform('Mozilla iPhone; CPU iPhone OS like Mac OS X'), null);
});

test('live discovery validates packages and tap without sending credentials', async () => {
  const pair = fixture();
  const result = await loadPublishedReleases(readReleaseSnapshot(null), {
    fetcher: fakeFetch(pair),
  });
  assert.equal(result.status, 'live');
  assert.equal(result.releases.length, 1);
  assert.equal(result.homebrew.command, HOMEBREW_COMMAND);
});

test('API failures retain a validated site snapshot and truthfully distinguish unavailable data', async () => {
  const fetcher = async () => response({ message: 'API rate limit exceeded' }, 403);
  const cached = await loadPublishedReleases(snapshotOf(fixture()), { fetcher });
  assert.equal(cached.status, 'snapshot');
  assert.equal(cached.releases.length, 1);
  const empty = await loadPublishedReleases(readReleaseSnapshot(null), { fetcher });
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.releases.length, 0);
});

test('live removal invalidates stale downloads; metadata CORS failure only reuses unchanged assets', async () => {
  const pair = fixture();
  const cached = snapshotOf(pair);
  const empty = await loadPublishedReleases(cached, { fetcher: async () => response([]) });
  assert.equal(empty.status, 'live');
  assert.equal(empty.releases.length, 0);
  const endpoints = releaseMetadataEndpoints(pair.release);
  const failed = {
    [endpoints.manifest]: () => {
      throw new TypeError('Failed to fetch');
    },
  };
  const unchanged = await loadPublishedReleases(cached, { fetcher: fakeFetch(pair, failed) });
  assert.equal(unchanged.status, 'partial');
  assert.equal(unchanged.releases.length, 1);
  const replaced = clone(pair);
  replaced.release.assets[0].digest = `sha256:${'f'.repeat(64)}`;
  const mismatch = await loadPublishedReleases(cached, { fetcher: fakeFetch(replaced, failed) });
  assert.equal(mismatch.releases.length, 0);
});

test('an unavailable tap never gets advertised from a stale cask after a successful release refresh', async () => {
  const pair = fixture();
  const result = await loadPublishedReleases(snapshotOf(pair), {
    fetcher: fakeFetch(pair, { [HOMEBREW_RAW_URL]: () => response('Not Found', 404) }),
  });
  assert.equal(result.releases.length, 1);
  assert.equal(result.homebrew, null);
});

test('oversized metadata is bounded and cannot create a download', async () => {
  const pair = fixture();
  const endpoints = releaseMetadataEndpoints(pair.release);
  const result = await loadPublishedReleases(readReleaseSnapshot(null), {
    fetcher: fakeFetch(pair, { [endpoints.manifest]: () => response('x'.repeat(128 * 1024 + 1)) }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.releases.length, 0);
});
