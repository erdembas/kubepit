import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Investigation, KubeObject } from '@/types';
import './fixtures/build';
import './investigations';
import { getDb, list } from './fixtures/db';
import { handlers, type MockHandler } from './registry';

const STORAGE = 'kubepit.demo.investigations.v1';
const originals = new Map<string, MockHandler | undefined>();

function stub(name: string, handler: MockHandler) {
  if (!originals.has(name)) originals.set(name, handlers[name]);
  handlers[name] = handler;
}

function sample(): Investigation {
  return {
    version: 1,
    id: 'fixture',
    title: 'Checkout incident',
    cluster_id: 'c-kind',
    cluster_name: 'Fixture',
    target: { api_version: 'v1', kind: 'Pod', namespace: 'checkout', name: 'api' },
    captured_at: Date.now(),
    updated_at: Date.now(),
    imported: false,
    evidence_count: 2,
    incomplete_count: 0,
    notes: '',
    lookback_minutes: 15,
    evidence: [
      {
        id: 'object',
        kind: 'object',
        label: 'Pod/api',
        status: 'captured',
        format: 'json',
        reason: null,
        content: JSON.stringify({
          kind: 'Pod',
          metadata: { annotations: { custom: 'annotation-secret' } },
          spec: { containers: [{ env: [{ name: 'NOT_OBVIOUS', value: 'env-secret' }] }] },
        }),
      },
      {
        id: 'logs',
        kind: 'logs',
        label: 'api/app',
        status: 'captured',
        format: 'text',
        reason: null,
        content: 'connection failed password=log-secret',
      },
    ],
  };
}

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  });
});

afterEach(() => {
  for (const [name, handler] of originals) {
    if (handler) handlers[name] = handler;
    else delete handlers[name];
  }
  originals.clear();
  vi.unstubAllGlobals();
});

describe('local demo investigation bundles', () => {
  it('redacts imports before persistence, keeps frozen evidence and exports only reviewed selections', async () => {
    const imported = (await handlers.investigation_import!({
      bundle: JSON.stringify(sample()),
    })) as Investigation;
    expect(imported.imported).toBe(true);
    expect(imported.cluster_id).toBeNull();
    expect(imported.id).not.toBe('fixture');
    const stored = localStorage.getItem(STORAGE)!;
    for (const secret of ['annotation-secret', 'env-secret', 'log-secret'])
      expect(stored).not.toContain(secret);
    const frozen = structuredClone(imported.evidence);
    const updated = (await handlers.investigation_update!({
      id: imported.id,
      title: 'Reviewed',
      notes: 'token=note-secret',
    })) as Investigation;
    expect(updated.evidence).toEqual(frozen);
    expect(updated.notes).not.toContain('note-secret');
    // Read again from persistence, without relying on the returned object.
    updated.title = 'Changed only in caller';
    const reopened = (await handlers.investigation_get!({ id: imported.id })) as Investigation;
    expect(reopened.title).toBe('Reviewed');
    const exported = JSON.parse(
      (await handlers.investigation_export!({
        id: imported.id,
        evidenceIds: ['object'],
      })) as string,
    ) as Investigation;
    expect(exported.evidence.map((e) => e.id)).toEqual(['object']);
    expect(exported.evidence_count).toBe(1);
    expect(exported.cluster_id).toBeNull();
    await expect(async () =>
      handlers.investigation_export!({ id: imported.id, evidenceIds: ['missing'] }),
    ).rejects.toThrow('investigations:invalid-data');
  });

  it('captures a read-only fixture workload with explicit missing-history evidence', async () => {
    const pod = structuredClone(list(getDb('c-kind'), 'pods')[0]!) as KubeObject;
    stub('cluster_statuses', () => ({ 'c-kind': { state: 'connected' } }));
    stub('cluster_list', () => [{ id: 'c-kind', name: 'Fixture', read_only: true }]);
    stub('resource_get', () => pod);
    stub('resource_events', () => []);
    stub('changes_list', () => ({ entries: [], status: { recording: false } }));
    stub('metrics_history', () => ({ points: [] }));
    const record = (await handlers.investigation_capture!({
      clusterId: 'c-kind',
      request: {
        gvk: { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true },
        namespace: pod.metadata.namespace,
        name: pod.metadata.name,
        title: 'Saved incident',
        lookback_minutes: 15,
      },
    })) as Investigation;
    expect(record.evidence.find((e) => e.kind === 'object')?.status).toBe('captured');
    expect(record.evidence.find((e) => e.kind === 'changes')).toMatchObject({
      status: 'unavailable',
      reason: 'not-recording',
    });
    expect(record.evidence.some((e) => e.kind === 'logs')).toBe(true);
    expect(record.incomplete_count).toBeGreaterThan(0);
    expect(
      (await handlers.investigations_list!({ clusterId: 'c-kind' })) as unknown[],
    ).toHaveLength(1);
  });

  it('preserves corrupt storage and rejects incompatible bundles without overwriting it', async () => {
    localStorage.setItem(STORAGE, '{bad');
    await expect(async () =>
      handlers.investigation_import!({ bundle: JSON.stringify(sample()) }),
    ).rejects.toThrow('investigations:invalid-data');
    expect(localStorage.getItem(STORAGE)).toBe('{bad');
    await expect(async () =>
      handlers.investigation_import!({ bundle: JSON.stringify({ ...sample(), version: 2 }) }),
    ).rejects.toThrow('investigations:unsupported-version');
    expect(localStorage.getItem(STORAGE)).toBe('{bad');
  });
});
