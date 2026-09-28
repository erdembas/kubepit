import * as i18n from '@/i18n';
import { Fragment, type ReactNode } from 'react';
import { ArrowRight, Check, CircleSlash, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  coverageOf,
  peerText,
  portSetText,
  rangeText,
  type Coverage,
  type NpEndpoint,
  type NpPod,
  type NpPolicy,
  type PortTarget,
  type SideResult,
  type SimPair,
} from '@/lib/kube/netpol';
import { COVERAGE_DOT, COVERAGE_TEXT, coverageLabel } from './labels';

/** The "why" of a verdict: which policies isolate each side and which rule allowed it. */

export interface ExplainLinks {
  onOpenPolicy: (policy: NpPolicy) => void;
  onOpenPod?: (pod: NpPod) => void;
}

export function PolicyLink({ policy, links }: { policy: NpPolicy; links: ExplainLinks }) {
  return (
    <button
      type="button"
      onClick={() => links.onOpenPolicy(policy)}
      title={i18n.t('Open {name}', { name: `${policy.namespace}/${policy.name}` })}
      className="text-accent max-w-full truncate text-left font-mono text-[11.5px] hover:underline"
    >
      {policy.namespace}/{policy.name}
    </button>
  );
}

export function EndpointLabel({ endpoint, links }: { endpoint: NpEndpoint; links?: ExplainLinks }) {
  if (endpoint.type === 'ip')
    return <span className="text-fg font-mono text-[11.5px]">{rangeText(endpoint.range)}</span>;
  const pod = endpoint.pod;
  const text = `${pod.namespace}/${pod.name}`;
  if (!links?.onOpenPod || pod.template)
    return (
      <span className="text-fg font-mono text-[11.5px]" title={text}>
        {text}
      </span>
    );
  return (
    <button
      type="button"
      onClick={() => links.onOpenPod?.(pod)}
      title={i18n.t('Open {name}', { name: text })}
      className="text-fg hover:text-accent max-w-full truncate text-left font-mono text-[11.5px] hover:underline"
    >
      {text}
    </button>
  );
}

function joinNodes(nodes: ReactNode[]): ReactNode {
  return nodes.map((n, i) => (
    <Fragment key={i}>
      {i > 0 && ', '}
      {n}
    </Fragment>
  ));
}

export function CoverageChip({ coverage, className }: { coverage: Coverage; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium',
        COVERAGE_TEXT[coverage],
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', COVERAGE_DOT[coverage])} />
      {coverageLabel(coverage)}
    </span>
  );
}

function Line({
  tone,
  children,
}: {
  tone: 'allow' | 'deny' | 'warn' | 'info';
  children: ReactNode;
}) {
  const Icon =
    tone === 'allow' ? Check : tone === 'deny' ? X : tone === 'warn' ? TriangleAlert : Info;
  return (
    <li className="flex min-w-0 items-start gap-2 text-[12px] leading-[1.45]">
      <Icon
        className={cn(
          'mt-[3px] h-3 w-3 shrink-0',
          tone === 'allow'
            ? 'text-status-running'
            : tone === 'deny'
              ? 'text-status-error'
              : tone === 'warn'
                ? 'text-status-starting'
                : 'text-fg-dim',
        )}
      />
      <div className="text-fg-muted min-w-0 flex-1 break-words">{children}</div>
    </li>
  );
}

function ruleLabel(direction: SideResult['direction'], index: number) {
  return direction === 'ingress'
    ? i18n.t('ingress rule {n}', { n: index + 1 })
    : i18n.t('egress rule {n}', { n: index + 1 });
}

function peerPhrase(direction: SideResult['direction'], peer: string) {
  return direction === 'ingress' ? i18n.t('from {peer}', { peer }) : i18n.t('to {peer}', { peer });
}

function anyPeer(direction: SideResult['direction']) {
  return direction === 'ingress' ? i18n.t('from anywhere') : i18n.t('to anywhere');
}

export function SideExplanation({
  side,
  subject,
  targets,
  links,
}: {
  side: SideResult;
  /** The pod the policies of this side belong to. */
  subject: NpEndpoint;
  targets: readonly PortTarget[] | null;
  links: ExplainLinks;
}) {
  i18n.useLocale();
  const ingress = side.direction === 'ingress';
  const coverage = coverageOf(side.ports, targets);
  const who = <EndpointLabel endpoint={subject} links={links} />;
  const lines: ReactNode[] = [];
  switch (side.state) {
    case 'external':
      lines.push(
        <Line key="x" tone="info">
          {ingress
            ? i18n.t('The destination is outside the cluster: no ingress policy applies.')
            : i18n.t('The source is outside the cluster: no egress policy applies.')}
        </Line>,
      );
      break;
    case 'host-network':
      lines.push(
        <Line key="h" tone="warn">
          {i18n.rich(
            '{pod} uses the host network: NetworkPolicies usually do not apply to it (this depends on the network plugin).',
            { pod: who },
          )}
        </Line>,
      );
      break;
    case 'loopback':
      lines.push(
        <Line key="l" tone="allow">
          {i18n.t('A pod can always reach itself.')}
        </Line>,
      );
      break;
    case 'not-isolated':
      lines.push(
        <Line key="n" tone="allow">
          {ingress
            ? i18n.rich(
                'No NetworkPolicy selects {pod} for ingress, so all its ingress is allowed.',
                {
                  pod: who,
                },
              )
            : i18n.rich(
                'No NetworkPolicy selects {pod} for egress, so all its egress is allowed.',
                {
                  pod: who,
                },
              )}
        </Line>,
      );
      break;
    case 'node':
      lines.push(
        <Line key="node" tone="allow">
          {i18n.t(
            'Traffic from the pod’s own node is always allowed (kubelet probes, host-network pods).',
          )}
        </Line>,
      );
      break;
    case 'isolated': {
      const policies = joinNodes(
        side.policies.map((p) => <PolicyLink key={p.uid} policy={p} links={links} />),
      );
      lines.push(
        <Line key="iso" tone="info">
          {ingress
            ? i18n.rich('{pod} is isolated for ingress by {policies}.', { pod: who, policies })
            : i18n.rich('{pod} is isolated for egress by {policies}.', { pod: who, policies })}
        </Line>,
      );
      for (const hit of side.hits) {
        const rules = ingress ? hit.policy.ingressRules : hit.policy.egressRules;
        const rule = rules[hit.rule];
        const peer =
          hit.peer === null || !rule?.peers
            ? anyPeer(side.direction)
            : peerPhrase(side.direction, peerText(rule.peers[hit.peer]!, hit.policy.namespace));
        const hitCoverage = coverageOf(hit.ports, targets);
        lines.push(
          <Line
            key={`hit-${hit.policy.uid}-${hit.rule}`}
            tone={hitCoverage === 'none' ? 'warn' : 'allow'}
          >
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <PolicyLink policy={hit.policy} links={links} />
              <span className="text-fg-dim">·</span>
              <span>{ruleLabel(side.direction, hit.rule)}</span>
            </span>
            <span className="block">
              {hitCoverage === 'none'
                ? i18n.t('Matches {peer}, but only allows {ports}.', {
                    peer,
                    ports: portSetText(hit.ports),
                  })
                : i18n.t('Allows {peer} on {ports}.', { peer, ports: portSetText(hit.ports) })}
            </span>
            {hit.ipBlockOnPod && (
              <span className="text-fg-dim block text-[11px]">
                {i18n.t(
                  'This ipBlock matched a pod IP. Network plugins differ on whether ipBlocks apply to pod traffic.',
                )}
              </span>
            )}
          </Line>,
        );
      }
      if (coverage !== 'all') {
        for (const miss of side.peerMisses.slice(0, 6)) {
          const rules = ingress ? miss.policy.ingressRules : miss.policy.egressRules;
          const rule = rules[miss.rule];
          const peers = (rule?.peers ?? []).map((p) => peerText(p, miss.policy.namespace));
          lines.push(
            <Line key={`miss-${miss.policy.uid}-${miss.rule}`} tone="deny">
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <PolicyLink policy={miss.policy} links={links} />
                <span className="text-fg-dim">·</span>
                <span>{ruleLabel(side.direction, miss.rule)}</span>
              </span>
              <span className="block">
                {ingress
                  ? i18n.t('Does not match this source. It allows:')
                  : i18n.t('Does not match this destination. It allows:')}
              </span>
              <ul className="text-fg-dim mt-0.5 list-disc pl-4 text-[11.5px]">
                {peers.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Line>,
          );
        }
        if (side.peerMisses.length > 6)
          lines.push(
            <Line key="more" tone="info">
              {i18n.plural(
                '{count} more rule does not match.',
                '{count} more rules do not match.',
                side.peerMisses.length - 6,
              )}
            </Line>,
          );
        for (const p of side.policies) {
          const rules = ingress ? p.ingressRules : p.egressRules;
          if (rules.length) continue;
          lines.push(
            <Line key={`empty-${p.uid}`} tone="deny">
              {ingress
                ? i18n.rich('{policy} has no ingress rules: it only isolates.', {
                    policy: <PolicyLink policy={p} links={links} />,
                  })
                : i18n.rich('{policy} has no egress rules: it only isolates.', {
                    policy: <PolicyLink policy={p} links={links} />,
                  })}
            </Line>,
          );
        }
      }
      for (const u of side.unresolved)
        lines.push(
          <Line key={`u-${u}`} tone="warn">
            {i18n.t('The named port {port} is not declared by the destination pod.', { port: u })}
          </Line>,
        );
      break;
    }
  }
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-2">
        <h4 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {ingress ? i18n.t('Destination ingress') : i18n.t('Source egress')}
        </h4>
        <CoverageChip coverage={coverage} className="ml-auto" />
      </div>
      <ul className="space-y-1.5">{lines}</ul>
    </div>
  );
}

/** Both sides of one pod pair (or address range). */
export function PairExplanation({ pair, links }: { pair: SimPair; links: ExplainLinks }) {
  i18n.useLocale();
  const { result } = pair;
  return (
    <div className="space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <EndpointLabel endpoint={result.source} links={links} />
        <ArrowRight className="text-fg-dim h-3 w-3 shrink-0" />
        <EndpointLabel endpoint={result.destination} links={links} />
        {pair.servicePort && (
          <span className="text-fg-dim text-[11px]">
            {i18n.t('via Service port {port}', {
              port: `${pair.servicePort.name ? `${pair.servicePort.name} ` : ''}${pair.servicePort.protocol} ${pair.servicePort.port} → ${pair.servicePort.targetPort}`,
            })}
          </span>
        )}
      </div>
      {pair.noTargetPort && (
        <p className="text-status-starting flex items-start gap-1.5 text-[12px]">
          <CircleSlash className="mt-0.5 h-3 w-3 shrink-0" />
          {i18n.t('The destination does not declare the asked port, so nothing listens there.')}
        </p>
      )}
      <div className="grid gap-3 @xl:grid-cols-2">
        <SideExplanation
          side={result.egress}
          subject={result.source}
          targets={pair.targets}
          links={links}
        />
        <SideExplanation
          side={result.ingress}
          subject={result.destination}
          targets={pair.targets}
          links={links}
        />
      </div>
      {pair.coverage !== 'none' && (
        <p className="text-fg-dim text-[11px]">
          {i18n.t('Allowed end to end: {ports}', { ports: portSetText(result.ports) })}
        </p>
      )}
    </div>
  );
}
