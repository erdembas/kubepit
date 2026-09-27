import { create } from 'zustand';
import { ipc } from '@/lib/ipc';
import type { Alert } from '@/types';

/**
 * The notification center's alerts in this window. The backend owns the
 * history (bounded, shared by every window); this store mirrors it from
 * `alerts_list`, `alerts://new` (upserts) and `alerts://changed` (refetch
 * after another window marked alerts read or cleared them).
 */
interface AlertState {
  /** Newest activity first. */
  alerts: Alert[];
  loaded: boolean;
  load: () => Promise<void>;
  upsert: (alert: Alert) => void;
  /** `null` = every alert. */
  markRead: (ids: string[] | null) => Promise<void>;
  clear: (ids: string[] | null) => Promise<void>;
}

const byActivity = (a: Alert, b: Alert) => b.last_seen - a.last_seen || b.first_seen - a.first_seen;

export const useAlertStore = create<AlertState>()((set) => ({
  alerts: [],
  loaded: false,
  load: async () => {
    const alerts = await ipc.alertsList();
    set({ alerts: [...alerts].sort(byActivity), loaded: true });
  },
  upsert: (alert) =>
    set((s) => ({
      alerts: [alert, ...s.alerts.filter((a) => a.id !== alert.id)].sort(byActivity),
    })),
  markRead: async (ids) => {
    const wanted = ids ? new Set(ids) : null;
    set((s) => ({
      alerts: s.alerts.map((a) =>
        !a.read && (!wanted || wanted.has(a.id)) ? { ...a, read: true } : a,
      ),
    }));
    await ipc.alertsMarkRead(ids);
  },
  clear: async (ids) => {
    const wanted = ids ? new Set(ids) : null;
    set((s) => ({ alerts: wanted ? s.alerts.filter((a) => !wanted.has(a.id)) : [] }));
    await ipc.alertsClear(ids);
  },
}));

export const selectUnreadCount = (s: AlertState) =>
  s.alerts.reduce((n, a) => n + (a.read ? 0 : 1), 0);
