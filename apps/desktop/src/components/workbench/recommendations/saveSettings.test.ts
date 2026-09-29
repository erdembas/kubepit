import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/types';

const settingsSet = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({ ipc: { settingsSet } }));

const { useAppStore } = await import('@/store/useAppStore');
const { saveRecommendationSettings } = await import('./saveSettings');

describe('recommendation settings saves', () => {
  it('run one after another, so quick consecutive changes are all kept', async () => {
    useAppStore.getState().setSettings({
      recommendations: {
        scan_clusters: [],
        interval_minutes: 60,
        retention_days: 30,
        strategy: null,
        overrides: {},
        alerts: false,
      },
    } as unknown as Settings);
    // The backend answers slowly and returns what it was sent.
    settingsSet.mockImplementation(
      (next: Settings) => new Promise((resolve) => setTimeout(() => resolve(next), 5)),
    );
    const a = saveRecommendationSettings((rec) => ({
      ...rec,
      scan_clusters: [...rec.scan_clusters, 'c1'],
    }));
    const b = saveRecommendationSettings((rec) => ({ ...rec, interval_minutes: 180 }));
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(settingsSet).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().settings?.recommendations).toMatchObject({
      scan_clusters: ['c1'],
      interval_minutes: 180,
    });
  });

  it('keep the queue going after a failed save', async () => {
    const pushToast = vi.fn();
    useAppStore.setState({ pushToast });
    settingsSet.mockReset();
    settingsSet.mockRejectedValueOnce(new Error('disk full'));
    settingsSet.mockImplementation(async (next: Settings) => next);
    const failed = saveRecommendationSettings((rec) => ({ ...rec, retention_days: 7 }));
    const saved = saveRecommendationSettings((rec) => ({ ...rec, retention_days: 14 }));
    expect(await failed).toBe(false);
    expect(pushToast).toHaveBeenCalledWith('error', 'disk full');
    expect(await saved).toBe(true);
    expect(useAppStore.getState().settings?.recommendations.retention_days).toBe(14);
  });
});
