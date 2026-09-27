import { handlers } from './registry';
import './app';
import './resources';
import './dock';
import './access';
// Registered after './resources': it wraps `resource_patch` (resuming a paused rollout).
import './workloadOps';
import './fleet';
import './logsDebug';
import './helmCharts';
import './openapi';

export { mockListen } from './bus';

/**
 * In-memory demo backend used when the UI runs outside Tauri (`pnpm dev:ui`).
 * It mirrors the real command surface closely enough to exercise every
 * screen, with a handful of fictional clusters and live-looking data.
 */
export async function mockInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const handler = handlers[command];
  if (!handler)
    throw new Error(`Demo backend: "${command}" is not available in the browser preview.`);
  return (await handler(args)) as T;
}
