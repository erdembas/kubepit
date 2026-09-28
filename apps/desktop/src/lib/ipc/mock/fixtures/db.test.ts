import { describe, expect, it } from 'vitest';
import './build';
import { drop, find, getDb, ownedBy, put } from './db';

describe('demo db indexes', () => {
  it('find and ownedBy follow put and drop, in table order', () => {
    const db = getDb('c-scale-s');
    const dep = find(db, 'deployments.apps', 'ns-0001', 'app-0001-api')!;
    const sets = ownedBy(db, 'replicasets.apps', dep);
    expect(sets.map((r) => r.metadata.name)).toEqual([
      'app-0001-api-bs5r87rj9j',
      'app-0001-api-kbf2jnh5rf',
    ]);
    const current = sets[1]!;
    const pods = ownedBy(db, 'pods', current);
    expect(pods).toHaveLength(4);
    expect(find(db, 'pods', 'ns-0002', pods[0]!.metadata.name)).toBeUndefined();

    drop(db, pods[0]!);
    expect(find(db, 'pods', 'ns-0001', pods[0]!.metadata.name)).toBeUndefined();
    expect(ownedBy(db, 'pods', current)).toEqual(pods.slice(1));

    // Re-inserted at the end of its table, and of the indexes.
    put(db, pods[0]!);
    expect(find(db, 'pods', 'ns-0001', pods[0]!.metadata.name)).toBe(pods[0]);
    expect(ownedBy(db, 'pods', current)).toEqual([...pods.slice(1), pods[0]]);

    // Replacing an object with a new owner moves it between owners.
    const moved = { ...pods[1]!, metadata: { ...pods[1]!.metadata, ownerReferences: [] } };
    put(db, moved);
    expect(ownedBy(db, 'pods', current).map((p) => p.metadata.uid)).not.toContain(
      moved.metadata.uid,
    );
    expect(find(db, 'pods', 'ns-0001', moved.metadata.name)).toBe(moved);
  });
});
