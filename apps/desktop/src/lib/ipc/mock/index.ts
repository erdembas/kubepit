import { handlers } from './registry';
import './app';
import './resources';
import './dock';
import './access';
// Registered after './resources': it wraps `resource_patch` (resuming a paused rollout).
import './workloadOps';
// Registered after './workloadOps': it runs on `resource_dry_run_yaml` / `resource_apply_yaml`.
import './manifests';
// Wraps `resource_patch` too: demo Argo CD / Flux controllers (GitOps actions).
import './gitops';
import './fleet';
import './logsDebug';
import './helmCharts';
import './updates';
import './alerts';
import './insights';
import './prometheus';
import './openapi';
// Registered after './app': it wraps `port_forward_start` and `cluster_connect`.
import './connectivity';
import './changes';

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
