import * as i18n from '@/i18n';
import { useMemo } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { BUILTIN, gvkForKey, kindKey, toGvk } from '@/lib/kube/catalog';
import { kindIcon } from '@/lib/kube/icons';
import type { NpPod, NpPolicy } from '@/lib/kube/netpol';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';
import { useSelectedNamespaces } from '../data/hooks';
import { DetailsPanel } from '../details/DetailsPanel';
import { NamespacePicker } from '../header/NamespacePicker';
import { CaveatBanners, EnforcementChip } from './Caveats';
import type { ExplainLinks } from './Explanation';
import { MatrixPanel } from './MatrixPanel';
import { useNetpolStore, useNetpolViewState, type NetpolMode } from './netpolStore';
import { ProtectionPanel } from './ProtectionPanel';
import { SimulatorPanel } from './SimulatorPanel';
import { useNetpolData } from './useNetpolData';

/**
 * The NetworkPolicy simulator view: "can A talk to B?", a namespace matrix
 * and the isolation list. Policies and pods open in a details panel docked
 * beside the view, like the resource map.
 */

const POLICY_KEY = kindKey(BUILTIN.NetworkPolicy);
const POD_KEY = kindKey(BUILTIN.Pod);

export function NetpolPage({
  clusterId,
  viewKey,
  isActive,
  apiResources,
}: {
  clusterId: string;
  viewKey: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const namespaces = useSelectedNamespaces(clusterId, viewKey);
  const data = useNetpolData(clusterId, namespaces, isActive, apiResources);
  const state = useNetpolViewState(clusterId);
  const selection = useWorkbenchStore(
    (s) => s.selection[clusterId]?.[VIEW.netpolSimulator] ?? null,
  );
  const selectedGvk = useMemo(
    () => (selection ? gvkForKey(selection.key, apiResources) : null),
    [selection, apiResources],
  );
  const Icon = kindIcon(VIEW.netpolSimulator);

  const links: ExplainLinks = useMemo(
    () => ({
      onOpenPolicy: (p: NpPolicy) =>
        useWorkbenchStore.getState().select(clusterId, VIEW.netpolSimulator, {
          key: POLICY_KEY,
          namespace: p.namespace,
          name: p.name,
        }),
      onOpenPod: (p: NpPod) =>
        useWorkbenchStore.getState().select(clusterId, VIEW.netpolSimulator, {
          key: POD_KEY,
          namespace: p.namespace,
          name: p.name,
        }),
    }),
    [clusterId],
  );

  const liveObject = selection
    ? selection.key === POLICY_KEY
      ? data.policyObject(selection.namespace ?? '', selection.name)
      : selection.key === POD_KEY
        ? data.podObject(selection.namespace ?? '', selection.name)
        : null
    : null;

  const modes: Array<[NetpolMode, string]> = [
    ['simulate', i18n.t('Simulate')],
    ['matrix', i18n.t('Matrix')],
    ['protection', i18n.t('Isolation')],
  ];
  const setMode = (mode: NetpolMode) => useNetpolStore.getState().patch(clusterId, { mode });
  const policyCount = data.cluster.policies.length;
  const failed = data.errors.filter((e) => e.kind !== 'Namespace');

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-fg min-w-0 shrink truncate text-[13px] font-semibold">
            {i18n.t('Network Policy Simulator')}
          </h2>
          <span className="text-fg-dim hidden shrink-0 text-[11px] tabular-nums @3xl:inline">
            {i18n.plural('{count} NetworkPolicy', '{count} NetworkPolicies', policyCount)}
          </span>
          <EnforcementChip cni={data.cni} />
          {data.loading && (
            <Loader2
              className="text-fg-dim h-3 w-3 shrink-0 animate-spin"
              aria-label={i18n.t('Syncing')}
            />
          )}
          <span className="ml-auto" />
          <NamespacePicker clusterId={clusterId} viewKey={viewKey} isActive={isActive} />
          <div
            role="tablist"
            aria-label={i18n.t('Simulator mode')}
            className="bg-fg/5 flex h-7 shrink-0 items-center gap-0.5 rounded-lg p-0.5"
          >
            {modes.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={state.mode === id}
                onClick={() => setMode(id)}
                className={cn(
                  'h-6 rounded-md px-2.5 text-[11.5px] transition',
                  state.mode === id
                    ? 'bg-surface-raised text-fg font-medium shadow-xs'
                    : 'text-fg-dim hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-6xl space-y-4 p-5">
            <CaveatBanners clusterId={clusterId} data={data} cni={data.cni} namespaces={null} />
            {failed.length > 0 && (
              <div className="border-status-error/30 bg-status-error/8 text-fg-muted rounded-app flex items-start gap-2.5 border px-3.5 py-2.5 text-[12px]">
                <TriangleAlert className="text-status-error mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {i18n.t('Could not load {kinds}; verdicts may be incomplete.', {
                    kinds: failed.map((e) => e.kind).join(', '),
                  })}
                </span>
              </div>
            )}
            {!data.synced && !data.cluster.pods.length ? (
              <div className="text-fg-muted flex items-center justify-center gap-2 py-16 text-[12px]">
                <Loader2 className="h-4 w-4 animate-spin" />
                {i18n.t('Loading pods and policies…')}
              </div>
            ) : state.mode === 'matrix' ? (
              <MatrixPanel
                clusterId={clusterId}
                data={data}
                namespaces={namespaces}
                links={links}
              />
            ) : state.mode === 'protection' ? (
              <ProtectionPanel
                clusterId={clusterId}
                data={data}
                namespaces={namespaces}
                links={links}
              />
            ) : (
              <SimulatorPanel
                clusterId={clusterId}
                data={data}
                defaultNamespace={namespaces[0] ?? null}
                links={links}
              />
            )}
          </div>
        </div>
      </div>
      {selection && selectedGvk && (
        <DetailsPanel
          clusterId={clusterId}
          gvk={selectedGvk ?? toGvk(BUILTIN.NetworkPolicy)}
          kindKey={selection.key}
          viewKey={VIEW.netpolSimulator}
          selection={selection}
          liveObject={liveObject}
          isActive={isActive}
          apiResources={apiResources}
        />
      )}
    </div>
  );
}
