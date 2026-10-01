import { describe, expect, it } from 'vitest';
import type { ClusterDef } from '@/types';
import { demoDoctorReport } from './connectionDoctor';

function cluster(overrides: Partial<ClusterDef> = {}): ClusterDef {
  return {
    id: 'c-fixture',
    default_namespace: null,
    accessible_namespaces: ['team-a'],
    read_only: false,
    ...overrides,
  } as ClusterDef;
}

describe('demo connection doctor', () => {
  it('distinguishes Kubernetes permissions from local read-only restrictions', () => {
    const report = demoDoctorReport(cluster({ read_only: true }));
    expect(report.namespace).toBe('team-a');
    expect(report.capabilities.every((c) => c.allowed)).toBe(true);
    expect(report.capabilities.filter((c) => c.blocked_by_read_only).map((c) => c.id)).toEqual([
      'exec',
      'rollouts',
    ]);
    expect(report.steps.find((s) => s.stage === 'permissions')?.status).toBe('warning');
  });

  it('does not fabricate successful later stages when the fixture endpoint is unavailable', () => {
    const report = demoDoctorReport(cluster({ id: 'c-minikube' }));
    expect(report.steps).toHaveLength(7);
    expect(report.steps.find((s) => s.stage === 'network')?.code).toBe('tcp-failed');
    expect(report.steps.slice(3).every((s) => s.status === 'skipped')).toBe(true);
    expect(report.capabilities).toEqual([]);
    expect(report.metrics_api).toBe('unchecked');
  });

  it('keeps metrics installation separate from authorization', () => {
    const report = demoDoctorReport(cluster({ id: 'c-kind' }), 'default');
    expect(report.metrics_api).toBe('missing');
    expect(report.capabilities.find((c) => c.id === 'metrics')?.allowed).toBe(true);
  });

  it('validates namespace scope before synthetic checks', () => {
    const report = demoDoctorReport(cluster(), '../secrets');
    expect(report.steps[0]?.code).toBe('namespace-invalid');
    expect(report.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
  });
});
