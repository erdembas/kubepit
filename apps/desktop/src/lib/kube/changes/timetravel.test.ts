import { describe, expect, it } from 'vitest';
import type { ChangeDetail, ChangeSummary, KubeObject } from '@/types';
import {
  fallbackCandidates,
  journalMirror,
  liveYaml,
  mergeOldestFirst,
  pickStateAt,
  resolveState,
  snapshotYaml,
} from './timetravel';

function entry(
  id: number,
  ts: number,
  op: 'added' | 'modified' | 'deleted',
  overrides: Partial<ChangeSummary> = {},
): ChangeSummary {
  return {
    id,
    ts,
    cluster_id: 'c',
    gvk: { group: 'apps', version: 'v1', kind: 'Deployment', plural: 'deployments', namespaced: true },
    namespace: 'web',
    name: 'shop',
    uid: 'u1',
    op,
    actor: null,
    paths: [],
    path_count: 0,
    truncated: false,
    ...overrides,
  };
}

const oldest = entry(1, 1_000, 'added');
const middle = entry(2, 2_000, 'modified');
const newest = entry(3, 3_000, 'modified');
const deleted = entry(4, 4_000, 'deleted');
const recreated = entry(5, 5_000, 'added');

describe('mergeOldestFirst', () => {
  it('merges history (older) with the journal, oldest first, tagged by source', () => {
    const merged = mergeOldestFirst([newest, middle], [oldest]);
    expect(merged.map((e) => [e.entry.id, e.source])).toEqual([
      [1, 'history'],
      [2, 'journal'],
      [3, 'journal'],
    ]);
  });
});

describe('pickStateAt', () => {
  const entries = mergeOldestFirst([recreated, deleted, newest, middle], []);

  it('picks the last entry at or before the time', () => {
    const pick = pickStateAt(entries, 2_500);
    expect(pick.kind).toBe('state');
    if (pick.kind !== 'state') return;
    expect(pick.picked.entry.id).toBe(2);
    expect(pick.next?.entry.id).toBe(3);
  });

  it('follows delete and re-create chains by timestamp', () => {
    expect(pickStateAt(entries, 4_500)).toMatchObject({
      kind: 'state',
      picked: { entry: { id: 4 } },
    });
    expect(pickStateAt(entries, 6_000)).toMatchObject({
      kind: 'state',
      picked: { entry: { id: 5 } },
      next: null,
    });
  });

  it('reports unknown before the first known entry', () => {
    const pick = pickStateAt(entries, 500);
    expect(pick).toEqual({ kind: 'unknown', at: 500, coverageStart: 2_000, hasEntries: true });
    expect(pickStateAt([], 500)).toEqual({
      kind: 'unknown',
      at: 500,
      coverageStart: null,
      hasEntries: false,
    });
  });
});

describe('fallbackCandidates', () => {
  it('offers up to three entries at or before the time, newest first', () => {
    const entries = mergeOldestFirst([newest, middle, oldest], []);
    expect(fallbackCandidates(entries, 3_000).map((e) => e.entry.id)).toEqual([3, 2, 1]);
    expect(fallbackCandidates(entries, 1_500).map((e) => e.entry.id)).toEqual([1]);
    expect(fallbackCandidates(entries, 500)).toEqual([]);
  });
});

describe('resolveState', () => {
  const detail = (omitted: boolean): ChangeDetail => ({
    summary: entry(9, 9, 'modified'),
    before_yaml: 'replicas: 2\n',
    after_yaml: 'replicas: 4\n',
    omitted,
  });

  it('walks back over entries stored without bodies', async () => {
    const seen: number[] = [];
    const entries = mergeOldestFirst([newest, middle, oldest], []);
    const resolved = await resolveState(fallbackCandidates(entries, 3_000), async (e) => {
      seen.push(e.entry.id);
      return e.entry.id === 3 ? detail(true) : e.entry.id === 2 ? null : detail(false);
    });
    expect(seen).toEqual([3, 2, 1]);
    expect(resolved).toMatchObject({ entry: { entry: { id: 1 } }, skippedOmitted: 1 });
  });

  it('returns null when nothing kept a body', async () => {
    const resolved = await resolveState(mergeOldestFirst([newest], []), async () => detail(true));
    expect(resolved).toBeNull();
  });
});

describe('canonical yaml of both sides', () => {
  const live: KubeObject = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'shop',
      namespace: 'web',
      uid: 'u1',
      resourceVersion: '99',
      generation: 3,
      creationTimestamp: '2026-01-01T00:00:00Z',
      labels: { app: 'shop', team: 'web' },
      annotations: {
        'deployment.kubernetes.io/revision': '7',
        'example.com/heartbeat': 'now',
        'owner.io/contact': 'sre',
      },
    },
    spec: { replicas: 4 },
    status: { readyReplicas: 4 },
  };

  it('mirrors the journal normalization on the live side', () => {
    const mirrored = journalMirror(live) as Record<string, unknown>;
    expect(mirrored.status).toBeUndefined();
    const meta = mirrored.metadata as Record<string, unknown>;
    expect(meta.uid).toBeUndefined();
    expect(meta.resourceVersion).toBeUndefined();
    expect(meta.creationTimestamp).toBeUndefined();
    const annotations = meta.annotations as Record<string, unknown>;
    expect(annotations['deployment.kubernetes.io/revision']).toBeUndefined();
    expect(annotations['example.com/heartbeat']).toBeUndefined();
    expect(annotations['owner.io/contact']).toBe('sre');
  });

  it('renders snapshot and live sides identically for the same intent', () => {
    // What the journal stored: sorted keys, bookkeeping dropped, creationTimestamp kept.
    const snapshot = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  annotations:',
      '    owner.io/contact: sre',
      '  creationTimestamp: "2026-01-01T00:00:00.000Z"',
      '  labels:',
      '    app: shop',
      '    team: web',
      '  name: shop',
      '  namespace: web',
      'spec:',
      '  replicas: 4',
    ].join('\n');
    expect(snapshotYaml(snapshot)).toBe(liveYaml(live));
  });

  it('canonicalizes secret and truncation markers on both sides', () => {
    const secretLive: KubeObject = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'db', uid: 's1' },
      data: { password: 'c3VwZXJzZWNyZXQ=' },
    };
    const secretSnapshot = [
      'apiVersion: v1',
      'data:',
      "  password: '<redacted #a1b2c3d4e5f6>'",
      'kind: Secret',
      'metadata:',
      '  name: db',
    ].join('\n');
    expect(liveYaml(secretLive)).toBe(snapshotYaml(secretSnapshot));
  });

  it('reduces nodes like the journal', () => {
    const node: KubeObject = {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: {
        name: 'node-1',
        uid: 'n1',
        creationTimestamp: '2026-01-01T00:00:00Z',
        labels: { zone: 'a' },
        annotations: { 'node.alpha.kubernetes.io/ttl': '0' },
      },
      spec: { providerID: 'aws://x' },
      status: { conditions: [] },
    };
    const mirrored = journalMirror(node) as Record<string, unknown>;
    expect(Object.keys(mirrored).sort()).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
    const meta = mirrored.metadata as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(['labels', 'name']);
  });

  it('returns empty string for unusable input', () => {
    expect(snapshotYaml(null)).toBe('');
    expect(snapshotYaml('just a string')).toBe('');
    expect(liveYaml(null)).toBe('');
  });
});
