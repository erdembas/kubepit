import * as i18n from '@/i18n/core';
import { useEffect } from 'react';
import { create } from 'zustand';
import { ipc, isTauri } from '@/lib/ipc';
import { isMainWindow } from '@/lib/windowSeed';
import { startUpdateScheduler } from '@/lib/updates/scheduler';
import { useAppStore } from '@/store/useAppStore';
import type { UpdateInfo, UpdaterStatus } from '@/types';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'error';

interface UpdaterState {
  status: UpdaterStatus | null;
  phase: UpdatePhase;
  update: UpdateInfo | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  checkedAt: number | null;
  announcementOpen: boolean;
  detailsOpen: boolean;
  relaunching: boolean;
  loadStatus: () => Promise<UpdaterStatus | null>;
  check: (options?: { silent?: boolean; automatic?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  relaunch: () => Promise<void>;
  openDetails: () => void;
  closeDetails: () => void;
  dismissAnnouncement: () => void;
}

function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (message === 'The available update changed. Check for updates again before installing.')
    return i18n.t('The available update changed. Check for updates again before installing.');
  if (message === 'An update operation is already in progress in another window')
    return i18n.t('An update operation is already in progress in another window');
  return message;
}
const toast = (tone: 'success' | 'error' | 'info', message: string) =>
  useAppStore.getState().pushToast(tone, message);
const automaticChecksAllowed = () =>
  isMainWindow && !!useAppStore.getState().settings?.auto_check_updates;
const ANNOUNCED_KEY = 'kubepit.updates.announced.v1';
const announced = new Set<string>();
let statusRequest: Promise<UpdaterStatus | null> | null = null;

/** Remember announcements across launches, including when browser storage is unavailable. */
function claimAnnouncement(update: UpdateInfo): boolean {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ANNOUNCED_KEY) ?? '[]');
    if (Array.isArray(saved))
      saved
        .filter((value): value is string => typeof value === 'string')
        .forEach((value) => announced.add(value));
  } catch {
    /* Blocked or malformed storage: the in-memory set still prevents repeat notices. */
  }
  const key = `${update.current_version}>${update.version}`;
  if (announced.has(key)) return false;
  announced.add(key);
  const recent = [...announced].slice(-20);
  announced.clear();
  recent.forEach((value) => announced.add(value));
  try {
    localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(recent));
  } catch {
    /* Best effort. */
  }
  return true;
}

export const useUpdaterStore = create<UpdaterState>()((set, get) => ({
  status: null,
  phase: 'idle',
  update: null,
  downloaded: 0,
  total: null,
  error: null,
  checkedAt: null,
  announcementOpen: false,
  detailsOpen: false,
  relaunching: false,

  loadStatus: () => {
    if (statusRequest) return statusRequest;
    statusRequest = (async () => {
      try {
        const status = await ipc.updateStatus();
        set({ status });
        return status;
      } catch (e) {
        set({ error: errorText(e) });
        return null;
      } finally {
        statusRequest = null;
      }
    })();
    return statusRequest;
  },

  check: async ({ silent = false, automatic = false } = {}) => {
    const previous = get().phase;
    // A downloaded update must survive background polling until the user relaunches.
    if (['checking', 'downloading', 'installing', 'ready'].includes(previous)) return;
    if (automatic && !automaticChecksAllowed()) return;
    // Acquire the guard before awaiting status: startup, settings and the palette can race.
    set({ phase: 'checking', error: null });
    const status = get().status ?? (await get().loadStatus());
    if (!status?.configured || (automatic && !automaticChecksAllowed())) {
      set({ phase: !status ? 'error' : previous });
      return;
    }
    try {
      const update = await ipc.updateCheck();
      const mayAnnounce = !automatic || automaticChecksAllowed();
      const firstAnnouncement = update && mayAnnounce ? claimAnnouncement(update) : false;
      set({
        update,
        phase: update ? 'available' : 'up-to-date',
        checkedAt: Date.now(),
        announcementOpen: !!update && (get().announcementOpen || firstAnnouncement),
        detailsOpen: !!update && (get().detailsOpen || !silent),
      });
      if (!update && !silent) toast('success', i18n.t('Kubepit is up to date.'));
    } catch (e) {
      set({ phase: 'error', error: errorText(e), checkedAt: Date.now() });
      if (!silent) toast('error', i18n.t('Update check failed: {error}', { error: errorText(e) }));
    }
  },

  install: async () => {
    const update = get().update;
    if (!update || !['available', 'error'].includes(get().phase)) return;
    set({ phase: 'downloading', downloaded: 0, total: null, error: null });
    let active = true;
    try {
      await ipc.updateInstall(update.version, (progress) => {
        // Some channel implementations can deliver an already queued event after completion.
        if (!active) return;
        if (progress.event === 'started') set({ total: progress.total });
        else if (progress.event === 'progress')
          set({ downloaded: progress.downloaded, total: progress.total });
        else set({ phase: 'installing' });
      });
      active = false;
      set({ phase: 'ready', announcementOpen: true });
    } catch (e) {
      active = false;
      set({ phase: 'error', error: errorText(e) });
      toast('error', i18n.t('Update failed: {error}', { error: errorText(e) }));
    }
  },

  relaunch: async () => {
    if (get().phase !== 'ready' || get().relaunching) return;
    if (!isTauri) {
      toast('info', i18n.t('The browser preview cannot relaunch; reload the page instead.'));
      return;
    }
    set({ relaunching: true });
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      set({ relaunching: false });
      toast('error', errorText(e));
    }
  },

  openDetails: () => {
    if (get().update) set({ detailsOpen: true });
  },
  closeDetails: () => set({ detailsOpen: false }),
  dismissAnnouncement: () => set({ announcementOpen: false }),
}));

/** Only the main window owns the timer; switching the setting off cancels future checks. */
export function useAutomaticUpdateChecks() {
  const bootstrapped = useAppStore((s) => s.bootstrapped);
  const auto = useAppStore((s) => s.settings?.auto_check_updates ?? false);
  useEffect(() => {
    if (!bootstrapped || !auto || !isMainWindow) return;
    return startUpdateScheduler(() =>
      useUpdaterStore.getState().check({ silent: true, automatic: true }),
    );
  }, [bootstrapped, auto]);
}
