import { describe, expect, it } from 'vitest';
import { RIGHTSIZABLE_KINDS, isRightsizable, workloadGvk } from './model';

describe('right-sizable kinds', () => {
  it('cover CronJobs next to the apps workloads', () => {
    expect([...RIGHTSIZABLE_KINDS]).toEqual(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob']);
    expect(isRightsizable('CronJob')).toBe(true);
    expect(isRightsizable('Job')).toBe(false);
    expect(isRightsizable('Pod')).toBe(false);
  });

  it('address each kind in its API group', () => {
    expect(workloadGvk('CronJob')).toEqual({
      group: 'batch',
      version: 'v1',
      kind: 'CronJob',
      plural: 'cronjobs',
      namespaced: true,
    });
    expect(workloadGvk('StatefulSet')).toEqual({
      group: 'apps',
      version: 'v1',
      kind: 'StatefulSet',
      plural: 'statefulsets',
      namespaced: true,
    });
    expect(workloadGvk('Deployment').plural).toBe('deployments');
    expect(workloadGvk('DaemonSet').plural).toBe('daemonsets');
  });
});
