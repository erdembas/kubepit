import { afterEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import { changesOf } from '@/lib/kube/rightsizing/model';
import type { WorkloadRecommendation } from '@/types';
import { MiB, container, recommend, workload } from '../recommendations/testFixtures';
import {
  NO_ACK,
  acknowledgementKey,
  acknowledgementText,
  applyBlockedReason,
  applyControl,
  isAcknowledged,
  listText,
} from './rightsizingAck';

afterEach(() => i18n.setLocale('en', false));

describe('acknowledgementText', () => {
  it('names the flags the user reviewed', () => {
    expect(acknowledgementText(['CPU throttled'])).toBe('I reviewed: CPU throttled');
    expect(acknowledgementText(['OOM killed', 'Autoscaled', 'Low coverage'])).toBe(
      'I reviewed: OOM killed, Autoscaled, and Low coverage',
    );
    expect(acknowledgementText([])).toBe('I reviewed the changes');
  });

  it('lists in the UI language', () => {
    i18n.setLocale('tr', false);
    expect(listText(['A', 'B', 'C'])).toBe('A, B ve C');
  });
});

describe('applyBlockedReason', () => {
  const open = { gate: null, hasChanges: true, reviewFailed: false, unacknowledged: false };

  it('keeps Apply disabled until the acknowledgement is ticked', () => {
    expect(applyBlockedReason({ ...open, unacknowledged: true })).toBe(
      'Tick “I reviewed” to apply',
    );
    expect(applyBlockedReason(open)).toBeNull();
  });

  it('puts the gate (read-only, RBAC) and the dry run before the acknowledgement', () => {
    const all = {
      gate: 'Read-only cluster: changes are blocked',
      hasChanges: false,
      reviewFailed: true,
      unacknowledged: true,
    };
    expect(applyBlockedReason(all)).toBe('Read-only cluster: changes are blocked');
    expect(applyBlockedReason({ ...all, gate: null })).toBe('Nothing to change');
    expect(applyBlockedReason({ ...all, gate: null, hasChanges: true })).toBe(
      'Fix the dry-run error first',
    );
  });
});

/** A medium-confidence change of `app`, with the given flags. */
function rec(
  warnings: { code: string; detail: string | null }[],
  over: Partial<WorkloadRecommendation> = {},
  memory = 256 * MiB,
): WorkloadRecommendation {
  const app = recommend(container('app', [500, 512 * MiB], null, { warnings }), [800, memory]);
  return workload('web', [app], { confidence: 'medium', ...over });
}
const keyOf = (r: WorkloadRecommendation) => acknowledgementKey(r, changesOf(r));

describe('acknowledgementKey', () => {
  const oom = rec([{ code: 'oom-killed', detail: null }]);

  it('is the same for the same recommendation, in any language', () => {
    expect(keyOf(rec([{ code: 'oom-killed', detail: null }]))).toBe(keyOf(oom));
    i18n.setLocale('tr', false);
    expect(keyOf(oom)).toBe(acknowledgementKey(oom, changesOf(oom)));
  });

  it('changes with the flags, their details, the confidence and the changes', () => {
    const base = keyOf(oom);
    const more = rec([
      { code: 'oom-killed', detail: null },
      { code: 'cpu-throttled', detail: '12%' },
      { code: 'hpa-target', detail: 'web' },
    ]);
    expect(keyOf(more)).not.toBe(base);
    expect(keyOf(rec([{ code: 'cpu-throttled', detail: '30%' }]))).not.toBe(
      keyOf(rec([{ code: 'cpu-throttled', detail: '12%' }])),
    );
    expect(keyOf(rec([{ code: 'oom-killed', detail: null }], { confidence: 'low' }))).not.toBe(
      base,
    );
    expect(keyOf(rec([{ code: 'oom-killed', detail: null }], {}, 300 * MiB))).not.toBe(base);
    expect(acknowledgementKey(oom, [])).not.toBe(base);
  });
});

describe('applyControl', () => {
  const r = rec([{ code: 'oom-killed', detail: null }]);
  const key = keyOf(r);
  const ready = {
    gate: null,
    hasChanges: true,
    review: 'ready' as const,
    busy: false,
    requireAck: true,
    ack: NO_ACK,
    ackKey: key,
  };

  it('keeps Apply disabled until the tick is set for what is shown', () => {
    expect(applyControl(ready)).toEqual({ blocked: 'Tick “I reviewed” to apply', enabled: false });
    const ticked = { key, checked: true };
    expect(applyControl({ ...ready, ack: ticked })).toEqual({ blocked: null, enabled: true });
    expect(applyControl({ ...ready, ack: { key, checked: false } }).enabled).toBe(false);
  });

  it('drops a tick once the recommendation changed under it', () => {
    const ticked = { key, checked: true };
    const refreshed = rec([
      { code: 'oom-killed', detail: null },
      { code: 'cpu-throttled', detail: '12%' },
      { code: 'hpa-target', detail: 'web' },
    ]);
    expect(isAcknowledged(ticked, keyOf(refreshed))).toBe(false);
    expect(applyControl({ ...ready, ack: ticked, ackKey: keyOf(refreshed) })).toEqual({
      blocked: 'Tick “I reviewed” to apply',
      enabled: false,
    });
  });

  it('needs no tick at high confidence, but always a passed dry run and no busy apply', () => {
    expect(applyControl({ ...ready, requireAck: false }).enabled).toBe(true);
    expect(applyControl({ ...ready, requireAck: false, review: 'loading' }).enabled).toBe(false);
    expect(applyControl({ ...ready, requireAck: false, busy: true }).enabled).toBe(false);
    expect(applyControl({ ...ready, requireAck: false, review: 'error' })).toEqual({
      blocked: 'Fix the dry-run error first',
      enabled: false,
    });
    expect(
      applyControl({ ...ready, requireAck: false, gate: 'Read-only cluster: changes are blocked' }),
    ).toEqual({ blocked: 'Read-only cluster: changes are blocked', enabled: false });
  });
});
