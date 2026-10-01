import { describe, expect, it } from 'vitest';
import type { Investigation } from '@/types/investigations';
import {
  byteLength,
  MAX_BUNDLE_BYTES,
  parseInvestigationBundle,
  selectedEvidence,
  summary,
} from './bundle';

function sample(): Investigation {
  return {
    version: 1,
    id: 'sample',
    title: 'Checkout',
    notes: '',
    cluster_id: null,
    cluster_name: 'Production',
    target: { api_version: 'v1', kind: 'Pod', namespace: 'checkout', name: 'api-0' },
    captured_at: Date.now(),
    updated_at: Date.now(),
    imported: true,
    lookback_minutes: 15,
    evidence_count: 99,
    incomplete_count: 99,
    evidence: [
      {
        id: 'object',
        kind: 'object',
        label: 'Pod/api-0',
        format: 'yaml',
        status: 'captured',
        content: 'kind: Pod\n',
        reason: null,
      },
      {
        id: 'logs',
        kind: 'logs',
        label: 'api-0/app',
        format: 'text',
        status: 'unavailable',
        content: '',
        reason: 'forbidden',
      },
    ],
  };
}

describe('portable investigation validation', () => {
  it('derives source coverage from evidence rather than trusting imported counts', () => {
    const record = parseInvestigationBundle(JSON.stringify(sample()));
    expect(record.evidence_count).toBe(2);
    expect(record.incomplete_count).toBe(1);
    expect(summary(record)).not.toHaveProperty('evidence');
  });

  it('rejects unsupported versions, unknown fields and duplicate source ids', () => {
    expect(() => parseInvestigationBundle(JSON.stringify({ ...sample(), version: 2 }))).toThrow(
      'unsupported-version',
    );
    expect(() =>
      parseInvestigationBundle(JSON.stringify({ ...sample(), command: 'do not execute' })),
    ).toThrow('invalid-data');
    const record = sample();
    record.evidence[1]!.id = record.evidence[0]!.id;
    expect(() => parseInvestigationBundle(JSON.stringify(record))).toThrow('invalid-data');
  });

  it('rejects hidden content in unavailable evidence and excessive UTF-8 titles', () => {
    const record = sample();
    record.evidence[1]!.content = 'hidden log';
    expect(() => parseInvestigationBundle(JSON.stringify(record))).toThrow('invalid-data');
    record.evidence[1]!.content = '';
    record.title = 'ş'.repeat(101);
    expect(record.title.length).toBeLessThan(200);
    expect(byteLength(record.title)).toBeGreaterThan(200);
    expect(() => parseInvestigationBundle(JSON.stringify(record))).toThrow('invalid-data');
  });

  it('enforces the byte limit before parsing and selects only reviewed evidence', () => {
    expect(() => parseInvestigationBundle('x'.repeat(MAX_BUNDLE_BYTES + 1))).toThrow(
      'bundle-too-large',
    );
    const record = sample();
    expect(selectedEvidence(record, ['object']).map((entry) => entry.id)).toEqual(['object']);
    expect(() => selectedEvidence(record, ['unknown'])).toThrow('invalid-data');
    expect(() => selectedEvidence(record, [])).toThrow('invalid-data');
    expect(record.evidence).toHaveLength(2);
  });
});
