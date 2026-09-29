import { describe, expect, it } from 'vitest';
import type { RecommendationSettings } from '@/types';
import { REC_RETENTION_DAYS, clampDays, withScanCluster } from './recommendationHistory';

const rec: RecommendationSettings = {
  scan_clusters: ['b'],
  interval_minutes: 60,
  retention_days: 30,
  strategy: null,
  overrides: {},
  alerts: false,
};

describe('recommendation history settings', () => {
  it('clamps the retention to 1–90 days and keeps the last value for junk', () => {
    const { min, max } = REC_RETENTION_DAYS;
    expect(clampDays('45', 30, min, max)).toBe(45);
    expect(clampDays('120', 30, min, max)).toBe(90);
    expect(clampDays('2.6', 30, min, max)).toBe(3);
    expect(clampDays('0', 30, min, max)).toBe(30);
    expect(clampDays('-4', 30, min, max)).toBe(30);
    expect(clampDays('', 30, min, max)).toBe(30);
    expect(clampDays('abc', 30, min, max)).toBe(30);
    // Other retentions keep their wider default range.
    expect(clampDays('999', 7)).toBe(999);
    expect(clampDays('99999', 7)).toBe(3650);
  });

  it('turns background scans on and off per cluster', () => {
    const on = withScanCluster(rec, 'a', true);
    expect(on.scan_clusters).toEqual(['a', 'b']);
    expect(withScanCluster(on, 'a', true).scan_clusters).toEqual(['a', 'b']);
    expect(withScanCluster(on, 'b', false).scan_clusters).toEqual(['a']);
    expect(withScanCluster(rec, 'x', false)).toEqual(rec);
    expect(rec.scan_clusters).toEqual(['b']);
  });
});
