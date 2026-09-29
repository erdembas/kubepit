import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeFilter, Gvk, KubeObject, LogChunk, LogOptions } from '@/types';

// The stores and `lib/ipc` pull in window-bound modules (Vitest runs in the
// node environment), so they are replaced by small fakes.
const ipcMock = vi.hoisted(() => ({
  podLogsStream: vi.fn(),
  podLogsStop: vi.fn(async () => undefined),
  resourceList: vi.fn(),
  resourceGet: vi.fn(),
  resourceEvents: vi.fn(),
  changesList: vi.fn(),
  metricsPods: vi.fn(),
}));
const state = vi.hoisted(() => ({
  app: { clusters: [] as unknown[], statuses: {} as Record<string, unknown> },
  health: { scans: {} as Record<string, unknown> },
  alerts: { alerts: [] as unknown[] },
}));
vi.mock('@/lib/ipc', () => ({ ipc: ipcMock }));
vi.mock('@/store/useAppStore', () => ({ useAppStore: { getState: () => state.app } }));
vi.mock('@/store/useHealthStore', () => ({ useHealthStore: { getState: () => state.health } }));
vi.mock('@/store/useAlertStore', () => ({ useAlertStore: { getState: () => state.alerts } }));

import { collectPodLogs, gatherExplainContext } from './gather';

type Stream = (
  clusterId: string,
  namespace: string,
  pod: string,
  container: string | null,
  options: LogOptions,
  onChunk: (chunk: LogChunk) => void,
) => Promise<string>;

const POD_GVK: Gvk = { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true };
const DEPLOY_GVK: Gvk = {
  group: 'apps',
  version: 'v1',
  kind: 'Deployment',
  plural: 'deployments',
  namespaced: true,
};

/** A `web` pod in `shop` with an `app` and a `proxy` container; `app` restarts `restarts` times. */
function pod(name: string, restarts: number, ready = true): KubeObject {
  const status = (c: string, n: number) => ({
    name: c,
    image: `ghcr.io/acme/${c}:1`,
    ready,
    restartCount: n,
    state: { running: { startedAt: '2026-09-29T09:00:00Z' } },
    ...(n ? { lastState: { terminated: { reason: 'Error', exitCode: 1 } } } : {}),
  });
  return {
    apiVersion: 'v1',
    kind: 'Pod',
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
    },
    spec: {
      containers: [
        { name: 'app', image: 'ghcr.io/acme/app:1' },
        { name: 'proxy', image: 'ghcr.io/acme/proxy:1' },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [status('app', restarts), status('proxy', 0)],
    },
  };
}

const deployment: KubeObject = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'shop', uid: 'uid-web' },
  spec: { replicas: 3, selector: { matchLabels: { app: 'web' } } },
  status: { replicas: 3, updatedReplicas: 3, readyReplicas: 2, availableReplicas: 2 },
};

/** Streams `lines` in two chunks that split a line, then `done`. */
function streamOf(
  linesFor: (pod: string, container: string | null, previous: boolean) => string[],
): Stream {
  let n = 0;
  return async (_c, _ns, podName, container, options, onChunk) => {
    const id = `stream-${++n}`;
    const text = linesFor(podName, container, options.previous)
      .map((l) => `${l}\n`)
      .join('');
    const cut = Math.floor(text.length / 2);
    setTimeout(
      () => onChunk({ stream_id: id, data: text.slice(0, cut), done: false, error: null }),
      5,
    );
    setTimeout(
      () => onChunk({ stream_id: id, data: text.slice(cut), done: true, error: null }),
      10,
    );
    return id;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-29T10:00:00Z') });
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  ipcMock.podLogsStop.mockResolvedValue(undefined);
  state.app = {
    clusters: [{ id: 'c-dev', name: 'dev-shared', environment: 'development', read_only: false }],
    statuses: { 'c-dev': { version: 'v1.30.6', platform: 'AKS' } },
  };
  state.health = { scans: {} };
  state.alerts = { alerts: [] };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('collectPodLogs', () => {
  it('reads the last 500 lines with timestamps and splits chunks into lines', async () => {
    ipcMock.podLogsStream.mockImplementation(streamOf(() => ['one', 'two two', 'three']));
    const lines = collectPodLogs('c-dev', 'shop', 'web-1', 'app', true);
    await vi.advanceTimersByTimeAsync(20);
    expect(await lines).toEqual(['one', 'two two', 'three']);
    expect(ipcMock.podLogsStream.mock.calls[0]!.slice(0, 5)).toEqual([
      'c-dev',
      'shop',
      'web-1',
      'app',
      { follow: false, tail_lines: 500, since_seconds: null, timestamps: true, previous: true },
    ]);
    expect(ipcMock.podLogsStop).not.toHaveBeenCalled();
  });

  it('gives up after the timeout, keeps what arrived and stops the stream', async () => {
    ipcMock.podLogsStream.mockImplementation((async (_c, _n, _p, _ct, _o, onChunk) => {
      setTimeout(
        () => onChunk({ stream_id: 's', data: 'partial\nhalf', done: false, error: null }),
        5,
      );
      return 's';
    }) as Stream);
    const lines = collectPodLogs('c-dev', 'shop', 'web-1', 'app', false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await lines).toEqual(['partial', 'half']);
    expect(ipcMock.podLogsStop).toHaveBeenCalledWith('s');
  });

  it('stops the stream when aborted and keeps what arrived', async () => {
    ipcMock.podLogsStream.mockImplementation((async (_c, _n, _p, _ct, _o, onChunk) => {
      setTimeout(() => onChunk({ stream_id: 's', data: 'one\ntwo', done: false, error: null }), 5);
      return 's';
    }) as Stream);
    const controller = new AbortController();
    const lines = collectPodLogs('c-dev', 'shop', 'web-1', 'app', false, 10_000, controller.signal);
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    expect(await lines).toEqual(['one', 'two']);
    expect(ipcMock.podLogsStop).toHaveBeenCalledWith('s');
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await collectPodLogs('c-dev', 'shop', 'web-1', 'app', false, 10_000, aborted.signal),
    ).toEqual([]);
  });

  it('resolves empty when the stream cannot start', async () => {
    ipcMock.podLogsStream.mockRejectedValue(new Error('container is waiting to start'));
    const lines = collectPodLogs('c-dev', 'shop', 'web-1', 'app', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(await lines).toEqual([]);
  });
});

describe('gatherExplainContext', () => {
  it('gathers every section of a pod, with previous logs of restarted containers', async () => {
    const crashing = pod('web-1', 4, false);
    ipcMock.podLogsStream.mockImplementation(
      streamOf((p, c, previous) => [
        `INFO ${p} ${c} ${previous ? 'before' : 'now'} starting`,
        'ERROR boom',
      ]),
    );
    ipcMock.resourceEvents.mockResolvedValue([
      {
        apiVersion: 'v1',
        kind: 'Event',
        metadata: { name: 'e', namespace: 'shop', uid: 'e' },
        type: 'Warning',
        reason: 'BackOff',
        message: 'Back-off restarting failed container',
        involvedObject: { kind: 'Pod', name: 'web-1' },
      },
    ]);
    ipcMock.changesList.mockImplementation(async (_c: string, f: ChangeFilter) => ({
      entries:
        f.kinds.includes('Deployment') && f.name === 'web'
          ? [
              {
                id: 1,
                ts: Date.parse('2026-09-29T09:30:00Z'),
                cluster_id: 'c-dev',
                gvk: DEPLOY_GVK,
                namespace: 'shop',
                name: 'web',
                uid: 'uid-web',
                op: 'modified',
                actor: null,
                paths: [
                  {
                    path: 'spec.template.spec.containers[app].image',
                    before: 'a:1',
                    after: 'a:2',
                    redacted: false,
                  },
                ],
                path_count: 1,
                truncated: false,
              },
            ]
          : [],
      next_cursor: null,
      status: {},
    }));
    ipcMock.metricsPods.mockResolvedValue({
      available: true,
      items: [
        {
          namespace: 'shop',
          name: 'web-1',
          cpu_millicores: 10,
          memory_bytes: 2 ** 20,
          containers: [{ name: 'app', cpu_millicores: 10, memory_bytes: 2 ** 20 }],
        },
      ],
    });
    state.health = {
      scans: {
        'c-dev': {
          namespaces: [],
          computedAt: 0,
          byUid: new Map([
            [
              'uid-web-1',
              [
                {
                  id: 'f',
                  ruleId: 'pod-restarts',
                  severity: 'warning',
                  category: 'reliability',
                  ref: {
                    apiVersion: 'v1',
                    kind: 'Pod',
                    namespace: 'shop',
                    name: 'web-1',
                    uid: 'uid-web-1',
                  },
                  message: 'restarting',
                },
              ],
            ],
          ]),
        },
      },
    };
    state.alerts = {
      alerts: [
        {
          id: 'a',
          cluster_id: 'c-dev',
          severity: 'critical',
          reason: 'CrashLoopBackOff',
          object: { group: '', version: 'v1', kind: 'Pod', namespace: 'shop', name: 'web-1' },
          container: 'app',
          condition: null,
          message: 'back-off',
          first_seen: 0,
          last_seen: 1,
          count: 2,
          read: false,
          group: null,
        },
        {
          id: 'b',
          cluster_id: 'c-dev',
          severity: 'warning',
          reason: 'OOMKilled',
          object: { group: '', version: 'v1', kind: 'Pod', namespace: 'shop', name: 'other' },
          container: 'app',
          condition: null,
          message: 'exit code 137',
          first_seen: 0,
          last_seen: 1,
          count: 1,
          read: false,
          group: null,
        },
      ],
    };

    const gathered = gatherExplainContext('c-dev', POD_GVK, crashing);
    await vi.advanceTimersByTimeAsync(100);
    const sections = await gathered;
    const ids = sections.map((s) => s.id);
    expect(ids).toEqual([
      'scope',
      'object',
      'containers',
      'events',
      'logs:web-1/app',
      'logs:web-1/app@previous',
      'logs:web-1/proxy',
      'health',
      'changes',
      'alerts',
      'metrics',
    ]);
    expect(sections.find((s) => s.id === 'logs:web-1/app@previous')!.content).toContain('before');
    expect(sections.find((s) => s.id === 'alerts')!.content).not.toContain('other');
    // The pod's owner chain: its ReplicaSet and the Deployment behind it.
    const kinds = ipcMock.changesList.mock.calls.map((c) => (c[1] as ChangeFilter).kinds[0]);
    expect(kinds).toEqual(expect.arrayContaining(['Pod', 'ReplicaSet', 'Deployment']));
    expect((ipcMock.changesList.mock.calls[0]![1] as ChangeFilter).since).toBe(
      Date.parse('2026-09-29T10:00:00Z') - 24 * 3_600_000,
    );
  });

  it('explains a workload through its three worst pods and skips what fails', async () => {
    ipcMock.resourceList.mockResolvedValue({
      items: [pod('web-a', 0), pod('web-b', 9, false), pod('web-c', 1), pod('web-d', 3)],
      resource_version: '1',
    });
    ipcMock.podLogsStream.mockImplementation(streamOf(() => ['INFO ok']));
    ipcMock.resourceEvents.mockRejectedValue(new Error('forbidden'));
    ipcMock.changesList.mockRejectedValue(new Error('not recording'));
    ipcMock.metricsPods.mockResolvedValue({ available: false, items: [] });

    const gathered = gatherExplainContext('c-dev', DEPLOY_GVK, deployment);
    await vi.advanceTimersByTimeAsync(100);
    const sections = await gathered;
    expect(ipcMock.resourceList.mock.calls[0]!.slice(0, 4)).toEqual([
      'c-dev',
      POD_GVK,
      'shop',
      'app=web',
    ]);
    const containers = sections.find((s) => s.id === 'containers')!;
    expect(containers.label).toBe('pod/web-b, pod/web-d, pod/web-c');
    expect(sections.find((s) => s.id === 'scope')!.content).toContain('rollout:');
    expect(sections.map((s) => s.kind)).not.toContain('events');
    expect(sections.map((s) => s.kind)).not.toContain('metrics');
    expect(sections.filter((s) => s.kind === 'logs').map((s) => s.label)).toContain(
      'web-b/app@previous',
    );
    expect(sections.some((s) => s.label.startsWith('web-a/'))).toBe(false);
  });

  it('keeps only the pods of the Deployment itself (exact ReplicaSet name)', async () => {
    const other = pod('web-api-1', 7, false);
    other.metadata.ownerReferences = [
      {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        name: 'web-api-7c9d8b6f5',
        uid: 'rs2',
        controller: true,
      },
    ];
    ipcMock.resourceList.mockResolvedValue({
      items: [other, pod('web-a', 1)],
      resource_version: '1',
    });
    ipcMock.podLogsStream.mockImplementation(streamOf(() => ['INFO ok']));
    ipcMock.resourceEvents.mockResolvedValue([]);
    ipcMock.changesList.mockResolvedValue({ entries: [], next_cursor: null, status: {} });
    ipcMock.metricsPods.mockResolvedValue({ available: false, items: [] });
    const gathered = gatherExplainContext('c-dev', DEPLOY_GVK, deployment);
    await vi.advanceTimersByTimeAsync(100);
    const sections = await gathered;
    expect(sections.find((s) => s.id === 'containers')!.label).toBe('pod/web-a');
  });

  it('follows a CronJob to its Jobs and their pods', async () => {
    const cron: KubeObject = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'nightly', namespace: 'shop', uid: 'uid-cron' },
      spec: { schedule: '0 2 * * *', jobTemplate: { spec: {} } },
    };
    const job = (name: string, owner: string): KubeObject => ({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        namespace: 'shop',
        uid: `uid-${name}`,
        ownerReferences: [
          { apiVersion: 'batch/v1', kind: 'CronJob', name: owner, uid: 'c', controller: true },
        ],
      },
      spec: { selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': `uid-${name}` } } },
    });
    const jobPod = pod('nightly-1-abcde', 2, false);
    jobPod.metadata.ownerReferences = [
      {
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: 'nightly-1',
        uid: 'uid-nightly-1',
        controller: true,
      },
    ];
    ipcMock.resourceList.mockImplementation(
      async (_c: string, gvk: Gvk, _ns: string, selector?: string) =>
        gvk.kind === 'Job'
          ? {
              items: [job('nightly-1', 'nightly'), job('backup-1', 'backup')],
              resource_version: '1',
            }
          : {
              items: selector?.includes('uid-nightly-1') ? [jobPod] : [],
              resource_version: '1',
            },
    );
    ipcMock.podLogsStream.mockImplementation(streamOf(() => ['ERROR report failed']));
    ipcMock.resourceEvents.mockResolvedValue([]);
    ipcMock.changesList.mockResolvedValue({ entries: [], next_cursor: null, status: {} });
    ipcMock.metricsPods.mockResolvedValue({ available: false, items: [] });
    const gathered = gatherExplainContext(
      'c-dev',
      { group: 'batch', version: 'v1', kind: 'CronJob', plural: 'cronjobs', namespaced: true },
      cron,
    );
    await vi.advanceTimersByTimeAsync(100);
    const sections = await gathered;
    expect(sections.find((s) => s.id === 'containers')!.label).toBe('pod/nightly-1-abcde');
    expect(sections.some((s) => s.id === 'logs:nightly-1-abcde/app@previous')).toBe(true);
    const selectors = ipcMock.resourceList.mock.calls.map((c) => c[3]);
    expect(selectors).not.toContain('batch.kubernetes.io/controller-uid=uid-backup-1');
  });

  it('reads the logs of init containers that are still running', async () => {
    const initializing = pod('web-i', 0, false);
    initializing.spec.initContainers = [{ name: 'migrate', image: 'ghcr.io/acme/migrate:1' }];
    initializing.status.phase = 'Pending';
    initializing.status.initContainerStatuses = [
      { name: 'migrate', ready: false, restartCount: 0, state: { running: { startedAt: 'x' } } },
    ];
    initializing.status.containerStatuses = [
      {
        name: 'app',
        ready: false,
        restartCount: 0,
        state: { waiting: { reason: 'PodInitializing' } },
      },
      {
        name: 'proxy',
        ready: false,
        restartCount: 0,
        state: { waiting: { reason: 'PodInitializing' } },
      },
    ];
    ipcMock.podLogsStream.mockImplementation(streamOf((_p, c) => [`INFO ${c} migrating`]));
    ipcMock.resourceEvents.mockResolvedValue([]);
    ipcMock.changesList.mockResolvedValue({ entries: [], next_cursor: null, status: {} });
    ipcMock.metricsPods.mockResolvedValue({ available: false, items: [] });
    const gathered = gatherExplainContext('c-dev', POD_GVK, initializing);
    await vi.advanceTimersByTimeAsync(100);
    const sections = await gathered;
    expect(sections.map((s) => s.id)).toContain('logs:web-i/migrate');
  });

  it('skips the logs of pods on a NotReady node or in phase Unknown, and says so', async () => {
    const onDeadNode = pod('web-n', 3, false);
    onDeadNode.spec.nodeName = 'node-a';
    const unknown = pod('web-u', 1, false);
    unknown.status.phase = 'Unknown';
    ipcMock.resourceList.mockResolvedValue({ items: [onDeadNode, unknown], resource_version: '1' });
    ipcMock.resourceGet.mockResolvedValue({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: 'node-a', uid: 'n' },
      status: { conditions: [{ type: 'Ready', status: 'Unknown', reason: 'NodeStatusUnknown' }] },
    });
    ipcMock.podLogsStream.mockImplementation(streamOf(() => ['INFO ok']));
    ipcMock.resourceEvents.mockResolvedValue([]);
    ipcMock.changesList.mockResolvedValue({ entries: [], next_cursor: null, status: {} });
    ipcMock.metricsPods.mockResolvedValue({ available: false, items: [] });
    const gathered = gatherExplainContext('c-dev', DEPLOY_GVK, deployment);
    await vi.advanceTimersByTimeAsync(100);
    const sections = await gathered;
    expect(ipcMock.podLogsStream).not.toHaveBeenCalled();
    expect(sections.some((s) => s.kind === 'logs')).toBe(false);
    const containers = sections.find((s) => s.id === 'containers')!.content;
    expect(containers).toContain('logs not read: node node-a is not Ready');
    expect(containers).toContain('logs not read: pod phase is Unknown');
    expect(ipcMock.resourceGet.mock.calls[0]!.slice(2)).toEqual([null, 'node-a']);
  });

  it('reads all logs within one shared deadline', async () => {
    const busy = pod('web-1', 2, false);
    busy.spec.containers.push({ name: 'sidecar', image: 'x' });
    busy.status.containerStatuses.push({
      name: 'sidecar',
      ready: false,
      restartCount: 1,
      state: { running: {} },
    });
    busy.status.containerStatuses[1].restartCount = 1;
    // Streams that never finish: every job would wait for its own 10 s timeout.
    ipcMock.podLogsStream.mockImplementation((async (_c, _n, p, c) => `${p}/${c}`) as Stream);
    ipcMock.resourceEvents.mockResolvedValue([]);
    ipcMock.changesList.mockResolvedValue({ entries: [], next_cursor: null, status: {} });
    ipcMock.metricsPods.mockResolvedValue({ available: false, items: [] });
    let done = false;
    const gathered = gatherExplainContext('c-dev', POD_GVK, busy).then((s) => {
      done = true;
      return s;
    });
    await vi.advanceTimersByTimeAsync(11_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    await gathered;
    // Six jobs (three containers, current + previous), four at a time: the
    // last two start at 10 s with what is left of the shared 12 s.
    expect(ipcMock.podLogsStream).toHaveBeenCalledTimes(6);
    expect(ipcMock.podLogsStop).toHaveBeenCalledTimes(6);
  });

  it('stops everything when the caller aborts', async () => {
    ipcMock.podLogsStream.mockImplementation((async (_c, _n, p, c) => `${p}/${c}`) as Stream);
    ipcMock.resourceEvents.mockReturnValue(new Promise(() => {}));
    ipcMock.changesList.mockResolvedValue({ entries: [], next_cursor: null, status: {} });
    ipcMock.metricsPods.mockResolvedValue({ available: false, items: [] });
    const controller = new AbortController();
    const gathered = gatherExplainContext(
      'c-dev',
      POD_GVK,
      pod('web-1', 1, false),
      controller.signal,
    );
    const outcome = gathered.then(
      () => 'resolved',
      (e: unknown) => (e instanceof Error ? e.name : String(e)),
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe('AbortError');
    expect(ipcMock.podLogsStop).toHaveBeenCalled();
  });
});
