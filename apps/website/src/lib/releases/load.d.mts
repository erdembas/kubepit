import type { ReleaseSnapshot, PublishedRelease, HomebrewInstall } from './model.mjs';
export type ReleaseStatus = 'live' | 'partial' | 'snapshot' | 'unavailable';
export interface ReleaseLoadResult {
  releases: PublishedRelease[];
  homebrew: HomebrewInstall | null;
  status: ReleaseStatus;
  checkedAt: string | null;
}
export function loadPublishedReleases(
  snapshot: ReleaseSnapshot,
  options?: { signal?: AbortSignal; fetcher?: typeof fetch },
): Promise<ReleaseLoadResult>;
