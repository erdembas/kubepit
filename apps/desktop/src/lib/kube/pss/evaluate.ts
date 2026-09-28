import type { KubeObject } from '@/types';
import {
  asArray,
  asObject,
  asString,
  asStringMap,
  get,
  isObject,
  type JsonObject,
} from '../accessors';
import { podSpecOf } from '../health/context';
import { CHECKS, type CheckContext } from './checks';
import {
  PSS_LEVELS,
  PSS_MODES,
  type NamespacePss,
  type PssLevel,
  type PssMode,
  type PssModePolicy,
  type PssPolicy,
  type PssViolation,
} from './types';

/** Label prefix of the Pod Security admission labels. */
export const PSS_LABEL_PREFIX = 'pod-security.kubernetes.io/';

export const pssLabel = (mode: PssMode) => `${PSS_LABEL_PREFIX}${mode}`;
export const pssVersionLabel = (mode: PssMode) => `${PSS_LABEL_PREFIX}${mode}-version`;

export function isPssLevel(value: unknown): value is PssLevel {
  return typeof value === 'string' && (PSS_LEVELS as readonly string[]).includes(value);
}

/** Minor version of `latest` / `v1.<minor>`; `Infinity` for latest, `null` when invalid. */
export function parseVersion(version: string): number | null {
  if (version === 'latest') return Infinity;
  const m = /^v1\.(\d+)$/.exec(version);
  return m ? Number(m[1]) : null;
}

export function isPssVersion(value: unknown): value is string {
  return typeof value === 'string' && parseVersion(value) !== null;
}

/** Levels ordered from least to most restrictive. */
export function levelRank(level: PssLevel): number {
  return PSS_LEVELS.indexOf(level);
}

export function stricter(a: PssLevel, b: PssLevel): PssLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

/**
 * The policy of every admission mode from namespace labels. A missing level
 * means the cluster default (assumed `privileged`, the built-in default); a
 * label that cannot be parsed falls back to `restricted` / `latest`, as the
 * admission plugin does.
 */
export function namespacePss(labels: Readonly<Record<string, string>> | undefined): NamespacePss {
  const out = {} as NamespacePss;
  for (const mode of PSS_MODES) {
    const rawLevel = labels?.[pssLabel(mode)];
    const rawVersion = labels?.[pssVersionLabel(mode)];
    const levelOk = rawLevel === undefined || isPssLevel(rawLevel);
    const versionOk = rawVersion === undefined || isPssVersion(rawVersion);
    const policy: PssModePolicy = {
      level:
        rawLevel === undefined ? 'privileged' : levelOk ? (rawLevel as PssLevel) : 'restricted',
      version: rawVersion === undefined || !versionOk ? 'latest' : rawVersion,
      explicit: rawLevel !== undefined,
      invalid: !levelOk || !versionOk,
    };
    out[mode] = policy;
  }
  return out;
}

/** True when any mode is stricter than privileged. */
export function hasPssPolicy(pss: NamespacePss): boolean {
  return PSS_MODES.some((m) => pss[m].level !== 'privileged');
}

export function policyText(policy: PssPolicy): string {
  return `${policy.level}:${policy.version}`;
}

// ---------------------------------------------------------------------------
// Pod specs
// ---------------------------------------------------------------------------

export interface PodInput {
  annotations: Readonly<Record<string, string>>;
  spec: JsonObject;
}

/** Pod template metadata of a workload (the pod's own metadata for pods). */
function templateMeta(obj: KubeObject): JsonObject {
  switch (obj.kind) {
    case 'Pod':
      return asObject(obj.metadata);
    case 'CronJob':
      return asObject(get(obj, 'spec.jobTemplate.spec.template.metadata'));
    default:
      return asObject(get(obj, 'spec.template.metadata'));
  }
}

/** The pod spec and annotations a pod or workload template is admitted with. */
export function podInputOf(obj: KubeObject): PodInput | null {
  const spec = podSpecOf(obj);
  if (!spec) return null;
  return { annotations: asStringMap(templateMeta(obj).annotations), spec };
}

function contextOf(input: PodInput, minor: number): CheckContext {
  const containers = ['containers', 'initContainers', 'ephemeralContainers'].flatMap((k) =>
    asArray(input.spec[k]).filter(isObject),
  );
  return {
    annotations: input.annotations,
    spec: input.spec,
    podSc: asObject(input.spec.securityContext),
    containers,
    minor,
    windows: asString(asObject(input.spec.os).name) === 'windows',
  };
}

/** Failed checks of a pod spec against a policy (empty = allowed). */
export function evaluatePod(policy: PssPolicy, input: PodInput): PssViolation[] {
  if (policy.level === 'privileged') return [];
  const minor = parseVersion(policy.version) ?? Infinity;
  const applicable = CHECKS.filter(
    (c) => (c.level === 'baseline' || policy.level === 'restricted') && minor >= c.since,
  );
  const overridden = new Set(applicable.flatMap((c) => c.overrides ?? []));
  const ctx = contextOf(input, minor);
  const out: PssViolation[] = [];
  for (const check of applicable) {
    if (overridden.has(check.id)) continue;
    const outcome = check.run(ctx);
    if (outcome) out.push({ check: check.id, level: check.level, ...outcome });
  }
  return out;
}

/** Failed checks of a pod or workload template; `[]` for objects without a pod spec. */
export function evaluateObject(policy: PssPolicy, obj: KubeObject): PssViolation[] {
  const input = podInputOf(obj);
  return input ? evaluatePod(policy, input) : [];
}

/** The strictest level a pod spec passes at `version`. */
export function passingLevel(input: PodInput, version = 'latest'): PssLevel {
  if (!evaluatePod({ level: 'restricted', version }, input).length) return 'restricted';
  if (!evaluatePod({ level: 'baseline', version }, input).length) return 'baseline';
  return 'privileged';
}

/** `reason (detail)`: the API server's wording of one failed check. */
export function violationText(v: Pick<PssViolation, 'reason' | 'detail'>): string {
  return v.detail ? `${v.reason} (${v.detail})` : v.reason;
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

export interface OwnerResult {
  owner: KubeObject;
  violations: PssViolation[];
}

export interface NamespaceEvaluation {
  namespace: string;
  pss: NamespacePss;
  /** Pod-spec owners (workload templates and bare pods) evaluated. */
  total: number;
  baseline: OwnerResult[];
  restricted: OwnerResult[];
  /** Owners violating the enforce / audit / warn policy of the namespace. */
  modes: Record<PssMode, OwnerResult[]>;
}

function evaluateAll(policy: PssPolicy, owners: readonly KubeObject[]): OwnerResult[] {
  if (policy.level === 'privileged') return [];
  const out: OwnerResult[] = [];
  for (const owner of owners) {
    const violations = evaluateObject(policy, owner);
    if (violations.length) out.push({ owner, violations });
  }
  return out;
}

/**
 * Evaluate the pod-spec owners of one namespace at baseline and restricted
 * (latest) and at the policy of each admission mode.
 */
export function evaluateNamespace(
  namespace: KubeObject,
  owners: readonly KubeObject[],
): NamespaceEvaluation {
  const pss = namespacePss(namespace.metadata.labels);
  const baseline = evaluateAll({ level: 'baseline', version: 'latest' }, owners);
  const restricted = evaluateAll({ level: 'restricted', version: 'latest' }, owners);
  const modes = {} as Record<PssMode, OwnerResult[]>;
  for (const mode of PSS_MODES) {
    const policy = pss[mode];
    modes[mode] =
      policy.version === 'latest' && policy.level === 'baseline'
        ? baseline
        : policy.version === 'latest' && policy.level === 'restricted'
          ? restricted
          : evaluateAll(policy, owners);
  }
  return {
    namespace: namespace.metadata.name,
    pss,
    total: owners.length,
    baseline,
    restricted,
    modes,
  };
}
