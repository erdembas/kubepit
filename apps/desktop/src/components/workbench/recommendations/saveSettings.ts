import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { RecommendationSettings } from '@/types';

/** The saves in flight, one after another. */
let queue: Promise<unknown> = Promise.resolve();

async function save(
  change: (current: RecommendationSettings) => RecommendationSettings,
): Promise<boolean> {
  const settings = useAppStore.getState().settings;
  if (!settings) return false;
  try {
    const saved = await ipc.settingsSet({
      ...settings,
      recommendations: change(settings.recommendations),
    });
    useAppStore.getState().setSettings(saved);
    return true;
  } catch (e) {
    useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Saves a change of `Settings.recommendations` right away (scan opt-ins,
 * interval, strategy, overrides). The backend normalizes the value and
 * syncs the schedulers; a changed strategy or override re-evaluates the
 * stored scans on their next read. Saves run one after another and each
 * change applies to the settings the previous one saved, so quick
 * consecutive changes are all kept. Returns whether it was saved.
 */
export function saveRecommendationSettings(
  change: (current: RecommendationSettings) => RecommendationSettings,
): Promise<boolean> {
  const next = queue.then(() => save(change));
  queue = next;
  return next;
}
