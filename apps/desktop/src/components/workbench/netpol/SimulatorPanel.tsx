import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import {
  ArrowDown,
  ArrowRightLeft,
  ChevronDown,
  CircleHelp,
  Radar,
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  ShieldX,
} from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { simulate, type NpSelection, type Protocol, type SimResult } from '@/lib/kube/netpol';
import type { ClusterId } from '@/types';
import { Card } from '../overview/charts';
import { uncertainText } from './Caveats';
import { uncertainReasons } from './uncertain';
import { CoverageChip, PairExplanation, type ExplainLinks } from './Explanation';
import { EndpointPicker } from './EndpointPicker';
import { parsePortInput, PROTOCOL_OPTIONS, selectionText } from './labels';
import { useNetpolStore, useNetpolViewState, type NetpolViewState } from './netpolStore';
import type { NetpolData } from './useNetpolData';

/** "Can A talk to B?": pickers, the verdict card and the explanation trail. */

function problemText(problem: NonNullable<SimResult['problem']>): string {
  switch (problem) {
    case 'no-source':
      return i18n.t('The source has no running pods to evaluate.');
    case 'no-destination':
      return i18n.t('The destination has no running pods to evaluate.');
    case 'invalid-cidr':
      return i18n.t('Not a valid IPv4 / IPv6 address or CIDR.');
    case 'both-external':
      return i18n.t('Both ends are outside the cluster: no NetworkPolicy applies.');
    case 'no-selector':
      return i18n.t('This Service has no selector, so its endpoints are not known pods.');
    default:
      return i18n.t('The Service has no port matching the asked protocol and port.');
  }
}

function VerdictIcon({ verdict }: { verdict: SimResult['verdict'] }) {
  const Icon =
    verdict === 'allowed'
      ? ShieldCheck
      : verdict === 'denied'
        ? ShieldX
        : verdict === 'partial'
          ? ShieldHalf
          : CircleHelp;
  return (
    <span
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
        verdict === 'allowed'
          ? 'bg-status-running/12 text-status-running'
          : verdict === 'denied'
            ? 'bg-status-error/12 text-status-error'
            : verdict === 'partial'
              ? 'bg-status-starting/15 text-status-starting'
              : 'bg-fg/5 text-fg-dim',
      )}
    >
      <Icon className="h-5 w-5" />
    </span>
  );
}

function verdictTitle(verdict: SimResult['verdict']): string {
  switch (verdict) {
    case 'allowed':
      return i18n.t('Allowed');
    case 'denied':
      return i18n.t('Denied');
    case 'partial':
      return i18n.t('Partly allowed');
    default:
      return i18n.t('Nothing to evaluate');
  }
}

export function SimulatorPanel({
  clusterId,
  data,
  defaultNamespace,
  links,
}: {
  clusterId: ClusterId;
  data: NetpolData;
  defaultNamespace: string | null;
  links: ExplainLinks;
}) {
  i18n.useLocale();
  const state = useNetpolViewState(clusterId);
  const patch = (p: Partial<NetpolViewState>) => useNetpolStore.getState().patch(clusterId, p);
  const port = parsePortInput(state.port);

  const result = useMemo<SimResult | null>(() => {
    if (!state.source || !state.destination || port === 'invalid') return null;
    return simulate(data.cluster, {
      source: state.source,
      destination: state.destination,
      protocol: state.protocol,
      port,
    });
  }, [data.cluster, state.source, state.destination, state.protocol, port]);

  const reasons = result ? uncertainReasons(data, result.namespaces, result.flags) : [];
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());

  const swap = () =>
    patch({
      source: state.destination?.type === 'service' ? null : state.destination,
      destination: state.source,
    });

  const portText =
    port === null
      ? i18n.t('on the destination’s declared ports')
      : port === 'invalid'
        ? ''
        : i18n.t('on {protocol} {port}', { protocol: state.protocol, port: String(port) });

  return (
    <div className="space-y-4">
      <Card title={i18n.t('Connection')} icon={<Radar />}>
        <div className="grid gap-4 p-4 @3xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <EndpointPicker
            role="source"
            value={state.source}
            onChange={(source: NpSelection | null) => patch({ source })}
            cluster={data.cluster}
            defaultNamespace={defaultNamespace}
          />
          <div className="flex items-center justify-center @3xl:pt-6">
            <button
              type="button"
              onClick={swap}
              title={i18n.t('Swap source and destination')}
              aria-label={i18n.t('Swap source and destination')}
              className="text-fg-dim hover:bg-fg/5 hover:text-fg flex h-7 w-7 items-center justify-center rounded-md"
            >
              <ArrowDown className="h-3.5 w-3.5 @3xl:hidden" />
              <ArrowRightLeft className="hidden h-3.5 w-3.5 @3xl:block" />
            </button>
          </div>
          <EndpointPicker
            role="destination"
            value={state.destination}
            onChange={(destination: NpSelection | null) => patch({ destination })}
            cluster={data.cluster}
            defaultNamespace={defaultNamespace}
          />
        </div>
        <div className="border-border/60 flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
          <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
            {i18n.t('Port')}
          </span>
          <Select<Protocol>
            value={state.protocol}
            onChange={(protocol) => patch({ protocol })}
            options={PROTOCOL_OPTIONS}
            ariaLabel={i18n.t('Protocol')}
          />
          <input
            value={state.port}
            onChange={(e) => patch({ port: e.target.value })}
            placeholder={i18n.t('Declared ports')}
            aria-label={i18n.t('Port number or name')}
            spellCheck={false}
            className={cn(
              'bg-surface border-border text-fg placeholder:text-fg-dim focus:border-accent/50 h-7 w-36 min-w-0 rounded-md border px-2 font-mono text-[12px] outline-none',
              port === 'invalid' && 'border-status-error/60',
            )}
          />
          <span className="text-fg-dim min-w-0 text-[11px]">
            {port === 'invalid'
              ? i18n.t('Use a number (1–65535) or a port name.')
              : i18n.t('A number, a named port, or empty for the ports the destination declares.')}
          </span>
        </div>
      </Card>

      {!result ? (
        <div className="rounded-app border-border text-fg-dim flex flex-col items-center gap-2 border border-dashed px-6 py-10 text-center text-[12px]">
          <span className="bg-fg/5 flex h-10 w-10 items-center justify-center rounded-xl">
            <Radar className="h-5 w-5" />
          </span>
          {i18n.t('Pick a source and a destination to see whether NetworkPolicies let them talk.')}
        </div>
      ) : (
        <section className="rounded-app border-border bg-surface-raised/40 overflow-hidden border">
          <header className="flex min-w-0 items-start gap-3 px-4 py-3.5">
            <VerdictIcon verdict={result.verdict} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3
                  className={cn(
                    'text-[15px] font-semibold',
                    result.verdict === 'allowed'
                      ? 'text-status-running'
                      : result.verdict === 'denied'
                        ? 'text-status-error'
                        : result.verdict === 'partial'
                          ? 'text-status-starting'
                          : 'text-fg',
                  )}
                >
                  {verdictTitle(result.verdict)}
                </h3>
                {reasons.length > 0 && result.problem === null && (
                  <span className="bg-status-starting/12 text-status-starting inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
                    <ShieldAlert className="h-3 w-3" />
                    {i18n.t('Not certain')}
                  </span>
                )}
              </div>
              {state.source && state.destination && (
                <p className="text-fg-muted mt-0.5 min-w-0 text-[12px] break-words">
                  <span className="font-mono text-[11.5px]">{selectionText(state.source)}</span>
                  <span className="text-fg-dim"> → </span>
                  <span className="font-mono text-[11.5px]">
                    {selectionText(state.destination)}
                  </span>
                  {portText && <span className="text-fg-dim"> · {portText}</span>}
                </p>
              )}
              {result.problem ? (
                <p className="text-fg-muted mt-1.5 text-[12px]">{problemText(result.problem)}</p>
              ) : (
                <p className="text-fg-dim mt-1 text-[11.5px] tabular-nums">
                  {result.counts.all + result.counts.some === result.pairs
                    ? i18n.plural(
                        '{count} connection evaluated',
                        '{count} connections evaluated',
                        result.pairs,
                      )
                    : i18n.t('{allowed} of {total} connections allowed', {
                        allowed: result.counts.all + result.counts.some,
                        total: result.pairs,
                      })}
                  {result.truncated && ` · ${i18n.t('sampled')}`}
                </p>
              )}
              {result.resolvedIp && (
                <p className="text-fg-dim mt-1 text-[11.5px]">
                  {i18n.t('The address belongs to pod {pod}; it was evaluated as that pod.', {
                    pod: `${result.resolvedIp.namespace}/${result.resolvedIp.name}`,
                  })}
                </p>
              )}
              {reasons.length > 0 && result.problem === null && (
                <ul className="text-fg-muted mt-2 list-disc space-y-0.5 pl-4 text-[11.5px]">
                  {reasons.map((r) => (
                    <li key={r}>{uncertainText(r)}</li>
                  ))}
                </ul>
              )}
              {data.cni.enforcement === 'unknown' && result.problem === null && (
                <p className="text-fg-dim mt-1.5 text-[11px]">
                  {i18n.t('Network plugin not recognised: this assumes it enforces NetworkPolicy.')}
                </p>
              )}
            </div>
          </header>
          {result.groups.map((group, i) => {
            const open =
              openGroups.has(group.signature) ||
              (i === 0 && !openGroups.has(`!${group.signature}`));
            const toggle = () => {
              const next = new Set(openGroups);
              if (open) {
                next.delete(group.signature);
                if (i === 0) next.add(`!${group.signature}`);
              } else {
                next.add(group.signature);
                next.delete(`!${group.signature}`);
              }
              setOpenGroups(next);
            };
            return (
              <div key={group.signature} className="border-border/60 border-t">
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  className="hover:bg-fg/4 flex w-full min-w-0 items-center gap-2 px-4 py-2 text-left"
                >
                  <ChevronDown
                    className={cn(
                      'text-fg-dim h-3.5 w-3.5 shrink-0 transition-transform',
                      !open && '-rotate-90',
                    )}
                  />
                  <CoverageChip coverage={group.coverage} />
                  <span className="text-fg-dim min-w-0 flex-1 truncate text-[11.5px]">
                    {result.groups.length > 1
                      ? i18n.plural(
                          '{count} connection like this',
                          '{count} connections like this',
                          group.count,
                        )
                      : i18n.t('Explanation')}
                  </span>
                </button>
                {open && (
                  <div className="px-4 pt-1 pb-4">
                    <PairExplanation pair={group.example} links={links} />
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
