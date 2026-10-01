import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './useAppStore';
import { useFleetSearchStore } from './useFleetSearchStore';
import { ipc } from '@/lib/ipc';

vi.mock('@/lib/ipc', () => ({
  ipc: { fleetSearchCancel: vi.fn().mockResolvedValue(undefined), fleetSearch: vi.fn() },
}));
vi.mock('@/lib/windowSeed', () => ({ isMainWindow: true, windowSeed: null }));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  useFleetSearchStore.setState(useFleetSearchStore.getInitialState(), true);
  useAppStore.setState({ sections: [{ id: 'section-a', name: 'Production', color: 'orange' }] });
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('restoring saved Fleet queries', () => {
  it('applies input, kinds and scope atomically, invalidates old results and never starts a connection', () => {
    useFleetSearchStore.setState({
      running: true,
      searchId: 'older-search',
      query: 'old',
      signature: 'old',
      generation: 7,
    });
    const snapshots: unknown[] = [];
    const unsubscribe = useFleetSearchStore.subscribe((state) =>
      snapshots.push({ input: state.input, kinds: state.kinds, scope: state.scope }),
    );
    const query = {
      input: ' ns:payments  app=api ',
      kinds: ['pods', 'deployments.apps'],
      scope: { kind: 'section' as const, id: 'section-a' },
    };
    expect(useFleetSearchStore.getState().applySavedSearch(query)).toBe('applied');
    unsubscribe();
    expect(snapshots).toEqual([query]);
    expect(useFleetSearchStore.getState()).toMatchObject({
      generation: 8,
      running: false,
      query: '',
      signature: '',
      results: {},
    });
    expect(ipc.fleetSearchCancel).toHaveBeenCalledWith('older-search');
    expect(ipc.fleetSearch).not.toHaveBeenCalled();
    query.kinds.push('secrets');
    expect(useFleetSearchStore.getState().kinds).toEqual(['pods', 'deployments.apps']);
  });

  it('leaves the current query and running operation untouched when a saved section was deleted', () => {
    useFleetSearchStore.setState({
      input: 'safe',
      kinds: ['pods'],
      scope: { kind: 'environment', env: 'development' },
      running: true,
      searchId: 'current',
    });
    const before = useFleetSearchStore.getState();
    expect(
      before.applySavedSearch({
        input: 'api',
        kinds: ['pods'],
        scope: { kind: 'section', id: 'deleted' },
      }),
    ).toBe('missing-section');
    expect(useFleetSearchStore.getState()).toBe(before);
    expect(ipc.fleetSearchCancel).not.toHaveBeenCalled();
    expect(ipc.fleetSearch).not.toHaveBeenCalled();
  });
});
