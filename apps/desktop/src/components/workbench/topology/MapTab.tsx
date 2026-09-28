import * as i18n from '@/i18n';
import { useEffect, useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { asObject, asString } from '@/lib/kube/accessors';
import { kindKey } from '@/lib/kube/catalog';
import {
  DEFAULT_INGRESS_CLASS_ANNOTATION,
  mapSeed,
  nodeId,
  planMapScope,
  plannedGraphScope,
  topologySources,
  type SlotScope,
  type TopoNode,
} from '@/lib/kube/topology';
import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { useWatch } from '../data/watchCache';
import { useDetailsTabRequest } from '../details/detailsTabs';
import { openInResourceMap, openNodeDetails } from './mapNavigation';
import { isHops, usePersistentJson } from './persist';
import { TopologyMap } from './TopologyMap';
import { useTopologyData } from './useTopologyData';

/**
 * Namespaces a neighbourhood needs: the object's own, the whole namespace for
 * a Namespace, the claim's for a bound PersistentVolume. `[]` for other
 * cluster-scoped roots, whose slots `planMapScope` scopes instead.
 */
function scopeFor(gvk: Gvk, obj: KubeObject): string[] {
  if (obj.kind === 'Namespace') return [obj.metadata.name];
  if (gvk.namespaced) return obj.metadata.namespace ? [obj.metadata.namespace] : [];
  if (obj.kind === 'PersistentVolume') {
    const claimNs = asString(asObject(asObject(obj.spec).claimRef).namespace);
    if (claimNs) return [claimNs];
  }
  return [];
}

/**
 * Details panel "Map" tab: the object's neighbourhood (1–3 hops; ownership
 * links are free). Clicking another object opens it on its own Map tab; a
 * Namespace shows its whole map.
 */
export function MapTab({
  clusterId,
  gvk,
  obj,
  isActive,
  apiResources,
  onShowDetails,
}: {
  clusterId: string;
  gvk: Gvk;
  obj: KubeObject;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
  onShowDetails: () => void;
}) {
  i18n.useLocale();
  const [hops, setHops] = usePersistentJson<number>('kubepit.topology.hops', 2, isHops);
  const isNamespace = obj.kind === 'Namespace';
  const scopeKey = scopeFor(gvk, obj).join(',');
  const key = kindKey(gvk);
  const sources = useMemo(() => topologySources(apiResources), [apiResources]);
  const watched = sources.some((g) => g && kindKey(g) === key);
  // A cluster-scoped root with no namespace of its own never watches
  // namespaced kinds cluster-wide: its seed kinds (pods of a Node, claims of
  // a StorageClass, bindings of a ClusterRole, …) pick the namespaces the
  // other slots watch. Both seed watches share the keys other views hold
  // (the ClusterRoleBinding one is the cluster-scoped slot's own watch).
  const planned = !gvk.namespaced && !scopeKey;
  const seed = planned ? mapSeed(obj.kind) : null;
  const seedGvks = useMemo(
    () => (seed?.gvkKeys ?? []).map((k) => sources.find((g) => g && kindKey(g) === k) ?? null),
    [seed, sources],
  );
  const seedA = useWatch(clusterId, seedGvks[0] ?? null, [], isActive);
  const seedB = useWatch(clusterId, seedGvks[1] ?? null, [], isActive);
  // A failed seed (no access) counts as settled with no objects.
  const settled = (i: number, s: typeof seedA) => !seedGvks[i] || s.synced || s.status === 'error';
  const seedsSynced = settled(0, seedA) && settled(1, seedB);
  const itemsA = seedGvks[0] ? seedA.items : null;
  const itemsB = seedGvks[1] ? seedB.items : null;
  const rootName = obj.metadata.name;
  const rootKind = obj.kind;
  const defaultClass = obj.metadata.annotations?.[DEFAULT_INGRESS_CLASS_ANNOTATION];
  const slotScopes = useMemo<SlotScope[]>(() => {
    if (!planned) {
      const scope = scopeKey ? scopeKey.split(',') : [];
      return sources.map(() => scope);
    }
    const root = {
      kind: rootKind,
      name: rootName,
      annotations: defaultClass ? { [DEFAULT_INGRESS_CLASS_ANNOTATION]: defaultClass } : undefined,
    };
    const seedItems = itemsA || itemsB ? [...(itemsA ?? []), ...(itemsB ?? [])] : null;
    return planMapScope(
      root,
      sources,
      seedItems ? { items: seedItems, synced: seedsSynced } : null,
    );
  }, [planned, scopeKey, sources, rootKind, rootName, defaultClass, itemsA, itemsB, seedsSynced]);
  const graphScope = useMemo(
    () => (planned ? plannedGraphScope(slotScopes) : undefined),
    [planned, slotScopes],
  );
  const extra = watched || isNamespace ? null : { gvk, obj };
  const data = useTopologyData(clusterId, slotScopes, isActive, apiResources, extra, graphScope);
  const rootId = isNamespace
    ? null
    : nodeId(key, gvk.namespaced ? obj.metadata.namespace : null, obj.metadata.name);

  // A pending "open on the Map tab" request for this object is consumed here.
  useEffect(() => {
    const request = useDetailsTabRequest.getState().request;
    if (
      request?.tab === 'map' &&
      request.uid === obj.metadata.uid &&
      request.clusterId === clusterId
    )
      useDetailsTabRequest.getState().clear();
  }, [clusterId, obj.metadata.uid]);

  const onOpen = (node: TopoNode) => {
    if (node.id === rootId) onShowDetails();
    else openNodeDetails(clusterId, node, apiResources);
  };

  return (
    <TopologyMap
      label={i18n.t('Relationships of {name}', { name: obj.metadata.name })}
      graph={data.graph}
      rootId={rootId}
      hops={hops}
      selectedId={null}
      showNamespace={!gvk.namespaced && !isNamespace}
      persistKey="details"
      active={isActive}
      synced={data.synced}
      errors={data.errors}
      fitKey={`${clusterId}|${rootId ?? scopeKey}|${hops}`}
      focusRequest={null}
      onOpen={onOpen}
      emptyText={i18n.t('No related objects found.')}
      toolbar={
        <>
          {!isNamespace && (
            <div
              role="radiogroup"
              aria-label={i18n.t('Neighbourhood depth')}
              title={i18n.t('How many relationships away from this object to show')}
              className="bg-fg/5 flex h-7 shrink-0 items-center gap-0.5 rounded-lg p-0.5"
            >
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={hops === n}
                  onClick={() => setHops(n)}
                  className={cn(
                    'h-6 rounded-md px-2 text-[11px] tabular-nums transition',
                    hops === n
                      ? 'bg-surface-raised text-fg font-medium shadow-xs'
                      : 'text-fg-dim hover:text-fg',
                  )}
                >
                  {i18n.plural('{count} hop', '{count} hops', n)}
                </button>
              ))}
            </div>
          )}
          {!isNamespace && (
            <IconButton
              className="order-last"
              label={i18n.t('Open in Resource Map')}
              icon={<ExternalLink />}
              onClick={() => openInResourceMap(clusterId, gvk, obj)}
            />
          )}
        </>
      }
    />
  );
}
