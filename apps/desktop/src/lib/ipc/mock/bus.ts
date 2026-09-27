/** Tiny event bus standing in for Tauri's global events in browser previews. */
type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

export function mockEmit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((handler) => handler(payload));
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
