import { describe, expect, it } from 'vitest';
import { scanHealth, type HealthKind } from '@/lib/kube/health';
import { emptyHealthInput } from '@/lib/kube/health/testing';
import type { KubeObject } from '@/types';
import { hasListIssue, isListLoaded, scanLists, type ListSnapshot } from './scanLists';

const ready = (items: KubeObject[] = []): ListSnapshot => ({
  items,
  synced: true,
  status: 'ready',
  error: null,
});
const forbiddenB = 'pods is forbidden: User "dev" cannot list resource "pods" in the namespace "b"';

describe('health list loading', () => {
  it('a list loads only when it synced without any error', () => {
    expect(isListLoaded(true, ready())).toBe(true);
    expect(isListLoaded(true, { ...ready(), error: forbiddenB })).toBe(false);
    expect(isListLoaded(true, { ...ready(), status: 'error', error: forbiddenB })).toBe(false);
    expect(isListLoaded(true, { ...ready(), synced: false, status: 'loading' })).toBe(false);
    expect(isListLoaded(false, { ...ready(), synced: false, status: 'idle' })).toBe(true);
  });
  it('partial and failed lists are reported as issues', () => {
    expect(hasListIssue(true, { ...ready(), error: forbiddenB })).toBe(true);
    expect(hasListIssue(true, { ...ready(), status: 'error', error: forbiddenB })).toBe(true);
    expect(hasListIssue(true, ready())).toBe(false);
    expect(hasListIssue(false, { ...ready(), error: forbiddenB })).toBe(false);
  });

  it('pods forbidden in one namespace skip secret-unused instead of flagging its secrets', () => {
    const secret = (name: string, namespace: string) =>
      ({
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'Opaque',
        metadata: { name, namespace, uid: `${namespace}-${name}` },
      }) as KubeObject;
    const podA = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web', namespace: 'a', uid: 'pod-a' },
      spec: {
        containers: [{ name: 'app', image: 'nginx:1' }],
        imagePullSecrets: [{ name: 'creds' }],
      },
    } as KubeObject;
    const kinds = [...emptyHealthInput().loaded];
    const snapsWith = (pods: ListSnapshot) => {
      const snaps = Object.fromEntries(kinds.map((k) => [k, ready()])) as Record<
        HealthKind,
        ListSnapshot
      >;
      snaps.pods = pods;
      snaps.secrets = ready([secret('creds', 'a'), secret('creds', 'b')]);
      return snaps;
    };
    const unused = (pods: ListSnapshot) => {
      const { lists, loaded } = scanLists(kinds, () => true, snapsWith(pods));
      return scanHealth({ ...lists, loaded, now: 0 })
        .findings.filter((f) => f.ruleId === 'secret-unused')
        .map((f) => `${f.ref.namespace}/${f.ref.name}`);
    };
    // Complete pods list: b's secret is really unused.
    expect(unused(ready([podA]))).toEqual(['b/creds']);
    // Pods of b could not be read: nothing is reported.
    expect(unused({ ...ready([podA]), error: forbiddenB })).toEqual([]);
  });
});
