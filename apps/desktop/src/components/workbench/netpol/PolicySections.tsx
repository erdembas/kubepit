import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState, type ReactNode } from 'react';
import { ArrowDown, Info, Radar, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import {
  parsePolicy,
  peerText,
  podSelectorText,
  podsMatchingPeer,
  resolveNamedPort,
  rulePortsText,
  selectedPods,
  workloadGroups,
  type Direction,
  type NpCluster,
  type NpPolicy,
  type NpRule,
} from '@/lib/kube/netpol';
import { navigateTo } from '@/store/useWorkbenchStore';
import { Section } from '../details/primitives';
import type { SectionProps } from '../details/sections/types';
import { openNetpolSimulator } from './netpolStore';
import { useNetpolData } from './useNetpolData';

/** NetworkPolicy details: what it selects and allows, in plain words and as a flow. */

const POD_LIMIT = 24;

function effectText(policy: NpPolicy, direction: Direction): string {
  const affects = direction === 'ingress' ? policy.ingress : policy.egress;
  const rules = direction === 'ingress' ? policy.ingressRules : policy.egressRules;
  if (!affects)
    return direction === 'ingress'
      ? i18n.t('Ingress is not affected by this policy.')
      : i18n.t('Egress is not affected by this policy.');
  if (!rules.length)
    return direction === 'ingress'
      ? i18n.t('Blocks all ingress to them: the policy has no ingress rules.')
      : i18n.t('Blocks all egress from them: the policy has no egress rules.');
  return direction === 'ingress'
    ? i18n.plural(
        'Isolates them for ingress: only what {count} rule allows gets in (together with other policies selecting them).',
        'Isolates them for ingress: only what its {count} rules allow gets in (together with other policies selecting them).',
        rules.length,
      )
    : i18n.plural(
        'Isolates them for egress: only what {count} rule allows gets out (together with other policies selecting them).',
        'Isolates them for egress: only what its {count} rules allow gets out (together with other policies selecting them).',
        rules.length,
      );
}

function RuleRow({
  rule,
  policy,
  direction,
  cluster,
}: {
  rule: NpRule;
  policy: NpPolicy;
  direction: Direction;
  cluster: NpCluster;
}) {
  i18n.useLocale();
  const ingress = direction === 'ingress';
  return (
    <li className="border-border/60 rounded-app-sm border px-2.5 py-2">
      <div className="text-fg-dim mb-1 text-[10.5px] font-semibold tracking-[0.1em] uppercase">
        {ingress
          ? i18n.t('Ingress rule {n}', { n: rule.index + 1 })
          : i18n.t('Egress rule {n}', { n: rule.index + 1 })}
      </div>
      <ul className="space-y-1">
        {rule.peers === null ? (
          <li className="text-fg text-[12px]">
            {ingress
              ? i18n.t('From anywhere (every pod and address)')
              : i18n.t('To anywhere (every pod and address)')}
          </li>
        ) : (
          rule.peers.map((peer, i) => {
            const count =
              peer.type === 'invalid'
                ? 0
                : podsMatchingPeer(cluster, policy.namespace, peer).length;
            return (
              <li key={i} className="flex min-w-0 items-baseline gap-2 text-[12px]">
                <span
                  className={cn(
                    'min-w-0 flex-1 break-words',
                    peer.type === 'invalid' ? 'text-status-error' : 'text-fg',
                  )}
                >
                  {ingress
                    ? i18n.t('from {peer}', { peer: peerText(peer, policy.namespace) })
                    : i18n.t('to {peer}', { peer: peerText(peer, policy.namespace) })}
                </span>
                {peer.type !== 'invalid' && (
                  <span className="text-fg-dim shrink-0 text-[11px] tabular-nums">
                    {i18n.plural('{count} pod', '{count} pods', count)}
                  </span>
                )}
              </li>
            );
          })
        )}
      </ul>
      <div className="text-fg-muted mt-1 text-[11.5px]">
        <span className="text-fg-dim">{i18n.t('Ports:')}</span>{' '}
        <span className="font-mono text-[11px]">{rulePortsText(rule)}</span>
      </div>
    </li>
  );
}

function FlowBox({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'allow' | 'deny' | 'muted' | 'accent';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-app min-w-0 border px-3 py-2.5',
        tone === 'deny'
          ? 'border-status-error/30 bg-status-error/5'
          : tone === 'muted'
            ? 'border-border border-dashed'
            : tone === 'accent'
              ? 'border-accent/40 bg-accent/5'
              : 'border-status-running/30 bg-status-running/5',
      )}
    >
      <div className="text-fg-dim mb-1.5 text-[10.5px] font-semibold tracking-[0.12em] uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function Connector() {
  return (
    <div className="flex justify-center py-1" aria-hidden>
      <svg width="16" height="20" viewBox="0 0 16 20" className="text-fg-dim">
        <line x1="8" y1="1" x2="8" y2="15" className="stroke-current" strokeWidth="1.5" />
        <path
          d="M3.5 11.5 L8 17 L12.5 11.5"
          className="stroke-current"
          strokeWidth="1.5"
          fill="none"
        />
      </svg>
    </div>
  );
}

function DirectionBox({
  policy,
  direction,
  cluster,
}: {
  policy: NpPolicy;
  direction: Direction;
  cluster: NpCluster;
}) {
  i18n.useLocale();
  const ingress = direction === 'ingress';
  const affects = ingress ? policy.ingress : policy.egress;
  const rules = ingress ? policy.ingressRules : policy.egressRules;
  const title = ingress ? i18n.t('Allowed in') : i18n.t('Allowed out');
  if (!affects)
    return (
      <FlowBox title={title} tone="muted">
        <p className="text-fg-dim text-[12px]">{i18n.t('Not affected by this policy')}</p>
      </FlowBox>
    );
  if (!rules.length)
    return (
      <FlowBox title={title} tone="deny">
        <p className="text-status-error text-[12px] font-medium">{i18n.t('Nothing (deny all)')}</p>
      </FlowBox>
    );
  return (
    <FlowBox title={title} tone="allow">
      <ul className="space-y-1.5">
        {rules.map((rule) => (
          <RuleRow
            key={rule.index}
            rule={rule}
            policy={policy}
            direction={direction}
            cluster={cluster}
          />
        ))}
      </ul>
    </FlowBox>
  );
}

export function NetworkPolicySections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const namespace = obj.metadata.namespace ?? '';
  const scope = useMemo(() => (namespace ? [namespace] : []), [namespace]);
  const data = useNetpolData(ctx.clusterId, scope, isActive, ctx.apiResources);
  const policy = useMemo(() => parsePolicy(obj), [obj]);
  const pods = useMemo(() => selectedPods(data.cluster, policy), [data.cluster, policy]);
  const [allPods, setAllPods] = useState(false);

  const warnings = useMemo(() => {
    const out: string[] = [];
    const rules = [
      ...(policy.ingress ? policy.ingressRules : []),
      ...(policy.egress ? policy.egressRules : []),
    ];
    if (rules.some((r) => r.peers?.some((p) => p.type === 'invalid')))
      out.push(
        i18n.t(
          'A peer is invalid (no selector, bad CIDR, or ipBlock mixed with selectors); it matches nothing.',
        ),
      );
    if (rules.some((r) => r.ports !== null && r.ports.length === 0))
      out.push(i18n.t('A rule lists only invalid ports; it matches no port.'));
    if (policy.ingress) {
      const named = new Set<string>();
      for (const r of policy.ingressRules)
        for (const p of r.ports ?? [])
          if (typeof p.port === 'string') named.add(`${p.protocol}/${p.port}`);
      for (const key of named) {
        const [protocol, name] = key.split('/') as ['TCP' | 'UDP' | 'SCTP', string];
        const missing = pods.filter((pod) => resolveNamedPort(pod, name, protocol) === null).length;
        if (missing)
          out.push(
            i18n.plural(
              'The named port {port} is not declared by {count} selected pod.',
              'The named port {port} is not declared by {count} selected pods.',
              missing,
              { port: key },
            ),
          );
      }
    }
    return out;
  }, [policy, pods]);

  const workloads = workloadGroups(pods);
  const shown = allPods ? pods : pods.slice(0, POD_LIMIT);

  return (
    <>
      <Section
        title={i18n.t('What it does')}
        actions={
          <button
            type="button"
            onClick={() =>
              openNetpolSimulator(ctx.clusterId, {
                mode: 'simulate',
                source: null,
                destination: workloads[0]
                  ? {
                      type: 'workload',
                      namespace,
                      kind: workloads[0].workload.kind,
                      name: workloads[0].workload.name,
                    }
                  : null,
              })
            }
            className="text-accent hover:bg-accent/10 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
          >
            <Radar className="h-3 w-3" />
            {i18n.t('Simulate')}
          </button>
        }
      >
        <div className="text-fg space-y-1.5 text-[12px] leading-[1.5]">
          <p>
            {i18n.t('Applies to {pods}.', { pods: podSelectorText(policy.podSelector, namespace) })}{' '}
            <span className="text-fg-dim">
              {data.synced || pods.length
                ? i18n.plural(
                    '{count} pod selected right now.',
                    '{count} pods selected right now.',
                    pods.length,
                  )
                : ''}
            </span>
          </p>
          <p className="text-fg-muted">{effectText(policy, 'ingress')}</p>
          <p className="text-fg-muted">{effectText(policy, 'egress')}</p>
          {policy.typesDefaulted && (
            <p className="text-fg-dim flex items-start gap-1.5 text-[11.5px]">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              {i18n.t(
                'policyTypes is not set: Ingress always applies, Egress only because the policy has egress rules.',
              )}
            </p>
          )}
          {warnings.map((w) => (
            <p key={w} className="text-status-starting flex items-start gap-1.5 text-[11.5px]">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              {w}
            </p>
          ))}
        </div>
      </Section>
      <Section title={i18n.t('Traffic flow')}>
        <DirectionBox policy={policy} direction="ingress" cluster={data.cluster} />
        <Connector />
        <FlowBox title={i18n.t('Selected pods ({count})', { count: pods.length })} tone="accent">
          {!pods.length ? (
            <p className="text-fg-dim text-[12px]">
              {data.synced
                ? i18n.t('No pod matches the pod selector right now.')
                : i18n.t('Loading…')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {shown.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => navigateTo(ctx.clusterId, toGvk(BUILTIN.Pod), p.namespace, p.name)}
                  title={`${p.workload.kind} ${p.workload.name}`}
                  className="bg-fg/5 text-fg-muted ring-border/60 hover:text-fg hover:ring-border-strong max-w-full truncate rounded-md px-1.5 py-0.5 font-mono text-[10.5px] ring-1 transition"
                >
                  {p.name}
                </button>
              ))}
              {pods.length > POD_LIMIT && (
                <button
                  type="button"
                  onClick={() => setAllPods((x) => !x)}
                  className="text-accent px-1 text-[11px] hover:underline"
                >
                  {allPods
                    ? i18n.t('Show less')
                    : i18n.t('Show all {count}', { count: pods.length })}
                </button>
              )}
            </div>
          )}
        </FlowBox>
        <Connector />
        <DirectionBox policy={policy} direction="egress" cluster={data.cluster} />
        <p className="text-fg-dim mt-3 flex items-start gap-1.5 text-[11px]">
          <ArrowDown className="mt-0.5 h-3 w-3 shrink-0" />
          {i18n.t(
            'Policies add up: a connection is allowed when any policy selecting the pod allows it, on both the sending and the receiving side.',
          )}
        </p>
      </Section>
    </>
  );
}
