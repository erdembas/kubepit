import { EngineHost, type EngineRequest, type EngineResponse, type EngineTask } from './engine';

/**
 * Runs engine tasks (`engine.ts`) in a lazily created module worker, or
 * inline where there is no `Worker` (Node, tests) or it failed to start.
 *
 * The worker holds state (topology sessions), so callers hold the engine
 * while they use it (`acquireEngine`); it is terminated `IDLE_MS` after
 * the last release. Every time the engine loses its state (terminated,
 * failed, replaced by the inline fallback) {@link engineGeneration} changes
 * and pending requests reject with {@link EngineLost}: callers then send
 * their state again.
 */

/** How long an unused worker lives on (quick view switches reuse it). */
export const IDLE_MS = 10_000;

/** The engine lost its state before answering; send the session again. */
export class EngineLost extends Error {
  constructor(reason: string) {
    super(`kubepit-engine: ${reason}`);
    this.name = 'EngineLost';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
/** The worker could not start or crashed: run inline from now on. */
let workerFailed = false;
let inline: EngineHost | null = null;
let generation = 0;
let nextId = 1;
const pending = new Map<number, Pending>();
let users = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Changes whenever the engine's state is lost. */
export function engineGeneration(): number {
  return generation;
}

function lose(reason: string) {
  generation++;
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) p.reject(new EngineLost(reason));
}

function startWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  if (typeof Worker === 'undefined') {
    workerFailed = true;
    return null;
  }
  try {
    const w = new Worker(new URL('./engineWorker.ts', import.meta.url), {
      type: 'module',
      name: 'kubepit-engine',
    });
    w.onmessage = ({ data }: MessageEvent<EngineResponse>) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if ('error' in data) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    w.onerror = (event) => {
      event.preventDefault();
      console.error('kubepit-engine: the worker failed, running inline', event.message);
      fail();
    };
    w.onmessageerror = () => fail();
    worker = w;
    generation++;
    return w;
  } catch (error) {
    console.error('kubepit-engine: no worker, running inline', error);
    workerFailed = true;
    return null;
  }
}

function fail() {
  workerFailed = true;
  worker?.terminate();
  worker = null;
  lose('the worker failed');
}

/**
 * Runs `task` and resolves with its result. Inline, the task runs before
 * this returns (the promise is already settled), so tasks keep their order
 * either way.
 */
export function runEngine<T>(task: EngineTask): Promise<T> {
  const w = startWorker();
  if (w) {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      w.postMessage({ id, task } satisfies EngineRequest);
    });
  }
  try {
    return Promise.resolve((inline ??= new EngineHost()).handle(task) as T);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Sends a task that needs no answer (data, disposal); its errors are only logged. */
export function postEngine(task: EngineTask): void {
  const w = startWorker();
  if (w) {
    w.postMessage({ id: 0, task } satisfies EngineRequest);
    return;
  }
  try {
    (inline ??= new EngineHost()).handle(task);
  } catch (error) {
    console.error('kubepit-engine:', error);
  }
}

/** Holds the engine while it has state for the caller; call the result to release it. */
export function acquireEngine(): () => void {
  users++;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    users--;
    if (users === 0) idleTimer = setTimeout(stopEngine, IDLE_MS);
  };
}

/** Terminates the worker and drops every session (also once idle). */
export function stopEngine(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!worker && !inline) return;
  worker?.terminate();
  worker = null;
  inline = null;
  lose('the engine was stopped');
}

/** Whether a worker is running (tests, perf driver). */
export function engineRunning(): boolean {
  return worker !== null;
}
