import * as i18n from '@/i18n/core';
import { cn } from '@/lib/cn';
import { formatAge, formatBytes, formatCpu } from '@/lib/format';
import type { KubeObject } from '@/types';
import { asNumber, asObject, asString, field, lastTimestamp, status } from '../accessors';
import {
  nodeConditions,
  nodeResources,
  nodeRoles,
  nodeTaints,
  nodeVersion,
  phaseTone,
  taintText,
} from '../workloads';
import {
  ageColumn,
  ConditionWords,
  Dash,
  labelsColumn,
  Muted,
  nameColumn,
  namespaceColumn,
  RefLink,
  Tone,
  UsageBar,
} from './cells';
import type { ColumnContext, KindColumns } from './types';

function nodeUsage(o: KubeObject, ctx: ColumnContext, which: 'cpu' | 'memory') {
  const m = ctx.nodeMetrics.byKey.get(o.metadata.name);
  const alloc = nodeResources(o, 'allocatable');
  if (!m) return null;
  return which === 'cpu'
    ? { used: m.cpu_millicores, total: alloc.cpu }
    : { used: m.memory_bytes, total: alloc.memory };
}

export const nodeColumns: KindColumns = {
  searchText: (o) =>
    `${nodeRoles(o).join(' ')} ${nodeVersion(o)} ${nodeConditions(o)
      .map((c) => c.label)
      .join(' ')}`,
  columns: [
    nameColumn,
    {
      id: 'cpu',
      label: () => i18n.t('CPU'),
      width: 'minmax(96px, 1fr)',
      cell: (o, ctx) => {
        const u = nodeUsage(o, ctx, 'cpu');
        const alloc = nodeResources(o, 'allocatable');
        return u ? (
          <UsageBar
            used={u.used}
            total={u.total}
            label={`${formatCpu(u.used)} / ${formatCpu(u.total)}`}
          />
        ) : (
          <Muted>{formatCpu(alloc.cpu)}</Muted>
        );
      },
      sort: (o, ctx) => {
        const u = nodeUsage(o, ctx, 'cpu');
        return u ? u.used / Math.max(1, u.total) : nodeResources(o, 'allocatable').cpu;
      },
    },
    {
      id: 'memory',
      label: () => i18n.t('Memory'),
      width: 'minmax(96px, 1fr)',
      cell: (o, ctx) => {
        const u = nodeUsage(o, ctx, 'memory');
        const alloc = nodeResources(o, 'allocatable');
        return u ? (
          <UsageBar
            used={u.used}
            total={u.total}
            label={`${formatBytes(u.used)} / ${formatBytes(u.total)}`}
          />
        ) : (
          <Muted>{formatBytes(alloc.memory)}</Muted>
        );
      },
      sort: (o, ctx) => {
        const u = nodeUsage(o, ctx, 'memory');
        return u ? u.used / Math.max(1, u.total) : nodeResources(o, 'allocatable').memory;
      },
    },
    {
      id: 'disk',
      label: () => i18n.t('Disk'),
      width: '72px',
      align: 'right',
      defaultHidden: true,
      cell: (o) => <Muted>{formatBytes(nodeResources(o, 'capacity').storage)}</Muted>,
      sort: (o) => nodeResources(o, 'capacity').storage,
    },
    {
      id: 'taints',
      label: () => i18n.t('Taints'),
      width: '64px',
      align: 'right',
      cell: (o) => {
        const t = nodeTaints(o);
        return t.length ? (
          <span className="text-fg-muted tabular-nums" title={t.map(taintText).join('\n')}>
            {t.length}
          </span>
        ) : (
          <Dash />
        );
      },
      sort: (o) => nodeTaints(o).length,
    },
    {
      id: 'roles',
      label: () => i18n.t('Roles'),
      width: 'minmax(90px, 1fr)',
      cell: (o) => <Muted>{nodeRoles(o).join(', ') || '<none>'}</Muted>,
      sort: (o) => nodeRoles(o).join(','),
    },
    {
      id: 'version',
      label: () => i18n.t('Version'),
      width: 'minmax(96px, 1fr)',
      cell: (o) => <Muted>{nodeVersion(o)}</Muted>,
      sort: nodeVersion,
    },
    ageColumn,
    {
      id: 'conditions',
      label: () => i18n.t('Conditions'),
      width: 'minmax(120px, 1.4fr)',
      cell: (o) => <ConditionWords chips={nodeConditions(o)} />,
      sort: (o) =>
        nodeConditions(o)
          .map((c) => c.label)
          .join(','),
    },
  ],
};

export const namespaceColumns: KindColumns = {
  columns: [
    nameColumn,
    { ...labelsColumn(false), width: 'minmax(200px, 3fr)' },
    ageColumn,
    {
      id: 'status',
      label: () => i18n.t('Status'),
      width: '96px',
      cell: (o) => {
        const phase = o.metadata.deletionTimestamp
          ? 'Terminating'
          : asString(status(o).phase) || 'Active';
        return <Tone tone={phaseTone(phase)}>{phase}</Tone>;
      },
      sort: (o) => asString(status(o).phase),
    },
  ],
};

function involved(o: KubeObject) {
  const io = asObject(field(o, 'involvedObject'));
  return {
    apiVersion: asString(io.apiVersion) || undefined,
    kind: asString(io.kind),
    name: asString(io.name),
    namespace: asString(io.namespace) || null,
  };
}

function eventSource(o: KubeObject) {
  const src = asObject(field(o, 'source'));
  const component = asString(src.component) || asString(field(o, 'reportingComponent'));
  const host = asString(src.host);
  return [component, host].filter(Boolean).join(' ');
}

export const eventColumns: KindColumns = {
  defaultSort: { column: 'lastSeen', desc: false },
  searchText: (o) =>
    `${asString(field(o, 'reason'))} ${asString(field(o, 'message'))} ${involved(o).kind} ${involved(o).name} ${asString(field(o, 'type'))}`,
  columns: [
    {
      id: 'type',
      label: () => i18n.t('Type'),
      width: '76px',
      cell: (o) => {
        const type = asString(field(o, 'type'));
        return (
          <span
            className={cn(
              'font-medium',
              type === 'Warning' ? 'text-status-starting' : 'text-fg-dim',
            )}
          >
            {type}
          </span>
        );
      },
      sort: (o) => asString(field(o, 'type')),
    },
    {
      id: 'message',
      label: () => i18n.t('Message'),
      width: 'minmax(260px, 4fr)',
      fixed: true,
      cell: (o) => (
        <span className="text-fg min-w-0 truncate" title={asString(field(o, 'message'))}>
          <span className="text-fg-muted mr-1.5 font-medium">{asString(field(o, 'reason'))}</span>
          {asString(field(o, 'message'))}
        </span>
      ),
      sort: (o) => asString(field(o, 'reason')),
    },
    namespaceColumn,
    {
      id: 'object',
      label: () => i18n.t('Involved Object'),
      width: 'minmax(160px, 1.6fr)',
      cell: (o, ctx) => {
        const ref = involved(o);
        return ref.name ? (
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="text-fg-dim shrink-0 text-[10.5px]">{ref.kind}</span>
            <RefLink target={ref} ctx={ctx} />
          </span>
        ) : (
          <Dash />
        );
      },
      sort: (o) => `${involved(o).kind}/${involved(o).name}`,
    },
    {
      id: 'source',
      label: () => i18n.t('Source'),
      width: 'minmax(110px, 1fr)',
      cell: (o) => <Muted title={eventSource(o)}>{eventSource(o) || '—'}</Muted>,
      sort: eventSource,
    },
    {
      id: 'count',
      label: () => i18n.t('Count'),
      width: '60px',
      align: 'right',
      cell: (o) => <Muted>{asNumber(field(o, 'count'), 1)}</Muted>,
      sort: (o) => asNumber(field(o, 'count'), 1),
    },
    { ...ageColumn, defaultHidden: true },
    {
      id: 'lastSeen',
      label: () => i18n.t('Last Seen'),
      width: '84px',
      align: 'right',
      cell: (o, ctx) => {
        const t = lastTimestamp(o);
        return (
          <span className="text-fg-muted tabular-nums" title={t}>
            {formatAge(t, ctx.now)}
          </span>
        );
      },
      sort: (o) => -Date.parse(lastTimestamp(o) ?? '0'),
    },
  ],
};
