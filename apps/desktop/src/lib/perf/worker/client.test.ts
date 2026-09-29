import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTopology,
  DEFAULT_MAX_NODES,
  deriveView,
  type ViewOptions,
} from '@/lib/kube/topology';
import { topologyInputFor } from '@/lib/perf/fixtures';
import {
  EngineHost,
  SESSION_MISSING,
  type EngineRequest,
  type EngineResponse,
  type EngineTask,
  type TopologyDelta,
  type TopologyEngineResult,
} from './engine';

const VIEW: ViewOptions = {
  rootId: null,
  hops: 1,
  expanded: new Set(),
  hiddenKinds: new Set(),
  maxNodes: DEFAULT_MAX_NODES,
};

const input = topologyInputFor('s', 'ns-0001');

/** Everything in `input`, as the first delta of a session. */
const fullDelta: TopologyDelta = {
  scope: { namespaces: input.namespaces, apiResources: input.apiResources, extra: null },
  slots: input.lists.map((l, slot) => ({
    slot,
    gvk: l.gvk,
    synced: l.synced,
    replace: true,
    upserts: l.items,
    removes: [],
  })),
};

const topology = (session: number, graphRev = -1): EngineTask => ({
  kind: 'topology',
  session,
  view: VIEW,
  withGraph: true,
  graphRev,
  timed: false,
});

/** A stand-in for the module worker: answers like `engineWorker.ts` when told to. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: EngineResponse }) => void) | null = null;
  onerror: ((event: { preventDefault(): void; message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  inbox: EngineRequest[] = [];
  terminated = false;
  private host = new EngineHost();

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.all.push(this);
  }
  postMessage(message: EngineRequest) {
    this.inbox.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  answer() {
    for (const { id, task } of this.inbox.splice(0)) {
      try {
        const result = this.host.handle(task);
        if (id) this.onmessage?.({ data: { id, result } });
      } catch (error) {
        if (id) this.onmessage?.({ data: { id, error: (error as Error).message } });
      }
    }
  }
  crash() {
    this.onerror?.({ preventDefault() {}, message: 'boom' });
  }
}

async function freshClient() {
  vi.resetModules();
  return import('./client');
}

describe('engine client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeWorker.all = [];
  });

  it('inline fallback returns what the engine returns', async () => {
    const client = await freshClient();
    client.postEngine({ kind: 'topology-data', session: 1, delta: fullDelta });
    const result = await client.runEngine<TopologyEngineResult>(topology(1));
    const graph = buildTopology(input);
    expect(result.graph).toEqual(graph);
    expect(result.view).toEqual(deriveView(graph, VIEW));
    expect(client.engineRunning()).toBe(false);
  });

  it('applies deltas in order and sends the graph only when the caller lacks it', async () => {
    const client = await freshClient();
    client.postEngine({ kind: 'topology-data', session: 2, delta: fullDelta });
    const first = await client.runEngine<TopologyEngineResult>(topology(2));
    const again = await client.runEngine<TopologyEngineResult>(topology(2, first.graphRev));
    expect(again.graph).toBeUndefined();
    expect(again.graphRev).toBe(first.graphRev);
    const pods = input.lists.findIndex((l) => l.gvk.kind === 'Pod');
    const gone = input.lists[pods]!.items[0]!;
    client.postEngine({
      kind: 'topology-data',
      session: 2,
      delta: {
        slots: [
          {
            slot: pods,
            gvk: input.lists[pods]!.gvk,
            synced: true,
            replace: false,
            upserts: [],
            removes: [gone.metadata.uid],
          },
        ],
      },
    });
    const after = await client.runEngine<TopologyEngineResult>(topology(2, first.graphRev));
    expect(after.graphRev).toBe(first.graphRev + 1);
    expect(after.graph!.nodes.size).toBe(first.graph!.nodes.size - 1);
  });

  it('rejects a request for a session it does not hold', async () => {
    const client = await freshClient();
    await expect(client.runEngine(topology(99))).rejects.toThrow(SESSION_MISSING);
    client.postEngine({ kind: 'topology-data', session: 3, delta: fullDelta });
    client.postEngine({ kind: 'topology-dispose', session: 3 });
    await expect(client.runEngine(topology(3))).rejects.toThrow(SESSION_MISSING);
  });

  it('starts one module worker lazily and answers through it', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = await freshClient();
    expect(FakeWorker.all).toHaveLength(0);
    client.postEngine({ kind: 'topology-data', session: 1, delta: fullDelta });
    const pending = client.runEngine<TopologyEngineResult>(topology(1));
    expect(FakeWorker.all).toHaveLength(1);
    const worker = FakeWorker.all[0]!;
    expect(worker.url.pathname).toMatch(/engineWorker\.ts$/);
    expect(worker.options.type).toBe('module');
    expect(worker.inbox.map((m) => m.id)).toEqual([0, 1]);
    worker.answer();
    expect((await pending).view.nodes.length).toBeGreaterThan(0);
  });

  it('terminates the worker once idle and rejects what was pending', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const client = await freshClient();
    const release = client.acquireEngine();
    client.postEngine({ kind: 'topology-data', session: 1, delta: fullDelta });
    const generation = client.engineGeneration();
    const pending = client.runEngine(topology(1));
    release();
    release(); // a second call is harmless
    vi.advanceTimersByTime(client.IDLE_MS - 1);
    expect(FakeWorker.all[0]!.terminated).toBe(false);
    // Held again before the deadline: it lives on.
    const again = client.acquireEngine();
    vi.advanceTimersByTime(client.IDLE_MS * 2);
    expect(FakeWorker.all[0]!.terminated).toBe(false);
    again();
    vi.advanceTimersByTime(client.IDLE_MS);
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    expect(client.engineRunning()).toBe(false);
    expect(client.engineGeneration()).not.toBe(generation);
    await expect(pending).rejects.toBeInstanceOf(client.EngineLost);
    // The next task starts a new worker.
    client.postEngine({ kind: 'topology-data', session: 1, delta: fullDelta });
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('falls back inline when the worker fails', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = await freshClient();
    client.postEngine({ kind: 'topology-data', session: 1, delta: fullDelta });
    const pending = client.runEngine(topology(1));
    const generation = client.engineGeneration();
    FakeWorker.all[0]!.crash();
    await expect(pending).rejects.toBeInstanceOf(client.EngineLost);
    expect(client.engineGeneration()).not.toBe(generation);
    // The session is sent again, now to the inline engine.
    client.postEngine({ kind: 'topology-data', session: 1, delta: fullDelta });
    const result = await client.runEngine<TopologyEngineResult>(topology(1));
    expect(result.view).toEqual(deriveView(buildTopology(input), VIEW));
    expect(FakeWorker.all).toHaveLength(1);
  });
});
