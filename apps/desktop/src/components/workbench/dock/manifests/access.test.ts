import { describe, expect, it } from 'vitest';
import type { ApiResourceInfo } from '@/types';
import { cellChecks, deniedKey, targetLock } from './access';
import { planApply, type Cell, type ReviewDoc, type ReviewTarget, type TargetRun } from './model';

const res = (
  group: string,
  version: string,
  kind: string,
  plural: string,
  namespaced: boolean,
): ApiResourceInfo => ({
  group,
  version,
  kind,
  plural,
  namespaced,
  api_version: group ? `${group}/${version}` : version,
  verbs: [],
  short_names: [],
  categories: [],
});
const api = [
  res('apps', 'v1', 'Deployment', 'deployments', true),
  res('', 'v1', 'Namespace', 'namespaces', false),
];
const doc = (kind: string, apiVersion: string, namespace: string | null): ReviewDoc => ({
  id: kind,
  source: 'a.yaml',
  line: 1,
  apiVersion,
  kind,
  name: 'x',
  namespace,
  yaml: '',
});
const target: ReviewTarget = {
  key: 'c1|shop',
  clusterId: 'c1',
  namespace: 'shop',
  readOnly: false,
  production: false,
};

describe('manifest apply access', () => {
  it('asks for patch, plus create for new objects, in the effective namespace', () => {
    expect(cellChecks(doc('Deployment', 'apps/v1', null), target, 'create', api)).toEqual([
      expect.objectContaining({
        verb: 'patch',
        resource: 'deployments',
        namespace: 'shop',
        name: 'x',
      }),
      expect.objectContaining({ verb: 'create', resource: 'deployments', namespace: 'shop' }),
    ]);
    expect(cellChecks(doc('Namespace', 'v1', null), target, 'update', api)).toEqual([
      expect.objectContaining({ verb: 'patch', resource: 'namespaces', namespace: null }),
    ]);
  });
  it('asks nothing for kinds discovery does not know', () => {
    expect(cellChecks(doc('Widget', 'example.com/v1', 'shop'), target, 'create', api)).toEqual([]);
  });
  it('planApply leaves denied cells out and counts them', () => {
    const docs = [doc('Deployment', 'apps/v1', null), doc('Namespace', 'v1', null)];
    const run = {
      status: 'done',
      cells: [{ badge: 'create' }, { badge: 'update' }],
    } as unknown as TargetRun;
    const plan = planApply(
      docs,
      [target],
      { [target.key]: run },
      new Set(['Deployment', 'Namespace']),
      new Set([target.key]),
      new Set([deniedKey(target.key, 0)]),
    );
    expect(plan.targets[0]?.indexes).toEqual([1]);
    expect(plan.denied).toBe(1);
    expect(plan.changes).toBe(1);
  });
  it('locks a target only when every selected change there is denied', () => {
    const docs = [doc('Deployment', 'apps/v1', null), doc('Namespace', 'v1', null)];
    const cells = [{ badge: 'create' }, { badge: 'unchanged' }] as unknown as Cell[];
    const check = cellChecks(docs[0]!, target, 'create', api)[1]!;
    const selected = new Set(['Deployment', 'Namespace']);
    expect(
      targetLock(docs, target, cells, selected, new Map([[deniedKey(target.key, 0), check]])),
    ).toBe(check);
    expect(targetLock(docs, target, cells, selected, new Map())).toBeNull();
    const both = [{ badge: 'create' }, { badge: 'update' }] as unknown as Cell[];
    expect(
      targetLock(docs, target, both, selected, new Map([[deniedKey(target.key, 0), check]])),
    ).toBeNull();
  });
});
