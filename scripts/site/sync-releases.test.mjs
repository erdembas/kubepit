import assert from 'node:assert/strict';
import test from 'node:test';
import { collectReleaseSnapshot, readPublicReleaseResource } from './sync-releases.mjs';

const api = 'https://api.github.com/repos/erdembas/kubepit/releases/assets/42';

test('release downloads keep API credentials off redirected asset hosts', async () => {
  const calls = [];
  const value = await readPublicReleaseResource(api, {
    token: 'fixture-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://release-assets.githubusercontent.com/fixture/manifest' },
          })
        : new Response('{"fixture":true}');
    },
  });
  assert.equal(value, '{"fixture":true}');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('release metadata rejects untrusted redirect destinations before requesting them', async () => {
  let calls = 0;
  await assert.rejects(
    readPublicReleaseResource(api, {
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://untrusted.example/asset' },
        });
      },
    }),
    /Unexpected release metadata URL/,
  );
  assert.equal(calls, 1);
});

test('release metadata is bounded even without a Content-Length header', async () => {
  await assert.rejects(
    readPublicReleaseResource(api, {
      limit: 8,
      fetchImpl: async () => new Response('much too large for this fixture'),
    }),
    /too large/,
  );
});

test('source-only releases produce no invented installer or Homebrew links', async () => {
  let calls = 0;
  const snapshot = await collectReleaseSnapshot({
    now: () => new Date('2026-09-30T00:00:00Z'),
    fetchImpl: async () => {
      calls++;
      return Response.json([
        {
          tag_name: 'v0.0.1',
          draft: false,
          prerelease: true,
          published_at: '2026-09-30T00:00:00Z',
          html_url: 'https://github.com/erdembas/kubepit/releases/tag/v0.0.1',
          assets: [],
        },
      ]);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    checkedAt: '2026-09-30T00:00:00.000Z',
    releases: [],
    homebrew: null,
  });
});

test('an unavailable GitHub listing is not mistaken for an empty release catalog', async () => {
  await assert.rejects(
    collectReleaseSnapshot({ fetchImpl: async () => new Response(null, { status: 403 }) }),
    /403/,
  );
});

test('new prereleases cannot evict stable metadata from the bundled snapshot candidates', async () => {
  const root = 'https://github.com/erdembas/kubepit';
  const listing = Array.from({ length: 7 }, (_, index) => {
    const tag = `v1.${index}.0`;
    return {
      tag_name: tag,
      draft: false,
      prerelease: index !== 0,
      published_at: '2026-09-30T00:00:00Z',
      html_url: `${root}/releases/tag/${tag}`,
      assets: ['release-manifest.json', 'SHA256SUMS'].map((name, offset) => ({
        id: index * 2 + offset + 1,
        name,
        state: 'uploaded',
        size: 100,
        browser_download_url: `${root}/releases/download/${tag}/${name}`,
      })),
    };
  });
  const requested = [];
  await collectReleaseSnapshot({
    warn: () => {},
    fetchImpl: async (url) => {
      if (!url.includes('/assets/')) return Response.json(listing);
      requested.push(url);
      return new Response(null, { status: 404 });
    },
  });
  assert.ok(requested.some((url) => url.endsWith('/assets/1')));
  assert.equal(requested.length, 6); // One stable and two newest prereleases, two metadata files each.
});
