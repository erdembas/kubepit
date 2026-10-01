import { describe, expect, it } from 'vitest';
import {
  MAX_PINNED_SEARCHES,
  MAX_SAVED_SEARCHES,
  sanitizeSavedSearches,
  searchSnapshot,
  sameSavedSearch,
  savedSearchScopeExists,
} from './savedSearches';

const record = (index = 0) => ({
  id: `saved-${index}`,
  name: `Search ${index}`,
  input: ' ns:"payments"  app=api ',
  kinds: ['pods', 'deployments.apps'],
  scope: { kind: 'section', id: 'production' },
  pinned: true,
  createdAt: 1000 + index,
});

describe('saved Fleet search validation', () => {
  it('retains raw syntax and all selected fields while excluding unrelated content', () => {
    const [saved] = sanitizeSavedSearches([
      { ...record(), resultObjects: [{ secret: 'not retained' }] },
    ]);
    expect(saved).toEqual(record());
    expect(searchSnapshot(saved)).toEqual({
      input: record().input,
      kinds: record().kinds,
      scope: record().scope,
    });
    expect(sameSavedSearch(saved!, { ...saved!, kinds: [...saved!.kinds].reverse() })).toBe(true);
    expect(sameSavedSearch(saved!, { ...saved!, input: saved!.input.trim() })).toBe(false);
  });

  it('rejects damaged scopes and kind selections whole instead of broadening queries', () => {
    for (const patch of [
      { kinds: ['pods', 'no-longer-known'] },
      { kinds: [null] },
      { scope: { kind: 'oops' } },
      { scope: { kind: 'environment', env: 'unknown' } },
      { scope: { kind: 'section', id: '' } },
      { input: 'x'.repeat(4097) },
      { input: '' },
      { name: 'x'.repeat(81) },
      { createdAt: Infinity },
    ])
      expect(sanitizeSavedSearches([{ ...record(), ...patch }])).toEqual([]);
    // A CRD may be selected by a raw kind: token without any builtin chips.
    expect(
      searchSnapshot({
        input: 'kind:certificates.cert-manager.io',
        kinds: [],
        scope: { kind: 'all' },
      }),
    ).not.toBeNull();
  });

  it('caps records and pins, deduplicates identities and never widens a missing section', () => {
    const saved = sanitizeSavedSearches(Array.from({ length: 1000 }, (_, i) => record(i)));
    expect(saved).toHaveLength(MAX_SAVED_SEARCHES);
    expect(saved.filter((search) => search.pinned)).toHaveLength(MAX_PINNED_SEARCHES);
    expect(
      sanitizeSavedSearches([record(), record(), { ...record(1), name: 'SEARCH 0' }]),
    ).toHaveLength(1);
    expect(savedSearchScopeExists(saved[0]!.scope, [{ id: 'another' }])).toBe(false);
    expect(savedSearchScopeExists(saved[0]!.scope, [{ id: 'production' }])).toBe(true);
    expect(savedSearchScopeExists({ kind: 'environment', env: 'production' }, [])).toBe(true);
  });
});
