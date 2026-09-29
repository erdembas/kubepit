import { describe, expect, it } from 'vitest';
import type {
  ContainerRecommendation,
  RecommendationLens,
  RecommendationWarning,
  WorkloadRecommendation,
} from '@/types';
import {
  flagLabel,
  listRows,
  pruneSelection,
  rowFlags,
  toggleAll,
  toggleSelection,
  withLenses,
} from './listModel';

const MiB = 1024 ** 2;

function container(
  name: string,
  warnings: RecommendationWarning[] = [],
  extra: Partial<ContainerRecommendation> = {},
): ContainerRecommendation {
  return {
    name,
    current: { cpu_request: 500, memory_request: 512 * MiB, cpu_limit: null, memory_limit: null },
    recommended: {
      cpu_request: 100,
      memory_request: 256 * MiB,
      cpu_limit: null,
      memory_limit: null,
    },
    usage: null,
    cpu: 'decrease',
    memory: 'decrease',
    memory_limit: 'unchanged',
    cpu_limit: 'unchanged',
    confidence: 'high',
    warnings,
    cpu_limit_raised: false,
    memory_limit_raised: false,
    evidence: null,
    ...extra,
  };
}

function workload(
  name: string,
  over: Partial<WorkloadRecommendation> = {},
  containers: ContainerRecommendation[] = [container('app')],
): WorkloadRecommendation {
  return {
    kind: 'Deployment',
    namespace: 'shop',
    name,
    uid: name,
    replicas: 1,
    confidence: 'high',
    verdict: 'over',
    coverage_hours: 168,
    containers,
    monthly_delta: -10,
    monthly_current: 20,
    changed: true,
    pods: [],
    pods_truncated: false,
    hpa: null,
    lenses: [],
    cost_replicas: 1,
    ...over,
  };
}

const names = (list: WorkloadRecommendation[]) => list.map((w) => w.name);
const lensed = (name: string, lenses: RecommendationLens[], over = {}) =>
  workload(name, { lenses, ...over });

describe('list rows', () => {
  const rows = [
    lensed('web', ['cpu-reduction', 'memory-reduction'], { monthly_delta: -30 }),
    lensed('api', ['cpu-reduction'], { monthly_delta: -5 }),
    lensed('db', ['increase', 'limit-raised'], { verdict: 'under', monthly_delta: 12 }),
    lensed('idle', ['missing-data'], { verdict: 'no-data', changed: false, monthly_delta: 0 }),
  ];
  const view = {
    filter: 'changed' as const,
    lenses: [] as RecommendationLens[],
    sort: 'delta' as const,
  };

  it('count every verdict tab over the searched rows', () => {
    expect(listRows(rows, view, '').tabs).toEqual({ changed: 3, over: 2, under: 1, all: 4 });
    expect(listRows(rows, view, 'Deployment shop/w').tabs).toEqual({
      changed: 1,
      over: 1,
      under: 0,
      all: 1,
    });
  });

  it('show the tab, narrowed by every picked lens, sorted', () => {
    expect(names(listRows(rows, view, '').shown)).toEqual(['web', 'api', 'db']);
    expect(names(listRows(rows, { ...view, lenses: ['cpu-reduction'] }, '').shown)).toEqual([
      'web',
      'api',
    ]);
    // Lenses combine: a row needs every one of them.
    expect(
      names(listRows(rows, { ...view, lenses: ['cpu-reduction', 'memory-reduction'] }, '').shown),
    ).toEqual(['web']);
    expect(names(listRows(rows, { ...view, filter: 'all', sort: 'name' }, '').shown)).toEqual([
      'api',
      'db',
      'idle',
      'web',
    ]);
  });

  it('count lenses among the rows shown, so a count is what picking the lens leaves', () => {
    const all = listRows(rows, view, '').lenses;
    expect(all['cpu-reduction']).toBe(2);
    expect(all['missing-data']).toBe(0); // the unchanged row is not on the "With changes" tab
    const narrowed = listRows(rows, { ...view, lenses: ['cpu-reduction'] }, '').lenses;
    expect(narrowed['cpu-reduction']).toBe(2);
    expect(narrowed['memory-reduction']).toBe(1);
    expect(narrowed['limit-raised']).toBe(0);
  });

  it('keep every row without lenses and never mutate the input', () => {
    const input = [...rows];
    expect(withLenses(input, [])).toEqual(input);
    expect(withLenses(input, [])).not.toBe(input);
    expect(
      names(withLenses([workload('old', { lenses: undefined as never })], ['increase'])),
    ).toEqual([]);
  });
});

describe('flag chips', () => {
  it('have one chip per code, the most severe first, raised limits left to the change cells', () => {
    const rec = workload('web', {}, [
      container('app', [
        { code: 'identity-by-name', detail: null },
        { code: 'cpu-limit-raised', detail: null },
        { code: 'oom-killed', detail: null },
      ]),
    ]);
    const flags = rowFlags(rec);
    expect(flags.map((f) => f.code)).toEqual(['oom-killed', 'identity-by-name']);
    expect(flags[0]).toMatchObject({ label: 'OOM-killed', tone: 'critical' });
    expect(flags[1]!.detail).toContain('tied to this workload by name');
  });

  it('name the containers in the tooltip when the workload has several', () => {
    const rec = workload('web', {}, [
      container('app', [{ code: 'cpu-throttled', detail: '12%' }]),
      container('proxy', [{ code: 'cpu-throttled', detail: '30%' }]),
    ]);
    const [flag] = rowFlags(rec);
    expect(flag).toMatchObject({ code: 'cpu-throttled', tone: 'warning', label: 'CPU throttled' });
    expect(flag!.detail.split('\n')).toEqual([
      'app: CPU was throttled in 12% of CFS periods; raise or remove the CPU limit.',
      'proxy: CPU was throttled in 30% of CFS periods; raise or remove the CPU limit.',
    ]);
  });

  it('keep unknown codes as they are', () => {
    expect(flagLabel('future-flag')).toBe('future-flag');
    expect(
      rowFlags(workload('web', {}, [container('app', [{ code: 'future-flag', detail: 'x' }])])),
    ).toEqual([{ code: 'future-flag', label: 'future-flag', detail: 'x', tone: 'neutral' }]);
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('toggles one key without shift or anchor', () => {
    expect([...toggleSelection(new Set(), order, 'b', null, false)]).toEqual(['b']);
    expect([...toggleSelection(new Set(['b']), order, 'b', 'a', false)]).toEqual([]);
    expect([...toggleSelection(new Set(), order, 'c', null, true)]).toEqual(['c']);
  });

  it('sets the range from the anchor with shift, to the new state of the key', () => {
    expect([...toggleSelection(new Set(['a']), order, 'd', 'b', true)].sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect([...toggleSelection(new Set(order), order, 'b', 'd', true)].sort()).toEqual(['a', 'e']);
    // An anchor no longer shown falls back to a single toggle.
    expect([...toggleSelection(new Set(), order, 'b', 'gone', true)]).toEqual(['b']);
  });

  it('select-all covers the keys shown and keeps other checks', () => {
    expect([...toggleAll(new Set(['x', 'a']), ['a', 'b'])].sort()).toEqual(['a', 'b', 'x']);
    expect([...toggleAll(new Set(['x', 'a', 'b']), ['a', 'b'])]).toEqual(['x']);
    expect([...toggleAll(new Set(['x']), [])]).toEqual(['x']);
  });

  it('prunes checks of rows that are gone, keeping the set when none is', () => {
    const selected = new Set(['a', 'b']);
    expect(pruneSelection(selected, new Set(['a', 'b', 'c']))).toBe(selected);
    expect([...pruneSelection(selected, new Set(['b']))]).toEqual(['b']);
  });
});
