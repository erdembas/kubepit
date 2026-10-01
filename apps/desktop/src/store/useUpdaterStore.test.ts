import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo, UpdateProgress, UpdaterStatus } from '@/types';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  check: vi.fn(),
  install: vi.fn(),
  toast: vi.fn(),
  relaunch: vi.fn(),
  automatic: true,
  main: true,
  native: true,
}));
vi.mock('@/lib/ipc', () => ({
  get isTauri() {
    return mocks.native;
  },
  ipc: { updateStatus: mocks.status, updateCheck: mocks.check, updateInstall: mocks.install },
}));
vi.mock('@/lib/windowSeed', () => ({
  get isMainWindow() {
    return mocks.main;
  },
}));
vi.mock('@/store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({ settings: { auto_check_updates: mocks.automatic }, pushToast: mocks.toast }),
  },
}));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));

const status: UpdaterStatus = {
  configured: true,
  current_version: '0.0.1',
  endpoint: 'https://example.test/latest.json',
};
const update: UpdateInfo = {
  version: '0.0.2',
  current_version: '0.0.1',
  date: null,
  notes: 'Release fixture',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let store: (typeof import('./useUpdaterStore'))['useUpdaterStore'];
let storage: Map<string, string>;
const automatic = { silent: true, automatic: true };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.automatic = true;
  mocks.main = true;
  mocks.native = true;
  mocks.status.mockResolvedValue(status);
  mocks.check.mockResolvedValue(update);
  mocks.install.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  store = (await import('./useUpdaterStore')).useUpdaterStore;
});
afterEach(() => vi.unstubAllGlobals());

describe('update checks and announcements', () => {
  it('acquires its guard before status loads and shares concurrent status requests', async () => {
    const loading = deferred<UpdaterStatus>();
    mocks.status.mockReturnValue(loading.promise);
    const first = store.getState().check(automatic);
    const duplicate = store.getState().check(automatic);
    const statusRequest = store.getState().loadStatus();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(store.getState().phase).toBe('checking');
    loading.resolve(status);
    await Promise.all([first, duplicate, statusRequest]);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      phase: 'available',
      announcementOpen: true,
      detailsOpen: false,
    });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('does not nag for the same release after dismissal, later checks or an app restart', async () => {
    await store.getState().check(automatic);
    store.getState().dismissAnnouncement();
    await store.getState().check(automatic);
    expect(store.getState().announcementOpen).toBe(false);
    vi.resetModules();
    store = (await import('./useUpdaterStore')).useUpdaterStore;
    await store.getState().check(automatic);
    expect(store.getState().announcementOpen).toBe(false);
    mocks.check.mockResolvedValue({ ...update, version: '0.0.3' });
    await store.getState().check(automatic);
    expect(store.getState().announcementOpen).toBe(true);
  });

  it('manual checks can reopen details for a previously announced release', async () => {
    await store.getState().check(automatic);
    store.getState().dismissAnnouncement();
    await store.getState().check();
    expect(store.getState().detailsOpen).toBe(true);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('requires main window and enabled preference for automatic checks, but permits manual checks', async () => {
    mocks.main = false;
    await store.getState().check(automatic);
    expect(mocks.status).not.toHaveBeenCalled();
    mocks.main = true;
    mocks.automatic = false;
    await store.getState().check(automatic);
    expect(mocks.status).not.toHaveBeenCalled();
    await store.getState().check();
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it('rechecks the preference after loading status and does not send a disabled automatic request', async () => {
    const loading = deferred<UpdaterStatus>();
    mocks.status.mockReturnValue(loading.promise);
    const request = store.getState().check(automatic);
    mocks.automatic = false;
    loading.resolve(status);
    await request;
    expect(mocks.check).not.toHaveBeenCalled();
    expect(store.getState().phase).toBe('idle');
  });

  it('does not announce a pending automatic result after the preference was disabled', async () => {
    store.setState({ status });
    const loading = deferred<UpdateInfo>();
    mocks.check.mockReturnValue(loading.promise);
    const request = store.getState().check(automatic);
    mocks.automatic = false;
    loading.resolve(update);
    await request;
    expect(store.getState()).toMatchObject({ update, announcementOpen: false, detailsOpen: false });
    expect(storage.size).toBe(0);
  });

  it('never queries an unconfigured feed and can recover from status errors', async () => {
    mocks.status.mockRejectedValueOnce(new Error('status unavailable'));
    await store.getState().check(automatic);
    expect(store.getState().phase).toBe('error');
    mocks.status.mockResolvedValueOnce({ ...status, configured: false });
    await store.getState().check(automatic);
    expect(mocks.check).not.toHaveBeenCalled();
    store.setState({ status: null });
    await store.getState().check(automatic);
    expect(store.getState().phase).toBe('available');
  });

  it('retains an available update on background failure and clears it when no update is returned', async () => {
    await store.getState().check(automatic);
    mocks.check.mockRejectedValueOnce(new Error('offline'));
    await store.getState().check(automatic);
    expect(store.getState()).toMatchObject({ phase: 'error', update, error: 'offline' });
    expect(mocks.toast).not.toHaveBeenCalled();
    mocks.check.mockResolvedValueOnce(null);
    await store.getState().check();
    expect(store.getState()).toMatchObject({
      phase: 'up-to-date',
      update: null,
      announcementOpen: false,
      detailsOpen: false,
    });
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Kubepit is up to date.');
  });

  it('tolerates malformed and unavailable announcement storage', async () => {
    storage.set('kubepit.updates.announced.v1', '{invalid');
    await store.getState().check(automatic);
    expect(store.getState().announcementOpen).toBe(true);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    store.getState().dismissAnnouncement();
    await store.getState().check(automatic);
    expect(store.getState().announcementOpen).toBe(false);
  });
});

describe('installation and relaunch consent', () => {
  it('blocks competing checks and duplicate installs, preserves ready, and ignores late progress', async () => {
    await store.getState().check(automatic);
    const download = deferred<void>();
    let progress!: (event: UpdateProgress) => void;
    mocks.install.mockImplementation((_version: string, callback: typeof progress) => {
      progress = callback;
      return download.promise;
    });
    const installing = store.getState().install();
    await store.getState().install();
    await store.getState().check(automatic);
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.install).toHaveBeenCalledWith(update.version, expect.any(Function));
    expect(mocks.check).toHaveBeenCalledTimes(1);
    progress({ event: 'started', total: 100 });
    progress({ event: 'progress', downloaded: 50, total: 100 });
    expect(store.getState()).toMatchObject({ phase: 'downloading', downloaded: 50, total: 100 });
    progress({ event: 'finished' });
    expect(store.getState().phase).toBe('installing');
    download.resolve();
    await installing;
    await store.getState().check();
    await store.getState().install();
    progress({ event: 'started', total: 2 });
    progress({ event: 'finished' });
    expect(store.getState()).toMatchObject({ phase: 'ready', update, total: 100 });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('blocks installation while checking and allows explicit retry after installation failure', async () => {
    store.setState({ status, update });
    const loading = deferred<UpdateInfo>();
    mocks.check.mockReturnValue(loading.promise);
    const request = store.getState().check(automatic);
    await store.getState().install();
    expect(mocks.install).not.toHaveBeenCalled();
    loading.resolve(update);
    await request;
    mocks.install.mockRejectedValueOnce(new Error('signature mismatch'));
    await store.getState().install();
    expect(store.getState()).toMatchObject({ phase: 'error', update });
    expect(mocks.toast).toHaveBeenCalledWith('error', 'Update failed: signature mismatch');
    await store.getState().install();
    expect(store.getState().phase).toBe('ready');
  });

  it('only relaunches a ready update once after an explicit action, with retry on failure', async () => {
    await store.getState().relaunch();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    store.setState({ phase: 'ready', update });
    mocks.relaunch.mockRejectedValueOnce(new Error('restart failed'));
    await store.getState().relaunch();
    expect(store.getState()).toMatchObject({ phase: 'ready', relaunching: false });
    const restart = deferred<void>();
    mocks.relaunch.mockReturnValue(restart.promise);
    const first = store.getState().relaunch();
    const second = store.getState().relaunch();
    await Promise.resolve();
    restart.resolve();
    await Promise.all([first, second]);
    expect(mocks.relaunch).toHaveBeenCalledTimes(2);
  });

  it('keeps the browser demo ready and explains that native relaunch is unavailable', async () => {
    mocks.native = false;
    store.setState({ phase: 'ready', update });
    await store.getState().relaunch();
    expect(store.getState().phase).toBe('ready');
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      'info',
      'The browser preview cannot relaunch; reload the page instead.',
    );
  });
});
