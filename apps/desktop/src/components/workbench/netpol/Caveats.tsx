import * as i18n from '@/i18n';
import { useState } from 'react';
import { ChevronDown, Info, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { cn } from '@/lib/cn';
import { resolveRef } from '@/lib/kube/catalog';
import {
  relevantUnevaluated,
  type CniDetection,
  type CniPlugin,
  type UnevaluatedPolicy,
} from '@/lib/kube/netpol';
import { navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ClusterId } from '@/types';
import type { NetpolData } from './useNetpolData';

/**
 * What the simulator cannot see: other policy engines' objects, a network
 * plugin that likely ignores NetworkPolicy, unreadable lists.
 */

export type UncertainReason = 'not-enforced' | 'unevaluated' | 'host-network' | 'ipblock-pod';

export function uncertainReasons(
  data: Pick<NetpolData, 'cni' | 'unevaluated'>,
  namespaces: readonly string[],
  flags: { hostNetwork: boolean; ipBlockOnPod: boolean },
): UncertainReason[] {
  const out: UncertainReason[] = [];
  if (data.cni.enforcement === 'not-enforced') out.push('not-enforced');
  if (relevantUnevaluated(data.unevaluated, namespaces).length) out.push('unevaluated');
  if (flags.hostNetwork) out.push('host-network');
  if (flags.ipBlockOnPod) out.push('ipblock-pod');
  return out;
}

export function uncertainText(reason: UncertainReason): string {
  switch (reason) {
    case 'not-enforced':
      return i18n.t('The network plugin likely does not enforce NetworkPolicy.');
    case 'unevaluated':
      return i18n.t('Policies of another engine apply to these namespaces and are not evaluated.');
    case 'host-network':
      return i18n.t('A host-network pod is involved; plugins differ on how policies treat it.');
    default:
      return i18n.t('An ipBlock matched a pod IP; plugins differ on whether that applies.');
  }
}

function pluginNote(p: CniPlugin): string | null {
  switch (p.note) {
    case 'aws-policy-agent-off':
      return i18n.t(
        'Amazon VPC CNI enforces NetworkPolicy only with the network policy agent enabled.',
      );
    case 'aws-policy-agent-unknown':
      return i18n.t('Could not tell whether the Amazon VPC CNI network policy agent is enabled.');
    case 'kindnet-old':
      return i18n.t('This kindnet release predates NetworkPolicy support.');
    default:
      return null;
  }
}

function openUnevaluated(clusterId: ClusterId, p: UnevaluatedPolicy) {
  const apiResources = useWorkbenchStore.getState().apiResources[clusterId];
  const gvk = resolveRef(p.apiVersion, p.kind.kind, apiResources);
  if (gvk) navigateTo(clusterId, gvk, p.namespace, p.name);
}

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'warn' | 'info';
  icon: typeof Info;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-app flex items-start gap-2.5 border px-3.5 py-2.5 text-[12px]',
        tone === 'warn'
          ? 'border-status-starting/30 bg-status-starting/8 text-fg-muted'
          : 'border-border bg-surface-raised/40 text-fg-muted',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          tone === 'warn' ? 'text-status-starting' : 'text-fg-dim',
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

function UnevaluatedList({
  clusterId,
  policies,
}: {
  clusterId: ClusterId;
  policies: UnevaluatedPolicy[];
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const engines = [...new Set(policies.map((p) => p.kind.engine))].join(', ');
  return (
    <Banner tone="warn" icon={ShieldAlert}>
      <p className="text-fg">
        {i18n.plural(
          '{count} {engines} policy is not evaluated: verdicts only cover Kubernetes NetworkPolicies.',
          '{count} {engines} policies are not evaluated: verdicts only cover Kubernetes NetworkPolicies.',
          policies.length,
          { engines },
        )}
      </p>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        className="text-fg-dim hover:text-fg flex items-center gap-1 text-[11.5px]"
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
        {open ? i18n.t('Hide the list') : i18n.t('Show the list')}
      </button>
      {open && (
        <ul className="space-y-0.5">
          {policies.slice(0, 50).map((p) => (
            <li key={p.uid} className="flex min-w-0 items-baseline gap-2 text-[11.5px]">
              <span className="text-fg-dim shrink-0">{p.kind.kind}</span>
              <button
                type="button"
                onClick={() => openUnevaluated(clusterId, p)}
                className="text-accent min-w-0 truncate font-mono hover:underline"
              >
                {p.namespace ? `${p.namespace}/${p.name}` : p.name}
              </button>
            </li>
          ))}
          {policies.length > 50 && (
            <li className="text-fg-dim text-[11px]">
              {i18n.t('and {count} more', { count: policies.length - 50 })}
            </li>
          )}
        </ul>
      )}
    </Banner>
  );
}

/** Banners for the whole view (or one namespace's worth of policies in details). */
export function CaveatBanners({
  clusterId,
  data,
  cni,
  namespaces,
  compact,
}: {
  clusterId: ClusterId;
  data: NetpolData;
  cni: CniDetection;
  /** Limit unevaluated policies to these namespaces (plus cluster-wide ones); null = all. */
  namespaces: readonly string[] | null;
  compact?: boolean;
}) {
  i18n.useLocale();
  const unevaluated = namespaces
    ? relevantUnevaluated(data.unevaluated, namespaces)
    : data.unevaluated;
  const notEnforcing = cni.plugins.filter((p) => p.enforces !== true);
  return (
    <>
      {cni.enforcement === 'not-enforced' && (
        <Banner tone="warn" icon={ShieldAlert}>
          <p className="text-fg">
            {i18n.t(
              'The network plugin ({plugins}) likely does not enforce NetworkPolicy. Verdicts show what the policies say, not what the network does.',
              { plugins: notEnforcing.map((p) => p.name).join(', ') },
            )}
          </p>
          {notEnforcing.map((p) => {
            const note = pluginNote(p);
            return note ? (
              <p key={p.source} className="text-fg-dim text-[11.5px]">
                {note}
              </p>
            ) : null;
          })}
        </Banner>
      )}
      {cni.enforcement === 'unknown' && !compact && (
        <Banner tone="info" icon={ShieldQuestion}>
          <p>
            {cni.unreadable
              ? i18n.t(
                  'DaemonSets could not be read, so the network plugin is unknown. Make sure it enforces NetworkPolicy.',
                )
              : i18n.t(
                  'The network plugin was not recognised. Make sure it enforces NetworkPolicy before relying on these verdicts.',
                )}
          </p>
          {cni.plugins.map((p) => {
            const note = pluginNote(p);
            return note ? (
              <p key={p.source} className="text-fg-dim text-[11.5px]">
                {note}
              </p>
            ) : null;
          })}
        </Banner>
      )}
      {unevaluated.length > 0 && <UnevaluatedList clusterId={clusterId} policies={unevaluated} />}
      {!compact && data.cluster.namespacesSynthetic && (
        <Banner tone="info" icon={Info}>
          <p>
            {i18n.t(
              'Namespace labels could not be read: namespace selectors only see kubernetes.io/metadata.name.',
            )}
          </p>
        </Banner>
      )}
      {!compact && data.scoped && (
        <Banner tone="info" icon={Info}>
          <p>
            {i18n.t(
              'Only the selected namespaces could be listed: traffic to and from other namespaces is not simulated.',
            )}
          </p>
        </Banner>
      )}
    </>
  );
}

/** Small header chip naming the enforcing plugin. */
export function EnforcementChip({ cni }: { cni: CniDetection }) {
  i18n.useLocale();
  const enforcing = cni.plugins.filter((p) => p.enforces === true);
  if (cni.enforcement !== 'enforced' || !enforcing.length) return null;
  return (
    <span
      className="text-fg-dim hidden shrink-0 items-center gap-1.5 truncate text-[11px] @2xl:inline-flex"
      title={enforcing.map((p) => p.source).join(', ')}
    >
      <span className="bg-status-running h-1.5 w-1.5 rounded-full" />
      {i18n.t('Enforced by {plugins}', { plugins: enforcing.map((p) => p.name).join(', ') })}
    </span>
  );
}
