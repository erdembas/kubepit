import { describe, expect, it } from 'vitest';
import type { ApiResourceInfo } from '@/types';
import {
  buildFleetQuery,
  parseSearchInput,
  quoteSearchValue,
  removeSearchToken,
  replaceSearchToken,
  scanSearchInput,
  searchTags,
  splitSearchDraft,
} from './searchQuery';

const custom = [
  {
    group: 'acme.io',
    version: 'v1',
    kind: 'Widget',
    plural: 'widgets',
    namespaced: true,
    short_names: ['wdg'],
  },
] as ApiResourceInfo[];

describe('fleet query tokenization and parsing', () => {
  it('parses aliases and quoted cluster names without leaking words into name matching', () => {
    const parsed = parseSearchInput(
      'k:po,deploy namespace:checkout c:"Production Europe" env:prd,stg l:app=web tier!=db !canary label:team api-*',
    );
    expect(parsed.kinds.map((k) => k.kind)).toEqual(['Pod', 'Deployment']);
    expect(parsed.namespace).toBe('checkout');
    expect(parsed.clusters).toEqual(['production europe']);
    expect(parsed.environments).toEqual(['production', 'staging']);
    expect(parsed.labels).toEqual(['app=web', 'tier!=db', '!canary', 'team']);
    expect(parsed.text).toBe('api-*');
    expect(buildFleetQuery(parsed, parsed.kinds, ['cluster']).label_selector).toBe(
      'app=web,tier!=db,!canary,team',
    );
  });
  it('preserves commas inside quotes, escaped quotes, backslashes and exact offsets', () => {
    const name = 'Europe, "Blue" \\ production';
    const query = `  cluster:${quoteSearchValue(name)} kind:pod `;
    const tokens = scanSearchInput(query);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.values).toEqual([name]);
    expect(parseSearchInput(query).clusters).toEqual([name.toLowerCase()]);
    for (const token of tokens) expect(query.slice(token.start, token.end)).toBe(token.raw);
  });
  it('keeps complete regexes including spaces and character-class slashes as free text', () => {
    const input = String.raw`kind:Pod /^[a-z/ ]+-\d+$/ cluster:"local cluster"`;
    const tokens = scanSearchInput(input);
    expect(tokens).toHaveLength(3);
    expect(tokens[1]).toMatchObject({
      type: 'text',
      value: String.raw`/^[a-z/ ]+-\d+$/`,
      valid: true,
    });
    expect(parseSearchInput(input).text).toBe(String.raw`/^[a-z/ ]+-\d+$/`);
    expect(parseSearchInput(String.raw`kind:Pod "/^api-\d+$/"`).text).toBe(String.raw`/^api-\d+$/`);
  });
  it('leaves malformed and unknown filters editable and reports unknown kind names', () => {
    const input = 'kind:Wrong env:moon ns:bad/name cluster:"unfinished name';
    expect(searchTags(input)).toEqual([]);
    expect(splitSearchDraft(input, true).draft).toBe(input);
    expect(parseSearchInput('kind:Wrong,Pod').unknownKinds).toEqual(['Wrong']);
    expect(scanSearchInput('kind:wdg', custom)[0]).toMatchObject({ valid: true, complete: true });
    expect(parseSearchInput('kind:wdg', custom).kinds[0]?.group).toBe('acme.io');
  });
  it('models all label operators and validates actual Kubernetes label syntax', () => {
    const tokens = scanSearchInput('app=web tier!=db !canary label:team label:app=web,tier!=db');
    expect(tokens.map(({ key, value, operator }) => ({ key, value, operator }))).toEqual([
      { key: 'app', value: 'web', operator: '=' },
      { key: 'tier', value: 'db', operator: '!=' },
      { key: 'canary', value: '', operator: 'not-exists' },
      { key: 'team', value: '', operator: 'exists' },
      { key: null, value: 'app=web,tier!=db', operator: null },
    ]);
    expect(scanSearchInput('app.kubernetes.io/name=api')[0]?.valid).toBe(true);
    for (const invalid of ['wrong//key=api', '-wrong=api', 'app="has spaces"', 'label:'])
      expect(searchTags(invalid)).toEqual([]);
  });
  it('supports explicit empty labels and commits a trailing empty assignment on a delimiter', () => {
    expect(scanSearchInput('app=')[0]).toMatchObject({ valid: true, complete: false });
    expect(scanSearchInput('app= ')[0]).toMatchObject({ valid: true, complete: true });
    expect(scanSearchInput('app=""')[0]).toMatchObject({ valid: true, complete: true });
    expect(parseSearchInput('app=').labels).toEqual(['app=']);
    expect(splitSearchDraft('app=', true).filters).toHaveLength(1);
    expect(splitSearchDraft('app=', false).filters).toHaveLength(0);
  });
});

describe('fleet filter tags preserve the editable query', () => {
  it('commits only closed filter tokens and preserves free text whitespace and regex bytes', () => {
    const input = String.raw`kind:Pod  /^foo \d+$/ ns:checkout app=web`;
    const pending = splitSearchDraft(input, false);
    expect(pending.filters.map((t) => t.raw)).toEqual(['kind:Pod', 'ns:checkout']);
    expect(pending.draft).toBe(String.raw`  /^foo \d+$/  app=web`);
    const committed = splitSearchDraft(input, true);
    expect(committed.filters.map((t) => t.raw)).toEqual(['kind:Pod', 'ns:checkout', 'app=web']);
    expect(committed.draft).toBe(String.raw`  /^foo \d+$/  `);
  });
  it('does not commit a last closed quote until whitespace, Enter or blur', () => {
    expect(splitSearchDraft('cluster:"prod eu"', false).filters).toEqual([]);
    expect(splitSearchDraft('cluster:"prod eu" ', false).filters).toHaveLength(1);
    expect(splitSearchDraft('cluster:"prod eu"', true).filters).toHaveLength(1);
  });
  it('removes only the chosen occurrence and replaces only the caret token', () => {
    const input = 'kind:Pod ns:checkout kind:Pod api-*';
    const tokens = scanSearchInput(input);
    expect(removeSearchToken(input, tokens[2]!)).toBe('kind:Pod ns:checkout api-*');
    expect(replaceSearchToken(input, tokens[1]!, 'ns:payments')).toEqual({
      input: 'kind:Pod ns:payments kind:Pod api-*',
      caret: 20,
    });
  });
});
