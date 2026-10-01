import { create } from 'zustand';
import changelog from '../../../../shared/changelog/generated.json';
import { isTauri } from './ipc/invoke';
import { isMainWindow } from './windowSeed';
import { compareVersions } from './semver';
import {
  claimInstalledUpgrade,
  readReleaseSeen,
  RELEASE_SEEN_KEY,
  RELEASE_SEEN_LOCK,
  releaseEntriesBetween,
  rememberReleaseDismissal,
  validReleaseVersion,
  type ReleaseEntry,
  type ReleaseExclusive,
} from './releaseNotes';

export interface WhatsNewSummary {
  mode: 'upgrade' | 'installed' | 'preview';
  fromVersion: string | null;
  toVersion: string | null;
  entries: ReleaseEntry[];
}

export const useReleaseNotesStore = create<{ summary: WhatsNewSummary | null }>()(() => ({
  summary: null,
}));

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function exclusiveAccess(): ReleaseExclusive | null {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return async <T>(work: () => T | Promise<T>): Promise<T> =>
      await navigator.locks.request(RELEASE_SEEN_LOCK, work);
  // Native secondary windows never own automatic announcements. When Web Locks
  // are unavailable in a browser, keep automatic prompts quiet rather than race
  // other tabs; manual reading still works without persistence or a lock.
  if (isTauri && isMainWindow) return async (work) => work();
  return null;
}

const checking = new Set<string>();

export async function checkInstalledRelease(currentVersion: string): Promise<void> {
  if (!isMainWindow || checking.has(currentVersion)) return;
  const storage = browserStorage();
  const exclusive = exclusiveAccess();
  if (!storage || !exclusive) return;
  checking.add(currentVersion);
  try {
    const interval = await claimInstalledUpgrade(storage, exclusive, currentVersion);
    if (!interval) return;
    const entries = releaseEntriesBetween(changelog.entries, interval);
    if (entries.length && !useReleaseNotesStore.getState().summary)
      useReleaseNotesStore.setState({
        summary: { mode: 'upgrade', ...interval, entries },
      });
  } finally {
    checking.delete(currentVersion);
  }
}

/** Explicitly revisit this installation's upgrade interval, or its exact version
 * on a first install. Neither available updates nor development notes enter it. */
export function openWhatsNew(installedVersion: string): void {
  if (!validReleaseVersion(installedVersion)) return;
  let previous = null;
  try {
    previous = readReleaseSeen(browserStorage()?.getItem(RELEASE_SEEN_KEY) ?? null);
  } catch {
    // The bundled installed-version summary also works with storage disabled.
  }
  const interval = previous?.recentUpgrade;
  if (interval && compareVersions(interval.toVersion, installedVersion) === 0) {
    useReleaseNotesStore.setState({
      summary: {
        mode: 'upgrade',
        ...interval,
        entries: releaseEntriesBetween(changelog.entries, interval),
      },
    });
    return;
  }
  useReleaseNotesStore.setState({
    summary: {
      mode: 'installed',
      fromVersion: null,
      toVersion: installedVersion,
      entries: changelog.entries.filter(
        (entry) =>
          entry.status === 'versioned' &&
          validReleaseVersion(entry.version) &&
          compareVersions(entry.version, installedVersion) === 0,
      ),
    },
  });
}

/** Manual previews never advance or dismiss the installed-version watermark. */
export function openWhatsNewPreview(entryId: string): void {
  const entry = changelog.entries.find((item) => item.id === entryId);
  if (!entry) return;
  useReleaseNotesStore.setState({
    summary: { mode: 'preview', fromVersion: null, toVersion: entry.version, entries: [entry] },
  });
}

export function dismissWhatsNew(): void {
  const summary = useReleaseNotesStore.getState().summary;
  useReleaseNotesStore.setState({ summary: null });
  if (!summary || summary.mode === 'preview' || !summary.toVersion) return;
  const storage = browserStorage();
  const exclusive = exclusiveAccess();
  if (storage && exclusive) void rememberReleaseDismissal(storage, exclusive, summary.toVersion);
}
