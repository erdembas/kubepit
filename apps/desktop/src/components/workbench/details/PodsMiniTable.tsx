import * as i18n from '@/i18n';
import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { RefLink } from '@/lib/kube/columns/cells';
import type { ColumnContext } from '@/lib/kube/columns';
import {
  containerTone,
  podContainers,
  podNode,
  podRestarts,
  podStatus,
  podStatusTone,
} from '@/lib/kube/pods';
import { cn } from '@/lib/cn';
import { formatAge, formatBytes, formatCpu } from '@/lib/format';
import type { KubeObject } from '@/types';
import { useWatch } from '../data/watchCache';
import { MiniTable, ToneText } from './primitives';

const POD_GVK = toGvk(BUILTIN.Pod);

/** Live pods mini-table (matching a selector, on a node, owned by a job…). */
export function PodsMiniTable({
  ctx,
  namespace,
  match,
  isActive,
  showNode = true,
  showNamespace = false,
  limit = 200,
}: {
  ctx: ColumnContext;
  namespace: string | null;
  match: (pod: KubeObject) => boolean;
  isActive: boolean;
  showNode?: boolean;
  showNamespace?: boolean;
  limit?: number;
}) {
  i18n.useLocale();
  const snap = useWatch(ctx.clusterId, POD_GVK, namespace ? [namespace] : [], isActive);
  const pods = useMemo(
    () => snap.items.filter(match).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
    // `match` is recreated by callers each render; the snapshot drives recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap.items],
  );
  if (!snap.synced && !snap.items.length)
    return (
      <p className="text-fg-dim flex items-center gap-2 text-[12px]">
        <Loader2 className="h-3 w-3 animate-spin" />
        {i18n.t('Loading pods…')}
      </p>
    );
  const shown = pods.slice(0, limit);
  return (
    <>
      <MiniTable
        rows={shown}
        rowKey={(p) => p.metadata.uid}
        empty={i18n.t('No pods')}
        rowClass={(p) => (p.metadata.deletionTimestamp ? 'opacity-60' : '')}
        columns={[
          {
            label: i18n.t('Name'),
            className: 'max-w-[240px] truncate whitespace-nowrap',
            cell: (p) => (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="flex shrink-0 gap-[2px]">
                  {podContainers(p)
                    .filter((c) => !c.init)
                    .map((c) => (
                      <span
                        key={c.name}
                        className={cn('h-2 w-2 rounded-[2px]', containerTone(c))}
                      />
                    ))}
                </span>
                <RefLink
                  target={{
                    apiVersion: 'v1',
                    kind: 'Pod',
                    name: p.metadata.name,
                    namespace: p.metadata.namespace ?? null,
                  }}
                  ctx={ctx}
                />
              </span>
            ),
          },
          ...(showNamespace
            ? [{ label: i18n.t('Namespace'), cell: (p: KubeObject) => p.metadata.namespace ?? '—' }]
            : []),
          ...(showNode
            ? [
                {
                  label: i18n.t('Node'),
                  className: 'max-w-[150px] truncate whitespace-nowrap',
                  cell: (p: KubeObject) => <span title={podNode(p)}>{podNode(p) || '—'}</span>,
                },
              ]
            : []),
          ...(ctx.podMetrics.available
            ? [
                {
                  label: i18n.t('Usage'),
                  className: 'text-right whitespace-nowrap',
                  cell: (p: KubeObject) => {
                    const m = ctx.podMetrics.byKey.get(
                      `${p.metadata.namespace}/${p.metadata.name}`,
                    );
                    return m
                      ? `${formatCpu(m.cpu_millicores)} · ${formatBytes(m.memory_bytes)}`
                      : '—';
                  },
                },
              ]
            : []),
          {
            label: i18n.t('Restarts'),
            className: 'text-right tabular-nums',
            cell: (p) => podRestarts(p),
          },
          {
            label: i18n.t('Age'),
            className: 'text-right whitespace-nowrap',
            cell: (p) => formatAge(p.metadata.creationTimestamp, ctx.now),
          },
          {
            label: i18n.t('Status'),
            className: 'whitespace-nowrap',
            cell: (p) => <ToneText tone={podStatusTone(podStatus(p))}>{podStatus(p)}</ToneText>,
          },
        ]}
      />
      {pods.length > limit && (
        <p className="text-fg-dim mt-1.5 text-[11px]">
          {i18n.t('+{count} more', { count: pods.length - limit })}
        </p>
      )}
    </>
  );
}
