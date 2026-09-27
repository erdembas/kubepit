import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { asArray, asObject, isObject, spec } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import { matchesSelector, parseSelector } from '@/lib/kube/selectors';
import { nodeResources } from '@/lib/kube/workloads';
import { Select } from '@/components/ui/Select';
import type { KubeObject, MetricsHistoryQuery, PrometheusTarget } from '@/types';
import { useWatch } from '../data/watchCache';
import {
  MetricsRangeToggle,
  MetricsSourceNote,
  PromRangeToggle,
} from '../metrics/PrometheusControls';
import { PrometheusUsage, mainQuery } from '../metrics/PrometheusUsage';
import { type RefKey, type UsageRefs } from '../metrics/UsageHistory';
import { UsageMetrics } from '../metrics/UsageMetrics';
import { useMetricsHistory } from '../metrics/useMetricsHistory';
import {
  usePrometheusAvailable,
  usePrometheusMetrics,
  usePrometheusStatus,
  usePromRange,
} from '../metrics/usePrometheus';
import { Section } from './primitives';
import type { SectionProps } from './sections/types';

/**
 * "Usage history" sections of the details panel (nodes, pods, workloads,
 * namespaces, PVCs). Each is a self-contained component so detail sections
 * mount it with one line. Charts come from Prometheus when the cluster has
 * one, otherwise from the metrics-server history; a section renders
 * nothing when neither source has data for its kind.
 */

type Props = Pick<SectionProps, 'obj' | 'ctx' | 'isActive'>;

const POD_GVK = toGvk(BUILTIN.Pod);
const NO_REFS: UsageRefs = { cpu: {}, memory: {} };

/** Summed container requests / limits of `pods` (running or pending). */
function podResources(pods: readonly KubeObject[], container?: string | null): UsageRefs {
  const refs = {
    cpu: { requests: 0, limits: 0 },
    memory: { requests: 0, limits: 0 },
  };
  for (const pod of pods) {
    const phase = (pod.status as { phase?: string } | undefined)?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    for (const c of asArray(spec(pod).containers).filter(isObject)) {
      if (container && c.name !== container) continue;
      const res = asObject(c.resources);
      const req = asObject(res.requests);
      const lim = asObject(res.limits);
      refs.cpu.requests += cpuMillicores(req.cpu);
      refs.cpu.limits += cpuMillicores(lim.cpu);
      refs.memory.requests += memoryBytes(req.memory);
      refs.memory.limits += memoryBytes(lim.memory);
    }
  }
  return refs;
}

function HistorySection({
  clusterId,
  query,
  target,
  isActive,
  refs,
  prefsKey,
  defaultRefs,
  extraActions,
}: {
  clusterId: string;
  query: MetricsHistoryQuery | null;
  target: PrometheusTarget | null;
  isActive: boolean;
  refs: UsageRefs;
  prefsKey: string;
  defaultRefs: RefKey[];
  extraActions?: React.ReactNode;
}) {
  i18n.useLocale();
  const prom = usePrometheusAvailable(clusterId, isActive) && !!target;
  // Same polled entry as the charts below (shared by key): no extra request.
  const state = useMetricsHistory(clusterId, prom ? null : query, isActive);
  if (!prom && state.data && !state.data.available) return null;
  return (
    <Section
      title={i18n.t('Usage history')}
      actions={
        <>
          {prom && extraActions}
          <MetricsRangeToggle clusterId={clusterId} enabled={isActive} />
        </>
      }
    >
      <UsageMetrics
        clusterId={clusterId}
        historyQuery={query}
        promTarget={target}
        enabled={isActive}
        refs={refs}
        prefsKey={prefsKey}
        defaultRefs={defaultRefs}
      />
    </Section>
  );
}

export function NodeMetricsHistory({ obj, ctx, isActive }: Props) {
  const name = obj.metadata.name;
  const query = useMemo<MetricsHistoryQuery>(() => ({ scope: 'nodes', names: [name] }), [name]);
  const target = useMemo<PrometheusTarget>(() => ({ kind: 'node', name }), [name]);
  const allocatable = nodeResources(obj, 'allocatable');
  const capacity = nodeResources(obj, 'capacity');
  return (
    <HistorySection
      clusterId={ctx.clusterId}
      query={query}
      target={target}
      isActive={isActive}
      prefsKey="node"
      defaultRefs={['allocatable']}
      refs={{
        cpu: { allocatable: allocatable.cpu, capacity: capacity.cpu },
        memory: { allocatable: allocatable.memory, capacity: capacity.memory },
      }}
    />
  );
}

/** "All containers" or one container of a pod (Prometheus only). */
function ContainerPicker({
  containers,
  value,
  onChange,
}: {
  containers: string[];
  value: string | null;
  onChange: (container: string | null) => void;
}) {
  i18n.useLocale();
  return (
    <Select
      size="sm"
      value={value ?? ''}
      onChange={(v) => onChange(v || null)}
      ariaLabel={i18n.t('Container')}
      className="max-w-40"
      options={[
        { value: '', label: i18n.t('All containers') },
        ...containers.map((c) => ({ value: c, label: c })),
      ]}
    />
  );
}

export function PodMetricsHistory({ obj, ctx, isActive }: Props) {
  const namespace = obj.metadata.namespace ?? '';
  const name = obj.metadata.name;
  const containers = useMemo(
    () =>
      asArray(spec(obj).containers)
        .filter(isObject)
        .map((c) => String(c.name ?? ''))
        .filter(Boolean),
    [obj],
  );
  const [container, setContainer] = useState<string | null>(null);
  const selected = container && containers.includes(container) ? container : null;
  const query = useMemo<MetricsHistoryQuery>(
    () => ({ scope: 'pods', namespace, names: [name] }),
    [namespace, name],
  );
  const target = useMemo<PrometheusTarget>(
    () =>
      selected
        ? { kind: 'container', namespace, pod: name, container: selected }
        : { kind: 'pod', namespace, name },
    [namespace, name, selected],
  );
  const refs = useMemo(() => podResources([obj], selected), [obj, selected]);
  return (
    <HistorySection
      clusterId={ctx.clusterId}
      query={query}
      target={target}
      isActive={isActive}
      prefsKey="pod"
      defaultRefs={['requests', 'limits']}
      refs={refs}
      extraActions={
        containers.length > 1 ? (
          <ContainerPicker containers={containers} value={selected} onChange={setContainer} />
        ) : undefined
      }
    />
  );
}

/**
 * A workload's usage: with Prometheus, every pod it ever owned (matched by
 * name); with metrics-server, the pods its selector matches right now.
 */
export function WorkloadMetricsHistory({ obj, ctx, isActive }: Props) {
  const namespace = obj.metadata.namespace ?? '';
  const prom = usePrometheusAvailable(ctx.clusterId, isActive);
  const snap = useWatch(ctx.clusterId, POD_GVK, namespace ? [namespace] : [], isActive);
  const selector = useMemo(() => parseSelector(spec(obj).selector), [obj]);
  const pods = useMemo(
    () => (selector ? snap.items.filter((p) => matchesSelector(selector, p.metadata.labels)) : []),
    [snap.items, selector],
  );
  const names = useMemo(() => pods.map((p) => p.metadata.name).sort(), [pods]);
  const key = names.join('\u0000');
  const query = useMemo<MetricsHistoryQuery | null>(
    () => (names.length ? { scope: 'pods', namespace, names } : null),
    // `key` captures the name list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namespace, key],
  );
  const target = useMemo<PrometheusTarget>(
    () => ({ kind: 'workload', namespace, workload_kind: obj.kind, name: obj.metadata.name }),
    [namespace, obj.kind, obj.metadata.name],
  );
  const refs = useMemo(() => podResources(pods), [pods]);
  if (!prom && snap.synced && !names.length) return null;
  return (
    <HistorySection
      clusterId={ctx.clusterId}
      query={query}
      target={target}
      isActive={isActive}
      prefsKey="workload"
      defaultRefs={['requests', 'limits']}
      refs={refs}
    />
  );
}

/** Prometheus-only section (metrics-server has no series for these kinds). */
function PrometheusSection({
  clusterId,
  target,
  isActive,
  prefsKey,
}: {
  clusterId: string;
  target: PrometheusTarget;
  isActive: boolean;
  prefsKey: string;
}) {
  i18n.useLocale();
  const status = usePrometheusStatus(clusterId, isActive).data;
  const available = status?.state === 'available';
  // Same polled entry as the charts (shared by key): no extra request.
  const metrics = usePrometheusMetrics(
    clusterId,
    available ? target : null,
    [],
    usePromRange(),
    isActive,
  );
  if (!available) return null;
  return (
    <Section title={i18n.t('Usage history')} actions={<PromRangeToggle />}>
      <div className="space-y-2.5">
        <PrometheusUsage
          clusterId={clusterId}
          target={target}
          enabled={isActive}
          refs={NO_REFS}
          defaultRefs={['requests', 'limits']}
          prefsKey={prefsKey}
          height={110}
        />
        <MetricsSourceNote clusterId={clusterId} status={status} query={mainQuery(metrics.data)} />
      </div>
    </Section>
  );
}

export function NamespaceMetricsHistory({ obj, ctx, isActive }: Props) {
  const namespace = obj.metadata.name;
  const target = useMemo<PrometheusTarget>(() => ({ kind: 'namespace', namespace }), [namespace]);
  return (
    <PrometheusSection
      clusterId={ctx.clusterId}
      target={target}
      isActive={isActive}
      prefsKey="namespace"
    />
  );
}

export function PvcMetricsHistory({ obj, ctx, isActive }: Props) {
  const namespace = obj.metadata.namespace ?? '';
  const name = obj.metadata.name;
  const target = useMemo<PrometheusTarget>(
    () => ({ kind: 'pvc', namespace, name }),
    [namespace, name],
  );
  return (
    <PrometheusSection
      clusterId={ctx.clusterId}
      target={target}
      isActive={isActive}
      prefsKey="pvc"
    />
  );
}
