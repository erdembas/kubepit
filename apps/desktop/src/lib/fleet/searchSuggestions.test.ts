import { describe, expect, it } from 'vitest';
import type { ApiResourceInfo } from '@/types';
import { parseSearchInput, replaceSearchToken, scanSearchInput } from './searchQuery';
import { suggestSearchInput, type SearchSuggestionContext } from './searchSuggestions';

const context: SearchSuggestionContext = {
  clusters: [
    { id: 'one', name: 'Production Europe', environment: 'production' },
    { id: 'two', name: 'Development, West', environment: 'development' },
  ],
  namespaces: ['checkout', 'payments', 'kube-system'],
  labelValues: {
    app: ['web', 'web-api', ''],
    tier: ['api', 'worker'],
    'app.kubernetes.io/name': ['payments'],
    canary: ['true'],
  },
  apiResources: [
    {
      group: 'acme.io',
      version: 'v1',
      kind: 'Widget',
      plural: 'widgets',
      namespaced: true,
      short_names: ['wdg'],
    },
  ] as ApiResourceInfo[],
};
const suggest = (input: string) => suggestSearchInput(input, input.length, context);

describe('context-aware fleet suggestions', () => {
  it('offers only field templates at an empty caret and narrows kinds through aliases', () => {
    expect(
      suggest('')
        .map((s) => s.value)
        .sort(),
    ).toEqual(['cluster:', 'env:', 'kind:', 'label:', 'ns:']);
    expect(suggest('').map((s) => s.value)).toEqual(['kind:', 'ns:', 'cluster:', 'env:', 'label:']);
    expect(
      suggest('kind:')
        .slice(0, 3)
        .map((s) => s.label),
    ).toEqual(['Pod', 'Deployment', 'StatefulSet']);
    expect(suggest('k:po').some((s) => s.value === 'kind:Pod')).toBe(true);
    expect(suggest('kind:wdg')).toMatchObject([
      { category: 'kind', label: 'Widget', value: 'kind:widgets.acme.io' },
    ]);
  });
  it('quotes real cluster names and their commas so selection survives the real parser', () => {
    const first = suggest('c:prod').find((s) => s.category === 'cluster')!;
    expect(first.value).toBe('cluster:"Production Europe"');
    expect(parseSearchInput(first.value).clusters).toEqual(['production europe']);
    const second = suggest('cluster:dev')[0]!;
    expect(second.value).toBe('cluster:"Development, West"');
    expect(parseSearchInput(second.value).clusters).toEqual(['development, west']);
  });
  it('keeps preceding kind and environment list values while replacing the suffix', () => {
    const kinds = suggest('kind:pod,dep');
    expect(kinds.some((s) => s.value === 'kind:pod,Deployment')).toBe(true);
    expect(suggest('kind:pod,').some((s) => s.label === 'Pod')).toBe(false);
    expect(suggest('e:prd,stg')[0]?.value).toBe('env:prd,staging');
    expect(parseSearchInput(suggest('e:prd,stg')[0]!.value).environments).toEqual([
      'production',
      'staging',
    ]);
  });
  it('offers observed labels and their values without changing the requested operator', () => {
    expect(suggest('app').some((s) => s.category === 'label-key' && s.value === 'app=')).toBe(true);
    expect(suggest('app!=we').map((s) => s.value)).toEqual(['app!=web', 'app!=web-api']);
    expect(suggest('label:tier=wo')[0]?.value).toBe('label:tier=worker');
    expect(suggest('!ca')[0]?.value).toBe('!canary');
    expect(suggest('label:ca')[0]?.value).toBe('label:canary');
    expect(suggest('app=').some((s) => s.value === 'app=""')).toBe(true);
    expect(suggest('label:tier=api,app=we')[0]?.value).toBe('label:tier=api,app=web');
  });
  it('replaces the middle token using the caret while retaining surrounding free text', () => {
    const input = 'api-* ns:pay cluster:"Production Europe"';
    const caret = input.indexOf('pay') + 3;
    const chosen = suggestSearchInput(input, caret, context).find((s) => s.label === 'payments')!;
    expect(replaceSearchToken(input, chosen, chosen.value).input).toBe(
      'api-* ns:payments cluster:"Production Europe"',
    );
    expect(chosen.start).toBe(6);
    expect(chosen.end).toBe(12);
  });
  it('leaves regex and glob editing alone, bounds results and avoids malformed label values', () => {
    expect(suggest(String.raw`/^api-\d+$/`)).toEqual([]);
    expect(suggest('api-*')).toEqual([]);
    expect(suggestSearchInput('kind:', 5, context, 2)).toHaveLength(2);
    const values = suggestSearchInput(
      'app=',
      4,
      { labelValues: { app: ['web', 'has spaces'], '-invalid': ['x'] } },
      50,
    );
    expect(values.map((v) => v.value)).toEqual(['app=web']);
    expect(values.every((v) => scanSearchInput(v.value)[0]?.valid)).toBe(true);
  });
});
