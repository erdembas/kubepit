import { Channel, invoke } from '@tauri-apps/api/core';

/**
 * True inside the Tauri webview. `pnpm dev:ui` runs the same React tree in
 * a plain browser tab; there every command is served by the in-memory demo
 * backend in `./mock` so the UI can be developed and reviewed without a
 * cluster or a native build.
 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as object);

export type Emit<T> = (message: T) => void;

// The demo backend is only ever loaded in browser previews, so it stays out of
// the code the desktop app executes (Vite splits it into its own chunk).
let mockModule: Promise<typeof import('./mock')> | null = null;
const mock = () => (mockModule ??= import('./mock'));

export function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) return invoke<T>(command, args);
  return mock().then((m) => m.mockInvoke<T>(command, args));
}

/**
 * Invoke a command that streams through a typed Tauri Channel. `channelArg`
 * is the Rust parameter name (camelCase on this side), e.g. `onEvent`.
 */
export function callWithChannel<T, M>(
  command: string,
  args: Record<string, unknown>,
  channelArg: string,
  onMessage: Emit<M>,
): Promise<T> {
  if (isTauri) {
    const channel = new Channel<M>();
    channel.onmessage = onMessage;
    return invoke<T>(command, { ...args, [channelArg]: channel });
  }
  return mock().then((m) => m.mockInvoke<T>(command, { ...args, [channelArg]: onMessage }));
}

export async function listenEvent<T>(event: string, handler: (payload: T) => void) {
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(event, (e) => handler(e.payload));
  }
  return mock().then((m) => m.mockListen<T>(event, handler));
}
