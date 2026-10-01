import { describe, expect, it } from 'vitest';
import { getDb, put, type ClusterDb } from './db';
import { presetPoints, pvcUsageRows } from './prometheus';

const NOW = Date.UTC(2026, 9, 1, 12);

function claim(
  db: ClusterDb,
  name: string,
  namespace = 'data',
  capacity: string | null = '10Gi',
  phase = 'Bound',
) {
  return put(db, {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace, uid: `${namespace}/${name}`, resourceVersion: '1' },
    spec: { resources: { requests: { storage: '100Gi' } } },
    status: { phase, ...(capacity === null ? {} : { capacity: { storage: capacity } }) },
  });
}

describe('demo PVC usage', () => {
  it('returns five claims across namespaces, ranked by measured percentage', () => {
    const db = getDb('pvc-usage-ranked');
    for (let i = 0; i < 8; i++)
      claim(db, `claim-${i}`, i % 2 ? 'data' : 'monitoring', `${i + 1}Gi`);
    const rows = pvcUsageRows(db, NOW);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.namespace)).size).toBe(2);
    expect(rows.map((row) => row.used_percent)).toEqual(
      rows.map((row) => row.used_percent).sort((a, b) => b - a),
    );
    for (const row of rows) {
      const target = { kind: 'pvc', namespace: row.namespace, name: row.name } as const;
      expect(row.used_bytes).toBe(presetPoints(db, target, 'volume_usage', [NOW], 120)![0]![1]);
      expect(row.capacity_bytes).toBe(
        presetPoints(db, target, 'volume_capacity', [NOW], 120)![0]![1],
      );
      expect(row.used_percent).toBe((row.used_bytes / row.capacity_bytes) * 100);
    }
  });

  it('omits pending claims and missing or invalid measured capacities without using requests', () => {
    const db = getDb('pvc-usage-unmeasured');
    claim(db, 'pending', 'data', '10Gi', 'Pending');
    claim(db, 'missing-capacity', 'data', null);
    claim(db, 'invalid-capacity', 'data', 'invalid');
    claim(db, 'zero-capacity', 'data', '0');
    claim(db, 'negative-capacity', 'data', '-1Gi');
    expect(pvcUsageRows(db, NOW)).toEqual([]);
    expect(
      presetPoints(
        db,
        { kind: 'pvc', namespace: 'data', name: 'missing-claim' },
        'volume_usage',
        [NOW],
        120,
      ),
    ).toEqual([]);
    claim(db, 'measured', 'data', '2Gi');
    expect(pvcUsageRows(db, NOW)).toMatchObject([
      { name: 'measured', capacity_bytes: 2 * 1024 ** 3 },
    ]);
  });
});
