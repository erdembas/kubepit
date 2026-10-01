import { describe, expect, it } from 'vitest';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { getDb, put } from '@/lib/ipc/mock/fixtures/db';
import { getObject, patchObject } from '@/lib/ipc/mock/fixtures/ops';

describe('demo patch preconditions', () => {
  it('preserves stored data when a reviewed UID or version is stale', () => {
    const db = getDb('config-impact-preconditions');
    db.building = true;
    const gvk = toGvk(BUILTIN.ConfigMap);
    const original = put(db, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'config', namespace: 'app', uid: 'original' },
      data: { url: 'old' },
    });
    const version = original.metadata.resourceVersion!;
    for (const metadata of [{ uid: 'replacement' }, { resourceVersion: 'stale' }]) {
      expect(() =>
        patchObject(db, gvk, 'app', 'config', { metadata, data: { url: 'new' } }, 'merge'),
      ).toThrow('changed or was replaced');
      expect(getObject(db, gvk, 'app', 'config').data).toEqual({ url: 'old' });
      expect(getObject(db, gvk, 'app', 'config').metadata.resourceVersion).toBe(version);
    }
    const next = patchObject(
      db,
      gvk,
      'app',
      'config',
      { metadata: { uid: 'original', resourceVersion: version }, data: { url: 'new' } },
      'merge',
    );
    expect(next.data).toEqual({ url: 'new' });
    expect(next.metadata.resourceVersion).not.toBe(version);
    // Existing unconditioned edits remain supported by the mock API.
    expect(patchObject(db, gvk, 'app', 'config', { data: { mode: 'safe' } }, 'merge').data).toEqual(
      { url: 'new', mode: 'safe' },
    );
  });
});
