import { describe, expect, it } from 'vitest';
import { searchableSelectOptions, type SearchableOption } from './selectSearch';

const custom = (query: string): SearchableOption | null =>
  query ? { value: query, label: query } : null;
describe('searchable select native and custom choice priority', () => {
  it('ranks an actual model above the automatic choice that mentions its ID', () => {
    expect(
      searchableSelectOptions(
        [
          { value: 'default', label: 'Agent default', description: 'gpt-6-sol' },
          { value: 'gpt-6-sol', label: 'GPT-6 Sol' },
        ],
        'sol',
        custom,
      ).map((option) => option.value),
    ).toEqual(['gpt-6-sol', 'default', 'sol']);
  });
  it('keeps a real substring match ahead of a custom exact search value', () => {
    expect(
      searchableSelectOptions(
        [{ value: 'gpt-6-astra', label: 'GPT-6 Astra' }],
        'astra',
        custom,
      ).map((option) => option.value),
    ).toEqual(['gpt-6-astra', 'astra']);
  });
  it('promotes a real exact version over its matching alias without duplicating it', () => {
    expect(
      searchableSelectOptions(
        [
          { value: 'opus', label: 'Opus', description: 'claude-opus-5' },
          { value: 'claude-opus-5', label: 'claude-opus-5' },
        ],
        'claude-opus-5',
        custom,
      ).map((option) => option.value),
    ).toEqual(['claude-opus-5', 'opus']);
  });
  it('allows a custom id when no known option matches and preserves ordinary dropdown ordering', () => {
    expect(searchableSelectOptions([], 'future/model', custom)).toEqual([
      { value: 'future/model', label: 'future/model' },
    ]);
    expect(
      searchableSelectOptions(
        [
          { value: 'one', label: 'Two one' },
          { value: 'two', label: 'Two' },
        ],
        'two',
      ).map((option) => option.value),
    ).toEqual(['one', 'two']);
  });
});
