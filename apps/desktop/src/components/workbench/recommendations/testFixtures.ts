import type { ContainerRecommendation, WorkloadRecommendation } from '@/types';

/** Recommendation rows for the tests of this view's sections (never bundled). */

export const MiB = 1024 ** 2;

export function container(
  name: string,
  requests: [number | null, number | null],
  usage: Partial<NonNullable<ContainerRecommendation['usage']>> | null,
  extra: Partial<ContainerRecommendation> = {},
): ContainerRecommendation {
  const values = {
    cpu_request: requests[0],
    memory_request: requests[1],
    cpu_limit: null,
    memory_limit: null,
  };
  return {
    name,
    current: values,
    recommended: values,
    usage: usage
      ? {
          cpu_p95: 0,
          cpu_max: 0,
          memory_max: 0,
          hours: 168,
          cpu_avg: null,
          memory_avg: null,
          ...usage,
        }
      : null,
    cpu: 'unchanged',
    memory: 'unchanged',
    memory_limit: 'unchanged',
    cpu_limit: 'unchanged',
    confidence: 'high',
    warnings: [],
    cpu_limit_raised: false,
    memory_limit_raised: false,
    evidence: null,
    ...extra,
  };
}

export function workload(
  name: string,
  containers: ContainerRecommendation[],
  over: Partial<WorkloadRecommendation> = {},
): WorkloadRecommendation {
  return {
    kind: 'Deployment',
    namespace: 'shop',
    name,
    uid: name,
    replicas: 1,
    confidence: 'high',
    verdict: 'under',
    coverage_hours: 168,
    containers,
    monthly_delta: 0,
    monthly_current: 10,
    changed: true,
    pods: [],
    pods_truncated: false,
    hpa: null,
    lenses: [],
    cost_replicas: 1,
    ...over,
  };
}

const changeOf = (current: number | null, next: number | null) =>
  current === next
    ? ('unchanged' as const)
    : current == null
      ? ('set' as const)
      : next != null && next > current
        ? ('increase' as const)
        : ('decrease' as const);

/** `c` with recommended requests (null = unchanged) and the matching change kinds. */
export function recommend(
  c: ContainerRecommendation,
  [cpu, memory]: [number | null, number | null],
): ContainerRecommendation {
  const recommended = {
    ...c.recommended,
    cpu_request: cpu ?? c.current.cpu_request,
    memory_request: memory ?? c.current.memory_request,
  };
  return {
    ...c,
    recommended,
    cpu: changeOf(c.current.cpu_request, recommended.cpu_request),
    memory: changeOf(c.current.memory_request, recommended.memory_request),
  };
}
