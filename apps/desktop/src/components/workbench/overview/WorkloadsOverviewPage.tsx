import * as i18n from '@/i18n';
import { useEffect } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { refreshOverview } from '@/lib/clusterActions';
import { BUILTIN, toGvk, type KindDef } from '@/lib/kube/catalog';
import { kindIcon } from '@/lib/kube/icons';
import { podBucket } from '@/lib/kube/pods';
import { cronActive, cronSuspended, jobBucket, workloadBucket } from '@/lib/kube/workloads';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, KubeObject } from '@/types';
import { useWatch } from '../data/watchCache';
import { useNow } from '../util';
import { Card, Legend, Ring, type Segment } from './charts';
import { WarningList } from './WarningList';

type Bucketer = (items: readonly KubeObject[]) => Segment[];

// Literal class names keep Tailwind's scanner happy.
const COLORS = {
  running: { stroke: 'stroke-status-running', fill: 'bg-status-running' },
  pending: { stroke: 'stroke-status-starting', fill: 'bg-status-starting' },
  failed: { stroke: 'stroke-status-error', fill: 'bg-status-error' },
  muted: { stroke: 'stroke-fg-dim', fill: 'bg-fg-dim/60' },
  info: { stroke: 'stroke-cat-frontend', fill: 'bg-cat-frontend' },
};

function colored(key: keyof typeof COLORS, label: string, value: number): Segment {
  return { key: `${key}:${label}`, label, value, ...COLORS[key] };
}

function count<T extends string>(items: readonly KubeObject[], fn: (o: KubeObject) => T) {
  const out = {} as Record<T, number>;
  for (const o of items) {
    const k = fn(o);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const workloadSegments: Bucketer = (items) => {
  const c = count(items, workloadBucket);
  return [
    colored('running', i18n.t('Running'), c.running ?? 0),
    colored('pending', i18n.t('Pending'), c.pending ?? 0),
    colored('failed', i18n.t('Failed'), c.failed ?? 0),
    colored('muted', i18n.t('Scaled to zero'), c.idle ?? 0),
  ];
};

const TILES: Array<{ def: KindDef; segments: Bucketer }> = [
  {
    def: BUILTIN.Pod,
    segments: (items) => {
      const c = count(items, podBucket);
      return [
        colored('running', i18n.t('Running'), c.running ?? 0),
        colored('pending', i18n.t('Pending'), c.pending ?? 0),
        colored('failed', i18n.t('Failed'), c.failed ?? 0),
        colored('muted', i18n.t('Succeeded'), c.succeeded ?? 0),
        colored('info', i18n.t('Terminating'), c.terminating ?? 0),
      ];
    },
  },
  { def: BUILTIN.Deployment, segments: workloadSegments },
  { def: BUILTIN.DaemonSet, segments: workloadSegments },
  { def: BUILTIN.StatefulSet, segments: workloadSegments },
  { def: BUILTIN.ReplicaSet, segments: workloadSegments },
  {
    def: BUILTIN.Job,
    segments: (items) => {
      const c = count(items, jobBucket);
      return [
        colored('running', i18n.t('Succeeded'), c.succeeded ?? 0),
        colored('info', i18n.t('Running'), c.running ?? 0),
        colored('failed', i18n.t('Failed'), c.failed ?? 0),
        colored('muted', i18n.t('Suspended'), c.suspended ?? 0),
      ];
    },
  },
  {
    def: BUILTIN.CronJob,
    segments: (items) => {
      const suspended = items.filter(cronSuspended).length;
      const active = items.filter((o) => !cronSuspended(o) && cronActive(o) > 0).length;
      return [
        colored('running', i18n.t('Scheduled'), items.length - suspended - active),
        colored('info', i18n.t('Active'), active),
        colored('muted', i18n.t('Suspended'), suspended),
      ];
    },
  },
];

function WorkloadTile({
  clusterId,
  def,
  namespaces,
  isActive,
  segments,
}: {
  clusterId: string;
  def: KindDef;
  namespaces: string[];
  isActive: boolean;
  segments: Bucketer;
}) {
  i18n.useLocale();
  const snap = useWatch(clusterId, toGvk(def), namespaces, isActive);
  const Icon = kindIcon(def.key);
  const segs = segments(snap.items);
  const loading = !snap.synced && !snap.items.length;
  return (
    <button
      type="button"
      onClick={() => useWorkbenchStore.getState().setActiveKind(clusterId, def.key)}
      className="rounded-app border-border bg-surface-raised/40 hover:border-border-strong hover:bg-surface-raised group flex flex-col border text-left transition"
    >
      <div className="border-border/60 flex w-full items-center gap-2 border-b px-4 py-2">
        <Icon className="text-fg-dim group-hover:text-accent h-3.5 w-3.5 transition-colors" />
        <span className="text-fg text-[12.5px] font-semibold">{def.title}</span>
        <span className="bg-surface-muted text-fg-dim ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {snap.items.length}
        </span>
      </div>
      <div className="flex items-center gap-4 p-4">
        <Ring segments={segs} size={84} stroke={9} label={def.title}>
          {loading ? (
            <Loader2 className="text-fg-dim h-4 w-4 animate-spin" />
          ) : (
            <span className="text-fg text-[16px] font-semibold tabular-nums">
              {snap.items.length}
            </span>
          )}
        </Ring>
        <Legend
          className="min-w-0 flex-1"
          items={segs
            .filter((s) => s.value > 0 || s.key.startsWith('running'))
            .map((s) => ({ key: s.key, label: s.label, value: s.value, fill: s.fill }))}
        />
      </div>
      {snap.error && (
        <p className="text-status-error border-border/60 border-t px-4 py-1.5 text-[11px]">
          {snap.forbidden ? i18n.t('Access denied') : snap.error}
        </p>
      )}
    </button>
  );
}

export function WorkloadsOverviewPage({
  clusterId,
  namespaces,
  isActive,
  apiResources,
}: {
  clusterId: string;
  namespaces: string[];
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const overview = useAppStore((s) => s.overviews[clusterId]);
  const now = useNow(30_000, isActive);
  useEffect(() => {
    if (isActive && !overview) void refreshOverview(clusterId);
  }, [isActive, overview, clusterId]);
  const warnings = (overview?.warnings ?? []).filter(
    (e) => !namespaces.length || namespaces.includes(e.metadata.namespace ?? ''),
  );
  return (
    <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-5">
        <div>
          <h2 className="text-fg text-[16px] font-semibold tracking-tight">
            {i18n.t('Workloads')}
          </h2>
          <p className="text-fg-dim mt-0.5 text-[11.5px]">
            {namespaces.length
              ? i18n.t('Namespaces: {list}', { list: namespaces.join(', ') })
              : i18n.t('All namespaces')}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {TILES.map((t) => (
            <WorkloadTile
              key={t.def.key}
              clusterId={clusterId}
              def={t.def}
              namespaces={namespaces}
              isActive={isActive}
              segments={t.segments}
            />
          ))}
        </div>
        <Card title={i18n.t('Recent warnings')} icon={<TriangleAlert />}>
          <WarningList
            clusterId={clusterId}
            events={warnings}
            apiResources={apiResources}
            now={now}
          />
        </Card>
      </div>
    </div>
  );
}
