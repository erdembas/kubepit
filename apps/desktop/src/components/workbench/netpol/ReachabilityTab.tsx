import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Loader2,
  Radar,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import {
  peerText,
  reachSubject,
  reachSummary,
  rulePortsText,
  type DirectionSummary,
  type ExternalReach,
  type NpPod,
  type NpPolicy,
  type NpSelection,
  type PeerReach,
} from '@/lib/kube/netpol';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { useDetailsTabRequest } from '../details/detailsTabs';
import { Section } from '../details/primitives';
import { CaveatBanners } from './Caveats';
import { CoverageChip, PolicyLink, type ExplainLinks } from './Explanation';
import { openNetpolSimulator } from './netpolStore';
import { useNetpolData } from './useNetpolData';

/** Details tab of pods and workloads: isolation, who can reach it, whom it can reach. */

const LIST_LIMIT = 12;

function selfSelection(obj: KubeObject, pod: NpPod): NpSelection {
  if (obj.kind === 'Pod') return { type: 'pod', namespace: pod.namespace, name: pod.name };
  return {
    type: 'workload',
    namespace: pod.namespace,
    kind: pod.template ? obj.kind : pod.workload.kind,
    name: pod.template ? obj.metadata.name : pod.workload.name,
  };
}

function peerSelection(peer: PeerReach): NpSelection {
  return {
    type: 'workload',
    namespace: peer.group.namespace,
    kind: peer.group.workload.kind,
    name: peer.group.workload.name,
  };
}

function IsolationTile({ summary, links }: { summary: DirectionSummary; links: ExplainLinks }) {
  i18n.useLocale();
  const ingress = summary.direction === 'ingress';
  const isolated = summary.state === 'isolated';
  const Icon = isolated ? ShieldCheck : ShieldOff;
  const denyAll = isolated && summary.rules.length === 0;
  return (
    <div className="rounded-app border-border bg-surface-raised/40 min-w-0 border px-3 py-2.5">
      <div className="text-fg-dim flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.12em] uppercase">
        {ingress ? (
          <ArrowDownToLine className="h-3 w-3" />
        ) : (
          <ArrowUpFromLine className="h-3 w-3" />
        )}
        {ingress ? i18n.t('Ingress') : i18n.t('Egress')}
      </div>
      <div
        className={cn(
          'mt-1.5 flex items-center gap-1.5 text-[13px] font-semibold',
          denyAll
            ? 'text-status-error'
            : isolated
              ? 'text-status-running'
              : summary.state === 'host-network'
                ? 'text-fg-muted'
                : 'text-status-starting',
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {summary.state === 'host-network'
          ? i18n.t('Host network')
          : denyAll
            ? i18n.t('Deny all')
            : isolated
              ? i18n.t('Isolated')
              : i18n.t('Open')}
      </div>
      <p className="text-fg-dim mt-1 text-[11.5px]">
        {summary.state === 'host-network'
          ? i18n.t('Uses the node’s network: policies usually do not apply.')
          : isolated
            ? i18n.plural(
                'Selected by {count} policy',
                'Selected by {count} policies',
                summary.policies.length,
              )
            : ingress
              ? i18n.t('No policy selects it for ingress.')
              : i18n.t('No policy selects it for egress.')}
      </p>
      {isolated && (
        <div className="mt-1 flex flex-col items-start gap-0.5">
          {summary.policies.map((p) => (
            <PolicyLink key={p.uid} policy={p} links={links} />
          ))}
        </div>
      )}
    </div>
  );
}

function externalText(ext: ExternalReach): ReactNode {
  if (ext.coverage === 'all') return i18n.t('Any address outside the cluster');
  if (ext.coverage === 'none') return i18n.t('No address outside the cluster');
  const useExcept = ext.except.length > 0 && ext.except.length <= ext.ranges.length;
  const list = (useExcept ? ext.except : ext.ranges).slice(0, 6).join(', ');
  const more = (useExcept ? ext.except : ext.ranges).length > 6 ? ' …' : '';
  return useExcept
    ? i18n.t('Outside addresses except {ranges}', { ranges: `${list}${more}` })
    : i18n.t('Outside addresses in {ranges}', { ranges: `${list}${more}` });
}

function PeerList({
  peers,
  onSimulate,
}: {
  peers: PeerReach[];
  onSimulate: (peer: PeerReach) => void;
}) {
  i18n.useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? peers : peers.slice(0, LIST_LIMIT);
  return (
    <ul className="space-y-0.5">
      {shown.map((p) => (
        <li key={p.group.key}>
          <button
            type="button"
            onClick={() => onSimulate(p)}
            title={i18n.t('Explain in the simulator')}
            className="hover:bg-fg/5 -mx-1.5 flex w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="text-fg block truncate text-[12px]">{p.group.workload.name}</span>
              <span className="text-fg-dim block truncate text-[10.5px]">
                {p.group.workload.kind} · {p.group.namespace}
                {p.pairs > 1 && p.reachable !== p.pairs && (
                  <>
                    {' '}
                    ·{' '}
                    {i18n.t('{reachable} of {total} pods', {
                      reachable: p.reachable,
                      total: p.pairs,
                    })}
                  </>
                )}
              </span>
            </span>
            {p.coverage !== 'all' && <CoverageChip coverage={p.coverage} />}
          </button>
        </li>
      ))}
      {peers.length > LIST_LIMIT && (
        <li>
          <button
            type="button"
            onClick={() => setAll((x) => !x)}
            className="text-accent text-[11px] hover:underline"
          >
            {all ? i18n.t('Show less') : i18n.t('Show all {count}', { count: peers.length })}
          </button>
        </li>
      )}
    </ul>
  );
}

function DirectionSection({
  summary,
  links,
  onSimulate,
}: {
  summary: DirectionSummary;
  links: ExplainLinks;
  onSimulate: (peer: PeerReach) => void;
}) {
  i18n.useLocale();
  const ingress = summary.direction === 'ingress';
  const reachable = summary.peers.filter((p) => p.coverage !== 'none');
  const blocked = summary.peers.filter((p) => p.coverage === 'none');
  return (
    <Section title={ingress ? i18n.t('Can be reached from') : i18n.t('Can reach')}>
      <div className="space-y-3">
        {summary.state === 'isolated' && summary.rules.length > 0 && (
          <div>
            <h4 className="text-fg-dim mb-1 text-[11px]">{i18n.t('Allowed by')}</h4>
            <ul className="space-y-1.5">
              {summary.rules.map(({ policy, rule }) => (
                <li key={`${policy.uid}-${rule.index}`} className="text-[12px] leading-[1.45]">
                  <PolicyLink policy={policy} links={links} />
                  <span className="text-fg-muted block">
                    {rule.peers === null
                      ? ingress
                        ? i18n.t('from anywhere')
                        : i18n.t('to anywhere')
                      : rule.peers
                          .map((peer) =>
                            ingress
                              ? i18n.t('from {peer}', { peer: peerText(peer, policy.namespace) })
                              : i18n.t('to {peer}', { peer: peerText(peer, policy.namespace) }),
                          )
                          .join(' · ')}
                    <span className="text-fg-dim"> — {rulePortsText(rule)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {summary.state === 'isolated' && summary.rules.length === 0 && (
          <p className="text-status-error text-[12px]">
            {ingress
              ? i18n.t('Nothing can connect: its policies have no ingress rules.')
              : i18n.t('It cannot connect anywhere: its policies have no egress rules.')}
          </p>
        )}
        {summary.state !== 'isolated' && (
          <p className="text-fg-muted text-[12px]">
            {summary.state === 'host-network'
              ? i18n.t('Host-network pods are usually not subject to NetworkPolicy.')
              : ingress
                ? i18n.t(
                    'Every pod and address may connect, unless its own egress policies block it.',
                  )
                : i18n.t(
                    'It may connect anywhere, unless the destination’s ingress policies block it.',
                  )}
          </p>
        )}
        <div>
          <h4 className="text-fg-dim mb-1 text-[11px]">
            {summary.state === 'isolated' || summary.state === 'host-network'
              ? ingress
                ? i18n.plural(
                    '{count} workload can connect',
                    '{count} workloads can connect',
                    reachable.length,
                  )
                : i18n.plural(
                    '{count} workload reachable',
                    '{count} workloads reachable',
                    reachable.length,
                  )
              : ingress
                ? i18n.plural(
                    '{count} workload is blocked by its own egress policies',
                    '{count} workloads are blocked by their own egress policies',
                    blocked.length,
                  )
                : i18n.plural(
                    '{count} workload blocks it with ingress policies',
                    '{count} workloads block it with ingress policies',
                    blocked.length,
                  )}
          </h4>
          <PeerList
            peers={summary.state === 'not-isolated' ? blocked : reachable}
            onSimulate={onSimulate}
          />
        </div>
        <p className="text-fg-muted flex flex-wrap items-center gap-x-2 text-[12px]">
          <span className="text-fg-dim text-[11px]">
            {ingress ? i18n.t('From outside:') : i18n.t('To outside:')}
          </span>
          <span className="min-w-0 break-words">{externalText(summary.external)}</span>
        </p>
      </div>
    </Section>
  );
}

export function ReachabilityTab({
  clusterId,
  obj,
  isActive,
  apiResources,
}: {
  clusterId: ClusterId;
  gvk: Gvk;
  obj: KubeObject;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const namespace = obj.metadata.namespace ?? '';
  const scope = useMemo(() => (namespace ? [namespace] : []), [namespace]);
  const data = useNetpolData(clusterId, scope, isActive, apiResources);
  const subject = useMemo(() => reachSubject(data.cluster, obj), [data.cluster, obj]);
  const summary = useMemo(
    () => (subject ? reachSummary(subject.cluster, subject.pod) : null),
    [subject],
  );

  // A pending "open on the Reachability tab" request for this object is consumed here.
  useEffect(() => {
    const request = useDetailsTabRequest.getState().request;
    if (
      request?.tab === 'reachability' &&
      request.uid === obj.metadata.uid &&
      request.clusterId === clusterId
    )
      useDetailsTabRequest.getState().clear();
  }, [clusterId, obj.metadata.uid]);

  const links: ExplainLinks = useMemo(
    () => ({
      onOpenPolicy: (p: NpPolicy) =>
        navigateTo(clusterId, toGvk(BUILTIN.NetworkPolicy), p.namespace, p.name),
      onOpenPod: (p: NpPod) => navigateTo(clusterId, toGvk(BUILTIN.Pod), p.namespace, p.name),
    }),
    [clusterId],
  );

  if (!summary || !subject)
    return (
      <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 p-6 text-[12px]">
        {data.synced ? (
          i18n.t('Nothing to evaluate for this object.')
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Loading pods and policies…')}
          </>
        )}
      </div>
    );

  const self = selfSelection(obj, subject.pod);
  const simulate = (peer: PeerReach, ingress: boolean) =>
    openNetpolSimulator(clusterId, {
      mode: 'simulate',
      source: ingress ? peerSelection(peer) : self,
      destination: ingress ? self : peerSelection(peer),
      port: '',
    });

  return (
    <div className="overlay-scroll @container min-h-0 flex-1 overflow-auto">
      <div className="space-y-2 px-4 pt-4 empty:hidden">
        <CaveatBanners
          clusterId={clusterId}
          data={data}
          cni={data.cni}
          namespaces={scope}
          compact
        />
      </div>
      <Section
        title={i18n.t('Isolation')}
        actions={
          <>
            <button
              type="button"
              onClick={() =>
                openNetpolSimulator(clusterId, {
                  mode: 'simulate',
                  source: self,
                  destination: null,
                })
              }
              className="text-accent hover:bg-accent/10 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
            >
              <Radar className="h-3 w-3" />
              {i18n.t('Simulate from here')}
            </button>
            <button
              type="button"
              onClick={() =>
                openNetpolSimulator(clusterId, {
                  mode: 'simulate',
                  source: null,
                  destination: self,
                })
              }
              className="text-accent hover:bg-accent/10 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
            >
              {i18n.t('to here')}
            </button>
          </>
        }
      >
        <div className="grid gap-2 @md:grid-cols-2">
          <IsolationTile summary={summary.ingress} links={links} />
          <IsolationTile summary={summary.egress} links={links} />
        </div>
        {subject.pod.template ? (
          <p className="text-fg-dim mt-2 text-[11.5px]">
            {i18n.t('No pods are running: the pod template was evaluated instead.')}
          </p>
        ) : obj.kind !== 'Pod' ? (
          <p className="text-fg-dim mt-2 text-[11.5px]">
            {subject.mixedLabels
              ? i18n.t('Replicas carry different labels; evaluated for {pod}.', {
                  pod: subject.pod.name,
                })
              : i18n.plural(
                  'Evaluated for its pod {pod}.',
                  'Evaluated for {pod}; its {count} replicas share the same labels.',
                  subject.pods.length,
                  { pod: subject.pod.name },
                )}
          </p>
        ) : null}
        {summary.dns && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px]">
            <span className="text-fg-dim text-[11px]">
              {i18n.t('DNS ({service}, UDP 53):', {
                service: `${summary.dns.service.namespace}/${summary.dns.service.name}`,
              })}
            </span>
            <CoverageChip coverage={summary.dns.coverage} />
          </p>
        )}
      </Section>
      <DirectionSection
        summary={summary.ingress}
        links={links}
        onSimulate={(peer) => simulate(peer, true)}
      />
      <DirectionSection
        summary={summary.egress}
        links={links}
        onSimulate={(peer) => simulate(peer, false)}
      />
    </div>
  );
}
