import * as i18n from '@/i18n';
import { useEffect, useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { asObject, asString } from '@/lib/kube/accessors';
import { kindKey } from '@/lib/kube/catalog';
import { nodeId, topologySources, type TopoNode } from '@/lib/kube/topology';
import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { useDetailsTabRequest } from '../details/detailsTabs';
import { openInResourceMap, openNodeDetails } from './mapNavigation';
import { isHops, usePersistentJson } from './persist';
import { TopologyMap } from './TopologyMap';
import { useTopologyData } from './useTopologyData';

/** Namespaces a neighbourhood needs: the object's own, all for cluster-scoped roots. */
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
  const scope = useMemo(() => (scopeKey ? scopeKey.split(',') : []), [scopeKey]);
  const key = kindKey(gvk);
  const watched = useMemo(
    () => topologySources(apiResources).some((g) => g && kindKey(g) === key),
    [apiResources, key],
  );
  const extra = watched || isNamespace ? null : { gvk, obj };
  const data = useTopologyData(clusterId, scope, isActive, apiResources, extra);
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
