import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import changelog from '../../../../shared/changelog/generated.json';
import { RELEASE_SEEN_KEY } from './releaseNotes';

vi.mock('./ipc/invoke', () => ({ isTauri: true }));
vi.mock('./windowSeed', () => ({ isMainWindow: true }));

import {
  checkInstalledRelease,
  dismissWhatsNew,
  openWhatsNew,
  openWhatsNewPreview,
  useReleaseNotesStore,
} from './releaseNotesStore';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  useReleaseNotesStore.setState({ summary: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('manual release summaries and previews', () => {
  it('a first install stays quiet, while a manual revisit shows only the installed version', async () => {
    await checkInstalledRelease('0.0.3');
    expect(useReleaseNotesStore.getState().summary).toBeNull();
    openWhatsNew('0.0.3');
    expect(useReleaseNotesStore.getState().summary?.mode).toBe('installed');
    expect(useReleaseNotesStore.getState().summary?.entries.map((entry) => entry.id)).toEqual([
      '0.0.3',
    ]);
  });

  it('unreleased preview and dismissal never write the installed-version watermark', () => {
    openWhatsNewPreview('unreleased');
    expect(useReleaseNotesStore.getState().summary?.mode).toBe('preview');
    expect(useReleaseNotesStore.getState().summary?.entries[0]?.status).toBe('unreleased');
    dismissWhatsNew();
    expect(values.has(RELEASE_SEEN_KEY)).toBe(false);
    expect(useReleaseNotesStore.getState().summary).toBeNull();
  });

  it('an upgrade without bundled version notes stays quiet and is not retried on restart', async () => {
    const futureMajor =
      Math.max(...changelog.entries.map((entry) => Number(entry.version?.split('.')[0] ?? 0))) + 1;
    const previousVersion = `${futureMajor}.0.0`;
    const nextVersion = `${futureMajor}.0.1`;
    values.set(
      RELEASE_SEEN_KEY,
      JSON.stringify({ schemaVersion: 1, lastSeenVersion: previousVersion }),
    );
    await checkInstalledRelease(nextVersion);
    expect(useReleaseNotesStore.getState().summary).toBeNull();
    expect(JSON.parse(values.get(RELEASE_SEEN_KEY)!).lastSeenVersion).toBe(nextVersion);
    await checkInstalledRelease(nextVersion);
    expect(useReleaseNotesStore.getState().summary).toBeNull();
  });

  it('automatically shows and manually reopens only the installed upgrade interval', async () => {
    values.set(RELEASE_SEEN_KEY, JSON.stringify({ schemaVersion: 1, lastSeenVersion: '0.0.1' }));
    await checkInstalledRelease('0.0.3');
    expect(useReleaseNotesStore.getState().summary?.entries.map((entry) => entry.id)).toEqual([
      '0.0.3',
      '0.0.2',
    ]);
    dismissWhatsNew();
    await checkInstalledRelease('0.0.3');
    expect(useReleaseNotesStore.getState().summary).toBeNull();
    openWhatsNew('0.0.3');
    expect(useReleaseNotesStore.getState().summary?.fromVersion).toBe('0.0.1');
    expect(useReleaseNotesStore.getState().summary?.entries.map((entry) => entry.id)).toEqual([
      '0.0.3',
      '0.0.2',
    ]);
  });
});
