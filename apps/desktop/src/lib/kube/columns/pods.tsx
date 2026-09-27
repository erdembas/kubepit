import * as i18n from '@/i18n/core';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes, formatCpu } from '@/lib/format';
import type { KubeObject } from '@/types';
import { asArray, asObject, asString, spec, status } from '../accessors';
import {
  containerTone,
  podContainers,
  podIssues,
  podNode,
  podQos,
  podRestarts,
  podStatus,
  podStatusTone,
} from '../pods';
import { cpuMillicores, memoryBytes } from '../quantity';
import {
  ageColumn,
  Dash,
  Muted,
  nameColumn,
  namespaceColumn,
  ownerRef,
  RefLink,
  Tone,
} from './cells';
import type { KindColumns } from './types';

/** Pods table columns (Freelens parity). */

function podRequests(o: KubeObject) {
  let cpu = 0;
  let mem = 0;
  for (const c of asArray(spec(o).containers)) {
    const req = asObject(asObject(asObject(c).resources).requests);
    cpu += cpuMillicores(req.cpu);
    mem += memoryBytes(req.memory);
  }
  return { cpu, mem };
}

export const podColumns: KindColumns = {
  searchText: (o) => `${podStatus(o)} ${podNode(o)} ${asString(status(o).podIP)}`,
  columns: [
    {
      ...nameColumn,
      cell: (o) => {
        const issues = podIssues(o);
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-fg truncate" title={o.metadata.name}>
              {o.metadata.name}
            </span>
            {issues.length > 0 && (
              <span
                title={issues.join('\n')}
                aria-label={issues.join('\n')}
                className="flex shrink-0"
              >
                <TriangleAlert className="text-status-starting h-3.5 w-3.5" />
              </span>
            )}
          </span>
        );
      },
    },
    namespaceColumn,
    {
      id: 'containers',
      label: () => i18n.t('Containers'),
      width: 'minmax(84px, 0.6fr)',
      cell: (o) => (
        <span className="flex flex-wrap items-center gap-[3px]">
          {podContainers(o).map((c) => (
            <span
              key={`${c.init ? 'i' : 'c'}:${c.name}`}
              className={cn(
                'h-2.5 w-2.5 shrink-0 rounded-[2px]',
                containerTone(c),
                c.init && 'scale-75 opacity-80',
              )}
              title={`${c.init ? `${i18n.t('Init container')} · ` : ''}${c.name}\n${c.state}${c.reason ? ` (${c.reason})` : ''}${c.ready ? ` · ${i18n.t('ready')}` : ''}`}
            />
          ))}
        </span>
      ),
      sort: (o) => podContainers(o).length,
      text: (o) => {
        const main = podContainers(o).filter((c) => !c.init);
        return `${main.filter((c) => c.ready).length}/${main.length}`;
      },
      value: (o) =>
        podContainers(o).map((c) => ({
          name: c.name,
          init: c.init,
          state: c.state,
          ready: c.ready,
          restarts: c.restarts,
        })),
    },
    {
      id: 'cpu',
      label: () => i18n.t('CPU'),
      width: '52px',
      align: 'right',
      cell: (o, ctx) => {
        const m = ctx.podMetrics.byKey.get(`${o.metadata.namespace}/${o.metadata.name}`);
        return m ? (
          <Muted title={`${i18n.t('Requests')}: ${formatCpu(podRequests(o).cpu)}`}>
            {formatCpu(m.cpu_millicores)}
          </Muted>
        ) : (
          <Dash />
        );
      },
      sort: (o, ctx) =>
        ctx.podMetrics.byKey.get(`${o.metadata.namespace}/${o.metadata.name}`)?.cpu_millicores ??
        -1,
      value: (o, ctx) =>
        ctx.podMetrics.byKey.get(`${o.metadata.namespace}/${o.metadata.name}`)?.cpu_millicores ??
        null,
    },
    {
      id: 'memory',
      label: () => i18n.t('Memory'),
      width: '64px',
      align: 'right',
      cell: (o, ctx) => {
        const m = ctx.podMetrics.byKey.get(`${o.metadata.namespace}/${o.metadata.name}`);
        return m ? (
          <Muted title={`${i18n.t('Requests')}: ${formatBytes(podRequests(o).mem)}`}>
            {formatBytes(m.memory_bytes)}
          </Muted>
        ) : (
          <Dash />
        );
      },
      sort: (o, ctx) =>
        ctx.podMetrics.byKey.get(`${o.metadata.namespace}/${o.metadata.name}`)?.memory_bytes ?? -1,
      value: (o, ctx) =>
        ctx.podMetrics.byKey.get(`${o.metadata.namespace}/${o.metadata.name}`)?.memory_bytes ??
        null,
    },
    {
      id: 'restarts',
      label: () => i18n.t('Restarts'),
      width: '60px',
      align: 'right',
      cell: (o) => {
        const n = podRestarts(o);
        return (
          <span
            className={cn(
              'tabular-nums',
              n > 5 ? 'text-status-starting font-medium' : 'text-fg-muted',
            )}
          >
            {n}
          </span>
        );
      },
      sort: podRestarts,
    },
    {
      id: 'controlled',
      label: () => i18n.t('Controlled By'),
      width: 'minmax(96px, 0.9fr)',
      cell: (o, ctx) => {
        const ref = ownerRef(o);
        return ref ? <RefLink target={ref} ctx={ctx} label={ref.kind} /> : <Dash />;
      },
      sort: (o) => `${ownerRef(o)?.kind ?? ''}/${ownerRef(o)?.name ?? ''}`,
    },
    {
      id: 'node',
      label: () => i18n.t('Node'),
      width: 'minmax(84px, 1fr)',
      cell: (o, ctx) => {
        const node = podNode(o);
        return node ? (
          <RefLink target={{ apiVersion: 'v1', kind: 'Node', name: node }} ctx={ctx} />
        ) : (
          <Dash />
        );
      },
      sort: podNode,
    },
    {
      id: 'qos',
      label: () => i18n.t('QoS'),
      width: '86px',
      defaultHidden: true,
      cell: (o) => <Muted>{podQos(o)}</Muted>,
      sort: podQos,
    },
    ageColumn,
    {
      id: 'status',
      label: () => i18n.t('Status'),
      width: 'minmax(84px, 1fr)',
      cell: (o) => {
        const s = podStatus(o);
        return <Tone tone={podStatusTone(s)}>{s}</Tone>;
      },
      sort: podStatus,
    },
  ],
};
