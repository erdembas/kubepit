import { describe, expect, it } from 'vitest';
import { chunkBatches, generateScaleObjects, scaleParams, withScaleParams } from './scale';

describe('scale demo', () => {
  it('generates the preset counts deterministically', () => {
    const objs = generateScaleObjects('s', 'c-scale-s');
    const count = (kind: string) => objs.filter((o) => o.kind === kind).length;
    expect([
      count('Pod'),
      count('Node'),
      count('Service'),
      count('Deployment'),
      count('ReplicaSet'),
    ]).toEqual([1000, 50, 250, 250, 500]);
    expect(JSON.stringify(generateScaleObjects('s', 'c-scale-s'))).toBe(JSON.stringify(objs));
  });
  it('chunkBatches follows the backend contract', () => {
    const items = generateScaleObjects('s', 'c').filter((o) => o.kind === 'Pod');
    const batches = chunkBatches('w', items);
    expect(batches.map((b) => b.upserts.length)).toEqual([500, 500]);
    expect(batches.map((b) => [b.reset, b.synced])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(chunkBatches('w', [])).toEqual([
      {
        watch_id: 'w',
        reset: true,
        upserts: [],
        deletes: [],
        synced: true,
        error: null,
        recovered: false,
      },
    ]);
  });
  it('parses and validates the URL switches', () => {
    expect(scaleParams('?scale=l&churn=50')).toEqual({ scale: 'l', churn: 50 });
    expect(scaleParams('?scale=xl&churn=99999')).toEqual({ scale: null, churn: 1000 });
    expect(scaleParams('')).toEqual({ scale: null, churn: 0 });
  });
  it('withScaleParams keeps scale and churn', () => {
    const url = withScaleParams(
      new URL('http://localhost:1430/?window=win-2'),
      '?scale=m&churn=10&perf=1',
    );
    expect(url.searchParams.get('scale')).toBe('m');
    expect(url.searchParams.get('churn')).toBe('10');
    expect(url.searchParams.get('perf')).toBe('1');
    expect(url.searchParams.get('window')).toBe('win-2');
  });
  // The same names are pinned by `crates/kubepit-core/tests/scale_fixture.rs`
  // (`names_match_the_demo_generator`): both generators follow one scheme.
  it('names match the Rust scale fixture', () => {
    const names = new Set(
      generateScaleObjects('s', 'c-scale-s').map(
        (o) => `${o.apiVersion} ${o.kind} ${o.metadata.namespace ?? ''}/${o.metadata.name}`,
      ),
    );
    for (const name of [
      'v1 Pod ns-0001/app-0001-api-kbf2jnh5rf-6gdhk',
      'apps/v1 ReplicaSet ns-0001/app-0001-api-bs5r87rj9j',
      'discovery.k8s.io/v1 EndpointSlice ns-0001/app-0001-api-29dnx',
      'v1 Event ns-0001/app-0001-api-kbf2jnh5rf-6gdhk.c9e192c28c8c4cde',
      'scale7.example.com/v1 Widget ns-0011/widget-0001',
    ])
      expect(names).toContain(name);
    const pods = generateScaleObjects('l', 'c-scale-l').filter((o) => o.kind === 'Pod');
    expect(pods.map((p) => `${p.metadata.namespace}/${p.metadata.name}`)).toContain(
      'ns-0400/app-5000-gateway-pxzk6tb9sn-vjhp5',
    );
  });
});
