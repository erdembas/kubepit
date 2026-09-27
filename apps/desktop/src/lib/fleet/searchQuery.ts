import { BUILTIN, resolveKindName, toGvk, type KindDef } from '@/lib/kube/catalog';
import type { ApiResourceInfo, ClusterEnvironment, FleetSearchQuery, Gvk } from '@/types';

/**
 * Fleet search query syntax (pure, no React):
 *
 *   kind:pod,deploy  ns:payments  app=web  tier!=db  !canary  label:team
 *   cluster:prod  env:staging  checkout web-*  /^api-\d+$/
 *
 * Field tokens (`kind:`, `ns:`, `cluster:`, `env:`, `label:`) narrow the
 * search; `key=value`, `key!=value` and `!key` are label selector terms;
 * everything else is the name pattern the backend matches (substring, glob
 * or `/regex/`).
 */

export interface ParsedSearch {
  /** Name pattern sent as `FleetSearchQuery.text`. */
  text: string;
  /** Kinds named with `kind:`; empty = the kind chips decide. */
  kinds: Gvk[];
  /** `kind:` values that matched no known kind. */
  unknownKinds: string[];
  namespace: string | null;
  /** Label selector terms, joined with `,` for the API server. */
  labels: string[];
  /** `cluster:` values (case-insensitive substrings of cluster names). */
  clusters: string[];
  environments: ClusterEnvironment[];
}

/** The kind chips offered by the search view, in display order. */
export const SEARCH_KINDS: Array<{ def: KindDef; label: string }> = [
  { def: BUILTIN.Pod, label: 'Pods' },
  { def: BUILTIN.Deployment, label: 'Deployments' },
  { def: BUILTIN.StatefulSet, label: 'StatefulSets' },
  { def: BUILTIN.DaemonSet, label: 'DaemonSets' },
  { def: BUILTIN.Job, label: 'Jobs' },
  { def: BUILTIN.CronJob, label: 'CronJobs' },
  { def: BUILTIN.Service, label: 'Services' },
  { def: BUILTIN.Ingress, label: 'Ingresses' },
  { def: BUILTIN.ConfigMap, label: 'ConfigMaps' },
  { def: BUILTIN.Secret, label: 'Secrets' },
  { def: BUILTIN.PersistentVolumeClaim, label: 'PVCs' },
  { def: BUILTIN.Node, label: 'Nodes' },
  { def: BUILTIN.Namespace, label: 'Namespaces' },
];

/** Chips selected until the user changes them. */
export const DEFAULT_SEARCH_KINDS = [
  'pods',
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'cronjobs.batch',
  'services',
  'ingresses.networking.k8s.io',
  'configmaps',
];

const ENV_ALIASES: Record<string, ClusterEnvironment> = {
  prod: 'production',
  prd: 'production',
  production: 'production',
  stage: 'staging',
  stg: 'staging',
  staging: 'staging',
  dev: 'development',
  development: 'development',
  test: 'testing',
  testing: 'testing',
  qa: 'testing',
  local: 'local',
};

const FIELD = /^(kind|kinds|k|ns|namespace|n|cluster|c|env|e|label|l):(.*)$/i;
const LABEL_TERM = /^!?[A-Za-z0-9][A-Za-z0-9._/-]*(?:(?:==?|!=)[A-Za-z0-9._-]*)?$/;
const HAS_OPERATOR = /(?:==?|!=)/;

function list(value: string) {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function isRegexText(text: string) {
  return text.length >= 2 && text.startsWith('/') && text.endsWith('/');
}

export function parseSearchInput(
  input: string,
  apiResources?: readonly ApiResourceInfo[] | null,
): ParsedSearch {
  const out: ParsedSearch = {
    text: '',
    kinds: [],
    unknownKinds: [],
    namespace: null,
    labels: [],
    clusters: [],
    environments: [],
  };
  const terms: string[] = [];
  let regex: string | null = null;
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const field = FIELD.exec(token);
    if (field) {
      const name = field[1]!.toLowerCase();
      const value = field[2]!;
      if (!value) continue; // still typing `kind:`
      if (name.startsWith('k')) {
        for (const kind of list(value)) {
          const gvk = resolveKindName(kind, apiResources);
          if (!gvk) out.unknownKinds.push(kind);
          else if (!out.kinds.some((k) => k.group === gvk.group && k.plural === gvk.plural))
            out.kinds.push(gvk);
        }
      } else if (name.startsWith('n')) out.namespace = value;
      else if (name.startsWith('c')) out.clusters.push(...list(value).map((v) => v.toLowerCase()));
      else if (name.startsWith('e')) {
        for (const env of list(value)) {
          const key = ENV_ALIASES[env.toLowerCase()];
          if (key && !out.environments.includes(key)) out.environments.push(key);
        }
      } else out.labels.push(value);
      continue;
    }
    if (isRegexText(token)) {
      regex = token;
      continue;
    }
    if (LABEL_TERM.test(token) && (HAS_OPERATOR.test(token) || token.startsWith('!'))) {
      out.labels.push(token);
      continue;
    }
    terms.push(token);
  }
  out.text = regex ?? terms.join(' ');
  return out;
}

/** Kinds to search: `kind:` tokens win over the chips. */
export function effectiveKinds(parsed: ParsedSearch, chipKeys: readonly string[]): Gvk[] {
  if (parsed.kinds.length) return parsed.kinds;
  return SEARCH_KINDS.filter((k) => chipKeys.includes(k.def.key)).map((k) => toGvk(k.def));
}

export function buildFleetQuery(
  parsed: ParsedSearch,
  kinds: Gvk[],
  clusterIds: string[],
  limitPerKind = 200,
): FleetSearchQuery {
  return {
    text: parsed.text,
    kinds,
    cluster_ids: clusterIds,
    namespace: parsed.namespace,
    label_selector: parsed.labels.length ? parsed.labels.join(',') : null,
    limit_per_kind: limitPerKind,
  };
}

/** True when the query would list every object of every kind (worth a nudge). */
export function isBroad(parsed: ParsedSearch) {
  return !parsed.text && !parsed.labels.length && !parsed.namespace;
}
