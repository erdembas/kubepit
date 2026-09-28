import * as i18n from '@/i18n';
import { useMemo, type ReactNode } from 'react';
import { Radar, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { BUILTIN, kindKey } from '@/lib/kube/catalog';
import { findPod, reachOverlay, relevantUnevaluated, type ReachState } from '@/lib/kube/netpol';
import type { TopoGraph } from '@/lib/kube/topology';
import type { ObjectSelection } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId } from '@/types';
import { REACH_DOT, reachLabel } from './labels';
import { useNetpolStore, useNetpolViewState } from './netpolStore';
import { useNetpolData } from './useNetpolData';

/**
 * Resource map overlay: colours the map by what the selected pod can reach
 * (its egress and each destination's ingress, on the destination's
 * declared ports). Only watches the simulator's lists while it is on.
 */

const POD_KEY = kindKey(BUILTIN.Pod);

export interface MapReachability {
  enabled: boolean;
  toggle: () => void;
  overlay: ReadonlyMap<string, ReachState> | null;
  notice: ReactNode;
}

export function useMapReachability({
  clusterId,
  namespaces,
  isActive,
  apiResources,
  graph,
  selection,
}: {
  clusterId: ClusterId;
  namespaces: readonly string[];
  isActive: boolean;
  apiResources: readonly ApiResourceInfo[] | null;
  graph: TopoGraph;
  selection: ObjectSelection | null;
}): MapReachability {
  const enabled = useNetpolViewState(clusterId).mapOverlay;
  const data = useNetpolData(clusterId, namespaces, isActive && enabled, apiResources);
  const source =
    enabled && selection?.key === POD_KEY && selection.namespace
      ? findPod(data.cluster, selection.namespace, selection.name)
      : null;
  const overlay = useMemo(
    () => (source ? reachOverlay(graph, data.cluster, source, null) : null),
    [graph, data.cluster, source],
  );
  const uncertain =
    !!source &&
    (data.cni.enforcement === 'not-enforced' ||
      data.policiesIncomplete ||
      relevantUnevaluated(data.unevaluated, [source.namespace]).length > 0);

  const notice: ReactNode = !enabled ? null : (
    <div className="border-border bg-surface-raised/95 text-fg-muted pointer-events-auto rounded-md border px-2 py-1 text-[11px] shadow-sm">
      {!source ? (
        <span className="flex items-center gap-1.5">
          <Radar className="text-accent h-3.5 w-3.5 shrink-0" />
          {data.synced || !selection
            ? i18n.t('Select a pod to colour the map by what it can reach.')
            : i18n.t('Loading pods and policies…')}
        </span>
      ) : (
        <div className="space-y-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <Radar className="text-accent h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {i18n.t('What {pod} can reach, on each destination’s declared ports', {
                pod: source.name,
              })}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pl-5">
            {(['allowed', 'partial', 'denied'] as const).map((s) => (
              <span key={s} className="flex items-center gap-1">
                <span className={cn('h-2 w-2 rounded-full', REACH_DOT[s])} />
                {reachLabel(s)}
              </span>
            ))}
          </span>
          {uncertain && (
            <span className="text-status-starting flex items-center gap-1.5 pl-5">
              <ShieldAlert className="h-3 w-3 shrink-0" />
              {i18n.t('Not certain: see the Network Policy Simulator for caveats.')}
            </span>
          )}
        </div>
      )}
    </div>
  );

  return {
    enabled,
    toggle: () => useNetpolStore.getState().patch(clusterId, { mapOverlay: !enabled }),
    overlay,
    notice,
  };
}

export function MapReachabilityToggle({ reach }: { reach: MapReachability }) {
  i18n.useLocale();
  return (
    <button
      type="button"
      aria-pressed={reach.enabled}
      onClick={reach.toggle}
      title={i18n.t('Colour the map by what the selected pod can reach (NetworkPolicies)')}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] transition',
        reach.enabled
          ? 'bg-accent/10 text-accent font-medium'
          : 'text-fg-muted hover:bg-fg/5 hover:text-fg',
      )}
    >
      <Radar className="h-3.5 w-3.5" />
      {i18n.t('Reachability')}
    </button>
  );
}
