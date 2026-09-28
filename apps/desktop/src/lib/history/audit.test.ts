import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@/types';
import { actionLabel, actionTone, AUDIT_ACTIONS, requestSummary } from './audit';

const entry = (request: Record<string, unknown> | null): AuditEntry => ({
  id: 1,
  ts: 0,
  cluster_id: 'c',
  cluster_name: 'c',
  context: 'c',
  identity: null,
  action: 'custom-action',
  dry_run: false,
  outcome: 'ok',
  error: null,
  duration_ms: 1,
  targets: [],
  request,
  result: 'exit 0',
  has_diff: false,
  revertible: false,
});

describe('custom action audit entries', () => {
  it('are filterable, labelled and weighted like a patch', () => {
    expect(AUDIT_ACTIONS).toContain('custom-action');
    expect(actionLabel('custom-action')).toBe('Custom action');
    expect(actionTone('custom-action')).toBe(actionTone('patch'));
  });

  it('summarize the action name verbatim', () => {
    const request = { action: 'Annotate', id: 'a', mode: 'background', command: 'x', targets: 1 };
    expect(requestSummary(entry(request))).toBe('Annotate');
    expect(requestSummary(entry(null))).toBeNull();
  });
});
