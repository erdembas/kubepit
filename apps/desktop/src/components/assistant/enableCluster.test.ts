import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterDef, Settings } from '@/types';

// `lib/ipc` and the app store pull in window-bound modules (Vitest runs in
// the node environment): a fake ipc and a small zustand store stand in.
const ipcMock = vi.hoisted(() => ({ aiClusterSet: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ ipc: ipcMock }));
vi.mock('@/store/useAppStore', async () => {
  const { create } = await import('zustand');
  type Confirm = import('@/store/types').ConfirmRequest;
  const useAppStore = create<{
    settings: Settings | null;
    confirm: Confirm | null;
    toasts: string[];
    setSettings: (s: Settings) => void;
    requestConfirm: (c: Confirm) => void;
    closeConfirm: () => void;
    pushToast: (tone: string, message: string) => void;
  }>((set) => ({
    settings: null,
    confirm: null,
    toasts: [],
    setSettings: (settings) => set({ settings }),
    requestConfirm: (confirm) => set({ confirm }),
    closeConfirm: () => set({ confirm: null }),
    pushToast: (_tone, message) => set((s) => ({ toasts: [...s.toasts, message] })),
  }));
  return { useAppStore };
});

import { useAppStore } from '@/store/useAppStore';
import { enableAssistantFor } from './enableCluster';

const cluster = (id: string, environment: string | null) =>
  ({ id, name: `${id}-name`, environment }) as ClusterDef;
const saved = (clusters: string[]) => ({ ai: { clusters } }) as unknown as Settings;

beforeEach(() => {
  ipcMock.aiClusterSet.mockReset();
  useAppStore.setState({ settings: null, confirm: null, toasts: [] });
});

describe('enableAssistantFor', () => {
  it('enables other clusters at once and applies the saved settings', async () => {
    ipcMock.aiClusterSet.mockResolvedValue(saved(['c-dev']));
    expect(await enableAssistantFor(cluster('c-dev', 'development'))).toBe(true);
    expect(ipcMock.aiClusterSet).toHaveBeenCalledWith('c-dev', true, false);
    expect(useAppStore.getState().settings).toEqual(saved(['c-dev']));
    expect(useAppStore.getState().confirm).toBeNull();
  });

  it('asks for the typed cluster name on production clusters', async () => {
    ipcMock.aiClusterSet.mockResolvedValue(saved(['c-prod']));
    const result = enableAssistantFor(cluster('c-prod', 'production'));
    const confirm = useAppStore.getState().confirm!;
    expect(confirm.typeToConfirm).toBe('c-prod-name');
    expect(confirm.tone).toBe('danger');
    expect(confirm.message).toContain('c-prod-name');
    expect(ipcMock.aiClusterSet).not.toHaveBeenCalled();
    await confirm.onConfirm();
    useAppStore.getState().closeConfirm();
    expect(await result).toBe(true);
    expect(ipcMock.aiClusterSet).toHaveBeenCalledWith('c-prod', true, true);
    expect(useAppStore.getState().settings).toEqual(saved(['c-prod']));
  });

  it('returns false when the confirmation is cancelled or replaced', async () => {
    const cancelled = enableAssistantFor(cluster('c-prod', 'production'));
    useAppStore.getState().closeConfirm();
    expect(await cancelled).toBe(false);

    const replaced = enableAssistantFor(cluster('c-prod', 'production'));
    useAppStore.getState().requestConfirm({ title: 'x', message: 'y', onConfirm: () => {} });
    expect(await replaced).toBe(false);
    expect(ipcMock.aiClusterSet).not.toHaveBeenCalled();
  });

  it('resolves from the save when the dialog is replaced while saving', async () => {
    let finish: (s: Settings) => void = () => {};
    ipcMock.aiClusterSet.mockReturnValueOnce(new Promise<Settings>((r) => (finish = r)));
    let outcome: boolean | null = null;
    const result = enableAssistantFor(cluster('c-prod', 'production')).then((v) => (outcome = v));
    const confirming = useAppStore.getState().confirm!.onConfirm();
    useAppStore.getState().requestConfirm({ title: 'other', message: 'x', onConfirm: () => {} });
    await Promise.resolve();
    expect(outcome).toBeNull();
    finish(saved(['c-prod']));
    await confirming;
    await result;
    expect(outcome).toBe(true);

    ipcMock.aiClusterSet.mockRejectedValueOnce(new Error('keychain locked'));
    const failing = enableAssistantFor(cluster('c-prod', 'production'));
    const attempt = useAppStore.getState().confirm!.onConfirm();
    useAppStore.getState().closeConfirm();
    await expect(attempt).rejects.toThrow('keychain locked');
    expect(await failing).toBe(false);
  });

  it('keeps the confirmation open when saving fails, and reports other failures', async () => {
    ipcMock.aiClusterSet.mockRejectedValueOnce(new Error('keychain locked'));
    const result = enableAssistantFor(cluster('c-prod', 'production'));
    const confirm = useAppStore.getState().confirm!;
    await expect(confirm.onConfirm()).rejects.toThrow('keychain locked');
    useAppStore.getState().closeConfirm();
    expect(await result).toBe(false);

    ipcMock.aiClusterSet.mockRejectedValueOnce(new Error('unknown cluster c-x'));
    expect(await enableAssistantFor(cluster('c-x', null))).toBe(false);
    expect(useAppStore.getState().toasts).toEqual(['unknown cluster c-x']);
  });
});
