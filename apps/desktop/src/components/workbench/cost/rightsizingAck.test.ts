import { afterEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import { acknowledgementText, applyBlockedReason, listText } from './rightsizingAck';

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
