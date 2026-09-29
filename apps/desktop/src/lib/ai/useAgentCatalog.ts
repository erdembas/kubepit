import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ipc } from '@/lib/ipc';
import type { AiProviderKind } from '@/types';
import { createAgentCatalogCache } from './agentCatalogCache';

const cache = createAgentCatalogCache();
export function useAgentCatalog(kind: AiProviderKind, enabled: boolean) {
  const subscribe = useCallback((listener: () => void) => cache.subscribe(kind, listener), [kind]);
  const snapshot = useCallback(() => cache.snapshot(kind), [kind]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const load = useCallback(
    (refresh: boolean) => {
      if (enabled)
        void cache.load(kind, (force) => ipc.aiAgentCatalog(kind, force), refresh).catch(() => {});
    },
    [kind, enabled],
  );
  useEffect(() => {
    load(false);
  }, [load]);
  return {
    ...state,
    loading: enabled && (state.status === 'idle' || state.status === 'loading'),
    refresh: () => load(true),
  };
}
