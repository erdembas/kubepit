import { describe, expect, it } from 'vitest';
import type { Finding } from '@/lib/kube/health/types';
import type {
  Alert,
  ChangeSummary,
  ClusterDef,
  ClusterStatus,
  KubeObject,
  PodMetric,
} from '@/types';
import {
  alertsSection,
  changesSection,
  containersSection,
  eventsSection,
  healthSection,
  logsSection,
  metricsSection,
  objectSection,
  scopeSection,
  worstPods,
} from './explain';

interface PodOptions {
  restarts?: number;
  ready?: boolean;
  waiting?: string;
  last?: { reason: string; exitCode: number };
}

/** A pod of the `web` Deployment in `shop` with one `app` container. */
function pod(name: string, o: PodOptions = {}): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    // `managedFields` is not in `ObjectMeta` (the backend strips it); the UI strips it too.
    metadata: {
      name,
      namespace: 'shop',
      uid: `uid-${name}`,
      labels: { app: 'web', 'pod-template-hash': '7c9d8b6f5' },
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          name: 'web-7c9d8b6f5',
          uid: 'rs',
          controller: true,
        },
      ],
      ...{ managedFields: [{ manager: 'kube-controller-manager' }] },
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': '{"secret":"hunter2"}',
        team: 'shop',
      },
    },
    spec: {
      nodeName: 'node-a',
      containers: [
        {
          name: 'app',
          image: 'ghcr.io/acme/web:1.2.3',
          resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { memory: '512Mi' } },
        },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: o.ready === false ? 'False' : 'True' }],
      containerStatuses: [
        {
          name: 'app',
          image: 'ghcr.io/acme/web:1.2.3',
          ready: o.ready !== false,
          restartCount: o.restarts ?? 0,
          state: o.waiting
            ? {
                waiting: {
                  reason: o.waiting,
                  message: 'back-off 5m0s restarting failed container',
                },
              }
            : { running: { startedAt: '2026-09-29T09:00:00Z' } },
          ...(o.last
            ? { lastState: { terminated: { ...o.last, finishedAt: '2026-09-29T08:59:00Z' } } }
            : {}),
        },
      ],
    },
  };
}

const oomPod = pod('web-1', { restarts: 7, last: { reason: 'OOMKilled', exitCode: 137 } });

function event(i: number, type: 'Normal' | 'Warning'): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: `e${i}`, namespace: 'shop', uid: `e${i}` },
    type,
    reason: type === 'Warning' ? 'BackOff' : 'Pulled',
    message: `message ${i}`,
    count: i + 1,
    lastTimestamp: new Date(Date.UTC(2026, 8, 29, 9, 0, i)).toISOString(),
    involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'shop' },
  };
}

describe('explain section builders', () => {
  it('lists Warning events first and caps at 50 rows', () => {
    const events = Array.from({ length: 80 }, (_, i) =>
      event(i, i % 4 === 0 ? 'Warning' : 'Normal'),
    );
    const section = eventsSection(events, 'pod/web-1')!;
    expect(section).toMatchObject({
      id: 'events',
      kind: 'events',
      label: 'pod/web-1',
      priority: 1,
    });
    const rows = section.content.split('\n').filter((l) => /\b(Warning|Normal)\b/.test(l));
    expect(rows).toHaveLength(50);
    expect(rows[0]).toContain('Warning');
    // Newest Warning first (event 76 is the last Warning).
    expect(rows[0]).toContain('message 76');
    expect(rows.slice(0, 20).every((r) => r.includes('Warning'))).toBe(true);
    expect(section.content).toContain('30 more events not shown');
    expect(eventsSection([], 'pod/web-1')).toBeNull();
  });

  it('strips managedFields and last-applied from the object section', () => {
    const section = objectSection(oomPod);
    expect(section).toMatchObject({
      id: 'object',
      kind: 'object',
      label: 'pod/web-1',
      format: 'yaml',
    });
    expect(section.content).not.toContain('managedFields');
    expect(section.content).not.toContain('last-applied-configuration');
    expect(section.content).toContain('team: shop');
    expect(section.content).toContain('restartCount: 7'); // status is kept
  });

  it('ranks the worst pods by restarts, then not-ready', () => {
    const pods = [
      pod('a', { restarts: 0 }),
      pod('b', { restarts: 5 }),
      pod('c', { restarts: 0, ready: false }),
      pod('d', { restarts: 5, ready: false }),
      pod('e', { restarts: 2 }),
    ];
    expect(worstPods(pods).map((p) => p.metadata.name)).toEqual(['d', 'b', 'e']);
    expect(worstPods(pods, 5).map((p) => p.metadata.name)).toEqual(['d', 'b', 'e', 'c', 'a']);
  });

  it('reports lastState OOMKilled with exit code 137', () => {
    const section = containersSection([oomPod])!;
    expect(section.content).toContain('OOMKilled (137)');
    expect(section.content).toContain('restarts=7');
    expect(section.content).toContain('ghcr.io/acme/web:1.2.3');
    expect(section.label).toBe('pod/web-1');
    const crash = containersSection([
      pod('web-2', { restarts: 3, ready: false, waiting: 'CrashLoopBackOff' }),
    ])!;
    expect(crash.content).toMatch(/app: waiting CrashLoopBackOff/);
    expect(containersSection([])).toBeNull();
  });

  it('uses identifier-only labels', () => {
    const logs = logsSection('web-1', 'app', true, ['x'])!;
    expect(logs).toMatchObject({
      id: 'logs:web-1/app@previous',
      kind: 'logs',
      label: 'web-1/app@previous',
      priority: 2,
      format: 'log',
    });
    expect(logsSection('web-1', 'app', false, ['x'])!.label).toBe('web-1/app');
    expect(logsSection('web-1', 'app', false, [])).toBeNull();
  });

  it('describes the scope with the cluster, version, namespace, object and rollout', () => {
    const cluster = {
      id: 'c-dev',
      name: 'dev-shared',
      environment: 'development',
      read_only: true,
    } as ClusterDef;
    const status = { version: 'v1.30.6', platform: 'AKS' } as ClusterStatus;
    const deployment: KubeObject = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'shop', uid: 'd', generation: 3 },
      spec: { replicas: 3 },
      status: {
        observedGeneration: 3,
        replicas: 3,
        updatedReplicas: 2,
        readyReplicas: 2,
        availableReplicas: 2,
      },
    };
    const section = scopeSection({ cluster, status, namespace: 'shop', obj: deployment });
    expect(section).toMatchObject({ id: 'scope', kind: 'scope', label: 'dev-shared', priority: 0 });
    for (const text of [
      'dev-shared',
      'development',
      'v1.30.6',
      'AKS',
      'namespace: shop',
      'Deployment shop/web',
      'read-only',
    ])
      expect(section.content).toContain(text);
    expect(section.content).toMatch(/rollout: \w+ desired=3 updated=2/);
  });

  it('lists health findings, changes, alerts and usage against requests and limits', () => {
    const finding: Finding = {
      id: 'f1',
      ruleId: 'pod-restarts',
      severity: 'warning',
      category: 'reliability',
      ref: { apiVersion: 'v1', kind: 'Pod', namespace: 'shop', name: 'web-1', uid: 'uid-web-1' },
      message: 'Container app restarted 7 times',
    };
    expect(healthSection([finding])!.content).toContain('warning  reliability  Pod shop/web-1');
    expect(healthSection([])).toBeNull();

    const change: ChangeSummary = {
      id: 1,
      ts: Date.UTC(2026, 8, 29, 8, 30),
      cluster_id: 'c-dev',
      gvk: {
        group: 'apps',
        version: 'v1',
        kind: 'Deployment',
        plural: 'deployments',
        namespaced: true,
      },
      namespace: 'shop',
      name: 'web',
      uid: 'd',
      op: 'modified',
      actor: { manager: 'helm', operation: 'Update', subresource: null },
      paths: [
        {
          path: 'spec.template.spec.containers[app].image',
          before: 'ghcr.io/acme/web:1.2.2',
          after: 'ghcr.io/acme/web:1.2.3',
          redacted: false,
        },
        { path: 'data["password"]', before: null, after: null, redacted: true },
      ],
      path_count: 3,
      truncated: false,
    };
    const changes = changesSection([change])!.content;
    expect(changes).toContain('2026-09-29T08:30:00Z modified Deployment shop/web by helm');
    expect(changes).toContain(
      'spec.template.spec.containers[app].image: ghcr.io/acme/web:1.2.2 → ghcr.io/acme/web:1.2.3',
    );
    expect(changes).toContain('data["password"]: (changed)');
    expect(changes).toContain('1 more path');

    const alert = {
      id: 'a',
      cluster_id: 'c-dev',
      severity: 'critical',
      reason: 'OOMKilled',
      object: { group: '', version: 'v1', kind: 'Pod', namespace: 'shop', name: 'web-1' },
      container: 'app',
      condition: null,
      message: 'exit code 137',
      first_seen: Date.UTC(2026, 8, 29, 8, 0),
      last_seen: Date.UTC(2026, 8, 29, 8, 50),
      count: 3,
      read: false,
      group: null,
    } as Alert;
    expect(alertsSection([alert])!.content).toContain(
      'critical OOMKilled Pod shop/web-1 container=app ×3',
    );

    const usage: PodMetric[] = [
      {
        namespace: 'shop',
        name: 'web-1',
        cpu_millicores: 120,
        memory_bytes: 480 * 2 ** 20,
        containers: [{ name: 'app', cpu_millicores: 120, memory_bytes: 480 * 2 ** 20 }],
      },
    ];
    const metrics = metricsSection([oomPod], usage)!;
    expect(metrics).toMatchObject({ id: 'metrics', priority: 4 });
    expect(metrics.content).toContain(
      'app: cpu 120m (request 250m, no limit) · memory 480Mi (request 256Mi, limit 512Mi)',
    );
    expect(metricsSection([oomPod], [])).toBeNull();
  });
});
