import { create } from 'zustand';
import type { CostAggregate, CostWindow } from '@/types';

/**
 * Per-viewer preferences of the Cost view (window, grouping, label key,
 * idle row, tab). Conveniences only: kept in this webview's localStorage
 * and safe to lose. Recommendation settings live in the backend
 * (`Settings.recommendations`).
 */

export type CostTab = 'breakdown' | 'rightsizing';

export interface CostPrefs {
  window: CostWindow;
  aggregate: CostAggregate;
  label: string;
  showIdle: boolean;
  tab: CostTab;
}

const KEY = 'kubepit.cost.v1';

const DEFAULTS: CostPrefs = {
  window: '7d',
  aggregate: 'namespace',
  label: 'team',
  showIdle: true,
  tab: 'breakdown',
};

function load(): CostPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CostPrefs> | null;
    if (!raw || typeof raw !== 'object') return DEFAULTS;
    return {
      window: raw.window === '30d' ? '30d' : '7d',
      aggregate:
        raw.aggregate === 'workload' || raw.aggregate === 'label' ? raw.aggregate : 'namespace',
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : DEFAULTS.label,
      showIdle: raw.showIdle !== false,
      tab: raw.tab === 'rightsizing' ? 'rightsizing' : 'breakdown',
    };
  } catch {
    return DEFAULTS;
  }
}

interface CostPrefsStore extends CostPrefs {
  update: (patch: Partial<CostPrefs>) => void;
}

export const useCostPrefs = create<CostPrefsStore>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch);
    const { update: _update, ...prefs } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* Private or blocked storage: keep the in-memory value. */
    }
  },
}));
