import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  RELEASE_API,
  HOMEBREW_RAW_URL,
  HOMEBREW_URL,
  publishedReleaseCandidates,
  releaseMetadataEndpoints,
  validateReleasePair,
  validateHomebrew,
  readReleaseSnapshot,
} from '../../apps/website/src/lib/releases/model.mjs';

const snapshotPath = new URL('../../apps/website/src/lib/releases/snapshot.json', import.meta.url);
const releasePath = '/repos/erdembas/kubepit/releases';

/** Credentials stay on the GitHub API; redirected public asset downloads get no token. */
export async function readPublicReleaseResource(
  url,
  { token, fetchImpl = fetch, accept = 'application/vnd.github+json', limit = 128 * 1024 } = {},
) {
  let current = new URL(url);
  const allowed = (value) =>
    value.protocol === 'https:' &&
    !value.username &&
    !value.password &&
    ((value.hostname === 'api.github.com' && value.pathname.startsWith(releasePath)) ||
      (value.hostname === 'raw.githubusercontent.com' && value.href === HOMEBREW_RAW_URL) ||
      value.hostname === 'release-assets.githubusercontent.com' ||
      value.hostname === 'objects.githubusercontent.com');
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!allowed(current)) throw new Error('Unexpected release metadata URL');
    const headers = { Accept: accept, 'User-Agent': 'kubepit-pages-release-sync' };
    if (current.hostname === 'api.github.com') {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(current.href, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Release redirect has no destination');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Release metadata request failed (${response.status})`);
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('Release metadata is too large');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > limit) throw new Error('Release metadata is too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('Too many release redirects');
}

export async function collectReleaseSnapshot({
  token,
  fetchImpl,
  now = () => new Date(),
  warn = console.warn,
} = {}) {
  const request = (url, options = {}) =>
    readPublicReleaseResource(url, { token, fetchImpl, ...options });
  const listing = JSON.parse(await request(RELEASE_API, { limit: 4 * 1024 * 1024 }));
  if (!Array.isArray(listing)) throw new Error('Invalid GitHub release listing');
  const releases = [];
  const candidates = publishedReleaseCandidates(listing);
  const selected = [
    ...candidates.filter((release) => !release.prerelease).slice(0, 2),
    ...candidates.filter((release) => release.prerelease).slice(0, 2),
  ];
  for (const release of selected) {
    const endpoints = releaseMetadataEndpoints(release);
    try {
      const [manifestText, checksums] = await Promise.all([
        request(endpoints.manifest, { accept: 'application/octet-stream' }),
        request(endpoints.checksums, { accept: 'application/octet-stream' }),
      ]);
      const manifest = JSON.parse(manifestText);
      if (!validateReleasePair(release, manifest, checksums))
        throw new Error('Assets and metadata do not agree');
      // Keep only fields needed for validation; release prose and author data are unnecessary.
      releases.push({
        release: {
          tag_name: release.tag_name,
          draft: release.draft,
          prerelease: release.prerelease,
          published_at: release.published_at,
          html_url: release.html_url,
          assets: release.assets.map(({ id, name, state, size, browser_download_url, digest }) => ({
            id,
            name,
            state,
            size,
            browser_download_url,
            ...(digest ? { digest } : {}),
          })),
        },
        manifest,
        checksums,
      });
    } catch (error) {
      warn(`Skipping ${release.tag_name}: ${error.message}`);
    }
  }
  let homebrew = null;
  if (releases.length) {
    try {
      const content = await request(HOMEBREW_RAW_URL, { accept: 'text/plain', limit: 64 * 1024 });
      const candidate = { url: HOMEBREW_URL, content };
      for (const pair of releases) {
        if (
          await validateHomebrew(
            candidate,
            validateReleasePair(pair.release, pair.manifest, pair.checksums),
          )
        ) {
          homebrew = candidate;
          break;
        }
      }
    } catch {
      warn('Homebrew cask is not published or not available yet.');
    }
  }
  return { schemaVersion: 1, checkedAt: now().toISOString(), releases, homebrew };
}

async function main() {
  const required = process.argv.includes('--required');
  try {
    const snapshot = await collectReleaseSnapshot({
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    });
    if (required && !snapshot.releases.length)
      throw new Error('No verified binary release is available');
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      `Download snapshot: ${snapshot.releases.length} verified release(s), Homebrew ${snapshot.homebrew ? 'ready' : 'pending'}.`,
    );
  } catch (error) {
    if (required) throw error;
    const previous = readReleaseSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8')));
    console.warn(
      `Release refresh unavailable; keeping ${previous.releases.length} verified bundled release(s). ${error.message}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
