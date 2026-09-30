export type Platform = 'macos' | 'windows' | 'linux';
export type Architecture = 'arm64' | 'x64';
export type ReleaseChannel = 'stable' | 'prerelease';
export type InstallerFormat = 'dmg' | 'AppImage' | 'deb' | 'rpm' | 'nsis' | 'msi';
export type Signing = 'ad-hoc' | 'unsigned' | 'signed' | 'notarized';
export interface Installer {
  name: string;
  url: string;
  sha256: string;
  size: number;
  platform: Platform;
  arch: Architecture;
  format: InstallerFormat;
  signing: Signing;
}
export interface PublishedRelease {
  version: string;
  tag: string;
  prerelease: boolean;
  publishedAt: string;
  url: string;
  assets: Installer[];
  checksumsUrl: string;
  manifestUrl: string;
  homebrewCask: { url: string; sha256: string } | null;
}
export interface ReleasePair {
  release: unknown;
  manifest: unknown;
  checksums: string;
}
export interface HomebrewFile {
  url: string;
  content: string;
}
export interface HomebrewInstall {
  command: string;
  url: string;
  version: string;
}
export interface ReleaseSnapshot {
  releases: PublishedRelease[];
  pairs: ReleasePair[];
  checkedAt: string | null;
  homebrew: HomebrewFile | null;
}
export const RELEASE_REPOSITORY: string;
export const RELEASE_API: string;
export const HOMEBREW_RAW_URL: string;
export const HOMEBREW_URL: string;
export const HOMEBREW_COMMAND: string;
export function classifyInstaller(
  name: unknown,
  version: unknown,
): Pick<Installer, 'platform' | 'arch' | 'format'> | null;
export function parseChecksums(text: unknown): Map<string, string> | null;
export function validateReleasePair(
  release: unknown,
  manifest: unknown,
  checksums: unknown,
): PublishedRelease | null;
export function releaseMetadataEndpoints(
  release: unknown,
): { manifest: string; checksums: string } | null;
export function publishedReleaseCandidates(value: unknown): unknown[];
export function readReleaseSnapshot(value: unknown): ReleaseSnapshot;
export function selectRelease(
  releases: PublishedRelease[],
  channel: ReleaseChannel,
): PublishedRelease | null;
export function sortReleases<T extends Pick<PublishedRelease, 'version' | 'publishedAt'>>(
  releases: T[],
): T[];
export function detectPlatform(userAgent: unknown): Platform | null;
export function validateHomebrew(
  value: unknown,
  release: PublishedRelease | null,
): Promise<HomebrewInstall | null>;
