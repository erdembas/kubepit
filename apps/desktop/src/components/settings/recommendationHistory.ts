import type { ClusterId, RecommendationSettings } from '@/types';

/** Days recommendation scans are kept (the backend clamps to the same range). */
export const REC_RETENTION_DAYS = { min: 1, max: 90 } as const;

/** A typed number of days clamped to `min`–`max`; not a number keeps `fallback`. */
export function clampDays(value: string, fallback: number, min = 1, max = 3650): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Turn background scans of `clusterId` on or off (a sorted, duplicate-free list). */
export function withScanCluster(
  rec: RecommendationSettings,
  clusterId: ClusterId,
  on: boolean,
): RecommendationSettings {
  const ids = new Set(rec.scan_clusters);
  if (on) ids.add(clusterId);
  else ids.delete(clusterId);
  return { ...rec, scan_clusters: [...ids].sort() };
}
