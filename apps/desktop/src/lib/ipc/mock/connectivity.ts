import { sameTarget } from '@/lib/portForwards';
import type {
  ClusterDef,
  ClusterStatus,
  PortForward,
  PortForwardRequest,
  SavedPortForward,
  SavedPortForwardInput,
} from '@/types';
import { demoForwards, writeBackendOwned } from './app';
import { mockEmit, sleep } from './bus';
import {
  DEMO_BUSY_PORTS,
  DEMO_SAVED_FORWARDS,
  demoKubeconfigChange,
  demoProxyInfo,
} from './fixtures/connectivity';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo connectivity: saved port forwards (start on connect, failures with a
 * restart), busy local ports, proxy info, keychain storage and one
 * `kubeconfig://changed` notice. Registered after './app': it wraps
 * `port_forward_start` and `cluster_connect`.
 */

let saved: SavedPortForward[] = DEMO_SAVED_FORWARDS.map((s) => ({ ...s }));

function emitSaved() {
  mockEmit('portforward://saved', saved);
}

function freeNear(port: number) {
  for (let p = port + 1; p <= Math.min(port + 100, 65535); p++)
    if (!DEMO_BUSY_PORTS.has(p) && !demoForwards.list().some((f) => f.local_port === p)) return p;
  return 40000 + Math.floor(Math.random() * 20000);
}

function portInUse(port: number) {
  return DEMO_BUSY_PORTS.has(port) || demoForwards.list().some((f) => f.local_port === port);
}

function clusters() {
  return (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
}

function statuses() {
  return (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined) ?? {};
}

const originalStart = handlers.port_forward_start!;
const originalConnect = handlers.cluster_connect!;

/** Start like kubepit-core: busy ports fail with a free alternative; saved targets link. */
async function start(request: PortForwardRequest, savedId: string | null, id?: string) {
  const port = request.local_port ?? 0;
  if (port && portInUse(port))
    throw new Error(
      `local port ${port} is already in use by another program (port ${freeNear(port)} is free)`,
    );
  const pf = (await originalStart({ request })) as PortForward;
  const linked: PortForward = { ...pf, id: id ?? pf.id, saved_id: savedId };
  demoForwards.replace([
    ...demoForwards.list().filter((f) => f.id !== pf.id && f.id !== id),
    linked,
  ]);
  return linked;
}

function linkedId(request: PortForwardRequest) {
  const def = saved.find((s) => sameTarget(s, request));
  return def && !demoForwards.list().some((f) => f.saved_id === def.id) ? def.id : null;
}

function requestOf(def: SavedPortForward): PortForwardRequest {
  return {
    cluster_id: def.cluster_id,
    namespace: def.namespace,
    kind: def.kind,
    name: def.name,
    remote_port: def.remote_port,
    local_port: def.local_port,
  };
}

async function autostart(clusterId: string) {
  for (const def of saved.filter((s) => s.cluster_id === clusterId && s.start_on_connect)) {
    if (demoForwards.list().some((f) => f.saved_id === def.id)) continue;
    try {
      await start(requestOf(def), def.id);
    } catch (error) {
      const failed: PortForward = {
        ...requestOf(def),
        id: crypto.randomUUID(),
        local_port: def.local_port ?? 0,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
        created_at: Date.now(),
        saved_id: def.id,
      };
      demoForwards.replace([...demoForwards.list(), failed]);
    }
  }
}

register({
  port_forward_start: ({ request }: MockArgs) => {
    const req = request as PortForwardRequest;
    return start(req, linkedId(req));
  },
  cluster_connect: async (args: MockArgs) => {
    const status = (await originalConnect(args)) as ClusterStatus;
    if (status.state === 'connected') void autostart(status.id);
    return status;
  },
  port_forward_saved_list: () => saved,
  port_forward_save: ({ input }: MockArgs) => {
    const next = input as SavedPortForwardInput;
    if (!next.remote_port) throw new Error('remote port must be between 1 and 65535');
    const existing = saved.find((s) => sameTarget(s, next));
    const def: SavedPortForward = {
      ...(existing ?? { id: `spf-${crypto.randomUUID().slice(0, 8)}`, created_at: Date.now() }),
      ...next,
      local_port: next.local_port || null,
      label: next.label?.trim() || null,
    };
    saved = [...saved.filter((s) => s.id !== def.id), def];
    const running = demoForwards.list().find((f) => !f.saved_id && sameTarget(f, def));
    if (running && !demoForwards.list().some((f) => f.saved_id === def.id))
      demoForwards.replace(
        demoForwards.list().map((f) => (f.id === running.id ? { ...f, saved_id: def.id } : f)),
      );
    emitSaved();
    return def;
  },
  port_forward_saved_update: ({ saved: update }: MockArgs) => {
    const next = update as SavedPortForward;
    const current = saved.find((s) => s.id === next.id);
    if (!current) throw new Error(`saved port forward ${next.id} does not exist`);
    const def: SavedPortForward = {
      ...current,
      label: next.label?.trim() || null,
      local_port: next.local_port || null,
      start_on_connect: next.start_on_connect,
    };
    saved = saved.map((s) => (s.id === def.id ? def : s));
    emitSaved();
    return def;
  },
  port_forward_unsave: ({ id }: MockArgs) => {
    if (!saved.some((s) => s.id === id)) return;
    saved = saved.filter((s) => s.id !== id);
    demoForwards.replace(
      demoForwards.list().map((f) => (f.saved_id === id ? { ...f, saved_id: null } : f)),
    );
    emitSaved();
  },
  port_forward_saved_start: async ({ id }: MockArgs) => {
    const def = saved.find((s) => s.id === id);
    if (!def) throw new Error(`saved port forward ${id} does not exist`);
    const live = demoForwards.list().find((f) => f.saved_id === id);
    if (live && live.state !== 'error') return live;
    if (statuses()[def.cluster_id]?.state !== 'connected')
      await originalConnect({ id: def.cluster_id });
    return start(requestOf(def), def.id, live?.id);
  },
  port_forward_restart: async ({ id }: MockArgs) => {
    const live = demoForwards.list().find((f) => f.id === id);
    if (!live) throw new Error(`port forward ${id} is not running`);
    await sleep(200);
    const request: PortForwardRequest = { ...live, local_port: live.local_port || null };
    demoForwards.replace(demoForwards.list().filter((f) => f.id !== id));
    try {
      return await start(request, live.saved_id ?? null, id);
    } catch (error) {
      demoForwards.replace([
        ...demoForwards.list(),
        { ...live, state: 'error', error: error instanceof Error ? error.message : String(error) },
      ]);
      throw error;
    }
  },
  port_forward_local_port: ({ port }: MockArgs) => {
    const n = Number(port);
    const busy = n > 0 && portInUse(n);
    return { port: n, available: !busy, suggestion: busy ? freeNear(n) : null };
  },
  cluster_proxy_info: ({ id }: MockArgs) =>
    demoProxyInfo(String(id), clusters().find((c) => c.id === id)?.proxy_url),
  kubeconfig_storage_set: async ({ keychain }: MockArgs) => {
    await sleep(400);
    // The one command that flips it (`settings_set` keeps the stored value).
    return writeBackendOwned((current) => ({ ...current, keychain_kubeconfigs: !!keychain }));
  },
});

// One kubeconfig change a little after the preview starts, like editing ~/.kube/config.
let announced = false;
setTimeout(() => {
  if (announced) return;
  announced = true;
  const connected = Object.values(statuses())
    .filter((s) => s.state === 'connected')
    .map((s) => s.id);
  mockEmit('kubeconfig://changed', demoKubeconfigChange(connected));
}, 20_000);
