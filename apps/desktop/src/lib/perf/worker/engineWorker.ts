import { EngineHost, type EngineRequest, type EngineResponse } from './engine';

/**
 * The engine worker, started lazily by `client.ts` as a module worker. It
 * answers requests (`id > 0`) with `{ id, result }` or `{ id, error }`;
 * one-way tasks (`id = 0`) get no answer, and their errors are logged.
 */

// The app's lib is DOM, not WebWorker: type the worker scope by hand.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null;
  postMessage(message: EngineResponse): void;
};

const host = new EngineHost();

scope.onmessage = ({ data: { id, task } }) => {
  try {
    const result = host.handle(task);
    if (id) scope.postMessage({ id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (id) scope.postMessage({ id, error: message });
    else console.error('kubepit-engine:', error);
  }
};
