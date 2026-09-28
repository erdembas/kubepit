/**
 * LogQL for the Loki tab's query builder (pure). The builder picks a
 * namespace, a workload (pods matched by the names its kind generates, like
 * the Prometheus presets), a pod and a container, adds a line filter and a
 * parser stage, and renders a query the user can keep editing by hand.
 * LogQL itself is never translated.
 */

export type LineFilterOp = '|=' | '!=' | '|~' | '!~';
export type ParserStage = 'none' | 'json' | 'logfmt';

export interface LokiBuilder {
  namespace: string | null;
  /** Pods of a workload, matched by name (`web-7c9d8b6f5-x2kqp`). */
  workload: { kind: string; name: string } | null;
  pod: string | null;
  container: string | null;
  lineOp: LineFilterOp;
  line: string;
  parser: ParserStage;
}

export function emptyBuilder(namespace: string | null = null): LokiBuilder {
  return {
    namespace,
    workload: null,
    pod: null,
    container: null,
    lineOp: '|=',
    line: '',
    parser: 'none',
  };
}

/** A LogQL double-quoted string literal. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Escape RE2 metacharacters so `value` matches literally inside `=~`. */
export function regexEscape(value: string): string {
  return value.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
}

/**
 * Pod-name regex of the pods a workload creates; segment counts keep `web`
 * from matching `web-api` (mirrors `workload_pod_regex` in the backend).
 */
export function workloadPodRegex(kind: string, name: string): string {
  const base = regexEscape(name);
  switch (kind) {
    case 'Deployment':
    case 'Rollout':
      return `${base}-[a-z0-9]+-[a-z0-9]+`;
    case 'StatefulSet':
      return `${base}-[0-9]+`;
    case 'CronJob':
      return `${base}-[0-9]+-[a-z0-9]+`;
    case 'ReplicaSet':
    case 'DaemonSet':
    case 'Job':
    case 'ReplicationController':
      return `${base}-[a-z0-9]+`;
    default:
      return `${base}-.+`;
  }
}

/** Workloads whose pods the builder can match by name. */
export const LOKI_WORKLOAD_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
  'CronJob',
  'Rollout',
]);

/** Label names the builder writes (promtail / Alloy defaults, or OTel-style names). */
export interface LokiLabelNames {
  namespace: string;
  pod: string;
  container: string;
}

export const DEFAULT_LABEL_NAMES: LokiLabelNames = {
  namespace: 'namespace',
  pod: 'pod',
  container: 'container',
};

const LABEL_CANDIDATES: Record<keyof LokiLabelNames, string[]> = {
  namespace: ['namespace', 'k8s_namespace_name', 'namespace_name', 'kubernetes_namespace_name'],
  pod: ['pod', 'k8s_pod_name', 'pod_name', 'kubernetes_pod_name'],
  container: ['container', 'k8s_container_name', 'container_name', 'kubernetes_container_name'],
};

/** The label names this Loki uses, picked from its label list. */
export function labelNamesFrom(labels: readonly string[]): LokiLabelNames {
  const pick = (key: keyof LokiLabelNames) =>
    LABEL_CANDIDATES[key].find((name) => labels.includes(name)) ?? DEFAULT_LABEL_NAMES[key];
  return { namespace: pick('namespace'), pod: pick('pod'), container: pick('container') };
}

/** `{namespace="shop", pod=~"web-…"}`; never empty (Loki needs one matcher). */
export function builderSelector(
  b: LokiBuilder,
  names: LokiLabelNames = DEFAULT_LABEL_NAMES,
): string {
  const matchers: string[] = [];
  if (b.namespace) matchers.push(`${names.namespace}=${quote(b.namespace)}`);
  if (b.pod) matchers.push(`${names.pod}=${quote(b.pod)}`);
  else if (b.workload)
    matchers.push(`${names.pod}=~${quote(workloadPodRegex(b.workload.kind, b.workload.name))}`);
  if (b.container) matchers.push(`${names.container}=${quote(b.container)}`);
  if (matchers.length === 0) matchers.push(`${names.namespace}=~".+"`);
  return `{${matchers.join(', ')}}`;
}

/** The builder's full query: selector, line filter, parser. */
export function builderQuery(b: LokiBuilder, names: LokiLabelNames = DEFAULT_LABEL_NAMES): string {
  let query = builderSelector(b, names);
  if (b.line.trim()) query += ` ${b.lineOp} ${quote(b.line)}`;
  if (b.parser !== 'none') query += ` | ${b.parser}`;
  return query;
}

const METRIC_HEAD_RE =
  /^\s*(?:sum|avg|min|max|count|stddev|stdvar|topk|bottomk|sort|sort_desc|rate|rate_counter|count_over_time|bytes_over_time|bytes_rate|avg_over_time|sum_over_time|min_over_time|max_over_time|stdvar_over_time|stddev_over_time|quantile_over_time|first_over_time|last_over_time|absent_over_time|label_replace|vector|approx_topk)\b/;

/** True for metric queries (they return series, not lines). */
export function isMetricQuery(logql: string): boolean {
  return METRIC_HEAD_RE.test(logql) || /^\s*[\d(]/.test(logql);
}

/**
 * Line counts per `stepSecs` of a log query, for the volume histogram.
 * Parser and formatting stages are kept: they only filter lines, and
 * `count_over_time` counts whatever passes.
 */
export function volumeQuery(logql: string, stepSecs: number): string | null {
  const query = logql.trim();
  if (!query || isMetricQuery(query)) return null;
  return `sum(count_over_time(${query} [${Math.max(1, Math.round(stepSecs))}s]))`;
}

/** Equality matchers of the first stream selector (`{a="b", c=~"d"}` → `{a: 'b'}`). */
export function selectorLabels(logql: string): Record<string, string> {
  const open = logql.indexOf('{');
  const close = logql.indexOf('}', open + 1);
  if (open < 0 || close < 0) return {};
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w]*)\s*=\s*"((?:\\.|[^"\\])*)"/g;
  const body = logql.slice(open + 1, close);
  for (const m of body.matchAll(re)) {
    const before = body[m.index! + m[1]!.length];
    if (before === '~') continue;
    out[m[1]!] = m[2]!.replace(/\\(.)/g, '$1');
  }
  return out;
}

/** Workload name + kind guessed from a pod name (`web-7c9d8b6f5-x2kqp` → Deployment web). */
export function workloadOfPod(pod: string): { kind: string; name: string } | null {
  const deployment = /^(.+)-[a-z0-9]{8,10}-[a-z0-9]{5}$/.exec(pod);
  if (deployment) return { kind: 'Deployment', name: deployment[1]! };
  const statefulSet = /^(.+)-\d+$/.exec(pod);
  if (statefulSet) return { kind: 'StatefulSet', name: statefulSet[1]! };
  const owned = /^(.+)-[a-z0-9]{5}$/.exec(pod);
  if (owned) return { kind: 'DaemonSet', name: owned[1]! };
  return null;
}

/** Distinct workloads behind a list of pod names, by name. */
export function workloadsOfPods(pods: readonly string[]): { kind: string; name: string }[] {
  const seen = new Map<string, { kind: string; name: string }>();
  for (const pod of pods) {
    const w = workloadOfPod(pod);
    if (w && !seen.has(`${w.kind}/${w.name}`)) seen.set(`${w.kind}/${w.name}`, w);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
