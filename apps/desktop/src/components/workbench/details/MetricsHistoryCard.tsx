import * as i18n from '@/i18n';
import { useMemo } from 'react';
import { asArray, asObject, isObject, spec } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import { matchesSelector, parseSelector } from '@/lib/kube/selectors';
import { nodeResources } from '@/lib/kube/workloads';
import type { KubeObject, MetricsHistoryQuery } from '@/types';
import { useWatch } from '../data/watchCache';
import { RangeToggle, UsageHistory, type RefKey, type UsageRefs } from '../metrics/UsageHistory';
import { useMetricsHistory } from '../metrics/useMetricsHistory';
import { Section } from './primitives';
import type { SectionProps } from './sections/types';

/**
 * "Usage history" sections of the details panel (nodes, pods, workloads).
 * Each is a self-contained component so detail sections mount it with one
 * line; it renders nothing on clusters without metrics-server.
 */

type Props = Pick<SectionProps, 'obj' | 'ctx' | 'isActive'>;

const POD_GVK = toGvk(BUILTIN.Pod);

/** Summed container requests / limits of `pods` (running or pending). */
function podResources(pods: readonly KubeObject[]): UsageRefs {
  const refs = {
    cpu: { requests: 0, limits: 0 },
    memory: { requests: 0, limits: 0 },
  };
  for (const pod of pods) {
    const phase = (pod.status as { phase?: string } | undefined)?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    for (const c of asArray(spec(pod).containers).filter(isObject)) {
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
  isActive,
  refs,
  prefsKey,
  defaultRefs,
}: {
  clusterId: string;
  query: MetricsHistoryQuery | null;
  isActive: boolean;
  refs: UsageRefs;
  prefsKey: string;
  defaultRefs: RefKey[];
}) {
  i18n.useLocale();
  // Same polled entry as the charts below (shared by key): no extra request.
  const state = useMetricsHistory(clusterId, query, isActive);
  if (state.data && !state.data.available) return null;
  return (
    <Section title={i18n.t('Usage history')} actions={<RangeToggle />}>
      <UsageHistory
        clusterId={clusterId}
        query={query}
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
  const allocatable = nodeResources(obj, 'allocatable');
  const capacity = nodeResources(obj, 'capacity');
  return (
    <HistorySection
      clusterId={ctx.clusterId}
      query={query}
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

export function PodMetricsHistory({ obj, ctx, isActive }: Props) {
  const namespace = obj.metadata.namespace ?? '';
  const name = obj.metadata.name;
  const query = useMemo<MetricsHistoryQuery>(
    () => ({ scope: 'pods', namespace, names: [name] }),
    [namespace, name],
  );
  const refs = useMemo(() => podResources([obj]), [obj]);
  return (
    <HistorySection
      clusterId={ctx.clusterId}
      query={query}
      isActive={isActive}
      prefsKey="pod"
      defaultRefs={['requests', 'limits']}
      refs={refs}
    />
  );
}

/** A workload's usage is the sum of the pods its selector matches right now. */
export function WorkloadMetricsHistory({ obj, ctx, isActive }: Props) {
  const namespace = obj.metadata.namespace ?? '';
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
  const refs = useMemo(() => podResources(pods), [pods]);
  if (snap.synced && !names.length) return null;
  return (
    <HistorySection
      clusterId={ctx.clusterId}
      query={query}
      isActive={isActive}
      prefsKey="workload"
      defaultRefs={['requests', 'limits']}
      refs={refs}
    />
  );
}
