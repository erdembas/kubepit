import { parseMarkdown, type Block, type Inline } from './markdown';
import { compareVersions } from './semver';

export interface ReleaseEntry {
  id: string;
  version: string | null;
  status: string;
  title: { en: string; tr: string };
  body: { en: string; tr: string };
}

export interface ReleaseInterval {
  fromVersion: string;
  toVersion: string;
}

export interface ReleaseSeenState {
  schemaVersion: 1;
  lastSeenVersion: string;
  recentUpgrade?: ReleaseInterval;
  dismissedVersion?: string;
}

export const RELEASE_SEEN_KEY = 'kubepit.releases.seen.v1';
export const RELEASE_SEEN_LOCK = 'kubepit.releases.seen';

/** The Helm comparator is deliberately lenient; installed-version tracking is not. */
export function validReleaseVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 120) return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) return false;
  return (match[4]?.split('.') ?? []).every(
    (part) =>
      !/^\d+$/.test(part) || (/^(0|[1-9]\d*)$/.test(part) && Number.isSafeInteger(Number(part))),
  );
}

export function readReleaseSeen(raw: string | null): ReleaseSeenState | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const state = value as Partial<ReleaseSeenState>;
    if (state.schemaVersion !== 1 || !validReleaseVersion(state.lastSeenVersion)) return null;
    const result: ReleaseSeenState = { schemaVersion: 1, lastSeenVersion: state.lastSeenVersion };
    const upgrade = state.recentUpgrade;
    if (
      upgrade &&
      validReleaseVersion(upgrade.fromVersion) &&
      validReleaseVersion(upgrade.toVersion) &&
      compareVersions(upgrade.toVersion, upgrade.fromVersion) > 0 &&
      compareVersions(upgrade.toVersion, state.lastSeenVersion) <= 0
    )
      result.recentUpgrade = { fromVersion: upgrade.fromVersion, toVersion: upgrade.toVersion };
    if (
      validReleaseVersion(state.dismissedVersion) &&
      compareVersions(state.dismissedVersion, state.lastSeenVersion) <= 0
    )
      result.dismissedVersion = state.dismissedVersion;
    return result;
  } catch {
    return null;
  }
}

export function advanceInstalledVersion(
  previous: ReleaseSeenState | null,
  currentVersion: string,
): { state: ReleaseSeenState | null; upgrade: ReleaseInterval | null } {
  if (!validReleaseVersion(currentVersion)) return { state: previous, upgrade: null };
  if (!previous)
    return { state: { schemaVersion: 1, lastSeenVersion: currentVersion }, upgrade: null };
  // Keep a high-water mark through a downgrade, restart or build-metadata change.
  if (compareVersions(currentVersion, previous.lastSeenVersion) <= 0)
    return { state: previous, upgrade: null };
  const upgrade = { fromVersion: previous.lastSeenVersion, toVersion: currentVersion };
  return {
    state: { ...previous, lastSeenVersion: currentVersion, recentUpgrade: upgrade },
    upgrade,
  };
}

export function releaseEntriesBetween(
  entries: readonly ReleaseEntry[],
  interval: ReleaseInterval,
): ReleaseEntry[] {
  if (
    !validReleaseVersion(interval.fromVersion) ||
    !validReleaseVersion(interval.toVersion) ||
    compareVersions(interval.toVersion, interval.fromVersion) <= 0
  )
    return [];
  return entries
    .filter(
      (entry) =>
        entry.status === 'versioned' &&
        validReleaseVersion(entry.version) &&
        compareVersions(entry.version, interval.fromVersion) > 0 &&
        compareVersions(entry.version, interval.toVersion) <= 0,
    )
    .sort((a, b) => compareVersions(b.version!, a.version!));
}

export type ReleaseStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type ReleaseExclusive = <T>(work: () => T | Promise<T>) => Promise<T>;

/** The caller supplies a cross-window lock (or the unique native main window).
 * Persist before showing: concurrent windows/reloads must never announce twice.
 * If persistence is blocked, automatic announcements stay quiet. */
export async function claimInstalledUpgrade(
  storage: ReleaseStorage,
  exclusive: ReleaseExclusive,
  currentVersion: string,
): Promise<ReleaseInterval | null> {
  try {
    return await exclusive(() => {
      const previous = readReleaseSeen(storage.getItem(RELEASE_SEEN_KEY));
      const next = advanceInstalledVersion(previous, currentVersion);
      if (next.state && next.state !== previous)
        storage.setItem(RELEASE_SEEN_KEY, JSON.stringify(next.state));
      return next.upgrade;
    });
  } catch {
    return null;
  }
}

export async function rememberReleaseDismissal(
  storage: ReleaseStorage,
  exclusive: ReleaseExclusive,
  version: string,
): Promise<void> {
  if (!validReleaseVersion(version)) return;
  try {
    await exclusive(() => {
      const state = readReleaseSeen(storage.getItem(RELEASE_SEEN_KEY));
      if (
        !state ||
        compareVersions(version, state.lastSeenVersion) > 0 ||
        (state.dismissedVersion && compareVersions(version, state.dismissedVersion) <= 0)
      )
        return;
      storage.setItem(RELEASE_SEEN_KEY, JSON.stringify({ ...state, dismissedVersion: version }));
    });
  } catch {
    // Closing a summary must still work if storage becomes unavailable.
  }
}

const inlineText = (nodes: Inline[]): string =>
  nodes
    .map((node): string => {
      if (node.t === 'text' || node.t === 'code') return node.v;
      if (node.t === 'br') return ' ';
      if (node.t === 'image') return node.alt;
      return inlineText(node.c);
    })
    .join('');

const blockText = (blocks: Block[]): string =>
  blocks
    .map((block): string => {
      if (block.t === 'paragraph' || block.t === 'heading') return inlineText(block.c);
      if (block.t === 'quote') return blockText(block.c);
      if (block.t === 'list') return block.items.map((item) => blockText(item.c)).join(' ');
      return '';
    })
    .filter(Boolean)
    .join(' ');

/** Plain text, bounded highlights; full Markdown remains available in the changelog. */
export function releaseHighlights(markdown: string, limit = 2): string[] {
  const blocks = parseMarkdown(markdown);
  const bullets = blocks.flatMap((block) =>
    block.t === 'list' ? block.items.map((item) => blockText(item.c)) : [],
  );
  const candidates = bullets.length
    ? bullets
    : blocks.filter((block) => block.t === 'paragraph').map((block) => blockText([block]));
  return candidates
    .filter((text) => text.trim())
    .slice(0, limit)
    .map((text) => {
      const clean = text.replace(/\s+/g, ' ').trim();
      const chars = [...clean];
      return chars.length > 240 ? `${chars.slice(0, 239).join('').trimEnd()}…` : clean;
    });
}
