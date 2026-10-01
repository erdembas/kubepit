import assert from 'node:assert/strict';
import test from 'node:test';
import { signedReleaseFixture } from '../release/fixtures/updater.mjs';
import { collectUpdaterFeed, collectReleaseSnapshot } from './sync-releases.mjs';

function pair(fixture) {
  return {
    manifest: fixture.manifest,
    checksums: fixture.checksums,
    release: {
      tag_name: fixture.manifest.tag,
      draft: false,
      prerelease: fixture.manifest.prerelease,
      published_at: fixture.manifest.publishedAt,
      html_url: fixture.manifest.releaseUrl,
      assets: fixture.githubAssets,
    },
  };
}

test('Pages publishes the exact verified prerelease feed until a stable signed release exists', async (t) => {
  const fixture = await signedReleaseFixture(t);
  const selected = pair(fixture);
  let calls = 0;
  const text = await collectUpdaterFeed(
    { releases: [selected] },
    {
      publicKey: fixture.publicKey,
      fetchImpl: async (url) => {
        calls++;
        assert.ok(
          url.endsWith(`/${fixture.githubAssets.find((asset) => asset.name === 'latest.json').id}`),
        );
        return new Response(fixture.feedText);
      },
    },
  );
  assert.equal(text, fixture.feedText);
  assert.equal(calls, 1);
});

test('a newer preview cannot replace the signed stable feed', async (t) => {
  const stable = await signedReleaseFixture(t, {
    version: '0.0.2',
    tag: 'v0.0.2',
    prerelease: false,
  });
  const preview = await signedReleaseFixture(t, {
    version: '0.0.3',
    tag: 'v0.0.3',
    prerelease: true,
  });
  let calls = 0;
  const text = await collectUpdaterFeed(
    { releases: [pair(preview), pair(stable)] },
    {
      publicKey: stable.publicKey,
      fetchImpl: async () => {
        calls++;
        return new Response(stable.feedText);
      },
    },
  );
  assert.equal(text, stable.feedText);
  assert.equal(calls, 1);
});

test('a corrupt or unreachable feed fails deployment instead of replacing the deployed feed', async (t) => {
  const fixture = await signedReleaseFixture(t);
  for (const fetchImpl of [
    async () => new Response(fixture.feedText.replace('0.0.2', '9.9.9')),
    async () => new Response('Unavailable', { status: 503 }),
  ]) {
    await assert.rejects(
      collectUpdaterFeed(
        { releases: [pair(fixture)] },
        {
          publicKey: fixture.publicKey,
          fetchImpl,
        },
      ),
      /No published updater feed passed/,
    );
  }
  await assert.rejects(
    collectUpdaterFeed(
      { releases: [pair(fixture)] },
      {
        publicKey: '',
        fetchImpl: async () => {
          throw new Error('Must not request');
        },
      },
    ),
    /trusted public key/,
  );
});

test('a broken stable feed never promotes a preview to installed stable clients', async (t) => {
  const stable = await signedReleaseFixture(t, { prerelease: false });
  const preview = await signedReleaseFixture(t, { version: '0.0.3', tag: 'v0.0.3' });
  let calls = 0;
  await assert.rejects(
    collectUpdaterFeed(
      { releases: [pair(preview), pair(stable)] },
      {
        publicKey: stable.publicKey,
        fetchImpl: async () => {
          calls++;
          return new Response('Unavailable', { status: 503 });
        },
      },
    ),
    /No published updater feed passed/,
  );
  assert.equal(calls, 1);
});

test('source-only releases and legacy unsigned metadata cannot invent an updater feed', async () => {
  assert.equal(await collectUpdaterFeed({ releases: [] }), null);
  assert.equal(await collectUpdaterFeed({ releases: [{ manifest: {} }] }), null);
});

test('missing signed manifest metadata cannot erase a previously published feed', async (t) => {
  const fixture = await signedReleaseFixture(t);
  await assert.rejects(
    collectReleaseSnapshot({
      warn: () => {},
      fetchImpl: async (url) =>
        url.includes('/assets/')
          ? new Response('Unavailable', { status: 503 })
          : Response.json([pair(fixture).release]),
    }),
    /keep the deployed feed/,
  );
});
