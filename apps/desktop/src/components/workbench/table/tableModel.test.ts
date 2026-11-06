import { describe, expect, it } from 'vitest';
import { podColumns } from '@/lib/kube/columns/pods';
import type { KindColumns } from '@/lib/kube/columns';
import type { KubeObject } from '@/types';
import {
  facetCounts,
  facetSelection,
  filterItems,
  parseFilter,
  quoteFacetValue,
  splitFacetValues,
  withFacet,
} from './tableModel';

const obj = (name: string, phase: string, extra: Partial<KubeObject> = {}): KubeObject =>
  ({
    apiVersion: 'v1',
    kind: 'Thing',
    metadata: { name, namespace: 'ns', uid: name, labels: { app: name } },
    status: { phase },
    ...extra,
  }) as KubeObject;

const phaseOf = (o: KubeObject) => String((o as { status?: { phase?: string } }).status?.phase);

const kind: KindColumns = {
  columns: [
    { id: 'name', label: () => 'Name', width: '1fr', cell: () => null },
    {
      id: 'status',
      label: () => 'Status',
      width: '1fr',
      cell: () => null,
      facet: phaseOf,
    },
    {
      id: 'conditions',
      label: () => 'Conditions',
      width: '1fr',
      cell: () => null,
      facet: (o) => (phaseOf(o) === 'Ready' ? ['Ready', 'Has Space'] : ['NotReady']),
    },
  ],
};

const items = [
  obj('a', 'Running'),
  obj('b', 'Pending'),
  obj('c', 'Running'),
  obj('d', 'Ready'),
  obj('e', 'Ready,SchedulingDisabled'),
];
const names = (list: KubeObject[]) => list.map((o) => o.metadata.name);

describe('facet values', () => {
  it('splits commas and keeps quoted values whole', () => {
    expect(splitFacetValues('Running,Pending')).toEqual(['Running', 'Pending']);
    expect(splitFacetValues('"Ready,SchedulingDisabled",NotReady')).toEqual([
      'Ready,SchedulingDisabled',
      'NotReady',
    ]);
    expect(splitFacetValues('"Has Space')).toEqual(['Has Space']);
    expect(splitFacetValues('')).toEqual([]);
  });

  it('quotes only what would split the token', () => {
    expect(quoteFacetValue('CrashLoopBackOff')).toBe('CrashLoopBackOff');
    expect(quoteFacetValue('Init:0/1')).toBe('Init:0/1');
    expect(quoteFacetValue('Ready,SchedulingDisabled')).toBe('"Ready,SchedulingDisabled"');
    expect(quoteFacetValue('Has Space')).toBe('"Has Space"');
  });
});

describe('parseFilter', () => {
  it('treats only facet column ids as facet keys', () => {
    const { facets, terms } = parseFilter('status:Running init:0/1 fe80::1 app=a', kind);
    expect(facets.map((f) => [f.column.id, [...f.values]])).toEqual([['status', ['running']]]);
    expect(terms).toEqual(['init:0/1', 'fe80::1', 'app=a']);
  });

  it('merges repeated keys and ignores an empty pick', () => {
    expect(parseFilter('status:Running STATUS:pending', kind).facets[0]!.values).toEqual(
      new Set(['running', 'pending']),
    );
    expect(parseFilter('status:', kind).facets).toEqual([]);
  });
});

describe('filterItems with facets', () => {
  it('matches any picked value, case-insensitively', () => {
    expect(names(filterItems(items, 'status:running', kind))).toEqual(['a', 'c']);
    expect(names(filterItems(items, 'status:Running,Pending', kind))).toEqual(['a', 'b', 'c']);
  });

  it('matches quoted values with commas exactly', () => {
    expect(names(filterItems(items, 'status:"Ready,SchedulingDisabled"', kind))).toEqual(['e']);
    expect(names(filterItems(items, 'status:Ready', kind))).toEqual(['d']);
  });

  it('matches multi-valued facets on any value', () => {
    expect(names(filterItems(items, 'conditions:"Has Space"', kind))).toEqual(['d']);
    expect(names(filterItems(items, 'conditions:NotReady', kind))).toEqual(['a', 'b', 'c', 'e']);
  });

  it('combines facets with text and labels', () => {
    expect(names(filterItems(items, 'status:Running app=c', kind))).toEqual(['c']);
    expect(names(filterItems(items, 'b status:Pending', kind))).toEqual(['b']);
    expect(names(filterItems(items, 'status:Running status:Pending', kind))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps plain text search and quoted phrases working', () => {
    expect(names(filterItems(items, 'ns', kind))).toEqual(names(items));
    expect(names(filterItems(items, '"a ns"', kind))).toEqual(['a']);
  });

  it('filters pods by their displayed status', () => {
    const crashing = obj('crash', 'Running', {
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CrashLoopBackOff' } } }],
      },
    });
    const running = obj('ok', 'Running', {
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }],
      },
    });
    expect(names(filterItems([crashing, running], 'status:CrashLoopBackOff', podColumns))).toEqual([
      'crash',
    ]);
  });
});

describe('editing the filter text', () => {
  it('reads the picked values as written', () => {
    expect(facetSelection('x status:Running,"Has Space" status:running', kind, 'status')).toEqual([
      'Running',
      'Has Space',
    ]);
    expect(facetSelection('conditions:Ready', kind, 'status')).toEqual([]);
  });

  it('replaces only the facet token', () => {
    expect(withFacet('app=a status:Running', kind, 'status', ['Pending', 'Ready,X'])).toBe(
      'app=a status:Pending,"Ready,X"',
    );
    expect(withFacet('status:Running app=a', kind, 'status', [])).toBe('app=a');
    expect(withFacet('', kind, 'status', ['Running'])).toBe('status:Running');
    expect(withFacet('init:0/1', kind, 'status', ['Running'])).toBe('init:0/1 status:Running');
  });
});

describe('facetCounts', () => {
  it('counts each value once per item, most common first', () => {
    const column = kind.columns[1]!;
    expect(facetCounts(items, column)).toEqual([
      { value: 'Running', count: 2 },
      { value: 'Pending', count: 1 },
      { value: 'Ready', count: 1 },
      { value: 'Ready,SchedulingDisabled', count: 1 },
    ]);
    expect(facetCounts(items, kind.columns[0]!)).toEqual([]);
  });
});
