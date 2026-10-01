import { describe, expect, it } from 'vitest';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import {
  SearchSuggestionMetadata,
  type ResourceMetadataObservation,
} from './searchSuggestionMetadata';

function resource(
  clusterId: string,
  uid: string,
  namespace: string,
  labels: Record<string, string>,
  kind = BUILTIN.Pod,
): ResourceMetadataObservation {
  return { clusterId, uid, name: uid, namespace, labels, gvk: toGvk(kind) };
}

describe('observed search metadata', () => {
  it('retains values through empty partial searches, but replaces changed metadata for the same object', () => {
    const cache = new SearchSuggestionMetadata();
    cache.observe([resource('prod', 'api', 'checkout', { app: 'payments', tier: 'backend' })]);
    cache.observe([]);
    expect(cache.collect(['prod'], ['pods'], null).labelValues).toEqual({
      app: ['payments'],
      tier: ['backend'],
    });
    cache.observe([resource('prod', 'api', 'checkout', { app: 'checkout' })]);
    expect(cache.collect(['prod'], ['pods'], null).labelValues).toEqual({ app: ['checkout'] });
  });

  it('isolates labels by target cluster, kind and namespace while preserving namespace choices', () => {
    const cache = new SearchSuggestionMetadata();
    cache.observe([
      resource('prod', 'pod', 'checkout', { app: 'payments' }),
      resource('prod', 'service', 'checkout', { app: 'gateway' }, BUILTIN.Service),
      resource('prod', 'pod-ops', 'ops', { app: 'controller' }),
      resource('staging', 'pod', 'checkout', { app: 'test' }),
      {
        ...resource('prod', 'namespace', 'ignored', {}, BUILTIN.Namespace),
        name: 'inventory',
        namespace: null,
      },
    ]);
    expect(cache.collect(['prod'], ['pods'], 'checkout')).toEqual({
      namespaces: ['checkout', 'inventory', 'ops'],
      labelValues: { app: ['payments'] },
    });
    expect(cache.collect(['staging'], ['pods'], null).labelValues).toEqual({ app: ['test'] });
    cache.prune(['staging']);
    expect(cache.collect(['prod'], ['pods'], null).labelValues).toEqual({});
  });

  it('keeps only bounded metadata and rejects malformed oversized label values', () => {
    const cache = new SearchSuggestionMetadata();
    const pod = resource('prod', 'pod', 'default', {
      app: 'web',
      empty: '',
      tooLong: 'x'.repeat(64),
      'bad key': 'value',
    });
    cache.observe([
      {
        ...pod,
        spec: { password: 'never-stored' },
        annotations: { token: 'never-stored' },
      } as ResourceMetadataObservation,
    ]);
    expect(cache.collect(['prod'], ['pods'], null)).toEqual({
      namespaces: ['default'],
      labelValues: { app: ['web'], empty: [''] },
    });
    const many = Array.from({ length: 8192 }, (_, index) =>
      resource(`cluster-${index % 40}`, `pod-${index}`, 'default', { app: `app-${index}` }),
    );
    cache.observe(many);
    expect(cache.size().clusters).toBeLessThanOrEqual(32);
    expect(cache.size().observations).toBeLessThanOrEqual(2048);
    expect(
      Object.values(
        cache.collect(
          many.map((row) => row.clusterId),
          ['pods'],
          null,
        ).labelValues,
      ).every((values) => values.length <= 128),
    ).toBe(true);
  });
});
