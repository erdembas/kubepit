import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { Radar, ShieldCheck, ShieldOff, ShieldX } from 'lucide-react';
import { cn } from '@/lib/cn';
import { protectionList, type NpPolicy, type Protection } from '@/lib/kube/netpol';
import type { ClusterId } from '@/types';
import { Card, StatTile } from '../overview/charts';
import { PolicyLink, type ExplainLinks } from './Explanation';
import { openNetpolSimulator } from './netpolStore';
import type { NetpolData } from './useNetpolData';

/** Isolated pods and pods with no ingress / egress protection, per workload. */

type Filter = 'all' | 'ingress-open' | 'egress-open' | 'isolated' | 'deny-all';

type State = Protection['ingress'];

function stateLabel(state: State): string {
  switch (state) {
    case 'open':
      return i18n.t('Open');
    case 'isolated':
      return i18n.t('Isolated');
    case 'deny-all':
      return i18n.t('Deny all');
    default:
      return i18n.t('Host network');
  }
}

function StateChip({
  state,
  policies,
  direction,
  links,
}: {
  state: State;
  policies: readonly NpPolicy[];
  direction: 'ingress' | 'egress';
  links: ExplainLinks;
}) {
  const [open, setOpen] = useState(false);
  const tone =
    state === 'open'
      ? 'text-status-starting bg-status-starting/10'
      : state === 'deny-all'
        ? 'text-status-error bg-status-error/10'
        : state === 'isolated'
          ? 'text-status-running bg-status-running/10'
          : 'text-fg-dim bg-fg/6';
  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={!policies.length}
        onClick={() => setOpen((x) => !x)}
        title={
          direction === 'ingress'
            ? i18n.plural(
                '{count} policy isolates ingress',
                '{count} policies isolate ingress',
                policies.length,
              )
            : i18n.plural(
                '{count} policy isolates egress',
                '{count} policies isolate egress',
                policies.length,
              )
        }
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
          tone,
          policies.length > 0 && 'hover:ring-border-strong ring-1 ring-transparent',
        )}
      >
        {stateLabel(state)}
        {policies.length > 0 && (
          <span className="tabular-nums opacity-70">· {policies.length}</span>
        )}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-0.5">
          {policies.map((p) => (
            <PolicyLink key={p.uid} policy={p} links={links} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ProtectionPanel({
  clusterId,
  data,
  namespaces,
  links,
}: {
  clusterId: ClusterId;
  data: NetpolData;
  namespaces: readonly string[];
  links: ExplainLinks;
}) {
  i18n.useLocale();
  const [filter, setFilter] = useState<Filter>('all');
  const list = useMemo(() => protectionList(data.cluster, namespaces), [data.cluster, namespaces]);
  const counts = useMemo(
    () => ({
      all: list.length,
      'ingress-open': list.filter((p) => p.ingress === 'open').length,
      'egress-open': list.filter((p) => p.egress === 'open').length,
      isolated: list.filter((p) => p.ingress !== 'open' && p.egress !== 'open').length,
      'deny-all': list.filter((p) => p.ingress === 'deny-all' || p.egress === 'deny-all').length,
    }),
    [list],
  );
  const shown = list.filter((p) =>
    filter === 'all'
      ? true
      : filter === 'ingress-open'
        ? p.ingress === 'open'
        : filter === 'egress-open'
          ? p.egress === 'open'
          : filter === 'isolated'
            ? p.ingress !== 'open' && p.egress !== 'open'
            : p.ingress === 'deny-all' || p.egress === 'deny-all',
  );
  const filters: Array<[Filter, string]> = [
    ['all', i18n.t('All')],
    ['ingress-open', i18n.t('No ingress protection')],
    ['egress-open', i18n.t('No egress protection')],
    ['isolated', i18n.t('Isolated both ways')],
    ['deny-all', i18n.t('Deny all')],
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <StatTile label={i18n.t('Workloads')} value={counts.all} onClick={() => setFilter('all')} />
        <StatTile
          icon={<ShieldOff className="text-status-starting" />}
          label={i18n.t('Ingress open')}
          value={counts['ingress-open']}
          tone={counts['ingress-open'] ? 'text-status-starting' : undefined}
          onClick={() => setFilter('ingress-open')}
        />
        <StatTile
          icon={<ShieldOff className="text-status-starting" />}
          label={i18n.t('Egress open')}
          value={counts['egress-open']}
          tone={counts['egress-open'] ? 'text-status-starting' : undefined}
          onClick={() => setFilter('egress-open')}
        />
        <StatTile
          icon={<ShieldCheck className="text-status-running" />}
          label={i18n.t('Isolated')}
          value={counts.isolated}
          sub={i18n.t('both directions')}
          onClick={() => setFilter('isolated')}
        />
      </div>
      <Card
        title={i18n.t('Isolation by workload')}
        icon={<ShieldX />}
        actions={
          <span className="text-fg-dim text-[11px] tabular-nums">
            {i18n.plural('{count} workload', '{count} workloads', shown.length)}
          </span>
        }
      >
        <div
          role="radiogroup"
          aria-label={i18n.t('Filter workloads')}
          className="border-border/60 overlay-scroll flex items-center gap-1 overflow-x-auto border-b px-3 py-1.5"
        >
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition',
                filter === id
                  ? 'bg-fg/7 text-fg font-medium'
                  : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
              )}
            >
              {label}
              <span className="text-fg-dim tabular-nums">{counts[id]}</span>
            </button>
          ))}
        </div>
        {!shown.length ? (
          <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
            {list.length
              ? i18n.t('Nothing matches this filter.')
              : i18n.t('No running pods in scope.')}
          </p>
        ) : (
          <ul className="divide-border/60 divide-y">
            <li className="text-fg-dim hidden grid-cols-[minmax(0,1fr)_7rem_7rem_2rem] gap-3 px-4 py-1.5 text-[10.5px] font-semibold tracking-[0.12em] uppercase @xl:grid">
              <span>{i18n.t('Workload')}</span>
              <span>{i18n.t('Ingress')}</span>
              <span>{i18n.t('Egress')}</span>
              <span />
            </li>
            {shown.slice(0, 500).map((p) => (
              <li
                key={p.group.key}
                className="hover:bg-fg/3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-4 py-2 @xl:grid-cols-[minmax(0,1fr)_7rem_7rem_2rem] @xl:items-center"
              >
                <div className="min-w-0">
                  <div
                    className="text-fg truncate text-[12px] font-medium"
                    title={p.group.workload.name}
                  >
                    {p.group.workload.name}
                  </div>
                  <div className="text-fg-dim truncate text-[11px]">
                    {p.group.workload.kind} · {p.group.namespace} ·{' '}
                    {i18n.plural('{count} pod', '{count} pods', p.group.pods.length)}
                  </div>
                </div>
                <div className="col-start-1 flex flex-wrap items-center gap-2 @xl:contents">
                  <span className="text-fg-dim text-[10.5px] @xl:hidden">{i18n.t('Ingress')}</span>
                  <StateChip
                    state={p.ingress}
                    policies={p.ingressPolicies}
                    direction="ingress"
                    links={links}
                  />
                  <span className="text-fg-dim text-[10.5px] @xl:hidden">{i18n.t('Egress')}</span>
                  <StateChip
                    state={p.egress}
                    policies={p.egressPolicies}
                    direction="egress"
                    links={links}
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    openNetpolSimulator(clusterId, {
                      mode: 'simulate',
                      destination: {
                        type: 'workload',
                        namespace: p.group.namespace,
                        kind: p.group.workload.kind,
                        name: p.group.workload.name,
                      },
                    })
                  }
                  title={i18n.t('Simulate traffic to this workload')}
                  aria-label={i18n.t('Simulate traffic to this workload')}
                  className="text-fg-dim hover:bg-fg/5 hover:text-fg col-start-2 row-start-1 flex h-7 w-7 items-center justify-center self-start rounded-md @xl:col-start-auto @xl:row-start-auto @xl:self-center"
                >
                  <Radar className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            {shown.length > 500 && (
              <li className="text-fg-dim px-4 py-2 text-[11px]">
                {i18n.t('and {count} more', { count: shown.length - 500 })}
              </li>
            )}
          </ul>
        )}
      </Card>
    </div>
  );
}
