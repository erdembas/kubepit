import { describe, expect, it } from 'vitest';
import { RIGHTSIZABLE_KINDS, isRightsizable, warningText, workloadGvk } from './model';

describe('warning texts', () => {
  it('translate every evidence flag and keep its detail as data', () => {
    const codes = [
      'identity-unclear',
      'insufficient-history',
      'low-coverage',
      'partial-data',
      'hpa-target',
      'hpa-utilization',
      'oom-killed',
      'cpu-throttled',
      'identity-by-name',
    ];
    for (const code of codes) {
      const text = warningText({ code, detail: null });
      expect(text, code).not.toBe(code);
      expect(text.length, code).toBeGreaterThan(20);
    }
    expect(warningText({ code: 'insufficient-history', detail: '10' })).toContain('10 hours');
    expect(warningText({ code: 'insufficient-history', detail: '1' })).toContain('1 hour of');
    expect(warningText({ code: 'low-coverage', detail: '89%' })).toContain('89%');
    expect(warningText({ code: 'hpa-target', detail: 'api' })).toContain('api');
    expect(warningText({ code: 'hpa-utilization', detail: 'cpu 70%' })).toContain('cpu 70%');
    expect(warningText({ code: 'cpu-throttled', detail: '12.5%' })).toContain('12.5%');
    // Codes of newer backends fall back to their detail.
    expect(warningText({ code: 'from-the-future', detail: 'detail' })).toBe('detail');
  });
});

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
