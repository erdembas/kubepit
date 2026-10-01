import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PINNED_SEARCHES, MAX_SAVED_SEARCHES } from '@/lib/fleet/savedSearches';
import {
  acceptSavedSearchStorage,
  SAVED_FLEET_SEARCH_KEY,
  useSavedFleetSearchStore,
} from './useSavedFleetSearchStore';

vi.mock('@/lib/windowSeed', () => ({ isMainWindow: true }));
const snapshot = {
  input: ' ns:payments  app=api ',
  kinds: ['pods'],
  scope: { kind: 'section' as const, id: 'section-a' },
};
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  useSavedFleetSearchStore.setState({ searches: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('saved Fleet search preferences', () => {
  it('persists, reloads, renames, pins and removes a complete query snapshot', async () => {
    const result = useSavedFleetSearchStore.getState().save('API incidents', snapshot, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const persisted = values.get(SAVED_FLEET_SEARCH_KEY)!;
    expect(JSON.parse(persisted).state.searches[0]).toMatchObject(snapshot);
    useSavedFleetSearchStore.setState({ searches: [] });
    values.set(SAVED_FLEET_SEARCH_KEY, persisted);
    await useSavedFleetSearchStore.persist.rehydrate();
    const store = useSavedFleetSearchStore.getState();
    expect(store.searches).toEqual([result.search]);
    expect(store.rename(result.search.id, 'Payments')).toMatchObject({
      ok: true,
      search: { name: 'Payments' },
    });
    expect(store.setPinned(result.search.id, false)).toMatchObject({
      ok: true,
      search: { pinned: false },
    });
    store.remove(result.search.id);
    expect(JSON.parse(values.get(SAVED_FLEET_SEARCH_KEY)!).state.searches).toEqual([]);
  });

  it('enforces name, pin and count limits without evicting existing searches', () => {
    const store = useSavedFleetSearchStore.getState();
    for (let i = 0; i < MAX_PINNED_SEARCHES; i++)
      expect(store.save(`Pinned ${i}`, snapshot, true).ok).toBe(true);
    expect(store.save('Too many pins', snapshot, true)).toEqual({ ok: false, error: 'pin-limit' });
    expect(store.save('PINNED 0', snapshot, false)).toEqual({ ok: false, error: 'duplicate-name' });
    for (let i = MAX_PINNED_SEARCHES; i < MAX_SAVED_SEARCHES; i++)
      expect(store.save(`Search ${i}`, snapshot, false).ok).toBe(true);
    expect(store.save('Too many', snapshot, false)).toEqual({ ok: false, error: 'limit' });
    expect(useSavedFleetSearchStore.getState().searches).toHaveLength(MAX_SAVED_SEARCHES);
  });

  it('reports quota failures for every edit without changing memory or persisted records, and allows retry', () => {
    const store = useSavedFleetSearchStore.getState();
    const original = store.save('Existing', snapshot, false);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const before = useSavedFleetSearchStore.getState().searches;
    const persisted = values.get(SAVED_FLEET_SEARCH_KEY);
    const failingWrite = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(store.save('New search', snapshot, false)).toEqual({ ok: false, error: 'storage' });
    expect(store.rename(original.search.id, 'Renamed')).toEqual({ ok: false, error: 'storage' });
    expect(store.setPinned(original.search.id, true)).toEqual({ ok: false, error: 'storage' });
    expect(store.remove(original.search.id)).toEqual({ ok: false, error: 'storage' });
    expect(useSavedFleetSearchStore.getState().searches).toBe(before);
    expect(values.get(SAVED_FLEET_SEARCH_KEY)).toBe(persisted);
    failingWrite.mockRestore();
    expect(store.save('New search', snapshot, false).ok).toBe(true);
    expect(useSavedFleetSearchStore.getState().searches).toHaveLength(2);
  });

  it('validates hydration and live preference messages instead of trusting stored functions or scopes', async () => {
    const record = { ...snapshot, id: 'one', name: 'One', pinned: false, createdAt: 100 };
    const malformed = { ...record, id: 'bad', name: 'Bad', scope: { kind: 'unknown' } };
    values.set(
      SAVED_FLEET_SEARCH_KEY,
      JSON.stringify({
        version: 1,
        state: { searches: [record, malformed], save: 'not a function' },
      }),
    );
    await useSavedFleetSearchStore.persist.rehydrate();
    expect(useSavedFleetSearchStore.getState().searches).toEqual([record]);
    expect(typeof useSavedFleetSearchStore.getState().save).toBe('function');
    acceptSavedSearchStorage('{malformed');
    acceptSavedSearchStorage(JSON.stringify({ version: 2, state: { searches: [] } }));
    expect(useSavedFleetSearchStore.getState().searches).toEqual([record]);
    acceptSavedSearchStorage(
      JSON.stringify({
        version: 1,
        state: { searches: [{ ...record, name: 'Changed elsewhere', pinned: true }] },
      }),
    );
    expect(useSavedFleetSearchStore.getState().searches[0]).toMatchObject({
      name: 'Changed elsewhere',
      pinned: true,
    });
    acceptSavedSearchStorage(null);
    expect(useSavedFleetSearchStore.getState().searches).toEqual([]);
  });
});
