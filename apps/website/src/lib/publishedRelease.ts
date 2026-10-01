import snapshot from '@/lib/releases/snapshot.json';
import { readReleaseSnapshot, selectRelease } from '@/lib/releases/model.mjs';

const releases = readReleaseSnapshot(snapshot).releases;
/** Marketing version follows verified published packages, never an unreleased source version. */
export const publishedRelease =
  selectRelease(releases, 'stable') ?? selectRelease(releases, 'prerelease');
