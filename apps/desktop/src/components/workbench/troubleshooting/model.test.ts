import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import { diagnosePod, evidenceError, podReferences } from './model';

const pod = (status: object = {}, spec: object = {}): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { uid: 'pod-a', name: 'api-1', namespace: 'team' },
  spec: {
    containers: [
      { name: 'api', image: 'registry/api:v1', resources: { limits: { memory: '128Mi' } } },
    ],
    ...spec,
  },
  status: { phase: 'Running', ...status },
});
const event = (reason: string, message: string, uid = 'pod-a'): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Event',
  metadata: { uid: `${uid}/${reason}`, name: reason },
  involvedObject: { uid },
  reason,
  message,
  lastTimestamp: '2026-10-01T12:00:00Z',
});

describe('Pod diagnosis from observed evidence', () => {
  it('distinguishes active crash-loop state and the previous OOM termination', () => {
    const result = diagnosePod(
      pod({
        containerStatuses: [
          {
            name: 'api',
            restartCount: 5,
            state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off restarting api' } },
            lastState: {
              terminated: {
                reason: 'OOMKilled',
                exitCode: 137,
                finishedAt: '2026-10-01T11:59:00Z',
              },
            },
          },
        ],
      }),
      [],
    );
    expect(result.findings.map((finding) => finding.code)).toEqual(['crash-loop', 'oom-previous']);
    expect(result.findings[1]?.evidence).toContainEqual({ kind: 'memory-limit', value: '128Mi' });
    expect(result.findings[1]?.evidence[0]?.time).toBe('2026-10-01T11:59:00Z');
  });

  it('does not infer OOM from exit137 and does not infer current crash-loop from old BackOff events', () => {
    const result = diagnosePod(
      pod({
        containerStatuses: [
          {
            name: 'api',
            ready: true,
            state: { running: {} },
            lastState: { terminated: { reason: 'Error', exitCode: 137 } },
          },
        ],
      }),
      [event('BackOff', 'back-off restarting api')],
    );
    expect(result.findings).toEqual([]);
  });

  it('diagnoses init-container image pull failures without guessing registry credentials', () => {
    const result = diagnosePod(
      pod(
        {
          phase: 'Pending',
          initContainerStatuses: [
            {
              name: 'setup',
              state: { waiting: { reason: 'ImagePullBackOff', message: 'pull rejected' } },
            },
          ],
        },
        { initContainers: [{ name: 'setup', image: 'private/setup:missing' }] },
      ),
      [],
    );
    expect(
      result.findings.some(
        (finding) => finding.code === 'image-pull' && finding.container === 'setup',
      ),
    ).toBe(true);
    expect(result.findings.map((finding) => finding.code)).not.toContain('missing-config');
  });

  it('requires a negative scheduling condition before classifying a pending Pod as unscheduled', () => {
    expect(
      diagnosePod(
        pod({
          phase: 'Pending',
          conditions: [
            {
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: 'Insufficient memory',
            },
          ],
        }),
        [event('FailedScheduling', 'Insufficient memory')],
      ).findings[0]?.code,
    ).toBe('pending-scheduling');
    expect(
      diagnosePod(pod({ phase: 'Pending' }, { nodeName: 'node-1' }), []).findings[0]?.code,
    ).toBe('pending-startup');
  });

  it('reports missing configuration only from a current error or matching event evidence', () => {
    const refs = { volumes: [{ name: 'config', configMap: { name: 'app-config' } }] };
    expect(diagnosePod(pod({}, refs), []).findings).toEqual([]);
    const current = pod(
      {
        containerStatuses: [
          {
            name: 'api',
            state: {
              waiting: {
                reason: 'CreateContainerConfigError',
                message: 'configmap "app-config" not found',
              },
            },
          },
        ],
      },
      refs,
    );
    expect(diagnosePod(current, []).findings[0]?.code).toBe('missing-config');
    const warning = event('FailedMount', 'secret "credentials" not found');
    expect(diagnosePod(pod(), [warning]).findings).toEqual([]);
    expect(
      diagnosePod(pod({ phase: 'Pending' }), [warning]).findings.some(
        (finding) => finding.code === 'missing-config',
      ),
    ).toBe(true);
    expect(
      diagnosePod(pod({ phase: 'Pending' }), [
        event('FailedMount', 'secret "credentials" not found', 'another-pod'),
      ]).findings.some((finding) => finding.code === 'missing-config'),
    ).toBe(false);
  });

  it('collects only reference names including projected volumes, never environment values or Secret content', () => {
    const object = pod(
      {},
      {
        containers: [
          {
            name: 'api',
            env: [
              { name: 'PASSWORD', value: 'do-not-copy-this' },
              { name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'credentials', key: 'token' } } },
            ],
            envFrom: [{ configMapRef: { name: 'app-config' } }],
          },
        ],
        volumes: [
          {
            projected: {
              sources: [
                { secret: { name: 'credentials' } },
                { configMap: { name: 'projected-config' } },
              ],
            },
          },
          { persistentVolumeClaim: { claimName: 'data' } },
        ],
        nodeName: 'node-1',
        serviceAccountName: 'runner',
        imagePullSecrets: [{ name: 'registry' }],
      },
    );
    const refs = podReferences(object);
    expect(refs.filter((ref) => ref.kind === 'Secret' && ref.name === 'credentials')).toHaveLength(
      1,
    );
    expect(refs.some((ref) => ref.kind === 'Node' && ref.namespace === null)).toBe(true);
    expect(refs.some((ref) => ref.kind === 'ConfigMap' && ref.name === 'projected-config')).toBe(
      true,
    );
    expect(JSON.stringify(refs)).not.toContain('do-not-copy-this');
    expect(JSON.stringify(refs)).not.toContain('token');
  });

  it('distinguishes missing, denied, timeout and unknown evidence failures', () => {
    expect(evidenceError('403 Forbidden')).toBe('forbidden');
    expect(evidenceError('previous terminated container was not found')).toBe('missing');
    expect(evidenceError('request timed out')).toBe('timeout');
    expect(evidenceError('transport failed')).toBe('unavailable');
  });
});
