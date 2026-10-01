import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { Investigation, InvestigationEvidence } from '@/types/investigations';
import {
  compareInvestigations,
  comparisonCandidates,
  sameInvestigationWorkload,
} from './comparison';

const target = { api_version: 'apps/v1', kind: 'Deployment', namespace: 'shop', name: 'api' };
const deployment = (replicas = 1, uid = 'deployment-uid') => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'api', namespace: 'shop', uid },
  spec: { replicas },
});
function evidence(
  kind: InvestigationEvidence['kind'],
  data: unknown,
  patch: Partial<InvestigationEvidence> = {},
): InvestigationEvidence {
  return {
    id: kind,
    kind,
    label: kind,
    status: 'captured',
    reason: null,
    format: 'yaml',
    content: YAML.stringify(data),
    ...patch,
  };
}
function record(
  id: string,
  captured_at: number,
  entries: InvestigationEvidence[] = [],
): Investigation {
  return {
    version: 1,
    id,
    captured_at,
    updated_at: captured_at,
    cluster_id: 'cluster-one',
    cluster_name: 'Production',
    target: { ...target },
    title: id,
    imported: false,
    evidence_count: 3 + entries.length,
    incomplete_count: 0,
    notes: '',
    lookback_minutes: 15,
    evidence: [
      evidence('object', deployment()),
      evidence('pods', []),
      evidence('events', []),
      ...entries,
    ],
  };
}
function withEvidence(
  source: Investigation,
  kind: InvestigationEvidence['kind'],
  value: InvestigationEvidence | null,
): Investigation {
  return {
    ...source,
    evidence: [
      ...source.evidence.filter((entry) => entry.kind !== kind),
      ...(value ? [value] : []),
    ],
  };
}
function pod(uid: string, restarts: number | undefined, state = 'running', ready = true) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { uid, name: 'api-0', namespace: 'shop' },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [
        {
          name: 'api',
          ready,
          ...(restarts === undefined ? {} : { restartCount: restarts }),
          state: { [state]: state === 'waiting' ? { reason: 'CrashLoopBackOff' } : {} },
        },
      ],
    },
  };
}
function event(uid: string, count = 1, message = 'Container restarted') {
  return {
    metadata: { uid, name: uid, namespace: 'shop' },
    type: 'Warning',
    reason: 'BackOff',
    message,
    count,
    involvedObject: { kind: 'Pod', namespace: 'shop', name: 'api-0', uid: 'pod-uid' },
    lastTimestamp: '2026-10-01T12:00:00Z',
  };
}

describe('offline investigation comparison', () => {
  it('requires saved cluster and workload identity rather than mutable cluster names', () => {
    const a = record('a', 100);
    const b = record('b', 200);
    expect(sameInvestigationWorkload(a, { ...b, cluster_name: 'Renamed cluster' })).toBe(true);
    for (const other of [
      { ...b, cluster_id: 'other' },
      { ...b, cluster_id: null },
      { ...b, target: { ...target, kind: 'StatefulSet' } },
      { ...b, target: { ...target, namespace: 'other' } },
      { ...b, target: { ...target, name: 'other' } },
      { ...b, target: { ...target, api_version: 'custom.example/v1' } },
    ]) {
      expect(sameInvestigationWorkload(a, other)).toBe(false);
      expect(() => compareInvestigations(a, other)).toThrow('comparison-identity');
    }
    expect(() => compareInvestigations(a, a)).toThrow('comparison-identity');
    expect(
      comparisonCandidates(a, [
        a,
        b,
        record('c', 300),
        { ...b, id: 'wrong', cluster_id: 'other' },
      ]).map((item) => item.id),
    ).toEqual(['c', 'b']);
  });

  it('sorts by capture time, not last note edit, and canonicalizes manifest key order without mutating evidence', () => {
    const a = record('a', 100);
    a.updated_at = 9999;
    const b = withEvidence(
      record('b', 200),
      'object',
      evidence('object', null, {
        format: 'json',
        content: JSON.stringify({
          spec: { replicas: 1 },
          metadata: { uid: 'deployment-uid', namespace: 'shop', name: 'api' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        }),
      }),
    );
    const originals = JSON.stringify([a, b]);
    const result = compareInvestigations(b, a);
    expect(result.earlier.id).toBe('a');
    expect(result.later.id).toBe('b');
    expect(result.manifest.before).toBe(result.manifest.after);
    expect(result.sameCaptureTime).toBe(false);
    expect(compareInvestigations(a, { ...b, captured_at: 100 }).sameCaptureTime).toBe(true);
    expect(JSON.stringify([a, b])).toBe(originals);
  });

  it('compares Pod state, readiness and restart counts only for the same UID/container', () => {
    const a = withEvidence(record('a', 100), 'pods', evidence('pods', [pod('pod-uid', 2)]));
    const b = withEvidence(
      record('b', 200),
      'pods',
      evidence('pods', [pod('pod-uid', 5, 'waiting', false)]),
    );
    const result = compareInvestigations(a, b);
    expect(result.pods.changes).toHaveLength(1);
    expect(result.pods.changes[0]?.containers[0]).toMatchObject({
      restartDelta: 3,
      counterReset: false,
      before: { state: 'running', ready: true },
      after: { state: 'waiting (CrashLoopBackOff)', ready: false },
    });
    const recreated = compareInvestigations(
      a,
      withEvidence(b, 'pods', evidence('pods', [pod('new-uid', 5)])),
    );
    expect(recreated.pods.recreatedNames).toEqual(['shop/api-0']);
    expect(recreated.pods.changes).toHaveLength(2);
    expect(
      recreated.pods.changes.every((entry) =>
        entry.containers.every((container) => container.restartDelta === null),
      ),
    ).toBe(true);
  });

  it('does not turn missing restart counters or counter resets into zero/negative restart totals', () => {
    const a = withEvidence(record('a', 100), 'pods', evidence('pods', [pod('pod-uid', 10)]));
    const missing = withEvidence(
      record('b', 200),
      'pods',
      evidence('pods', [pod('pod-uid', undefined)]),
    );
    expect(compareInvestigations(a, missing).pods.changes[0]?.containers[0]).toMatchObject({
      restartDelta: null,
      counterReset: false,
      after: { restarts: null },
    });
    const reset = withEvidence(missing, 'pods', evidence('pods', [pod('pod-uid', 1)]));
    expect(compareInvestigations(a, reset).pods.changes[0]?.containers[0]).toMatchObject({
      restartDelta: null,
      counterReset: true,
    });
  });

  it('preserves equal-time observations without inferring additional restarts or counter resets in either direction', () => {
    const a = withEvidence(record('a', 100), 'pods', evidence('pods', [pod('pod-uid', 2)]));
    const b = withEvidence(
      record('b', 100),
      'pods',
      evidence('pods', [pod('pod-uid', 5, 'waiting', false)]),
    );
    for (const [left, right] of [
      [a, b],
      [b, a],
    ] as const) {
      const result = compareInvestigations(left, right);
      expect(result.sameCaptureTime).toBe(true);
      expect(result.pods.changes[0]?.containers[0]).toMatchObject({
        restartDelta: null,
        counterReset: false,
      });
      expect(result.pods.changes[0]?.before).not.toEqual(result.pods.changes[0]?.after);
    }
    expect(compareInvestigations(a, b).pods.changes[0]?.containers[0]).toMatchObject({
      before: { restarts: 2, state: 'running' },
      after: { restarts: 5, state: 'waiting (CrashLoopBackOff)' },
    });
  });

  it('deduplicates event UIDs and distinguishes new/missing observations from changed repeated events', () => {
    const a = withEvidence(
      record('a', 100),
      'events',
      evidence('events', [event('old'), event('repeat', 1)]),
    );
    a.evidence.push(evidence('events', [event('repeat', 1)], { id: 'events-pod' }));
    const b = withEvidence(
      record('b', 200),
      'events',
      evidence('events', [event('new'), event('repeat', 4)]),
    );
    b.lookback_minutes = 60;
    const result = compareInvestigations(a, b);
    expect(result.events.removed.map((item) => item.uid)).toEqual(['old']);
    expect(result.events.added.map((item) => item.uid)).toEqual(['new']);
    expect(result.events.changed).toMatchObject([
      { before: { uid: 'repeat', count: 1 }, after: { uid: 'repeat', count: 4 } },
    ]);
    expect(result.events.beforeCoverage.state).toBe('complete');
    expect(result.earlier.lookback_minutes).toBe(15);
    expect(result.later.lookback_minutes).toBe(60);
  });

  it('retains missing, forbidden, truncated and malformed evidence coverage instead of substituting empty manifests', () => {
    const a = record('a', 100);
    const b = withEvidence(record('b', 200), 'object', null);
    expect(compareInvestigations(a, b).manifest).toMatchObject({
      after: null,
      afterCoverage: { state: 'unavailable', issues: ['missing'] },
    });
    const forbidden = withEvidence(
      b,
      'object',
      evidence('object', null, {
        status: 'unavailable',
        reason: 'forbidden',
        format: 'text',
        content: '',
      }),
    );
    expect(compareInvestigations(a, forbidden).manifest.afterCoverage).toMatchObject({
      state: 'unavailable',
      issues: ['unavailable'],
    });
    const partial = withEvidence(
      a,
      'pods',
      evidence('pods', [pod('pod-uid', 1)], { status: 'truncated', reason: 'capture-limit' }),
    );
    expect(compareInvestigations(partial, b).pods.beforeCoverage).toMatchObject({
      state: 'partial',
      issues: ['truncated'],
    });
    const malformed = withEvidence(
      b,
      'events',
      evidence('events', null, {
        content: '[broken',
        status: 'truncated',
        reason: 'capture-limit',
      }),
    );
    expect(compareInvestigations(a, malformed).events.afterCoverage).toMatchObject({
      state: 'unavailable',
      issues: ['truncated', 'invalid'],
    });
    const wrongObject = withEvidence(
      b,
      'object',
      evidence('object', { ...deployment(), metadata: { name: 'different', namespace: 'shop' } }),
    );
    expect(compareInvestigations(a, wrongObject).manifest.after).toBeNull();
  });

  it('flags workload recreation and rejects identity-free or excessively nested imported observations safely', () => {
    const a = record('a', 100);
    const b = withEvidence(
      record('b', 200),
      'object',
      evidence('object', deployment(2, 'new-instance')),
    );
    expect(compareInvestigations(a, b).workloadRecreated).toBe(true);
    const invalidPods = withEvidence(
      b,
      'pods',
      evidence('pods', [{ metadata: { name: 'api-0' } }]),
    );
    expect(compareInvestigations(a, invalidPods).pods.afterCoverage).toMatchObject({
      state: 'unavailable',
      issues: ['invalid'],
    });
    const nested = withEvidence(
      b,
      'object',
      evidence('object', null, { format: 'json', content: '['.repeat(50) + '{}' + ']'.repeat(50) }),
    );
    expect(compareInvestigations(a, nested).manifest.after).toBeNull();
    const cycle = withEvidence(b, 'pods', evidence('pods', null, { content: '&root [*root]' }));
    expect(compareInvestigations(a, cycle).pods.afterCoverage.state).toBe('unavailable');
  });

  it('bounds imported observation counts and excludes Pods from another namespace', () => {
    const a = record('a', 100);
    const pods = Array.from({ length: 201 }, (_, index) => ({
      metadata: { uid: `uid-${index}`, name: `pod-${index}`, namespace: 'shop' },
    }));
    const b = withEvidence(record('b', 200), 'pods', evidence('pods', pods));
    const result = compareInvestigations(a, b);
    expect(result.pods.changes).toHaveLength(200);
    expect(result.pods.afterCoverage).toMatchObject({ state: 'partial', issues: ['limit'] });
    const unrelated = withEvidence(
      b,
      'pods',
      evidence('pods', [{ metadata: { uid: 'other', name: 'api-0', namespace: 'other' } }]),
    );
    expect(compareInvestigations(a, unrelated).pods.afterCoverage.state).toBe('unavailable');
  });
});
