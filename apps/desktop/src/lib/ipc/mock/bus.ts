/** Tiny event bus standing in for Tauri's global events in browser previews. */
type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

export function mockEmit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((handler) => handler(payload));
}

// Browser windows opened by the demo's `window_open` each run their own demo
// backend; app-wide events such as `workspace://changed` reach the others here.
const windows =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('kubepit-demo-events');
windows?.addEventListener('message', (message: MessageEvent<{ event: string; payload: unknown }>) =>
  mockEmit(message.data.event, message.data.payload),
);

/** Emit to this window and every other demo window. */
export function mockEmitAllWindows(event: string, payload: unknown) {
  mockEmit(event, payload);
  windows?.postMessage({ event, payload });
}

export function mockListen<T>(event: string, handler: (payload: T) => void) {
  const set = listeners.get(event) ?? new Set<Handler>();
  listeners.set(event, set);
  const wrapped = handler as Handler;
  set.add(wrapped);
  return Promise.resolve(() => {
    set.delete(wrapped);
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
