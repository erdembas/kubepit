import * as i18n from '@/i18n';
import { useEffect } from 'react';
import {
  Box,
  Cpu,
  FolderTree,
  Loader2,
  MemoryStick,
  RefreshCw,
  Rocket,
  Server,
  TriangleAlert,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { refreshOverview } from '@/lib/clusterActions';
import { formatBytes, formatCpu, formatPercent } from '@/lib/format';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, Quantity } from '@/types';
import { useNow } from '../util';
import { Card, GaugeRings, Legend, SegmentBar, StatTile, type Gauge, type Segment } from './charts';
import { WarningList } from './WarningList';

function ResourceCard({
  title,
  icon,
  usage,
  requests,
  limits,
  allocatable,
  capacity,
  format,
}: {
  title: string;
  icon: React.ReactNode;
  usage: number | null;
  requests: number;
  limits: number;
  allocatable: number;
  capacity: number;
  format: (n: number) => string;
}) {
  i18n.useLocale();
  const pct = (n: number) => (allocatable ? formatPercent((n / allocatable) * 100) : '—');
  const gauges: Gauge[] = [
    ...(usage !== null
      ? [
          {
            key: 'usage',
            label: i18n.t('Usage'),
            value: usage,
            stroke: 'stroke-accent',
            fill: 'bg-accent',
          },
        ]
      : []),
    {
      key: 'requests',
      label: i18n.t('Requests'),
      value: requests,
      stroke: 'stroke-cat-frontend',
      fill: 'bg-cat-frontend',
    },
    {
      key: 'limits',
      label: i18n.t('Limits'),
      value: limits,
      stroke: 'stroke-cat-backend',
      fill: 'bg-cat-backend',
    },
  ];
  const headline = usage ?? requests;
  return (
    <Card title={title} icon={icon}>
      <div className="flex items-center gap-4 p-4">
        <GaugeRings gauges={gauges} max={allocatable} label={title} size={108}>
          <span className="text-fg text-[15px] font-semibold tabular-nums">{pct(headline)}</span>
          <span className="text-fg-dim text-[10px] tracking-wide uppercase">
            {usage !== null ? i18n.t('used') : i18n.t('requested')}
          </span>
        </GaugeRings>
        <Legend
          className="min-w-0 flex-1"
          items={[
            ...gauges.map((g) => ({
              key: g.key,
              label: g.label,
              fill: g.fill,
              value: format(g.value),
              pct: pct(g.value),
            })),
            {
              key: 'alloc',
              label: i18n.t('Allocatable'),
              fill: 'bg-fg/20',
              value: format(allocatable),
              pct: '',
            },
            {
              key: 'cap',
              label: i18n.t('Capacity'),
              fill: 'bg-fg/10',
              value: format(capacity),
              pct: '',
            },
          ]}
        />
      </div>
      {usage === null && (
        <p className="text-fg-dim border-border/60 border-t px-4 py-2 text-[11px]">
          {i18n.t('Usage needs metrics-server; showing requests and limits.')}
        </p>
      )}
    </Card>
  );
}

export function ClusterOverviewPage({
  clusterId,
  isActive,
  apiResources,
}: {
  clusterId: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const overview = useAppStore((s) => s.overviews[clusterId]);
  const error = useAppStore((s) => s.overviewErrors[clusterId]);
  const now = useNow(30_000, isActive);
  const go = (key: string) => useWorkbenchStore.getState().setActiveKind(clusterId, key);

  useEffect(() => {
    if (!isActive) return;
    void refreshOverview(clusterId);
    const id = window.setInterval(() => void refreshOverview(clusterId), 20_000);
    return () => window.clearInterval(id);
  }, [clusterId, isActive]);

  if (!overview)
    return (
      <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 p-8 text-[12.5px]">
        {error ? (
          <span className="text-status-error">{error}</span>
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Loading cluster overview…')}
          </>
        )}
      </div>
    );

  const o = overview;
  const usage: Quantity | null = o.usage;
  const phases: Segment[] = [
    {
      key: 'running',
      label: i18n.t('Running'),
      value: o.pods.running,
      stroke: 'stroke-status-running',
      fill: 'bg-status-running',
    },
    {
      key: 'pending',
      label: i18n.t('Pending'),
      value: o.pods.pending,
      stroke: 'stroke-status-starting',
      fill: 'bg-status-starting',
    },
    {
      key: 'failed',
      label: i18n.t('Failed'),
      value: o.pods.failed,
      stroke: 'stroke-status-error',
      fill: 'bg-status-error',
    },
    {
      key: 'succeeded',
      label: i18n.t('Succeeded'),
      value: o.pods.succeeded,
      stroke: 'stroke-fg-dim',
      fill: 'bg-fg-dim/60',
    },
    {
      key: 'unknown',
      label: i18n.t('Unknown'),
      value: o.pods.unknown,
      stroke: 'stroke-fg/20',
      fill: 'bg-fg/20',
    },
  ];
  const nodesTone = o.nodes.ready < o.nodes.total ? 'text-status-starting' : 'text-fg';

  return (
    <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-5">
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-fg text-[16px] font-semibold tracking-tight">
              {i18n.t('Cluster overview')}
            </h2>
            <p className="text-fg-dim mt-0.5 text-[11.5px]">
              {[o.platform, o.version].filter(Boolean).join(' · ')}
              {' · '}
              {i18n.t('refreshes every 20s')}
            </p>
          </div>
          <IconButton
            className="ml-auto"
            label={i18n.t('Refresh')}
            icon={<RefreshCw />}
            onClick={() => void refreshOverview(clusterId)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            icon={<Server />}
            label={i18n.t('Nodes')}
            value={`${o.nodes.ready}/${o.nodes.total}`}
            tone={nodesTone}
            sub={i18n.t('ready')}
            onClick={() => go('nodes')}
          />
          <StatTile
            icon={<Box />}
            label={i18n.t('Pods')}
            value={o.pods.total}
            sub={i18n.t('{running} running · {pending} pending · {failed} failed', {
              running: o.pods.running,
              pending: o.pods.pending,
              failed: o.pods.failed,
            })}
            onClick={() => go('pods')}
          />
          <StatTile
            icon={<FolderTree />}
            label={i18n.t('Namespaces')}
            value={o.namespaces}
            onClick={() => go('namespaces')}
          />
          <StatTile
            icon={<Rocket />}
            label={i18n.t('Deployments')}
            value={`${o.deployments.available}/${o.deployments.total}`}
            tone={
              o.deployments.available < o.deployments.total ? 'text-status-starting' : 'text-fg'
            }
            sub={i18n.t('available')}
            onClick={() => go('deployments.apps')}
          />
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <ResourceCard
            title={i18n.t('CPU')}
            icon={<Cpu />}
            usage={usage?.cpu_millicores ?? null}
            requests={o.requests.cpu_millicores}
            limits={o.limits.cpu_millicores}
            allocatable={o.allocatable.cpu_millicores}
            capacity={o.capacity.cpu_millicores}
            format={formatCpu}
          />
          <ResourceCard
            title={i18n.t('Memory')}
            icon={<MemoryStick />}
            usage={usage?.memory_bytes ?? null}
            requests={o.requests.memory_bytes}
            limits={o.limits.memory_bytes}
            allocatable={o.allocatable.memory_bytes}
            capacity={o.capacity.memory_bytes}
            format={formatBytes}
          />
          <Card title={i18n.t('Pods')} icon={<Box />}>
            <div className="flex items-center gap-4 p-4">
              <GaugeRings
                gauges={[
                  {
                    key: 'pods',
                    label: i18n.t('Pods'),
                    value: o.pods.total - o.pods.succeeded,
                    stroke: 'stroke-accent',
                    fill: 'bg-accent',
                  },
                ]}
                max={o.allocatable.pods}
                label={i18n.t('Pods')}
                size={108}
              >
                <span className="text-fg text-[15px] font-semibold tabular-nums">
                  {o.allocatable.pods
                    ? formatPercent(((o.pods.total - o.pods.succeeded) / o.allocatable.pods) * 100)
                    : '—'}
                </span>
                <span className="text-fg-dim text-[10px] tracking-wide uppercase">
                  {i18n.t('of slots')}
                </span>
              </GaugeRings>
              <Legend
                className="min-w-0 flex-1"
                items={[
                  {
                    key: 'scheduled',
                    label: i18n.t('Scheduled'),
                    fill: 'bg-accent',
                    value: o.pods.total - o.pods.succeeded,
                  },
                  {
                    key: 'alloc',
                    label: i18n.t('Allocatable'),
                    fill: 'bg-fg/20',
                    value: o.allocatable.pods,
                  },
                  {
                    key: 'cap',
                    label: i18n.t('Capacity'),
                    fill: 'bg-fg/10',
                    value: o.capacity.pods,
                  },
                ]}
              />
            </div>
          </Card>
        </div>
        <Card title={i18n.t('Pods by phase')} icon={<Box />}>
          <div className="space-y-3 p-4">
            <SegmentBar segments={phases} label={i18n.t('Pods by phase')} />
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {phases.map((p) => (
                <span key={p.key} className="flex items-center gap-1.5 text-[11.5px]">
                  <span className={`h-2 w-2 rounded-sm ${p.fill}`} />
                  <span className="text-fg-muted">{p.label}</span>
                  <span className="text-fg tabular-nums">{p.value}</span>
                </span>
              ))}
            </div>
          </div>
        </Card>
        <Card
          title={i18n.t('Warnings')}
          icon={<TriangleAlert />}
          actions={
            <button
              type="button"
              onClick={() => go('events')}
              className="text-fg-dim hover:text-accent text-[11px]"
            >
              {i18n.t('All events')}
            </button>
          }
        >
          <WarningList
            clusterId={clusterId}
            events={o.warnings}
            apiResources={apiResources}
            now={now}
          />
        </Card>
      </div>
    </div>
  );
}
