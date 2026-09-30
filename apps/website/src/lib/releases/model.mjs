/** Public release data is untrusted until the manifest, checksums and GitHub assets agree. */
export const RELEASE_REPOSITORY = 'erdembas/kubepit';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=30`;
export const HOMEBREW_RAW_URL =
  'https://raw.githubusercontent.com/erdembas/homebrew-tap/main/Casks/kubepit.rb';
export const HOMEBREW_URL = 'https://github.com/erdembas/homebrew-tap/blob/main/Casks/kubepit.rb';
export const HOMEBREW_COMMAND = 'brew install --cask erdembas/tap/kubepit';
const GITHUB = `https://github.com/${RELEASE_REPOSITORY}`;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value > 0;

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.') ?? [];
  if (
    numbers.some((n) => !Number.isSafeInteger(n)) ||
    pre.some((p) => /^\d+$/.test(p) && !/^(0|[1-9]\d*)$/.test(p))
  )
    return null;
  return { numbers, pre };
}

/** Descending semantic version order, with publication time as a deterministic tiebreaker. */
export function sortReleases(releases) {
  return [...releases].sort((a, b) => {
    const av = parseVersion(a.version);
    const bv = parseVersion(b.version);
    if (!av || !bv) return 0;
    for (let i = 0; i < 3; i++)
      if (av.numbers[i] !== bv.numbers[i]) return bv.numbers[i] - av.numbers[i];
    if (!av.pre.length && bv.pre.length) return -1;
    if (av.pre.length && !bv.pre.length) return 1;
    for (let i = 0; i < Math.max(av.pre.length, bv.pre.length); i++) {
      const x = av.pre[i];
      const y = bv.pre[i];
      if (x === y) continue;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      const xn = /^\d+$/.test(x);
      const yn = /^\d+$/.test(y);
      if (xn && yn) return Number(y) - Number(x);
      if (xn !== yn) return xn ? 1 : -1;
      return x < y ? 1 : -1;
    }
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  });
}

export function classifyInstaller(name, version) {
  if (typeof name !== 'string' || !NAME.test(name) || !parseVersion(version)) return null;
  const prefix = `Kubepit_${version}_`;
  if (!name.startsWith(prefix)) return null;
  const match = name
    .slice(prefix.length)
    .match(/^(macos|linux|windows)_(arm64|x64)(\.dmg|\.AppImage|\.deb|\.rpm|-setup\.exe|\.msi)$/);
  if (!match) return null;
  const [, platform, arch, extension] = match;
  const formats = {
    '.dmg': ['macos', 'dmg'],
    '.AppImage': ['linux', 'AppImage'],
    '.deb': ['linux', 'deb'],
    '.rpm': ['linux', 'rpm'],
    '-setup.exe': ['windows', 'nsis'],
    '.msi': ['windows', 'msi'],
  };
  const [expected, format] = formats[extension];
  return platform === expected ? { platform, arch, format } : null;
}

function downloadUrl(tag, name) {
  return `${GITHUB}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** SHA256SUMS uses sha256sum/shasum output. Reject paths, duplicate names and malformed rows. */
export function parseChecksums(text) {
  if (typeof text !== 'string' || text.length > 128 * 1024) return null;
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-fA-F0-9]{64})[ \t]+\*?([A-Za-z0-9][A-Za-z0-9._+-]*)$/);
    if (!match || result.has(match[2])) return null;
    result.set(match[2], match[1].toLowerCase());
  }
  return result.size ? result : null;
}

function publishedRecord(release) {
  if (
    !object(release) ||
    release.draft !== false ||
    typeof release.prerelease !== 'boolean' ||
    !Array.isArray(release.assets)
  )
    return null;
  if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) return null;
  const version = release.tag_name.slice(1);
  const parsed = parseVersion(version);
  if (!parsed || (parsed.pre.length && !release.prerelease)) return null;
  if (
    typeof release.published_at !== 'string' ||
    !Number.isFinite(Date.parse(release.published_at))
  )
    return null;
  if (release.html_url !== `${GITHUB}/releases/tag/${encodeURIComponent(release.tag_name)}`)
    return null;
  const assets = new Map();
  for (const asset of release.assets) {
    if (
      !object(asset) ||
      typeof asset.name !== 'string' ||
      !NAME.test(asset.name) ||
      assets.has(asset.name)
    )
      return null;
    if (asset.state !== 'uploaded' || !integer(asset.size) || !integer(asset.id)) return null;
    if (asset.browser_download_url !== downloadUrl(release.tag_name, asset.name)) return null;
    assets.set(asset.name, asset);
  }
  return {
    version,
    tag: release.tag_name,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    url: release.html_url,
    assets,
  };
}

/** Safe API endpoints only, built from numeric asset IDs rather than arbitrary manifest URLs. */
export function releaseMetadataEndpoints(release) {
  const record = publishedRecord(release);
  if (!record) return null;
  const manifest = record.assets.get('release-manifest.json');
  const checksums = record.assets.get('SHA256SUMS');
  if (!manifest || !checksums || manifest.size > 128 * 1024 || checksums.size > 128 * 1024)
    return null;
  return {
    manifest: `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/assets/${manifest.id}`,
    checksums: `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/assets/${checksums.id}`,
  };
}

export function publishedReleaseCandidates(value) {
  if (!Array.isArray(value)) return [];
  return sortReleases(
    value.flatMap((release) => {
      const record = publishedRecord(release);
      return record && releaseMetadataEndpoints(release) ? [{ ...record, raw: release }] : [];
    }),
  ).map((record) => record.raw);
}

export function validateReleasePair(release, manifest, checksumsText) {
  const record = publishedRecord(release);
  const checksums = parseChecksums(checksumsText);
  if (!record || !checksums || !releaseMetadataEndpoints(release) || !object(manifest)) return null;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== RELEASE_REPOSITORY ||
    manifest.version !== record.version ||
    manifest.tag !== record.tag ||
    manifest.prerelease !== record.prerelease ||
    manifest.releaseUrl !== record.url
  )
    return null;
  if (
    !/^[a-f0-9]{40}$/.test(manifest.commit ?? '') ||
    typeof manifest.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.publishedAt))
  )
    return null;
  if (!Array.isArray(manifest.assets) || !manifest.assets.length || manifest.assets.length > 30)
    return null;
  if (
    !object(manifest.checksums) ||
    manifest.checksums.name !== 'SHA256SUMS' ||
    manifest.checksums.url !== downloadUrl(record.tag, 'SHA256SUMS')
  )
    return null;
  const seen = new Set();
  const assets = [];
  for (const item of manifest.assets) {
    if (!object(item)) return null;
    const kind = classifyInstaller(item.name, record.version);
    const published = record.assets.get(item.name);
    if (!kind || !published || seen.has(item.name)) return null;
    if (item.platform !== kind.platform || item.arch !== kind.arch || item.format !== kind.format)
      return null;
    if (
      item.url !== published.browser_download_url ||
      item.size !== published.size ||
      !HASH.test(item.sha256 ?? '') ||
      checksums.get(item.name) !== item.sha256
    )
      return null;
    if (published.digest != null && published.digest !== `sha256:${item.sha256}`) return null;
    if (!['ad-hoc', 'unsigned', 'signed', 'notarized'].includes(item.signing)) return null;
    if (['ad-hoc', 'notarized'].includes(item.signing) && kind.platform !== 'macos') return null;
    seen.add(item.name);
    assets.push({
      ...kind,
      name: item.name,
      url: item.url,
      sha256: item.sha256,
      size: item.size,
      signing: item.signing,
    });
  }
  let homebrewCask = null;
  if (object(manifest.homebrew) && HASH.test(manifest.homebrew.sha256 ?? '')) {
    const published = record.assets.get('kubepit.rb');
    if (
      published &&
      manifest.homebrew.caskUrl === published.browser_download_url &&
      checksums.get('kubepit.rb') === manifest.homebrew.sha256 &&
      (published.digest == null || published.digest === `sha256:${manifest.homebrew.sha256}`)
    ) {
      homebrewCask = { url: published.browser_download_url, sha256: manifest.homebrew.sha256 };
    }
  }
  return {
    version: record.version,
    tag: record.tag,
    prerelease: record.prerelease,
    publishedAt: record.publishedAt,
    url: record.url,
    assets,
    checksumsUrl: manifest.checksums.url,
    manifestUrl: downloadUrl(record.tag, 'release-manifest.json'),
    homebrewCask,
  };
}

export function readReleaseSnapshot(value) {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.releases))
    return { releases: [], pairs: [], checkedAt: null, homebrew: null };
  const pairs = value.releases.filter(
    (pair) => object(pair) && validateReleasePair(pair.release, pair.manifest, pair.checksums),
  );
  const releases = sortReleases(
    pairs.map((pair) => validateReleasePair(pair.release, pair.manifest, pair.checksums)),
  );
  const seen = new Set();
  const unique = releases.filter((release) => !seen.has(release.tag) && seen.add(release.tag));
  return {
    releases: unique,
    pairs,
    checkedAt:
      typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt))
        ? value.checkedAt
        : null,
    homebrew: object(value.homebrew) ? value.homebrew : null,
  };
}

export function selectRelease(releases, channel) {
  return (
    sortReleases(releases).find((release) => release.prerelease === (channel === 'prerelease')) ??
    null
  );
}

/** OS hints only: browser architecture hints are unreliable, so architecture is always explicit. */
export function detectPlatform(userAgent) {
  if (typeof userAgent !== 'string' || /Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return null;
}

/** Homebrew must match the actual tap file byte-for-byte, including the release's cask checksum. */
export async function validateHomebrew(value, release) {
  if (
    !object(value) ||
    value.url !== HOMEBREW_URL ||
    typeof value.content !== 'string' ||
    value.content.length > 64 * 1024 ||
    !release?.homebrewCask
  )
    return null;
  const bytes = new TextEncoder().encode(value.content);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (hash !== release.homebrewCask.sha256) return null;
  const arm = release.assets.find(
    (asset) => asset.platform === 'macos' && asset.arch === 'arm64' && asset.format === 'dmg',
  );
  const intel = release.assets.find(
    (asset) => asset.platform === 'macos' && asset.arch === 'x64' && asset.format === 'dmg',
  );
  if (!arm || !intel) return null;
  if (
    !/\bcask\s+"kubepit"\s+do\b/.test(value.content) ||
    !value.content.includes(`version "${release.version}"`) ||
    !value.content.includes(arm.sha256) ||
    !value.content.includes(intel.sha256)
  )
    return null;
  // The template is generated by release automation; explicit per-architecture URLs are also valid.
  const template = `${GITHUB}/releases/download/v#{version}/Kubepit_#{version}_macos_#{arch}.dmg`;
  if (
    !value.content.includes(template) &&
    !(value.content.includes(arm.url) && value.content.includes(intel.url))
  )
    return null;
  return { command: HOMEBREW_COMMAND, url: HOMEBREW_URL, version: release.version };
}
