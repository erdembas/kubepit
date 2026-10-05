import { useMemo, useRef } from 'react';
import type { SearchSuggestionContext } from '@/lib/fleet/searchSuggestions';
import { effectiveKinds, parseSearchInput } from '@/lib/fleet/searchQuery';
import { kindKey } from '@/lib/kube/catalog';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useAppStore } from '@/store/useAppStore';
import {
  targetClusters,
  useFleetSearchStore,
  type ClusterResult,
} from '@/store/useFleetSearchStore';
import { ANY_VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';
import { cachedResourceMetadata } from '../workbench/data/watchCache';
import {
  SearchSuggestionMetadata,
  type ResourceMetadataObservation,
} from './searchSuggestionMetadata';

// Session-only history intentionally outlives a cleared search and an
// unmounted search tab. The bounded cache retains metadata, never objects.
const observed = new SearchSuggestionMetadata();
const workbench = new SearchSuggestionMetadata();

function* resultMetadata(
  results: Record<string, ClusterResult>,
  registered: Set<string>,
): Iterable<ResourceMetadataObservation> {
  let clusters = 0;
  for (const [clusterId, result] of Object.entries(results)) {
    if (!registered.has(clusterId)) continue;
    if (++clusters > 32) break;
    // Sample across the result order so the first kind of a broad search
    // cannot consume the entire per-cluster metadata budget.
    const stride = Math.max(1, Math.ceil(result.items.length / 256));
    for (let index = 0; index < result.items.length; index += stride) {
      const item = result.items[index]!;
      yield {
        clusterId,
        gvk: item.gvk,
        namespace: item.namespace,
        name: item.name,
        uid: item.uid,
        labels: item.labels,
      };
    }
  }
}

/** Local completion context. No IPC, watches, discovery requests or implicit
 * connections: metadata comes from views/searches the user already opened. */
export function useSearchSuggestionContext(visible: boolean): SearchSuggestionContext {
  const clusters = useVisibleStore(useAppStore, (state) => state.clusters, visible);
  const clusterSection = useVisibleStore(useAppStore, (state) => state.clusterSection, visible);
  const apiResources = useVisibleStore(useWorkbenchStore, (state) => state.apiResources, visible);
  const selectedNamespaces = useVisibleStore(
    useWorkbenchStore,
    (state) => state.namespaces,
    visible,
  );
  const input = useVisibleStore(useFleetSearchStore, (state) => state.input, visible);
  const kinds = useVisibleStore(useFleetSearchStore, (state) => state.kinds, visible);
  const scope = useVisibleStore(useFleetSearchStore, (state) => state.scope, visible);
  const results = useVisibleStore(useFleetSearchStore, (state) => state.results, visible);
  const lastResults = useRef<Record<string, ClusterResult> | null>(null);

  return useMemo(() => {
    if (!visible) return { apiResources: [], clusters: [], namespaces: [], labelValues: {} };
    const registeredIds = clusters.map((cluster) => cluster.id);
    observed.prune(registeredIds);
    workbench.prune(registeredIds);
    if (lastResults.current !== results) {
      observed.observe(resultMetadata(results, new Set(registeredIds)));
      lastResults.current = results;
    }

    const scopeClusters = targetClusters(clusters, scope, clusterSection, null);
    const discovered = new Map<string, ApiResourceInfo>();
    for (const cluster of scopeClusters) {
      for (const resource of apiResources[cluster.id] ?? []) {
        const key = `${kindKey(resource)}|${resource.version}`;
        if (discovered.size < 2048 || discovered.has(key)) discovered.set(key, resource);
      }
    }
    const resources = [...discovered.values()];
    const parsed = parseSearchInput(input, resources);
    const targets = targetClusters(clusters, scope, clusterSection, parsed);
    const ids = targets.map((cluster) => cluster.id);
    const activeKinds = effectiveKinds(parsed, kinds);
    const kindKeys = activeKinds.map(kindKey);
    workbench.observe(cachedResourceMetadata(ids, kindKeys));

    const collect = (namespace: string | null) => {
      const fromResults = observed.collect(ids, kindKeys, namespace);
      const fromWorkbench = workbench.collect(ids, kindKeys, namespace);
      const labels = new Map<string, string[]>();
      for (const source of [fromResults.labelValues, fromWorkbench.labelValues]) {
        for (const [key, values] of Object.entries(source)) {
          if (labels.size >= 256 && !labels.has(key)) continue;
          labels.set(key, [...new Set([...(labels.get(key) ?? []), ...values])].slice(0, 128));
        }
      }
      return {
        namespaces: [...new Set([...fromResults.namespaces, ...fromWorkbench.namespaces])].slice(
          0,
          512,
        ),
        labelValues: Object.fromEntries(labels),
      };
    };
    const unscoped = collect(null);
    const namespaces = new Set(unscoped.namespaces);
    for (const cluster of targets) {
      for (const namespace of [
        ...cluster.accessible_namespaces,
        ...(selectedNamespaces[cluster.id]?.[ANY_VIEW] ?? []),
        cluster.default_namespace,
      ]) {
        if (namespace && namespaces.size < 512) namespaces.add(namespace);
      }
    }
    // While a namespace token is only a prefix, preserve useful label
    // context. Once it names an observed/registered namespace, scope values
    // to that exact namespace instead of mixing unrelated applications.
    const namespace =
      parsed.namespace && namespaces.has(parsed.namespace) ? parsed.namespace : null;
    const metadata = namespace ? collect(namespace) : unscoped;
    return {
      apiResources: resources,
      // Do not narrow the cluster picker by the token currently being
      // completed; the suggestion helper handles its typed prefix.
      clusters: scopeClusters.map(({ id, name, environment }) => ({ id, name, environment })),
      namespaces: [...namespaces].sort((a, b) => a.localeCompare(b)),
      labelValues: activeKinds.length ? metadata.labelValues : {},
    };
  }, [
    visible,
    clusters,
    clusterSection,
    apiResources,
    selectedNamespaces,
    input,
    kinds,
    scope,
    results,
  ]);
}
