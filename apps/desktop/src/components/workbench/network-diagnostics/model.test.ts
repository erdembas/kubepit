import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import { runningContainers, servicePorts, validProbePath } from './model';

const object = (extra: Record<string, unknown>) =>
  ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'fixture' }, ...extra }) as KubeObject;

describe('network diagnostic input model', () => {
  it('offers only containers with a current running state', () => {
    const pod = object({
      status: {
        containerStatuses: [
          { name: 'app', state: { running: { startedAt: '2026-01-01' } } },
          { name: 'crashed', state: { waiting: { reason: 'CrashLoopBackOff' } } },
          { name: 'terminated', state: { terminated: { exitCode: 1 } } },
        ],
      },
    });
    expect(runningContainers(pod)).toEqual(['app']);
    expect(runningContainers(undefined)).toEqual([]);
  });
  it('only offers valid TCP service ports', () => {
    expect(
      servicePorts(
        object({
          spec: {
            ports: [
              { port: 80 },
              { port: 443, protocol: 'TCP' },
              { port: 53, protocol: 'UDP' },
              { port: 0 },
              { port: 70000 },
            ],
          },
        }),
      ),
    ).toEqual([80, 443]);
  });
  it('rejects injected URLs, query credentials, fragments and controls', () => {
    for (const path of [
      '//evil.test',
      'https://evil.test',
      '/?token=secret',
      '/#fragment',
      '/\n',
      '/\\host',
      '/two words',
    ])
      expect(validProbePath(path)).toBe(false);
    expect(validProbePath('/health/live')).toBe(true);
  });
});
