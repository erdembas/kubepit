import * as i18n from '@/i18n/core';
import { useEffect } from 'react';
import { create } from 'zustand';
import { ipc, isTauri } from '@/lib/ipc';
import { isMainWindow } from '@/lib/windowSeed';
import { useAppStore } from '@/store/useAppStore';
import type { UpdateInfo, UpdaterStatus } from '@/types';

/**
 * In-app updates (About & Updates). Builds without a release signing key
 * report `configured: false` and never check; see `docs/RELEASING.md`.
 * Only the main window checks on startup so several windows do not all
 * announce the same release.
 */

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
  loadStatus: () => Promise<UpdaterStatus | null>;
  /** `silent` skips the toasts (startup check). */
  check: (options?: { silent?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  relaunch: () => Promise<void>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toast = (tone: 'success' | 'error' | 'info', message: string) =>
  useAppStore.getState().pushToast(tone, message);

export const useUpdaterStore = create<UpdaterState>()((set, get) => ({
  status: null,
  phase: 'idle',
  update: null,
  downloaded: 0,
  total: null,
  error: null,
  checkedAt: null,

  loadStatus: async () => {
    try {
      const status = await ipc.updateStatus();
      set({ status });
      return status;
    } catch (e) {
      set({ error: errorText(e) });
      return null;
    }
  },

  check: async ({ silent = false } = {}) => {
    const busy = get().phase;
    if (busy === 'checking' || busy === 'downloading' || busy === 'installing') return;
    const status = get().status ?? (await get().loadStatus());
    if (!status?.configured) return;
    set({ phase: 'checking', error: null });
    try {
      const update = await ipc.updateCheck();
      set({
        update,
        phase: update ? 'available' : 'up-to-date',
        checkedAt: Date.now(),
      });
      if (update)
        toast(
          'info',
          i18n.t('Kubepit {version} is available. Open Settings → About & Updates to install it.', {
            version: update.version,
          }),
        );
      else if (!silent) toast('success', i18n.t('Kubepit is up to date.'));
    } catch (e) {
      set({ phase: 'error', error: errorText(e), checkedAt: Date.now() });
      if (!silent) toast('error', i18n.t('Update check failed: {error}', { error: errorText(e) }));
    }
  },

  install: async () => {
    if (!get().update || get().phase === 'downloading' || get().phase === 'installing') return;
    set({ phase: 'downloading', downloaded: 0, total: null, error: null });
    try {
      await ipc.updateInstall((progress) => {
        if (progress.event === 'started') set({ total: progress.total });
        else if (progress.event === 'progress')
          set({ downloaded: progress.downloaded, total: progress.total });
        else set({ phase: 'installing' });
      });
      set({ phase: 'ready' });
    } catch (e) {
      set({ phase: 'error', error: errorText(e) });
      toast('error', i18n.t('Update failed: {error}', { error: errorText(e) }));
    }
  },

  relaunch: async () => {
    if (!isTauri) {
      toast('info', i18n.t('The browser preview cannot relaunch; reload the page instead.'));
      return;
    }
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      toast('error', errorText(e));
    }
  },
}));

const STARTUP_DELAY_MS = 8_000;

/** Checks once after startup when the build has updates and the setting allows it. */
export function useStartupUpdateCheck() {
  const bootstrapped = useAppStore((s) => s.bootstrapped);
  const auto = useAppStore((s) => s.settings?.auto_check_updates ?? false);
  useEffect(() => {
    if (!bootstrapped || !auto || !isMainWindow) return;
    const timer = window.setTimeout(() => {
      const store = useUpdaterStore.getState();
      if (store.checkedAt === null) void store.check({ silent: true });
    }, STARTUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [bootstrapped, auto]);
}
