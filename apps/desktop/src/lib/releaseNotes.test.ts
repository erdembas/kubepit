import { describe, expect, it } from 'vitest';
import {
  advanceInstalledVersion,
  claimInstalledUpgrade,
  readReleaseSeen,
  RELEASE_SEEN_KEY,
  releaseEntriesBetween,
  releaseHighlights,
  rememberReleaseDismissal,
  validReleaseVersion,
  type ReleaseEntry,
  type ReleaseExclusive,
  type ReleaseStorage,
} from './releaseNotes';

function entry(version: string | null): ReleaseEntry {
  return {
    id: version ?? 'unreleased',
    version,
    status: version ? 'versioned' : 'unreleased',
    title: { en: 'Title', tr: 'Başlık' },
    body: { en: '- A change.', tr: '- Bir değişiklik.' },
  };
}

function memoryStorage(initialVersion?: string): ReleaseStorage {
  const values = new Map<string, string>();
  if (initialVersion)
    values.set(
      RELEASE_SEEN_KEY,
      JSON.stringify({ schemaVersion: 1, lastSeenVersion: initialVersion }),
    );
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function serialized(): ReleaseExclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => T | Promise<T>) => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
}

describe('installed release history', () => {
  it('records a first-install baseline without announcing an upgrade', async () => {
    const storage = memoryStorage();
    expect(await claimInstalledUpgrade(storage, serialized(), '0.0.3')).toBeNull();
    expect(readReleaseSeen(storage.getItem(RELEASE_SEEN_KEY))).toEqual({
      schemaVersion: 1,
      lastSeenVersion: '0.0.3',
    });
  });

  it('claims an upgrade once across competing windows and persists dismissal', async () => {
    const storage = memoryStorage('0.0.1');
    const exclusive = serialized();
    const results = await Promise.all([
      claimInstalledUpgrade(storage, exclusive, '0.0.3'),
      claimInstalledUpgrade(storage, exclusive, '0.0.3'),
    ]);
    expect(results).toEqual([{ fromVersion: '0.0.1', toVersion: '0.0.3' }, null]);
    await rememberReleaseDismissal(storage, exclusive, '0.0.3');
    expect(readReleaseSeen(storage.getItem(RELEASE_SEEN_KEY))?.dismissedVersion).toBe('0.0.3');
    expect(await claimInstalledUpgrade(storage, exclusive, '0.0.3')).toBeNull();
  });

  it('preserves the high-water version across downgrade, re-upgrade and metadata changes', () => {
    const previous = { schemaVersion: 1 as const, lastSeenVersion: '0.0.3' };
    for (const version of ['0.0.2', '0.0.3', '0.0.3+rebuild']) {
      const next = advanceInstalledVersion(previous, version);
      expect(next.upgrade).toBeNull();
      expect(next.state).toBe(previous);
    }
    expect(advanceInstalledVersion(previous, '0.0.4').upgrade).toEqual({
      fromVersion: '0.0.3',
      toVersion: '0.0.4',
    });
  });

  it('includes only versioned entries within the exact forward interval, in semantic order', () => {
    const entries = [entry(null), entry('0.0.4'), entry('0.0.2'), entry('0.0.1'), entry('0.0.3')];
    expect(
      releaseEntriesBetween(entries, { fromVersion: '0.0.1', toVersion: '0.0.3' }).map(
        (item) => item.version,
      ),
    ).toEqual(['0.0.3', '0.0.2']);
    expect(releaseEntriesBetween(entries, { fromVersion: '0.0.3', toVersion: '0.0.1' })).toEqual(
      [],
    );
  });

  it('compares prereleases numerically and treats the stable release as newer', () => {
    const previous = { schemaVersion: 1 as const, lastSeenVersion: '1.0.0-rc.2' };
    const advanced = advanceInstalledVersion(previous, '1.0.0-rc.10');
    expect(advanced.upgrade?.toVersion).toBe('1.0.0-rc.10');
    expect(advanceInstalledVersion(advanced.state, '1.0.0').upgrade?.toVersion).toBe('1.0.0');
    expect(
      releaseEntriesBetween(
        [entry('1.0.0'), entry('1.0.0-rc.10'), entry('1.0.0-rc.3'), entry('1.0.0-rc.1')],
        { fromVersion: '1.0.0-rc.2', toVersion: '1.0.0-rc.10' },
      ).map((item) => item.version),
    ).toEqual(['1.0.0-rc.10', '1.0.0-rc.3']);
  });

  it('fails quiet on invalid versions, corrupt storage or blocked writes', async () => {
    for (const version of ['Unreleased', '1.0', '1.0.0-01', '1.0.0-..', 'v1.0.0'])
      expect(validReleaseVersion(version)).toBe(false);
    expect(readReleaseSeen('{bad')).toBeNull();
    expect(
      readReleaseSeen(JSON.stringify({ schemaVersion: 1, lastSeenVersion: 'garbage' })),
    ).toBeNull();
    const storage = memoryStorage('0.0.1');
    storage.setItem = () => {
      throw new Error('blocked');
    };
    expect(await claimInstalledUpgrade(storage, serialized(), '0.0.3')).toBeNull();
    expect(await claimInstalledUpgrade(storage, serialized(), 'Unreleased')).toBeNull();
  });

  it('never lets a delayed old dismissal overwrite a newer watermark or interval', async () => {
    const storage = memoryStorage('0.0.1');
    const exclusive = serialized();
    await claimInstalledUpgrade(storage, exclusive, '0.0.2');
    await claimInstalledUpgrade(storage, exclusive, '0.0.3');
    await rememberReleaseDismissal(storage, exclusive, '0.0.2');
    const state = readReleaseSeen(storage.getItem(RELEASE_SEEN_KEY));
    expect(state?.lastSeenVersion).toBe('0.0.3');
    expect(state?.recentUpgrade).toEqual({ fromVersion: '0.0.2', toVersion: '0.0.3' });
  });

  it('renders bounded plain-text highlights without links, code fences or markup', () => {
    expect(
      releaseHighlights(
        '#### Added\n\n- **Smart search:** use `kind:Pod`.\n- [Read more](https://example.com).\n- Third change.',
      ),
    ).toEqual(['Smart search: use kind:Pod.', 'Read more.']);
    expect(releaseHighlights('```sh\nsecret command\n```\n\nA short paragraph.')).toEqual([
      'A short paragraph.',
    ]);
    const [long] = releaseHighlights(`- ${'é'.repeat(500)}`);
    expect([...long!]).toHaveLength(240);
    expect(long?.endsWith('…')).toBe(true);
  });
});
