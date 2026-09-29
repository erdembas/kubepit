import type { AiAgentCatalog, AiProviderKind } from '@/types';

export interface AgentCatalogSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  catalog: AiAgentCatalog | null;
  error: string | null;
  updatedAt: number | null;
  stale: boolean;
}
const EMPTY: AgentCatalogSnapshot = {
  status: 'idle',
  catalog: null,
  error: null,
  updatedAt: null,
  stale: false,
};

/** Share native discovery across settings and the composer; failures never trigger a retry loop. */
export function createAgentCatalogCache(ttl = 300_000, now = Date.now) {
  const entries = new Map<
    AiProviderKind,
    { snapshot: AgentCatalogSnapshot; pending: Promise<AiAgentCatalog> | null; expires: number }
  >();
  const listeners = new Map<AiProviderKind, Set<() => void>>();
  const notify = (kind: AiProviderKind) => {
    for (const listener of listeners.get(kind) ?? []) listener();
  };
  return {
    snapshot(kind: AiProviderKind | null): AgentCatalogSnapshot {
      return kind ? (entries.get(kind)?.snapshot ?? EMPTY) : EMPTY;
    },
    subscribe(kind: AiProviderKind | null, listener: () => void) {
      if (!kind) return () => {};
      let set = listeners.get(kind);
      if (!set) listeners.set(kind, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(kind);
      };
    },
    load(
      kind: AiProviderKind,
      loader: (refresh: boolean) => Promise<AiAgentCatalog>,
      refresh = false,
    ): Promise<AiAgentCatalog> {
      const current = entries.get(kind);
      if (current?.pending) return current.pending;
      if (!refresh && current?.snapshot.catalog && current.expires > now())
        return Promise.resolve(current.snapshot.catalog);
      if (!refresh && current?.snapshot.status === 'error')
        return Promise.reject(new Error(current.snapshot.error ?? ''));
      const snapshot = current?.snapshot ?? EMPTY;
      const entry = {
        snapshot: {
          ...snapshot,
          status: 'loading' as const,
          error: null,
          stale: !!snapshot.catalog,
        } as AgentCatalogSnapshot,
        pending: null as Promise<AiAgentCatalog> | null,
        expires: 0,
      };
      const promise = Promise.resolve().then(() => loader(refresh || !!snapshot.catalog));
      entry.pending = promise;
      entries.set(kind, entry);
      notify(kind);
      void promise.then(
        (catalog) => {
          entry.pending = null;
          entry.expires = now() + ttl;
          entry.snapshot = {
            status: 'ready',
            catalog,
            error: null,
            updatedAt: now(),
            stale: false,
          };
          notify(kind);
        },
        (cause: unknown) => {
          entry.pending = null;
          entry.snapshot = {
            ...snapshot,
            status: 'error',
            error: cause instanceof Error ? cause.message : String(cause),
            stale: !!snapshot.catalog,
          };
          notify(kind);
        },
      );
      return promise;
    },
  };
}
